/**
 * 共享写策略（v0.19.1）：所有「写 TiddlyWiki」的路径（agent 工具 + HTTP 路由）
 * 必须走这里，别再各自拼 PUT body。
 *
 * 为什么抽出这一层：TW 的 REST PUT 是**整体替换**。v0.19.0 只在工具层修了
 * 「以已有条目为基底、不传 tags 就保留标签与自定义字段」，而 `/note`、`/edit`
 * 这些人类入口仍然直接 `put({title,text,tags})` —— 用一个同名标题保存就会把
 * 人类笔记的标签和 `q`/`due`/`clip-url` 等自定义字段清空（v0.19.1 审计发现）。
 * 把策略收成一个模块，两条路径共用，回归就不会再各修各的。
 *
 * 另外两个必须记住的事实：
 * - 单条 GET 返回的自定义字段**嵌套在 `fields` 下**（core-server 的
 *   get-tiddler.js 把 knownFields 之外的字段收进 `fields`），PUT 却接受平铺
 *   字段，所以 `cleanTiddler()` 必须摊平，否则 rename/append/trash 静默丢字段；
 * - `revision`（GET 的 changeCount）是唯一「刚 PUT 还没落盘」时也存在的并发
 *   令牌——那种条目没有 `modified`，两个令牌都支持。
 *
 * @module dsh-tiddlywiki/host/write-policy
 */
import type { Tiddler } from './tw-api.ts'
import { formatTiddlerDate, parseTiddlerDate, toIsoDateString } from './tw-api.ts'

/** 约定标签：标记「由 Agent 撰写」的笔记（新建时自动补打）。 */
export const AGENT_WRITTEN_TAG = 'agent-written'

/** 约定标签：标记「Agent 撰写后又经人类编辑」的笔记。 */
export const HUMAN_EDITED_TAG = 'human-edited'

/** Agent / 人类笔记的默认内容类型（TW 对无 type 的条目按 wikitext 解析）。 */
export const DEFAULT_NOTE_TYPE = 'text/markdown'

/**
 * 构造 PUT body 时跳过的字段（身份/内容）。
 *
 * ⚠️ `type` **不在**这里（v0.20.1 修复）：它曾被误列为跳过字段，于是
 * `cleanTiddler(existing)` 把条目的内容类型丢掉，`finalTypeForWrite()` 随后又
 * 补上默认的 `text/markdown`（或干脆不写 type → TW 回落 `text/vnd.tiddlywiki`）。
 * 结果：任何「覆盖已有条目」的路径都会静默改掉类型——
 *   - `text/css` 的样式条目被改成 `text/markdown` → 整篇 CSS 被当 Markdown 渲染；
 *   - `text/markdown` 笔记被改成 `text/vnd.tiddlywiki` → `##`/`**粗体**`/表格全按
 *     wikitext 解析（磁盘上 `.md` + `.meta` 也变成 `.tid`）。
 * 内容类型是条目的解析方式，必须与 tags/自定义字段一样按「以已有条目为基底」保留。
 *
 * ⚠️ `created`/`modified` 也**不再**在这里（v0.22.10 修复）：它们曾被当成「TW 自己
 * 拥有的时间戳，服务端会补」而丢弃——**TW 的服务端写路径从不补这两个字段**
 * （`core-server` 的 put 路由只是 `addTiddler(new $tw.Tiddler(fields,{title}))`，
 * `getCreationFields()`/`getModificationFields()` 只在 TW **自己的 UI** 里被调用；
 * 实测 `tiddlywiki_put` 新建条目落盘只有 tags/title/type）。于是插件写下的条目在
 * `+[!sort[modified]]` 这类页面上被 `sortTiddlers` 的 `fields[sortField] || ""`
 * 当空串——降序时**沉到最后一名**，看起来就像「没被收录」。现在这两个字段由
 * `buildWriteTiddler()` 负责写入（见 `stampTiddlerTimes`），与 TW 编辑器行为一致。
 */
const CLEAN_SKIP_FIELDS = new Set(['title', 'text', 'tags', 'fields'])

/**
 * 调用方**不得**通过 `fields` 覆盖的保留字段：它们是条目的身份/内容，时间戳
 * 归 TW 所有。`type` 故意放行——那是显式指定内容类型的正规入口。
 */
const RESERVED_TIDDLER_FIELDS = new Set(['title', 'text', 'tags', 'created', 'modified'])

/**
 * TW 服务端 GET/listing 会为缺省 `type` 的条目**补上** `text/vnd.tiddlywiki`
 * （get-tiddler.js / get-tiddlers-json.js 都有 `type = type || "text/vnd.tiddlywiki"`），
 * 而 `bag` 也是响应里补的传输字段。回写时把这两个透传回去要么污染文件（type）、
 * 要么被 TW 自行剥掉（bag/revision），所以从展示与回写里都排除。
 */
const TRANSPORT_FIELDS = new Set(['bag', 'revision', 'recipe', 'uri', 'permissions'])

/** 写入冲突（乐观并发令牌不匹配）：路由层把它映射成 HTTP 409。 */
export class WriteConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WriteConflictError'
  }
}

/**
 * 把单条 GET 返回的字段**摊平**成模型/路由可直接读的形状：
 * 嵌套 `fields` 里的自定义字段提到顶层，`bag`/`revision` 等传输字段排除。
 */
export function flattenTiddlerFields(tiddler: Tiddler): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(tiddler)) {
    if (key === 'title' || key === 'text' || key === 'tags' || key === 'fields') continue
    if (TRANSPORT_FIELDS.has(key)) continue
    out[key] = value
  }
  const nested = tiddler.fields
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    for (const [key, value] of Object.entries(nested)) {
      if (key === 'title' || key === 'text' || key === 'tags' || key === 'fields') continue
      if (value === undefined) continue
      if (out[key] === undefined) out[key] = value
    }
  }
  return out
}

/**
 * 由已有条目构造一份可 PUT 的副本：字段摊平、tags 归数组、TW 拥有的时间戳丢掉。
 * `type` 保留（含服务端补的默认值——语义等价，且能防止 Markdown 笔记被回退成
 * wikitext；用户若显式改名内容类型，走 `fields.type`）。
 */
export function cleanTiddler(t: Tiddler): Tiddler {
  const out: Tiddler = { title: t.title, text: t.text ?? '', tags: t.tags ?? [] }
  for (const [k, v] of Object.entries(t)) {
    if (CLEAN_SKIP_FIELDS.has(k) || TRANSPORT_FIELDS.has(k)) continue
    out[k] = v
  }
  const nested = t.fields
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    for (const [k, v] of Object.entries(nested)) {
      if (CLEAN_SKIP_FIELDS.has(k) || TRANSPORT_FIELDS.has(k) || v === undefined) continue
      out[k] = v
    }
  }
  return out
}

/** 是不是一个「平铺对象」（`fields` 唯一合法的形状；数组不算）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 错误信息里的短样本（不把整段正文塞进回执）。 */
function excerpt(value: string, max = 60): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 归一化调用方给的 `fields`（v0.26.5）。
 *
 * 背景（真实事故）：`tiddlywiki_put`/`batch_put`/`append` 的参数 schema 曾把它声明为
 * `{ type: 'json' }`，而 DSH 的 schema 里 `type:'json'` 是**纯注解**——编译出来的
 * 节点连 `type` 都没有（见 `src/sdk.ts` 的 `compileValue`）。模型于是不知道它是对象，
 * 把 `{"review-after":"2026-12-22"}` 当**字符串**发来；字符串走到
 * `withWorkspaceMark` 的 `{ ...(fields ?? {}) }` 被按字符展开成
 * `{0:'{', 1:'"', 2:'r', …}`，再被当成几十个单字符字段写进条目，真正的自定义字段
 * 一个也没落（用户 2026-09-23 实测复现两次）。
 *
 * 这条修复同时钉两头：工具 schema 改成真正的 object（`additionalProperties: true`），
 * 以及在任何展开/遍历之前先在这里归一化。语义：
 *
 * | 输入 | 结果 |
 * |---|---|
 * | `undefined` / `null` / 空串 | `undefined`（保留基底，不动任何字段） |
 * | 平铺对象 | 原样返回 |
 * | JSON 字符串（对象） | 解析后使用——兼容仍按字符串发参的模型 |
 * | 数组 / 数字 / 布尔 / 解析不出对象的字符串 | **抛错** |
 *
 * 最后一条是刻意的：宁可给模型一条可读的报错让它重发，也**绝不**静默丢字段或把
 * 字符串按字符拆成垃圾字段（那正是这次事故的形态）。
 */
export function normalizeFieldsArg(fields: unknown): Record<string, unknown> | undefined {
  if (fields === undefined || fields === null) return undefined
  if (typeof fields === 'string') {
    const trimmed = fields.trim()
    if (trimmed.length === 0) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      parsed = undefined
    }
    if (isPlainObject(parsed)) return parsed
    throw new Error(
      `fields 必须是一个对象（如 {"review-after":"2026-12-22"}），`
      + `收到无法解析成对象的字符串：${excerpt(fields)}`,
    )
  }
  if (isPlainObject(fields)) return fields
  throw new Error(
    `fields 必须是一个对象（如 {"review-after":"2026-12-22"}），收到 ${Array.isArray(fields) ? '数组' : typeof fields}`,
  )
}

/**
 * 合并调用方显式提供的自定义字段（跳过保留字段与 undefined）。
 *
 * 模块私有（v0.22.8）：它只被 buildWriteTiddler 调用，导出会让「写策略只有一个
 * 入口」这条约定出现第二个可绕过的门。`verify-write-policy.mjs` 断的是
 * `buildWriteTiddler`/`cleanTiddler` 的对外行为，不需要这个内部步骤。
 *
 * v0.26.5：非对象一律**抛错**，不再静默 return。旧实现的静默 return 让模型看到
 * 「字段没写进去」却收不到任何错误（事故的第二个症状）；配合 `withWorkspaceMark`
 * 的字符串展开，才有了「几十个单字符字段」那一步。现在任何绕过
 * `normalizeFieldsArg` 的调用方都会在这里被拦住，而不是往人类笔记上写垃圾。
 */
function applyCustomFields(tiddler: Tiddler, fields: Record<string, unknown> | undefined): void {
  if (fields === undefined || fields === null) return
  if (!isPlainObject(fields)) {
    throw new Error(`内部错误：fields 必须是对象，收到 ${Array.isArray(fields) ? '数组' : typeof fields}`)
  }
  for (const [key, value] of Object.entries(fields)) {
    if (RESERVED_TIDDLER_FIELDS.has(key)) continue
    if (value === undefined) continue
    tiddler[key] = value
  }
}

/**
 * 归一化工具/路由的 `tags` 参数（非数组 → undefined）。
 *
 * ⚠️ 三种输入三种语义（v0.25.0 修复「无法清空标签」）：
 *   - 未传 / 非数组 → `undefined` = 「保留基底里原有的标签」；
 *   - `[]`（显式空数组）→ `[]` = 「清空全部标签」（`buildWriteTiddler` 会
 *     `delete tiddler.tags`）；
 *   - 有内容的数组 → 该数组 = 「整体替换」。
 *
 * 旧实现把 `[]` 过滤成 `undefined`，而 `tags` 又是 `RESERVED_TIDDLER_FIELDS`
 * 成员（`fields.tags` 会被拒），于是**没有任何途径**把一篇既有笔记的标签改成
 * 空：模型按 `tiddlywiki_lint` 的 junk-tags 建议去「清标签」，传 `[]` 却什么
 * 都没发生，回执还把旧标签原样列出来（实测）。全是空白字符串的数组（`['  ']`）
 * 同样是「清空」意图，一并按清空处理。
 */
export function normalizeTagArg(tags: unknown): string[] | undefined {
  if (!Array.isArray(tags)) return undefined
  const list = tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim())
  if (list.length > 0) return list
  // 显式给了数组、但里面没有有效标签（`[]` 或 `['  ']`）：一律按「清空」处理。
  return []
}

/**
 * 计算最终标签（模块私有，v0.22.8）：只被 `buildWriteTiddler` 调用，导出会让
 * 「新条目补 agent-written」这条规则出现绕过 buildWriteTiddler 的第二条路。
 *
 * - 已存在的条目 → 调用方给什么就是什么（不给 = 保留基底里的原标签）；
 * - 新条目 + `agentTag` → 自动补 `agent-written`（`$:/` 系统条目除外）；
 * - 新条目 + 人类入口（`agentTag: false`，如快速笔记 / `/note`）→ 不补，
 *   人类写的笔记不该被标成 agent 撰写。
 */
function finalTagsForWrite(title: string, existing: Tiddler | undefined, tags: string[], agentTag: boolean): string[] {
  if (existing !== undefined) return tags
  if (!agentTag) return tags
  if (title.startsWith('$:/')) return tags
  if (tags.includes(AGENT_WRITTEN_TAG)) return tags
  return [...tags, AGENT_WRITTEN_TAG]
}

/**
 * 计算最终内容类型（原地改 tiddler）：显式 type 优先；**只有新建条目**才回落
 * Markdown，`$:/` 条目保持 TW 默认。
 *
 * v0.20.1：`isNew=false`（覆盖既有条目）时**绝不**发明类型——基底里有什么就是
 * 什么；基底没有 type（极少数情况）也保持「没有」，让 TW 继续按 wikitext 处理，
 * 而不是把它升级成 Markdown。改类型是调用方的显式动作（`fields.type`）。
 */
export function finalTypeForWrite(title: string, tiddler: Tiddler, isNew = true): { defaulted: boolean } {
  if (typeof tiddler.type === 'string' && tiddler.type.length > 0) return { defaulted: false }
  if (!isNew) return { defaulted: false }
  if (title.startsWith('$:/')) return { defaulted: false }
  tiddler.type = DEFAULT_NOTE_TYPE
  return { defaulted: true }
}

export interface BuildWriteOptions {
  /** 已有条目（`wiki.get()` 的结果；读失败不得吞成 undefined）。 */
  existing?: Tiddler | undefined
  /** 显式标签：给了就整体替换，没给就保留基底里的原标签。 */
  tags?: string[] | undefined
  /**
   * 显式自定义字段（逐个覆盖在基底之上）。必须是平铺对象——调用方应先用
   * `normalizeFieldsArg()` 归一化（工具层允许模型按 JSON 字符串发来），
   * 传字符串/数组会在 `applyCustomFields` 里抛错，绝不按字符拆开（v0.26.5）。
   */
  fields?: Record<string, unknown> | undefined
  /** 新建条目时是否自动补 `agent-written`（agent 工具 true，人类入口 false）。 */
  agentTag?: boolean
  /** 新建条目且未显式给标签时使用的默认标签（人类入口，如 note.tag）。 */
  defaultTags?: string[] | undefined
  /** 写入时刻（测试注入用；省略 = `new Date()`）。 */
  now?: Date | number | undefined
}

/**
 * 给要写出的条目补 `created`/`modified`（v0.22.10），语义与 TW 编辑器一致：
 *
 * | 情形 | created | modified |
 * |---|---|---|
 * | 新建（含首次写入的 `$:/`） | 当前时刻 | 当前时刻 |
 * | 覆盖既有条目、基底有 created | **基底原值** | 当前时刻 |
 * | 覆盖既有条目、基底无 created（迁移存量） | 当前时刻 | 当前时刻 |
 *
 * 为什么必须由插件来写：TW 的 `getCreationFields()`/`getModificationFields()`
 * 只在 **TW 自己的 UI**（`$tw.wiki.setTiddlerData`、navigation/editor widgets…）
 * 里被调用；服务端的 PUT 路由只做
 * `state.wiki.addTiddler(new $tw.Tiddler(fields, {title: title}))`，**不会补**
 * 这两个字段。所以「服务端会补」这个假设是错的，缺 `modified` 的条目会被
 * `sortTiddlers` 的 `fields[sortField] || ""` 当成空串——`!sort[modified]` 降序时
 * 直接沉到最后一名（用户看到的现象：新日记在「主题页·日志」里排 175/175）。
 *
 * 值是 TW 的紧凑格式 `YYYYMMDDhhmmssSSS`（UTC），与 `$tw.utils.stringifyDate()`
 * 逐字节一致，TW 的日期字段模块能正常 parse/stringify/显示。
 */
export function stampTiddlerTimes(tiddler: Tiddler, existing: Tiddler | undefined, now: Date | number = new Date()): void {
  const stamp = formatTiddlerDate(now)
  const existingCreated = typeof existing?.created === 'string' && existing.created.trim().length > 0
    ? existing.created
    : undefined
  // An overwrite keeps the note's ORIGINAL creation instant; a new tiddler (and a
  // legacy one written before this fix, whose created is unknown) starts now.
  tiddler.created = existingCreated ?? stamp
  tiddler.modified = stamp
}

/**
 * 构造一次写要 PUT 的 tiddler。
 *
 * - 已有条目 → 以其为基底（标签、自定义字段、**内容类型**、**created** 全部保留）；
 * - 新条目 → `{title, text}` + 默认/显式标签（`$:/` 不带 agent 标签）；
 * - `fields` 逐个覆盖；`type` 未指定时**仅新建条目**补 Markdown（`$:/` 除外）；
 * - `created`/`modified` 一律补写（v0.22.10，见 `stampTiddlerTimes`）——TW 的服务端
 *   写路径**不会**补这两个字段，缺它们的条目会在 `!sort[modified]` 里沉底。
 */
export function buildWriteTiddler(
  title: string,
  text: string,
  options: BuildWriteOptions = {},
): { tiddler: Tiddler; typeDefaulted: boolean } {
  const { existing, fields } = options
  const agentTag = options.agentTag !== false
  const tiddler: Tiddler = existing !== undefined ? { ...cleanTiddler(existing), title, text } : { title, text }
  if (options.tags !== undefined) {
    const finalTags = finalTagsForWrite(title, existing, options.tags, agentTag)
    if (finalTags.length > 0) tiddler.tags = finalTags
    else delete tiddler.tags
  } else if (existing === undefined) {
    const seedTags = options.defaultTags !== undefined && options.defaultTags.length > 0 ? options.defaultTags : []
    const finalTags = finalTagsForWrite(title, undefined, seedTags, agentTag)
    if (finalTags.length > 0) tiddler.tags = finalTags
  }
  applyCustomFields(tiddler, fields)
  // v0.20.1: the Markdown default is for NEW tiddlers only — an overwrite keeps
  // the content type it was read with (see finalTypeForWrite).
  const { defaulted } = finalTypeForWrite(title, tiddler, existing === undefined)
  // v0.22.10: stamp created/modified AFTER applyCustomFields — those two are
  // reserved (applyCustomFields refuses them anyway) and TW's own editor uses the
  // same "keep created, refresh modified" rule on save.
  stampTiddlerTimes(tiddler, existing, options.now)
  return { tiddler, typeDefaulted: defaulted }
}

export interface ConflictTokens {
  expectedModified?: string
  expectedRevision?: string | number
  force?: boolean
}

/**
 * 乐观并发守卫：调用方可以传 `tiddlywiki_get` 读到的 `modified` 或 `revision`；
 * 与当前值不一致就拒绝写入，避免覆盖人类在 TW 编辑器里的并发修改。
 *
 * ⚠️ 两个令牌是 **AND**，不是 OR（v0.23.5 修复）。旧实现「`modified` 命中就放行、
 * 否则再看 `revision`」，有两个真实缺陷：
 *   1. `revision` 是 TW `wiki.js` 里的**内存**计数器（`changeCount`），**不持久化**，
 *      重启后每条回到 1。调用方读到 `revision: 1` → 人类改动 → 一次 pull/重启让
 *      计数复位 → 带 `expectedRevision: 1` 的写入被判「一致」而**静默覆盖**人类改动。
 *   2. 同时传两个令牌**并不会更安全**：`modified` 不匹配时会落到 `revision` 分支
 *      继续写，等于调用方以为有两重保护、实际只有一重。
 * 现在：**给了哪个令牌就必须匹配哪个**，任一不匹配即拒。只给一个令牌时语义不变
 * （`revision` 仍是「刚 PUT 还没落盘」条目的唯一可用令牌，只是不再当作强令牌）。
 */
export function assertNoConflict(title: string, existing: Tiddler | undefined, expected: ConflictTokens): void {
  if (expected.force === true || existing === undefined) return
  const wantsModified = expected.expectedModified !== undefined
  const wantsRevision = expected.expectedRevision !== undefined
  if (!wantsModified && !wantsRevision) return
  let modifiedOk = true
  if (wantsModified) {
    // 两种日期格式都接受：get 给模型的是 ISO，REST 存的是 TW 紧凑格式。
    const expectedMs = parseTiddlerDate(expected.expectedModified)
    const currentMs = parseTiddlerDate(existing.modified)
    // 无法比较（令牌或当前值解析不出）时判为**不匹配**：宁可让调用方重读一次，
    // 也不要在证据不足时放行一次覆盖。
    modifiedOk = expectedMs !== undefined && currentMs !== undefined && expectedMs === currentMs
  }
  const currentRevision = existing.revision
  const revisionOk = wantsRevision
    ? currentRevision !== undefined && String(currentRevision) === String(expected.expectedRevision)
    : true
  if (modifiedOk && revisionOk) return
  const failed = [!modifiedOk ? 'modified' : null, !revisionOk ? 'revision' : null].filter(Boolean).join('、')
  const revisionHint = !revisionOk && modifiedOk
    ? '（注意：revision 是 TW 的内存计数器，重启/拉取后会复位——它只能证明「读到过」，长时间跨度的写入请用 expectedModified）'
    : ''
  throw new WriteConflictError(
    `写入冲突：tiddler「${title}」在你读取之后已被改动（不匹配的令牌：${failed}；当前 revision=${currentRevision ?? '?'} modified=${toIsoDateString(existing.modified) ?? '?'}；`
    + `期望 revision=${expected.expectedRevision ?? '?'} modified=${expected.expectedModified ?? '?'}）。${revisionHint}`
    + '请重新读取最新内容后重试；确认要用你的版本覆盖时可传 force: true。',
  )
}

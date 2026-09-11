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
import { parseTiddlerDate, toIsoDateString } from './tw-api.ts'

/** 约定标签：标记「由 Agent 撰写」的笔记（新建时自动补打）。 */
export const AGENT_WRITTEN_TAG = 'agent-written'

/** 约定标签：标记「Agent 撰写后又经人类编辑」的笔记。 */
export const HUMAN_EDITED_TAG = 'human-edited'

/** Agent / 人类笔记的默认内容类型（TW 对无 type 的条目按 wikitext 解析）。 */
export const DEFAULT_NOTE_TYPE = 'text/markdown'

/** 构造 PUT body 时跳过的字段（身份/内容/TW 自己的时间戳）。 */
const CLEAN_SKIP_FIELDS = new Set(['title', 'text', 'tags', 'type', 'created', 'modified', 'fields'])

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

/** 合并调用方显式提供的自定义字段（跳过保留字段与 undefined）。 */
export function applyCustomFields(tiddler: Tiddler, fields: Record<string, unknown> | undefined): void {
  if (fields === undefined || fields === null || typeof fields !== 'object') return
  for (const [key, value] of Object.entries(fields)) {
    if (RESERVED_TIDDLER_FIELDS.has(key)) continue
    if (value === undefined) continue
    tiddler[key] = value
  }
}

/** 归一化工具/路由的 `tags` 参数（非数组或全空 → undefined）。 */
export function normalizeTagArg(tags: unknown): string[] | undefined {
  if (!Array.isArray(tags)) return undefined
  const list = tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim())
  return list.length > 0 ? list : undefined
}

/**
 * 计算最终标签：
 * - 已存在的条目 → 调用方给什么就是什么（不给 = 保留基底里的原标签）；
 * - 新条目 + `agentTag` → 自动补 `agent-written`（`$:/` 系统条目除外）；
 * - 新条目 + 人类入口（`agentTag: false`，如快速笔记 / `/note`）→ 不补，
 *   人类写的笔记不该被标成 agent 撰写。
 */
export function finalTagsForWrite(title: string, existing: Tiddler | undefined, tags: string[], agentTag: boolean): string[] {
  if (existing !== undefined) return tags
  if (!agentTag) return tags
  if (title.startsWith('$:/')) return tags
  if (tags.includes(AGENT_WRITTEN_TAG)) return tags
  return [...tags, AGENT_WRITTEN_TAG]
}

/** 计算最终内容类型（原地改 tiddler）：显式 type 优先，`$:/` 保持 TW 默认，其余默认 Markdown。 */
export function finalTypeForWrite(title: string, tiddler: Tiddler): { defaulted: boolean } {
  if (typeof tiddler.type === 'string' && tiddler.type.length > 0) return { defaulted: false }
  if (title.startsWith('$:/')) return { defaulted: false }
  tiddler.type = DEFAULT_NOTE_TYPE
  return { defaulted: true }
}

export interface BuildWriteOptions {
  /** 已有条目（`wiki.get()` 的结果；读失败不得吞成 undefined）。 */
  existing?: Tiddler | undefined
  /** 显式标签：给了就整体替换，没给就保留基底里的原标签。 */
  tags?: string[] | undefined
  /** 显式自定义字段（逐个覆盖在基底之上）。 */
  fields?: Record<string, unknown> | undefined
  /** 新建条目时是否自动补 `agent-written`（agent 工具 true，人类入口 false）。 */
  agentTag?: boolean
  /** 新建条目且未显式给标签时使用的默认标签（人类入口，如 note.tag）。 */
  defaultTags?: string[] | undefined
}

/**
 * 构造一次写要 PUT 的 tiddler。
 *
 * - 已有条目 → 以其为基底（标签、自定义字段、内容类型全部保留）；
 * - 新条目 → `{title, text}` + 默认/显式标签（`$:/` 不带 agent 标签）；
 * - `fields` 逐个覆盖；`type` 未指定时补 Markdown（`$:/` 除外）。
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
  const { defaulted } = finalTypeForWrite(title, tiddler)
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
 */
export function assertNoConflict(title: string, existing: Tiddler | undefined, expected: ConflictTokens): void {
  if (expected.force === true || existing === undefined) return
  const wantsToken = expected.expectedModified !== undefined || expected.expectedRevision !== undefined
  if (!wantsToken) return
  // 两种日期格式都接受：get 给模型的是 ISO，REST 存的是 TW 紧凑格式。
  const expectedMs = parseTiddlerDate(expected.expectedModified)
  const currentMs = parseTiddlerDate(existing.modified)
  if (expectedMs !== undefined && currentMs !== undefined && expectedMs === currentMs) return
  const currentRevision = existing.revision
  if (expected.expectedRevision !== undefined && currentRevision !== undefined
    && String(currentRevision) === String(expected.expectedRevision)) return
  throw new WriteConflictError(
    `写入冲突：tiddler「${title}」在你读取之后已被改动（当前 revision=${currentRevision ?? '?'} modified=${toIsoDateString(existing.modified) ?? '?'}；`
    + `期望 revision=${expected.expectedRevision ?? '?'} modified=${expected.expectedModified ?? '?'}）。`
    + '请重新读取最新内容后重试；确认要用你的版本覆盖时可传 force: true。',
  )
}

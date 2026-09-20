/**
 * 会话相关 wiki 汇总（会话顶部「知识库」Tab 的后端）——把一次 DSH 会话（含其后代
 * subagent）在本会话中产生 / 读取 / 检索过的 wiki 笔记汇总成一篇 TW wikitext，写入
 * TW 的 volatile 命名空间 `$:/temp/dsh/session-summary/<会话ID>`。
 *
 * 判定来源（设计定稿，探查验证）：
 * - Host 服务 `sessionQuery`（可选注入）：`readSession(sessionId)` 返回完整事件日志
 *   （events 升序），`traceSession` 返回祖先/后代树。绝不直接解析
 *   `~/.dsh/sessions` 目录下的 session 文件——那是 zstd 压缩的。
 * - `tool/call` 事件精确记录每次 `tiddlywiki_*` 调用的 `name` 与
 *   `arguments`（JSON 字符串）。
 * - `assistant/message` 事件 `message.content` 的 text 块可扫
 *   `/dsh-tiddlywiki/tw/#...` 引用链接（视为「读取」）。
 *
 * 归类规则（§三 定稿 + v0.24.x 补齐）：
 *   产生 📝 put / batch_put / append（增量写入）/ attach（附件）/ rename /
 *           trash 的 action=restore（arguments 取 title）
 *   读取 👀 tiddlywiki_get（title）+ 助手回复里的 wiki 引用链接
 *   检索 🔍 search / recent（记关键词，不算单篇）
 *   删除 🗑 delete / trash（restore 以外）——注入提示词推荐「纯增量内容优先 append」，
 *           漏掉 append 会让用 append 写的笔记整篇不出现在 Tab 里，会话被误判成
 *           「没产生过任何笔记」；删除同理（做过的事就该看得见）。
 *   范围   本会话 + 后代 subagent（traceSession 递归，仅子代理触达的笔记标注）
 *
 * 渲染（§四）：写入 `$:/temp/...`——TW 5.4.1 默认 `$:/config/SyncFilter` 显式
 * `-[prefix[$:/temp/]]`（core/wiki/config/SyncFilter.tid），服务端 syncer 从不把
 * $:/temp 落盘：内存态、不进 git、TW 重启即消失（已实测：PUT 204、tiddlers/ 无文件、
 * git clean）。TW 用自己主题/链接/导航原生渲染，不另造 UI。
 *
 * @module dsh-tiddlywiki/host/session-summary
 */
import { parseTiddlerDate, type TiddlyWebClient } from './tw-api.ts'
import { formatLocalMinute } from './text-util.ts'

/** 会话汇总 tiddler 的 $:/temp 命名空间前缀。 */
export const SESSION_SUMMARY_PREFIX = '$:/temp/dsh/session-summary/'

/**
 * 会话内能触达 wiki 的 tiddlywiki_* 工具名（search/recent 只记检索记录，不算单篇）。
 *
 * 必须与「产生 / 读取 / 删除」的三条实际写读路径对齐：注入的系统提示词明确推荐
 * 「纯增量内容优先用 tiddlywiki_append」，`tiddlywiki_attach` 写附件条目、
 * `tiddlywiki_delete` / `tiddlywiki_trash` 动已有笔记——漏掉任何一个，那一类操作
 * 都会从汇总里整体消失（会话被误判成「没碰过任何笔记」）。
 */
const NOTE_TOOL_NAMES = new Set([
  'tiddlywiki_put',
  'tiddlywiki_batch_put',
  'tiddlywiki_append',
  'tiddlywiki_attach',
  'tiddlywiki_rename',
  'tiddlywiki_get',
  'tiddlywiki_search',
  'tiddlywiki_recent',
  'tiddlywiki_delete',
  'tiddlywiki_trash',
])

/** 每篇笔记的触达摘要（按 title 去重，时间取最近一次）。 */
export interface NoteEntry {
  title: string
  action: 'produced' | 'read' | 'deleted'
  /** 最近一次触达的 epoch ms。 */
  time: number
  /** 附加说明（如 rename 的旧标题、append 的「增量写入」）。 */
  detail?: string
  /** true = 仅由后代 subagent 触达过（本会话自己没碰过）。 */
  subagent: boolean
}

/** 一次检索类调用（search / recent），不算单篇笔记。 */
export interface SearchRecord {
  kind: 'search' | 'recent'
  query: string
  tags: string[]
  time: number
  subagent: boolean
}

/** 一次会话扫描的收集结果。 */
export interface Collected {
  produced: Map<string, NoteEntry>
  read: Map<string, NoteEntry>
  /** 被删除 / 移入回收站的笔记（trash 的 restore 反之计入 produced）。 */
  deleted: Map<string, NoteEntry>
  searches: SearchRecord[]
}

/**
 * 结构化 `sessionQuery` 服务脸（dsh-api-session-query 的极小子集，只声明本模块用到
 * 的方法；运行时实例是真实 Service，绝不是 Inspect 数据）。
 */
export interface SessionQueryFace {
  /** Read and replay-validate one complete logical session log (events ascending). */
  readSession(sessionId: string): Promise<SessionLogSnapshot>
  /** Trace known ancestry and descendants from one corpus observation. */
  traceSession(sessionId: string, signal?: AbortSignal): Promise<SessionLineageTrace>
}

export interface SessionLogSnapshot {
  session: { id: string }
  events: SessionEvent[]
}

export interface SessionEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
}

export interface SessionLineageTrace {
  descendants: SessionLineageNode[]
}

export interface SessionLineageNode {
  session: { header: { id: string } }
  descendants: SessionLineageNode[]
}

/**
 * Bounds so one enormous session tree cannot make the「知识库」Tab unresponsive:
 * the summary reads every listed session's FULL event log and then probes each
 * touched tiddler over REST.
 */
const MAX_SESSIONS = 40
const MAX_SEARCH_RECORDS = 200
const MAX_ENRICH_TITLES = 300

/** 读会话事件日志的并发路数（风格同 `enrichTitles` 的 8 路；日志比单篇条目重，减半）。 */
const SESSION_READ_CONCURRENCY = 4

/**
 * 探测整段的墙钟预算（v0.24.x）：`enrichTitles` 最多 300 篇 × 每篇一次 `client.get`
 * （内部超时 10s）÷ 8 路并发 ≈ 最坏 375s，远超客户端 25s 的 abort——TW 卡顿时宿主
 * 会一直压着 TW 打，客户端却早就放弃了。超预算的标题按既有「未探测」分支渲染：
 * 少几行状态可以接受，把一次汇总变成对 TW 的持续拒绝服务不行。
 */
const ENRICH_BUDGET_MS = 12_000

/** 递归收集后代树里所有 session id（不含根自身，超过上限即停）。 */
function collectDescendantIds(nodes: SessionLineageNode[] | undefined, out: string[]): void {
  if (!Array.isArray(nodes)) return
  for (const node of nodes) {
    if (out.length >= MAX_SESSIONS) return
    const id = node?.session?.header?.id
    if (typeof id === 'string' && id.length > 0) {
      out.push(id)
      collectDescendantIds(node?.descendants, out)
    }
  }
}

/**
 * 汇总条目会直接写进 `[[标题]]` wikitext——标题既要能安全渲染、又不能制造死链。
 * 会话日志里常混入模型的示例/残缺写法（`#…`、`#标题`、带反引号的截断链接、
 * 控制字符等），这类收进来会被 TW 渲染成「佚失条目」；一律过滤。
 */
function isPlausibleTitle(title: string): boolean {
  if (title.length === 0 || title.length > 300) return false
  if (title.trim().length === 0) return false
  if (/[\u0000-\u001f\u007f]/.test(title)) return false // 控制字符 / 换行
  if (/[\]|`#]/.test(title)) return false // 会破坏 [[…]] 链接语法
  if (title.startsWith('…') || title === '标题') return false // 占位 / 示例写法
  return true
}

/** 记录一篇笔记的触达；同标题合并（时间取最新、detail 取最新、subagent 取 AND）。 */
function record(map: Map<string, NoteEntry>, entry: NoteEntry): void {
  if (entry.title.startsWith('$:/')) return
  if (!isPlausibleTitle(entry.title)) return
  const prev = map.get(entry.title)
  if (prev !== undefined) {
    prev.time = Math.max(prev.time, entry.time)
    if (entry.detail !== undefined) prev.detail = entry.detail
    prev.subagent = prev.subagent && entry.subagent
    return
  }
  map.set(entry.title, { ...entry })
}

/**
 * 削掉链接语法留下的收尾符 `)`/`]`。
 *
 * TW 标题允许 `)` / `]`（`[标题](/dsh-tiddlywiki/tw/#标题)` 里的标题也常带括号），
 * 但它们同时是 Markdown/链接的收尾符——一律截断会切掉合法标题（老正则的 bug），
 * 一律保留又会把收尾符吃进标题。折中：只在「剩余部分里没有与之配对的开启符」时
 * 判定它是收尾符。必须**先削尾再 decodeURIComponent**，否则编码过的 `%29` 会被
 * 当成收尾符削掉。
 */
function trimTrailingClosers(raw: string): string {
  let s = raw
  for (;;) {
    const last = s.slice(-1)
    if (last !== ')' && last !== ']') return s
    const open = last === ')' ? '(' : '['
    if (s.slice(0, -1).includes(open)) return s
    s = s.slice(0, -1)
  }
}

/** 扫助手回复文本里的 `/dsh-tiddlywiki/tw/#标题` 引用链接 → 读取。 */
function scanRefs(text: string, time: number, subagent: boolean, collected: Collected): void {
  // 只认到下一个 `#` / 空白为止（`#` 之后再出现 `#` 是 URL 片段分隔，标题里的 `#`
  // 按链接约定必须编码）；`)` / `]` 不再一律截断——它们是合法标题字符，只有落在
  // 末尾且无配对开启符时才当收尾符削掉（见 trimTrailingClosers）。
  const re = /\/dsh-tiddlywiki\/tw\/#([^#\s]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = trimTrailingClosers(m[1] ?? '')
    if (raw.length === 0) continue
    let title = raw
    try {
      title = decodeURIComponent(raw)
    } catch {
      /* keep raw on malformed percent-encoding */
    }
    if (title.length === 0) continue
    record(collected.read, { title, action: 'read', time, subagent })
  }
}

/** 扫描一次会话的事件日志，按 §三 规则收集笔记触达与检索记录。 */
function scanSnapshot(snap: SessionLogSnapshot | undefined, subagent: boolean, collected: Collected): void {
  const events = snap?.events
  if (!Array.isArray(events)) return
  for (const ev of events) {
    const type = ev?.type
    const t = typeof ev?.time === 'number' ? ev.time : Date.now()
    if (type === 'tool/call') {
      const name = ev.data?.name
      if (typeof name !== 'string' || !NOTE_TOOL_NAMES.has(name)) continue
      let args: Record<string, unknown> = {}
      if (typeof ev.data?.arguments === 'string') {
        try {
          args = JSON.parse(ev.data.arguments) as Record<string, unknown>
        } catch {
          args = {}
        }
      }
      switch (name) {
        case 'tiddlywiki_put':
          if (typeof args.title === 'string' && args.title.length > 0) {
            record(collected.produced, { title: args.title, action: 'produced', time: t, subagent })
          }
          break
        case 'tiddlywiki_batch_put':
          if (Array.isArray(args.items)) {
            for (const item of args.items) {
              if (item !== null && typeof item === 'object' && typeof (item as { title?: unknown }).title === 'string') {
                const title = (item as { title: string }).title
                if (title.length > 0) record(collected.produced, { title, action: 'produced', time: t, subagent })
              }
            }
          }
          break
        case 'tiddlywiki_append':
          // 注入提示词推荐「纯增量内容优先用 append」——它和 put 一样是「产生笔记」，
          // 且是最高频的笔记写入路径，漏掉它整篇汇总就空了。
          if (typeof args.title === 'string' && args.title.length > 0) {
            record(collected.produced, { title: args.title, action: 'produced', time: t, detail: '增量写入', subagent })
          }
          break
        case 'tiddlywiki_attach':
          // 附件写成二进制 tiddler（标题 = args.title），同样是本会话产生的内容。
          if (typeof args.title === 'string' && args.title.length > 0) {
            record(collected.produced, { title: args.title, action: 'produced', time: t, detail: '附件', subagent })
          }
          break
        case 'tiddlywiki_rename':
          if (typeof args.newTitle === 'string' && args.newTitle.length > 0) {
            const old = typeof args.oldTitle === 'string' && args.oldTitle.length > 0 ? args.oldTitle : undefined
            record(collected.produced, {
              title: args.newTitle,
              action: 'produced',
              time: t,
              detail: old !== undefined && isPlausibleTitle(old) ? `重命名自「${old}」` : undefined,
              subagent,
            })
          }
          break
        case 'tiddlywiki_get':
          if (typeof args.title === 'string' && args.title.length > 0) {
            record(collected.read, { title: args.title, action: 'read', time: t, subagent })
          }
          break
        case 'tiddlywiki_delete':
          // 默认软删除（进回收站）也算删除：这个 Tab 的职责是「本会话动过哪些笔记」，
          // 删掉的东西不该凭空消失。
          if (typeof args.title === 'string' && args.title.length > 0) {
            record(collected.deleted, { title: args.title, action: 'deleted', time: t, subagent })
          }
          break
        case 'tiddlywiki_trash': {
          // action=restore 把笔记从回收站救回来 = 产生；list / empty 是回收站维护，
          // 没有单篇标题（empty 清空整个回收站）→ 没有可链接的标题就什么都不记，
          // 免得在汇总里凭空造出一个死链。
          const trashAction = typeof args.action === 'string' ? args.action : ''
          const trashTitle = typeof args.title === 'string' && args.title.length > 0 ? args.title : undefined
          if (trashTitle === undefined) break
          if (trashAction === 'restore') {
            record(collected.produced, { title: trashTitle, action: 'produced', time: t, detail: '回收站恢复', subagent })
          } else {
            record(collected.deleted, { title: trashTitle, action: 'deleted', time: t, detail: '移入回收站', subagent })
          }
          break
        }
        case 'tiddlywiki_search': {
          if (collected.searches.length >= MAX_SEARCH_RECORDS) break
          const query = typeof args.query === 'string' ? args.query : ''
          const tags = Array.isArray(args.tags) ? args.tags.filter((x): x is string => typeof x === 'string') : []
          collected.searches.push({ kind: 'search', query, tags, time: t, subagent })
          break
        }
        case 'tiddlywiki_recent':
          if (collected.searches.length < MAX_SEARCH_RECORDS) {
            collected.searches.push({ kind: 'recent', query: '', tags: [], time: t, subagent })
          }
          break
      }
    } else if (type === 'assistant/message') {
      const message = ev.data?.message
      const content = message !== null && typeof message === 'object' ? (message as { content?: unknown }).content : undefined
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block === null || typeof block !== 'object') continue
          const b = block as { type?: unknown; text?: unknown }
          if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
            scanRefs(b.text, t, subagent, collected)
          }
        }
      }
    }
  }
}

/**
 * 内联文本净化（v0.19.3，v0.24.x 补 `{}` + 截断顺序）：汇总 wikitext 会被 TW 渲染成
 * HTML 片段再注入 DSH 页面，而 TW 的解析器**原样透传 HTML**，并且会把 `{{…}}`
 * 当**转写**展开（会话日志里随手出现的 `{{$:/plugins/dsh-tiddlywiki/config}}`
 * 实测能直接把插件配置 JSON 读出来）。凡是来自会话日志/请求体的字符串（sessionId、
 * rename 的旧标题、检索词、tags、modified 解析失败时的原样回显）都要先中和
 * HTML 元字符 + 链接语法 + 转写花括号，别指望上层净化。
 *
 * 顺序上**先截断再转义**：反过来会把 `&amp;` 从中间截成 `&am`（既不可读，又留下
 * 半个实体）。
 */
export function escapeInline(text: string, max = 200): string {
  return text
    .slice(0, max)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[[\]|{}]/g, ' ')
}

/** 当前状态（存在？标签？修改时间？摘要）。 */
interface TitleState {
  exists: boolean
  tags: string[]
  modified?: string
  snippet?: string
  /** 查询失败（非 404）：状态未知，不能报「已删除/不存在」。 */
  unknown?: boolean
}

/** 并发（8 路）查询每篇笔记的当前状态（404 → 不存在/已删除）。 */
async function enrichTitles(client: TiddlyWebClient, titles: string[]): Promise<Map<string, TitleState>> {
  const out = new Map<string, TitleState>()
  const enquire = async (title: string): Promise<[string, TitleState]> => {
    try {
      const t = await client.get(title)
      if (t === undefined) return [title, { exists: false, tags: [] }]
      const flat = typeof t.text === 'string' ? t.text.replace(/\s+/g, ' ').trim() : ''
      return [title, {
        exists: true,
        tags: t.tags ?? [],
        modified: typeof t.modified === 'string' ? t.modified : undefined,
        snippet: flat.length > 48 ? `${flat.slice(0, 48)}…` : flat,
      }]
    } catch {
      // 只有 404 才算「不存在」（tw-api 的 get 只在 404 返回 undefined）：
      // 超时/5xx/服务重启中的查询失败必须报「状态未知」，否则一篇还在的笔记
      // 会被标成「已删除」——正是项目里反复强调的「读取失败 ≠ 条目不存在」。
      return [title, { exists: false, tags: [], unknown: true }]
    }
  }
  // Bounded batches: parallel within a batch, insertion order preserved across
  // batches (Map order = the caller's title order, same as the old sequential).
  // 整段还有墙钟预算：每批开始前检查，超预算的标题直接不放进 Map → 调用方按
  // 「未探测」分支渲染（宁可少几行状态，也不能一直压着 TW 打）。
  const deadline = Date.now() + ENRICH_BUDGET_MS
  for (let i = 0; i < titles.length; i += 8) {
    if (Date.now() >= deadline) break
    const batch = titles.slice(i, i + 8)
    for (const [title, state] of await Promise.all(batch.map(enquire))) out.set(title, state)
  }
  return out
}

/** epoch ms → 本地 `YYYY-MM-DD HH:mm`（与 routes.ts 的 timestampTitle 共用一份实现）。 */
function fmtTime(ms: number): string {
  return formatLocalMinute(ms)
}

/**
 * TW `modified` → 本地时间（解析失败则原样返回）。
 *
 * v0.20.0: the REST layer returns the COMPACT form (`20260101000000000`,
 * YYYYMMDDhhmmssSSS UTC), which `Date.parse()` rejects with NaN — the summary
 * therefore printed the raw 17-digit string. `parseTiddlerDate` handles both
 * the compact and the ISO form (same rule as the rest of the host).
 */
function fmtModified(value: string | undefined): string {
  if (value === undefined || value.length === 0) return ''
  const ms = parseTiddlerDate(value)
  return ms === undefined ? value : fmtTime(ms)
}

/** 组装分组 wikitext：产生 / 读取（未产生过的）/ 检索记录 / 删除。 */
function buildWikitext(
  sessionId: string,
  readFailed: string[],
  collected: Collected,
  producedTitles: string[],
  readTitles: string[],
  deletedTitles: string[],
  stateByTitle: Map<string, TitleState>,
): string {
  const lines: string[] = []
  lines.push('! 会话相关 wiki 汇总')
  lines.push('')
  lines.push(
    `本页列出会话 \`${escapeInline(sessionId, 120)}\`（含其后代子代理）在本会话中产生 / 读取 / 检索 / 删除过的知识库笔记。`,
  )
  lines.push('')
  // 事件日志读不出来的会话必须在**页面上**明说：否则它的笔记整体消失，读者只会
  // 得出「本会话没碰过笔记」这个错误结论（readFailed 为空时这行整体不出现）。
  if (readFailed.length > 0) {
    lines.push(`> ⚠️ ${readFailed.length} 个会话的事件日志读取失败，汇总可能不完整：${readFailed.map((id) => escapeInline(id, 120)).join('、')}`)
    lines.push('')
  }
  const producedCount = producedTitles.length
  const readCount = readTitles.length
  const searchCount = collected.searches.length
  const deletedCount = deletedTitles.length
  // Was anything touched ONLY through a descendant subagent? (The old column
  // said「本会话 + 子代理」whenever anything existed at all.)
  const anySubagent =
    [...collected.produced.values()].some((e) => e.subagent) ||
    [...collected.read.values()].some((e) => e.subagent) ||
    [...collected.deleted.values()].some((e) => e.subagent) ||
    collected.searches.some((s) => s.subagent)
  if (producedCount + readCount + searchCount + deletedCount === 0) {
    lines.push('> 本会话暂时没有产生、读取、检索或删除过任何知识库笔记。')
    lines.push('>')
    lines.push('> 本页为会话自动生成的临时汇总（`$:/temp`，不落盘、不进 git，重启 TW 即消失）；需要时点 Tab 顶栏的「🔄 刷新」重新生成。')
    return lines.join('\n')
  }
  lines.push(
    '| 产生 📝 | 读取 👀 | 检索 🔍 | 删除 🗑 | 涉及会话 |',
    '| --- | --- | --- | --- | --- |',
    `| ${producedCount} | ${readCount} | ${searchCount} | ${deletedCount} | ${anySubagent ? '本会话 + 子代理' : '本会话'} |`,
  )
  lines.push('')

  const entryLine = (title: string, state: TitleState | undefined, entry: NoteEntry): string => {
    const bits: string[] = [`[[${title}]]`]
    if (state === undefined) {
      // Not probed at all: `enrichTitles` stops at MAX_ENRICH_TITLES / the wall-clock
      // budget, so a long session's tail must NOT be reported as「已删除/不存在」
      // (v0.19.5) — that is a false accusation, not a status.
      bits.push('（本轮查询预算用尽，未探测）')
    } else if (state.unknown === true) {
      bits.push('⚠️ 状态未知（查询失败）')
    } else if (!state.exists) {
      bits.push('⚠️ 已删除/不存在')
    } else {
      if (state.tags.length > 0) bits.push(`标签 ${state.tags.slice(0, 6).map((tag) => escapeInline(tag, 40)).join('、')}${state.tags.length > 6 ? '…' : ''}`)
      const mod = fmtModified(state.modified)
      if (mod.length > 0) bits.push(`修改 ${mod}`)
      // v0.24.x：snippet 之前只被赋值、从没渲染（每篇白做一次全文归一化）。
      // 渲染出来信息量更大，也顺手兑现了 enrichTitles 的探测成本。
      const snip = state.snippet ?? ''
      if (snip.length > 0) bits.push(`摘要 ${escapeInline(snip, 60)}`)
    }
    const t = fmtTime(entry.time)
    if (t.length > 0) bits.push(`会话内 ${t}`)
    if (entry.detail !== undefined) bits.push(escapeInline(entry.detail, 200))
    if (entry.subagent) bits.push('（子代理）')
    return `* ${bits.join(' · ')}`
  }

  if (producedCount > 0) {
    lines.push('!!! 📝 产生')
    for (const title of producedTitles) {
      const entry = collected.produced.get(title)
      if (entry !== undefined) lines.push(entryLine(title, stateByTitle.get(title), entry))
    }
    lines.push('')
  }
  if (readCount > 0) {
    lines.push('!!! 👀 读取')
    for (const title of readTitles) {
      const entry = collected.read.get(title)
      if (entry !== undefined) lines.push(entryLine(title, stateByTitle.get(title), entry))
    }
    lines.push('')
  }
  if (searchCount > 0) {
    lines.push('!!! 🔍 检索记录')
    for (const r of collected.searches) {
      const bits: string[] = []
      if (r.kind === 'search') {
        bits.push(`\`tiddlywiki_search\` query=「${r.query.length > 0 ? escapeInline(r.query, 120) : '(空)'}」`)
        if (r.tags.length > 0) bits.push(`tags ${r.tags.map((tag) => escapeInline(tag, 40)).join('、')}`)
      } else {
        bits.push('`tiddlywiki_recent`（最近修改）')
      }
      const t = fmtTime(r.time)
      if (t.length > 0) bits.push(t)
      if (r.subagent) bits.push('（子代理）')
      lines.push(`* ${bits.join(' · ')}`)
    }
    lines.push('')
  }
  if (deletedCount > 0) {
    lines.push('!!! 🗑 删除 / 回收站')
    for (const title of deletedTitles) {
      const entry = collected.deleted.get(title)
      if (entry !== undefined) lines.push(entryLine(title, stateByTitle.get(title), entry))
    }
    lines.push('')
  }
  lines.push('---')
  lines.push('> 本页为会话自动生成的临时汇总（`$:/temp`，不落盘、不进 git，重启 TW 即消失）；需要时点 Tab 顶栏的「🔄 刷新」重新生成。')
  return lines.join('\n')
}

export interface SessionSummaryResult {
  title: string
  counts: { produced: number; read: number; searches: number; deleted: number; sessions: number }
  /**
   * 事件日志读取失败的会话 id（按发现顺序）。`counts.sessions` 只统计**成功读取**
   * 的会话——失败被静默吞掉时页面会把「读不出来」显示成「这个会话没碰过笔记」。
   */
  readFailed: string[]
  empty: boolean
  generatedAt: string
}

/**
 * 生成并写入一篇会话汇总 tiddler（$:/temp，volatile）。
 * @param client  可用 TW 客户端（调用方已保证 wiki 服务在线）。
 * @param sq      sessionQuery 服务（调用方已保证可用）。
 * @param sessionId 目标会话 id（本会话 + 后代 subagent）。
 */
export async function writeSessionSummary(client: TiddlyWebClient, sq: SessionQueryFace, sessionId: string): Promise<SessionSummaryResult> {
  // 1) 会话范围：自身 + traceSession 后代树（递归）。trace 失败（会话已归档/不存在）
  //    就只汇总自身，绝不让单次失败拖垮整页。
  const ids: string[] = [sessionId]
  try {
    const trace = await sq.traceSession(sessionId, AbortSignal.timeout(10_000))
    collectDescendantIds(trace?.descendants, ids)
  } catch {
    /* trace unavailable → self only */
  }

  // 2) 读每个会话的完整事件日志：有界并发（4 路），再按 ids 原始顺序逐个
  //    scanSnapshot——并发只提速，收集顺序仍与串行一致（结果确定）。串行读最多
  //    MAX_SESSIONS 个会话（每个都是完整日志）会让延迟线性叠加，而 readSession
  //    的接口签名没有 signal（不改签名：宿主其它消费方共用它）。
  //    单条失败只记进 readFailed，其余照常（一个坏会话不该毁掉整页汇总）。
  const collected: Collected = { produced: new Map(), read: new Map(), deleted: new Map(), searches: [] }
  const readResults: Array<{ id: string; snap?: SessionLogSnapshot }> = []
  for (let i = 0; i < ids.length; i += SESSION_READ_CONCURRENCY) {
    const batch = ids.slice(i, i + SESSION_READ_CONCURRENCY)
    const done = await Promise.all(
      batch.map(async (id) => {
        try {
          return { id, snap: await sq.readSession(id) }
        } catch {
          return { id }
        }
      }),
    )
    readResults.push(...done)
  }
  const readFailed: string[] = []
  for (const r of readResults) {
    if (r.snap === undefined) {
      readFailed.push(r.id)
      continue
    }
    scanSnapshot(r.snap, r.id !== sessionId, collected)
  }

  // 3) 产生优先：同时被产生+读取的笔记只列在「产生」，读取区只放未产生过的。
  const producedTitles = [...collected.produced.keys()].sort((a, b) => (collected.produced.get(b)?.time ?? 0) - (collected.produced.get(a)?.time ?? 0))
  const readTitles = [...collected.read.keys()]
    .filter((t) => !collected.produced.has(t))
    .sort((a, b) => (collected.read.get(b)?.time ?? 0) - (collected.read.get(a)?.time ?? 0))
  const deletedTitles = [...collected.deleted.keys()].sort((a, b) => (collected.deleted.get(b)?.time ?? 0) - (collected.deleted.get(a)?.time ?? 0))
  collected.searches.sort((a, b) => b.time - a.time)

  // 4) 查询当前状态（存在？标签？时间？摘要）→ 组装 wikitext → PUT volatile tiddler。
  //    探测量有上限（篇数 + 墙钟预算）：一篇超长会话可能触碰成百上千篇笔记。
  //    删除过的标题同样探测：这样它们能显示「已删除/不存在」或「已恢复」，而不是
  //    因为没进探测集被误标成「未探测」。
  const allTitles = [...new Set([...producedTitles, ...readTitles, ...deletedTitles])]
  const probedTitles = allTitles.slice(0, MAX_ENRICH_TITLES)
  const stateByTitle = await enrichTitles(client, probedTitles)
  const text = buildWikitext(sessionId, readFailed, collected, producedTitles, readTitles, deletedTitles, stateByTitle)
  const title = `${SESSION_SUMMARY_PREFIX}${sessionId}`
  await client.put({ title, text, type: 'text/vnd.tiddlywiki', tags: [] })

  return {
    title,
    counts: {
      produced: producedTitles.length,
      read: readTitles.length,
      searches: collected.searches.length,
      deleted: deletedTitles.length,
      // 只算成功读取的会话：读取失败的会话要在页面上被看见（readFailed），而不是
      // 混进「一共汇总了 N 个会话」里假装一切正常。
      sessions: ids.length - readFailed.length,
    },
    readFailed,
    empty: producedTitles.length + readTitles.length + collected.searches.length + deletedTitles.length === 0,
    generatedAt: new Date().toISOString(),
  }
}

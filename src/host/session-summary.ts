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
 * 归类规则（§三 定稿）：
 *   产生 📝 tiddlywiki_put / batch_put / rename（arguments 取 title）
 *   读取 👀 tiddlywiki_get（title）+ 助手回复里的 wiki 引用链接
 *   检索 🔍 search / recent（记关键词，不算单篇）
 *   范围   本会话 + 后代 subagent（traceSession 递归，仅子代理触达的笔记标注）
 *
 * 渲染（§四）：写入 `$:/temp/...`——TW 5.4.1 默认 `$:/config/SyncFilter` 显式
 * `-[prefix[$:/temp/]]`（core/wiki/config/SyncFilter.tid），服务端 syncer 从不把
 * $:/temp 落盘：内存态、不进 git、TW 重启即消失（已实测：PUT 204、tiddlers/ 无文件、
 * git clean）。TW 用自己主题/链接/导航原生渲染，不另造 UI。
 *
 * @module dsh-tiddlywiki/host/session-summary
 */
import type { TiddlyWebClient } from './tw-api.ts'

/** 会话汇总 tiddler 的 $:/temp 命名空间前缀。 */
export const SESSION_SUMMARY_PREFIX = '$:/temp/dsh/session-summary/'

/** 会话内能触达 wiki 的 tiddlywiki_* 工具名（search/recent 只记检索记录，不算单篇）。 */
const NOTE_TOOL_NAMES = new Set(['tiddlywiki_put', 'tiddlywiki_batch_put', 'tiddlywiki_rename', 'tiddlywiki_get', 'tiddlywiki_search', 'tiddlywiki_recent'])

/** 每篇笔记的触达摘要（按 title 去重，时间取最近一次）。 */
export interface NoteEntry {
  title: string
  action: 'produced' | 'read'
  /** 最近一次触达的 epoch ms。 */
  time: number
  /** 附加说明（如 rename 的旧标题）。 */
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

/** 扫助手回复文本里的 `/dsh-tiddlywiki/tw/#标题` 引用链接 → 读取。 */
function scanRefs(text: string, time: number, subagent: boolean, collected: Collected): void {
  // 只认到下一个 `)` / 空白 / `]` / `#` 为止——`#` 会截断后续碎片（模型示例常写成
  // `#…` 或 `#标题`，这些由 isPlausibleTitle 在 record 时过滤）。
  const re = /\/dsh-tiddlywiki\/tw\/#([^#)\s\]]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = m[1] ?? ''
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
        case 'tiddlywiki_rename':
          if (typeof args.newTitle === 'string' && args.newTitle.length > 0) {
            const old = typeof args.oldTitle === 'string' && args.oldTitle.length > 0 ? args.oldTitle : undefined
            record(collected.produced, {
              title: args.newTitle,
              action: 'produced',
              time: t,
              detail: old !== undefined ? `重命名自「${old}」` : undefined,
              subagent,
            })
          }
          break
        case 'tiddlywiki_get':
          if (typeof args.title === 'string' && args.title.length > 0) {
            record(collected.read, { title: args.title, action: 'read', time: t, subagent })
          }
          break
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

/** 当前状态（存在？标签？修改时间？摘要）。 */
interface TitleState {
  exists: boolean
  tags: string[]
  modified?: string
  snippet?: string
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
      return [title, { exists: false, tags: [] }]
    }
  }
  // Bounded batches: parallel within a batch, insertion order preserved across
  // batches (Map order = the caller's title order, same as the old sequential).
  for (let i = 0; i < titles.length; i += 8) {
    const batch = titles.slice(i, i + 8)
    for (const [title, state] of await Promise.all(batch.map(enquire))) out.set(title, state)
  }
  return out
}

/** epoch ms → 本地 `YYYY-MM-DD HH:mm`。 */
function fmtTime(ms: number): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** TW modified ISO → 本地时间（解析失败则原样返回）。 */
function fmtModified(iso: string | undefined): string {
  if (iso === undefined || iso.length === 0) return ''
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? iso : fmtTime(ms)
}

/** 组装分组 wikitext：产生 / 读取（未产生过的）/ 检索记录。 */
function buildWikitext(
  sessionId: string,
  collected: Collected,
  producedTitles: string[],
  readTitles: string[],
  stateByTitle: Map<string, TitleState>,
): string {
  const lines: string[] = []
  lines.push('! 会话相关 wiki 汇总')
  lines.push('')
  lines.push(
    `本页列出会话 \`${sessionId}\`（含其后代子代理）在本会话中产生 / 读取 / 检索过的知识库笔记。`,
  )
  lines.push('')
  const producedCount = producedTitles.length
  const readCount = readTitles.length
  const searchCount = collected.searches.length
  // Was anything touched ONLY through a descendant subagent? (The old column
  // said「本会话 + 子代理」whenever anything existed at all.)
  const anySubagent =
    [...collected.produced.values()].some((e) => e.subagent) ||
    [...collected.read.values()].some((e) => e.subagent) ||
    collected.searches.some((s) => s.subagent)
  if (producedCount + readCount + searchCount === 0) {
    lines.push('> 本会话暂时没有产生、读取或检索过任何知识库笔记。')
    lines.push('>')
    lines.push('> 本页为会话自动生成的临时汇总（`$:/temp`，不落盘、不进 git，重启 TW 即消失）；需要时点 Tab 顶栏的「🔄 刷新」重新生成。')
    return lines.join('\n')
  }
  lines.push(
    '| 产生 📝 | 读取 👀 | 检索 🔍 | 涉及会话 |',
    '| --- | --- | --- | --- |',
    `| ${producedCount} | ${readCount} | ${searchCount} | ${anySubagent ? '本会话 + 子代理' : '本会话'} |`,
  )
  lines.push('')

  const entryLine = (title: string, state: TitleState | undefined, entry: NoteEntry): string => {
    const bits: string[] = [`[[${title}]]`]
    if (state === undefined || !state.exists) {
      bits.push('⚠️ 已删除/不存在')
    } else {
      if (state.tags.length > 0) bits.push(`标签 ${state.tags.slice(0, 6).join('、')}${state.tags.length > 6 ? '…' : ''}`)
      const mod = fmtModified(state.modified)
      if (mod.length > 0) bits.push(`修改 ${mod}`)
    }
    const t = fmtTime(entry.time)
    if (t.length > 0) bits.push(`会话内 ${t}`)
    if (entry.detail !== undefined) bits.push(entry.detail)
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
        bits.push(`\`tiddlywiki_search\` query=「${r.query.length > 0 ? r.query : '(空)'}」`)
        if (r.tags.length > 0) bits.push(`tags ${r.tags.join('、')}`)
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
  lines.push('---')
  lines.push('> 本页为会话自动生成的临时汇总（`$:/temp`，不落盘、不进 git，重启 TW 即消失）；需要时点 Tab 顶栏的「🔄 刷新」重新生成。')
  return lines.join('\n')
}

export interface SessionSummaryResult {
  title: string
  counts: { produced: number; read: number; searches: number; sessions: number }
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

  // 2) 逐个会话读完整事件日志并收集（任一失败跳过，其余照常）。
  const collected: Collected = { produced: new Map(), read: new Map(), searches: [] }
  for (const id of ids) {
    try {
      const snap = await sq.readSession(id)
      scanSnapshot(snap, id !== sessionId, collected)
    } catch {
      /* one bad session must not fail the whole summary */
    }
  }

  // 3) 产生优先：同时被产生+读取的笔记只列在「产生」，读取区只放未产生过的。
  const producedTitles = [...collected.produced.keys()].sort((a, b) => (collected.produced.get(b)?.time ?? 0) - (collected.produced.get(a)?.time ?? 0))
  const readTitles = [...collected.read.keys()]
    .filter((t) => !collected.produced.has(t))
    .sort((a, b) => (collected.read.get(b)?.time ?? 0) - (collected.read.get(a)?.time ?? 0))
  collected.searches.sort((a, b) => b.time - a.time)

  // 4) 查询当前状态（存在？标签？时间？）→ 组装 wikitext → PUT volatile tiddler。
  //    探测量有上限：一篇超长会话可能触碰成百上千篇笔记。
  const allTitles = [...new Set([...producedTitles, ...readTitles])]
  const stateByTitle = await enrichTitles(client, allTitles.slice(0, MAX_ENRICH_TITLES))
  const text = buildWikitext(sessionId, collected, producedTitles, readTitles, stateByTitle)
  const title = `${SESSION_SUMMARY_PREFIX}${sessionId}`
  await client.put({ title, text, type: 'text/vnd.tiddlywiki', tags: [] })

  return {
    title,
    counts: { produced: producedTitles.length, read: readTitles.length, searches: collected.searches.length, sessions: ids.length },
    empty: producedTitles.length + readTitles.length + collected.searches.length === 0,
    generatedAt: new Date().toISOString(),
  }
}

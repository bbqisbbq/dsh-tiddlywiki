/**
 * 会话事件日志的**扫描层**（v0.30.18 从 `session-summary.ts` 拆出，纯搬迁）。
 *
 * 它只做一件事：把一份会话事件日志快照按规则读成「这次会话碰过哪些笔记 / 做过哪些检索」。
 * 不碰网络、不碰 tiddler、不认识 wikitext —— 那些留在 base（编排）与 enrich / wikitext 两片里。
 * 单独成文件是因为它是这一族里**唯一带解析规则**的部分（正则、去重、各类上限），
 * 也是唯一值得单独审读的部分。
 *
 * 与 base 的关系：类型用 `import type` 拿回来（类型期闭环、运行期无环，本仓库既有约定）；
 * 反过来 base 只 import 它**真正调用**的那几个函数。
 *
 * @module dsh-tiddlywiki/host/session-summary-scan
 */
import type { Collected, NoteEntry, SessionLineageNode, SessionLogSnapshot } from './session-summary.ts'

/**
 * 会话内能触达 wiki 的 tiddlywiki_* 工具名（search/recent 只记检索记录，不算单篇）。
 *
 * 必须与「产生 / 读取 / 删除」的三条实际写读路径对齐：注入的系统提示词明确推荐
 * 「纯增量内容优先用 tiddlywiki_append」，`tiddlywiki_attach` 写附件条目、
 * `tiddlywiki_delete` / `tiddlywiki_trash` 动已有笔记——漏掉任何一个，那一类操作
 * 都会从汇总里整体消失（会话被误判成「没碰过任何笔记」）。
 */
/**
 * Bounds so one enormous session tree cannot make the「知识库」Tab unresponsive：扫描层要读
 * 每个列出的会话的**完整**事件日志，所以这两个上限是这一层的（v0.30.18 从 base 搬来）。
 */
export const MAX_SESSIONS = 40
export const MAX_SEARCH_RECORDS = 200

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


/** 递归收集后代树里所有 session id（不含根自身，超过上限即停）。 */
export function collectDescendantIds(nodes: SessionLineageNode[] | undefined, out: string[]): void {
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
export function isPlausibleTitle(title: string): boolean {
  if (title.length === 0 || title.length > 300) return false
  if (title.trim().length === 0) return false
  if (/[\u0000-\u001f\u007f]/.test(title)) return false // 控制字符 / 换行
  if (/[\]|`#]/.test(title)) return false // 会破坏 [[…]] 链接语法
  if (title.startsWith('…') || title === '标题') return false // 占位 / 示例写法
  return true
}

/** 记录一篇笔记的触达；同标题合并（时间取最新、detail 取最新、subagent 取 AND）。 */
export function record(map: Map<string, NoteEntry>, entry: NoteEntry): void {
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
export function trimTrailingClosers(raw: string): string {
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
export function scanRefs(text: string, time: number, subagent: boolean, collected: Collected): void {
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
export function scanSnapshot(snap: SessionLogSnapshot | undefined, subagent: boolean, collected: Collected): void {
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

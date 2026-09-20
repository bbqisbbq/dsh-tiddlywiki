/**
 * The `tiddlywiki_*` agent tools (design doc §11, D8) plus the extension
 * point: `registerTiddlywikiTools(ctx, deps)` registers tools list-style, so a
 * new tool is just one more `defineTool` in the array — index.ts never changes.
 *
 * Toolset (v0.19):
 *   search / get / put / batch_put / append / rename / delete / trash /
 *   backlinks / attach / lint / recent / list_tags / git_sync / git_resolve
 *
 * RENDER CONTRACT (design doc §4.3): the registry feeds `output.render(args,
 * value)` into the loop — the model sees ONLY the rendered text, never the raw
 * JSON `value`. Every render must carry the complete facts an agent needs to
 * act (titles, tags, snippets, git state); a terse UI summary starves it.
 *
 * @module dsh-tiddlywiki/host/tools
 */
import { defineTool } from '../sdk.ts'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { MISSING_TYPE_FILTER, isBinaryType, parseTiddlerDate, toIsoDateString } from './tw-api.ts'
import type { TiddlyWebClient, Tiddler } from './tw-api.ts'
import { GitConflictStateError, type GitFace, type GitStatusView } from './git.ts'
import { downloadClipImage } from './clip-bridge.ts'
import { flushPendingWrites } from './seeds.ts'
import { snippetOf } from './text-util.ts'
import {
  assertNoConflict,
  buildWriteTiddler,
  flattenTiddlerFields,
  normalizeTagArg,
} from './write-policy.ts'
import { WORKSPACE_FIELD, WORKSPACE_TAG_PREFIX, workspaceMarkFromCwd } from './workspace.ts'

export { AGENT_WRITTEN_TAG, DEFAULT_NOTE_TYPE, HUMAN_EDITED_TAG } from './write-policy.ts'

import type { PromptToolSummary } from './prompt.ts'

/**
 * Summaries of the tools registered by the LAST `registerTiddlywikiTools()`
 * pass — the single source for the `full` prompt catalogue and for
 * `scripts/verify-prompt.mjs` (v0.21.0).
 *
 * History: the prompt carried a HAND-WRITTEN parameter catalogue that was last
 * updated in v0.19.0 and silently drifted 6 signatures behind the tools by
 * v0.20.1. Collecting them here from the same definitions that reach the model
 * makes that class of drift impossible.
 */
const REGISTERED_TOOL_SUMMARY: PromptToolSummary[] = []

/** Tool summaries of the last registration pass (empty before one has run). */
export function tiddlywikiToolSummary(): readonly PromptToolSummary[] {
  return REGISTERED_TOOL_SUMMARY
}

/** Structural shape the collector needs from a registry-ready tool. */
interface RegistrableTool {
  readonly name: string
  readonly parameters: Record<string, unknown>
}


/** Structural tool-registry face (subset of the dsh tools service). */
export interface ToolsCtx {
  tools: { register(tool: unknown): () => void }
}

export interface ToolsDeps {
  /** Lazy TW client — undefined while the service is not up. */
  wiki: () => TiddlyWebClient | undefined
  git: GitFace
  wikiPath: () => string
  /** Debounced auto-commit touch (fires after our writes). */
  autoCommit: () => void
  /** Restart the TW child (same port). Called after a pull that changed the
   *  working tree, so the server drops its stale in-memory snapshot and the
   *  agent sees the pulled content. Optional — absent in headless contexts. */
  restartWiki?: () => Promise<void>
  /**
   * Workspace (project) name for a session, resolved from its cwd (v0.24.0).
   * Absent in headless contexts → no automatic workspace marking.
   */
  workspaceName?: (sessionId: string) => string | undefined
  /** Whether automatic workspace marking is on (config `note.workspaceMark`). */
  workspaceMarkEnabled?: () => boolean
}

/**
 * Session id of the caller, when the runtime supplies one.
 *
 * `ToolRunContext.agent.id` is the calling session (verified against the host
 * SDK's `ToolExecutionInput.agent`), which is what lets the plugin resolve
 * "which project is this note from?" all by itself (v0.24.0).
 */
function sessionIdOf(exec: unknown): string | undefined {
  const agent = (exec as { agent?: { id?: unknown } } | null | undefined)?.agent
  const id = agent?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * The workspace marker to add to a NEW note created by this call, or undefined
 * (no session, no cwd, unusable name, or the feature is off).
 *
 * Applied on CREATE only — an overwrite keeps whatever the note already has, and
 * never grows a workspace tag it was not created with.
 */
function workspaceMarkFor(deps: ToolsDeps, exec: unknown): { id: string; tag: string } | undefined {
  if (deps.workspaceName === undefined) return undefined
  if (deps.workspaceMarkEnabled?.() === false) return undefined
  const sessionId = sessionIdOf(exec)
  if (sessionId === undefined) return undefined
  return workspaceMarkFromCwd(deps.workspaceName(sessionId))
}

/**
 * Merge the workspace marker into a NEW note's explicit tags and fields.
 *
 * ADDITIVE, never replacing: the caller's tags are kept in front and the caller's
 * own `workspace` field (if it set one) wins, so an explicit value is never
 * silently overwritten. Returns the inputs untouched when there is no marker.
 */
function withWorkspaceMark(
  mark: { id: string; tag: string } | undefined,
  tags: string[] | undefined,
  fields: Record<string, unknown> | undefined,
): { tags: string[] | undefined; fields: Record<string, unknown> | undefined; workspace?: string } {
  if (mark === undefined) return { tags, fields }
  const nextTags = tags === undefined || tags.length === 0
    ? [mark.tag]
    : (tags.includes(mark.tag) ? tags : [...tags, mark.tag])
  const nextFields: Record<string, unknown> = { ...(fields ?? {}) }
  const explicit = nextFields[WORKSPACE_FIELD]
  if (typeof explicit !== 'string' || explicit.trim().length === 0) nextFields[WORKSPACE_FIELD] = mark.id
  return { tags: nextTags, fields: nextFields, workspace: mark.id }
}

/**
 * Snippet centred on the FIRST match of `query` (v0.19.0). The old snippet was
 * always the first 160 characters of the note, so a hit deep inside a long note
 * showed the model text that did not contain the term it searched for.
 *
 * v0.24.0: search is multi-term AND, so the whole query may never appear
 * literally. Fall back to the earliest individual term before giving up, or a
 * perfectly good hit would still render the head of the note.
 */
function snippetAround(text: string, query: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const lower = flat.toLowerCase()
  const candidates = [query.trim().toLowerCase(), ...query.split(/\s+/).map((s) => s.trim().toLowerCase())]
    .filter((needle) => needle.length > 0)
  let at = -1
  let needleLength = 0
  for (const needle of candidates) {
    const found = lower.indexOf(needle)
    if (found < 0) continue
    if (at < 0 || found < at) { at = found; needleLength = needle.length }
  }
  if (at < 0) return `${flat.slice(0, max)}…`
  const half = Math.max(0, Math.floor((max - needleLength) / 2))
  const start = Math.max(0, at - half)
  const end = Math.min(flat.length, start + max)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < flat.length ? '…' : ''
  return `${prefix}${flat.slice(start, end)}${suffix}`
}

/** Trash namespace for soft-deleted tiddlers (system titles: never listed by
 *  the default recipe filter, so deleted notes stop appearing in search/recent
 *  while staying recoverable). */
export const TRASH_PREFIX = '$:/dsh-tiddlywiki/trash/'

/**
 * Trash INDEX tiddler. A `$:/`-titled tiddler cannot be ENUMERATED through the
 * recipe listing at all: a fresh wiki has `$:/config/SyncSystemTiddlersFromServer
 * = "no"`, and `get-tiddlers-json.js` then appends `+[!is[system]]` to every
 * filter (verified). The trash therefore keeps its own index and reads it with a
 * plain GET (which works for system titles). (v0.19.0)
 */
export const TRASH_INDEX_TITLE = '$:/dsh-tiddlywiki/trash-index'

interface TrashIndexEntry { trash: string; of: string; at: string }

/** Build the trash title that holds one soft-deleted tiddler. */
function trashTitleFor(title: string, at = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-')
  return `${TRASH_PREFIX}${stamp}/${title}`
}

/**
 * Read the trash index.
 *
 * `readOk:false` distinguishes「索引读不到」(a failure: 5xx/timeout/auth — the
 * tool layer MUST stop, because overwriting the index with whatever we managed
 * to read would drop every earlier entry and orphan those trashed tiddlers) from
 *「索引不存在」(404 = a brand-new wiki with an empty trash) and「JSON 坏了」
 * (rebuildable: the trash tiddlers themselves are still there, only the index
 * entries are lost).
 *
 * Swallowing the error into `[]` was the v0.19.4 defect: one transient failure
 * during `tiddlywiki_delete` rewrote the whole index to a single-entry array.
 */
async function readTrashIndex(wiki: TiddlyWebClient): Promise<{ readOk: boolean; corrupted: boolean; entries: TrashIndexEntry[] }> {
  let tiddler: Tiddler | undefined
  try {
    // Only 404 yields undefined (tw-api): any other throw is a real read failure.
    tiddler = await wiki.get(TRASH_INDEX_TITLE)
  } catch {
    return { readOk: false, corrupted: false, entries: [] }
  }
  if (tiddler === undefined || typeof tiddler.text !== 'string' || tiddler.text.trim().length === 0) {
    return { readOk: true, corrupted: false, entries: [] }
  }
  try {
    const parsed = JSON.parse(tiddler.text) as unknown
    if (!Array.isArray(parsed)) return { readOk: true, corrupted: true, entries: [] }
    const entries = parsed.filter((entry): entry is TrashIndexEntry => {
      if (typeof entry !== 'object' || entry === null) return false
      const e = entry as Record<string, unknown>
      return typeof e.trash === 'string' && typeof e.of === 'string'
    }).map((e) => ({ trash: e.trash, of: e.of, at: typeof e.at === 'string' ? e.at : '' }))
    return { readOk: true, corrupted: false, entries }
  } catch {
    return { readOk: true, corrupted: true, entries: [] }
  }
}

/** Persist the trash index. */
async function writeTrashIndex(wiki: TiddlyWebClient, entries: TrashIndexEntry[]): Promise<void> {
  await wiki.put({ title: TRASH_INDEX_TITLE, text: JSON.stringify(entries, null, 2), type: 'application/json', tags: [] })
}

/** Raised when the trash index cannot be read: the operation must abort rather
 *  than rebuild the index from an empty base (data-loss guard, v0.19.5). */
export class TrashIndexUnavailableError extends Error {
  constructor() {
    super('回收站索引暂时读不到（TiddlyWiki 可能正在重启或超时）；为避免覆盖索引、丢回收站记录，本次操作已中止，请稍后重试。')
    this.name = 'TrashIndexUnavailableError'
  }
}

/** Mime types offered by `tiddlywiki_attach` for local files. */
const ATTACH_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
  ico: 'image/x-icon', pdf: 'application/pdf', zip: 'application/zip',
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4',
  epub: 'application/epub+zip',
}

/** Size cap for one attachment (mirrors the clip bridge's image cap). */
export const MAX_ATTACH_BYTES = 15 * 1024 * 1024

/**
 * Count references to `target` inside wiki text: `[[target]]`,
 * `[[display|target]]`, `[[target|display]]` is NOT a reference to target as a
 * link target in TW (the first part is the text, the second the target), so
 * only the second position counts, plus `{{target}}` transclusions.
 */
function countRefsTo(text: string, target: string): number {
  if (target.length === 0) return 0
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(`\\[\\[${escaped}\\]\\]`, 'g'),
    new RegExp(`\\[\\[[^\\]|]*\\|${escaped}\\]\\]`, 'g'),
    new RegExp(`\\{\\{${escaped}\\}\\}`, 'g'),
  ]
  let count = 0
  for (const re of patterns) count += (text.match(re) ?? []).length
  return count
}

/**
 * Junk tags produced by tooling mistakes rather than by a human. The live wiki
 * still carries `筛选器错误: Missing [ in filter expression` from the v0.16.22
 * filter bug — a lint must be able to find that class of damage again.
 *
 * EXPORTED (v0.24.0) so `scripts/verify-workspace.mjs` can assert the automatic
 * `ws/<id>` tags are never junk: the two character sets (here and in
 * `normalizeWorkspaceName`) must stay in agreement, and this is the only place
 * that can catch a future edit to just one of them.
 */
export function isJunkTag(tag: string): boolean {
  if (tag.length === 0) return false
  if (/筛选器错误|Missing \[|in filter expression/i.test(tag)) return true
  if (/[[\]{}|<>]/.test(tag)) return true
  if (/^(in|filter|expression|Missing|tags:)$/i.test(tag)) return true
  if (/^[A-Za-z]:\\/.test(tag)) return true
  if (tag.trim() !== tag) return true
  return false
}

/**
 * The checks `tiddlywiki_lint` can actually run, in report order (v0.25.0).
 *
 * The parameter used to be free-form: any unrecognised name was silently
 * dropped by `new Set(checks)`, so `checks: ["broken-link"]` (a typo) ran
 * NOTHING and the receipt still said「发现 0 个问题 / 没有发现问题」. Keeping the
 * list in one place lets the tool report both what RAN and what was ignored.
 */
const LINT_CHECKS = ['junk-tags', 'broken-links', 'empty-notes', 'missing-type', 'stale'] as const

/**
 * Expiry instant for the time-boxed fields `valid-until` / `review-after`.
 *
 * A bare `YYYY-MM-DD` means「当天整天有效」to a human, but `parseTiddlerDate`
 * resolves it to UTC midnight — in UTC+8 that flags the note expired at 08:00 of
 * that same day. Local end-of-day matches the documented wording; anything else
 * (ISO timestamps, TW compact dates) keeps the shared parser's behaviour.
 */
function expiryOf(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (dateOnly !== null) {
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 23, 59, 59, 999).getTime()
  }
  return parseTiddlerDate(value)
}

/**
 * tiddler 的非内容字段（自定义字段 + 内容类型 + 时间戳 + revision），供模型读。
 *
 * v0.19.1 修复：单条 GET 把自定义字段**嵌在 `fields` 里**，旧实现只把顶层条目
 * 抄一遍，于是渲染出来的 `字段:` 行是 `fields=[object Object]` —— `q`/`due`/
 * `clip-url`/`workspace` 这些笔记元数据对模型完全不可见（实测）。现在统一走
 * `flattenTiddlerFields()` 摊平，并显式带上 `revision`（乐观并发令牌）。
 */
function pickFields(t: Tiddler): Record<string, unknown> {
  const out = flattenTiddlerFields(t)
  if (t.revision !== undefined) out.revision = t.revision
  return out
}

/**
 * 覆盖写入前后内容类型的差异（v0.20.1）。内容类型决定 TW 用哪个 parser，静默变化
 * 会让 CSS 被当 Markdown、Markdown 笔记被当 wikitext，所以覆盖路径必须把这个差异
 * 回执给模型。只有两边都拿得到 `type` 且不同才报告（新建 → 无 from）。
 */
function typeChangeOf(existing: Tiddler | undefined, next: Tiddler): { typeChanged?: { from: string; to: string } } {
  if (existing === undefined) return {}
  const from = typeof existing.type === 'string' && existing.type.length > 0 ? existing.type : undefined
  const to = typeof next.type === 'string' && next.type.length > 0 ? next.type : undefined
  if (from === undefined || to === undefined || from === to) return {}
  return { typeChanged: { from, to } }
}

/**
 * Rewrite TiddlyWiki references to a title inside wiki text: `[[Title]]`,
 * `[[display|Title]]`, `{{Title}}` → the new title. Best-effort link/text
 * migration for tiddlywiki_rename; returns the rewritten text + hit count.
 */
function rewriteRefs(text: string, oldTitle: string, newTitle: string): { text: string; count: number } {
  if (oldTitle.length === 0) return { text, count: 0 }
  const escaped = oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(\\[\\[[^\\]|]*\\|)${escaped}(\\]\\])|(\\[\\[)${escaped}(\\]\\])|(\\{\\{)${escaped}(\\}\\})`, 'g')
  let count = 0
  const out = text.replace(re, (...args: Array<string | number>) => {
    const p = args as string[]
    count++
    const prefix = p[1] ?? p[3] ?? p[5] ?? ''
    const suffix = p[2] ?? p[4] ?? p[6] ?? ''
    return `${prefix}${newTitle}${suffix}`
  })
  return { text: out, count }
}

/**
 * Insert `addition` at the end of the section introduced by `heading` (Markdown
 * `#`/`##`… or wikitext `!`/`!!`…). Falls back to appending at the end of the
 * document when the heading is not found. Used by tiddlywiki_append so an agent
 * can add to one section of a long note without rewriting the whole file.
 */
function insertIntoSection(base: string, heading: string, addition: string): string {
  const lines = base.split('\n')
  const headingText = (line: string): string | null => {
    const md = /^#{1,6}\s+(.*)$/.exec(line)
    if (md !== null) return (md[1] ?? '').trim()
    const tw = /^!{1,6}\s*(.*)$/.exec(line)
    if (tw !== null) return (tw[1] ?? '').trim()
    return null
  }
  const start = lines.findIndex((line) => headingText(line) === heading)
  if (start < 0) {
    return base.trim().length === 0 ? addition : `${base.replace(/\s+$/, '')}\n\n${addition}`
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (headingText(lines[i] ?? '') !== null) {
      end = i
      break
    }
  }
  const before = lines.slice(0, end).join('\n').replace(/\s+$/, '')
  const after = lines.slice(end).join('\n')
  const head = `${before}\n\n${addition}`
  return after.trim().length === 0 ? head : `${head}\n\n${after.replace(/^\s+/, '')}`
}


export function registerTiddlywikiTools(ctx: ToolsCtx, deps: ToolsDeps): Array<() => void> {
  const disposers: Array<() => void> = []
  // Re-collect on every pass: a hot reload re-registers the whole toolset, and
  // a stale entry must never linger in the prompt catalogue.
  REGISTERED_TOOL_SUMMARY.length = 0
  const register = (tool: RegistrableTool): void => {
    const properties = (tool.parameters.properties ?? {}) as Record<string, unknown>
    const required = Array.isArray(tool.parameters.required) ? (tool.parameters.required as string[]) : []
    REGISTERED_TOOL_SUMMARY.push({
      name: tool.name,
      params: Object.keys(properties).map((name) => ({ name, required: required.includes(name) })),
    })
    disposers.push(ctx.tools.register(tool))
  }

  /** Every read/write tool needs a live TW client — shared guard for the 8
   *  wiki-facing tools (git tools operate on the repo path instead). */
  const requireWiki = (): TiddlyWebClient => {
    const wiki = deps.wiki()
    if (wiki === undefined) throw new Error('TiddlyWiki 服务未运行（tiddlywiki_status 可查）')
    return wiki
  }

  // ── tiddlywiki_search ────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_search',
    description: '检索 TiddlyWiki 持久知识库：按关键词（可选 tags 数组 / since 修改时间 / type / field+value / limit）搜索非系统 tiddler，按相关度排序返回标题、标签、修改时间与命中处上下文片段。二进制 tiddler（图片等附件，正文为 base64）不参与检索。查询按空白切词、**所有词都必须命中**（AND）。若当前会话属于某个工作区，会**先在该工作区内检索、命中为空才自动扩大到全库**，回执会写明用了哪个范围（传了 tags / tag / field / value 时视为调用方已给出明确范围，不再自动收窄）。',
    parameters: {
      query: { type: 'string', description: '搜索关键词（大小写不敏感，子串匹配；命中标题/标签/正文，标题命中权重最高）。多词按空白切分，**全部词都要命中**才算（AND）——例如「部署 步骤」只返回同时含这两词的笔记' },
      tags: { type: 'array', items: { type: 'string' }, description: '可选：要求同时包含的标签（AND）' },
      tag: { type: 'string', description: '可选：单个精确标签（与 tags 同为 AND）' },
      since: { type: 'string', description: '可选：ISO 时间（如 2026-09-01 或 2026-09-01T00:00:00Z），只返回修改时间不早于它的 tiddler' },
      type: { type: 'string', description: '可选：精确 tiddler 类型。⚠️ 不传则不限类型（推荐）；插件默认把笔记写成 text/markdown，传 "text/vnd.tiddlywiki" 会把 Markdown 笔记全部排除' },
      field: { type: 'string', description: '可选：按自定义字段过滤（如 "q"、"clip-url"、"workspace"）' },
      value: { type: 'string', description: '可选：field 必须等于该值（不传则只要求该字段存在）' },
      limit: { type: 'integer', description: '可选：返回条数上限（默认 30，最大 200）' },
    },
    output: {
      render: (_args, value: SearchResult) => {
        const filters: string[] = []
        if (value.tags.length > 0) filters.push(`tags=${value.tags.join(',')}`)
        if (value.since !== null) filters.push(`since=${value.since}`)
        if (value.type !== null) filters.push(`type=${value.type}`)
        if (value.field !== null) filters.push(`field=${value.field}${value.value !== null ? `=${value.value}` : ''}`)
        // Say WHICH scope produced these hits (v0.24.0). Without this a narrowed
        // search that fell back reads exactly like an unnarrowed one, and a
        // workspace-only empty result reads as "the library has nothing".
        let scope = ''
        if (value.workspace !== null && value.scope === 'workspace') {
          scope = ` · 已在工作区 ${WORKSPACE_TAG_PREFIX}${value.workspace} 内缩小范围`
        } else if (value.workspace !== null && value.fellBack) {
          scope = ` · 工作区 ${WORKSPACE_TAG_PREFIX}${value.workspace} 内 0 条，已扩大到全库`
        }
        const head = `TiddlyWiki 搜索「${value.query}」${filters.length > 0 ? ` (${filters.join(' · ')})` : ''}：命中 ${value.total} 条${scope}（按相关度排序）。`
        const lines = [head]
        if (value.results.length === 0) lines.push('没有匹配的 tiddler。')
        for (const r of value.results) {
          const tags = r.tags.length > 0 ? ` [${r.tags.join(', ')}]` : ''
          const modified = r.modified !== null ? ` (${r.modified})` : ''
          lines.push(`- ${r.title}${tags}${modified}`)
          if (r.snippet.length > 0) lines.push(`  ${r.snippet}`)
        }
        if (value.total > value.results.length) lines.push(`（另有 ${value.total - value.results.length} 条未展开，可用 tiddlywiki_get 读取具体标题，或提高 limit）`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { query: string; tags?: string[]; tag?: string; since?: string; type?: string; field?: string; value?: string; limit?: number }, exec: unknown): Promise<SearchResult> => {
      const wiki = requireWiki()
      const options = {
        tags: args.tags,
        tag: args.tag,
        since: args.since,
        type: args.type,
        field: args.field,
        value: args.value,
        limit: args.limit,
      }
      // Automatic workspace narrowing (v0.24.0, user request): look inside the
      // session's own project first, widen only when that finds nothing.
      // Skipped when the caller passed its own tag/field filter — those are an
      // explicit scope and must not be second-guessed.
      const explicitScope = (args.tags?.length ?? 0) > 0 || args.tag !== undefined
        || args.field !== undefined || args.value !== undefined
      const mark = explicitScope ? undefined : workspaceMarkFor(deps, exec)
      let narrowed: { items: Tiddler[]; total: number } | undefined
      if (mark !== undefined) {
        narrowed = await wiki.search(args.query, { ...options, tags: [mark.tag] })
      }
      const usedWorkspace = narrowed !== undefined && narrowed.total > 0
      const { items, total } = usedWorkspace ? narrowed as { items: Tiddler[]; total: number } : await wiki.search(args.query, options)
      return {
        query: args.query,
        tags: args.tags ?? [],
        since: args.since ?? null,
        type: args.type ?? null,
        field: args.field ?? null,
        value: args.value ?? null,
        total,
        workspace: mark?.id ?? null,
        scope: usedWorkspace ? 'workspace' : 'all',
        fellBack: mark !== undefined && !usedWorkspace,
        results: items.map((t) => ({ title: t.title, tags: t.tags ?? [], modified: toIsoDateString(t.modified), snippet: snippetAround(t.text ?? '', args.query) })),
      }
    },
  }))

  // ── tiddlywiki_recent ────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_recent',
    description: '查看 TiddlyWiki 知识库最近修改的笔记（按修改时间倒序，排除系统 tiddler 与图片等二进制附件），返回标题、标签、修改时间与摘要。适合开工时快速了解近期动态。',
    parameters: {
      limit: { type: 'integer', description: '可选：返回条数（默认 15，最大 200）' },
      since: { type: 'string', description: '可选：只返回修改时间不早于该 ISO 时间的 tiddler' },
    },
    output: {
      render: (_args, value: RecentResult) => {
        const lines = [`TiddlyWiki 最近修改（最近 ${value.results.length} 条${value.since !== null ? `，since=${value.since}` : ''}）：`]
        if (value.results.length === 0) lines.push('暂无笔记。')
        for (const r of value.results) {
          const tags = r.tags.length > 0 ? ` [${r.tags.join(', ')}]` : ''
          lines.push(`- ${r.title}${tags} (${r.modified ?? '?'})`)
          if (r.snippet.length > 0) lines.push(`  ${r.snippet}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { limit?: number; since?: string }): Promise<RecentResult> => {
      const wiki = requireWiki()
      const items = await wiki.recent(args.limit ?? 15, args.since)
      return {
        since: args.since ?? null,
        results: items.map((t) => ({ title: t.title, tags: t.tags ?? [], modified: toIsoDateString(t.modified), snippet: snippetOf(t.text ?? '') })),
      }
    },
  }))

  // ── tiddlywiki_list_tags ─────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_list_tags',
    description: '列出 TiddlyWiki 知识库现有的非系统标签及各自计数（按使用次数降序），方便决定给笔记打什么 tag。默认最多返回 200 个（`limit` 可调，上限 1000），被截断时结果里会带 total/truncated。',
    parameters: {
      limit: { type: 'integer', description: '可选：最多返回多少个标签（按使用次数降序），默认 200，上限 1000。' },
    },
    output: {
      render: (_args, value: TagListResult) => {
        if (value.tags.length === 0) return [{ type: 'text', text: '知识库暂无标签。' }]
        const lines = [
          value.truncated
            ? `现有标签（共 ${value.total} 个，仅列出使用最多的 ${value.tags.length} 个，按使用次数降序）：`
            : `现有标签（${value.total} 个，按使用次数降序）：`,
        ]
        for (const t of value.tags) lines.push(`- ${t.tag} × ${t.count}`)
        if (value.truncated) lines.push(`（其余 ${value.total - value.tags.length} 个较少使用的标签未列出；需要时可提高 limit 重试）`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { limit?: number }): Promise<TagListResult> => {
      const wiki = requireWiki()
      const stats = await wiki.tagStats()
      const limit = typeof args.limit === 'number' && Number.isFinite(args.limit)
        ? Math.max(1, Math.min(Math.floor(args.limit), 1000))
        : 200
      const tags = stats.tags.slice(0, limit)
      return { count: tags.length, total: stats.total, truncated: tags.length < stats.total, tags }
    },
  }))

  // ── tiddlywiki_get ───────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_get',
    description: '读取一个 TiddlyWiki tiddler 的完整内容（标题、全文、标签、自定义字段）。二进制 tiddler（图片等附件）只返回元数据，不返回 base64 正文。',
    parameters: {
      title: { type: 'string', description: 'tiddler 标题（精确匹配）', required: true },
    },
    output: {
      render: (_args, value: GetResult) => {
        if (value.notFound) return [{ type: 'text', text: `tiddler「${value.title}」不存在。可用 tiddlywiki_search 检索，或用 tiddlywiki_put 新建。` }]
        if (value.binary === true) {
          const lines = [`tiddler「${value.title}」是二进制附件（type=${value.binaryType ?? '?'}，base64 正文约 ${value.binaryChars ?? 0} 字符），不返回正文。`]
          if (value.tags.length > 0) lines.push(`标签: ${value.tags.join(', ')}`)
          if (value.modified !== null) lines.push(`修改: ${value.modified}`)
          const fields = Object.entries(value.fields)
          if (fields.length > 0) lines.push(`字段: ${fields.map(([k, v]) => `${k}=${String(v)}`).join(', ')}`)
          lines.push(`如需查看附件本身，可打开 [${value.title}](/dsh-tiddlywiki/tw/#${encodeURIComponent(value.title)})。`)
          return [{ type: 'text', text: lines.join('\n') }]
        }
        const lines = [`tiddler「${value.title}」`]
        if (value.tags.length > 0) lines.push(`标签: ${value.tags.join(', ')}`)
        if (value.modified !== null) lines.push(`修改: ${value.modified}`)
        const fields = Object.entries(value.fields)
        if (fields.length > 0) lines.push(`字段: ${fields.map(([k, v]) => `${k}=${String(v)}`).join(', ')}`)
        lines.push('--- 全文 ---')
        lines.push(value.text.length > 0 ? value.text : '（空）')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { title: string }): Promise<GetResult> => {
      const wiki = requireWiki()
      const t = await wiki.get(args.title)
      if (t === undefined) return { notFound: true, title: args.title, text: '', tags: [], fields: {}, modified: null }
      const binary = isBinaryType(typeof t.type === 'string' ? t.type : undefined)
      const result: GetResult = {
        notFound: false,
        title: t.title,
        text: binary ? '' : (t.text ?? ''),
        tags: t.tags ?? [],
        fields: pickFields(t),
        modified: toIsoDateString(t.modified),
      }
      if (binary) {
        result.binary = true
        result.binaryType = typeof t.type === 'string' ? t.type : undefined
        result.binaryChars = (t.text ?? '').length
      }
      return result
    },
  }))

  // ── tiddlywiki_put ───────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_put',
    description: '写入（新建或覆盖）一个 TiddlyWiki tiddler。同名覆盖；**覆盖已有条目时，未传的 tags / 自定义字段 / 内容类型都会原样保留**（不会静默丢掉笔记原有的标签、字段或 type；显式传 tags 才整体替换标签，**传空数组 [] 表示清空全部标签**）。写入后触发防抖自动 commit（默认 60s；手动同步用 tiddlywiki_git_sync）。新建（title 不存在）时自动补打 agent-written 标签标记「由 Agent 撰写」，无需手动添加；同时按当前会话工作目录自动打 `ws/<项目名>` 工作区标签与 `workspace` 字段（可用配置 `note.workspaceMark` 关闭；要归到别的项目就显式传 fields.workspace）。内容类型：**只有新建**条目且未指定时才默认 text/markdown（$:/ 系统条目除外）——覆盖 text/css、wikitext 等既有条目时保持原类型；要改类型用 fields 传 {"type":"..."}。⚠️ fields.type 是 TW 的内容类型保留字段，不要把业务分类值（如 "meeting"）写进去——业务分类请放 tags。',
    parameters: {
      title: { type: 'string', description: 'tiddler 标题（精确匹配，覆盖同名）', required: true },
      text: { type: 'string', description: 'tiddler 全文（默认按 Markdown 解析）', required: true },
      tags: { type: 'array', items: { type: 'string' }, description: '标签数组（可选）。不传 = 保留既有条目的原标签；传空数组 [] = 清空全部标签；有内容 = 整体替换' },
      fields: { type: 'json', description: '附加自定义字段，如 {"date":"2026-09-02"}（可选）。fields.type 是**改内容类型的正规入口**（如 {"type":"text/css"}）：新建条目未指定时默认 text/markdown，覆盖既有条目时保留原类型。注意不要把业务分类值（如 "meeting"）写进 type——业务分类请放 tags' },
      expectedModified: { type: 'string', description: '可选：乐观并发保护。传 tiddlywiki_get 读到的 modified 值，若该条目已被他人改动则拒绝写入（避免覆盖人类在 TW 编辑器里的修改）' },
      expectedRevision: { type: 'integer', description: '可选：乐观并发保护的另一种令牌——传 tiddlywiki_get 返回字段里的 revision（刚写入、还没落盘的条目没有 modified，此时用 revision）' },
      force: { type: 'boolean', description: '可选：true 时忽略 expectedModified/expectedRevision 强制覆盖（默认 false）' },
    },
    output: {
      render: (_args, value: PutResult) => {
        const lines = [`已写入 tiddler「${value.title}」`]
        if (value.workspace !== undefined) lines.push(`已自动标记工作区: ${WORKSPACE_TAG_PREFIX}${value.workspace}（字段 ${WORKSPACE_FIELD}）`)
        if (value.tags.length > 0) lines.push(`标签: ${value.tags.join(', ')}`)
        if (value.type !== null) lines.push(`类型: ${value.type}${value.typeDefaulted === true ? '（新建且未指定，已默认 markdown）' : ''}`)
        // 覆盖时若类型真的变了，必须说出来（v0.20.1）——内容类型决定解析方式，
        // 静默变化会让 CSS/JS 被当 Markdown、Markdown 笔记被当 wikitext。
        if (value.typeChanged !== undefined) lines.push(`⚠️ 内容类型已从 ${value.typeChanged.from} 改为 ${value.typeChanged.to}（覆盖前请确认这是你要的）`)
        if (value.fields !== null) {
          const entries = Object.entries(value.fields)
          if (entries.length > 0) lines.push(`字段: ${entries.map(([k, v]) => `${k}=${String(v)}`).join(', ')}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { title: string; text: string; tags?: string[]; fields?: Record<string, unknown>; expectedModified?: string; expectedRevision?: number; force?: boolean }, exec: unknown): Promise<PutResult> => {
      const wiki = requireWiki()
      if (args.title.trim().length === 0) throw new Error('tiddlywiki_put: title 不能为空')
      // Read WITHOUT swallowing errors: only a 404 means "new tiddler". A
      // transient failure treated as "new" would silently tag an existing
      // human note as agent-written.
      const existing = await wiki.get(args.title)
      assertNoConflict(args.title, existing, {
        expectedModified: args.expectedModified,
        expectedRevision: args.expectedRevision,
        force: args.force,
      })
      const tags = normalizeTagArg(args.tags)
      // DATA SAFETY (v0.23.5): a binary tiddler (image/PDF/…) holds base64 in
      // `text`. Writing prose into it keeps `type: image/png` (the write policy
      // preserves the base type on purpose), so the result is an attachment whose
      // base64 no longer decodes — the image breaks and the receipt reports
      // "type unchanged". Refusing is the only honest answer: overwriting an
      // attachment is `tiddlywiki_attach`'s job. An explicit `fields.type` that
      // leaves the binary family (or force) is treated as a deliberate conversion.
      if (existing !== undefined && isBinaryType(typeof existing.type === 'string' ? existing.type : undefined)) {
        const wantedType = typeof args.fields?.type === 'string' ? args.fields.type : undefined
        const deliberate = args.force === true || (wantedType !== undefined && !isBinaryType(wantedType))
        if (!deliberate) {
          throw new Error(
            `tiddlywiki_put: 「${args.title}」是二进制附件（type=${String(existing.type)}，正文为 base64），`
            + '直接写文本会把附件写坏。要替换附件请用 tiddlywiki_attach；'
            + '确实要转成文本条目，请显式传 fields: {"type":"text/markdown"}（或 force: true）。',
          )
        }
      }
      const marked = existing === undefined && !args.title.startsWith('$:/')
        ? withWorkspaceMark(workspaceMarkFor(deps, exec), tags, args.fields)
        : { tags, fields: args.fields }
      const { tiddler, typeDefaulted } = buildWriteTiddler(args.title, args.text, { existing, tags: marked.tags, fields: marked.fields })
      await wiki.put(tiddler)
      deps.autoCommit()
      return {
        ok: true,
        title: args.title,
        tags: tiddler.tags ?? [],
        type: typeof tiddler.type === 'string' ? tiddler.type : null,
        ...(typeDefaulted ? { typeDefaulted: true } : {}),
        ...typeChangeOf(existing, tiddler),
        fields: marked.fields ?? null,
        ...(marked.workspace !== undefined ? { workspace: marked.workspace } : {}),
      }
    },
  }))

  // ── tiddlywiki_batch_put ─────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_batch_put',
    description: '批量写入/覆盖多个 TiddlyWiki tiddler（一次工具调用）。overwrite=false 时跳过已存在的标题；返回逐条结果（单条失败不影响其余条目，失败原因逐条列出）。写入后触发防抖自动 commit（默认 60s）。新建（title 不存在）的条目会自动补打 agent-written 标签与 `ws/<项目名>` 工作区标记，无需手动添加。内容类型：只有**新建**条目未指定 fields.type 时才默认 text/markdown（$:/ 系统条目除外）；**覆盖既有条目时保留其原有 type/tags/自定义字段**。每条目可带 `expectedModified`（来自 tiddlywiki_get）做乐观并发保护：该条在你读取后被改过就只让这一条失败，其余照常写入。条目内传 `tags: []` 表示清空该条目的标签。',
    parameters: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          description: '要写入的 tiddler 数组',
          properties: {
            // NOTHING is `required` here on purpose (v0.19.0): argument
            // pre-validation runs BEFORE the per-item try/catch, so a declared
            // requirement made one malformed item abort the WHOLE batch and the
            // documented "one failure does not lose the others" contract was
            // unreachable. The implementation validates per item instead.
            title: { type: 'string', description: '标题（精确匹配，覆盖同名）' },
            text: { type: 'string', description: '全文（默认按 Markdown 解析）' },
            tags: { type: 'array', items: { type: 'string' }, description: '标签数组（可选）。不传 = 保留原标签；传空数组 [] = 清空全部标签' },
            fields: { type: 'json', description: '附加自定义字段（可选）。注意：fields.type 是 TW 内容类型（保留字段，默认已自动补 text/markdown），不要写业务分类值' },
            expectedModified: { type: 'string', description: '可选（v0.25.0）：该条目的乐观并发令牌，来自 tiddlywiki_get 的 modified。覆盖已存在条目时若已被改动，只让这一条失败并说明原因，其余条目照常' },
          },
        },
      },
      overwrite: { type: 'boolean', description: '可选：true=覆盖同名（默认），false=跳过已存在的标题' },
    },
    output: {
      render: (_args, value: BatchResult) => {
        const lines = [`批量写入完成：成功 ${value.written}，跳过 ${value.skipped}，失败 ${value.failed}，共 ${value.items.length} 条。`]
        for (const r of value.items) {
          const ws = r.workspace !== undefined ? `（已标记工作区 ${WORKSPACE_TAG_PREFIX}${r.workspace}）` : ''
          lines.push(`- ${r.title}：${r.written ? `已写入${ws}` : r.skipped ? '已跳过（存在）' : `失败（${r.error ?? '未知错误'}）`}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { items: Array<{ title: string; text: string; tags?: string[]; fields?: Record<string, unknown>; expectedModified?: string }>; overwrite?: boolean }, exec: unknown): Promise<BatchResult> => {
      const wiki = requireWiki()
      const list = Array.isArray(args.items) ? args.items : []
      if (list.length === 0) return { ok: true, written: 0, skipped: 0, failed: 0, items: [] }
      const overwrite = args.overwrite !== false
      const results: BatchItemResult[] = new Array<BatchItemResult>(list.length)
      let written = 0
      let skipped = 0
      let failed = 0
      // One item failing (validation, network, a rejected title) must not lose
      // the report of the items that DID land — the model needs per-item truth.
      //
      // BOUNDED CONCURRENCY (v0.19.5): the previous sequential loop issued 2N
      // REST round-trips (a GET + a PUT per item) — a 200-item import spent
      // minutes in request latency. Four workers share the same client (its
      // listing caches are invalidated per write, which only costs a refetch),
      // and results are stored BY INDEX so the report keeps the caller's order
      // regardless of completion order.
      const writeOne = async (item: { title: string; text: string; tags?: string[]; fields?: Record<string, unknown>; expectedModified?: string }, index: number): Promise<void> => {
        const title = typeof item?.title === 'string' ? item.title : ''
        try {
          if (title.length === 0) throw new Error('缺少非空 title')
          if (typeof item.text !== 'string') throw new Error('缺少 text')
          // Read WITHOUT swallowing errors: only a 404 means "new tiddler".
          const existing = await wiki.get(title)
          if (!overwrite && existing !== undefined) {
            skipped++
            results[index] = { title, written: false, skipped: true, failed: false }
            return
          }
          // Per-item optimistic guard (v0.25.0): an overwrite built from a stale
          // read silently reverts whatever a human changed in between. A mismatch
          // fails THIS item only (the batch contract keeps the others) — which is
          // why the check lives inside the per-item try, not before the loop.
          assertNoConflict(title, existing, { expectedModified: item.expectedModified })
          const marked = existing === undefined && !title.startsWith('$:/')
            ? withWorkspaceMark(workspaceMarkFor(deps, exec), normalizeTagArg(item.tags), item.fields)
            : { tags: normalizeTagArg(item.tags), fields: item.fields }
          const { tiddler } = buildWriteTiddler(title, item.text, { existing, tags: marked.tags, fields: marked.fields })
          await wiki.put(tiddler)
          written++
          results[index] = { title, written: true, skipped: false, failed: false, ...(marked.workspace !== undefined ? { workspace: marked.workspace } : {}) }
        } catch (err) {
          failed++
          results[index] = { title: title.length > 0 ? title : '(无标题)', written: false, skipped: false, failed: true, error: err instanceof Error ? err.message : String(err) }
        }
      }
      const workers = Math.max(1, Math.min(4, list.length))
      let next = 0
      await Promise.all(Array.from({ length: workers }, async () => {
        for (;;) {
          const index = next++
          if (index >= list.length) return
          await writeOne(list[index] as { title: string; text: string }, index)
        }
      }))
      deps.autoCommit()
      return { ok: failed === 0, written, skipped, failed, items: results }
    },
  }))

  // ── tiddlywiki_rename ────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_rename',
    description: '重命名一个 TiddlyWiki tiddler：把旧标题的内容复制到新标题、删除旧标题，并可选地更新其他 tiddler 里的 [[旧标题]] / {{旧标题}} 引用（最佳努力）。引用更新会逐个整篇回写引用者，所以每个引用者在写入前都会重新读一次：**遍历期间被改动过的会被跳过而不是覆盖**，跳过数量在回执里报告。',
    parameters: {
      oldTitle: { type: 'string', description: '当前标题', required: true },
      newTitle: { type: 'string', description: '新标题', required: true },
      updateRefs: { type: 'boolean', description: '可选：是否同步更新其他 tiddler 里的引用（默认 true）' },
      expectedModified: { type: 'string', description: '可选（v0.25.0）：旧标题的乐观并发令牌，传 tiddlywiki_get 读到的 modified；不匹配则拒绝重命名（避免把人类刚改过的正文写进新标题）' },
      expectedRevision: { type: 'integer', description: '可选：乐观并发保护的另一种令牌——tiddlywiki_get 返回字段里的 revision' },
      force: { type: 'boolean', description: '可选：true 时忽略 expectedModified/expectedRevision 强制重命名（默认 false）' },
    },
    output: {
      render: (_args, value: RenameResult) => {
        const lines = [`已重命名「${value.from}」→「${value.to}」`]
        lines.push(`更新了 ${value.refsUpdated} 处引用（${value.refsTiddlers} 个 tiddler）`)
        if ((value.refsSkipped ?? 0) > 0) {
          const names = (value.skippedTitles ?? []).join('、')
          lines.push(`跳过了 ${value.refsSkipped} 个引用者（遍历期间被改动过，未覆盖）${names.length > 0 ? `：${names}` : ''}`)
        }
        if (value.warning !== undefined) lines.push(`注意: ${value.warning}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { oldTitle: string; newTitle: string; updateRefs?: boolean; expectedModified?: string; expectedRevision?: number; force?: boolean }): Promise<RenameResult> => {
      const wiki = requireWiki()
      const { oldTitle, newTitle } = args
      if (oldTitle === newTitle) return { ok: true, from: oldTitle, to: newTitle, refsUpdated: 0, refsTiddlers: 0 }
      const existing = await wiki.get(oldTitle)
      if (existing === undefined) throw new Error(`tiddler「${oldTitle}」不存在`)
      // The rename re-writes the OLD note's body under the NEW title: an edit that
      // landed after the caller's read would be lost silently (v0.25.0).
      assertNoConflict(oldTitle, existing, {
        expectedModified: args.expectedModified,
        expectedRevision: args.expectedRevision,
        force: args.force,
      })
      const target = await wiki.get(newTitle)
      if (target !== undefined) throw new Error(`新标题「${newTitle}」已存在（可先用 tiddlywiki_delete 删除）`)
      let refsUpdated = 0
      let refsTiddlers = 0
      let refsSkipped = 0
      const skippedTitles: string[] = []
      let warning: string | undefined
      if (args.updateRefs !== false) {
        const all = await wiki.list(undefined, true)
        for (const t of all) {
          if (t.title === oldTitle || t.title === newTitle) continue
          if (t.title.startsWith('$:/')) continue
          const text = t.text ?? ''
          if (text.length === 0) continue
          const rewritten = rewriteRefs(text, oldTitle, newTitle)
          if (rewritten.count > 0) {
            // The list is a SNAPSHOT (and may come from the client's short-TTL
            // listing cache): re-read this referrer and skip it when it changed
            // since. A skipped link is recoverable by hand; a silently clobbered
            // paragraph is not (v0.25.0).
            const fresh = await wiki.get(t.title)
            if (fresh === undefined) continue
            if (fresh.modified !== t.modified) {
              refsSkipped++
              skippedTitles.push(t.title)
              continue
            }
            // Shared policy (v0.22.10): a rewrite of the note's text is an
            // overwrite — keep its `created`, refresh `modified`, and preserve
            // tags/custom fields/type. Hand-building the PUT (the old
            // `cleanTiddler(t)` + text) carried the STALE `modified` through.
            const { tiddler } = buildWriteTiddler(t.title, rewritten.text, { existing: fresh })
            await wiki.put(tiddler)
            refsUpdated += rewritten.count
            refsTiddlers++
          }
        }
      }
      // Renaming is an overwrite from the new title's point of view: TW's own
      // rename keeps the source's `created` and stamps a fresh `modified`
      // (`new $tw.Tiddler(getCreationFields(), tiddler, {...}, getModificationFields())`).
      const { tiddler: renamed } = buildWriteTiddler(newTitle, existing.text ?? '', { existing })
      await wiki.put(renamed)
      // The new title is already written; a failure here leaves BOTH copies on
      // disk, so report the partial state instead of throwing a bare error (the
      // caller would otherwise assume the rename never happened) — v0.19.5.
      let deleteFailed: string | undefined
      try {
        await wiki.delete(oldTitle)
      } catch (err) {
        deleteFailed = err instanceof Error ? err.message : String(err)
      }
      if (refsTiddlers === 0 && refsSkipped === 0) {
        warning = '未找到任何其他 tiddler 引用旧标题；如确实需要，可手动补充链接。'
      }
      if (refsSkipped > 0) {
        const note = `有 ${refsSkipped} 个引用者因在遍历期间被改动而跳过（${skippedTitles.join('、')}），它们里面仍指向旧标题，请手动确认或重跑一次重命名。`
        warning = warning === undefined ? note : `${warning} ${note}`
      }
      if (deleteFailed !== undefined) {
        const partial = `新标题「${newTitle}」已写入，但旧标题「${oldTitle}」删除失败（${deleteFailed}）：现在两个标题都存在同一份内容，请手动删除旧标题。`
        warning = warning === undefined ? partial : `${warning} ${partial}`
      }
      deps.autoCommit()
      return {
        ok: true,
        from: oldTitle,
        to: newTitle,
        refsUpdated,
        refsTiddlers,
        ...(refsSkipped > 0 ? { refsSkipped, skippedTitles } : {}),
        ...(warning !== undefined ? { warning } : {}),
      }
    },
  }))

  // ── tiddlywiki_delete ────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_delete',
    description: '删除一个 TiddlyWiki tiddler（不存在时是幂等空操作）。默认是**软删除**：内容移入回收站（$:/dsh-tiddlywiki/trash/…，不再出现在检索/最近列表里）后删除原条目，可用 tiddlywiki_trash 恢复；permanent=true 才真正永久删除。删除后触发自动 commit。⚠️ 例外：`$:/` 系统条目不进回收站（回收站的约定是只收普通笔记，且系统标题无法被枚举），删除它们等同于 permanent=true——只有 git 历史可回退。',
    parameters: {
      title: { type: 'string', description: 'tiddler 标题（精确匹配）', required: true },
      permanent: { type: 'boolean', description: '可选：true = 永久删除（回收站也拿不回来，仅剩 git 历史）；默认 false = 移入回收站' },
      expectedModified: { type: 'string', description: '可选：乐观并发保护。传 tiddlywiki_get 读到的 modified；若条目在你读取之后被改动（人类在 TW 编辑器里改过）则拒绝删除' },
      expectedRevision: { type: 'integer', description: '可选：乐观并发保护的另一种令牌——传 tiddlywiki_get 返回字段里的 revision' },
      force: { type: 'boolean', description: '可选：true 时忽略 expectedModified/expectedRevision 强制删除（默认 false）' },
    },
    output: {
      render: (_args, value: DeleteResult) => [{
        type: 'text',
        text: value.trashed === true
          ? `已把 tiddler「${value.title}」移入回收站（$:/dsh-tiddlywiki/trash/，可用 tiddlywiki_trash action=restore 恢复）。`
          : `已永久删除 tiddler「${value.title}」。`,
      }],
    },
    execute: async (args: { title: string; permanent?: boolean; expectedModified?: string; expectedRevision?: number; force?: boolean }): Promise<DeleteResult> => {
      const wiki = requireWiki()
      const existing = await wiki.get(args.title)
      // Deleting something the caller never saw is fine only when it does not
      // exist; a token means the note WAS read, so a changed revision since then
      // must abort (v0.19.5 — delete used to have no concurrency protection at
      // all, while put/batch_put did: `get` → human edits in TW → `delete` threw
      // the human's work into the trash with no warning).
      assertNoConflict(args.title, existing, {
        expectedModified: args.expectedModified,
        expectedRevision: args.expectedRevision,
        force: args.force,
      })
      // Trash entries themselves and SYSTEM tiddlers are never nested.
      // v0.23.5: the condition used to only exclude TRASH_PREFIX, so
      // `delete('$:/dsh-tiddlywiki/trash-index')` trashed the index itself —
      // the next read then 404s, looks like "trash is empty", and the index is
      // rewritten with a single entry, silently dropping every record (exactly
      // the loss v0.19.5 set out to prevent, just through another door).
      const canTrash = existing !== undefined
        && args.permanent !== true
        && !args.title.startsWith(TRASH_PREFIX)
        && !args.title.startsWith('$:/')
      // The trash index is the ONLY way to enumerate what is in the trash
      // (`$:/` tiddlers cannot be listed through a recipe — see the module
      // docblock). Deleting it orphans every trashed note: `trash list` can no
      // longer see them, `restore` cannot find them, `empty` cannot clean them.
      // Use `tiddlywiki_trash action=empty` to clear the trash deliberately.
      if (args.title === TRASH_INDEX_TITLE && existing !== undefined) {
        throw new Error(
          `tiddlywiki_delete: 「${TRASH_INDEX_TITLE}」是回收站索引，删掉它会让回收站里的条目全部变成不可恢复的孤儿`
          + '（列不出、恢复不了、也清不掉）。要清空回收站请用 tiddlywiki_trash action=empty；'
          + '确实要丢弃索引请显式传 permanent: true。',
        )
      }
      if (!canTrash) {
        await wiki.delete(args.title)
        deps.autoCommit()
        return { ok: true, title: args.title, trashed: false }
      }
      const trashTitle = trashTitleFor(args.title)
      const at = new Date().toISOString()
      // ORDER MATTERS (v0.23.5, data safety): read + validate the index BEFORE
      // any destructive step. The old order trashed the note first and only then
      // read the index, so a failed/corrupt read aborted the tool AFTER the
      // original was already gone and BEFORE the index recorded it — the note
      // became an unreachable orphan (`trash list` cannot see it, `restore`
      // cannot find it, `empty` cannot clean it), while the tool reported
      // "aborted". Aborting first means the note simply is not deleted.
      const index = await readTrashIndex(wiki)
      if (!index.readOk || index.corrupted) throw new TrashIndexUnavailableError()
      // The snapshot is a COPY: it keeps the original's created/modified (they
      // describe the note — deleting must not rewrite its history, and a later
      // restore must bring the note back with the same times). `trash-at` records
      // when it was deleted. buildWriteTiddler refreshes `modified` to now (it
      // cannot tell a copy from an edit), so put the original back explicitly.
      const { tiddler: trashTiddler } = buildWriteTiddler(trashTitle, existing.text ?? '', { existing })
      trashTiddler.created = existing.created ?? trashTiddler.created
      trashTiddler.modified = existing.modified ?? trashTiddler.modified
      await wiki.put({ ...trashTiddler, 'trash-of': args.title, 'trash-at': at })
      await wiki.delete(args.title)
      index.entries.push({ trash: trashTitle, of: args.title, at })
      await writeTrashIndex(wiki, index.entries)
      deps.autoCommit()
      return { ok: true, title: args.title, trashed: true, trashTitle }
    },
  }))

  // ── tiddlywiki_trash ─────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_trash',
    description: '回收站（软删除的笔记）：action=list 列出、action=restore 恢复某条、action=empty 清空。配合 tiddlywiki_delete（默认软删除）使用。',
    parameters: {
      action: { type: 'string', enum: ['list', 'restore', 'empty'], description: 'list=列出回收站；restore=恢复（需 title）；empty=永久清空', required: true },
      title: { type: 'string', description: 'action=restore 时的原标题（也接受回收站标题）' },
      limit: { type: 'integer', description: 'action=list 的返回上限（默认 30，最大 200）' },
    },
    output: {
      render: (_args, value: TrashResult) => {
        const lines = [`回收站 ${value.action}：${value.message}`]
        for (const item of value.items ?? []) lines.push(`- ${item.title}（删除于 ${item.at ?? '?'}${item.of !== undefined ? `，原名「${item.of}」` : ''}）`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { action: 'list' | 'restore' | 'empty'; title?: string; limit?: number }): Promise<TrashResult> => {
      const wiki = requireWiki()
      const index = await readTrashIndex(wiki)
      // A failed/corrupt index must never be treated as「回收站是空的」: `empty`
      // would then report success while doing nothing, and `restore` would claim
      // the note was never trashed (v0.19.5).
      if (!index.readOk) throw new TrashIndexUnavailableError()
      if (index.corrupted) {
        throw new Error('回收站索引已损坏（JSON 解析失败），本次操作已中止以免误删记录；可手动检查 $:/dsh-tiddlywiki/trash-index 后重试。')
      }
      const indexed = index.entries
      if (args.action === 'list') {
        const limit = Math.max(1, Math.min(args.limit ?? 30, 200))
        return {
          action: 'list',
          message: `共 ${indexed.length} 条`,
          items: indexed.slice(-limit).reverse().map((entry) => ({ title: entry.trash, at: entry.at, of: entry.of })),
        }
      }
      if (args.action === 'empty') {
        for (const entry of indexed) await wiki.delete(entry.trash)
        await writeTrashIndex(wiki, [])
        deps.autoCommit()
        return { action: 'empty', message: `已清空 ${indexed.length} 条` }
      }
      const wanted = typeof args.title === 'string' ? args.title.trim() : ''
      if (wanted.length === 0) throw new Error('tiddlywiki_trash: action=restore 需要 title')
      const match = indexed.slice().reverse().find((entry) => entry.of === wanted || entry.trash === wanted)
      if (match === undefined) throw new Error(`回收站里没有「${wanted}」`)
      const stored = await wiki.get(match.trash)
      if (stored === undefined) {
        // Stale index entry (the tiddler was removed by hand): prune and report.
        await writeTrashIndex(wiki, indexed.filter((entry) => entry.trash !== match.trash))
        throw new Error(`回收站条目「${match.trash}」已不存在（索引已清理）`)
      }
      if ((await wiki.get(match.of)) !== undefined) {
        throw new Error(`无法恢复：标题「${match.of}」已被占用，请先处理现有条目`)
      }
      // A restore means「恢复原状」: bring the note back with the SAME
      // created/modified it had before deletion. The trash snapshot deliberately
      // preserved both (see the delete branch), so restoring must not stamp a new
      // modified — otherwise that preservation would be pointless and a restored
      // note would jump to the top of every「最近修改」view as if it were edited.
      // Both fields are still guaranteed present: `buildWriteTiddler` stamps a
      // legacy snapshot that lacks them, and `put()` is the final safety net.
      const { tiddler: restored } = buildWriteTiddler(match.of, stored.text ?? '', { existing: stored })
      restored.created = stored.created ?? restored.created
      restored.modified = stored.modified ?? restored.modified
      delete restored['trash-of']
      delete restored['trash-at']
      await wiki.put(restored)
      await wiki.delete(match.trash)
      await writeTrashIndex(wiki, indexed.filter((entry) => entry.trash !== match.trash))
      deps.autoCommit()
      return { action: 'restore', message: `已恢复「${match.of}」`, items: [] }
    },
  }))

  // ── tiddlywiki_append ────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_append',
    description: '向已有 tiddler 追加/前插文本，或写入指定标题段落的末尾（无需先读全文、不会整篇覆盖）——适合日志、批注、清单的增量写入。条目不存在时默认新建（createIfMissing=false 则报错）。**写入既有条目走与 tiddlywiki_put 同一套写策略**：原有 tags、自定义字段与**内容类型**全部保留（不会把 Markdown 笔记改成 wikitext、也不会把 CSS 改成 Markdown）；可用 fields 显式覆盖字段/类型。新建条目未指定内容类型时才默认 text/markdown（并像 tiddlywiki_put 一样自动补 agent-written 与 `ws/<项目名>` 工作区标记）。⚠️ 本工具内部是「读全文 → 整篇回写」，属于覆盖写入：改前请先 `tiddlywiki_get`，并把读到的 `modified` 作为 `expectedModified` 传回（v0.25.0 起支持），否则人类在 TW 编辑器里的并发修改会被静默回滚。',
    parameters: {
      title: { type: 'string', description: 'tiddler 标题', required: true },
      text: { type: 'string', description: '要追加/前插的文本（默认按 Markdown 写；既有条目保持它自己的内容类型）', required: true },
      mode: { type: 'string', enum: ['append', 'prepend'], description: '可选：append（默认，追加到末尾）/ prepend（插到开头）' },
      heading: { type: 'string', description: '可选：append 时改为插入到该标题（Markdown # 或 wikitext ! 标题，按标题文本匹配）对应段落的末尾' },
      createIfMissing: { type: 'boolean', description: '可选：条目不存在时是否新建（默认 true）' },
      tags: { type: 'array', items: { type: 'string' }, description: '可选：标签（不传则保留既有条目的原标签，传空数组 [] 表示清空全部标签；新建条目会额外自动补 agent-written）' },
      fields: { type: 'json', description: '可选：显式覆盖的自定义字段（如 {"type":"text/css"}）。不传则保留既有条目的原字段与内容类型' },
      expectedModified: { type: 'string', description: '可选：乐观并发保护。传 tiddlywiki_get 读到的 modified；若条目在你读取之后被改动（人类在 TW 编辑器里改过）则拒绝写入——本工具是整篇回写，这一步能防止吞掉别人的修改' },
      expectedRevision: { type: 'integer', description: '可选：乐观并发保护的另一种令牌——传 tiddlywiki_get 返回字段里的 revision（注意 revision 是 TW 的内存计数器，重启后会复位，长时间跨度请用 expectedModified）' },
      force: { type: 'boolean', description: '可选：true 时忽略 expectedModified/expectedRevision 强制写入（默认 false）' },
    },
    output: {
      render: (_args, value: AppendResult) => {
        const lines = [`${value.created ? '已新建并写入' : '已增量写入'} tiddler「${value.title}」（${value.mode}${value.heading !== null ? ` · 段落「${value.heading}」` : ''}）：新增 ${value.added} 字符，现共 ${value.total} 字符。`]
        if (value.type !== null) lines.push(`类型: ${value.type}${value.typeDefaulted === true ? '（新建且未指定，已默认 markdown）' : ''}`)
        if (value.typeChanged !== undefined) lines.push(`⚠️ 内容类型已从 ${value.typeChanged.from} 改为 ${value.typeChanged.to}`)
        if (value.workspace !== undefined) lines.push(`已自动标记工作区: ${WORKSPACE_TAG_PREFIX}${value.workspace}（字段 ${WORKSPACE_FIELD}）`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { title: string; text: string; mode?: 'append' | 'prepend'; heading?: string; createIfMissing?: boolean; tags?: string[]; fields?: Record<string, unknown>; expectedModified?: string; expectedRevision?: number; force?: boolean }, exec: unknown): Promise<AppendResult> => {
      const wiki = requireWiki()
      const title = args.title.trim()
      if (title.length === 0) throw new Error('tiddlywiki_append: title 不能为空')
      const existing = await wiki.get(title)
      // v0.25.0: append is a read-modify-write of the WHOLE note (`next` below is
      // the stale base plus the addition), so it needs the same optimistic guard
      // as put/delete. Without it, a human edit landing between our GET and PUT
      // was silently reverted — and the injected prompt recommends append for
      // exactly the incremental writes that hit this path most often.
      assertNoConflict(title, existing, {
        expectedModified: args.expectedModified,
        expectedRevision: args.expectedRevision,
        force: args.force,
      })
      if (existing === undefined && args.createIfMissing === false) {
        throw new Error(`tiddler「${title}」不存在（createIfMissing=false）`)
      }
      const mode = args.mode === 'prepend' ? 'prepend' : 'append'
      const base = existing?.text ?? ''
      const addition = args.text
      let next: string
      if (mode === 'append' && typeof args.heading === 'string' && args.heading.trim().length > 0) {
        next = insertIntoSection(base, args.heading.trim(), addition)
      } else if (mode === 'prepend') {
        next = base.trim().length === 0 ? addition : `${addition}\n\n${base}`
      } else {
        next = base.trim().length === 0 ? addition : `${base.replace(/\s+$/, '')}\n\n${addition}`
      }
      // v0.20.1: ONE write policy for every write path. The old append built its
      // PUT by hand, which (a) dropped the existing tiddler's `type` and
      // (b) ignored `fields` entirely — appending a paragraph to a Markdown note
      // silently downgraded it to wikitext. buildWriteTiddler preserves
      // tags/custom fields/type for an existing tiddler and only defaults the
      // type when creating.
      const appendMarked = existing === undefined && !title.startsWith('$:/')
        ? withWorkspaceMark(workspaceMarkFor(deps, exec), normalizeTagArg(args.tags), args.fields)
        : { tags: normalizeTagArg(args.tags), fields: args.fields }
      const { tiddler, typeDefaulted } = buildWriteTiddler(title, next, {
        existing,
        tags: appendMarked.tags,
        fields: appendMarked.fields,
      })
      await wiki.put(tiddler)
      deps.autoCommit()
      return {
        ok: true,
        title,
        mode,
        // `heading` only has an effect in append mode (v0.23.5): reporting it for
        // a prepend made the model believe the text landed in that section.
        heading: mode === 'append' && typeof args.heading === 'string' && args.heading.trim().length > 0
          ? args.heading.trim()
          : null,
        created: existing === undefined,
        added: addition.length,
        total: next.length,
        type: typeof tiddler.type === 'string' ? tiddler.type : null,
        ...(appendMarked.workspace !== undefined ? { workspace: appendMarked.workspace } : {}),
        ...(typeDefaulted ? { typeDefaulted: true } : {}),
        ...typeChangeOf(existing, tiddler),
      }
    },
  }))

  // ── tiddlywiki_backlinks ─────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_backlinks',
    description: '查反向链接：哪些笔记引用了目标 tiddler（[[标题]] / [[显示|标题]] / {{标题}}），以及哪些笔记把它当作标签。用于知识图谱导航、改动前评估影响面。',
    parameters: {
      title: { type: 'string', description: '目标 tiddler 标题', required: true },
      includeTags: { type: 'boolean', description: '可选：是否把「以该标题为标签」的笔记也算作反向链接（默认 true）' },
      limit: { type: 'integer', description: '可选：最多返回多少条（默认 30，最大 200）' },
    },
    output: {
      render: (_args, value: BacklinkResult) => {
        const lines = [`「${value.title}」的反向链接：${value.total} 条（引用 ${value.linkCount} · 标签 ${value.tagCount}）`]
        if (value.items.length === 0) lines.push('没有任何笔记引用它。')
        for (const item of value.items) {
          lines.push(`- ${item.title}（${item.via === 'tag' ? '标签' : `${item.refs} 处引用`}）`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { title: string; includeTags?: boolean; limit?: number }): Promise<BacklinkResult> => {
      const wiki = requireWiki()
      const target = args.title.trim()
      if (target.length === 0) throw new Error('tiddlywiki_backlinks: title 不能为空')
      const includeTags = args.includeTags !== false
      const limit = Math.max(1, Math.min(args.limit ?? 30, 200))
      const items = await wiki.list(undefined, true)
      const hits: Array<{ title: string; refs: number; via: 'link' | 'tag'; modified: string | null }> = []
      let linkCount = 0
      let tagCount = 0
      for (const t of items) {
        if (t.title === target || t.title.startsWith('$:/')) continue
        const refs = countRefsTo(t.text ?? '', target)
        const tagged = includeTags && (t.tags ?? []).includes(target)
        if (refs === 0 && !tagged) continue
        if (refs > 0) linkCount++
        if (tagged) tagCount++
        hits.push({ title: t.title, refs, via: refs > 0 ? 'link' : 'tag', modified: toIsoDateString(t.modified) })
      }
      hits.sort((a, b) => b.refs - a.refs || a.title.localeCompare(b.title, 'zh'))
      return { title: target, total: hits.length, linkCount, tagCount, items: hits.slice(0, limit) }
    },
  }))

  // ── tiddlywiki_attach ────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_attach',
    description: '把一个本机文件或公网 http(s) 地址存成 wiki 的二进制附件 tiddler（图片 / PDF / 压缩包等，type + base64 正文，随 wiki 进 git）。可选把附件嵌入/链接进某篇笔记。这是 agent 唯一能写入二进制附件的途径。',
    parameters: {
      title: { type: 'string', description: '附件 tiddler 标题（同时决定其在 wiki 里的名字）', required: true },
      path: { type: 'string', description: '本机绝对路径（与 url 二选一）' },
      url: { type: 'string', description: '公网 http(s) 地址（与 path 二选一；含 SSRF 守卫，拒绝内网/回环地址）' },
      tags: { type: 'array', items: { type: 'string' }, description: '可选：附件标签' },
      noteTitle: { type: 'string', description: '可选：把该附件嵌入到这篇笔记末尾（图片用 [img[标题]]，其它用 [[标题]] 链接）' },
      expectedModified: { type: 'string', description: '可选：乐观并发保护，仅在同名 tiddler 已存在时有意义（传 tiddlywiki_get 读到的 modified）' },
      expectedRevision: { type: 'integer', description: '可选：乐观并发保护的另一种令牌——传 tiddlywiki_get 返回字段里的 revision' },
      force: { type: 'boolean', description: '可选：true 时忽略 expectedModified/expectedRevision，允许覆盖同名 tiddler（默认 false；即便覆盖也会保留其 tags 与自定义字段）' },
    },
    output: {
      render: (_args, value: AttachResult) => {
        const lines = [`已保存附件「${value.title}」（${value.mime}，${value.bytes} 字节，base64 约 ${value.chars} 字符）`]
        if (value.source !== null) lines.push(`来源: ${value.source}`)
        if (value.embedInto !== null) lines.push(`已嵌入笔记「${value.embedInto}」`)
        lines.push(`打开: [${value.title}](/dsh-tiddlywiki/tw/#${encodeURIComponent(value.title)})`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { title: string; path?: string; url?: string; tags?: string[]; noteTitle?: string; expectedModified?: string; expectedRevision?: number; force?: boolean }): Promise<AttachResult> => {
      const wiki = requireWiki()
      const title = args.title.trim()
      if (title.length === 0) throw new Error('tiddlywiki_attach: title 不能为空')
      const hasPath = typeof args.path === 'string' && args.path.trim().length > 0
      const hasUrl = typeof args.url === 'string' && args.url.trim().length > 0
      if (hasPath === hasUrl) throw new Error('tiddlywiki_attach: path 与 url 必须且只能提供一个')
      let buffer: Buffer
      let mime: string
      let source: string
      if (hasPath) {
        const filePath = (args.path as string).trim()
        // Absolute only: a relative path would resolve against the DSH process
        // cwd, which is not something the model can reason about.
        if (!isAbsolute(filePath)) throw new Error('tiddlywiki_attach: path 必须是绝对路径')
        const info = await stat(filePath)
        if (!info.isFile()) throw new Error(`tiddlywiki_attach: ${basename(filePath)} 不是普通文件`)
        if (info.size > MAX_ATTACH_BYTES) throw new Error(`tiddlywiki_attach: 文件超过 ${Math.floor(MAX_ATTACH_BYTES / 1024 / 1024)}MB 上限`)
        buffer = await readFile(filePath)
        const ext = extname(filePath).slice(1).toLowerCase()
        mime = ATTACH_MIME_BY_EXT[ext] ?? 'application/octet-stream'
        source = filePath
      } else {
        const imageUrl = (args.url as string).trim()
        const downloaded = await downloadClipImage(imageUrl, '')
        buffer = downloaded.buffer
        const ext = extname(new URL(imageUrl).pathname).slice(1).toLowerCase()
        mime = downloaded.type?.split(';')[0]?.trim() || ATTACH_MIME_BY_EXT[ext] || 'application/octet-stream'
        source = imageUrl
      }
      if (buffer.length === 0) throw new Error('tiddlywiki_attach: 内容为空')
      if (buffer.length > MAX_ATTACH_BYTES) throw new Error(`tiddlywiki_attach: 内容超过 ${Math.floor(MAX_ATTACH_BYTES / 1024 / 1024)}MB 上限`)
      // DATA SAFETY (v0.19.5): this used to `wiki.put({title, type, text})` with
      // no read at all — attaching an image whose title collided with an existing
      // note silently replaced that note (tags, custom fields and body all gone),
      // the exact class the write policy exists to prevent. It also never added
      // the `agent-written` tag every other creating tool adds. Read first (404 =
      // new tiddler; any other failure propagates), then build the PUT from the
      // existing tiddler so a same-named note keeps everything but its body.
      const existing = await wiki.get(title)
      assertNoConflict(title, existing, {
        expectedModified: args.expectedModified,
        expectedRevision: args.expectedRevision,
        force: args.force,
      })
      // An attachment sharing a title with an existing tiddler is almost always
      // a mistake (the old code silently destroyed the note). Require explicit
      // consent: a concurrency token (the caller proved it read the tiddler) or
      // `force: true`. `expectedRevision`/`expectedModified` alone does NOT
      // consent to an overwrite — `assertNoConflict` above only rejects when the
      // tiddler changed since that token, so a stale-but-matching token would
      // still wipe the body.
      if (existing !== undefined && args.force !== true) {
        throw new Error(
          `tiddlywiki_attach: 标题「${title}」已存在（type=${typeof existing.type === 'string' ? existing.type : '?'}）。`
          + '为避免静默覆盖既有笔记，请换一个附件标题；确认要覆盖时传 force: true（tags 与自定义字段仍会保留）。',
        )
      }
      const explicitTags = Array.isArray(args.tags)
        ? args.tags.filter((t) => typeof t === 'string' && t.trim().length > 0)
        : undefined
      const { tiddler } = buildWriteTiddler(title, buffer.toString('base64'), {
        existing,
        ...(explicitTags !== undefined && explicitTags.length > 0 ? { tags: explicitTags } : {}),
        fields: {
          type: mime,
          'attach-source': source,
          'attach-at': new Date().toISOString(),
        },
      })
      await wiki.put(tiddler)
      let embedInto: string | null = null
      if (typeof args.noteTitle === 'string' && args.noteTitle.trim().length > 0) {
        embedInto = args.noteTitle.trim()
        const note = await wiki.get(embedInto)
        // A binary tiddler holds base64 in `text`: appending an embed line would
        // corrupt it (and `type: image/png` would stay, so the receipt would look
        // fine). Same class `tiddlywiki_put` refuses — refuse here too (v0.25.0).
        if (note !== undefined && isBinaryType(typeof note.type === 'string' ? note.type : undefined)) {
          throw new Error(
            `tiddlywiki_attach: noteTitle「${embedInto}」是二进制附件（type=${String(note.type)}），`
            + '把嵌入链接写进去会写坏附件；请改用普通笔记，或去掉 noteTitle 参数单独保存附件。',
          )
        }
        // `[img[Title]]` breaks if the attachment title itself contains `]]`;
        // fall back to a plain link (which has the same constraint, so strip the
        // sequence) instead of silently producing a broken embed.
        const safeTitle = title.replace(/\]\]/g, '] ]')
        const embed = mime.startsWith('image/') ? `[img[${safeTitle}]]` : `[[${safeTitle}]]`
        const text = note === undefined ? embed : `${(note.text ?? '').replace(/\s+$/, '')}\n\n${embed}`
        // Same read-modify-write policy as everywhere else: preserve the note's
        // tags/custom fields/type, only append the embed.
        const { tiddler: noteTiddler } = buildWriteTiddler(embedInto, text, { existing: note })
        await wiki.put(noteTiddler)
      }
      deps.autoCommit()
      return { ok: true, title, mime, bytes: buffer.length, chars: buffer.toString('base64').length, source, embedInto }
    },
  }))

  // ── tiddlywiki_lint ──────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_lint',
    description: '知识库体检（**只读，绝不改动任何笔记**）：找出垃圾/异常标签、指向不存在条目的死链、空笔记、疑似 Markdown 却缺 type 的笔记，以及**时效性内容**（已过期 / 待复查 / 建议复查的候选）。返回按类别分组的问题清单与建议；淘汰与否完全由你决定。',
    parameters: {
      limit: { type: 'integer', description: '可选：每类最多返回多少条示例（默认 10，最大 100）' },
      checks: { type: 'array', items: { type: 'string' }, description: '可选：只跑指定检查。合法值只有 junk-tags / broken-links / empty-notes / missing-type / stale；回执会列出**实际运行**的检查，无法识别的名字会被明确报出来（不会静默当成「库很干净」）' },
      staleAfterDays: { type: 'integer', description: '可选：`stale` 检查里「长期未改动」的阈值天数（默认 180）。只影响候选的判定，不影响 valid-until / review-after 的硬判定' },
    },
    output: {
      render: (_args, value: LintResult) => {
        const ran = value.checks.length > 0 ? value.checks.join(', ') : '（无）'
        const lines = [`知识库体检：扫描 ${value.scanned} 条文本笔记，已检查 ${ran}，发现 ${value.issues.reduce((sum, i) => sum + i.count, 0)} 个问题。`]
        if (value.unknownChecks.length > 0) {
          lines.push(`⚠️ 忽略了无法识别的检查名：${value.unknownChecks.join(', ')}——合法值只有 ${LINT_CHECKS.join(' / ')}`)
        }
        if (value.issues.length === 0) {
          lines.push(value.checks.length === 0
            ? '没有运行任何检查（请求的检查名全部无法识别）。'
            : '没有发现问题。')
        }
        for (const issue of value.issues) {
          lines.push(`- ${issue.kind}：${issue.count} 处 — ${issue.hint}`)
          for (const sample of issue.samples) lines.push(`    · ${sample}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { limit?: number; checks?: string[]; staleAfterDays?: number }): Promise<LintResult> => {
      const wiki = requireWiki()
      const limit = Math.max(1, Math.min(args.limit ?? 10, 100))
      // Validate `checks` against the real list (v0.25.0). The old `new Set(checks)`
      // silently ignored an unknown name, so a typo ('broken-link') ran NO checks
      // and the receipt still read「发现 0 个问题 / 没有发现问题」—— a false clean
      // bill of health, measured on a 2933-note wiki.
      const requested = Array.isArray(args.checks)
        ? args.checks.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim())
        : []
      const unknownChecks = requested.filter((c) => !(LINT_CHECKS as readonly string[]).includes(c))
      const checks: string[] = requested.length > 0
        ? LINT_CHECKS.filter((c) => requested.includes(c))
        : [...LINT_CHECKS]
      const want = (kind: string): boolean => checks.includes(kind)
      const items = await wiki.list(undefined, true)
      // 死链检查需要**全部**标题（含图片/PDF 等二进制附件）——只拿文本列表会
      // 把每一条 `[[图.png]]` / `{{附件}}` 都误报成死链（v0.19.1 修复）。
      // 瘦列表（不带正文）一次请求就能拿到全部标题。
      const titles = want('broken-links')
        ? new Set((await wiki.list()).map((t) => t.title))
        : new Set(items.map((t) => t.title))
      // 缺 type 判定要走 `[!has[type]]` 过滤器：TW 服务端会给 listing 里**每条**
      // 无 type 的条目补 `text/vnd.tiddlywiki`，靠响应里的 type 永远认不出来
      // （v0.19.1 修复：旧实现里这个检查永远不触发）。过滤器在服务端按真实字段
      // 求值，返回的标题就是真正没有 type 的那些。
      const typelessTitles = want('missing-type')
        ? new Set((await wiki.list(MISSING_TYPE_FILTER)).map((t) => t.title))
        : new Set<string>()
      const issues: LintIssue[] = []

      if (want('junk-tags')) {
        const samples: string[] = []
        let count = 0
        for (const t of items) {
          for (const tag of t.tags ?? []) {
            if (!isJunkTag(tag)) continue
            count++
            if (samples.length < limit) samples.push(`「${t.title}」的标签「${tag}」`)
          }
        }
        if (count > 0) issues.push({ kind: 'junk-tags', count, hint: '明显是写入事故产生的标签（如筛选器错误文本）；用 tiddlywiki_put 重写该条目的 tags 清理', samples })
      }

      if (want('broken-links')) {
        const samples: string[] = []
        let count = 0
        // v0.23.6: the transclusion branch must NOT match a `{{{…}}}` filtered
        // transclusion expression. The old `/…|\{\{([^}]+)\}\}/` began at the
        // first two braces of `{{{`, captured `{ [tag[todo]count[]] ` — so the
        // "target" started with `{` — and reported it as a broken link, flagging
        // every page that counts with `{{{[…count[]]}}}` (the home page, the
        // session docs, …). The lookarounds say "not part of a triple brace"
        // directly; the `startsWith('{')` guard is defence in depth.
        const linkRe = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|(?<!\{)\{\{(?!\{)([^}]+)\}\}/g
        for (const t of items) {
          const text = t.text ?? ''
          let match: RegExpExecArray | null
          while ((match = linkRe.exec(text)) !== null) {
            const target = (match[3] ?? match[2] ?? match[1] ?? '').trim()
            if (target.length === 0 || target.startsWith('$:/') || /^(https?|mailto|file):/.test(target)) continue
            if (target.includes('$') || target.includes('<')) continue // variable/macro, not a tiddler link
            if (target.startsWith('{')) continue // inside a `{{{…}}}` filtered transclusion
            if (titles.has(target)) continue
            count++
            if (samples.length < limit) samples.push(`「${t.title}」→「${target}」`)
          }
        }
        if (count > 0) issues.push({ kind: 'broken-links', count, hint: '被引用条目标题不存在；确认是笔误还是应新建该条目', samples })
      }

      if (want('empty-notes')) {
        const samples: string[] = []
        let count = 0
        for (const t of items) {
          if (t.title.startsWith('$:/')) continue
          if (isBinaryType(typeof t.type === 'string' ? t.type : undefined)) continue
          if ((t.text ?? '').trim().length === 0) {
            count++
            if (samples.length < limit) samples.push(`「${t.title}」`)
          }
        }
        if (count > 0) issues.push({ kind: 'empty-notes', count, hint: '正文为空的笔记；补内容或删除', samples })
      }

      if (want('missing-type')) {
        const samples: string[] = []
        let count = 0
        for (const t of items) {
          if (t.title.startsWith('$:/')) continue
          if (!typelessTitles.has(t.title)) continue
          const text = t.text ?? ''
          if (/^#{1,6}\s|\n#{1,6}\s|^\s*[-*]\s|\*\*[^*]+\*\*/m.test(text)) {
            count++
            if (samples.length < limit) samples.push(`「${t.title}」（无 type 字段，当前按 wikitext 渲染）`)
          }
        }
        if (count > 0) issues.push({ kind: 'missing-type', count, hint: '正文像 Markdown 但条目没有 type 字段，TW 会按 wikitext 渲染；用 tiddlywiki_put 的 fields.type 明确内容类型', samples })
      }

      // ── 时效性内容（v0.24.0）────────────────────────────────────────────
      // READ-ONLY BY DESIGN. The user's rule: the report may say "this looks
      // expired", never "I removed it". Deleting a knowledge-base note is the
      // user's call — the wiki is a git repo, so keeping something costs almost
      // nothing while a wrong deletion costs a lot.
      //
      // Two HARD judgements (explicit fields) and one HEURISTIC bucket that is
      // labelled as a candidate, not a verdict.
      if (want('stale')) {
        const now = Date.now()
        const staleAfterDays = Math.max(1, Math.min(args.staleAfterDays ?? 180, 3650))
        const staleAfterMs = staleAfterDays * 24 * 60 * 60 * 1000
        const expired: string[] = []
        const review: string[] = []
        const candidates: string[] = []
        let expiredCount = 0
        let reviewCount = 0
        let candidateCount = 0
        for (const t of items) {
          if (t.title.startsWith('$:/')) continue
          const validUntil = expiryOf(t['valid-until'])
          if (validUntil !== undefined && validUntil < now) {
            expiredCount++
            if (expired.length < limit) expired.push(`「${t.title}」（valid-until 已过）`)
          }
          const reviewAfter = expiryOf(t['review-after'])
          if (reviewAfter !== undefined && reviewAfter < now) {
            reviewCount++
            if (review.length < limit) review.push(`「${t.title}」（review-after 已到）`)
          }
          if (validUntil !== undefined || reviewAfter !== undefined) continue // already reported above
          const modified = parseTiddlerDate(t.modified)
          const old = modified === undefined || now - modified > staleAfterMs
          if (!old) continue
          const tags = t.tags ?? []
          // 版本号标签（v2.1.1 / 1.2.3）天然是阶段性内容；`done` 是很久以前
          // 完成的任务，其上下文很可能已经过期。
          const versionTag = tags.find((tag) => /^v?\d+\.\d+(\.\d+)?$/.test(tag.trim()))
          const doneTag = tags.some((tag) => tag.trim() === 'done')
          if (versionTag !== undefined || doneTag) {
            candidateCount++
            if (candidates.length < limit) {
              candidates.push(`「${t.title}」（${versionTag !== undefined ? `版本标签 ${versionTag}` : 'done 标签'}，${staleAfterDays} 天未改动）`)
            }
          }
        }
        if (expiredCount > 0) {
          issues.push({ kind: 'stale-expired', count: expiredCount, hint: '`valid-until` 已过期——内容按声明已失效。建议：确认后改成新内容、或打 归档 / superseded 标签、或（确认无用再）tiddlywiki_delete（默认进回收站，可恢复）', samples: expired })
        }
        if (reviewCount > 0) {
          issues.push({ kind: 'stale-review', count: reviewCount, hint: '`review-after` 到期——该复查是否仍然适用。建议：复查后更新 `review-after`，或把结论写进正文', samples: review })
        }
        if (candidateCount > 0) {
          issues.push({ kind: 'stale-candidates', count: candidateCount, hint: `**候选，非判定**：带版本号或 done 标签且 ${staleAfterDays} 天未改动，值得人工扫一眼。建议：确认过期的加 valid-until / superseded-by 字段或归档标签；仍有效的更新一下 modified 即可`, samples: candidates })
        }
      }

      return { scanned: items.length, checks, unknownChecks, issues }
    },
  }))

  // ── tiddlywiki_git_sync ──────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_git_sync',
    description: '对 TiddlyWiki 知识库的 git 仓库做同步：pull（拉取远端并 rebase 本地，冲突则 abort 并报文件）、push（推送本地提交到远端）、sync（pull → commit 本地改动 → push）。未配置 git.remote 时 push 会失败并提示。',
    parameters: {
      action: { type: 'string', enum: ['pull', 'push', 'sync'], description: '要执行的 git 操作', required: true },
      message: { type: 'string', description: 'commit 信息（可选，仅 sync 的本地 commit 使用）' },
    },
    output: {
      render: (_args, value: SyncResult) => renderSync(value),
    },
    execute: async (args: { action: 'pull' | 'push' | 'sync'; message?: string }): Promise<SyncResult> => {
      const dir = deps.wikiPath()
      /** Restart TW after a pull that changed the tree (stale snapshot drop). */
      const restartIfChanged = async (pulled: { changed?: boolean }): Promise<{ restarted?: boolean; restartError?: string }> => {
        if (pulled.changed !== true || deps.restartWiki === undefined) return {}
        try {
          // DRAIN THE SYNCER FIRST (v0.19.1, data safety): a PUT answers 204 as
          // soon as the tiddler is in TW's in-memory store; the filesystem
          // syncer writes it ~250ms later. Restarting TW before that flush KILLS
          // the write (the restarted server boots from the old snapshot and the
          // note is gone — not even the git commit that follows can recover it).
          // The agent path is the risky one: `tiddlywiki_put` → `git_sync`
          // back-to-back. Same sentinel trick as seeds.ts / index.ts.
          await flushPendingWrites(requireWiki(), join(dir, 'tiddlers')).catch(() => undefined)
          await deps.restartWiki()
          return { restarted: true }
        } catch (err) {
          return { restartError: err instanceof Error ? err.message : String(err) }
        }
      }
      switch (args.action) {
        case 'pull': {
          const r = await deps.git.pull(dir)
          const restart = await restartIfChanged(r)
          return { action: args.action, ok: r.ok, message: r.message, ...(r.conflictFiles !== undefined ? { conflictFiles: r.conflictFiles } : {}), ...(r.changed === true ? { changed: true } : {}), ...restart }
        }
        case 'push': {
          const r = await deps.git.push(dir)
          return { action: args.action, ok: r.ok, message: r.message }
        }
        case 'sync': {
          const pulled = await deps.git.pull(dir)
          if (!pulled.ok) return { action: args.action, ok: false, message: pulled.message, ...(pulled.conflictFiles !== undefined ? { conflictFiles: pulled.conflictFiles } : {}) }
          const restart = await restartIfChanged(pulled)
          // The commit guard (v0.23.4) turns a conflicted tree into a structured
          // failure instead of a thrown error: the model must SEE why nothing was
          // committed, otherwise it would report「同步完成」over broken content.
          let committed: { committed: boolean; message: string }
          try {
            committed = await deps.git.commit(dir, args.message ?? `sync ${new Date().toISOString()}`)
          } catch (err) {
            if (err instanceof GitConflictStateError) {
              return { action: args.action, ok: false, message: err.message, conflictFiles: err.files, ...restart }
            }
            throw err
          }
          const pushed = await deps.git.push(dir)
          const status = await deps.git.status(dir)
          return {
            action: args.action,
            ok: pushed.ok,
            message: pushed.ok ? '同步完成' : pushed.message,
            pull: 'ok',
            ...(pulled.changed === true ? { changed: true } : {}),
            ...restart,
            commit: committed.message,
            push: pushed.message,
            status,
          }
        }
      }
    },
  }))

  // ── tiddlywiki_git_resolve ───────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_git_resolve',
    description: '在 tiddlywiki_git_sync action=pull 冲突（已 abort）后，按 tiddler 二选一解决：keep-local 保留本地版本；keep-remote 用 git fetch 拉取远端并检出远端版本（需已配置 git.remote）；list 仅报告当前状态。解决后建议重新 pull/sync 整合其余改动。',
    parameters: {
      strategy: { type: 'string', enum: ['keep-local', 'keep-remote', 'list'], description: 'keep-local=保留本地；keep-remote=改用远端版本；list=仅报告当前 git 状态', required: true },
      files: { type: 'array', items: { type: 'string' }, description: '冲突文件名数组（来自 pull 返回的 conflictFiles；list 时忽略）' },
    },
    output: {
      render: (_args, value: ResolveResult) => {
        const lines = [`git resolve ${value.action}: ${value.ok ? '成功' : '失败'}`]
        lines.push(`  ${value.message}`)
        if (value.files !== undefined && value.files.length > 0) lines.push(`涉及文件: ${value.files.join(', ')}`)
        if (value.commit !== undefined) lines.push(`本地 commit: ${value.commit}`)
        if (value.status !== undefined) lines.push(`状态: ${gitStatusBits(value.status)}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { strategy: 'keep-local' | 'keep-remote' | 'list'; files?: string[] }): Promise<ResolveResult> => {
      const dir = deps.wikiPath()
      if (args.strategy === 'list') {
        const status = await deps.git.status(dir)
        return { ok: true, action: 'list', message: '当前仓库状态（pull 冲突已 abort，工作区即本地版本，不会残留未合并状态）', status }
      }
      const files = (args.files ?? []).filter((f) => typeof f === 'string' && f.length > 0)
      if (files.length === 0) {
        return { ok: false, action: args.strategy, message: '请提供 conflictFiles（来自 pull 返回）', hint: '可先执行 tiddlywiki_git_sync action=pull 查看冲突文件' }
      }
      if (args.strategy === 'keep-local') {
        const status = await deps.git.status(dir)
        return {
          ok: true,
          action: 'keep-local',
          message: `已保留本地版本（${files.length} 个文件；abort 后本地即为工作区内容）。建议重新 tiddlywiki_git_sync action=sync 整合远端其余改动。`,
          files,
          status,
        }
      }
      const fetched = await deps.git.fetch(dir)
      if (!fetched.ok) {
        return { ok: false, action: 'keep-remote', message: `fetch 失败（可能未配置 git.remote）：${fetched.message}` }
      }
      const checked = await deps.git.checkoutFetchHead(dir, files)
      if (!checked.ok) {
        return { ok: false, action: 'keep-remote', message: `从远端检出失败：${checked.message}` }
      }
      // Same guard as git_sync: resolving one file may still leave other
      // conflicted files behind — report that instead of throwing (v0.23.4).
      let committed: { committed: boolean; message: string }
      try {
        committed = await deps.git.commit(dir, `resolve conflict (keep remote) ${new Date().toISOString()}`)
      } catch (err) {
        if (err instanceof GitConflictStateError) {
          return { ok: false, action: 'keep-remote', message: err.message, files: err.files }
        }
        throw err
      }
      deps.autoCommit()
      const status = await deps.git.status(dir)
      return {
        ok: true,
        action: 'keep-remote',
        message: `已把 ${files.length} 个冲突文件改为远端版本并提交。建议继续 tiddlywiki_git_sync action=sync 完成整合与推送。`,
        files,
        commit: committed.message,
        status,
      }
    },
  }))

  return disposers
}

// ── tool result shapes + renders ───────────────────────────────────────────

interface SearchHit { title: string; tags: string[]; modified: string | null; snippet: string }
interface SearchResult { query: string; tags: string[]; since: string | null; type: string | null; field: string | null; value: string | null; total: number; /** 自动缩范围用的工作区 id（v0.24.0）；null = 未启用/不可用。 */ workspace: string | null; /** 结果来自哪个范围。 */ scope: 'workspace' | 'all'; /** 工作区内 0 条、已扩大到全库（回执必须说出来）。 */ fellBack: boolean; results: SearchHit[] }
interface RecentResult { since: string | null; results: SearchHit[] }
interface TagListResult { count: number; total: number; truncated: boolean; tags: Array<{ tag: string; count: number }> }
interface GetResult {
  notFound: boolean
  title: string
  text: string
  tags: string[]
  fields: Record<string, unknown>
  modified: string | null
  /** Binary attachment (image/audio/…): `text` is withheld, these carry its type+size. */
  binary?: boolean
  binaryType?: string
  binaryChars?: number
}
interface PutResult { ok: boolean; title: string; tags: string[]; type: string | null; typeDefaulted?: boolean; /** 覆盖时内容类型真的变了（v0.20.1）。 */ typeChanged?: { from: string; to: string }; fields: Record<string, unknown> | null; /** 新建时自动打上的工作区标记（v0.24.0）。 */ workspace?: string }
interface BatchItemResult { title: string; written: boolean; skipped: boolean; failed: boolean; error?: string; /** 该条是新建且自动打了工作区标记（v0.24.0）。 */ workspace?: string }
interface BatchResult { ok: boolean; written: number; skipped: number; failed: number; items: BatchItemResult[] }
interface RenameResult { ok: boolean; from: string; to: string; refsUpdated: number; refsTiddlers: number; /** 因遍历期间被改动而跳过的引用者数量（v0.25.0）。 */ refsSkipped?: number; skippedTitles?: string[]; warning?: string }
interface DeleteResult { ok: boolean; title: string; /** true = moved to the trash (recoverable). */ trashed?: boolean; trashTitle?: string }
interface TrashItem { title: string; at?: string; of?: string }
interface TrashResult { action: string; message: string; items?: TrashItem[] }
interface AppendResult { ok: boolean; title: string; mode: 'append' | 'prepend'; heading: string | null; created: boolean; added: number; total: number; type?: string | null; typeDefaulted?: boolean; typeChanged?: { from: string; to: string }; /** 新建时自动打上的工作区标记（v0.24.0）。 */ workspace?: string }
interface BacklinkHit { title: string; refs: number; via: 'link' | 'tag'; modified: string | null }
interface BacklinkResult { title: string; total: number; linkCount: number; tagCount: number; items: BacklinkHit[] }
interface AttachResult { ok: boolean; title: string; mime: string; bytes: number; chars: number; source: string | null; embedInto: string | null }
interface LintIssue { kind: string; count: number; hint: string; samples: string[] }
interface LintResult { scanned: number; /** 实际运行的检查（v0.25.0）。 */ checks: string[]; /** 请求里无法识别的检查名（回执必须报出来）。 */ unknownChecks: string[]; issues: LintIssue[] }
interface SyncResult {
  action: string
  ok: boolean
  message: string
  conflictFiles?: string[]
  pull?: string
  commit?: string
  push?: string
  changed?: boolean
  restarted?: boolean
  restartError?: string
  status?: GitStatusView
}
interface ResolveResult {
  ok: boolean
  action: string
  message: string
  files?: string[]
  commit?: string
  hint?: string
  status?: GitStatusView
}

/** One-line 状态 summary: 分支 … 领先 … 落后 … 工作区未提交 … 最近提交. */
function gitStatusBits(s: GitStatusView): string {
  const bits = [`分支 ${s.branch}`]
  if (s.ahead !== undefined) bits.push(`领先 ${s.ahead}`)
  if (s.behind !== undefined) bits.push(`落后 ${s.behind}`)
  if (s.dirty) bits.push(`工作区有 ${s.dirtyFiles.length} 个未提交改动`)
  if (s.lastCommit !== undefined) bits.push(`最近提交 ${s.lastCommit}`)
  return bits.join(' · ')
}

function renderSync(value: SyncResult): Array<{ type: 'text'; text: string }> {
  const lines = [`git ${value.action}: ${value.ok ? '成功' : '失败'}`]
  lines.push(`  ${value.message}`)
  if (value.conflictFiles !== undefined && value.conflictFiles.length > 0) {
    lines.push(`冲突文件（rebase 已 abort，勿自动覆盖）:`)
    for (const f of value.conflictFiles) lines.push(`  - ${f}`)
    lines.push('处理方式：用 tiddlywiki_git_resolve files=[以上文件] strategy=keep-local|keep-remote 按 tiddler 二选一解决，再重新 sync；也可以直接让用户处理。')
  }
  if (value.commit !== undefined) lines.push(`本地 commit: ${value.commit}`)
  if (value.push !== undefined) lines.push(`远端 push: ${value.push}`)
  if (value.changed === true) {
    lines.push(value.restarted === true
      ? '本次 pull 拉取了新内容，TW 服务已自动重启（同端口），读取/搜索均为最新快照。'
      : '本次 pull 拉取了新内容，但 TW 服务未能自动重启（如需最新快照，请手动重启 TW）。')
  }
  if (value.restartError !== undefined) lines.push(`TW 重启失败: ${value.restartError}`)
  if (value.status !== undefined) {
    lines.push(`状态: ${gitStatusBits(value.status)}`)
    const s = value.status
    if (s.dirty && s.dirtyFiles.length > 0) lines.push(`  未提交: ${s.dirtyFiles.join(', ')}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

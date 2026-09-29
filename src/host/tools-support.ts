/**
 * Shared types, result shapes and pure helpers behind the `tiddlywiki_*` tools.
 *
 * Split out of `tools.ts` in v0.28.8 — a PURE CODE MOVE: no behaviour, string
 * literal, schema or rendered output changed. The factory modules (tools-read /
 * tools-notes / tools-attach / tools-git) import from here, and `tools.ts`
 * re-exports everything that was public on that path before the split.
 *
 * @module dsh-tiddlywiki/host/tools-support
 */
import { parseTiddlerDate } from './tw-api.ts'
import type { Tiddler, TiddlyWebClient } from './tw-api.ts'
import type { GitFace, GitStatusView, GitSyncTarget } from './git.ts'
import { flattenTiddlerFields, normalizeFieldsArg } from './write-policy.ts'
import { WORKSPACE_FIELD, workspaceMarkFromCwd } from './workspace.ts'

/** Structural shape the collector needs from a registry-ready tool. */
export interface RegistrableTool {
  readonly name: string
  readonly parameters: Record<string, unknown>
}


/** Structural tool-registry face (subset of the dsh tools service). */
export interface ToolsCtx {
  tools: { register(tool: unknown): () => void }
}

/**
 * What one tool call may act on (v0.28.0).
 *
 * `ambiguous` is true when MORE THAN ONE knowledge base is visible to the agent:
 * only then does every tool result carry a 「知识库：…」 header, so a single-wiki
 * install keeps byte-identical output while a multi-wiki one always says which
 * base a result came from (writing to the wrong one is the failure this feature
 * most needs to make visible).
 */
export interface ToolScope {
  /** Live TW client of the resolved wiki (undefined = cannot serve). */
  client?: TiddlyWebClient
  /** Id + display label of the resolved wiki. */
  id?: string
  label?: string
  /** Actionable sentence for the tool error when there is no client. */
  reason?: string
  /** More than one visible wiki ⇒ results must name the one they used. */
  ambiguous: boolean
}

export interface ToolsDeps {
  /**
   * The knowledge base a tool call acts on, resolved per SESSION (v0.28.0).
   *
   * `sessionId` is the calling session (`sessionIdOf(exec)`), or undefined in
   * headless tests. The host resolves it through the session's scope, filtered
   * by `agentVisible`, and returns a REASON instead of a client when it cannot
   * serve — the tool then fails loudly rather than writing to another wiki.
   */
  scope: (sessionId: string | undefined) => ToolScope
  git: GitFace
  wikiPath: () => string
  /** Debounced auto-commit touch (fires after our writes). */
  autoCommit: () => void
  /**
   * After a pull moved HEAD: restart the running wikis whose CONTENT changed and
   * report their ids (v0.28.0).
   *
   * `dir` is the folder the pull ran in (the repo is resolved from it) and
   * `changedFiles` are the repository-relative paths the pull touched. Several
   * wikis may share one repository, so "the pull changed something" is NOT the
   * same question as "this wiki needs a restart".
   */
  restartAffected?: (dir: string, changedFiles: readonly string[]) => Promise<{ restarted: string[]; failed: Array<{ id: string; message: string }> }>
  /**
   * Every registered knowledge base that COULD be git-synced (v0.30.5), with
   * its repository root and effective `git.remote`. Absent in headless contexts
   * → `git_sync` falls back to "no targets" and says so.
   */
  gitTargets?: () => Promise<GitSyncTarget[]>
  /**
   * Workspace (project) name for a session, resolved from its cwd (v0.24.0).
   * Absent in headless contexts → no automatic workspace marking.
   */
  workspaceName?: (sessionId: string) => string | undefined
  /** Whether automatic workspace marking is on (config `note.workspaceMark`). */
  workspaceMarkEnabled?: () => boolean
}
/**
 * What one moved tool factory needs from the registration pass (v0.28.8).
 *
 * `register` is the summary collector + scope-header wrapper owned by
 * `registerTiddlywikiTools()`, `deps` the host services, and `requireWiki` that
 * guard already bound to `deps` — so a moved body keeps calling
 * `requireWiki(sessionId)` exactly as it did when this was a local closure.
 */
export interface ToolEnv {
  register(tool: RegistrableTool): void
  deps: ToolsDeps
  requireWiki(sessionId?: string): TiddlyWebClient
}

// ── tool result shapes + renders ───────────────────────────────────────────

export interface SearchHit { title: string; tags: string[]; modified: string | null; snippet: string }
export interface SearchResult { query: string; tags: string[]; since: string | null; type: string | null; field: string | null; value: string | null; total: number; /** 自动缩范围用的工作区 id（v0.24.0）；null = 未启用/不可用。 */ workspace: string | null; /** 结果来自哪个范围。 */ scope: 'workspace' | 'all'; /** 工作区内 0 条、已扩大到全库（回执必须说出来）。 */ fellBack: boolean; results: SearchHit[] }
export interface RecentResult { since: string | null; results: SearchHit[] }
export interface TagListResult { count: number; total: number; truncated: boolean; tags: Array<{ tag: string; count: number }> }
export interface GetResult {
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
export interface PutResult { ok: boolean; title: string; tags: string[]; type: string | null; typeDefaulted?: boolean; /** 覆盖时内容类型真的变了（v0.20.1）。 */ typeChanged?: { from: string; to: string }; fields: Record<string, unknown> | null; /** 新建时自动打上的工作区标记（v0.24.0）。 */ workspace?: string }
export interface BatchItemResult { title: string; written: boolean; skipped: boolean; failed: boolean; error?: string; /** 该条是新建且自动打了工作区标记（v0.24.0）。 */ workspace?: string }
export interface BatchResult { ok: boolean; written: number; skipped: number; failed: number; items: BatchItemResult[] }
export interface RenameResult { ok: boolean; from: string; to: string; refsUpdated: number; refsTiddlers: number; /** 因遍历期间被改动而跳过的引用者数量（v0.25.0）。 */ refsSkipped?: number; skippedTitles?: string[]; warning?: string }
export interface DeleteResult { ok: boolean; title: string; /** true = moved to the trash (recoverable). */ trashed?: boolean; trashTitle?: string }
export interface TrashItem { title: string; at?: string; of?: string }
export interface TrashResult { action: string; message: string; items?: TrashItem[] }
export interface AppendResult { ok: boolean; title: string; mode: 'append' | 'prepend'; heading: string | null; /** v0.26.6：给了 heading 时该标题是否真的定位成功（false = 未找到，文本已追加到文末）。 */ headingMatched?: boolean; created: boolean; added: number; total: number; type?: string | null; typeDefaulted?: boolean; typeChanged?: { from: string; to: string }; /** 新建时自动打上的工作区标记（v0.24.0）。 */ workspace?: string }
export interface BacklinkHit { title: string; refs: number; via: 'link' | 'tag'; modified: string | null }
export interface BacklinkResult { title: string; total: number; linkCount: number; tagCount: number; items: BacklinkHit[] }
export interface AttachResult { ok: boolean; title: string; mime: string; bytes: number; chars: number; source: string | null; embedInto: string | null }
export interface LintIssue { kind: string; count: number; hint: string; samples: string[] }
export interface LintResult { scanned: number; /** 实际运行的检查（v0.25.0）。 */ checks: string[]; /** 请求里无法识别的检查名（回执必须报出来）。 */ unknownChecks: string[]; issues: LintIssue[] }
/**
 * How one REPOSITORY's sync went (v0.30.5).
 *
 * The receipt is per repository, not per wiki: `git` can only ever pull/commit/
 * push once per work tree, so "which wiki did this?" is answered by the `wikis`
 * list instead of by running the same command N times.
 */
export interface SyncRepoResult {
  /** Repository root, or the wiki folder when git could not resolve one. */
  root: string
  /** Display labels of the knowledge bases living in this repository. */
  wikis: string[]
  /** Their ids — what `tiddlywiki_git_resolve wiki=<id>` takes. */
  wikiIds: string[]
  ok: boolean
  message: string
  changed?: boolean
  commit?: string
  push?: string
  conflictFiles?: string[]
  restarted?: string[]
  restartFailed?: Array<{ id: string; message: string }>
  drainFailed?: boolean
  status?: GitStatusView
}

export interface SyncResult {
  action: string
  ok: boolean
  message: string
  conflictFiles?: string[]
  pull?: string
  commit?: string
  push?: string
  changed?: boolean
  /** Ids of the knowledge bases whose TW child was restarted after the pull. */
  restarted?: string[]
  /** Wikis that could not be restarted (the pull itself still succeeded). */
  restartFailed?: Array<{ id: string; message: string }>
  /**
   * The pre-restart drain did NOT prove the syncer queue empty (v0.29.0).
   * Surfaced instead of swallowed: `flushPendingWrites` never rejects — it
   * resolves `false` on timeout — so the old `.catch(() => undefined)` was both
   * dead code and a way to restart on an unproven drain with no trace. The
   * best-effort policy stays (a wedged TW must still be restartable, exactly
   * like `drainThenStop`), but the model must be able to see it and tell the
   * user to verify the note landed.
   */
  drainFailed?: boolean
  status?: GitStatusView
  /**
   * Repositories that were NOT synced, with the reason (v0.30.5). Never
   * silently ignored: "sync said OK" must not be readable as "we synced
   * everything" when some wiki simply has no `git.remote`.
   */
  skipped?: string[]
  /** One entry per repository that actually ran (in deterministic order). */
  repos?: SyncRepoResult[]
  /** Ids of the knowledge bases whose TW child was restarted after the pull. */
  // NOTE: the flat fields above are the SINGLE-repo aliases kept for
  // compatibility (a one-wiki install sees the pre-v0.30.5 shape). With several
  // repositories, read `repos[]` — the aliases then describe the FIRST repo only.
}
export interface ResolveResult {
  ok: boolean
  action: string
  message: string
  /** Repository the resolve acted on (v0.30.5), when known. */
  repo?: string
  /** Labels of the knowledge bases sharing that repository. */
  wikis?: string[]
  files?: string[]
  commit?: string
  hint?: string
  status?: GitStatusView
}

/**
 * Session id of the caller, when the runtime supplies one.
 *
 * `ToolRunContext.agent.id` is the calling session (verified against the host
 * SDK's `ToolExecutionInput.agent`), which is what lets the plugin resolve
 * "which project is this note from?" all by itself (v0.24.0).
 */
export function sessionIdOf(exec: unknown): string | undefined {
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
export function workspaceMarkFor(deps: ToolsDeps, exec: unknown): { id: string; tag: string } | undefined {
  if (deps.workspaceName === undefined) return undefined
  if (deps.workspaceMarkEnabled?.() === false) return undefined
  const sessionId = sessionIdOf(exec)
  if (sessionId === undefined) return undefined
  return workspaceMarkFromCwd(deps.workspaceName(sessionId))
}

/**
 * 工具参数的 `fields` 归一化（v0.26.5，见 `normalizeFieldsArg`）。
 *
 * 历史：`fields` 的参数 schema 曾是 `{ type: 'json' }`——编译后是**纯注解**，
 * 模型收不到「这是个对象」的信息，于是把 JSON 当字符串发来，被
 * `withWorkspaceMark` 的 `{ ...fields }` 拆成单字符字段。schema 已改成 object；
 * 这里再兜一层，字符串能解析成对象就直接用，不必让模型重发一次。
 * 解析不出对象 → 抛错（绝不静默丢字段，也不按字符展开）。
 */
export function normalizeFieldsInArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (!('fields' in args)) return args
  return { ...args, fields: normalizeFieldsArg(args.fields) }
}

/** batch_put 专用：逐条目归一化 `fields`（非对象条目原样留给逐条校验报错）。 */
export function normalizeBatchItemsFields(items: unknown): unknown {
  if (!Array.isArray(items)) return items
  return items.map((item) => (item !== null && typeof item === 'object' && !Array.isArray(item))
    ? normalizeFieldsInArgs(item as Record<string, unknown>)
    : item)
}

/**
 * Merge the workspace marker into a NEW note's explicit tags and fields.
 *
 * ADDITIVE, never replacing: the caller's tags are kept in front and the caller's
 * own `workspace` field (if it set one) wins, so an explicit value is never
 * silently overwritten. Returns the inputs untouched when there is no marker.
 *
 * ⚠️ `fields` 必须已经过 `normalizeFieldsArg()`（v0.26.5）：下面这行 `{ ...fields }`
 * 对字符串会按字符展开成 `{0:'{',1:'"',…}`——那正是 fields bug 的现场。
 */
export function withWorkspaceMark(
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
export function snippetAround(text: string, query: string, max = 160): string {
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

export interface TrashIndexEntry { trash: string; of: string; at: string }

/** Build the trash title that holds one soft-deleted tiddler. */
export function trashTitleFor(title: string, at = new Date()): string {
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
export async function readTrashIndex(wiki: TiddlyWebClient): Promise<{ readOk: boolean; corrupted: boolean; entries: TrashIndexEntry[] }> {
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
export async function writeTrashIndex(wiki: TiddlyWebClient, entries: TrashIndexEntry[]): Promise<void> {
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

/** Size cap for one attachment (mirrors the clip bridge's image cap). */
export const MAX_ATTACH_BYTES = 15 * 1024 * 1024

/**
 * Count references to `target` inside wiki text: `[[target]]`,
 * `[[display|target]]`, `[[target|display]]` is NOT a reference to target as a
 * link target in TW (the first part is the text, the second the target), so
 * only the second position counts, plus `{{target}}` transclusions.
 */
export function countRefsTo(text: string, target: string): number {
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
export const LINT_CHECKS = ['junk-tags', 'broken-links', 'empty-notes', 'missing-type', 'stale'] as const

/**
 * Expiry instant for the time-boxed fields `valid-until` / `review-after`.
 *
 * A bare `YYYY-MM-DD` means「当天整天有效」to a human, but `parseTiddlerDate`
 * resolves it to UTC midnight — in UTC+8 that flags the note expired at 08:00 of
 * that same day. Local end-of-day matches the documented wording; anything else
 * (ISO timestamps, TW compact dates) keeps the shared parser's behaviour.
 */
export function expiryOf(value: unknown): number | undefined {
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
export function pickFields(t: Tiddler): Record<string, unknown> {
  const out = flattenTiddlerFields(t)
  if (t.revision !== undefined) out.revision = t.revision
  return out
}

/**
 * 覆盖写入前后内容类型的差异（v0.20.1）。内容类型决定 TW 用哪个 parser，静默变化
 * 会让 CSS 被当 Markdown、Markdown 笔记被当 wikitext，所以覆盖路径必须把这个差异
 * 回执给模型。只有两边都拿得到 `type` 且不同才报告（新建 → 无 from）。
 */
export function typeChangeOf(existing: Tiddler | undefined, next: Tiddler): { typeChanged?: { from: string; to: string } } {
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
export function rewriteRefs(text: string, oldTitle: string, newTitle: string): { text: string; count: number } {
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
 * Insert `addition` into the section introduced by `heading` (Markdown `#`/`##`…
 * or wikitext `!`/`!!`…). Used by tiddlywiki_append so an agent can add to one
 * section of a long note without rewriting the whole file.
 *
 * **落点语义**：插在「该标题之后、**下一个任意级别的标题**之前」。所以当标题后面
 * 紧跟子标题时（`## 4. 定时任务` + `### 槽位表`），内容落在两者**之间**，也就是
 * 「章节开头」而不是「整节末尾」——这一点以前只在 schema 里写成「段落的末尾」，
 * 容易让调用方误会（v0.26.6 起描述与回执都写清楚了）。
 *
 * **返回 `matched`**：`false` = 没找到该标题，文本被追加到**文末**。调用方**必须**
 * 把它透出去（v0.26.6 之前这个回退是静默的，回执照样打「段落「X」」，
 * 于是一次定位失败看起来像成功——Agent 没有任何办法自检）。
 *
 * **CRLF（v0.26.6 修复）**：tiddler 正文可能是 CRLF（Windows 上写的/同步来的笔记），
 * 而 `split('\n')` 会让每行结尾都留着 `\r`。JS 里 `(.*)` 不匹配 `\r`、`$` 也不匹配
 * `\r` 之前的位置，于是 `/^#{1,6}\s+(.*)$/` 对**每一个**标题都匹配失败 ⇒ 所有带
 * `heading` 的 append 都静默落到了文末。**只在 CRLF 笔记上复现**（纯 LF 笔记一切正常），
 * 这就是它像「偶发」的原因。现在只在**匹配时**剥掉行尾 CR，原文行尾一个字节都不动；
 * 并且新块用**文档自己的行尾**写入，避免 CRLF 笔记被越写越乱（混入 LF 块）。
 */
export function insertIntoSection(base: string, heading: string, addition: string): { text: string; matched: boolean } {
  const lines = base.split('\n')
  const headingText = (line: string): string | null => {
    // 只在匹配时剥离行尾 CR：CRLF 笔记的每一行都会带上它。
    const s = line.replace(/\r$/, '')
    const md = /^#{1,6}\s+(.*)$/.exec(s)
    if (md !== null) return (md[1] ?? '').trim()
    const tw = /^!{1,6}\s*(.*)$/.exec(s)
    if (tw !== null) return (tw[1] ?? '').trim()
    return null
  }
  const start = lines.findIndex((line) => headingText(line) === heading)
  // 新块跟随文档主流行尾：CRLF 文档里不要再塞 LF 块。
  const eol = base.includes('\r\n') ? '\r\n' : '\n'
  const adapt = (s: string): string => (eol === '\n' ? s.replace(/\r\n/g, '\n') : s.replace(/\r\n/g, '\n').split('\n').join('\r\n'))
  const block = adapt(addition)
  if (start < 0) {
    return {
      text: base.trim().length === 0 ? block : `${base.replace(/\s+$/, '')}${eol}${eol}${block}`,
      matched: false,
    }
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
  const head = `${before}${eol}${eol}${block}`
  return {
    text: after.trim().length === 0 ? head : `${head}${eol}${eol}${after.replace(/^\s+/, '')}`,
    matched: true,
  }
}

/** Every read/write tool needs a live TW client — shared guard for the 8
 *  wiki-facing tools (git tools operate on the repo path instead). */
export function requireWiki(deps: ToolsDeps, sessionId?: string): TiddlyWebClient {
  const scope = deps.scope(sessionId)
  if (scope.client === undefined) throw new Error(scope.reason ?? 'TiddlyWiki 服务未运行（tiddlywiki_status 可查）')
  return scope.client
}

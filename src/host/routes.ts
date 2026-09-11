/**
 * DSH webserver routes for dsh-tiddlywiki (design doc §10).
 *
 * | route                     | method | purpose                                  |
 * |---------------------------|--------|------------------------------------------|
 * | /dsh-tiddlywiki/status    | GET    | panel health (service / url / git / tag) |
 * | /dsh-tiddlywiki/note      | POST   | quick-note → independent tiddler         |
 * | /dsh-tiddlywiki/restart   | POST   | one-click retry/restart of the TW child  |
 * | /dsh-tiddlywiki/search    | GET    | keyword search (reply-stream tool card)  |
 * | /dsh-tiddlywiki/api/*     | any    | passthrough to the TW service (JSON)     |
 * | /dsh-tiddlywiki/tw/*      | any    | SAME-ORIGIN TW proxy (index + files + TiddlyWeb API) |
 *
 * Matching is exact-over-prefix, so the exact routes win and the `/api` /
 * `/tw` prefixes catch the rest. Client calls are same-origin (the DSH web
 * server), so no CORS is involved. The `/tw` proxy is the remote-access
 * bridge: it serves the ENTIRE TW frontend to the browser through the DSH
 * origin (see TW_PROXY_PATH in wiki.ts), so the embedded editor works no
 * matter which host/domain the user reaches DSH on.
 *
 * @module dsh-tiddlywiki/host/routes
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { Readable } from 'node:stream'
import type { TiddlyWebClient } from './tw-api.ts'
import { isBinaryType, toIsoDateString } from './tw-api.ts'
import type { WikiServer } from './wiki.ts'
import type { GitFace } from './git.ts'
import { PATH_PREFIX, TW_PROXY_PREFIX, TW_PROXY_PATH } from './wiki.ts'
import { writeSessionSummary, type SessionQueryFace } from './session-summary.ts'
import { readBody, readBodyBuffer, json, guardHandler, errorStatus, rejectCrossSiteWrite, rejectNonRead, MAX_PROXY_BODY_BYTES, MAX_UPLOAD_BYTES } from './http.ts'
import { sanitizeTwFragment } from './sanitize.ts'
import { flushPendingWrites } from './seeds.ts'
import { WriteConflictError, assertNoConflict, buildWriteTiddler, flattenTiddlerFields } from './write-policy.ts'

export { writeSessionSummary, SESSION_SUMMARY_PREFIX } from './session-summary.ts'
export type { SessionQueryFace, SessionSummaryResult } from './session-summary.ts'

export const ROUTE_PREFIX = PATH_PREFIX

/** Tiddler type for quick-notes: Markdown, so the uploaded images/links and
 *  any Markdown in the note actually render in TW (a type-less tiddler is
 *  treated as plain wiki text and shows raw `![..]`/`[..]` instead). */
const NOTE_TYPE = 'text/markdown'

/** Structural webserver face (a subset of dsh-host-webserver). */
export interface WebServerFace {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
}

/**
 * Structural face over the DSH `sessionController` service (a subset of
 * dsh-api-session-controller). Only the methods the agent-send routes need are
 * declared; the runtime instance is a real Service, never inspected data.
 */
export interface SessionControllerFace {
  prompt(
    request: { requestId: string; sessionId: string; mode: 'queue' | 'steer'; content: Array<{ type: 'text'; text: string }> },
    signal: AbortSignal,
  ): Promise<{ accepted: boolean }>
  list(
    request: { cursor?: string },
    signal: AbortSignal,
  ): Promise<{
    items: Array<{
      sessionId: string
      updatedAt?: number
      running?: boolean
      blank?: boolean
      parentSessionId?: string
      cwd?: string
    }>
  }>
  create(request: { cwd?: string; workspaceId?: string; agentPreset?: string }): Promise<{ sessionId: string }>
}

/**
 * Structural face over the DSH `workspaceRegistry` service (a subset of
 * dsh-workspace). Only what the agent-create route needs is declared; the
 * runtime instance is a real Service, never inspected data.
 */
export interface WorkspaceRegistryFace {
  /** Resolve or create the workspace owning `path` — idempotent by canonical path. */
  create(path: string, title?: string): Promise<{ id: string; path: string }>
}

/**
 * Structural face over the DSH `agentPresets` service (a subset of
 * dsh-agent-presets). It is the deployment's "工作模式" registry — the agent
 * presets a session can be composed from (default / cordis / blade / …). Only
 * `list` + `resolve` (default id) are needed by the agent-modes route.
 */
export interface AgentPresetsFace {
  /** Every preset the configured roots currently supply. */
  list(): Promise<Array<{ id: string; name?: string; description?: string; trust?: string; broken?: string }>>
  /** Resolve one preset by id (`undefined` = the deployment default). */
  resolve(id?: string): Promise<{ id: string; name?: string; description?: string }>
}

/**
 * Structural face over the DSH `sessionPersistence` service. Only the
 * lightweight `list` (metadata headers, no log parse) is needed so the
 * agent-sessions route can attach each session's recorded `agentPreset`.
 */
export interface SessionPersistenceFace {
  /** One header per materialized session (carries `agentPreset` when set). */
  list(signal?: AbortSignal): Promise<Array<{ id: string; agentPreset?: string }>>
}

/**
 * Structural face over the DSH `permissionPresets` service (a subset of
 * dsh-permission-presets). It owns the deployment's permission presets — each
 * bundles a sandbox mode + approval policy (e.g. `workspace-write` = write
 * inside the workspace with approval, `danger-full-access` = no prompts). The
 * agent-modes route exposes the option list to the TW picker, and agent-create
 * applies the chosen preset to the new session's log via `set`.
 */
export interface PermissionPresetsFace {
  /** Every switchable preset name, in declaration order. */
  readonly names: readonly string[]
  /** The preset currently selected as the default for new sessions. */
  readonly defaultPreset: string
  /** Build the client option ({ value, name, description? }) for one preset. */
  optionOf(name: string): { value: string; name: string; description?: string }
  /** Record a preset switch on a live session (durable, log-only user intent). */
  set(session: unknown, name: string): void
}

/**
 * Structural face over the DSH `sessions` in-memory store (a subset of
 * dsh-session). Only `get` is needed: after `sessionController.create`
 * resolves, the new session is already materialized here, so agent-create can
 * hand it to `permissionPresets.set`.
 */
export interface SessionsFace {
  get(id: string): unknown
}

/** Effective UI flags returned by /status (mirror index.ts). */
export interface UiDefaultsPublic {
  showQuickNote: boolean
  /** 聊天输入框上方的「快速笔记」快捷按钮（conversation.input.dock 槽位）。 */
  showQuickNoteDock: boolean
  /** 点击「快速笔记」后的打开方式：native=直达 TW 原生编辑器；card=Markdown 卡片。 */
  quickNoteMode: 'native' | 'card'
  /** 左侧侧边栏 TW 入口的显示名称。 */
  sidebarLabel: string
  showPanelStatus: boolean
  showSyncButton: boolean
  /** 嵌入式 TW 是否跟随 DSH 深浅主题（false 时客户端停止 palette 同步）。 */
  followDshTheme: boolean
  /** DSH 暗色时 TW 使用的 palette tiddler 标题。 */
  darkPalette: string
  /** 会话顶部「知识库」Tab 的显示名称（默认「知识库」）。 */
  tabLabel: string
  /** 是否在会话顶部显示「知识库」Tab（会话相关 wiki 汇总，默认 true）。 */
  showSessionTab: boolean
  /** 是否在 DSH 右侧边栏提供 TiddlyWiki 入口/Tab（默认 true）。 */
  showRightbarTab: boolean
}

export interface RouteDeps {
  server: WikiServer
  getClient: () => TiddlyWebClient | undefined
  git: GitFace
  autoCommit: () => void
  noteDefaults: () => { tag: string }
  uiDefaults: () => UiDefaultsPublic
  getWikiPath: () => string
  /** Optional DSH sessionController service (agent-send routes only); resolved
   *  lazily per request because it may register after webServer appears. */
  getSessionController: () => SessionControllerFace | undefined
  /** Optional DSH workspaceRegistry service (agent-create route); resolves a
   *  cwd to a real Workspace so new sessions land inside it instead of the
   *  ungrouped bucket. */
  getWorkspaceRegistry: () => WorkspaceRegistryFace | undefined
  /** Optional DSH agentPresets service (agent-modes route): the deployment's
   *  "工作模式" roster. Resolved lazily per request like sessionController. */
  getAgentPresets: () => AgentPresetsFace | undefined
  /** Optional DSH sessionPersistence service (agent-sessions route): attaches
   *  each session's recorded agentPreset so the picker can badge it. */
  getSessionPersistence: () => SessionPersistenceFace | undefined
  /** Optional DSH permissionPresets service (agent-modes permissions list +
   *  agent-create applies the chosen permission preset to the new session). */
  getPermissionPresets: () => PermissionPresetsFace | undefined
  /** Optional DSH `sessions` in-memory store (agent-create hands the created
   *  live session to permissionPresets.set). */
  getSessions: () => SessionsFace | undefined
  /** Optional DSH sessionQuery service (session-summary route): reads a
   *  session's complete event log + descendant tree to decide which wiki notes
   *  belong to this conversation. Resolved lazily like the other services. */
  getSessionQuery: () => SessionQueryFace | undefined
  /** Whether the one-click send-to-agent feature is enabled (config switch). */
  sendToAgentEnabled: () => boolean
  /** Optional shared token that must match `x-send-to-agent-token` when set. */
  sendToAgentToken: () => string
}

/** Header names forwarded to the upstream TW service by the proxy routes. */
const FORWARD_HEADER_NAMES = [
  'accept', 'accept-encoding', 'content-type', 'cookie', 'authorization',
  'if-none-match', 'if-modified-since', 'origin', 'referer', 'user-agent',
] as const

/** Copy a safe, string-valued subset of the request headers upstream. */
function forwardHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of FORWARD_HEADER_NAMES) {
    // Index through the string index signature so known header names (typed
    // `string`) do not hide the `string[]` repeat case via their specific
    // property declarations.
    const value: string | string[] | undefined = headers[name as string]
    if (typeof value === 'string') out[name] = value
    else if (Array.isArray(value) && value.length > 0) out[name] = value.join(', ')
  }
  return out
}

/**
 * Extensions that the browser would execute ON THE DSH ORIGIN: `/upload`
 * writes into `wiki/files/`, which TW's core server serves back through the
 * same-origin `/tw` proxy with an extension-derived Content-Type. An uploaded
 * `.html`/`.svg` would therefore be same-origin script (able to read
 * `/admin/state` and write the wiki), i.e. self-XSS with a persistence layer.
 * Documents/images/archives stay allowed; only the executable-by-browser set is
 * refused (v0.19.0).
 */
const DANGEROUS_UPLOAD_EXTENSIONS = new Set([
  '.html', '.htm', '.xhtml', '.shtml', '.hta', '.svg', '.xml', '.xsl', '.xslt',
  '.js', '.mjs', '.cjs', '.swf', '.htc',
])

/** Windows device names: `NUL.txt` cannot be created and makes the route 500. */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * Sanitize an uploaded filename into a safe bare name (no path separators,
 * no `..`, no control characters). Returns '' when nothing usable remains.
 */
function sanitizeUploadName(input: unknown): string {
  if (typeof input !== 'string') return ''
  let name = basename(input.trim().replace(/[\\/]+/g, '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  if (name.length === 0 || name === '.' || name === '..') return ''
  // Windows stores a trailing dot/space verbatim but never strips it, and
  // `extname('evil.html.')` is just `.` — so the extension denylist was
  // bypassable with `evil.html.` (v0.19.3). Canonicalize before the check.
  name = name.replace(/[. ]+$/, '')
  if (name.length === 0) return ''
  // `CON`, `NUL`, `COM1…` are not creatable on Windows — prefix instead of 500.
  if (WINDOWS_RESERVED_NAMES.test(name)) name = `_${name}`
  if (name.length > 160) name = name.slice(0, 160)
  return name
}

/**
 * Strip credentials embedded in a git remote URL (`https://user:token@host/x`)
 * before it reaches an unauthenticated HTTP response (v0.19.0). The token in a
 * remote URL is a real secret and `/status` is reachable without credentials.
 */
export function redactRemoteUrl(remote: string): string {
  return remote.replace(/\/\/[^/@\s]+@/g, '//***@')
}

/**
 * Redact secrets that can appear in the TW child's captured stdout/stderr log
 * (the spawn line carries `password=…`). Belt-and-braces on top of the
 * redaction in wiki.ts, because `/status` is unauthenticated.
 */
export function redactLogLines(logs: readonly string[]): string[] {
  return logs.map((line) => line
    .replace(/(password=)\S+/gi, '$1***')
    .replace(/(authorization:\s*basic\s+)[A-Za-z0-9+/=]+/gi, '$1***'))
}

/**
 * Constant-time string comparison: both sides are hashed first, so neither the
 * content nor the LENGTH of the expected token leaks through timing.
 */
function safeTokenEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Flat one-line snippet for the recent-notes picker. */
function snippetOf(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/** Max `limit` accepted by the list routes (bounded payloads, v0.19.4). */
const MAX_LIST_LIMIT = 200

/** Max `limit` accepted by `/tags` — the tag list is a small wrapper around one
 *  full listing, so a larger cap is fine while still bounding the payload. */
const MAX_TAGS_LIMIT = 500

/** Clamp a `limit` query param. `fallback` covers absent/unparsable values. */
function readLimit(url: URL, fallback: number, max = MAX_LIST_LIMIT): number {
  const raw = Number(url.searchParams.get('limit') ?? fallback)
  return Number.isFinite(raw) ? Math.max(1, Math.min(Math.floor(raw), max)) : fallback
}

/** Optional `limit` query param: `undefined` when absent/unparsable (= no cap). */
function readOptionalLimit(url: URL, max: number): number | undefined {
  const raw = url.searchParams.get('limit')
  if (raw === null || raw.trim().length === 0) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return undefined
  return Math.max(1, Math.min(Math.floor(parsed), max))
}

/** Default note title: `YYYY-MM-DD HH:mm` (design doc D6). */
function timestampTitle(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Open a tiddler in TW's NATIVE editor: save the tiddler (when text is
 * non-empty) as Markdown, reuse or create a DRAFT tiddler carrying
 * `draft.of`/`draft.title` (TW's story view renders drafts with the
 * EditTemplate — list.js: `isDraft && editTemplate`), and return the draft
 * title so the client can navigate the panel iframe to `#<draftTitle>`.
 * The draft carries the same `text/markdown` type as the note so saving it in
 * TW keeps Markdown (a draft without a matching type would overwrite the
 * note's type back to plain wiki text).
 */
export async function openInTwEditor(
  client: TiddlyWebClient,
  title: string,
  text: string,
  tags: string[] | undefined,
  options: { defaultTags?: string[]; expectedModified?: string; expectedRevision?: string | number; force?: boolean } = {},
): Promise<{ title: string; draftTitle: string }> {
  // One read drives everything: the write base (tags/custom fields/type), the
  // conflict check, and — when the body carried no text — the draft content.
  const existing = await client.get(title)
  assertNoConflict(title, existing, options)
  if (text.trim().length > 0) {
    // PRESERVE, do not blind-replace (v0.19.1): the old code PUT
    // `{title, text, tags, type}` with no read, wiping the note's custom fields
    // and (because `tags` defaulted to the note tag) its tags too.
    const { tiddler } = buildWriteTiddler(title, text, {
      existing,
      tags,
      defaultTags: options.defaultTags,
      agentTag: false,
    })
    await client.put(tiddler)
  }
  // Draft content: the provided text, else the existing tiddler's content.
  const draftText = text.trim().length > 0 ? text : (existing?.text ?? '')
  // Draft TYPE (v0.19.5): must match the note's real content type. Hardcoding
  // `text/markdown` meant that editing a wikitext note through the quick-note
  // surface downgraded it — TW's save copies the draft's fields back onto the
  // original, so `fields.type` flipped to markdown and the body started
  // rendering as source (`!` headings, `<$list>`, `[[links]]` all broke).
  const draftType = typeof existing?.type === 'string' && existing.type.length > 0 ? existing.type : NOTE_TYPE
  // Draft lookup. The canonical TW name is probed with a single GET first — the
  // old code always pulled the ENTIRE listing (megabytes on a big wiki) just to
  // find a draft; the listing stays as the fallback for a differently-named one.
  const canonical = `Draft of "${title}"`
  let draftTitle: string | undefined
  let canonicalProbe: boolean | undefined
  try {
    canonicalProbe = (await client.get(canonical)) === undefined
  } catch {
    canonicalProbe = undefined
  }
  if (canonicalProbe === false) {
    // The canonical name is free → use it (TW's own "save draft" bookkeeping
    // lines up). Only a TAKEN canonical name needs the listing scan.
    draftTitle = canonical
  } else if (canonicalProbe === true) {
    try {
      const items = await client.list(undefined, false)
      for (const item of items) {
        if (item['draft.of'] === title && typeof item.title === 'string') {
          draftTitle = item.title
          break
        }
      }
    } catch {
      /* fall back to a fresh draft */
    }
    // Prefer TW's CANONICAL draft name so the embedded editor's own "save
    // draft" bookkeeping lines up; fall back to a timestamped name when it is
    // taken (or the probe failed) so an existing draft is never clobbered.
    if (draftTitle === undefined) draftTitle = canonical
    else if (draftTitle !== canonical) draftTitle = `${canonical} ${Date.now()}`
  } else {
    draftTitle = `${canonical} ${Date.now()}`
  }
  await client.put({ title: draftTitle, text: draftText, 'draft.of': title, 'draft.title': title, type: draftType })
  return { title, draftTitle }
}

/**
 * Resolve note tags from the request body: `tags` array wins, then the legacy
 * single `tag` string. Returns **undefined** when the body asks for nothing —
 * the caller (`buildWriteTiddler`) then preserves the existing note's tags
 * (v0.19.1 data safety) or falls back to the configured default for new notes.
 * The old version always returned `[defaultTag]`, so re-saving an existing note
 * under its own title silently replaced its tags with the default.
 */
function resolveTags(body: { tag?: unknown; tags?: unknown }): string[] | undefined {
  if (Array.isArray(body.tags)) {
    const tags = body.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim())
    if (tags.length > 0) return tags
  }
  if (typeof body.tag === 'string' && body.tag.trim().length > 0) {
    return body.tag.trim().split(/\s+/).filter(Boolean)
  }
  return undefined
}

/** Body fields accepted by the note routes for optimistic concurrency. */
function conflictTokens(body: { expectedModified?: unknown; expectedRevision?: unknown; force?: unknown }): {
  expectedModified?: string
  expectedRevision?: string | number
  force?: boolean
} {
  return {
    ...(typeof body.expectedModified === 'string' && body.expectedModified.length > 0 ? { expectedModified: body.expectedModified } : {}),
    ...(typeof body.expectedRevision === 'string' || typeof body.expectedRevision === 'number'
      ? { expectedRevision: body.expectedRevision }
      : {}),
    ...(body.force === true ? { force: true } : {}),
  }
}

export function registerRoutes(ctx: { webServer: WebServerFace }, deps: RouteDeps): () => void {
  /**
   * `/status` is polled by the GUI (30s), every mounted TW frame and the FAB,
   * and each call shells out to up to five `git` processes — so the git summary
   * is cached for a couple of seconds. Any route that mutates the repo
   * invalidates it so a sync/upload is reflected immediately.
   */
  const GIT_STATUS_TTL_MS = 2_000
  /** Cached git-status PROMISE (not value): a burst of concurrent /status polls
   *  then shares ONE probe instead of each spawning up to five git processes
   *  (v0.19.0 — value-caching still let every concurrent miss run its own). */
  let gitStatusCache: { at: number; value: Promise<GitStatusViewPublic | null> } | undefined
  const invalidateGitStatus = (): void => { gitStatusCache = undefined }
  const cachedGitStatus = (): Promise<GitStatusViewPublic | null> => {
    if (gitStatusCache !== undefined && Date.now() - gitStatusCache.at < GIT_STATUS_TTL_MS) return gitStatusCache.value
    const pending = (async (): Promise<GitStatusViewPublic | null> => {
      try {
        const view = await deps.git.status(deps.getWikiPath())
        // The remote URL can carry a PAT (`https://user:token@…`) and /status is
        // unauthenticated — never hand the credential to the browser.
        return { ...view, remote: redactRemoteUrl(typeof view.remote === 'string' ? view.remote : '') }
      } catch {
        return null
      }
    })()
    gitStatusCache = { at: Date.now(), value: pending }
    return pending
  }

  /**
   * Serialize the heavyweight mutating routes (restart / sync). A burst of
   * concurrent calls used to stack pull/restart operations on top of each
   * other (and a restart racing a restart is what left orphan TW children).
   * A second concurrent caller gets 429 instead of piling on (v0.19.0).
   */
  let mutationInFlight: string | undefined
  const beginMutation = (label: string): boolean => {
    if (mutationInFlight !== undefined) return false
    mutationInFlight = label
    return true
  }
  const endMutation = (): void => { mutationInFlight = undefined }

  const handleStatus = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (rejectNonRead(req, res)) return
    const view = deps.server.status()
    const gitSummary = await cachedGitStatus()
    json(res, {
      ok: true,
      ...view,
      // Child-process logs are served to an unauthenticated caller: never leak
      // the spawn line's `password=…` (or a forwarded Authorization header).
      logs: redactLogLines(view.logs),
      twProxy: TW_PROXY_PATH,
      git: gitSummary,
      note: { tag: deps.noteDefaults().tag },
      ui: deps.uiDefaults(),
    })
  }

  /**
   * POST /dsh-tiddlywiki/session/summary — 生成当前会话的 wiki 汇总页（「知识库」
   * Tab 的后端）。body `{ session: <会话ID> }`；后端用 sessionQuery 读本会话（含
   * 后代 subagent）的完整事件日志，按「产生/读取/检索」收集 tiddlywiki_* 笔记，
   * 查询每篇当前状态，组装 TW wikitext 写入 `$:/temp/dsh/session-summary/<会话ID>`
   * （volatile：不落盘、不进 git），返回生成的 tiddler title 供前端 iframe 打开。
   */
  const handleSessionSummary = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      let body: { session?: unknown } = {}
      try {
        body = JSON.parse(await readBody(req)) as { session?: unknown }
      } catch {
        /* malformed body → session check below rejects */
      }
      const session = typeof body.session === 'string' && body.session.trim().length > 0 ? body.session.trim() : ''
      if (session.length === 0) {
        json(res, { ok: false, error: 'session is required' }, 400)
        return
      }
      // The id becomes part of a tiddler title (`$:/temp/dsh/session-summary/<id>`)
      // and is echoed into the summary wikitext — keep it to a safe charset
      // instead of trusting the request body (v0.19.3).
      if (!/^[A-Za-z0-9._:-]{1,120}$/.test(session)) {
        json(res, { ok: false, error: 'session id has an unsupported format' }, 400)
        return
      }
      const client = deps.getClient()
      if (client === undefined) {
        json(res, { ok: false, error: 'wiki service is not running' }, 503)
        return
      }
      const sq = deps.getSessionQuery()
      if (sq === undefined) {
        json(res, { ok: false, error: 'session query service unavailable' }, 503)
        return
      }
      const result = await writeSessionSummary(client, sq, session)
      json(res, { ok: true, ...result, twUrl: TW_PROXY_PATH })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  /**
   * GET /dsh-tiddlywiki/agent/sessions — visible ordinary sessions for the TW
   * one-click picker (excludes subagent sessions, activity-descending). Each
   * item also carries its recorded `agentPreset` (工作模式), when known, so the
   * picker can badge existing sessions — read from the lightweight persistence
   * header list, never a full log parse.
   */
  const handleAgentSessions = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectNonRead(req, res)) return
      // Same guard as the sibling /agent/* routes: a deployment that protects
      // send-to-agent with a token must not leak the session roster to an
      // unauthenticated caller (v0.19.0 — this route used to be the odd one out).
      if (!guardSendToAgent(req, res)) return
      const sc = deps.getSessionController()
      if (sc === undefined) {
        json(res, { ok: false, error: 'session service unavailable' }, 503)
        return
      }
      const list = await sc.list({}, AbortSignal.timeout(10_000))
      // sessionId → agentPreset, from the durable header list (degrade silently).
      const presetById: Record<string, string> = {}
      const pers = deps.getSessionPersistence()
      if (pers !== undefined) {
        try {
          const headers = await pers.list(AbortSignal.timeout(5_000))
          for (const h of headers) {
            if (typeof h.agentPreset === 'string' && h.agentPreset.length > 0) presetById[h.id] = h.agentPreset
          }
        } catch {
          /* header list unavailable → no mode badges, picker still works */
        }
      }
      const items = (list.items ?? [])
        .filter((s) => s.parentSessionId === undefined)
        .map((s) => ({
          sessionId: s.sessionId,
          cwd: s.cwd ?? null,
          running: !!s.running,
          blank: !!s.blank,
          updatedAt: s.updatedAt ?? 0,
          agentPreset: presetById[s.sessionId] ?? null,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
      json(res, { ok: true, items })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  /**
   * Shared gate for the TW-side send-to-agent routes: feature switch
   * (`ui.sendToAgent.enabled`) then, when a shared token is configured, the
   * `x-send-to-agent-token` header must match. Returns false after writing the
   * error response — the caller just does `if (!guard(...)) return`.
   */
  const guardSendToAgent = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!deps.sendToAgentEnabled()) {
      json(res, { ok: false, error: 'send-to-agent is disabled' }, 403)
      return false
    }
    const token = deps.sendToAgentToken().trim()
    if (token.length === 0) return true
    const got = req.headers['x-send-to-agent-token']
    const value = typeof got === 'string' ? got : Array.isArray(got) ? got[0] ?? '' : ''
    // Constant-time comparison (hash-then-compare): `===` leaks the token's
    // length and matched-prefix timing to a caller who can probe the route.
    if (safeTokenEqual(value, token)) return true
    json(res, { ok: false, error: 'unauthorized' }, 401)
    return false
  }

  /**
   * GET /dsh-tiddlywiki/agent/modes — available "工作模式" (Agent presets) for
   * the TW picker: id/name/description per preset plus the deployment default.
   * Guards mirror the other agent routes (feature switch + optional token).
   */
  const handleAgentModes = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectNonRead(req, res)) return
      if (!guardSendToAgent(req, res)) return
      const ap = deps.getAgentPresets()
      if (ap === undefined) {
        json(res, { ok: false, error: 'agent presets service unavailable' }, 503)
        return
      }
      const presets = await ap.list()
      let defaultId: string | undefined
      try {
        defaultId = (await ap.resolve())?.id
      } catch {
        defaultId = undefined
      }
      // The picker also needs the permission-preset roster (a "权限" selector
      // for newly created sessions). Best-effort: when the permissionPresets
      // service is not mounted (older host), `permissions` is null and the
      // picker simply hides the selector — modes still work.
      let permissions: { defaultId: string | null; items: Array<{ value: string; name: string; description?: string }> } | null = null
      const pp = deps.getPermissionPresets()
      if (pp !== undefined) {
        try {
          permissions = {
            defaultId: pp.defaultPreset ?? null,
            items: pp.names.map((n) => pp.optionOf(n)),
          }
        } catch {
          permissions = null
        }
      }
      json(res, {
        ok: true,
        defaultId: defaultId ?? null,
        items: presets.map((p) => ({
          id: p.id,
          name: p.name ?? p.id,
          description: p.description ?? '',
          trust: p.trust ?? 'user',
          broken: p.broken ?? null,
          isDefault: p.id === defaultId,
        })),
        permissions,
      })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  /**
   * POST /dsh-tiddlywiki/agent/send — deliver a note to one agent session as a
   * queued user message (sessionController.prompt, the same API the GUI chat
   * input uses). Guards: feature switch, optional shared token, body shape.
   */
  const handleAgentSend = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      if (!guardSendToAgent(req, res)) return
      const body = JSON.parse(await readBody(req)) as { sessionId?: unknown; text?: unknown }
      const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim().length > 0 ? body.sessionId.trim() : ''
      const text = typeof body.text === 'string' && body.text.trim().length > 0 ? body.text.trim() : ''
      if (sessionId.length === 0 || text.length === 0) {
        json(res, { ok: false, error: 'sessionId and text are required' }, 400)
        return
      }
      const sc = deps.getSessionController()
      if (sc === undefined) {
        json(res, { ok: false, error: 'session service unavailable' }, 503)
        return
      }
      const requestId = `tw-send-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      const accepted = await sc.prompt(
        { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
        AbortSignal.timeout(20_000),
      )
      // A refusal (session gone / busy) must not be reported as success.
      if (accepted !== undefined && accepted.accepted === false) {
        json(res, { ok: false, error: '会话未接受该消息（可能已结束或正忙）', requestId, sessionId }, 409)
        return
      }
      json(res, { ok: true, requestId, sessionId })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  /**
   * POST /dsh-tiddlywiki/agent/create — create (or adopt) one ordinary session
   * inside a real DSH workspace resolved from the requested path. The picker
   * uses it for "new workspace / new session": the directory is materialised so
   * a brand-new workspace actually exists on disk, the path is resolved to its
   * (idempotent) Workspace, and the session is created with `workspaceId` so it
   * lands under that workspace in the sidebar. Creating with bare `cwd` instead
   * would leave the session in the ungrouped bucket even when its working
   * directory matches an existing workspace path.
   *
   * Optional `mode` names the "工作模式" (an Agent preset id, e.g. from
   * /agent/modes); it is forwarded to `sessionController.create(agentPreset)`
   * so the new session launches under that preset. Omitted → deployment default.
   *
   * Optional `permission` names a "权限" preset (e.g. from /agent/modes'
   * `permissions` roster). After the session is created it is applied to the
   * live session's log via `permissionPresets.set` (durable knob events:
   * `permission/preset`, `sandbox/mode`, `approval/policy`), overriding the
   * deployment default pinned at creation. Omitted → keep the default.
   */
  const handleAgentCreate = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      if (!guardSendToAgent(req, res)) return
      const body = JSON.parse(await readBody(req)) as { cwd?: unknown; mode?: unknown; permission?: unknown }
      const cwd = typeof body.cwd === 'string' ? body.cwd.trim() : ''
      const mode = typeof body.mode === 'string' && body.mode.trim().length > 0 ? body.mode.trim() : undefined
      const permission = typeof body.permission === 'string' && body.permission.trim().length > 0 ? body.permission.trim() : undefined
      // Validate the permission preset BEFORE creating the session (fail fast,
      // so a bad name never leaves an orphaned session behind).
      const pp = deps.getPermissionPresets()
      if (permission !== undefined) {
        if (pp === undefined) {
          json(res, { ok: false, error: 'permission selected but the permission-presets service is unavailable' }, 503)
          return
        }
        if (!pp.names.includes(permission)) {
          json(res, { ok: false, error: `unknown permission preset "${permission}" (available: ${pp.names.join(', ')})` }, 400)
          return
        }
      }
      const sc = deps.getSessionController()
      if (sc === undefined) {
        json(res, { ok: false, error: 'session service unavailable' }, 503)
        return
      }
      // Validate the agent preset (工作模式) BEFORE any side effect (v0.19.3):
      // the old code created the cwd directory + workspace first, so an unknown
      // mode left an orphaned directory behind a 500 from `sc.create`.
      if (mode !== undefined) {
        const ap = deps.getAgentPresets()
        if (ap === undefined) {
          json(res, { ok: false, error: 'agent presets service unavailable' }, 503)
          return
        }
        try {
          const presets = await ap.list()
          if (!presets.some((preset) => preset.id === mode)) {
            json(res, { ok: false, error: `unknown agent preset "${mode}" (available: ${presets.map((preset) => preset.id).join(', ')})` }, 400)
            return
          }
        } catch (err) {
          json(res, { ok: false, error: `cannot validate agent preset: ${err instanceof Error ? err.message : String(err)}` }, 503)
          return
        }
      }
      const ws = deps.getWorkspaceRegistry()
      if (cwd.length > 0) {
        // Only absolute paths, and never clobber an existing non-directory:
        // `mkdir -p` on a file path throws ENOTDIR and used to surface as a 500.
        if (!isAbsolute(cwd)) {
          json(res, { ok: false, error: 'cwd must be an absolute path' }, 400)
          return
        }
        try {
          const info = await stat(cwd)
          if (!info.isDirectory()) {
            json(res, { ok: false, error: 'cwd exists but is not a directory' }, 400)
            return
          }
        } catch {
          await mkdir(cwd, { recursive: true })
        }
      }
      let created: { sessionId: string }
      let workspaceId: string | undefined
      if (cwd.length > 0 && ws !== undefined) {
        const workspace = await ws.create(cwd)
        workspaceId = workspace.id
        created = await sc.create({ workspaceId, agentPreset: mode })
      } else {
        created = await sc.create({ cwd: cwd.length > 0 ? cwd : undefined, agentPreset: mode })
      }
      // Apply the chosen permission preset to the just-created live session
      // (best-effort — the session is already created either way).
      let permissionApplied = false
      if (permission !== undefined) {
        const sessionsSvc = deps.getSessions()
        if (sessionsSvc !== undefined) {
          try {
            const session = sessionsSvc.get(created.sessionId)
            if (session !== undefined) {
              pp?.set(session, permission)
              permissionApplied = true
            }
          } catch {
            /* permission is an optional convenience; never fail the create */
          }
        }
      }
      json(res, {
        ok: true,
        sessionId: created.sessionId,
        cwd: cwd || null,
        workspaceId: workspaceId ?? null,
        mode: mode ?? null,
        permission: permission ?? null,
        permissionApplied,
      })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  const handleNote = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      const body = JSON.parse(await readBody(req)) as { title?: unknown; tag?: unknown; tags?: unknown; text?: unknown; expectedModified?: unknown; expectedRevision?: unknown; force?: unknown }
      const text = typeof body.text === 'string' && body.text.trim().length > 0 ? body.text.trim() : null
      if (text === null) {
        json(res, { ok: false, error: 'text is required' }, 400)
        return
      }
      const client = deps.getClient()
      if (client === undefined) {
        json(res, { ok: false, error: 'wiki service is not running' }, 503)
        return
      }
      const title = typeof body.title === 'string' && body.title.trim().length > 0 ? body.title.trim() : timestampTitle()
      // System tiddlers ($:/…) are TW internals (theme, config, plugins): the
      // quick-note route is a user path and must not let a request overwrite
      // them. Use the editor / admin surface for that (v0.19.0).
      if (title.startsWith('$:/')) {
        json(res, { ok: false, error: 'title must not be a system tiddler ($:/…)' }, 400)
        return
      }
      const tags = resolveTags(body)
      // PRESERVE, do not blind-replace (v0.19.1): read first (404 = new note,
      // any other failure propagates), keep the existing tags/custom fields
      // unless the body explicitly provides them, and honour the optimistic
      // concurrency tokens the quick-note card sends for a note it loaded.
      const existing = await client.get(title)
      assertNoConflict(title, existing, conflictTokens(body))
      const { tiddler } = buildWriteTiddler(title, text, {
        existing,
        tags,
        defaultTags: [deps.noteDefaults().tag],
        agentTag: false,
      })
      await client.put(tiddler)
      deps.autoCommit()
      invalidateGitStatus()
      const finalTags = tiddler.tags ?? []
      json(res, { ok: true, title, tag: finalTags.join(' '), tags: finalTags, text, type: typeof tiddler.type === 'string' ? tiddler.type : NOTE_TYPE })
    } catch (err) {
      if (err instanceof WriteConflictError) {
        json(res, { ok: false, error: err.message, conflict: true }, 409)
        return
      }
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  const handleEdit = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      const body = JSON.parse(await readBody(req)) as { title?: unknown; tag?: unknown; tags?: unknown; text?: unknown; expectedModified?: unknown; expectedRevision?: unknown; force?: unknown }
      const client = deps.getClient()
      if (client === undefined) {
        json(res, { ok: false, error: 'wiki service is not running' }, 503)
        return
      }
      const title = typeof body.title === 'string' && body.title.trim().length > 0 ? body.title.trim() : timestampTitle()
      if (title.startsWith('$:/')) {
        json(res, { ok: false, error: 'title must not be a system tiddler ($:/…)' }, 400)
        return
      }
      const text = typeof body.text === 'string' ? body.text : ''
      const result = await openInTwEditor(client, title, text, resolveTags(body), {
        defaultTags: [deps.noteDefaults().tag],
        ...conflictTokens(body),
      })
      deps.autoCommit()
      invalidateGitStatus()
      json(res, { ok: true, ...result, twUrl: TW_PROXY_PATH })
    } catch (err) {
      if (err instanceof WriteConflictError) {
        json(res, { ok: false, error: err.message, conflict: true }, 409)
        return
      }
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  /** Distinct non-system tags for the quick-note tag autocomplete. The flat
   *  `tags` array feeds note-widget's chip autocomplete; the parallel `items`
   *  (tag → tiddler count) feeds the reply-stream `tiddlywiki_list_tags` tool
   *  card, so both consumers share one endpoint.
   *
   *  Query params (v0.19.4): `limit` caps the payload (absent = every tag, so
   *  the autocomplete keeps its full vocabulary), `sort=count` orders by usage
   *  (default `alpha`). `tags`/`items` are always the same set in the same
   *  order, plus `total`/`truncated` so a capped caller can say "N of M". */
  const handleTags = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (rejectNonRead(req, res)) return
    const client = deps.getClient()
    if (client === undefined) {
      json(res, { ok: false, error: 'wiki service is not running' }, 503)
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const limit = readOptionalLimit(url, MAX_TAGS_LIMIT)
      const byCount = (url.searchParams.get('sort') ?? 'alpha') === 'count'
      // Text-bearing tiddlers only (server-side filter) — the same counting the
      // `tiddlywiki_list_tags` tool uses, so the card and the model agree.
      const { total, tags: all } = await client.tagStats()
      const ordered = byCount ? all : [...all].sort((a, b) => a.tag.localeCompare(b.tag, 'zh'))
      const picked = limit === undefined ? ordered : ordered.slice(0, limit)
      json(res, {
        ok: true,
        tags: picked.map((t) => t.tag),
        items: picked,
        total,
        truncated: picked.length < total,
      })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  /** Recent non-system tiddlers for the quick-note "最近" picker (newest first). */
  const handleRecent = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (rejectNonRead(req, res)) return
    const client = deps.getClient()
    if (client === undefined) {
      json(res, { ok: false, error: 'wiki service is not running' }, 503)
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const limit = readLimit(url, 15)
      const items = await client.recent(limit)
      json(res, {
        ok: true,
        limit,
        items: items.map((t) => ({
          title: t.title,
          tags: t.tags ?? [],
          modified: toIsoDateString(t.modified),
          snippet: snippetOf(t.text ?? ''),
        })),
      })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  /** Full tiddler for the quick-note "最近" picker (load into the editor). */
  const handleGet = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (rejectNonRead(req, res)) return
    const client = deps.getClient()
    if (client === undefined) {
      json(res, { ok: false, error: 'wiki service is not running' }, 503)
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const title = url.searchParams.get('title') ?? ''
      if (title.length === 0) {
        json(res, { ok: false, error: 'missing title' }, 400)
        return
      }
      // The plugin's own config tiddler can carry shared tokens (bridge.token /
      // sendToAgent.token) and this route is unauthenticated: serve the note
      // picker but never the plugin's secret-bearing config (v0.19.0).
      if (title.startsWith('$:/plugins/dsh-tiddlywiki/')) {
        json(res, { ok: false, error: 'system tiddler not exposed' }, 403)
        return
      }
      const t = await client.get(title)
      if (t === undefined) {
        json(res, { ok: false, notFound: true, title }, 404)
        return
      }
      // Custom fields are FLATTENED (v0.19.1): a single-tiddler GET nests every
      // non-known field under `fields`, so the old copy-top-level loop shipped
      // `fields: {fields: {q: …}}` — consumers could never read `q`/`due`/
      // `clip-url`. `revision` is surfaced explicitly as the concurrency token
      // the quick-note card echoes back on save.
      const binary = isBinaryType(typeof t.type === 'string' ? t.type : undefined)
      json(res, {
        ok: true,
        title: t.title,
        // Binary attachments carry base64 in `text`: never ship 20MB to the
        // note picker (it only needs metadata) — same rule as tiddlywiki_get.
        text: binary ? '' : (t.text ?? ''),
        binary,
        binaryChars: binary ? (t.text ?? '').length : undefined,
        tags: t.tags ?? [],
        type: t.type ?? 'text/vnd.tiddlywiki',
        modified: toIsoDateString(t.modified),
        revision: t.revision ?? null,
        fields: flattenTiddlerFields(t),
      })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  /**
   * GET /dsh-tiddlywiki/search — keyword search for the reply-stream tool card
   * (mirrors tools.ts tiddlywiki_search: same local substring/tag/since/type
   * matching via the TiddlyWebClient). Returns hit titles/tags/modified/
   * snippets so the card can list clickable wiki links.
   */
  const handleSearch = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (rejectNonRead(req, res)) return
    const client = deps.getClient()
    if (client === undefined) {
      json(res, { ok: false, error: 'wiki service is not running' }, 503)
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const query = url.searchParams.get('query') ?? ''
      const tags = url.searchParams.getAll('tags').filter((t) => t.length > 0)
      const tag = url.searchParams.get('tag') ?? undefined
      const since = url.searchParams.get('since') ?? undefined
      const type = url.searchParams.get('type') ?? undefined
      const limit = readLimit(url, 30)
      const { items, total } = await client.search(query, { tags, tag, since, type, limit })
      json(res, {
        ok: true,
        query,
        tags,
        tag: tag ?? null,
        since: since ?? null,
        type: type ?? null,
        limit,
        total,
        items: items.map((t) => ({
          title: t.title,
          tags: t.tags ?? [],
          modified: toIsoDateString(t.modified),
          snippet: snippetOf(t.text ?? ''),
        })),
      })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  const handleRestart = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      if (!beginMutation('restart')) {
        json(res, { ok: false, error: '另一个重启/同步正在进行中，请稍候' }, 429)
        return
      }
      try {
        await deps.server.restart()
      } finally {
        endMutation()
      }
      json(res, { ok: true, status: deps.server.status().status })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  /** One-click git sync for the floating button / settings page: pull →
   *  commit → push, then return the fresh status. Mirrors the agent tool's
   *  `action=sync` (design doc §7 conflict policy — rebase conflict aborts).
   *  When the pull actually changed the working tree, the running TW child
   *  still holds the old in-memory snapshot — restart it (same port) so the
   *  UI reflects the pulled files instead of looking stale. */
  const handleSync = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (rejectCrossSiteWrite(req, res, ['POST'])) return
    if (!beginMutation('sync')) {
      json(res, { ok: false, error: '另一个重启/同步正在进行中，请稍候' }, 429)
      return
    }
    invalidateGitStatus()
    const dir = deps.getWikiPath()
    const status = async (): Promise<GitStatusViewPublic | null> => {
      try { return await deps.git.status(dir) } catch { return null }
    }
    try {
      const pulled = await deps.git.pull(dir)
      if (!pulled.ok) {
        json(res, {
          ok: false,
          action: 'sync',
          message: pulled.message,
          ...(pulled.conflictFiles !== undefined ? { conflictFiles: pulled.conflictFiles } : {}),
          status: await status(),
        }, 409)
        return
      }
      let restarted = false
      let restartError: string | undefined
      if (pulled.changed === true) {
        try {
          // DRAIN THE SYNCER FIRST (v0.19.1, data safety): a REST PUT answers 204
          // while the filesystem syncer still holds the tiddler (~250ms timer).
          // Restarting TW before the flush kills those writes — the restarted
          // server boots from the pre-write snapshot and the note is gone, and
          // the `git commit` right below cannot recover what never hit disk.
          // Seeds/admin/index already used this sentinel; this route did not.
          const flushClient = deps.getClient()
          if (flushClient !== undefined) {
            await flushPendingWrites(flushClient, join(dir, 'tiddlers')).catch(() => undefined)
          }
          await deps.server.restart()
          restarted = true
        } catch (err) {
          restartError = err instanceof Error ? err.message : String(err)
        }
      }
      const committed = await deps.git.commit(dir, `sync ${new Date().toISOString()}`)
      const pushed = await deps.git.push(dir)
      const fresh = await status()
      json(res, {
        ok: pushed.ok,
        action: 'sync',
        message: pushed.ok ? '同步完成' : pushed.message,
        pull: 'ok',
        ...(pulled.changed === true ? { changed: true } : {}),
        restarted,
        ...(restartError !== undefined ? { restartError } : {}),
        commit: committed.message,
        push: pushed.message,
        status: fresh,
        lastSync: new Date().toISOString(),
      }, pushed.ok ? 200 : 502)
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    } finally {
      endMutation()
    }
  }

  /**
   * Save an uploaded file into the wiki's `files/` folder (git-tracked; TW's
   * core server serves it at `/files/<name>`, get-file.js — no restart
   * needed). Body is the raw file; the name arrives in `X-Filename`. A
   * collision appends `-1`, `-2`, … so nothing is ever overwritten.
   */
  const handleUpload = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      const buf = await readBodyBuffer(req)
      // Name comes from ?name= (URL-encoded) or the X-Filename header.
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const nameParam = url.searchParams.get('name')
      let name = sanitizeUploadName(nameParam ?? '')
      if (name.length === 0 && typeof req.headers['x-filename'] === 'string') {
        let decoded = ''
        try { decoded = decodeURIComponent(req.headers['x-filename'] as string) } catch { decoded = req.headers['x-filename'] as string }
        name = sanitizeUploadName(decoded)
      }
      if (name.length === 0) {
        json(res, { ok: false, error: 'missing or invalid filename' }, 400)
        return
      }
      // Refuse files the browser would EXECUTE on the DSH origin: `/files/*` is
      // served back through the same-origin `/tw` proxy, so an uploaded .html /
      // .svg would be same-origin script with access to the admin routes.
      const extension = extname(name).toLowerCase()
      if (DANGEROUS_UPLOAD_EXTENSIONS.has(extension)) {
        json(res, { ok: false, error: `不允许上传可执行/可脚本化的文件类型：${extension}` }, 400)
        return
      }
      const filesDir = join(deps.getWikiPath(), 'files')
      await mkdir(filesDir, { recursive: true })
      // Collision avoidance with an ATOMIC create (v0.19.3): the old code did
      // `access(candidate)` then `writeFile(candidate)`, so (a) any access error
      // (EACCES/EBUSY, not just ENOENT) was read as "name free" and (b) two
      // concurrent uploads could both pick the same name and one silently
      // replaced the other — contradicting the route's own "nothing is ever
      // overwritten" contract. `flag: 'wx'` fails with EEXIST instead, and we
      // walk the suffix chain on that error only. Bounded, so a pathological
      // directory cannot spin this loop forever.
      const ext = extname(name)
      const stem = ext.length > 0 ? name.slice(0, -ext.length) : name
      let candidate = ''
      let wrote = false
      for (let i = 0; i <= 10_000 && !wrote; i++) {
        candidate = i === 0 ? name : `${stem}-${i}${ext}`
        try {
          await writeFile(join(filesDir, candidate), buf, { flag: 'wx' })
          wrote = true
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        }
      }
      if (!wrote) {
        json(res, { ok: false, error: '同名文件过多，请换一个文件名' }, 409)
        return
      }
      deps.autoCommit()
      invalidateGitStatus()
      json(res, {
        ok: true,
        name: candidate,
        path: `files/${candidate}`,
        // Same-origin proxy URL: the embedded TW editor resolves image links
        // against the DSH origin, so a root-absolute `/files/...` would miss.
        url: `${TW_PROXY_PATH}files/${encodeURIComponent(candidate)}`,
        size: buf.length,
        type: req.headers['content-type'] ?? 'application/octet-stream',
      })
    } catch (err) {
      // Same mapping as every other route (v0.19.5): the old bespoke `/too
      // large/i` test disagreed with `errorStatus`'s `/body too large/i`, so the
      // 413 was decided by whichever wording the thrown error happened to use.
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  /**
   * POST /dsh-tiddlywiki/render — the ONLY render endpoint the GUI uses.
   *
   * Proxies to TW's own `/render` server route (installed by the `render-route`
   * seed) and **sanitizes the fragment before it leaves the host**.
   *
   * WHY (v0.19.1, security): the reply-stream tool card and the session
   * 「知识库」 Tab inject that HTML with `dangerouslySetInnerHTML` inside the DSH
   * page. TW's wikitext/markdown parsers only strip `on*` attributes — measured
   * against the live `/render`: `<iframe src="javascript:…">`,
   * `<a href="javascript:…">` and `<form action="javascript:…">` all pass
   * through, i.e. any note text (agent-written, clipped, imported) could run
   * script on the DSH origin and call the unauthenticated `/dsh-tiddlywiki/*`
   * routes. Sanitizing host-side also protects wikis whose ONE-SHOT render
   * bundle predates this fix (the client can never see raw TW output).
   */
  const handleRender = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      const client = deps.getClient()
      if (client === undefined) {
        json(res, { ok: false, error: 'wiki service is not running' }, 503)
        return
      }
      let body: { title?: unknown; text?: unknown; type?: unknown; contextTitle?: unknown; parseAsInline?: unknown } = {}
      try {
        body = JSON.parse(await readBody(req, MAX_PROXY_BODY_BYTES)) as typeof body
      } catch {
        json(res, { ok: false, error: 'invalid JSON body' }, 400)
        return
      }
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      const text = typeof body.text === 'string' ? body.text : undefined
      if (title.length === 0 && text === undefined) {
        json(res, { ok: false, error: 'body must provide "title" or "text"' }, 400)
        return
      }
      const request = title.length > 0
        ? { title }
        : {
            text: text as string,
            ...(typeof body.type === 'string' && body.type.length > 0 ? { type: body.type } : {}),
            ...(typeof body.contextTitle === 'string' && body.contextTitle.length > 0 ? { contextTitle: body.contextTitle } : {}),
            ...(body.parseAsInline === true ? { parseAsInline: true } : {}),
          }
      const html = await client.render(request)
      const safe = sanitizeTwFragment(html)
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(safe, 'utf8'),
      })
      res.end(safe)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/HTTP 404/.test(message)) {
        json(res, { ok: false, notFound: true, error: message }, 404)
        return
      }
      json(res, { ok: false, error: message }, 502)
    }
  }

  /**
   * Titles the browser-facing TW proxies must never serve (v0.19.3).
   *
   * `$:/plugins/dsh-tiddlywiki/config` holds the shared tokens and the git
   * remote (possibly with a PAT); both `/tw` and `/api` forward ANY path to the
   * loopback TW child, whose TiddlyWeb REST answers for `$:/…` titles — a
   * route-level guard on `/get` was therefore trivially bypassed by
   * `GET /dsh-tiddlywiki/tw/recipes/default/tiddlers/%24%3A%2Fplugins%2F…`
   * (verified). The whole plugin namespace is blocked: nothing under it is
   * needed by the TW frontend, and the host itself talks to TW directly.
   */
  const BLOCKED_PROXY_TITLE_PREFIXES = ['$:/plugins/dsh-tiddlywiki/']

  /** True when a proxied pathname addresses a blocked (secret-bearing) tiddler. */
  const isBlockedProxyPath = (pathname: string): boolean => {
    const marker = '/tiddlers/'
    const at = pathname.indexOf(marker)
    if (at < 0) return false
    const raw = pathname.slice(at + marker.length)
    let title = raw
    try {
      title = decodeURIComponent(raw)
    } catch { /* malformed encoding: check the raw form */ }
    return BLOCKED_PROXY_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix))
  }

  /** Passthrough /dsh-tiddlywiki/api/<rest> → TW root /<rest>. */
  const handleApiProxy = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Explicit method whitelist (v0.19.5): the host webserver dispatches by
    // pathname only, so without it every method (TRACE, or a typo'd verb) was
    // forwarded to the TW child. The set is the TiddlyWeb API surface the TW
    // frontend uses.
    if (rejectCrossSiteWrite(req, res, ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'])) return
    const client = deps.getClient()
    if (client === undefined) {
      json(res, { ok: false, error: 'wiki service is not running' }, 503)
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const rest = url.pathname.replace(/^\/dsh-tiddlywiki\/api/, '') || '/'
      if (isBlockedProxyPath(rest)) {
        json(res, { ok: false, error: 'system tiddler not exposed' }, 403)
        return
      }
      // Share the /tw proxy's header forwarding so `authorization`/`cookie`
      // reach the TW child: in locked-down mode (auth.username configured) the
      // /api passthrough used to 401 on every call because it dropped them.
      const headers: Record<string, string> = forwardHeaders(req.headers)
      const method = (req.method ?? 'GET').toUpperCase()
      // TW's CSRF gate requires X-Requested-With on writes; forward it through.
      if (method === 'PUT' || method === 'DELETE' || method === 'POST') headers['x-requested-with'] = 'TiddlyWiki'
      const init: RequestInit = { method, headers, signal: AbortSignal.timeout(15_000) }
      if (method === 'PUT' || method === 'POST') init.body = await readBody(req, MAX_PROXY_BODY_BYTES)
      const upstream = await fetch(`${deps.server.url}${rest}${url.search}`, init)
      const data = await upstream.text()
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(data)
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 502)
    }
  }

  /**
   * SAME-ORIGIN proxy /dsh-tiddlywiki/tw/<rest> → TW root /<rest>. Serves the
   * ENTIRE TW frontend (index HTML, /files/*, the TiddlyWeb API) to the
   * browser through the DSH origin, so the embedded editor works from any
   * host/domain the user reaches DSH on (loopback, LAN, Tailscale, domain,
   * HTTPS). The browser never talks to the loopback TW child directly; DSH
   * does, on the same machine. Binary responses are buffered losslessly
   * (arrayBuffer) — unlike the /api JSON proxy, this route must never .text().
   */
  const handleTwProxy = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (rejectCrossSiteWrite(req, res)) return
    const client = deps.getClient()
    if (client === undefined) {
      json(res, { ok: false, error: 'wiki service is not running' }, 503)
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const rest = url.pathname.replace(new RegExp(`^${TW_PROXY_PREFIX}(?=/|$)`), '') || '/'
    if (isBlockedProxyPath(rest)) {
      json(res, { ok: false, error: 'system tiddler not exposed' }, 403)
      return
    }
    try {
      const method = (req.method ?? 'GET').toUpperCase()
      const headers = forwardHeaders(req.headers)
      // TW's CSRF gate requires X-Requested-With on writes; forward it through.
      if (method === 'PUT' || method === 'DELETE' || method === 'POST') headers['x-requested-with'] = 'TiddlyWiki'
      // Abort the upstream fetch when the CLIENT goes away: without this the TW
      // child kept streaming a large attachment into the DSH process until the
      // 30s timeout fired, long after the browser had cancelled (v0.19.3).
      const abort = new AbortController()
      const timeout = AbortSignal.timeout(30_000)
      const signal = typeof AbortSignal.any === 'function' ? AbortSignal.any([abort.signal, timeout]) : timeout
      const init: RequestInit = { method, headers, signal }
      if (method === 'PUT' || method === 'POST') init.body = await readBodyBuffer(req, MAX_UPLOAD_BYTES)
      // A DELETE with a body would otherwise stay unread on the socket: the
      // upstream fetch goes out, but this request never drains, so the client
      // sits on a half-open connection until the 30s timeout (v0.19.5). The TW
      // frontend does not send DELETE bodies, but the proxy is a generic
      // passthrough — drain whatever is there.
      else if (req.readableEnded === false && (req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined)) req.resume()
      const upstream = await fetch(`${deps.server.url}${rest}${url.search}`, init)
      const responseHeaders: Record<string, string> = {
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'cache-control': upstream.headers.get('cache-control') ?? 'no-store',
      }
      for (const name of ['etag', 'last-modified', 'content-disposition', 'accept-ranges']) {
        const value = upstream.headers.get(name)
        if (value !== null) responseHeaders[name] = value
      }
      // Locked-down mode (auth.username configured) puts the TW frontend behind
      // HTTP Basic auth: without the challenge header the browser never prompts
      // and the embedded editor would just show a bare 401.
      const challenge = upstream.headers.get('www-authenticate')
      if (challenge !== null) responseHeaders['www-authenticate'] = challenge
      res.writeHead(upstream.status, responseHeaders)
      if (upstream.body === null) {
        res.end()
        return
      }
      // STREAM the body (not `arrayBuffer()`): fetching a large attachment
      // through /tw/files/… used to buffer the whole file in the DSH process
      // (v0.19.0). `content-length` is deliberately NOT forwarded — undici
      // decodes compressed responses, so the upstream length can be stale.
      const body = Readable.fromWeb(upstream.body as unknown as import('node:stream/web').ReadableStream)
      await new Promise<void>((resolveP, rejectP) => {
        body.on('error', rejectP)
        res.on('error', rejectP)
        res.on('close', () => {
          // Client hung up (aborted download / closed tab): stop pulling from the
          // TW child instead of draining it until the timeout.
          try { abort.abort() } catch { /* already aborted */ }
          try { body.destroy() } catch { /* already closed */ }
          resolveP()
        })
        res.on('finish', () => resolveP())
        body.pipe(res)
      })
    } catch (err) {
      if (res.headersSent) {
        res.end()
        return
      }
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 502)
    }
  }

  // Every handler goes through guardHandler (v0.19.3): a rejection — including a
  // synchronous throw before the handler's own try, e.g. `new URL(req.url)` —
  // becomes a 413/500 JSON response instead of an unhandled rejection that
  // would exit the dsh web process with the request hanging.
  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/status`, handler: guardHandler(handleStatus) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/note`, handler: guardHandler(handleNote) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/edit`, handler: guardHandler(handleEdit) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/tags`, handler: guardHandler(handleTags) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/recent`, handler: guardHandler(handleRecent) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/get`, handler: guardHandler(handleGet) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/search`, handler: guardHandler(handleSearch) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/render`, handler: guardHandler(handleRender) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/sync`, handler: guardHandler(handleSync) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/upload`, handler: guardHandler(handleUpload) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/restart`, handler: guardHandler(handleRestart) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/session/summary`, handler: guardHandler(handleSessionSummary) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/agent/sessions`, handler: guardHandler(handleAgentSessions) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/agent/modes`, handler: guardHandler(handleAgentModes) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/agent/send`, handler: guardHandler(handleAgentSend) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/agent/create`, handler: guardHandler(handleAgentCreate) }),
    ctx.webServer.register({ kind: 'prefix', path: `${ROUTE_PREFIX}/api`, handler: guardHandler(handleApiProxy) }),
    ctx.webServer.register({ kind: 'prefix', path: `${TW_PROXY_PREFIX}`, handler: guardHandler(handleTwProxy) }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** Public shape of the git status summary sent to the panel. */
export interface GitStatusViewPublic {
  exists: boolean
  branch: string
  dirty: boolean
  dirtyFiles: string[]
  remote: string
  lastCommit?: string
  ahead?: number
  behind?: number
}

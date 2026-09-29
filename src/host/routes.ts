/**
 * DSH webserver routes for dsh-tiddlywiki (design doc §10).
 *
 * Every route is registered with an explicit method whitelist and wrapped in
 * `guardHandler` (see the registration block at the bottom of this file); the
 * authoritative list, including the admin routes registered in admin.ts:
 *
 * | route                            | method | purpose                                  |
 * |----------------------------------|--------|------------------------------------------|
 * | /dsh-tiddlywiki/status           | GET    | panel health (service / url / git / tag) |
 * | /dsh-tiddlywiki/note             | POST   | quick-note → independent tiddler         |
 * | /dsh-tiddlywiki/edit             | POST   | save + open in TW's native editor (draft)|
 * | /dsh-tiddlywiki/tags             | GET    | tag vocabulary + counts (limit/sort)     |
 * | /dsh-tiddlywiki/recent           | GET    | recently modified notes                  |
 * | /dsh-tiddlywiki/get              | GET    | one tiddler for the quick-note picker    |
 * | /dsh-tiddlywiki/search           | GET    | keyword search (reply-stream tool card)  |
 * | /dsh-tiddlywiki/render           | POST   | TW render → sanitized HTML fragment      |
 * | /dsh-tiddlywiki/sync             | POST   | pull → commit → push (mutex)             |
 * | /dsh-tiddlywiki/upload           | POST   | upload into wiki/files/                  |
 * | /dsh-tiddlywiki/restart          | POST   | one-click retry/restart of the TW child  |
 * | /dsh-tiddlywiki/session/summary  | POST   | per-session wiki summary (§「知识库」Tab)  |
 * | /dsh-tiddlywiki/agent/sessions   | GET    | send-to-agent session picker             |
 * | /dsh-tiddlywiki/agent/modes      | GET    | agent / permission preset rosters        |
 * | /dsh-tiddlywiki/agent/send       | POST   | deliver a note into a session            |
 * | /dsh-tiddlywiki/agent/create     | POST   | create session (+workspace) and deliver  |
 * | /dsh-tiddlywiki/wechat/ready     | GET    | publish precheck (opencli + adapters)    |
 * | /dsh-tiddlywiki/wechat/publish   | POST   | start a draft-box publish job (mutex)    |
 * | /dsh-tiddlywiki/wechat/publish/status | GET | poll one publish job                    |
 * | /dsh-tiddlywiki/api/*            | any    | passthrough to the TW service (JSON)     |
 * | /dsh-tiddlywiki/tw/*             | any    | SAME-ORIGIN TW proxy (index + files + API)|
 * | /dsh-tiddlywiki/admin/state      | GET    | settings page: info + catalog + config   |
 * | /dsh-tiddlywiki/admin/info       | POST   | write tiddlywiki.info plugins/themes     |
 * | /dsh-tiddlywiki/admin/config     | POST   | write the config tiddler                 |
 * | /dsh-tiddlywiki/admin/restart    | POST   | restart the TW child                     |
 * | /dsh-tiddlywiki/admin/seeds      | GET    | seed status                              |
 * | /dsh-tiddlywiki/admin/seeds/run  | POST   | run seeds (include force re-init)        |
 * | /dsh-tiddlywiki/admin/seeds/remove| POST  | 反初始化 (remove non-core seeds)          |
 *
 * Matching is exact-over-prefix, so the exact routes win and the `/api` /
 * `/tw` prefixes catch the rest. Client calls are same-origin (the DSH web
 * server), so no CORS is involved. The `/tw` proxy is the remote-access
 * bridge: it serves the ENTIRE TW frontend to the browser through the DSH
 * origin (see TW_PROXY_PATH in wiki.ts), so the embedded editor works no
 * matter which host/domain the user reaches DSH on.
 *
 * Titles under `$:/plugins/dsh-tiddlywiki/` are NEVER served to a caller
 * (`isBlockedProxyTitle`): that namespace holds the shared tokens and the git
 * remote, and every caller-supplied title must pass through the predicate.
 *
 * @module dsh-tiddlywiki/host/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { TiddlyWebClient } from './tw-api.ts'
import type { WikiServer } from './wiki.ts'
import { GitConflictStateError, type GitFace, type GitStatusView } from './git.ts'
import { PATH_PREFIX, TW_PROXY_PREFIX, TW_PROXY_PATH } from './wiki.ts'
import type { SessionQueryFace } from './session-summary.ts'
import { readBody, json, guardHandler, errorStatus, rejectCrossSiteWrite, rejectNonRead, absoluteHostBase } from './http.ts'
import { drainThenStop } from './seeds.ts'
import { WriteConflictError } from './write-policy.ts'
import { conflictTokens, resolveTags, timestampTitle } from './routes-helpers.ts'
import type { WechatAdapter, WechatPublishConfig, WechatPublishJobView, WechatPublishStartResult, WechatReadyView } from './wechat-publish.ts'
import { createSessionRoutes } from './routes-session.ts'
import { createMutationLock, type MutationLock } from './mutation-lock.ts'
import { createNoteRoutes } from './routes-note.ts'
import { createWechatRoutes } from './routes-wechat.ts'
// Face types the session routes were extracted with: `registerRoutes`'s own
// deps interface still declares them, so they are re-imported here rather than
// duplicated (duplicating is how the two would drift apart).
import type {
  AgentPresetsFace,
  PermissionPresetsFace,
  SessionControllerFace,
  SessionPersistenceFace,
  SessionsFace,
  WorkspaceRegistryFace } from './routes-session.ts'
// The three TW-facing routes (`/render`, `/api/*`, `/tw/*`) and the
// blocked-title predicates + header forwarder they share with `/get` live in
// their own module (v0.28.8) — see that file's header for why.
import { createTwProxyRoutes } from './routes-tw-proxy.ts'

export { writeSessionSummary, SESSION_SUMMARY_PREFIX } from './session-summary.ts'
export type { SessionQueryFace, SessionSummaryResult } from './session-summary.ts'

export const ROUTE_PREFIX = PATH_PREFIX


/** Structural webserver face (a subset of dsh-host-webserver). */
export interface WebServerFace {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
}

/**
 * The DSH-service faces of the session routes. They are DECLARED in
 * routes-session.ts (v0.28.8) — next to the handlers that are their only
 * consumers — and re-exported here because this module has always been the
 * import surface for the plugin wiring (`src/index.ts`) and for the callers of
 * `SessionQueryFace` / the wiki-side surfaces.
 */
export type {
  SessionControllerFace,
  WorkspaceRegistryFace,
  AgentPresetsFace,
  SessionPersistenceFace,
  PermissionPresetsFace,
  SessionsFace } from './routes-session.ts'

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

/** One knowledge base as the GUI sees it (list/selector payload). */
export interface WikiSummaryPublic {
  id: string
  label: string
  /** Health of this wiki's TW child ('running' | 'starting' | 'stopped' | 'failed'). */
  status: string
  /** May the AGENT reach it at all (hidden ones are absent from every prompt). */
  agentVisible: boolean
  /** Comes up at boot (multi mode); others start on demand. */
  autostart: boolean
  /** A TW child is currently serving it. */
  running: boolean
  path: string
}

/** The whole farm as the GUI sees it. */
export interface WikiFarmPublic {
  /** 'single' = one wiki (legacy behaviour); 'multi' = the farm. */
  mode: string
  /** Id a session without an explicit scope falls back to. */
  defaultId: string
  items: WikiSummaryPublic[]
}

/**
 * Everything the routes need from the plugin.
 *
 * v0.28.0: every PER-WIKI accessor takes the request, because the plugin no
 * longer serves exactly one knowledge base. In single-wiki mode they all
 * resolve to the same instance, so the call sites read exactly as before; in
 * multi-wiki mode they resolve the wiki THIS request targets (`?wiki=<id>`, or
 * the session's scope — see host/wiki-farm.ts).
 *
 * ⚠️ `server` returns `undefined` when the targeted wiki is not running. The
 * routes then answer 503 — the same answer the previous
 * `getClient() === undefined` guard already produced.
 *
 * The DSH *session* services below stay request-independent on purpose: they
 * belong to the host, not to a wiki.
 */
export interface RouteDeps {
  /** The whole farm's list/mode/default (the GUI's per-wiki selector). */
  wikiSummaries: (req: IncomingMessage) => WikiFarmPublic
  /** The TW child serving the wiki this request targets (undefined = not up). */
  server: (req: IncomingMessage) => WikiServer | undefined
  /** Lazily resolved REST client for the same wiki. */
  getClient: (req: IncomingMessage) => TiddlyWebClient | undefined
  /** The TW child of a NAMED wiki (the `/tw/<id>/…` proxy form). */
  serverById: (id: string) => WikiServer | undefined
  /** Every registered wiki id (lets the proxy tell an id from a TW path). */
  wikiIds: () => readonly string[]
  git: GitFace
  /** Debounced auto-commit touch for the targeted wiki. */
  autoCommit: (req: IncomingMessage) => void
  /** Default note tag of the targeted wiki. */
  noteDefaults: (req: IncomingMessage) => { tag: string }
  /** Effective UI flags of the targeted wiki. */
  uiDefaults: (req: IncomingMessage) => UiDefaultsPublic
  /**
   * The plugin-wide mutation lock (v0.30.12). Optional so a harness that builds a
   * partial RouteDeps still registers; when omitted the surface makes its own.
   */
  mutationLock?: MutationLock
  /**
   * The targeted wiki's UI language (v0.30.6), raw (`zh`/`en`/`zh-CN`…). The
   * CLIENT normalizes it; `/status` carries it as `lang` so every client surface
   * speaks the language the user configured once, for both halves.
   */
  /**
   * OPTIONAL on purpose: harnesses (and any embedder) that build a partial
   * RouteDeps must not crash `/status` — the client falls back to the default
   * language when `lang` is absent.
   */
  langOf?: (req: IncomingMessage) => string
  /** Absolute folder of the targeted wiki. */
  getWikiPath: (req: IncomingMessage) => string
  /**
   * Why this request names a knowledge base that cannot serve it (v0.29.0).
   *
   * Returns an actionable sentence when `?wiki=<id>` names a REGISTERED but
   * STOPPED wiki, `undefined` otherwise (no selector / running / unknown id).
   * Routes that already 503 on a missing client use it to NAME the wiki; the
   * ones whose accessors have a harmless-looking fallback (config, wiki path,
   * seed status) MUST check it first, or they answer with ANOTHER wiki's data —
   * the silent-wrong-wiki class this hook exists to close.
   */
  targetProblem?: (req: IncomingMessage) => string | undefined
  /**
   * After a pull moved HEAD: restart the running wikis whose content actually
   * changed, and report their ids (v0.28.0). `changedFiles` are
   * repository-relative paths, so a shared repository can restart exactly the
   * affected knowledge bases. Absent in headless contexts (no restart).
   */
  restartAffected?: (req: IncomingMessage, dir: string, changedFiles: readonly string[]) => Promise<{ restarted: string[]; failed: Array<{ id: string; message: string }> }>
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
  /** Whether the one-click send-to-agent feature is enabled for that wiki. */
  sendToAgentEnabled: (req: IncomingMessage) => boolean
  /** Optional shared token that must match `x-send-to-agent-token` when set. */
  sendToAgentToken: (req: IncomingMessage) => string
  /**
   * Effective `wechat.*` config (v0.23.3) OF THE TARGETED WIKI: the opt-in
   * 公众号发布 feature's switch, CLI override, optional token and default
   * adapter. Read per request so a settings-page save applies without a dsh web
   * restart.
   */
  wechatConfig: (req: IncomingMessage) => WechatPublishConfig
  /** The publish runner (plugin-wide: one opencli child at a time). */
  wechatRunner: () => WechatPublishFace | undefined
  /** Readiness report (opencli + adapter files) for the button's precheck. */
  wechatReady: (req: IncomingMessage) => Promise<WechatReadyView>
  /**
   * Per-session knowledge-base scope (v0.28.0): what this conversation works on.
   * The composer's selector reads and writes it; the agent tools and the
   * injected prompt are driven by the same value, so what the user picks is what
   * the model gets.
   */
  sessionScope?: {
    /** Current choice + what it resolves to (and why, when it cannot serve). */
    get: (sessionId: string) => { scope?: string; resolved?: { id: string; label: string }; reason?: string }
    /** Point the session at a wiki, or clear the choice with `undefined`. */
    set: (sessionId: string, wikiId: string | undefined) => Promise<void>
  }
}

/**
 * Structural face over the WeChat publish runner (host/wechat-publish.ts).
 * Declared here so the routes only depend on start/status, never on the class.
 */
export interface WechatPublishFace {
  start(request: { title: string; adapter?: WechatAdapter; dsn: string }): WechatPublishStartResult
  status(id?: string): WechatPublishJobView | undefined
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
// v0.30.9：这十来个**纯 helper**（上传名净化 / 脱敏 / limit 夹取 / 时间戳 / 标签与并发
// 令牌解析）以及 `openInTwEditor` 搬进了 `routes-helpers.ts`（纯搬迁，函数体一字未改）。
// 下面是**原样 re-export**：`admin-secrets.ts` 从本文件 import `redactRemoteUrl`、
// `index.ts` 从本文件 re-export `openInTwEditor`、selftest 与
// `scripts/verify-audit-fixes.mjs` 直接用它们 —— 既有 import 路径一个都不用改。
import {
  openInTwEditor,
  redactLogLines,
  redactRemoteUrl } from './routes-helpers.ts'

export { openInTwEditor, redactLogLines, redactRemoteUrl } from './routes-helpers.ts'
export function registerRoutes(ctx: { webServer: WebServerFace }, deps: RouteDeps): () => void {
  /**
   * `/status` is polled by the GUI (30s), every mounted TW frame and the FAB,
   * and each call shells out to up to five `git` processes — so the git summary
   * is cached for a couple of seconds. Any route that mutates the repo
   * invalidates it so a sync/upload is reflected immediately.
   */
  const GIT_STATUS_TTL_MS = 2_000
  /** Cached git-status PROMISE **per wiki** (not value): a burst of concurrent
   *  /status polls then shares ONE probe instead of each spawning up to five git
   *  processes (v0.19.0 — value-caching still let every concurrent miss run its
   *  own). The key is the wiki folder: with several knowledge bases a
   *  single-slot cache would hand wiki A the answer probed for wiki B (v0.28.0). */
  let gitStatusCache: { key: string; at: number; value: Promise<GitStatusViewPublic | null> } | undefined
  const invalidateGitStatus = (): void => { gitStatusCache = undefined }
  const cachedGitStatus = (req: IncomingMessage): Promise<GitStatusViewPublic | null> => {
    const key = deps.getWikiPath(req)
    if (gitStatusCache !== undefined && gitStatusCache.key === key && Date.now() - gitStatusCache.at < GIT_STATUS_TTL_MS) return gitStatusCache.value
    const pending = (async (): Promise<GitStatusViewPublic | null> => {
      try {
        const view = await deps.git.status(key)
        // The remote URL can carry a PAT (`https://user:token@…`) and /status is
        // unauthenticated — never hand the credential to the browser.
        return { ...view, remote: redactRemoteUrl(typeof view.remote === 'string' ? view.remote : '') }
      } catch {
        return null
      }
    })()
    gitStatusCache = { key, at: Date.now(), value: pending }
    return pending
  }

  /**
   * Serialize the heavyweight mutating routes (restart / sync). A burst of
   * concurrent calls used to stack pull/restart operations on top of each
   * other (and a restart racing a restart is what left orphan TW children).
   * A second concurrent caller gets 429 instead of piling on (v0.19.0).
   */
  // v0.30.12: the lock is now SHARED with the admin routes (`/admin/restart`,
  // `/admin/seeds/{run,remove}`), which used to race it — see host/mutation-lock.ts.
  // `deps.mutationLock` is created once in index.ts; the fallback keeps a harness
  // that builds a partial RouteDeps working (its own lock is still correct for a
  // single surface).
  const mutationLock = deps.mutationLock ?? createMutationLock()
  const beginMutation = (label: string): boolean => mutationLock.begin(label)
  const endMutation = (): void => mutationLock.end()

  /**
   * Absolute twin of `twProxy` for embedders whose own document is not on
   * http(s) — the DSH desktop app's `dsh-app:` renderer (v0.26.7). See
   * `absoluteHostBase()` in http.ts for the full why; clients only consult it
   * while their own page is not http(s), so nothing changes for http(s)
   * deployments.
   */
  const twProxyAbsoluteBase = (req: IncomingMessage): string | undefined => absoluteHostBase(req.headers.host, TW_PROXY_PATH)

  /**
   * 503 when `?wiki=<id>` names a REGISTERED but STOPPED knowledge base (v0.29.0).
   *
   * Before this, such a request fell through to the DEFAULT wiki — the settings
   * page said 「正在配置：books」 and then synced/restarted/uploaded into the work
   * wiki, silently. `deps.targetProblem` is the single place that knows the
   * difference between "unknown id" (still falls back: stale bookmark) and
   * "known but not running" (must refuse), so every route that can act asks it.
   */
  const refuseStoppedTarget = (req: IncomingMessage, res: ServerResponse): boolean => {
    const problem = deps.targetProblem?.(req)
    if (problem === undefined) return false
    json(res, { ok: false, error: problem }, 503)
    return true
  }

  /**
   * The 503 body for "no running wiki behind this request": names the wiki when
   * the request asked for one that is stopped, otherwise the historical text.
   */
  const notRunning = (req: IncomingMessage): string => deps.targetProblem?.(req) ?? 'wiki service is not running'

  const handleStatus = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (rejectNonRead(req, res)) return
    // A `?wiki=` that names a stopped wiki must not answer with ANOTHER wiki's
    // path/git/note defaults (the settings page's 状态 row reads exactly this).
    if (refuseStoppedTarget(req, res)) return
    const view = deps.server(req)?.status() ?? { status: 'stopped' as const, wikiPath: deps.getWikiPath(req), logs: [] }
    const gitSummary = await cachedGitStatus(req)
    json(res, {
      ok: true,
      ...view,
      // Child-process logs are served to an unauthenticated caller: never leak
      // the spawn line's `password=…` (or a forwarded Authorization header).
      logs: redactLogLines(view.logs),
      twProxy: TW_PROXY_PATH,
      // Absolute twin of `twProxy` for embedders whose own document is not on
      // http(s) — the DSH desktop app (`dsh-app://app`); see
      // twProxyAbsoluteBase(). Absent when the Host header is unusable.
      twProxyAbsolute: twProxyAbsoluteBase(req),
      git: gitSummary,
      note: { tag: deps.noteDefaults(req).tag },
      ui: deps.uiDefaults(req),
      // v0.30.6: the client half's language (see RouteDeps.langOf). Optional so a
      // partial RouteDeps (harnesses) still serves /status; absent → client default.
      ...(typeof deps.langOf === 'function' ? { lang: deps.langOf(req) } : {}),
      // The knowledge-base roster (v0.28.0): the GUI's per-wiki selector and the
      // settings page read it from here. Deliberately WITHOUT per-wiki git
      // status — that would spawn up to five git processes per wiki on every
      // 30s poll; `/status?wiki=<id>` carries git for the one you are looking at.
      ...(() => {
        const farm = deps.wikiSummaries(req)
        return { mode: farm.mode, defaultId: farm.defaultId, wikis: farm.items }
      })() })
  }

  /**
   * Single-flight + short reuse for the session summary (v0.25.0).
   *
   * ONE generation reads up to 41 session event logs (whole logs) and probes up
   * to 300 tiddlers over REST; the client regenerates on every tab mount, so two
   * tabs or a double-click on「🔄 刷新」used to run that whole pipeline twice in
   * parallel for the same answer. The cache holds the PROMISE (concurrent callers
   * share one run) and a rejection is never kept.
   */
  /**
   * The session-scoped routes (per-session knowledge-base scope, the 「知识库」
   * Tab summary, and the TW-side send-to-agent picker) live in routes-session.ts
   * (v0.28.8): they are the handlers driven by the DSH *session* services rather
   * than by a wiki, so they are the one cohesive group that could move without
   * dragging the wiki-facing routes along with them. The factory closes over the
   * same locals they used before; only the returned functions change address.
   */
  const {
    // `handleSessionWiki`/`handleSessionWikiSet` are NOT destructured: only the
    // combined GET/POST dispatcher (`handleSessionWikiRoute`) is mounted, and it
    // calls the other two inside the factory. Pulling them out here would be an
    // unused binding.
    handleSessionWikiRoute,
    handleSessionSummary,
    handleAgentSessions,
    handleAgentModes,
    handleAgentSend,
    handleAgentCreate } = createSessionRoutes({
    getClient: deps.getClient,
    getSessionQuery: deps.getSessionQuery,
    sessionScope: deps.sessionScope,
    getSessionController: deps.getSessionController,
    getWorkspaceRegistry: deps.getWorkspaceRegistry,
    getAgentPresets: deps.getAgentPresets,
    getSessionPersistence: deps.getSessionPersistence,
    getPermissionPresets: deps.getPermissionPresets,
    getSessions: deps.getSessions,
    sendToAgentEnabled: deps.sendToAgentEnabled,
    sendToAgentToken: deps.sendToAgentToken,
    twProxyPath: TW_PROXY_PATH,
    twProxyAbsoluteBase,
  })

  const handleEdit = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      const body = JSON.parse(await readBody(req)) as { title?: unknown; tag?: unknown; tags?: unknown; text?: unknown; expectedModified?: unknown; expectedRevision?: unknown; force?: unknown }
      const client = deps.getClient(req)
      if (client === undefined) {
        json(res, { ok: false, error: notRunning(req) }, 503)
        return
      }
      const title = typeof body.title === 'string' && body.title.trim().length > 0 ? body.title.trim() : timestampTitle()
      if (title.startsWith('$:/')) {
        json(res, { ok: false, error: 'title must not be a system tiddler ($:/…)' }, 400)
        return
      }
      const text = typeof body.text === 'string' ? body.text : ''
      const result = await openInTwEditor(client, title, text, resolveTags(body), {
        defaultTags: [deps.noteDefaults(req).tag],
        ...conflictTokens(body) })
      deps.autoCommit(req)
      invalidateGitStatus()
      json(res, { ok: true, ...result, twUrl: TW_PROXY_PATH, twUrlAbsolute: twProxyAbsoluteBase(req) })
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

  const handleRestart = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      // Sync is a repository/folder operation on the target wiki's path: without
      // this check a stopped `?wiki=` would pull+commit+push the DEFAULT repo.
      if (refuseStoppedTarget(req, res)) return
      if (!beginMutation('restart')) {
        json(res, { ok: false, error: '另一个重启/同步正在进行中，请稍候' }, 429)
        return
      }
      let drained = true
      try {
        // v0.24.1: the drain lives inside `drainThenStop` (ironclad rule #1).
        // This route used to SIGKILL the child directly, so clicking「重启 TW」
        // within ~1s of any write silently lost that write.
        drained = await drainThenStop({
          client: deps.getClient(req),
          tiddlersDir: join(deps.getWikiPath(req), 'tiddlers'),
          stop: async () => { await deps.server(req)?.restart() },
          log: (message) => console.warn('[dsh-tiddlywiki]', message) })
      } finally {
        endMutation()
      }
      json(res, { ok: true, status: deps.server(req)?.status().status, drained })
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
    // Same reason as /restart: the folder comes from the target, and a stopped
    // `?wiki=` used to fall back to the DEFAULT wiki's repository.
    if (refuseStoppedTarget(req, res)) return
    if (!beginMutation('sync')) {
      json(res, { ok: false, error: '另一个重启/同步正在进行中，请稍候' }, 429)
      return
    }
    invalidateGitStatus()
    const dir = deps.getWikiPath(req)
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
          status: await status() }, 409)
        return
      }
      let restarted = false
      let restartedWikis: string[] | undefined
      let restartError: string | undefined
      if (pulled.changed === true && deps.restartAffected !== undefined) {
        try {
          // v0.28.0: restart ONLY the wikis whose content changed, and let the
          // runtime drain the syncer queue first (ironclad rule #1 lives inside
          // `WikiInstance.restart()`). Restarting "the wiki this request came
          // from" would miss the one that actually changed when several share a
          // repository — and would interrupt a wiki nothing happened to.
          const outcome = await deps.restartAffected(req, dir, pulled.changedFiles ?? [])
          restarted = outcome.restarted.length > 0
          if (outcome.restarted.length > 0) restartedWikis = outcome.restarted
          if (outcome.failed.length > 0) restartError = outcome.failed.map((item) => `${item.id}: ${item.message}`).join('; ')
        } catch (err) {
          restartError = err instanceof Error ? err.message : String(err)
        }
      }
      // Refuse a conflicted tree (v0.23.4): a leftover conflict block must never
      // be committed/pushed. `commit` throws GitConflictStateError → answer 409
      // with the offending files instead of the generic 500 handler.
      let committed: { committed: boolean; message: string }
      try {
        committed = await deps.git.commit(dir, `sync ${new Date().toISOString()}`)
      } catch (err) {
        if (err instanceof GitConflictStateError) {
          json(res, {
            ok: false,
            action: 'sync',
            message: err.message,
            conflictFiles: err.files,
            pull: 'ok',
            status: await status() }, 409)
          return
        }
        throw err
      }
      const pushed = await deps.git.push(dir)
      const fresh = await status()
      json(res, {
        ok: pushed.ok,
        action: 'sync',
        message: pushed.ok ? '同步完成' : pushed.message,
        pull: 'ok',
        ...(pulled.changed === true ? { changed: true } : {}),
        restarted,
        // Which knowledge bases were restarted (v0.28.0). `restarted` stays a
        // BOOLEAN for the existing client, which only shows a sentence.
        ...(restartedWikis !== undefined ? { restartedWikis } : {}),
        ...(restartError !== undefined ? { restartError } : {}),
        commit: committed.message,
        push: pushed.message,
        status: fresh,
        lastSync: new Date().toISOString() }, pushed.ok ? 200 : 502)
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
  const { handleRender, handleApiProxy, handleTwProxy } = createTwProxyRoutes({
    server: deps.server,
    serverById: deps.serverById,
    wikiIds: deps.wikiIds,
    getClient: deps.getClient })

  /**
   * Shared gate for the TW-side 公众号发布 routes (v0.23.3): opt-in feature
   * switch (`wechat.enabled`, default OFF) then, when a shared token is
   * configured, the `x-wechat-publish-token` header must match. Mirror of
   * `guardSendToAgent` — the feature is off by default, so an unconfigured
   * deployment answers 403 instead of starting browser automation.
   */
  // v0.30.9：公众号发布那三条路由（+ guardWechat/wechatDsn）搬进 routes-wechat.ts。
  // 只把它真正用到的 deps 成员传进去 —— 依赖面写在那个文件里，改动可审。
  const { handleWechatReady, handleWechatPublish, handleWechatPublishStatus } = createWechatRoutes({
    getClient: deps.getClient,
    wechatConfig: deps.wechatConfig,
    wechatReady: deps.wechatReady,
    wechatRunner: deps.wechatRunner,
    wikiSummaries: deps.wikiSummaries })


  // v0.30.10：笔记读写那六条路由搬进 routes-note.ts（纯搬迁 + 工厂化）。只把它真正
  // 用到的 deps 成员与闭包 helper 传进去 —— 依赖面写在那个文件里，改动可审。
  const note = createNoteRoutes(
    {
      autoCommit: deps.autoCommit,
      getClient: deps.getClient,
      getWikiPath: deps.getWikiPath,
      noteDefaults: deps.noteDefaults,
      server: deps.server,
      serverById: deps.serverById,
      wikiIds: deps.wikiIds,
      wikiSummaries: deps.wikiSummaries },
    { refuseStoppedTarget, notRunning, invalidateGitStatus },
  )
  // Every handler goes through guardHandler (v0.19.3): a rejection — including a
  // synchronous throw before the handler's own try, e.g. `new URL(req.url)` —
  // becomes a 413/500 JSON response instead of an unhandled rejection that
  // would exit the dsh web process with the request hanging.
  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/status`, handler: guardHandler(handleStatus) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/note`, handler: guardHandler(note.handleNote) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/edit`, handler: guardHandler(handleEdit) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/tags`, handler: guardHandler(note.handleTags) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/recent`, handler: guardHandler(note.handleRecent) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/get`, handler: guardHandler(note.handleGet) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/search`, handler: guardHandler(note.handleSearch) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/render`, handler: guardHandler(handleRender) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/sync`, handler: guardHandler(handleSync) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/upload`, handler: guardHandler(note.handleUpload) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/restart`, handler: guardHandler(handleRestart) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/session/summary`, handler: guardHandler(handleSessionSummary) }),
    // One path, both methods (the host webserver dispatches by pathname only).
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/session/wiki`, handler: guardHandler(handleSessionWikiRoute) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/agent/sessions`, handler: guardHandler(handleAgentSessions) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/agent/modes`, handler: guardHandler(handleAgentModes) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/agent/send`, handler: guardHandler(handleAgentSend) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/agent/create`, handler: guardHandler(handleAgentCreate) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/wechat/ready`, handler: guardHandler(handleWechatReady) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/wechat/publish`, handler: guardHandler(handleWechatPublish) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/wechat/publish/status`, handler: guardHandler(handleWechatPublishStatus) }),
    ctx.webServer.register({ kind: 'prefix', path: `${ROUTE_PREFIX}/api`, handler: guardHandler(handleApiProxy) }),
    ctx.webServer.register({ kind: 'prefix', path: `${TW_PROXY_PREFIX}`, handler: guardHandler(handleTwProxy) }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** Public shape of the git status summary sent to the panel.
 *  Single declaration lives in git.ts (v0.20.0 — this file used to repeat it). */
export type GitStatusViewPublic = GitStatusView
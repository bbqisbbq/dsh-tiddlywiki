/**
 * Session-service routes: the handlers driven by the DSH *session* services
 * rather than by a wiki (v0.28.8).
 *
 * WHY THEY ARE THEIR OWN MODULE: `routes.ts` had grown past 2000 lines, and this
 * is the one cohesive group inside it that could move without dragging the
 * wiki-facing routes along. Everything here answers a question about a
 * CONVERSATION — which knowledge base is this session using, what did it touch,
 * and DSH's own agent/session/preset facades — so the handlers share a
 * dependency set that has nothing to do with serving tiddlers.
 *
 * They keep closing over the same locals they always did; the factory exists so
 * those locals arrive as an explicit interface instead of an implicit closure.
 * Behaviour is unchanged, deliberately: this was a move, not a rewrite. That is
 * why the handlers below still read exactly as they did before, comments
 * included — those comments document real past bugs.
 *
 * @module dsh-tiddlywiki/host/routes-session
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readBody, errorStatus, rejectCrossSiteWrite, rejectNonRead, safeTokenEqual } from './http.ts'
// The session summary probes the library folder (`stat`/`mkdir`/`isAbsolute`)
// while it decides which notes belong to this conversation, so those node
// imports travel with the handlers.
import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { writeSessionSummary, type SessionQueryFace, type SessionSummaryResult } from './session-summary.ts'
import type { TiddlyWebClient } from './tw-api.ts'

/** Dependencies the session routes need, all supplied by the host wiring. */
export interface SessionRouteDeps {
  /** The TW client serving the request's target wiki (undefined = not running). */
  getClient: (req: IncomingMessage) => TiddlyWebClient | undefined
  /** The DSH session-query service (reads a session's event log). */
  getSessionQuery: () => SessionQueryFace | undefined
  /** Per-session knowledge-base scope (read + write). */
  sessionScope?: SessionScopeFace
  /** DSH session controller (create/send into a session). */
  getSessionController: () => SessionControllerFace | undefined
  /** Workspace registry (a session's cwd lives here). */
  getWorkspaceRegistry: () => WorkspaceRegistryFace | undefined
  /** Agent presets (the per-session mode/preset catalogue). */
  getAgentPresets: () => AgentPresetsFace | undefined
  /** Session persistence (list sessions / read headers). */
  getSessionPersistence: () => SessionPersistenceFace | undefined
  /** Permission presets (the sender's sandbox/approval posture). */
  getPermissionPresets: () => PermissionPresetsFace | undefined
  /** Sessions service (create/read sessions by id). */
  getSessions: () => SessionsFace | undefined
  /** Whether the TW-side「发送给 Agent」bridge is enabled. */
  sendToAgentEnabled: (req: IncomingMessage) => boolean
  /** The bridge's shared token (empty = no token required). */
  sendToAgentToken: (req: IncomingMessage) => string
  /**
   * The TW proxy path (e.g. `/dsh-tiddlywiki/tw/`) and its ABSOLUTE loopback
   * base. The session summary reports both so the TW-side client can build a
   * same-origin URL — including on the desktop shell, whose renderer is not on
   * http(s) and therefore needs the absolute form (see client/endpoints.ts).
   */
  twProxyPath: string
  /**
   * Absolute loopback base for the TW proxy, or `undefined` when the request's
   * Host header cannot yield one. Undefined is a legitimate answer (the summary
   * route simply omits `twUrlAbsolute` then), so the type keeps it.
   */
  twProxyAbsoluteBase: (req: IncomingMessage) => string | undefined
}

/**
 * Structural face over the per-session knowledge-base scope (the host's
 * `sessionScope`). `get` returns the session's current choice PLUS what it
 * resolves to right now (and why, when it cannot serve) — the composer selector
 * renders all three. `set` persists a choice, or clears it with `undefined`.
 */
export interface SessionScopeFace {
  /** Current choice + what it resolves to (and why, when it cannot serve). */
  get: (sessionId: string) => { scope?: string; resolved?: { id: string; label: string }; reason?: string }
  /** Point the session at a wiki, or clear the choice with `undefined`. */
  set: (sessionId: string, wikiId: string | undefined) => Promise<void>
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

/** The handler set `registerRoutes` mounts (see its route table). */
export interface SessionRouteHandlers {
  handleSessionWiki: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  handleSessionWikiSet: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  handleSessionWikiRoute: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  handleSessionSummary: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  handleAgentSessions: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  handleAgentModes: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  handleAgentSend: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  handleAgentCreate: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

/** Build the session-service handlers around one host's dependencies. */
export function createSessionRoutes(deps: SessionRouteDeps): SessionRouteHandlers {
  /**
   * ONE generation reads up to 41 session event logs (whole logs) and probes up
   * to 300 tiddlers over REST; the client regenerates on every tab mount, so two
   * tabs or a double-click on「🔄 刷新」used to run that whole pipeline twice in
   * parallel for the same answer. The cache holds the PROMISE (concurrent callers
   * share one run) and a rejection is never kept.
   */
  const SUMMARY_REUSE_MS = 3_000
  const summaryInFlight = new Map<string, { at: number; value: Promise<SessionSummaryResult> }>()

  const handleSessionWiki = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectNonRead(req, res)) return
      if (deps.sessionScope === undefined) {
        json(res, { ok: false, error: '会话作用域不可用（宿主未接线）' }, 503)
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const session = (url.searchParams.get('session') ?? '').trim()
      if (session.length === 0) {
        json(res, { ok: false, error: 'session is required' }, 400)
        return
      }
      json(res, { ok: true, session, ...deps.sessionScope.get(session) })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  /**
   * POST /dsh-tiddlywiki/session/wiki { session, wiki } — point this conversation
   * at a knowledge base (`wiki: null`/`''` clears the choice and falls back to
   * the default).
   *
   * A HIDDEN wiki is refused (400): `agentVisible: false` means "the agent never
   * reaches this one", and a selector that lets a session pick it would quietly
   * contradict the setting the user just made.
   */
  const handleSessionWikiSet = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (deps.sessionScope === undefined) {
        json(res, { ok: false, error: '会话作用域不可用（宿主未接线）' }, 503)
        return
      }
      let body: { session?: unknown; wiki?: unknown } = {}
      try {
        body = JSON.parse(await readBody(req)) as { session?: unknown; wiki?: unknown }
      } catch {
        json(res, { ok: false, error: '请求体必须是 JSON' }, 400)
        return
      }
      const session = typeof body.session === 'string' ? body.session.trim() : ''
      if (session.length === 0) {
        json(res, { ok: false, error: 'session is required' }, 400)
        return
      }
      const raw = typeof body.wiki === 'string' ? body.wiki.trim() : ''
      const wikiId = raw.length === 0 ? undefined : raw
      await deps.sessionScope.set(session, wikiId)
      json(res, { ok: true, session, ...deps.sessionScope.get(session) })
    } catch (err) {
      // A refusal from the host (unknown / hidden wiki, bad session id) is the
      // caller's problem: 400 + the reason, so the picker can say what happened.
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 400)
    }
  }

  /** `/session/wiki` takes both methods on ONE registration (see /admin/wikis). */
  const handleSessionWikiRoute = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if ((req.method ?? 'GET').toUpperCase() === 'POST') {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      return handleSessionWikiSet(req, res)
    }
    return handleSessionWiki(req, res)
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
      const client = deps.getClient(req)
      if (client === undefined) {
        json(res, { ok: false, error: 'wiki service is not running' }, 503)
        return
      }
      const sq = deps.getSessionQuery()
      if (sq === undefined) {
        json(res, { ok: false, error: 'session query service unavailable' }, 503)
        return
      }
      const cachedSummary = summaryInFlight.get(session)
      let pendingSummary: Promise<SessionSummaryResult>
      if (cachedSummary !== undefined && Date.now() - cachedSummary.at < SUMMARY_REUSE_MS) {
        pendingSummary = cachedSummary.value
      } else {
        pendingSummary = writeSessionSummary(client, sq, session)
        summaryInFlight.set(session, { at: Date.now(), value: pendingSummary })
        pendingSummary.catch(() => {
          if (summaryInFlight.get(session)?.value === pendingSummary) summaryInFlight.delete(session)
        })
      }
      const result = await pendingSummary
      json(res, { ok: true, ...result, twUrl: deps.twProxyPath, twUrlAbsolute: deps.twProxyAbsoluteBase(req) })
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
    if (!deps.sendToAgentEnabled(req)) {
      json(res, { ok: false, error: 'send-to-agent is disabled' }, 403)
      return false
    }
    const token = deps.sendToAgentToken(req).trim()
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

  return {
    handleSessionWiki,
    handleSessionWikiSet,
    handleSessionWikiRoute,
    handleSessionSummary,
    handleAgentSessions,
    handleAgentModes,
    handleAgentSend,
    handleAgentCreate,
  }
}
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
import { json, readBody, errorStatus, rejectCrossSiteWrite, rejectNonRead } from './http.ts'
import type { SessionQueryFace } from './session-summary.ts'
import type { TiddlyWebClient } from './tw-api.ts'
import { createAgentHandlers } from './routes-session-agent.ts'
import { createSessionSummaryHandler } from './routes-session-summary.ts'

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
  /**
   * Current choice + what it resolves to (and why, when it cannot serve).
   *
   * `mode` is the registry mode (v0.29.0): without it a client cannot tell
   * "`resolved` is the answer because there is only one wiki" (single install →
   * keep the old DOM) from "`resolved` is the DEFAULT wiki this session's tools
   * actually act on" (multi → its links must open THAT wiki, not whichever one
   * the GUI happens to be focused on).
   */
  get: (sessionId: string) => { scope?: string; resolved?: { id: string; label: string }; reason?: string; mode?: string }
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

  // v0.30.2：汇总与 /agent/* 两族处理器各自成文件（纯搬迁，函数体逐字未改）。
  // 这里只装配：两个工厂拿到的都是同一个 `deps`，所以它们内部照旧写 deps.*。
  const handleSessionSummary = createSessionSummaryHandler(deps)
  const { handleAgentSessions, handleAgentModes, handleAgentSend, handleAgentCreate } = createAgentHandlers(deps)

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

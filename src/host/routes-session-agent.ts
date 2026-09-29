/**
 * The `/agent/*` handlers: the TW-side 「发送给 Agent」 picker (list sessions /
 * list work modes / send a message) plus `POST /agent/create` (create or adopt
 * a session inside a real DSH workspace). Extracted from `routes-session.ts`
 * (v0.30.2, pure move) — same `deps`, same bodies.
 *
 * The shared token guard (`guardSendToAgent`) lives here because every handler
 * in this file uses it and nothing else does.
 *
 * @module dsh-tiddlywiki/host/routes-session-agent
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { errorStatus, json, readBody, rejectCrossSiteWrite, rejectNonRead, safeTokenEqual } from './http.ts'
import type {
  AgentPresetsFace,
  PermissionPresetsFace,
  SessionControllerFace,
  SessionPersistenceFace,
  SessionsFace,
  WorkspaceRegistryFace,
} from './routes-session.ts'

/** The optional DSH services + token knobs these handlers need. */
export interface AgentRouteDeps {
  getSessionController: () => SessionControllerFace | undefined
  getAgentPresets: () => AgentPresetsFace | undefined
  getPermissionPresets: () => PermissionPresetsFace | undefined
  getSessions: () => SessionsFace | undefined
  getSessionPersistence: () => SessionPersistenceFace | undefined
  getWorkspaceRegistry: () => WorkspaceRegistryFace | undefined
  sendToAgentEnabled: (req: IncomingMessage) => boolean
  sendToAgentToken: (req: IncomingMessage) => string
}

/** Every `/agent/*` handler, ready to be wrapped in `guardHandler` + registered. */
export interface AgentRouteHandlers {
  handleAgentSessions: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  handleAgentModes: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  handleAgentSend: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  handleAgentCreate: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

/** Build the four `/agent/*` handlers around the dep subset they actually use. */
export function createAgentHandlers(deps: AgentRouteDeps): AgentRouteHandlers {
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

  return { handleAgentSessions, handleAgentModes, handleAgentSend, handleAgentCreate }
}

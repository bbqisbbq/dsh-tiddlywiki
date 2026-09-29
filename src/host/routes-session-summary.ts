/**
 * `/session/summary` — the 「知识库」 tab's backend (v0.30.2: extracted from
 * `routes-session.ts`, whose single `createSessionRoutes()` had grown to 430
 * lines while mixing three unrelated families of handlers).
 *
 * WHY ITS OWN MODULE: the CACHE. One generation reads up to 41 whole session
 * logs and probes up to 300 tiddlers over REST, and the client regenerates on
 * every tab mount — so two tabs or a double-click on「🔄 刷新」used to run that
 * whole pipeline twice in parallel for the same answer. That promise-valued,
 * now-bounded cache has exactly one consumer, so it lives with it.
 *
 * @module dsh-tiddlywiki/host/routes-session-summary
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { errorStatus, json, readBody, rejectCrossSiteWrite } from './http.ts'
import { writeSessionSummary, type SessionQueryFace, type SessionSummaryResult } from './session-summary.ts'
import type { TiddlyWebClient } from './tw-api.ts'

/** The request-scoped services this handler needs (a subset of SessionRouteDeps). */
export interface SessionSummaryRouteDeps {
  getClient: (req: IncomingMessage) => TiddlyWebClient | undefined
  getSessionQuery: () => SessionQueryFace | undefined
  twProxyPath: string
  twProxyAbsoluteBase: (req: IncomingMessage) => string | undefined
}

/** Build the `/session/summary` handler around the dep subset it actually uses. */
export function createSessionSummaryHandler(
  deps: SessionSummaryRouteDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  /**
   * ONE generation reads up to 41 session event logs (whole logs) and probes up
   * to 300 tiddlers over REST; the client regenerates on every tab mount, so two
   * tabs or a double-click on「🔄 刷新」used to run that whole pipeline twice in
   * parallel for the same answer. The cache holds the PROMISE (concurrent callers
   * share one run) and a rejection is never kept.
   */
  const SUMMARY_REUSE_MS = 3_000
  const summaryInFlight = new Map<string, { at: number; value: Promise<SessionSummaryResult> }>()
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
      // Bound the summary cache (v0.29.0). Only the REJECTION path used to delete
      // its entry, so every successful session kept one forever: a Map keyed by
      // session id that only grew (small values, but unbounded). Entries are only
      // reusable for SUMMARY_REUSE_MS, so anything older is dead weight.
      for (const [id, entry] of summaryInFlight) {
        if (Date.now() - entry.at >= SUMMARY_REUSE_MS) summaryInFlight.delete(id)
      }
      json(res, { ok: true, ...result, twUrl: deps.twProxyPath, twUrlAbsolute: deps.twProxyAbsoluteBase(req) })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }
  return handleSessionSummary
}

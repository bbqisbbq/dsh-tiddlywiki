/**
 * The ONE session → knowledge-base switch path (v0.35.0).
 *
 * WHY THIS EXISTS
 * ---------------
 * Two surfaces now change a session's knowledge-base scope: the composer's
 * selector (`conversation.input.left`, `wiki-scope-dock.ts`) and — new in
 * v0.35.0 — the session row's native context menu (`session-menu.ts`, DSH
 * 0.2.2's `contextMenus` service). Both must do exactly the same four things:
 *
 *   1. `POST /session/wiki` with `{ session, wiki: <id> | null }`
 *      — `null` (never `''`) is what clears an explicit scope;
 *   2. tolerate a cold start (selecting a wiki that is not running STARTS it
 *      host-side, and a cold TiddlyWiki child can take tens of seconds);
 *   3. parse the reply defensively — the payload is `{ ok, scope, resolved,
 *      reason, error }` and every field may be absent on an error path;
 *   4. on success call `invalidateSessionWikiId(sessionId)` so the reply-stream
 *      cards and the 「知识库」 tab re-resolve instead of keeping the previous
 *      wiki's `?wiki=` and badge for up to their own TTL (v0.28.8, see
 *      `wiki-scope.ts`).
 *
 * Copying those four steps into the menu module would be a second switch path,
 * and a second switch path is exactly how "the card shows the other wiki's
 * data" comes back. So the implementation lives here and both callers use it.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * No React, no DOM, no state. It does not remember the result either: the
 * selector keeps its own component state and the menu re-reads the shared
 * scope cache (`wiki-scope.ts`) on the next open. Callers decide what to show;
 * this module only talks to the host.
 *
 * @module dsh-tiddlywiki/client/session-wiki
 */
import { SESSION_WIKI_ENDPOINT } from './endpoints.ts'
import { t } from './i18n.ts'
import { invalidateSessionWikiId } from './wiki-scope.ts'

/** `resolved` of `/session/wiki`: the wiki a session EFFECTIVELY uses. */
export interface ResolvedWiki { id: string; label: string }

/** Outcome of one switch attempt, already flattened for the UI. */
export interface SessionWikiSwitchResult {
  /** True only when the host replied 2xx with `ok: true`. */
  ok: boolean
  /**
   * The scope that applies AFTER this call: the explicit id when one was sent
   * and accepted, `''` when the call asked to follow the default and succeeded,
   * and the requested value unchanged when the call failed.
   */
  scope: string
  /** The effectively-used wiki, when the host named one. */
  resolved?: ResolvedWiki
  /** Host-provided explanation (e.g. "started wiki X"), when any. */
  reason?: string
  /** Ready-to-display failure text; only present when `ok` is false. */
  error?: string
}

/**
 * Read `{id,label}` out of a `/session/wiki` payload, tolerating every shape we
 * may be handed (absent field, wrong types, id-only). `undefined` = unknown.
 */
export function readResolvedWiki(value: unknown): ResolvedWiki | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const id = (value as { id?: unknown }).id
  if (typeof id !== 'string' || id.length === 0) return undefined
  const label = (value as { label?: unknown }).label
  return { id, label: typeof label === 'string' && label.length > 0 ? label : id }
}

/**
 * Point one session at a knowledge base, or clear the explicit scope.
 *
 * @param sessionId - the session whose scope is being changed.
 * @param wanted - target wiki id; an EMPTY string means "follow the default"
 *   and is sent as `wiki: null`.
 * @returns the flattened outcome; never throws (a throw here would surface as a
 *   dead menu row or a stuck selector, not as a diagnostic).
 */
export async function switchSessionWiki(sessionId: string, wanted: string): Promise<SessionWikiSwitchResult> {
  try {
    const res = await fetch(SESSION_WIKI_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // A generous budget: selecting a wiki that is not running STARTS it
      // host-side (the tools resolve the scope synchronously and never start
      // anything themselves), and a cold child can take tens of seconds.
      body: JSON.stringify({ session: sessionId, wiki: wanted.length > 0 ? wanted : null }),
      signal: AbortSignal.timeout(120_000),
    })
    const payload = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      scope?: string
      resolved?: unknown
      reason?: string
      error?: string
    }
    const resolved = readResolvedWiki(payload.resolved)
    if (!res.ok || payload.ok !== true) {
      return {
        ok: false,
        scope: wanted,
        ...(resolved === undefined ? {} : { resolved }),
        error: typeof payload.error === 'string' && payload.error.length > 0
          ? payload.error
          : t('chrome.scopeSwitchFailed', { status: res.status }),
      }
    }
    // 立即让工具卡/会话汇总重新解析作用域（v0.28.8）：它们按会话缓存 wiki id，
    // 不失效的话切库后已显示的卡片仍带着旧库的 ?wiki= 与库徽标。
    invalidateSessionWikiId(sessionId)
    return {
      ok: true,
      scope: typeof payload.scope === 'string' ? payload.scope : wanted,
      ...(resolved === undefined ? {} : { resolved }),
      ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
    }
  } catch (err) {
    return { ok: false, scope: wanted, error: err instanceof Error ? err.message : String(err) }
  }
}

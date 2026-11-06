/**
 * Which knowledge base is the CURRENT session working on? (v0.28.8, feedback 10)
 *
 * WHY THIS EXISTS
 * ---------------
 * The host has resolved a per-session wiki scope since v0.28.0, and it already
 * names the wiki in the model-visible tool text (「【知识库：工作（work）】」). The
 * BROWSER half never learned about it, so every reply-stream card fetched its
 * data from whatever `?wiki=` defaulted to — the farm's DEFAULT wiki. With two
 * knowledge bases that reads as a bug the user cannot see the cause of: the
 * model says "work", the card shows the other wiki's identically-titled entry.
 *
 * The same id is also needed for LINKS: `TW_PROXY_BASE` (`/dsh-tiddlywiki/tw/`)
 * is the default wiki's alias, so a row click used to open the wrong knowledge
 * base.
 *
 * ONE SOURCE, TWO CONSUMERS
 * -------------------------
 * `tool-views.ts` (cards) and `session-summary.ts` (the 「知识库」tab) both ask
 * this module. It is deliberately a tiny cache over `GET /session/wiki` rather
 * than a React context: the two live in different slot trees (a keyed tool view
 * vs a conversation view) with no common provider to hang one from.
 *
 * FAIL-OPEN TO THE DEFAULT
 * ------------------------
 * `undefined` means "no explicit scope" — i.e. the default wiki, which is
 * exactly what every request did before this existed. A single-wiki install, a
 * failed fetch, or an unknown session therefore keeps byte-identical behaviour;
 * the extra `?wiki=` only ever appears for a session that actually picked one.
 *
 * @module dsh-tiddlywiki/client/wiki-scope
 */
import { SESSION_WIKI_ENDPOINT } from './endpoints.ts'

/** How long a resolved scope is trusted before re-reading (ms). */
const SCOPE_TTL_MS = 15_000

/** How long the very first `/session/wiki` read may take before we give up. */
const FETCH_TIMEOUT_MS = 8_000

/**
 * One resolved read. `wikiId` is what the CARDS use (the effective wiki, i.e.
 * the explicit scope or the resolved default in multi mode). `scope` and
 * `resolved` are the raw fields kept so a SYNCHRONOUS reader can tell the two
 * apart — the session context menu (v0.35.0) has to mark "follow the default"
 * and "the default wiki itself" as the same state, and it may not await.
 */
interface ScopeEntry {
  wikiId: string | undefined
  /** The explicit scope id, or `undefined` when the session follows the default. */
  scope: string | undefined
  /** The wiki the host resolved as effective, when it named one. */
  resolved: string | undefined
  at: number
}

const cache = new Map<string, ScopeEntry>()
/** In-flight reads, so a card grid mounting at once makes ONE request. */
const pending = new Map<string, Promise<ScopeEntry>>()
/** Scope-invalidation subscribers (v0.29.0) — see invalidateSessionWikiId. */
const scopeListeners = new Set<(sessionId?: string) => void>()

/**
 * The wiki id this session is scoped to, or `undefined` for the default wiki.
 *
 * v0.29.0 — "the default wiki" is now named explicitly in MULTI mode. When a
 * session has no explicit scope, the host still serves its `tiddlywiki_*` calls
 * from the registry default; the reply-stream card therefore shows THAT wiki's
 * content, and its links must open THAT wiki. Previously this returned
 * `undefined` for "no explicit scope", so with the session on the default wiki
 * and the GUI focused on another one, a link inside the card (and inside the
 * 「知识库」tab) opened the FOCUSED wiki — the v0.28.11 report, only half fixed
 * (the card's own 「在 TW 打开」 button was already correct because it passes the
 * resolved default). Single mode keeps returning `undefined`, so its DOM and
 * URLs are byte-identical to what they were before multi-wiki.
 */
export async function resolveSessionWikiId(sessionId: string | undefined): Promise<string | undefined> {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const hit = cache.get(sessionId)
  if (hit !== undefined && Date.now() - hit.at <= SCOPE_TTL_MS) return hit.wikiId
  const inFlight = pending.get(sessionId)
  if (inFlight !== undefined) return (await inFlight).wikiId

  const read = (async (): Promise<ScopeEntry> => {
    const miss: ScopeEntry = { wikiId: undefined, scope: undefined, resolved: undefined, at: 0 }
    try {
      const res = await fetch(
        `${SESSION_WIKI_ENDPOINT}?session=${encodeURIComponent(sessionId)}`,
        { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      )
      if (!res.ok) return miss
      const payload = (await res.json().catch(() => null)) as { scope?: unknown; resolved?: { id?: unknown }; mode?: unknown } | null
      const explicit = typeof payload?.scope === 'string' && payload.scope.length > 0 ? payload.scope : undefined
      const resolvedId = payload?.resolved?.id
      const resolved = typeof resolvedId === 'string' && resolvedId.length > 0 ? resolvedId : undefined
      const wikiId = explicit !== undefined
        ? explicit
        : (payload?.mode === 'multi' && resolved !== undefined ? resolved : undefined)
      return { wikiId, scope: explicit, resolved, at: Date.now() }
    } catch {
      return miss
    } finally {
      pending.delete(sessionId)
    }
  })()
  pending.set(sessionId, read)
  const entry = await read
  // `at: 0` marks a FAILED read: caching it would freeze "no scope" for a whole
  // TTL after one network hiccup. Only a real answer is trusted for a TTL.
  if (entry.at > 0) cache.set(sessionId, entry)
  return entry.wikiId
}

/** A synchronous view of one session's cached scope. */
export interface SessionWikiScopePeek {
  /** False when nothing has been read for this session yet (or the read failed). */
  ready: boolean
  /** Explicit scope id, absent when the session follows the registry default. */
  scope?: string
  /** The wiki the host resolved as effective, when it named one. */
  resolved?: string
}

/**
 * Read the cached scope WITHOUT awaiting anything (v0.35.0).
 *
 * WHY this exists: DSH 0.2.2's session context menu resolves its rows
 * synchronously inside a 1s host budget, and awaiting `/session/wiki` there
 * would either miss the budget or freeze the menu. The menu therefore reads
 * this snapshot and, on a miss, fires `resolveSessionWikiId()` in the
 * background so the NEXT open has data.
 *
 * A session with no fresh entry reports `ready: false` — deliberately NOT
 * "no scope", because the two mean different things in the menu (one shows
 * 「跟随默认」 as active, the other shows nothing at all and retries later).
 */
export function peekSessionWikiScope(sessionId: string | undefined): SessionWikiScopePeek {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return { ready: false }
  const hit = cache.get(sessionId)
  if (hit === undefined || Date.now() - hit.at > SCOPE_TTL_MS) return { ready: false }
  return {
    ready: true,
    ...(hit.scope === undefined ? {} : { scope: hit.scope }),
    ...(hit.resolved === undefined ? {} : { resolved: hit.resolved }),
  }
}

/**
 * Drop the cached scope for one session, or all of them.
 *
 * The selector (wiki-scope-dock.ts) calls this right after a successful switch,
 * so the cards rendered next reflect the new knowledge base instead of waiting
 * out the TTL — a stale entry here is the same "card shows another wiki's data"
 * bug this module exists to fix.
 *
 * v0.29.0 also NOTIFIES subscribers: invalidating the id is enough for a card
 * that re-renders anyway, but the 「知识库」 tab caches a whole generated summary
 * for 3 minutes (`session-summary.ts`), so without a signal it kept showing the
 * previous wiki's notes (and its `data-dsh-tw-wiki`) after a switch.
 */
export function invalidateSessionWikiId(sessionId?: string): void {
  if (typeof sessionId === 'string' && sessionId.length > 0) cache.delete(sessionId)
  else cache.clear()
  const id = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
  for (const listener of [...scopeListeners]) listener(id)
}

/**
 * Subscribe to scope invalidations (one arg = the session, `undefined` = all).
 *
 * Returns the unsubscribe function; callers are React effects, so they must
 * clean up on unmount like every other listener in this half.
 */
export function subscribeSessionWikiId(listener: (sessionId?: string) => void): () => void {
  scopeListeners.add(listener)
  return () => { scopeListeners.delete(listener) }
}

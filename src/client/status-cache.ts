/**
 * Shared `/dsh-tiddlywiki/status` reader (v0.19.5).
 *
 * WHY: four independent surfaces (center panel, rightbar/side frames, sync
 * button, quick-note config reader) each carried their own `fetchStatus()` — on
 * mount they all fired at once, and every call makes the HOST run up to five
 * `git` subprocesses (its own 2s cache only helps inside one request window).
 * One module with a short TTL plus IN-FLIGHT COALESCING means a burst of
 * consumers shares a single HTTP request, which also keeps the git probe count
 * predictable.
 *
 * The cache holds the PROMISE (not the value) so concurrent callers await the
 * same request; a rejection is never cached.
 *
 * @module dsh-tiddlywiki/client/status-cache
 */
import { STATUS_ENDPOINT } from './endpoints.ts'

/** The subset of the host status payload the client surfaces consume. */
export interface StatusPayload {
  ok?: boolean
  status: string
  url?: string
  /** Same-origin TW proxy path (e.g. /dsh-tiddlywiki/tw/); the iframe base. */
  twProxy?: string
  wikiPath?: string
  error?: string
  git?: {
    exists?: boolean
    branch?: string
    dirty?: boolean
    dirtyFiles?: string[]
    remote?: string
    lastCommit?: string
    ahead?: number
    behind?: number
  }
  note?: { tag?: string }
  ui?: {
    showQuickNote?: boolean
    showQuickNoteDock?: boolean
    quickNoteMode?: 'native' | 'card'
    sidebarLabel?: string
    showPanelStatus?: boolean
    showSyncButton?: boolean
    followDshTheme?: boolean
    darkPalette?: string
    tabLabel?: string
    showSessionTab?: boolean
    showRightbarTab?: boolean
  }
  logs?: string[]
}

/** TTL for the shared status cache (the host itself caches git status 2s). */
const STATUS_TTL_MS = 2_000

let cache: { at: number; value: Promise<StatusPayload | null> } | undefined

/**
 * Fetch `/status`, coalescing concurrent callers and reusing a response for
 * `STATUS_TTL_MS`. Resolves `null` on any transport/HTTP failure (callers keep
 * their existing "treat as offline" behaviour).
 */
export function fetchStatus(): Promise<StatusPayload | null> {
  if (cache !== undefined && Date.now() - cache.at < STATUS_TTL_MS) return cache.value
  const pending = (async (): Promise<StatusPayload | null> => {
    try {
      const res = await fetch(STATUS_ENDPOINT, { signal: AbortSignal.timeout(8_000) })
      if (!res.ok) return null
      return (await res.json()) as StatusPayload
    } catch {
      return null
    }
  })()
  cache = { at: Date.now(), value: pending }
  // Never keep a failed probe cached for the TTL: the next caller must retry.
  void pending.then((value) => { if (value === null && cache?.value === pending) cache = undefined })
  return pending
}

/** Drop the cached probe (settings saved / explicit refresh). */
export function invalidateStatus(): void {
  cache = undefined
}

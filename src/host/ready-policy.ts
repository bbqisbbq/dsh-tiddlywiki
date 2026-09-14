/**
 * TiddlyWiki child readiness policy (v0.22.5).
 *
 * WHY THIS MODULE EXISTS — the production incident it fixes:
 * a 5000-tiddler / 26MB wiki on a cold file cache needed ~44s from `spawn` to
 * TW's own "Serving on http://127.0.0.1:…" line (verified from the /status ring
 * buffer: spawn 01:43:51 → first stdout 01:44:35). The old code had a single
 * hard 20s deadline, so it threw `wiki server did not become ready in time`,
 * which:
 *   1. aborted the whole startup pipeline (config load / seeds / clip bridge)
 *      even though the wiki WAS coming up;
 *   2. wrote `health = 'failed'` + a sticky error that nothing ever cleared —
 *      no one re-probed after the deadline, so `/status` (panel, FAB, tooltip)
 *      kept reporting a fault while TW served normally.
 *
 * The policy is now three-staged:
 *   soft window  (default 60s, configurable 5s–600s) — ONE warning, keep waiting;
 *   hard window  (3× the soft window)                — the attempt fails;
 *   late watch   (see wiki.ts)                       — a live child that answers
 *                                                      later still clears the fault.
 *
 * The loop is deliberately pure: `probe` / `isAlive` / clock / `sleep` are all
 * injected, so `scripts/verify-ready-policy.mjs` drives it with a virtual clock
 * (no real TW, no wall-clock flakiness).
 *
 * @module dsh-tiddlywiki/host/ready-policy
 */

/** Default soft readiness window: a slow boot only warns, it does not fail. */
export const READY_TIMEOUT_DEFAULT_MS = 60_000

/** Lower bound accepted from config (below this a big wiki would still be flaky). */
export const READY_TIMEOUT_MIN_MS = 5_000

/** Upper bound accepted from config. */
export const READY_TIMEOUT_MAX_MS = 600_000

/** Hard window = soft × this factor; only then is the attempt declared failed. */
export const READY_HARD_FACTOR = 3

/** Poll cadence while inside the soft window. */
export const READY_POLL_MS = 500

/** Slower cadence once the soft window passed (a slow boot needs patience, not 2 Hz). */
export const READY_SLOW_POLL_MS = 2_000

/**
 * Normalize a configured readiness window. Anything non-finite / non-positive
 * falls back to the default; the result is clamped into [MIN, MAX] so a typo in
 * the settings page can neither fail at 0ms nor hold startup for hours.
 */
export function normalizeReadyTimeoutMs(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : READY_TIMEOUT_DEFAULT_MS
  return Math.min(READY_TIMEOUT_MAX_MS, Math.max(READY_TIMEOUT_MIN_MS, n))
}

/** The hard deadline derived from a (possibly unnormalized) soft window. */
export function readyHardTimeoutMs(softMs: unknown): number {
  return normalizeReadyTimeoutMs(softMs) * READY_HARD_FACTOR
}

export interface ReadyProbeDeps {
  /** One readiness probe; resolve true when /status answered 200. May throw. */
  probe: () => Promise<boolean>
  /** Is the child still alive? false → give up immediately with 'exited'. */
  isAlive: () => boolean
  /** Soft window in ms (normalized/clamped by this module). */
  softTimeoutMs: unknown
  /** Invoked ONCE when the soft window passes with the child still alive. */
  onSlow?: (elapsedMs: number, hardTimeoutMs: number) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type ReadyOutcome = 'ready' | 'exited' | 'timeout'

/**
 * Poll until the child answers, exits, or the hard deadline passes.
 *
 * Returns instead of throwing so the caller owns the health/error bookkeeping;
 * a probe that rejects counts as "not ready yet" (TW closes the socket while it
 * is still loading, and that is not an error).
 */
export async function awaitReady(deps: ReadyProbeDeps): Promise<ReadyOutcome> {
  const now = deps.now ?? ((): number => Date.now())
  const sleep = deps.sleep ?? ((ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms)))
  const soft = normalizeReadyTimeoutMs(deps.softTimeoutMs)
  const hard = soft * READY_HARD_FACTOR
  const startedAt = now()
  let warned = false
  for (;;) {
    if (!deps.isAlive()) return 'exited'
    let ok = false
    try {
      ok = await deps.probe()
    } catch {
      ok = false
    }
    if (ok) return 'ready'
    const elapsed = now() - startedAt
    if (!warned && elapsed >= soft) {
      warned = true
      deps.onSlow?.(elapsed, hard)
    }
    if (elapsed >= hard) return 'timeout'
    await sleep(elapsed >= soft ? READY_SLOW_POLL_MS : READY_POLL_MS)
  }
}

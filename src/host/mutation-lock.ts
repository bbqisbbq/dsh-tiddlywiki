/**
 * The plugin's ONE "a wiki mutation is in flight" lock (v0.30.12).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `/restart` and `/sync` already refused to overlap *with each other* — but each
 * half of the plugin kept its private copy of the flag: `routes.ts` had
 * `mutationInFlight` inside `registerRoutes()`, while `admin-routes.ts` had
 * nothing at all. So the settings page could press 「重启」 (`/admin/restart`)
 * while a `/sync` was draining the syncer queue, or run seeds
 * (`/admin/seeds/run`) while a restart was in flight — exactly the overlap the
 * lock was written to prevent. Two operations that both stop the TW child and
 * both race the same queue must share ONE lock, and "share" has to be visible in
 * the wiring, not a convention.
 *
 * The lock is owned by `index.ts` (one per plugin instance) and passed to BOTH
 * route surfaces, so a third one cannot silently grow its own copy.
 *
 * SEMANTICS: `begin()` returns false when something else holds it (the caller
 * answers 409 with the holder's label, so a user sees 「同步进行中」 instead of a
 * mystery failure). `end(label)` releases ONLY when `label` is the current
 * holder, so "always call it in a `finally`" is safe: a handler whose `begin()`
 * never ran (or failed) cannot hand someone else's lock to the next caller.
 *
 * ⚠️ v0.33.4 — `end()` used to clear the holder unconditionally, and
 * `admin-routes-seeds` calls it on EVERY response. The common path there
 * (「重新初始化」 that rewrote nothing ⇒ no restart ⇒ `begin()` never ran) then
 * freed a `/sync` lock mid-flight, letting `/admin/restart` start a second
 * drain + child stop on the same queue — the exact write-loss overlap v0.30.12
 * was built to prevent. Hence the label check (and a guard case for it).
 *
 * @module dsh-tiddlywiki/host/mutation-lock
 */

export interface MutationLock {
  /**
   * Try to take the lock. Returns `false` (and does NOT take it) when another
   * mutation is in flight; `current()` then names it.
   */
  begin: (label: string) => boolean
  /**
   * Release it. Pass the SAME label the `begin()` was called with: a mismatched
   * label is ignored, so releasing is safe in a `finally` even when `begin()`
   * returned false (or was never reached).
   */
  end: (label?: string) => void
  /** The label of the mutation currently in flight, if any. */
  current: () => string | undefined
}

export function createMutationLock(): MutationLock {
  let inFlight: string | undefined
  return {
    begin: (label: string): boolean => {
      if (inFlight !== undefined) return false
      inFlight = label
      return true
    },
    end: (label?: string): void => {
      // `label === undefined` keeps the pre-v0.33.4 call shape working for a
      // harness that holds the only lock it knows about. When a label IS given
      // it must match the holder, which is what makes `finally` safe: a
      // handler whose `begin()` never ran cannot free someone else's lock.
      if (label !== undefined && inFlight !== label) return
      inFlight = undefined
    },
    current: (): string | undefined => inFlight,
  }
}

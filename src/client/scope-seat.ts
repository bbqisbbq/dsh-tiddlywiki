/**
 * Where the per-session knowledge-base selector is MOUNTED (v0.28.8).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The selector needs two different homes, because "pick a wiki" happens in two
 * different places:
 *
 *   1. **A blank (new) session** — the user is choosing a mode/preset before any
 *      message exists. The right seat is the input-selector context row, next to
 *      the mode picker: `conversation.input.selector.context`. The author asked
 *      for exactly this ("像 dsh-client-ui-git-graph 在模式选择后面增加个知识库选择",
 *      feedback item 9), and that plugin is the reference implementation for how
 *      to reach it.
 *   2. **An active session** — the selector must keep working where v0.28.0 put
 *      it, inside the quick-note row (`conversation.input.dock`), because the
 *      context row does not exist for an active session.
 *
 * The context seat is declared by SOME shells and not others: the running
 * `dsh web` shell renders it, while the published SDK cohort dropped the hole
 * (git-graph carries the same note). Registering into an undeclared slot THROWS,
 * so both seats go through `slots.inject(...)` — the declaration-aware path —
 * rather than a bare `register()`. We additionally verify this shell's live slot
 * tree at runtime: `cordis_inspect_query` on the running DSH reports
 * `conversation.input.selector.context` as `available: false` on the version
 * installed here, which is why the fallback is the COMMON path today and must
 * stay correct rather than being a rarely-exercised contingency.
 *
 * @module dsh-tiddlywiki/client/scope-seat
 */

/** Structural face of the two seats we mount into (kept local: no SDK types). */
export interface ScopeSeatSlots {
  inject(name: string, register: () => unknown): (() => void) | undefined
  register(opts: { name: string; id: string; order?: number; label?: string }, component: unknown): () => void
}

/** The blank-session input-selector context row (the mode picker's neighbour). */
export const SELECTOR_CONTEXT_SLOT = 'conversation.input.selector.context'

/** The full-width dock above the composer (where the selector lives since v0.28.0). */
export const INPUT_DOCK_SLOT = 'conversation.input.dock'

/**
 * How long to wait for the selector-context declaration before assuming this
 * shell does not have it. Covers the shell's first render of the input selector
 * row after the conversation service is up (mirrors git-graph's 2000ms).
 */
export const CONTEXT_FALLBACK_MS = 2000

/**
 * Register the knowledge-base chip into the best available seat.
 *
 * Returns a disposer that tears down BOTH the winning registration and any
 * still-pending wait, so a disposal during the fallback window cannot leak a
 * timer or double-mount.
 *
 * @param slots - the client slots registry.
 * @param chip - factory for the chip component (receives the slot props).
 */
export function mountScopeSeat(slots: ScopeSeatSlots, chip: unknown): () => void {
  let disposed = false
  let mounted = false
  let fallbackTimer: number | undefined
  const removers: Array<() => void> = []

  /** Give up on the context seat and use the dock instead (exactly once). */
  const fallbackToDock = (): void => {
    if (disposed || mounted) return
    const remove = slots.inject(INPUT_DOCK_SLOT, () => {
      if (disposed) return () => {}
      return slots.register(
        { name: INPUT_DOCK_SLOT, id: 'wiki-scope', order: 9, label: '知识库' },
        chip,
      )
    })
    if (remove !== undefined) removers.push(remove)
  }

  const disposeContextWait = slots.inject(SELECTOR_CONTEXT_SLOT, () => {
    if (disposed) return () => {}
    mounted = true
    // The declaration arrived, so the dock fallback must never also mount.
    if (fallbackTimer !== undefined) {
      window.clearTimeout(fallbackTimer)
      fallbackTimer = undefined
    }
    try {
      return slots.register(
        { name: SELECTOR_CONTEXT_SLOT, id: 'wiki-scope', order: 9, label: '知识库' },
        chip,
      )
    } catch {
      // The slot was declared but this shell still refuses it (an older SDK
      // whose SlotCore rejects undeclared names): fall back rather than losing
      // the selector entirely.
      mounted = false
      fallbackToDock()
      return () => {}
    }
  })
  if (disposeContextWait !== undefined) removers.push(disposeContextWait)

  fallbackTimer = window.setTimeout(() => {
    fallbackTimer = undefined
    fallbackToDock()
  }, CONTEXT_FALLBACK_MS)

  return () => {
    disposed = true
    if (fallbackTimer !== undefined) {
      window.clearTimeout(fallbackTimer)
      fallbackTimer = undefined
    }
    for (const remove of removers.splice(0)) remove()
  }
}

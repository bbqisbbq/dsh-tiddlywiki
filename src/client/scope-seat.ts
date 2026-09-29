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
 *   2. **Everywhere else** — the selector keeps working where v0.28.0 put it:
 *      inside the quick-note row (`conversation.input.dock`), rendered by
 *      `createWikiScopeDock()` as that entry's `scope` child (v0.28.7 — the dock
 *      is a vertical flex column, so the selector must NOT be its own entry, or
 *      the two rows can never line up).
 *
 * ONE SELECTOR AT A TIME (v0.28.11)
 * ---------------------------------
 * The context seat is an UPGRADE for blank sessions, never a second copy. This
 * module therefore:
 *
 *   · registers into the context row when the shell declares it, and
 *   · publishes that fact through `isBlankSeatMounted()` / `subscribeBlankSeat()`,
 *     which the dock's inline selector consults: for a blank session it stands
 *     down while the context chip owns the seat.
 *
 * The v0.28.8 code instead fell back to registering a SECOND
 * `conversation.input.dock` entry (blank-only) when the context slot was not
 * declared — which is the common case today. Both copies then rendered in a new
 * session: the one inside the quick-note row and the standalone one. That is the
 * author's 2026-09-29 report 「开启新会话时有两个知识库选择」, and the fallback is
 * gone: the dock already carries the selector, so there is nothing to fall back
 * TO. If the context row never appears, the inline one simply stays.
 *
 * @module dsh-tiddlywiki/client/scope-seat
 */

/** Structural face of the seat we mount into (kept local: no SDK types). */
export interface ScopeSeatSlots {
  inject(name: string, register: () => unknown): (() => void) | undefined
  register(opts: { name: string; id: string; order?: number; label?: string }, component: unknown): () => void
}

/** The blank-session input-selector context row (the mode picker's neighbour). */
export const SELECTOR_CONTEXT_SLOT = 'conversation.input.selector.context'

/** Whether a blank-session chip currently owns the selector (see the module doc). */
let blankSeatMounted = false
const blankSeatListeners = new Set<() => void>()

/** True while the context row is carrying the selector for blank sessions. */
export function isBlankSeatMounted(): boolean {
  return blankSeatMounted
}

/** Subscribe to ownership changes; returns the unsubscribe function. */
export function subscribeBlankSeat(listener: () => void): () => void {
  blankSeatListeners.add(listener)
  return () => { blankSeatListeners.delete(listener) }
}

function setBlankSeatMounted(next: boolean): void {
  if (next === blankSeatMounted) return
  blankSeatMounted = next
  // Iterate a copy: a listener may unsubscribe itself while we are notifying.
  for (const listener of [...blankSeatListeners]) listener()
}

/**
 * Register the knowledge-base chip into the best available seat.
 *
 * Returns a disposer that tears down the registration (and gives the seat back
 * to the dock's inline selector, so an unloaded plugin cannot leave blank
 * sessions without any selector).
 *
 * @param slots - the client slots registry.
 * @param chip - factory for the chip component (receives the slot props). MUST
 *   render only for blank sessions (`createWikiScopeDock({ blankOnly: true })`),
 *   otherwise an active session would show a second selector here.
 */
export function mountScopeSeat(slots: ScopeSeatSlots, chip: unknown): () => void {
  let disposed = false
  const remove = slots.inject(SELECTOR_CONTEXT_SLOT, () => {
    if (disposed) return () => {}
    // 这一格真的挂上了：dock 里那个选择器在**空白会话**里必须让位。
    setBlankSeatMounted(true)
    try {
      return slots.register(
        { name: SELECTOR_CONTEXT_SLOT, id: 'wiki-scope', order: 9, label: '知识库' },
        chip,
      )
    } catch {
      // The slot was declared but this shell still refuses it (an older SDK
      // whose SlotCore rejects undeclared names). The dock's inline selector is
      // still there, so just hand the seat back instead of mounting a second
      // dock entry (that second entry is exactly the duplicate this module's
      // header describes).
      setBlankSeatMounted(false)
      return () => {}
    }
  })

  return () => {
    disposed = true
    setBlankSeatMounted(false)
    if (remove !== undefined) remove()
  }
}

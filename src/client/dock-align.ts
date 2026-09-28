/**
 * Align a `conversation.input.dock` entry with the composer input card.
 *
 * WHY THIS EXISTS (v0.28.2)
 * -------------------------
 * The dock slot renders entries as a full-width flex column that is a SIBLING of
 * the composer, not inside it. The composer's input card is centred and has its
 * own max-width, so an entry's right edge sits far to the right of the input box
 * — visibly misaligned.
 *
 * The fix is to measure the composer card and pad the entry's right side by the
 * difference. That measurement used to live only inside `quick-note-dock.ts`, so
 * the moment a SECOND dock entry was added (the per-session knowledge-base
 * selector) it simply did not align — nobody had published the rule. This module
 * is that rule, written once.
 *
 * HOW IT FINDS THE CARD
 * ---------------------
 * Climb from the entry until an ancestor's subtree contains a wide text field
 * (>300px — the composer input; dock entries' own inputs are small), then take
 * the widest box between that field and its containing column (the visible card).
 *
 * WHEN IT RE-MEASURES
 * -------------------
 * ResizeObserver on the whole ancestor chain up to the conversation root
 * (`[data-phase]`), plus `resize` / `visibilitychange`, plus a short self-healing
 * interval that stops once the layout has measured cleanly three times (or after
 * 20 tries, so a shell we cannot understand never leaks a timer).
 *
 * @module dsh-tiddlywiki/client/dock-align
 */

/** The measurement/padding key, exported so the gate can assert on it. */
export const DOCK_ALIGN_MIN_INPUT_WIDTH = 300

/**
 * Start aligning `wrap` with the composer input card. Returns the disposer; call
 * it from the component's effect cleanup.
 *
 * A React ref is intentionally NOT taken: the caller passes its own element, so
 * this works for any dock entry regardless of how it renders.
 */
export function alignDockEntry(wrap: HTMLElement): () => void {
  /** Find the composer input CARD (see the module doc for the algorithm). */
  const findCard = (): HTMLElement | null => {
    let input: Element | null = null
    let column: HTMLElement | null = null
    let node: HTMLElement | null = wrap
    while (node !== null && node !== document.documentElement) {
      node = node.parentElement
      if (node === null) break
      for (const el of node.querySelectorAll('textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) {
        if (el.getBoundingClientRect().width > DOCK_ALIGN_MIN_INPUT_WIDTH) { input = el; column = node; break }
      }
      if (column !== null) break
    }
    if (input === null || column === null) return null
    const colW = column.getBoundingClientRect().width
    let cur: HTMLElement | null = input as HTMLElement
    let card: HTMLElement | null = null
    let cardW = 0
    while (cur !== null && cur !== column) {
      const w = cur.getBoundingClientRect().width
      if (w > 0 && w < colW - 8 && w >= cardW) { cardW = w; card = cur }
      cur = cur.parentElement
    }
    return card
  }

  /** Measure once; returns true when the composer card was found (valid measure). */
  const align = (): boolean => {
    const wrapRect = wrap.getBoundingClientRect()
    const card = findCard()
    const right = card !== null ? card.getBoundingClientRect().right : wrapRect.right
    const pad = Math.max(0, wrapRect.right - right)
    if (wrap.style.paddingRight !== `${pad}px`) wrap.style.paddingRight = `${pad}px`
    return card !== null
  }

  align()
  // A sidebar toggle changes the conversation column width → the centred,
  // max-width composer card moves → the padding must be re-measured. Observing
  // only the dock container misses that (it may not resize at all), so observe
  // the whole ancestor chain up to the conversation root.
  const ro = new ResizeObserver(() => { align() })
  let node: Element | null = wrap
  while (node !== null && node !== document.documentElement) {
    ro.observe(node)
    if (node instanceof HTMLElement && node.hasAttribute('data-phase')) break
    node = node.parentElement
  }
  window.addEventListener('resize', align)
  document.addEventListener('visibilitychange', align)

  // Self-healing fallback for layout changes we cannot observe. Each tick is a
  // few getBoundingClientRect reads. It stops after 3 clean measurements, and
  // gives up after 20 tries so an unrecognisable shell cannot leak a timer.
  let guardHits = 0
  let guardTicks = 0
  const guard = window.setInterval(() => {
    guardTicks++
    if (!align()) {
      if (guardTicks >= 20) window.clearInterval(guard)
      return
    }
    guardHits++
    if (guardHits >= 3) window.clearInterval(guard)
  }, 1500)
  // The composer card may mount slightly later; re-measure a couple of times.
  const t1 = window.setTimeout(align, 120)
  const t2 = window.setTimeout(align, 600)

  return () => {
    ro.disconnect()
    window.removeEventListener('resize', align)
    document.removeEventListener('visibilitychange', align)
    window.clearInterval(guard)
    window.clearTimeout(t1)
    window.clearTimeout(t2)
  }
}

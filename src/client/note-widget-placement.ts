/**
 * Where the quick-note card sits on screen — and how it is dragged around.
 *
 * Extracted from `note-widget.ts` (v0.30.43) with the `tw-frame-hash.ts` recipe.
 * The boundary was picked by asking "what does this code need from the card?":
 * both halves touch **only DOM elements and their own private state** — no wiki
 * roster, no draft, no save/token state at all. So they need no accessors and no
 * setters: `positionCard()` is a pure 3-argument function and the drag installer
 * takes the four elements it wires.
 *
 * ⚠️ Two details that are easy to "clean up" into a bug:
 *   1. `positionCard()` runs on EVERY open, so a dragged position is deliberately
 *      **not** remembered across close/open (the next open re-anchors). Nothing
 *      here may grow persistence without re-deciding that.
 *   2. The drag listeners are attached to elements that `dispose()` removes from
 *      the DOM, so there is no uninstall step on purpose — do not add one that
 *      only pretends to matter.
 *
 * @module dsh-tiddlywiki/client/note-widget-placement
 */

/**
 * Place the card: with an anchor (the input-dock button) it pops up right
 * ABOVE the anchor, horizontally centered on it and clamped inside the
 * viewport; without one it returns to the default bottom-right corner.
 * The card is `position: fixed`, so switching between left/top and
 * right/bottom positioning is a matter of which inline offsets are set.
 */
export function positionCard(root: HTMLElement, card: HTMLElement, anchor?: HTMLElement): void {
  if (anchor !== undefined) {
    const rect = anchor.getBoundingClientRect()
    const cardW = card.offsetWidth || 340
    const cardH = card.offsetHeight || 260
    const vw = window.innerWidth
    const vh = window.innerHeight
    const gap = 10
    const left = Math.min(Math.max(rect.left + rect.width / 2 - cardW / 2, 8), Math.max(8, vw - cardW - 8))
    const bottomRaw = vh - rect.top + gap
    const bottom = Math.min(Math.max(8, bottomRaw), Math.max(8, vh - cardH - 8))
    root.style.right = 'auto'
    root.style.top = 'auto'
    root.style.left = `${left}px`
    root.style.bottom = `${bottom}px`
  } else {
    root.style.right = '24px'
    root.style.bottom = '88px'
    root.style.left = 'auto'
    root.style.top = 'auto'
  }
}

/** The four elements the drag wiring needs (all created by the card's build()). */
export interface CardDragDeps {
  root: HTMLElement
  card: HTMLElement
  head: HTMLElement
  closeBtn: HTMLElement
}

/**
 * 自由拖动（按住标题栏拖动整张卡片；✕ 仍是唯一关闭方式）。
 *
 * Pointer events + setPointerCapture: the head keeps receiving moves even
 * when the pointer leaves it. Dragging switches the card from the default
 * right/bottom anchoring to explicit left/top, clamped to the viewport.
 *
 * The in-flight gesture (`dragState`) is PRIVATE to this function — the card
 * neither reads nor writes it, which is why nothing has to be passed back out.
 */
export function installCardDrag(deps: CardDragDeps): void {
  const { root, card, head, closeBtn } = deps
  let dragState: { startX: number; startY: number; origLeft: number; origTop: number; moved: boolean } | null = null
  const applyDrag = (left: number, top: number): void => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const cardW = card.offsetWidth || 340
    const cardH = card.offsetHeight || 260
    const x = Math.min(Math.max(left, 8), Math.max(8, vw - cardW - 8))
    const y = Math.min(Math.max(top, 8), Math.max(8, vh - cardH - 8))
    root.style.right = 'auto'
    root.style.bottom = 'auto'
    root.style.left = `${x}px`
    root.style.top = `${y}px`
  }
  head.addEventListener('pointerdown', (event) => {
    if (closeBtn.contains(event.target as Node)) return
    event.preventDefault()
    const rect = root.getBoundingClientRect()
    dragState = { startX: event.clientX, startY: event.clientY, origLeft: rect.left, origTop: rect.top, moved: false }
    try { head.setPointerCapture(event.pointerId) } catch { /* capture unavailable */ }
    head.classList.add('dsh-tw-note-head-dragging')
  })
  head.addEventListener('pointermove', (event) => {
    if (dragState === null) return
    const dx = event.clientX - dragState.startX
    const dy = event.clientY - dragState.startY
    if (!dragState.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return
    dragState.moved = true
    applyDrag(dragState.origLeft + dx, dragState.origTop + dy)
  })
  const endDrag = (event: PointerEvent): void => {
    if (dragState === null) return
    try { head.releasePointerCapture(event.pointerId) } catch { /* already released */ }
    dragState = null
    head.classList.remove('dsh-tw-note-head-dragging')
  }
  head.addEventListener('pointerup', endDrag)
  head.addEventListener('pointercancel', endDrag)
}

/**
 * Floating popup iframe that loads TiddlyWiki's NATIVE editor for a draft
 * (quick-note "✏️ 在 TW 中编辑"). A small draggable + resizable overlay with its
 * own iframe pointed at `twUrl#<draftTitle>`: the fragment-only navigation
 * triggers TW's hashchange, which opens the draft in the story, and because the
 * draft tiddler carries `draft.of` the story renders the native EditTemplate.
 *
 * Independent of the center panel — a separate floating window so the user can
 * edit a note without leaving the chat context.
 *
 * @module dsh-tiddlywiki/client/editor-popup
 */
import { attachThemeSync } from './theme-sync.ts'
import { ACTIVATE_EVENT } from './tw-frame.ts'

/**
 * This popup's identity in the `dsh-panel-activate` protocol: opening it
 * closes the center panel / rightbar TW tab, and any other surface activating
 * closes this popup (one TW client at a time — several TW editors writing the
 * same draft would last-write-wins each other).
 */
const EDITOR_POPUP_PANEL_NAME = 'dsh-tiddlywiki/editor-popup'

let root: HTMLDivElement | undefined
let frame: HTMLIFrameElement | undefined
let titleEl: HTMLSpanElement | undefined
let themeSyncDispose: (() => void) | undefined
let onKeyDown: ((event: KeyboardEvent) => void) | undefined
let onActivate: ((event: Event) => void) | undefined

/** Open (create on first use) the popup and load `url` (twUrl#draftTitle). */
export function openEditorPopup(url: string, label: string): void {
  ensurePopup()
  if (root === undefined || frame === undefined) return
  if (titleEl !== undefined) titleEl.textContent = `TiddlyWiki 编辑器 · ${label}`
  root.style.display = ''
  // 与中央面板/右栏 Tab 互斥：打开即广播本弹窗的身份，让其它 TW 客户端自行关闭。
  document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: EDITOR_POPUP_PANEL_NAME }))
  // Only set the src when the url actually changed: the host reuses the draft
  // tiddler for a title, so re-opening the same draft yields the SAME url — and
  // assigning an identical src reloads the whole iframe (TW re-boots, losing
  // the draft/scroll/undo state). A same-base hash change is enough for TW.
  if (frame.dataset.loaded !== url) {
    frame.dataset.loaded = url
    frame.src = url
  }
  // 打开后把焦点移入弹窗（首个可聚焦元素 = 标题栏的关闭按钮）。
  focusFirstInPopup()
}

/** Whether the popup is currently visible. */
export function isEditorPopupOpen(): boolean {
  return root !== undefined && root.style.display !== 'none'
}

/**
 * 把焦点移入弹窗的首个可聚焦元素（无障碍：键盘用户打开后能直接操作弹窗；
 * 刻意不做焦点陷阱，Esc / ✕ / Tab 顺序保持原生行为）。
 */
function focusFirstInPopup(): void {
  if (root === undefined) return
  const first = root.querySelector<HTMLElement>(
    'button, [href], input, select, textarea, iframe, [tabindex]:not([tabindex="-1"])',
  )
  first?.focus()
}

/** Hide the popup (the ✕ button and the input-dock toggle call this). */
export function closeEditorPopup(): void {
  if (root !== undefined) root.style.display = 'none'
}

/** Remove the popup DOM entirely (plugin dispose). */
export function disposeEditorPopup(): void {
  themeSyncDispose?.()
  themeSyncDispose = undefined
  if (onKeyDown !== undefined) {
    document.removeEventListener('keydown', onKeyDown)
    onKeyDown = undefined
  }
  if (onActivate !== undefined) {
    document.removeEventListener(ACTIVATE_EVENT, onActivate)
    onActivate = undefined
  }
  root?.remove()
  root = undefined
  frame = undefined
  titleEl = undefined
}

function ensurePopup(): void {
  if (root !== undefined && frame !== undefined) return

  root = document.createElement('div')
  root.className = 'dsh-tw-editor-popup'
  root.style.display = 'none'
  // 无障碍语义：浮层是一个模态对话框（不做焦点陷阱，只声明语义 + 打开时移焦）。
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-label', 'TiddlyWiki 编辑器')

  const bar = document.createElement('div')
  bar.className = 'dsh-tw-editor-bar'
  titleEl = document.createElement('span')
  titleEl.className = 'dsh-tw-editor-title'
  titleEl.textContent = 'TiddlyWiki 编辑器'
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'dsh-tw-editor-close'
  close.textContent = '✕'
  close.title = '关闭'
  bar.append(titleEl, close)

  frame = document.createElement('iframe')
  frame.className = 'dsh-tw-editor-frame'
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups')
  frame.title = 'TiddlyWiki 编辑器'
  // Same-origin sandbox keeps $tw reachable; let the popup follow DSH theme.
  themeSyncDispose = attachThemeSync(frame)

  const resize = document.createElement('div')
  resize.className = 'dsh-tw-editor-resize'
  resize.title = '拖拽调整大小'

  root.append(bar, frame, resize)
  document.body.append(root)

  close.addEventListener('click', () => closeEditorPopup())

  // Esc closes the popup too (when the parent document has focus — inside the
  // iframe TW's own editor shortcuts take precedence).
  onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && isEditorPopupOpen()) closeEditorPopup()
  }
  document.addEventListener('keydown', onKeyDown)

  // 互斥协议的另一半：中央面板 / 右栏 Tab 打开时（detail 是别人的名字）把自己关掉。
  onActivate = (event: Event): void => {
    const detail = (event as CustomEvent).detail
    if (detail !== EDITOR_POPUP_PANEL_NAME && isEditorPopupOpen()) closeEditorPopup()
  }
  document.addEventListener(ACTIVATE_EVENT, onActivate)

  // Drag by the title bar (un-center by setting explicit left/top + margin 0).
  // Pointer Events + setPointerCapture: the pointer is captured by the bar, so
  // pointermove/pointerup keep firing on it even over the iframe or outside the
  // window — no window-level listeners, hence nothing to leak on a lost mouseup.
  // The ✕ close button must be EXCLUDED: this handler calls preventDefault(),
  // and a canceled pointerdown suppresses the derived click event entirely (the
  // note-card drag handler guards the same way) — otherwise the popup could
  // never be closed. Same for any other focusable control on the bar.
  bar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || root === undefined) return
    const target = event.target as Node
    if (close.contains(target)) return
    event.preventDefault()
    bar.setPointerCapture(event.pointerId)
    const rect = root.getBoundingClientRect()
    const startX = event.clientX
    const startY = event.clientY
    const baseLeft = rect.left
    const baseTop = rect.top
    const onMove = (ev: PointerEvent): void => {
      if (root === undefined) return
      root.style.left = `${baseLeft + ev.clientX - startX}px`
      root.style.top = `${baseTop + ev.clientY - startY}px`
      root.style.margin = '0'
      root.style.right = 'auto'
      root.style.bottom = 'auto'
    }
    const onUp = (): void => {
      bar.removeEventListener('pointermove', onMove)
      bar.removeEventListener('pointerup', onUp)
      bar.removeEventListener('pointercancel', onUp)
    }
    bar.addEventListener('pointermove', onMove)
    bar.addEventListener('pointerup', onUp)
    bar.addEventListener('pointercancel', onUp)
  })

  // Resize from the bottom-right corner.
  resize.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || root === undefined) return
    event.preventDefault()
    event.stopPropagation()
    resize.setPointerCapture(event.pointerId)
    const rect = root.getBoundingClientRect()
    const startX = event.clientX
    const startY = event.clientY
    const baseW = rect.width
    const baseH = rect.height
    const onMove = (ev: PointerEvent): void => {
      if (root === undefined) return
      root.style.width = `${Math.max(360, baseW + ev.clientX - startX)}px`
      root.style.height = `${Math.max(260, baseH + ev.clientY - startY)}px`
      root.style.right = 'auto'
      root.style.bottom = 'auto'
    }
    const onUp = (): void => {
      resize.removeEventListener('pointermove', onMove)
      resize.removeEventListener('pointerup', onUp)
      resize.removeEventListener('pointercancel', onUp)
    }
    resize.addEventListener('pointermove', onMove)
    resize.addEventListener('pointerup', onUp)
    resize.addEventListener('pointercancel', onUp)
  })
}

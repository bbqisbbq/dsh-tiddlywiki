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

let root: HTMLDivElement | undefined
let frame: HTMLIFrameElement | undefined
let titleEl: HTMLSpanElement | undefined

/** Open (create on first use) the popup and load `url` (twUrl#draftTitle). */
export function openEditorPopup(url: string, label: string): void {
  ensurePopup()
  if (root === undefined || frame === undefined) return
  if (titleEl !== undefined) titleEl.textContent = `TiddlyWiki 编辑器 · ${label}`
  root.style.display = ''
  // Same-base fragment navigation reloads nothing; a changed base (restart on a
  // new port) reloads the app and TW still opens the draft from the hash.
  frame.src = url
}

/** Remove the popup DOM entirely (plugin dispose). */
export function disposeEditorPopup(): void {
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

  const resize = document.createElement('div')
  resize.className = 'dsh-tw-editor-resize'
  resize.title = '拖拽调整大小'

  root.append(bar, frame, resize)
  document.body.append(root)

  close.addEventListener('click', () => {
    if (root !== undefined) root.style.display = 'none'
  })

  // Drag by the title bar (un-center by setting explicit left/top + margin 0).
  bar.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || root === undefined) return
    event.preventDefault()
    const rect = root.getBoundingClientRect()
    const startX = event.clientX
    const startY = event.clientY
    const baseLeft = rect.left
    const baseTop = rect.top
    const onMove = (ev: MouseEvent): void => {
      if (root === undefined) return
      root.style.left = `${baseLeft + ev.clientX - startX}px`
      root.style.top = `${baseTop + ev.clientY - startY}px`
      root.style.margin = '0'
      root.style.right = 'auto'
      root.style.bottom = 'auto'
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  })

  // Resize from the bottom-right corner.
  resize.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || root === undefined) return
    event.preventDefault()
    event.stopPropagation()
    const rect = root.getBoundingClientRect()
    const startX = event.clientX
    const startY = event.clientY
    const baseW = rect.width
    const baseH = rect.height
    const onMove = (ev: MouseEvent): void => {
      if (root === undefined) return
      root.style.width = `${Math.max(360, baseW + ev.clientX - startX)}px`
      root.style.height = `${Math.max(260, baseH + ev.clientY - startY)}px`
      root.style.right = 'auto'
      root.style.bottom = 'auto'
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  })
}

/**
 * Center-column TiddlyWiki editor panel (design doc §12).
 *
 * A fixed-position overlay sized to the CENTER column's bounding rect and
 * appended to document.body, so it never depends on the shell's flex/grid
 * height model or on the column being a positioning ancestor (both caused the
 * earlier "half-height, scrollable" symptom). The rect is re-measured on
 * resize, on layout mutations, and on a light interval. While active it hides
 * the conversation content via a stylesheet rule keyed on `data-dsh-tw-active`.
 * Toggling rides the shared PanelState; cross-plugin exclusivity rides the
 * `dsh-panel-activate` event (same protocol as dsh-taskboard).
 *
 * The iframe points DIRECTLY at the TW service (http://127.0.0.1:<port>),
 * bypassing reverse-proxy sensitivity (design doc R1 — proxy is only a
 * fallback). The panel reads /status first and only sets iframe.src when the
 * service is actually running.
 *
 * @module dsh-tiddlywiki/client/panel
 */
import type { PanelState } from './state.ts'
import { ENTRY_SELECTOR } from './sidebar-entry.ts'

export const PANEL_VIEW_SELECTOR = '[data-dsh-tw-view]'

/**
 * Center-column targets, most-specific shell generation first. The official
 * layout shell (dsh-client-ui-layout) drops data-pane and uses a CSS-Module
 * hashed `centerCol`; older shells put `data-pane="conversation"` on the same
 * full-height grid item; DSH Desktop exposes the non-compat
 * `.dshDesktopConversationSurface`.
 */
const COLUMN_SELECTORS = ['[class*="centerCol"]', '[data-pane="conversation"]', '.dshDesktopConversationSurface']

const ACTIVE_ATTR = 'data-dsh-tw-active'
/** Sibling panels' activation attributes, evicted when this panel opens. */
const OTHER_ACTIVE_ATTRS = ['data-dsh-atb-active', 'data-dsh-taskboard-active', 'data-dsh-ssh-active']
/** Cross-plugin activation event; detail is the activating panel name. */
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'dsh-tiddlywiki'

/** Overlay z-index: above the shell content, below the note widget (950). */
const PANEL_Z_INDEX = 40
/** Safety re-measure cadence for shell layout changes CSS can't see. */
const SYNC_INTERVAL_MS = 2_000

const STATUS_ENDPOINT = '/dsh-tiddlywiki/status'
const RESTART_ENDPOINT = '/dsh-tiddlywiki/restart'

interface StatusPayload {
  ok?: boolean
  status: string
  url?: string
  wikiPath?: string
  error?: string
  note?: { tag?: string }
}

function conversationColumn(): HTMLElement | undefined {
  for (const selector of COLUMN_SELECTORS) {
    const el = document.querySelector<HTMLElement>(selector)
    if (el !== null) return el
  }
  return undefined
}

async function fetchStatus(): Promise<StatusPayload | null> {
  try {
    const res = await fetch(STATUS_ENDPOINT, { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) return null
    return (await res.json()) as StatusPayload
  } catch {
    return null
  }
}

async function requestRestart(): Promise<boolean> {
  try {
    const res = await fetch(RESTART_ENDPOINT, { method: 'POST', signal: AbortSignal.timeout(8_000) })
    return res.ok
  } catch {
    return false
  }
}

export function mountPanel(state: PanelState): () => void {
  let container: HTMLDivElement | undefined
  let columnEl: HTMLElement | undefined
  let iframe: HTMLIFrameElement | undefined
  let frameArea: HTMLDivElement | undefined
  let errorArea: HTMLDivElement | undefined
  let chip: HTMLSpanElement | undefined
  let refreshTimer: number | undefined
  let refreshAttempts = 0

  const build = (): HTMLDivElement => {
    const view = document.createElement('div')
    view.dataset.dshTwView = ''
    view.className = 'dsh-tw-view'

    const bar = document.createElement('div')
    bar.className = 'dsh-tw-panel-bar'
    const title = document.createElement('span')
    title.className = 'dsh-tw-panel-title'
    title.textContent = 'TiddlyWiki 知识库'
    chip = document.createElement('span')
    chip.className = 'dsh-tw-status-chip'
    chip.dataset.state = 'unknown'
    chip.textContent = '—'
    const reload = document.createElement('button')
    reload.type = 'button'
    reload.textContent = '重载'
    reload.addEventListener('click', () => {
      if (iframe !== undefined && !iframe.hidden) iframe.src = iframe.src
    })
    const refresh = document.createElement('button')
    refresh.type = 'button'
    refresh.textContent = '状态'
    refresh.addEventListener('click', () => { void doRefresh() })
    bar.append(title, chip, refresh, reload)

    frameArea = document.createElement('div')
    frameArea.className = 'dsh-tw-panel-frame-wrap'
    frameArea.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column'
    iframe = document.createElement('iframe')
    iframe.className = 'dsh-tw-panel-frame'
    iframe.title = 'TiddlyWiki'
    iframe.hidden = true
    frameArea.append(iframe)

    errorArea = document.createElement('div')
    errorArea.className = 'dsh-tw-panel-error'
    errorArea.hidden = true

    view.append(bar, frameArea, errorArea)
    return view
  }

  const setChip = (stateName: string, text: string): void => {
    if (chip === undefined) return
    chip.dataset.state = stateName
    chip.textContent = text
  }

  /** Pin the overlay to the center column's current viewport rect. */
  const syncRect = (): void => {
    if (container === undefined || columnEl === undefined) return
    const rect = columnEl.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return
    const left = `${rect.left}px`
    const top = `${rect.top}px`
    const width = `${rect.width}px`
    const height = `${rect.height}px`
    if (container.style.left !== left) container.style.left = left
    if (container.style.top !== top) container.style.top = top
    if (container.style.width !== width) container.style.width = width
    if (container.style.height !== height) container.style.height = height
  }

  const ensure = (): void => {
    if (container !== undefined) return
    columnEl = conversationColumn()
    if (columnEl === undefined) return
    container = build()
    container.style.position = 'fixed'
    container.style.zIndex = String(PANEL_Z_INDEX)
    document.body.append(container)
    syncRect()
  }

  const showError = (message: string): void => {
    if (iframe === undefined || errorArea === undefined || frameArea === undefined) return
    iframe.hidden = true
    errorArea.hidden = false
    errorArea.textContent = ''
    const p = document.createElement('div')
    p.textContent = 'TiddlyWiki 服务不可用'
    const code = document.createElement('code')
    code.textContent = message
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.textContent = '重试'
    retry.addEventListener('click', () => {
      retry.disabled = true
      retry.textContent = '重启中…'
      void requestRestart().finally(() => { void doRefresh() })
    })
    errorArea.append(p, code, retry)
  }

  const showStarting = (): void => {
    if (iframe === undefined || errorArea === undefined || frameArea === undefined) return
    iframe.hidden = true
    errorArea.hidden = false
    errorArea.textContent = ''
    const p = document.createElement('div')
    p.textContent = 'TiddlyWiki 服务正在启动…'
    errorArea.append(p)
  }

  const showFrame = (url: string): void => {
    if (iframe === undefined || errorArea === undefined) return
    errorArea.hidden = true
    iframe.hidden = false
    // Set the src only when the url actually changed, so an editor in the
    // iframe never loses unsaved state on a status refresh.
    if (iframe.dataset.loaded !== url) {
      iframe.dataset.loaded = url
      iframe.src = url
    }
  }

  const doRefresh = async (): Promise<void> => {
    if (refreshTimer !== undefined) {
      window.clearTimeout(refreshTimer)
      refreshTimer = undefined
    }
    const payload = await fetchStatus()
    if (payload === null) {
      setChip('failed', '状态不可达')
      showError('无法访问 /dsh-tiddlywiki/status')
      return
    }
    if (payload.status === 'running' && typeof payload.url === 'string') {
      setChip('running', '在线')
      refreshAttempts = 0
      showFrame(payload.url)
      return
    }
    if (payload.status === 'starting') {
      setChip('starting', '启动中')
      showStarting()
      // Auto-poll while starting (bounded).
      if (refreshAttempts < 30) {
        refreshAttempts++
        refreshTimer = window.setTimeout(() => { void doRefresh() }, 1_500)
      }
      return
    }
    setChip('failed', '离线')
    refreshAttempts = 0
    showError(payload.error ?? `服务状态：${payload.status}`)
  }

  const applyActive = (): void => {
    if (state.isOpen()) {
      for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr)
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
      void doRefresh()
    } else {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer)
        refreshTimer = undefined
      }
      refreshAttempts = 0
    }
  }
  const onOtherActivate = (event: Event): void => {
    const detail = (event as CustomEvent).detail
    if (detail !== PANEL_NAME && state.isOpen()) state.closePanel()
  }
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!state.isOpen()) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(ENTRY_SELECTOR) !== null) return
    const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'
    if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) state.closePanel()
  }

  // Mount the container once the column exists; self-heal on re-renders.
  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  // Keep the overlay pinned to the column: resize, layout mutations, scroll.
  const resizeObserver = new ResizeObserver(() => syncRect())
  resizeObserver.observe(document.body)
  const syncInterval = window.setInterval(syncRect, SYNC_INTERVAL_MS)
  const onWindowResize = (): void => syncRect()
  window.addEventListener('resize', onWindowResize)
  const onAnyScroll = (): void => syncRect()
  window.addEventListener('scroll', onAnyScroll, true)

  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  const unsubscribe = state.subscribe(applyActive)
  ensure()
  applyActive()

  return () => {
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
    window.clearInterval(syncInterval)
    window.removeEventListener('resize', onWindowResize)
    window.removeEventListener('scroll', onAnyScroll, true)
    resizeObserver.disconnect()
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    unsubscribe()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    container?.remove()
  }
}

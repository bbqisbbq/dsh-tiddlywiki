/**
 * Right-Sidebar TiddlyWiki tab type (v0.17.0).
 *
 * DSH's new right column (dsh-client-ui-sidebar-right) lets plugins register
 * "tab types": stage 1 registers the type into `ctx.sidebarRightTabs` — a
 * guide entry box on the rightbar's home page is the entry point — and stage 2
 * registers the tab's React body into the keyed `sidebar.right.pane.tab` seat
 * under the definition's id. This module does both, guarded at the call site:
 * the whole integration is optional (older DSH / rightbar absent → no-op).
 *
 * The body embeds the SAME-ORIGIN TW proxy (`/dsh-tiddlywiki/tw/`) in an
 * iframe, exactly like the center-column panel. One TW client at a time is
 * enforced: when this tab becomes visible the center overlay (and any sibling
 * overlay panel) closes via the existing `dsh-panel-activate` protocol, and
 * when another panel activates this tab closes itself. Wiki links in the reply
 * stream route here while the tab is visible (see panel.ts openTiddler).
 *
 * The tab body is React only because the slot runtime renders React: the frame
 * is plain DOM built inside a ref host, mirroring the plugin's DOM style.
 *
 * @module dsh-tiddlywiki/client/rightbar-tab
 */
import * as React from 'react'
import { STATUS_ENDPOINT } from './endpoints.ts'
import { attachThemeSync, setThemeSyncConfig } from './theme-sync.ts'

/** The tab kind this package owns; what `openTab` names and the guide entry opens. */
export const TW_RIGHTBAR_KIND = 'dsh-tiddlywiki'
/** This implementation's identity in the tab system: the key its body registers under. */
export const TW_RIGHTBAR_ID = 'dsh-tiddlywiki'
/** Activation-event name for THIS tab (distinct from the center panel's 'dsh-tiddlywiki'). */
const RIGHTBAR_PANEL_NAME = 'dsh-tiddlywiki/rightbar'
/** Cross-plugin activation event; detail is the activating panel name. */
const ACTIVATE_EVENT = 'dsh-panel-activate'
/** The "知识库" FAB's reload event; the rightbar frame reloads with the center one. */
const PANEL_RELOAD_EVENT = 'dsh-tw-panel-reload'

const RESTART_ENDPOINT = '/dsh-tiddlywiki/restart'

/** Tab chip / guide copy default (label refreshed from `/status` ui.tabLabel). */
let rightbarLabel = '知识库'

/** Update the tab chip label from the live config (ui.tabLabel). */
function setLabel(label: string): void {
  const trimmed = typeof label === 'string' ? label.trim() : ''
  if (trimmed.length > 0) rightbarLabel = trimmed
}

/* ── structural faces over the rightbar contract (no @deepseek-ai imports) ── */

interface RightbarTabInfo {
  sidebar: { expanded: boolean; fullscreen: boolean }
  panel: { id: string }
  tab: {
    id: string
    contentId: string
    visible: boolean
    navigation: { address: string; params?: unknown; revision: number }
    signal: AbortSignal
    actions: { close(): void; openTab?(kind: string, options?: unknown): void }
  }
}

type UseRightbarTabInfo = () => RightbarTabInfo

export interface RightbarTabBodyProps {
  useTabInfo: UseRightbarTabInfo
  sessionId?: string
}

/** The slot-registry face this module needs (keyed seats register by `key`). */
export interface RightbarSlotsFace {
  inject(name: string, callback: () => unknown): (() => void) | undefined
  register(
    opts: { name: string; key?: string; id?: string; order?: number; label?: string | (() => string) },
    component: unknown,
  ): () => void
}

interface StatusPayload {
  ok?: boolean
  status: string
  url?: string
  /** Same-origin TW proxy path (e.g. /dsh-tiddlywiki/tw/); the iframe base. */
  twProxy?: string
  wikiPath?: string
  error?: string
  ui?: { followDshTheme?: boolean; darkPalette?: string; tabLabel?: string }
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

/** Guide entry glyph: a wiki page with a TiddlyWiki-style "T" (same as the entry). */
function GuideIcon({ size = 16, className }: { size?: number; className?: string }): React.ReactElement {
  return React.createElement(
    'svg',
    { width: size, height: size, className, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    React.createElement('path', { d: 'M4 2.5h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z' }),
    React.createElement('path', { d: 'M6 6h4M6 8.5h2.5' }),
  )
}

/** The plain-DOM TW frame controller owned by the React body. */
interface FrameController {
  /** Reflect the tab's visibility; loads lazily on the first show. */
  setVisible(visible: boolean): void
  isVisible(): boolean
  /** Open a tiddler by title; false when this controller cannot serve it. */
  openTiddler(title: string): boolean
  dispose(): void
}

/** Live controller handle for center-panel link routing (openTiddlerInRightbar). */
let liveFrame: FrameController | undefined

/**
 * Ask the live rightbar TW tab to open a tiddler. False when no visible tab
 * is there, so the center panel handles the request as before.
 */
export function openTiddlerInRightbar(title: string): boolean {
  if (liveFrame === undefined) return false
  return liveFrame.openTiddler(title)
}

function createFrameController(host: HTMLElement, signal: AbortSignal): FrameController {
  let visible = false
  let started = false
  let disposed = false
  let refreshTimer: number | undefined
  let refreshAttempts = 0
  let frameLoaded = false
  let pendingHash: string | null = null
  let themeSyncDispose: (() => void) | undefined

  const view = document.createElement('div')
  view.className = 'dsh-tw-rightbar-view'

  const frameArea = document.createElement('div')
  frameArea.className = 'dsh-tw-rightbar-frame-wrap'
  const frame = document.createElement('iframe')
  frame.className = 'dsh-tw-rightbar-frame'
  frame.title = 'TiddlyWiki'
  frame.hidden = true
  frameArea.append(frame)

  const errorArea = document.createElement('div')
  errorArea.className = 'dsh-tw-rightbar-error'
  errorArea.hidden = true

  view.append(frameArea, errorArea)
  host.append(view)

  frame.addEventListener('load', () => {
    frameLoaded = true
    applyPendingHash()
  })
  themeSyncDispose = attachThemeSync(frame)

  const showError = (message: string): void => {
    frame.hidden = true
    errorArea.hidden = false
    errorArea.replaceChildren()
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
    frame.hidden = true
    errorArea.hidden = false
    errorArea.replaceChildren()
    const p = document.createElement('div')
    p.textContent = 'TiddlyWiki 服务正在启动…'
    errorArea.append(p)
  }

  const showFrame = (url: string): void => {
    errorArea.hidden = true
    // Only reveal the frame while the tab is on screen.
    frame.hidden = !visible
    // Set the src only when the url changed, so an editor never loses unsaved
    // state on a status refresh.
    if (frame.dataset.loaded !== url) {
      frame.dataset.loaded = url
      frameLoaded = false
      frame.src = url
    }
  }

  /** Apply a pending tiddler-hash once the frame is ready (see panel.ts). */
  const applyPendingHash = (): void => {
    if (pendingHash === null || !frameLoaded) return
    const hash = pendingHash
    const win = frame.contentWindow
    if (win === null) {
      fallbackLoad(hash)
      return
    }
    const tryOnce = (attempt: number): void => {
      if (disposed) return
      if (pendingHash !== hash) return
      const frameTw = win as { $tw?: unknown }
      if (typeof frameTw.$tw !== 'object' || frameTw.$tw === null) {
        if (attempt < 40) {
          window.setTimeout(() => tryOnce(attempt + 1), 150)
          return
        }
        fallbackLoad(hash)
        return
      }
      pendingHash = null
      try {
        if (win.location.hash !== hash) win.location.hash = hash
      } catch {
        fallbackLoad(hash)
      }
    }
    tryOnce(0)
  }

  const fallbackLoad = (hash: string): void => {
    if (disposed) return
    if (pendingHash === hash) pendingHash = null
    const base = frame.src.split('#')[0]
    if (frame.src !== `${base}${hash}`) frame.src = `${base}${hash}`
  }

  const doRefresh = async (): Promise<void> => {
    if (refreshTimer !== undefined) {
      window.clearTimeout(refreshTimer)
      refreshTimer = undefined
    }
    const payload = await fetchStatus()
    if (disposed) return
    if (payload === null) {
      showError('无法访问 /dsh-tiddlywiki/status')
      return
    }
    if (payload.ui !== undefined) {
      setLabel(payload.ui.tabLabel ?? rightbarLabel)
      setThemeSyncConfig({
        enabled: payload.ui.followDshTheme !== false,
        darkPalette: payload.ui.darkPalette,
      })
    }
    if (payload.status === 'running') {
      refreshAttempts = 0
      if (typeof payload.twProxy === 'string') {
        showFrame(new URL(payload.twProxy, window.location.origin).href)
      } else if (typeof payload.url === 'string') {
        showFrame(payload.url)
      } else {
        showError('服务未返回编辑器地址')
      }
      return
    }
    if (payload.status === 'starting') {
      showStarting()
      if (refreshAttempts < 30) {
        refreshAttempts++
        refreshTimer = window.setTimeout(() => { void doRefresh() }, 1_500)
      }
      return
    }
    refreshAttempts = 0
    showError(payload.error ?? `服务状态：${payload.status}`)
  }

  const onReloadRequest = (): void => {
    if (!frame.hidden) frame.src = frame.src
  }
  document.addEventListener(PANEL_RELOAD_EVENT, onReloadRequest)

  const onAbort = (): void => controller.dispose()
  signal.addEventListener('abort', onAbort, { once: true })

  const controller: FrameController = {
    setVisible(next: boolean): void {
      visible = next
      if (!started) {
        // Nothing loaded yet: stay hidden until the first show kicks the load.
        frame.hidden = true
        view.dataset.visible = next ? '1' : '0'
        if (next) {
          started = true
          void doRefresh()
        }
        return
      }
      frame.hidden = !next
      view.dataset.visible = next ? '1' : '0'
    },
    isVisible(): boolean {
      return visible
    },
    openTiddler(title: string): boolean {
      if (disposed || !visible) return false
      pendingHash = `#${encodeURIComponent(title)}`
      if (!started) {
        started = true
        void doRefresh()
      } else {
        applyPendingHash()
      }
      return true
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      if (liveFrame === controller) liveFrame = undefined
      document.removeEventListener(PANEL_RELOAD_EVENT, onReloadRequest)
      signal.removeEventListener('abort', onAbort)
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
      themeSyncDispose?.()
      view.remove()
    },
  }
  return controller
}

/**
 * The tab body (stage 2): a thin React wrapper that mounts the TW iframe into
 * a plain-DOM host. One mount per tab record; mutual exclusion rides the
 * `dsh-panel-activate` protocol both ways.
 */
export function TwRightbarTabBody(props: RightbarTabBodyProps): React.ReactElement {
  const { useTabInfo } = props
  const info = useTabInfo()
  const tab = info.tab
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const controllerRef = React.useRef<FrameController | null>(null)

  React.useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const controller = createFrameController(host, tab.signal)
    controllerRef.current = controller
    liveFrame = controller
    return () => {
      controller.dispose()
      controllerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one controller per tab record (id + signal are stable per occurrence).
  }, [tab.id, tab.signal])

  React.useEffect(() => {
    controllerRef.current?.setVisible(tab.visible)
  }, [tab.visible])

  // When this tab becomes visible, close the center overlay / sibling panels.
  // When any OTHER panel activates, close this tab (symmetry → one TW client).
  const visible = tab.visible
  const close = tab.actions.close
  React.useEffect(() => {
    if (!visible) return
    document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: RIGHTBAR_PANEL_NAME }))
    const onActivate = (event: Event): void => {
      const detail = (event as CustomEvent).detail
      if (detail !== RIGHTBAR_PANEL_NAME) close()
    }
    document.addEventListener(ACTIVATE_EVENT, onActivate)
    return () => document.removeEventListener(ACTIVATE_EVENT, onActivate)
  }, [visible, close])

  return React.createElement('div', { ref: hostRef, className: 'dsh-tw-rightbar-tab', 'data-dsh-tw-rightbar': '' })
}

/** The tab definition (stage 1): a page type opened by kind, with a guide entry box. */
export function rightbarDefinition(): Record<string, unknown> {
  return {
    id: TW_RIGHTBAR_ID,
    kind: TW_RIGHTBAR_KIND,
    title: (): string => rightbarLabel,
    guide: [
      {
        order: 10,
        title: (): string => 'TiddlyWiki 知识库',
        description: (): string => '在右侧边栏打开 TiddlyWiki 编辑器（与聊天并排）',
        icon: GuideIcon,
      },
    ],
  }
}

/**
 * Mount the rightbar integration for the caller's lifetime: register the type
 * and the body seat. Call only when `sidebarRightTabs` is actually available.
 */
export function mountRightbarTab(
  tabs: { register(definition: unknown): () => void },
  slots: RightbarSlotsFace,
): (() => void) | undefined {
  const disposers: Array<() => void> = []
  try {
    disposers.push(tabs.register(rightbarDefinition()))
    const removeBody = slots.inject('sidebar.right.pane.tab', () =>
      slots.register({ name: 'sidebar.right.pane.tab', key: TW_RIGHTBAR_ID }, TwRightbarTabBody),
    )
    if (removeBody !== undefined) disposers.push(removeBody)
  } catch (error) {
    for (const dispose of disposers.splice(0)) dispose()
    console.error('[dsh-tiddlywiki] rightbar tab mount failed:', error)
    return undefined
  }
  // Warm the chip label from the live config (ui.tabLabel) so the first open
  // already shows the right name; the frame refreshes it on every status call.
  void fetchStatus().then((payload) => {
    if (payload?.ui !== undefined) setLabel(payload.ui.tabLabel ?? rightbarLabel)
  })
  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}
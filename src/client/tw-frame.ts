/**
 * Shared TiddlyWiki iframe machinery for DSH side surfaces (v0.16.23).
 *
 * The center-column panel and the native right-sidebar tab (rightbar-tab.ts)
 * both embed the SAME-ORIGIN
 * TW proxy (`/dsh-tiddlywiki/tw/`) in an iframe and share the same lifecycle:
 * lazy-load on first show, `/status` polling with restart/error states, DSH
 * theme sync, reload-on-FAB-event, and tiddler-hash navigation. This module
 * owns that machinery plus the two small shared bits of state the surfaces
 * mirror (the tab chip label from `ui.tabLabel` and the tab icon).
 *
 * Link routing: each mounted TW surface registers its live frame controller
 * here; panel.ts asks `openTiddlerInLiveTab` first, so a wiki link lands in a
 * visible side TW tab (the native rightbar tab) before falling back to the
 * center overlay. Mutual exclusion (one TW client at a time) rides the
 * `dsh-panel-activate` protocol — each surface dispatches its own panel name
 * on becoming visible and closes itself when another name activates.
 *
 * @module dsh-tiddlywiki/client/tw-frame
 */
import * as React from 'react'
import { RESTART_ENDPOINT } from './endpoints.ts'
import { fetchStatus } from './status-cache.ts'
import { attachThemeSync, setThemeSyncConfig } from './theme-sync.ts'

/** Cross-plugin activation event; detail is the activating panel name. */
export const ACTIVATE_EVENT = 'dsh-panel-activate'
/** The "知识库" FAB's reload event; side frames reload with the center one. */
export const PANEL_RELOAD_EVENT = 'dsh-tw-panel-reload'

/** Tab chip / + menu / guide copy default (label refreshed from `/status` ui.tabLabel). */
let tabLabel = '知识库'

/** Update the shared surface label from the live config (ui.tabLabel). */
export function setTabLabel(label: string): void {
  const trimmed = typeof label === 'string' ? label.trim() : ''
  if (trimmed.length > 0) tabLabel = trimmed
}

/** Current shared surface label (ui.tabLabel, default 「知识库」). */
export function getTabLabel(): string {
  return tabLabel
}

/** POST /restart; `false` on any failure. Shared by both TW surfaces (v0.22.3). */
export async function requestRestart(): Promise<boolean> {
  try {
    const res = await fetch(RESTART_ENDPOINT, { method: 'POST', signal: AbortSignal.timeout(8_000) })
    return res.ok
  } catch {
    return false
  }
}

/** The shared surface glyph: a wiki page with a TiddlyWiki-style "T". */
export function TwTabIcon({ size = 16, className }: { size?: number; className?: string }): React.ReactElement {
  return React.createElement(
    'svg',
    { width: size, height: size, className, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    React.createElement('path', { d: 'M4 2.5h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z' }),
    React.createElement('path', { d: 'M6 6h4M6 8.5h2.5' }),
  )
}

/**
 * The last URL a TW surface actually assigned to its iframe, or null when the
 * frame never loaded one. Both surfaces cache it in `iframe.dataset.loaded`
 * (only `showFrame` writes it), which keeps "is this frame pointing at the TW
 * proxy?" answerable without trusting `src` — see `loadableFrameUrl`.
 */
export interface FrameLoadedState {
  loaded?: string
}

/**
 * Non-empty `dataset.loaded`, or null when the frame has no real URL yet
 * (v0.22.3). NEVER read `iframe.src` for this: for an iframe whose `src`
 * attribute was never assigned the property returns the EMBEDDING page's URL,
 * and assigning it back to `src` makes the DSH GUI load itself inside the
 * iframe (a second DSH instance: duplicate FAB, duplicated global listeners,
 * blank white page). Both callers below drive a full reload, so they must
 * refuse to touch a frame that has no loaded TW URL.
 */
export function loadableFrameUrl(dataset: FrameLoadedState): string | null {
  const loaded = dataset.loaded
  return loaded === undefined || loaded.length === 0 ? null : loaded
}

/** The plain-DOM TW frame controller owned by one surface body. */
export interface TwFrameController {
  /** Reflect the surface's visibility; loads lazily on the first show. */
  setVisible(visible: boolean): void
  /** Open a tiddler by title; false when this controller cannot serve it. */
  openTiddler(title: string): boolean
  dispose(): void
}

/**
 * Controller for an ALREADY-aborted signal: no DOM is ever built, so there is
 * nothing to show and nothing to reap (the abort listener would never fire).
 */
function disposedController(): TwFrameController {
  return {
    setVisible(): void {},
    openTiddler(): boolean { return false },
    dispose(): void {},
  }
}

/** Live visible-capable TW frames; a controller joins on creation, leaves on dispose. */
const liveFrames = new Set<TwFrameController>()

/**
 * Ask every live side TW surface to open a tiddler; true when one served it.
 * A controller answers false while hidden or disposed, so the center overlay
 * only opens when no visible side TW tab can take the link.
 */
export function openTiddlerInLiveTab(title: string): boolean {
  for (const controller of liveFrames) {
    if (controller.openTiddler(title)) return true
  }
  return false
}

/**
 * Refresh the shared surface label from `/status` (ui.tabLabel) so a surface
 * that mounts before the first status call already shows the right name.
 */
export function warmTabLabel(): void {
  void fetchStatus().then((payload) => {
    if (payload?.ui !== undefined) setTabLabel(payload.ui.tabLabel ?? tabLabel)
  })
}

/**
 * Create a TW frame controller inside `host`. The frame loads lazily on the
 * first `setVisible(true)`, polls `/status` (starting/restart/error states),
 * follows the DSH theme, reloads on the FAB's reload event, and navigates to
 * `#<title>` hashes once the frame is ready. `signal` (the tab's abort) tears
 * the whole controller down. Joins the live-frame registry on creation and
 * leaves it on dispose.
 */
export function createTwFrameController(host: HTMLElement, signal: AbortSignal): TwFrameController {
  // Already aborted (the tab was closed before this body mounted): 'abort' will
  // never fire again, so registering here would strand the iframe in
  // liveFrames forever. Hand back a no-op controller and build nothing.
  if (signal.aborted) return disposedController()

  let visible = false
  let started = false
  let disposed = false
  let refreshTimer: number | undefined
  /** In-flight hash-readiness retry timers (cancelled by dispose, v0.19.1). */
  const hashWaitTimers = new Set<number>()
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
    // Only reveal the frame while the surface is on screen.
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
          // Tracked so dispose() cancels the chain (v0.19.1 — the untracked
          // 40×150ms retry kept the iframe/closure alive after unmount).
          const timer = window.setTimeout(() => {
            hashWaitTimers.delete(timer)
            tryOnce(attempt + 1)
          }, 150)
          hashWaitTimers.add(timer)
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
    // Guard against the never-loaded frame: `frame.src` is '' before showFrame
    // ran, and `'' + '#title'` resolves against the DSH page URL (v0.22.3).
    const base = loadableFrameUrl(frame.dataset)
    if (base === null) return
    const next = `${base.split('#')[0]}${hash}`
    if (frame.src !== next) frame.src = next
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
      setTabLabel(payload.ui.tabLabel ?? tabLabel)
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
    // Reload = re-assign the URL the frame is ALREADY showing (full reload, so
    // TW re-reads the wiki; `location.reload()` could be blocked mid-edit).
    // `hidden` alone is not enough (v0.22.3): setVisible(true) reveals the frame
    // before the first /status response sets its src, and `frame.src = frame.src`
    // with `src === ''` loads the DSH page into the iframe.
    const loaded = loadableFrameUrl(frame.dataset)
    if (loaded !== null && !frame.hidden) frame.src = loaded
  }
  document.addEventListener(PANEL_RELOAD_EVENT, onReloadRequest)

  const onAbort = (): void => controller.dispose()
  signal.addEventListener('abort', onAbort, { once: true })

  const controller: TwFrameController = {
    setVisible(next: boolean): void {
      visible = next
      if (!started) {
        // Nothing loaded yet: stay hidden until the first show kicks the load.
        frame.hidden = true
        if (next) {
          started = true
          void doRefresh()
        }
        return
      }
      // Revealing before the first /status response is harmless as long as
      // every src-writing path checks `dataset.loaded` (onReloadRequest /
      // fallbackLoad), which also keeps the surface visible while a switch to
      // another wiki re-resolves its URL.
      frame.hidden = !next
      // 每次重新显示都重探一次状态：启动轮询是有界的（30×1.5s），首次打开时
      // 服务没起来就会把错误界面永久固定（切走再切回也不恢复）。doRefresh 自己
      // 会清旧 timer，不会重复轮询。
      if (next) void doRefresh()
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
      liveFrames.delete(controller)
      document.removeEventListener(PANEL_RELOAD_EVENT, onReloadRequest)
      signal.removeEventListener('abort', onAbort)
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
      for (const timer of hashWaitTimers) window.clearTimeout(timer)
      hashWaitTimers.clear()
      themeSyncDispose?.()
      view.remove()
    },
  }
  liveFrames.add(controller)
  return controller
}
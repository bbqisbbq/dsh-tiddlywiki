/**
 * Shared TiddlyWiki iframe machinery for DSH side surfaces (v0.16.23).
 *
 * The center-column panel and the native right-sidebar tab (rightbar-tab.ts)
 * both embed the SAME-ORIGIN
 * TW proxy (`/dsh-tiddlywiki/tw/`) in an iframe and share the same lifecycle:
 * lazy-load on first show, `/status` polling with restart/error states, DSH
 * theme sync, reload-on-FAB-event, and tiddler-hash navigation. This module
 * owns that machinery — `createTwFrameSurface()` is the ONE implementation —
 * plus the two small shared bits of state the surfaces mirror (the tab chip
 * label from `ui.tabLabel` and the tab icon).
 *
 * v0.22.4 convergence: `panel.ts` used to carry its own copies of
 * showError/showStarting/showFrame/fallbackLoad/doRefresh. They drifted, and
 * the drift is exactly what produced the v0.22.3 empty-`src` bug (one copy got
 * the guard, the other did not). A surface now supplies only its SKIN (class
 * names), its lazy build point and its visibility; every lifecycle decision
 * lives here. Add new lifecycle behaviour in this file, never at a call site.
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
import { RESTART_ENDPOINT, resolveTwUrl } from './endpoints.ts'
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
 * blank white page). Every full-reload path must refuse to touch a frame that
 * has no loaded TW URL.
 */
export function loadableFrameUrl(dataset: FrameLoadedState): string | null {
  const loaded = dataset.loaded
  return loaded === undefined || loaded.length === 0 ? null : loaded
}

/* ────────────────────────── the shared frame kernel ─────────────────────── */

/** Per-surface skin: the class names (and inline style) a surface wears. */
export interface TwFrameSkin {
  /** Wrapper filling the surface body (owns the flex chain). */
  view: string
  /** `data-*` attributes for the view wrapper (panel tags it for its CSS). */
  viewDataset?: Record<string, string>
  /** Wrapper around the iframe. */
  frameWrap: string
  /** Inline style for the frame wrapper (the panel's has no stylesheet rule). */
  frameWrapStyle?: string
  /** The TW iframe. */
  frame: string
  /** Error / starting panel. */
  error: string
}

/** A TW iframe surface: DOM + lifecycle, shared by every embedding surface. */
export interface TwFrameSurface {
  /**
   * Build the surface DOM (view wrapper + iframe + error area) and return the
   * view element; the CALLER decides where to append it. Idempotent, and safe
   * to call AFTER `setVisible(true)`: a surface asked to show before its DOM
   * existed (the panel builds lazily, once the center column appears) re-arms
   * its `/status` load right here instead of stranding an empty surface.
   */
  build(): HTMLDivElement
  /**
   * Reflect visibility. The first `true` starts the lazy load and is the only
   * thing that reveals the frame; `false` hides it and stops the bounded
   * retry polling, so a later `true` starts a fresh budget. Only a frame that
   * already carries a TW URL is ever revealed.
   */
  setVisible(visible: boolean): void
  /** Open a tiddler by title; false when this surface cannot serve it. */
  openTiddler(title: string): boolean
  /** Tear down listeners/timers/theme sync and remove the view from the DOM. */
  dispose(): void
}

/**
 * Create the frame machinery for one surface. Every `/status`-driven decision
 * (starting / error / running, iframe URL, theme config, shared chip label)
 * and every tiddler-hash navigation is implemented here ONCE.
 */
export function createTwFrameSurface(skin: TwFrameSkin): TwFrameSurface {
  let visible = false
  let started = false
  let disposed = false
  let view: HTMLDivElement | undefined
  let frame: HTMLIFrameElement | undefined
  let errorArea: HTMLDivElement | undefined
  let refreshTimer: number | undefined
  /** In-flight hash-readiness retry timers (cancelled by dispose, v0.19.1). */
  const hashWaitTimers = new Set<number>()
  let refreshAttempts = 0
  let frameLoaded = false
  let pendingHash: string | null = null
  let themeSyncDispose: (() => void) | undefined

  /** Cancel the pending bounded retry (a new refresh supersedes it). */
  const clearRetry = (): void => {
    if (refreshTimer !== undefined) {
      window.clearTimeout(refreshTimer)
      refreshTimer = undefined
    }
  }

  const showError = (message: string): void => {
    if (frame === undefined || errorArea === undefined) return
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
    if (frame === undefined || errorArea === undefined) return
    frame.hidden = true
    errorArea.hidden = false
    errorArea.replaceChildren()
    const p = document.createElement('div')
    p.textContent = 'TiddlyWiki 服务正在启动…'
    errorArea.append(p)
  }

  const showFrame = (url: string): void => {
    if (frame === undefined || errorArea === undefined) return
    errorArea.hidden = true
    // Only reveal the frame while the surface is on screen: doRefresh() can
    // still be in flight after the surface was hidden, and an unconditional
    // `hidden = false` would pop a closed surface back into view.
    frame.hidden = !visible
    // Set the src only when the url changed, so an editor never loses unsaved
    // state on a status refresh.
    if (frame.dataset.loaded !== url) {
      frame.dataset.loaded = url
      frameLoaded = false
      frame.src = url
    }
  }

  /**
   * Apply a pending tiddler-hash navigation once the iframe document is ready.
   * Preferred: same-origin `contentWindow.location.hash` — a hashchange INSIDE
   * the frame (no reload), TW's story handler opens the tiddler. Fallback: a
   * full `iframe.src` reload with the hash (TW auto-saves drafts, acceptable).
   *
   * TW registers its hashchange listener in a STARTUP module that runs after
   * the iframe's `load` event, so setting `location.hash` right on load is a
   * no-op (hash lost → TW stays on its home page). We therefore wait for TW to
   * become ready inside the frame (the `$tw` global appears once boot settles)
   * before setting the hash; if it never does (service down / slow boot) we
   * fall back to a full reload with the hash, which TW processes at startup.
   * A newer open request supersedes an in-flight wait.
   */
  const applyPendingHash = (): void => {
    if (pendingHash === null || frame === undefined || !frameLoaded) return
    const hash = pendingHash
    const win = frame.contentWindow
    if (win === null) {
      fallbackLoad(hash)
      return
    }
    const tryOnce = (attempt: number): void => {
      if (disposed) return // unmounted: do not keep waiting or touch the frame
      if (pendingHash !== hash) return // superseded by a newer request
      // Cross-origin frame (v0.26.7): on the DSH desktop app the TW frame is
      // loaded from the host's loopback HTTP origin — the only way TW's
      // TiddlyWeb sync adaptor will load there — which makes it a different
      // origin than the DSH page. Reading `$tw` inside it raises SecurityError,
      // so we cannot watch for TW's boot: go straight to the full
      // reload-with-hash fallback (TW honours the hash at startup).
      let frameIsTw = false
      try {
        const frameTw = win as { $tw?: unknown }
        frameIsTw = typeof frameTw.$tw === 'object' && frameTw.$tw !== null
      } catch {
        fallbackLoad(hash)
        return
      }
      if (!frameIsTw) {
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
    if (disposed || frame === undefined) return // never drive a detached frame
    if (pendingHash === hash) pendingHash = null
    // Guard against the never-loaded frame: `frame.src` is '' before showFrame
    // ran, and `'' + '#title'` resolves against the DSH page URL, which loads
    // the GUI into the iframe (v0.22.3).
    const base = loadableFrameUrl(frame.dataset)
    if (base === null) return
    const next = `${base.split('#')[0]}${hash}`
    if (frame.src !== next) frame.src = next
  }

  const doRefresh = async (): Promise<void> => {
    clearRetry()
    const payload = await fetchStatus()
    if (disposed) return // unmounted while fetching: stop, don't touch DOM
    // Re-check VISIBILITY after the await (v0.22.8). setVisible(false) clears the
    // pending retry and resets refreshAttempts — but a /status call already in
    // flight could land afterwards and take the `starting` branch below, arming a
    // BRAND NEW 30×1.5s budget on a hidden surface (and revealing the starting
    // panel on it). That contradicts setVisible's own contract and re-creates the
    // /status polling load (each call can spawn up to five host git processes)
    // that status-cache exists to bound.
    if (!visible) return
    if (payload === null) {
      showError('无法访问 /dsh-tiddlywiki/status')
      return
    }
    if (payload.ui !== undefined) {
      // Shared surface label + theme config: both are module-level, so any
      // surface that polls keeps them fresh for every other surface.
      setTabLabel(payload.ui.tabLabel ?? tabLabel)
      setThemeSyncConfig({
        enabled: payload.ui.followDshTheme !== false,
        darkPalette: payload.ui.darkPalette,
      })
    }
    if (payload.status === 'running') {
      refreshAttempts = 0
      // Same-origin proxy URL: build from the page's own origin so it works no
      // matter which host/domain the user reached DSH on. Fall back to the
      // legacy loopback `url` for older servers that do not send twProxy.
      if (typeof payload.twProxy === 'string') {
        // resolveTwUrl prefers the host's ABSOLUTE loopback base when THIS page
        // is not on http(s) (the DSH desktop app's `dsh-app:` renderer), because
        // TW refuses to load its sync adaptor anywhere else — see resolveTwUrl.
        showFrame(resolveTwUrl(payload.twProxy, payload.twProxyAbsolute))
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
    // The ONLY valid condition is `dataset.loaded` (v0.22.3): `frame.src` is ''
    // before showFrame ran, and `frame.src = frame.src` with `src === ''` loads
    // the DSH page into the iframe.
    // Deliberately NOT gated on `frame.hidden`: the FAB entry is an EXPLICIT
    // reload request, so it must reach every frame that really points at TW —
    // including a closed panel that would otherwise reopen onto stale assets
    // (v0.22.4; the panel used to reload in that state). An extra reload costs
    // less than showing stale content.
    if (frame === undefined) return
    const loaded = loadableFrameUrl(frame.dataset)
    if (loaded !== null) frame.src = loaded
  }
  document.addEventListener(PANEL_RELOAD_EVENT, onReloadRequest)

  const build = (): HTMLDivElement => {
    if (view !== undefined) return view
    const viewEl = document.createElement('div')
    viewEl.className = skin.view
    if (skin.viewDataset !== undefined) {
      for (const [key, value] of Object.entries(skin.viewDataset)) viewEl.dataset[key] = value
    }
    const wrapEl = document.createElement('div')
    wrapEl.className = skin.frameWrap
    if (skin.frameWrapStyle !== undefined) wrapEl.style.cssText = skin.frameWrapStyle
    const frameEl = document.createElement('iframe')
    frameEl.className = skin.frame
    frameEl.title = 'TiddlyWiki'
    frameEl.hidden = true
    wrapEl.append(frameEl)
    const errorEl = document.createElement('div')
    errorEl.className = skin.error
    errorEl.hidden = true
    viewEl.append(wrapEl, errorEl)
    view = viewEl
    frame = frameEl
    errorArea = errorEl
    // Track load so a pending tiddler-hash navigation can target a ready
    // document (setting contentWindow.location.hash before load is a no-op).
    frameEl.addEventListener('load', () => {
      frameLoaded = true
      applyPendingHash()
    })
    // Embedded TW follows the DSH light/dark theme (non-persisting palette
    // swap inside the same-origin iframe; re-applied on load + theme change).
    themeSyncDispose = attachThemeSync(frameEl)
    // The surface may already have been asked to show before its DOM existed
    // (the panel builds lazily): re-arm the load so it never stays empty.
    if (visible) void doRefresh()
    return viewEl
  }

  return {
    build,
    setVisible(next: boolean): void {
      if (disposed) return
      visible = next
      if (next && !started) started = true
      if (frame !== undefined) {
        // Reveal only a frame that already carries a TW URL; showFrame /
        // showStarting decide what to display until the first /status lands.
        frame.hidden = !next || loadableFrameUrl(frame.dataset) === null
      }
      if (next) {
        // 每次重新显示都重探一次状态：启动轮询是有界的（30×1.5s），首次打开时
        // 服务没起来就会把错误界面永久固定（切走再切回也不恢复）。doRefresh 自己
        // 会清旧 timer，不会重复轮询。
        void doRefresh()
      } else {
        // Hidden surfaces stop polling and get a fresh budget on the next show.
        clearRetry()
        refreshAttempts = 0
      }
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
      document.removeEventListener(PANEL_RELOAD_EVENT, onReloadRequest)
      clearRetry()
      for (const timer of hashWaitTimers) window.clearTimeout(timer)
      hashWaitTimers.clear()
      themeSyncDispose?.()
      view?.remove()
    },
  }
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

/** The rightbar tab's skin for the shared kernel (CSS owns the flex chain). */
const RIGHTBAR_SKIN: TwFrameSkin = {
  view: 'dsh-tw-rightbar-view',
  frameWrap: 'dsh-tw-rightbar-frame-wrap',
  frame: 'dsh-tw-rightbar-frame',
  error: 'dsh-tw-rightbar-error',
}

/**
 * Create a TW frame controller inside `host`: the shared kernel (which loads
 * lazily on the first `setVisible(true)`, polls `/status`, follows the DSH
 * theme, reloads on the FAB's reload event and navigates `#<title>` hashes)
 * plus the rightbar skin and the live-frame registry. `signal` (the tab's
 * abort) tears the whole controller down.
 */
export function createTwFrameController(host: HTMLElement, signal: AbortSignal): TwFrameController {
  // Already aborted (the tab was closed before this body mounted): 'abort' will
  // never fire again, so registering here would strand the iframe in
  // liveFrames forever. Hand back a no-op controller and build nothing.
  if (signal.aborted) return disposedController()

  const surface = createTwFrameSurface(RIGHTBAR_SKIN)
  host.append(surface.build())

  let disposed = false
  const onAbort = (): void => controller.dispose()
  signal.addEventListener('abort', onAbort, { once: true })

  const controller: TwFrameController = {
    setVisible(visible: boolean): void {
      surface.setVisible(visible)
    },
    openTiddler(title: string): boolean {
      return surface.openTiddler(title)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      liveFrames.delete(controller)
      signal.removeEventListener('abort', onAbort)
      surface.dispose()
    },
  }
  liveFrames.add(controller)
  return controller
}

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
 * The iframe points at the SAME-ORIGIN TW proxy (`<origin>/dsh-tiddlywiki/tw/`,
 * remote-access mode R1): the browser only talks to the DSH origin — which it
 * already reaches over loopback, LAN, Tailscale, a domain or HTTPS — and DSH
 * proxies to the loopback TW child. The panel reads /status first and only
 * sets iframe.src when the service is actually running. Because the proxy URL
 * is origin-relative and port-independent, a TW restart never reloads the
 * iframe, so an in-progress edit keeps its unsaved state.
 *
 * @module dsh-tiddlywiki/client/panel
 */
import type { PanelState } from './state.ts'
import { ENTRY_SELECTOR } from './sidebar-entry.ts'
import { attachThemeSync, setThemeSyncConfig } from './theme-sync.ts'
// 事件名单一来源：两个协议常量与 frame 生命周期助手都由 tw-frame.ts 提供
// （panel/rightbar 共同依赖）。requestRestart 也只此一份（v0.22.3 去重）。
import { ACTIVATE_EVENT, loadableFrameUrl, openTiddlerInLiveTab, PANEL_RELOAD_EVENT, requestRestart } from './tw-frame.ts'

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
const PANEL_NAME = 'dsh-tiddlywiki'

/** Overlay z-index: above the shell content, below the note widget (950). */
const PANEL_Z_INDEX = 40
/**
 * dsh-better-sidebar's unified fixed host layer (its persistent
 * expand/collapse toggle cluster lives inside it, at a global z-index of 25
 * — its internal 45 is trapped by the host's stacking context). When this
 * host is present the panel must stay BELOW it, so the sidebar toggle
 * buttons stay visible and clickable above the full-screen TW panel. This is
 * about the HOST chrome only (dsh-tiddlywiki no longer registers a tab in
 * that sidebar).
 */
const PANEL_HOST_SELECTOR = '[data-dsh-panel-host]'
/** The app's own shell overlay layer (dsh-client-ui-layout pins it at 20). */
const APP_OVERLAY_Z_INDEX = 20
/** Safety re-measure cadence for shell layout changes CSS can't see. */
const SYNC_INTERVAL_MS = 2_000

import { fetchStatus } from './status-cache.ts'

/**
 * Cross-module open request: the reply-stream tool cards and the document
 * click interceptor dispatch this; the mounted panel listens, opens itself and
 * navigates the iframe to the tiddler's hash (TW native page). Decoupled so
 * the panel can mount later than the first request.
 */
const OPEN_TIDDLER_EVENT = 'dsh-tw-open-tiddler'

/** Ask the mounted panel to open `title` in the TW native page. */
export function openTiddler(title: string): void {
  if (typeof document === 'undefined') return
  if (typeof title !== 'string' || title.length === 0) return
  document.dispatchEvent(new CustomEvent(OPEN_TIDDLER_EVENT, { detail: { title } }))
}

/**
 * The panel's z-index: below any dsh-better-sidebar host layer so its
 * persistent toggle cluster (top-right corner) stays visible and clickable
 * above the full-screen TW panel, otherwise the default 40. The host's live
 * computed z-index is read instead of hardcoding 25, so the rule tracks
 * plugin updates; the panel is still clamped above the app's own shell
 * overlay layer (dsh-client-ui-layout pins it at 20).
 */
function resolvePanelZIndex(): number {
  const host = document.querySelector<HTMLElement>(PANEL_HOST_SELECTOR)
  if (host === null) return PANEL_Z_INDEX
  const parsed = parseInt(getComputedStyle(host).zIndex, 10)
  if (!Number.isFinite(parsed)) return PANEL_Z_INDEX
  return Math.max(APP_OVERLAY_Z_INDEX, Math.min(PANEL_Z_INDEX, parsed - 1))
}

function conversationColumn(): HTMLElement | undefined {
  for (const selector of COLUMN_SELECTORS) {
    const el = document.querySelector<HTMLElement>(selector)
    if (el !== null) return el
  }
  return undefined
}

export function mountPanel(state: PanelState): () => void {
  let container: HTMLDivElement | undefined
  let columnEl: HTMLElement | undefined
  let iframe: HTMLIFrameElement | undefined
  let frameArea: HTMLDivElement | undefined
  let errorArea: HTMLDivElement | undefined
  let refreshTimer: number | undefined
  /** In-flight hash-readiness retry timers (cancelled by dispose, v0.19.1). */
  const hashWaitTimers = new Set<number>()
  let refreshAttempts = 0
  let themeSyncDispose: (() => void) | undefined
  /** true once the iframe's document finished loading (hash navigation target ready). */
  let frameLoaded = false
  /** A tiddler-hash open request waiting for the frame to become ready. */
  let pendingHash: string | null = null
  /** Set by the disposer: no timers/observers may touch DOM or the iframe after. */
  let disposed = false
  /** Last observed presence of the better-sidebar host layer (applyChrome cache). */
  let lastHasHost: boolean | undefined

  const build = (): HTMLDivElement => {
    const view = document.createElement('div')
    view.dataset.dshTwView = ''
    view.className = 'dsh-tw-view'

    frameArea = document.createElement('div')
    frameArea.className = 'dsh-tw-panel-frame-wrap'
    frameArea.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column'
    iframe = document.createElement('iframe')
    iframe.className = 'dsh-tw-panel-frame'
    iframe.title = 'TiddlyWiki'
    iframe.hidden = true
    frameArea.append(iframe)
    // Track load so a pending tiddler-hash navigation can target a ready
    // document (setting contentWindow.location.hash before load is a no-op).
    iframe.addEventListener('load', () => {
      frameLoaded = true
      applyPendingHash()
    })
    // Embedded TW follows the DSH light/dark theme (non-persisting palette
    // swap inside the same-origin iframe; re-applied on load + theme change).
    themeSyncDispose = attachThemeSync(iframe)

    errorArea = document.createElement('div')
    errorArea.className = 'dsh-tw-panel-error'
    errorArea.hidden = true

    view.append(frameArea, errorArea)
    return view
  }

  /** Pin the overlay to the center column's current viewport rect. */
  const syncRect = (): void => {
    // 面板关闭时不测量：2s interval 无条件调用，关闭后仍在做强制布局读取。
    if (!state.isOpen()) return
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

  /**
   * Coexist with dsh-better-sidebar: keep the panel's z-index below the
   * host layer (so its toggle cluster stays clickable above the panel) and
   * flag the host's presence so CSS can reserve the cluster's width at the
   * panel bar's right end. Re-run only while the panel is open (the z-index
   * must track the host layer) or when the host's presence actually flipped:
   * the querySelector + getComputedStyle here force a style recalc, so running
   * them on every DOM mutation (chat streaming!) is not affordable.
   */
  const applyChrome = (force = false): void => {
    if (container === undefined) return
    const hasHost = document.querySelector(PANEL_HOST_SELECTOR) !== null
    if (!force && !state.isOpen() && hasHost === lastHasHost) return
    lastHasHost = hasHost
    container.style.zIndex = String(resolvePanelZIndex())
    if (hasHost) container.dataset.sidebarHost = '1'
    else delete container.dataset.sidebarHost
  }

  const ensure = (): void => {
    // 中心列可能被 React 整体重建：overlay 已存在时也要自愈——脱离文档的节点
    // getBoundingClientRect() 恒为 0，syncRect() 会一直提前 return，面板位置/
    // 尺寸永久错位。首次挂载时中心列尚未出现（undefined）则继续等待。
    if (columnEl === undefined || !columnEl.isConnected) columnEl = conversationColumn()
    if (container !== undefined) return
    if (columnEl === undefined) return
    container = build()
    container.style.position = 'fixed'
    applyChrome(true)
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
    // 只有面板打开时才显示 iframe（对照 tw-frame.ts 的 `frame.hidden = !visible`）：
    // doRefresh() 在面板关闭后仍可能在途，无条件 hidden=false 会让已关闭的面板
    // 被一个迟到的 /status 响应重新显示出来。
    iframe.hidden = !state.isOpen()
    // Set the src only when the url actually changed, so an editor in the
    // iframe never loses unsaved state on a status refresh.
    if (iframe.dataset.loaded !== url) {
      iframe.dataset.loaded = url
      frameLoaded = false
      iframe.src = url
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
    if (pendingHash === null || iframe === undefined || !frameLoaded) return
    const hash = pendingHash
    const win = iframe.contentWindow
    if (win === null) {
      fallbackLoad(hash)
      return
    }
    const tryOnce = (attempt: number): void => {
      if (disposed) return // unmounted: do not keep waiting or touch the iframe
      if (pendingHash !== hash) return // superseded by a newer request
      const frameTw = win as { $tw?: unknown }
      if (typeof frameTw.$tw !== 'object' || frameTw.$tw === null) {
        if (attempt < 40) {
          // Track the retry timer so dispose() can cancel it (v0.19.1): an
          // untracked 40×150ms chain kept the closure (and the iframe) alive up
          // to ~6s after hot-reload/unmount.
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
        if (win.location.hash === hash) return
        win.location.hash = hash
      } catch {
        fallbackLoad(hash)
      }
    }
    tryOnce(0)
  }

  const fallbackLoad = (hash: string): void => {
    if (disposed || iframe === undefined) return // never drive a detached frame
    if (pendingHash === hash) pendingHash = null
    // dataset.loaded（showFrame 只写这个）而不是 iframe.src：src 为空时读出来
    // 是**DSH 页面自己的 URL**，赋 `'' + '#标题'` 会把 DSH 载进 iframe（v0.22.3）。
    const base = loadableFrameUrl(iframe.dataset)
    if (base === null) return
    const next = `${base.split('#')[0]}${hash}`
    if (iframe.src !== next) iframe.src = next
  }

  const onOpenTiddler = (event: Event): void => {
    const detail = (event as CustomEvent).detail as { title?: unknown } | undefined
    const title = typeof detail?.title === 'string' && detail.title.length > 0 ? detail.title : ''
    if (title.length === 0) return
    // 侧边栏（rightbar）的 TW tab 可见时，链接直接在那里
    // 打开（与聊天并排）；否则退回中央面板。互斥由 tw-frame.ts 共享的
    // dsh-panel-activate 协议保证。
    if (openTiddlerInLiveTab(title)) return
    pendingHash = `#${encodeURIComponent(title)}`
    state.openPanel()
    applyPendingHash()
  }

  const doRefresh = async (): Promise<void> => {
    if (refreshTimer !== undefined) {
      window.clearTimeout(refreshTimer)
      refreshTimer = undefined
    }
    const payload = await fetchStatus()
    if (disposed) return // unmounted while fetching: stop, don't touch DOM
    if (payload === null) {
      showError('无法访问 /dsh-tiddlywiki/status')
      return
    }
    if (payload.status === 'running') {
      refreshAttempts = 0
      // Keep the embedded TW's theme adaption in step with the settings page.
      setThemeSyncConfig({
        enabled: payload.ui?.followDshTheme !== false,
        darkPalette: payload.ui?.darkPalette,
      })
      // Same-origin proxy URL: build from the page's own origin so it works no
      // matter which host/domain the user reached DSH on. Fall back to the
      // legacy loopback `url` for older servers that do not send twProxy.
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
      // Auto-poll while starting (bounded).
      if (refreshAttempts < 30) {
        refreshAttempts++
        refreshTimer = window.setTimeout(() => { void doRefresh() }, 1_500)
      }
      return
    }
    refreshAttempts = 0
    showError(payload.error ?? `服务状态：${payload.status}`)
  }

  const applyActive = (): void => {
    if (state.isOpen()) {
      for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr)
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
      // syncRect() 现在只在打开时测量（关闭状态早退），所以打开这一帧必须主动
      // 请求一次布局：否则容器要等到下一个 2s interval 才有 left/top/width/height。
      scheduleLayout()
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

  // DOM 变更 / 滚动 / 尺寸三类高频信号合并到同一帧：一帧最多一次
  // ensure + syncRect + applyChrome。rect 仍然跟手（rAF 在下一帧绘制前执行），
  // 但聊天流式输出的高频 mutation 不会再每次都强制样式重算。
  let layoutRaf: number | undefined
  const scheduleLayout = (): void => {
    if (disposed || layoutRaf !== undefined) return
    layoutRaf = window.requestAnimationFrame(() => {
      layoutRaf = undefined
      if (disposed) return
      ensure()
      syncRect()
      applyChrome()
    })
  }

  // Mount the container once the column exists; self-heal on re-renders and
  // re-resolve the coexistence chrome when better-sidebar mounts/unmounts.
  const waitObserver = new MutationObserver(() => { scheduleLayout() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  // Keep the overlay pinned to the column: resize, layout mutations, scroll.
  const resizeObserver = new ResizeObserver(() => { scheduleLayout() })
  resizeObserver.observe(document.body)
  const syncInterval = window.setInterval(syncRect, SYNC_INTERVAL_MS)
  const onWindowResize = (): void => { scheduleLayout() }
  window.addEventListener('resize', onWindowResize)
  const onAnyScroll = (): void => { scheduleLayout() }
  window.addEventListener('scroll', onAnyScroll, true)

  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  const unsubscribe = state.subscribe(applyActive)
  ensure()
  applyActive()

  // The "知识库" FAB's 重载面板 entry dispatches this event to reload the
  // iframe (the panel itself no longer owns a floating status/reload button).
  const onReloadRequest = (): void => {
    // 只有真的载入过 TW 代理地址的 iframe 才允许重载：`!iframe.hidden` 已经不足
    // 以证明这一点（showFrame 之外，iframe 也可能是「面板打开但首个 /status 还在
    // 途」），而 `iframe.src = iframe.src` 在 src 为空串时会把 **DSH 页面**载进
    // iframe（v0.22.3）。判据统一用 dataset.loaded（只由 showFrame 写）。
    if (iframe === undefined) return
    const loaded = loadableFrameUrl(iframe.dataset)
    if (loaded !== null && !iframe.hidden) iframe.src = loaded
  }
  document.addEventListener(PANEL_RELOAD_EVENT, onReloadRequest)
  document.addEventListener(OPEN_TIDDLER_EVENT, onOpenTiddler)

  return () => {
    disposed = true
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
    for (const timer of hashWaitTimers) window.clearTimeout(timer)
    hashWaitTimers.clear()
    if (layoutRaf !== undefined) window.cancelAnimationFrame(layoutRaf)
    layoutRaf = undefined
    window.clearInterval(syncInterval)
    window.removeEventListener('resize', onWindowResize)
    window.removeEventListener('scroll', onAnyScroll, true)
    resizeObserver.disconnect()
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    document.removeEventListener(PANEL_RELOAD_EVENT, onReloadRequest)
    document.removeEventListener(OPEN_TIDDLER_EVENT, onOpenTiddler)
    waitObserver.disconnect()
    unsubscribe()
    themeSyncDispose?.()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    container?.remove()
  }
}

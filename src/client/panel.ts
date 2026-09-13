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
 * This module owns the overlay LAYOUT only (rect pinning, lazy build, chrome,
 * exclusion). The iframe's whole lifecycle — `/status` polling, error/starting
 * states, theme sync, FAB reload, tiddler-hash navigation — is the shared
 * kernel in tw-frame.ts (v0.22.4), so the panel and the rightbar tab can no
 * longer drift apart (the drift is what produced the v0.22.3 empty-src bug).
 *
 * The iframe points at the SAME-ORIGIN TW proxy (`<origin>/dsh-tiddlywiki/tw/`,
 * remote-access mode R1): the browser only talks to the DSH origin — which it
 * already reaches over loopback, LAN, Tailscale, a domain or HTTPS — and DSH
 * proxies to the loopback TW child. The kernel reads /status first and only
 * sets iframe.src when the service is actually running. Because the proxy URL
 * is origin-relative and port-independent, a TW restart never reloads the
 * iframe, so an in-progress edit keeps its unsaved state.
 *
 * @module dsh-tiddlywiki/client/panel
 */
import type { PanelState } from './state.ts'
import { ENTRY_SELECTOR } from './sidebar-entry.ts'
// 事件名与 frame 生命周期助手都只有一份，住在 tw-frame.ts（内核）。
import { ACTIVATE_EVENT, createTwFrameSurface, openTiddlerInLiveTab, type TwFrameSkin } from './tw-frame.ts'

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

/**
 * The panel's skin for the shared frame kernel. The inline flex chain is
 * required because — unlike `.dsh-tw-rightbar-frame-wrap` — the panel's frame
 * wrapper has no stylesheet rule; `data-dsh-tw-view` is what the stylesheet
 * keys on to hide the conversation content the overlay covers.
 */
const PANEL_SKIN: TwFrameSkin = {
  view: 'dsh-tw-view',
  viewDataset: { dshTwView: '' },
  frameWrap: 'dsh-tw-panel-frame-wrap',
  frameWrapStyle: 'flex:1;min-height:0;display:flex;flex-direction:column',
  frame: 'dsh-tw-panel-frame',
  error: 'dsh-tw-panel-error',
}

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
  /** Set by the disposer: no timers/observers may touch DOM or the iframe after. */
  let disposed = false
  /** Last observed presence of the better-sidebar host layer (applyChrome cache). */
  let lastHasHost: boolean | undefined

  /** iframe + /status lifecycle (shared with the rightbar tab, tw-frame.ts). */
  const surface = createTwFrameSurface(PANEL_SKIN)

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
    // 惰性构建：内核自己也记着可见性，晚于 setVisible(true) 建 DOM 时会自动补一次
    // /status（否则面板会停在空壳上）。
    container = surface.build()
    container.style.position = 'fixed'
    applyChrome(true)
    document.body.append(container)
    syncRect()
  }

  const onOpenTiddler = (event: Event): void => {
    const detail = (event as CustomEvent).detail as { title?: unknown } | undefined
    const title = typeof detail?.title === 'string' && detail.title.length > 0 ? detail.title : ''
    if (title.length === 0) return
    // 侧边栏（rightbar）的 TW tab 可见时，链接直接在那里打开（与聊天并排）；
    // 否则退回中央面板。互斥由 tw-frame.ts 共享的 dsh-panel-activate 协议保证。
    if (openTiddlerInLiveTab(title)) return
    // 顺序有意义：applyActive 由 openPanel() 同步触发，先把内核切到可见，
    // openTiddler() 才会被内核接受（否则内核以 visible=false 拒绝，链接丢失）。
    state.openPanel()
    surface.openTiddler(title)
  }

  const applyActive = (): void => {
    if (state.isOpen()) {
      for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr)
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
      // syncRect() 现在只在打开时测量（关闭状态早退），所以打开这一帧必须主动
      // 请求一次布局：否则容器要等到下一个 2s interval 才有 left/top/width/height。
      scheduleLayout()
    } else {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
    }
    // 打开 = 首次加载 + 每次重探 /status；关闭 = 隐藏 frame 并停掉有界轮询
    // （下次打开重新给满预算）。两种语义都在内核里。
    surface.setVisible(state.isOpen())
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

  // 链接路由入口（回复流工具卡 / 文档点击拦截器派发，见 `openTiddler()`）。
  // FAB 的「重载面板」事件由内核自己挂监听（含「只重载真的载入过 TW 的 frame」
  // 这条判据），panel 不再参与。
  document.addEventListener(OPEN_TIDDLER_EVENT, onOpenTiddler)

  return () => {
    disposed = true
    if (layoutRaf !== undefined) window.cancelAnimationFrame(layoutRaf)
    layoutRaf = undefined
    window.clearInterval(syncInterval)
    window.removeEventListener('resize', onWindowResize)
    window.removeEventListener('scroll', onAnyScroll, true)
    resizeObserver.disconnect()
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    document.removeEventListener(OPEN_TIDDLER_EVENT, onOpenTiddler)
    waitObserver.disconnect()
    unsubscribe()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    surface.dispose()
    container?.remove()
  }
}

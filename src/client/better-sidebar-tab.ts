/**
 * DSH Better Sidebar (dsh-better-sidebar) TiddlyWiki tab type (v0.16.23).
 *
 * dsh-better-sidebar exposes a client-side registry service on the cordis
 * context as `ctx.betterSidebar` (registerTab / registerFileViewer / openTab /
 * closeTab …). This module registers a TW tab type there: the sidebar's + menu
 * (and any caller of `openTab({ type: 'dsh-tiddlywiki' })`) opens the
 * SAME-ORIGIN TW proxy iframe — the same shared machinery the center panel and
 * the native rightbar tab use (tw-frame.ts).
 *
 * Mutual exclusion (one TW client at a time) rides the shared
 * `dsh-panel-activate` protocol: when this tab becomes visible the center
 * overlay / rightbar tab close; when another TW surface activates, this tab
 * closes itself through the service (closeTab). Wiki links in the reply
 * stream route here while the tab is visible (tw-frame.ts' live-frame
 * registry → panel.ts).
 *
 * The integration is optional: the caller reads `ctx.get('betterSidebar')`
 * and skips silently when the plugin is not installed (older DSH / other web
 * profiles). Registering a tab also gives every better-sidebar user an
 * enable/disable switch for it in the Side card settings page — that gate is
 * the plugin's own, independent of our `ui.showBetterSidebarTab` config.
 *
 * @module dsh-tiddlywiki/client/better-sidebar-tab
 */
import * as React from 'react'
import {
  ACTIVATE_EVENT,
  createTwFrameController,
  getTabLabel,
  TwTabIcon,
  type TwFrameController,
  warmTabLabel,
} from './tw-frame.ts'

/** The tab type this package owns in the better-sidebar registry. */
export const TW_BETTER_SIDEBAR_ID = 'dsh-tiddlywiki'
/** Activation-event name for THIS surface (distinct from center 'dsh-tiddlywiki' / rightbar). */
const BETTER_SIDEBAR_PANEL_NAME = 'dsh-tiddlywiki/bettersidebar'

/** Structural faces over the better-sidebar contract (no @deepseek-ai imports). */

export interface BetterSidebarTabProps {
  ctx: { get?(name: string): unknown }
  scope: { sessionId?: string; cwd?: string }
  tab: { id: string; type: string }
  /** Whether this tab is the active one AND the panel is open (live views pause otherwise). */
  visible: boolean
}

/** Structural face over the better-sidebar registry service (no @deepseek-ai imports). */
export interface BetterSidebarFace {
  registerTab(descriptor: {
    id: string
    title: string | (() => string)
    icon?: unknown
    single?: boolean
    component: (props: BetterSidebarTabProps) => unknown
  }): () => void
  closeTab(tabId: string, scope?: unknown): void
}

/**
 * The tab body: a thin React wrapper that mounts the TW iframe into a
 * plain-DOM host, like the rightbar tab body. `visible` pauses/resumes the
 * frame (lazy-loads on the first show); the `dsh-panel-activate` protocol
 * keeps exactly one TW client on screen.
 */
export function TwBetterSidebarTabBody(props: BetterSidebarTabProps): React.ReactElement {
  const { ctx, scope, tab } = props
  // 老版本 better-sidebar 可能不传 visible（缺失按「已可见」处理——tab 渲染在其
  // 面板内即视为在屏）。
  const visible = props.visible !== false
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const controllerRef = React.useRef<TwFrameController | null>(null)

  React.useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const ac = new AbortController()
    const controller = createTwFrameController(host, ac.signal)
    controllerRef.current = controller
    return () => {
      controller.dispose()
      ac.abort()
      controllerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one controller per tab (id stable; single-instance type).
  }, [tab.id])

  React.useEffect(() => {
    controllerRef.current?.setVisible(visible)
  }, [visible])

  // When this tab becomes visible, close the center overlay / rightbar tab.
  // When any OTHER TW surface activates, close this tab (one TW client).
  React.useEffect(() => {
    if (!visible) return
    document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: BETTER_SIDEBAR_PANEL_NAME }))
    const onActivate = (event: Event): void => {
      const detail = (event as CustomEvent).detail
      if (detail !== BETTER_SIDEBAR_PANEL_NAME) {
        const service = ctx.get?.('betterSidebar') as BetterSidebarFace | undefined
        service?.closeTab(tab.id, scope)
      }
    }
    document.addEventListener(ACTIVATE_EVENT, onActivate)
    return () => document.removeEventListener(ACTIVATE_EVENT, onActivate)
  }, [visible, tab.id, scope, ctx])

  return React.createElement('div', { ref: hostRef, className: 'dsh-tw-rightbar-tab', 'data-dsh-tw-bettersidebar': '' })
}

/**
 * Register the TW tab type in a live better-sidebar service for the caller's
 * lifetime; the returned disposer unregisters it. Call only when
 * `ctx.get('betterSidebar')` actually returned a service.
 */
export function mountBetterSidebarTab(service: BetterSidebarFace): (() => void) | undefined {
  try {
    const remove = service.registerTab({
      id: TW_BETTER_SIDEBAR_ID,
      title: (): string => getTabLabel(),
      icon: (size: number) => TwTabIcon({ size }),
      // Single instance: opening the tab focuses the existing one.
      single: true,
      component: (props: BetterSidebarTabProps) => TwBetterSidebarTabBody(props),
    })
    // Warm the + menu label from the live config (ui.tabLabel).
    warmTabLabel()
    return remove
  } catch (error) {
    console.error('[dsh-tiddlywiki] better-sidebar tab mount failed:', error)
    return undefined
  }
}
/**
 * Right-Sidebar TiddlyWiki tab type (v0.17.0; shared TW frame v0.16.23).
 *
 * DSH's new right column (dsh-client-ui-sidebar-right) lets plugins register
 * "tab types": stage 1 registers the type into `ctx.sidebarRightTabs` — a
 * guide entry box on the rightbar's home page is the entry point — and stage 2
 * registers the tab's React body into the keyed `sidebar.right.pane.tab` seat
 * under the definition's id. This module does both, guarded at the call site:
 * the whole integration is optional (older DSH / rightbar absent → no-op).
 *
 * The body embeds the SAME-ORIGIN TW proxy (`/dsh-tiddlywiki/tw/`) in an
 * iframe via the shared frame machinery (tw-frame.ts), exactly like the
 * center-column panel. One TW client at a time is enforced: when this tab
 * becomes visible the center overlay (and any sibling overlay panel) closes
 * via the existing `dsh-panel-activate` protocol, and when another panel
 * activates this tab closes itself. Wiki links in the reply stream route here
 * while the tab is visible (tw-frame.ts' live-frame registry, see panel.ts).
 *
 * The tab body is React only because the slot runtime renders React: the frame
 * is plain DOM built inside a ref host, mirroring the plugin's DOM style.
 *
 * @module dsh-tiddlywiki/client/rightbar-tab
 */
import { t } from './i18n.ts'
import * as React from 'react'
import {
  ACTIVATE_EVENT,
  createTwFrameController,
  getTabLabel,
  TwTabIcon,
  type TwFrameController,
  warmTabLabel,
} from './tw-frame.ts'

/** The tab kind this package owns; what `openTab` names and the guide entry opens. */
export const TW_RIGHTBAR_KIND = 'dsh-tiddlywiki'
/** This implementation's identity in the tab system: the key its body registers under. */
export const TW_RIGHTBAR_ID = 'dsh-tiddlywiki'
/**
 * The guide-card identity (v0.30.66).
 *
 * `sidebarRightTabs.register()` validates guide entries with
 * `new Set(entries.map(e => e.id))`, so an entry WITHOUT an `id` survives only
 * while it is the only one: adding a second entry throws, and the whole rightbar
 * integration (wrapped in a try/catch at the call site) disappears silently.
 *
 * Deliberately NOT `TW_RIGHTBAR_ID`: a guide entry and a tab type are two
 * identities in two namespaces, and the shipped guide page names its own with a
 * `/guide` suffix (`@deepseek-ai/dsh-client-ui-sidebar-right/guide`).
 */
export const TW_RIGHTBAR_GUIDE_ID = 'dsh-tiddlywiki/guide'
/** Activation-event name for THIS tab (distinct from the center panel's 'dsh-tiddlywiki'). */
const RIGHTBAR_PANEL_NAME = 'dsh-tiddlywiki/rightbar'

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
}

/** The slot-registry face this module needs (keyed seats register by `key`). */
export interface RightbarSlotsFace {
  inject(name: string, callback: () => unknown): (() => void) | undefined
  register(
    opts: { name: string; key?: string; id?: string; order?: number; label?: string | (() => string) },
    component: unknown,
  ): () => void
}

/** The tab body (stage 2): a thin React wrapper that mounts the TW iframe into
 *  a plain-DOM host. One mount per tab record; mutual exclusion rides the
 *  `dsh-panel-activate` protocol both ways.
 *
 *  Module-private (v0.22.8): it serves as the `slots.register` component and is
 *  never referenced directly. */
function TwRightbarTabBody(props: RightbarTabBodyProps): React.ReactElement {
  const { useTabInfo } = props
  const info = useTabInfo()
  const tab = info.tab
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const controllerRef = React.useRef<TwFrameController | null>(null)

  React.useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const controller = createTwFrameController(host, tab.signal)
    controllerRef.current = controller
    // 创建即应用一次可见性（v0.29.0）：如果 tab 记录被换掉（id/signal 变）而
    // `visible` 仍是 true，下面的 effect 不会再跑（依赖没变），新控制器就永远
    // 停在 `started = false` / iframe 隐藏 —— 右侧栏那块 tab 是空白的，直到用户
    // 手动收起再展开。这里同步应用一次，两个 effect 谁先跑都不影响结果。
    controller.setVisible(tab.visible)
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

  // 不再挂 `data-dsh-tw-rightbar`（v0.22.3）：没有任何选择器/代码消费它。
  return React.createElement('div', { ref: hostRef, className: 'dsh-tw-rightbar-tab' })
}

/** The tab definition (stage 1): a page type opened by kind, with a guide entry
 *  box. Module-private (v0.22.8) — only `mountRightbarTab()` below registers it. */
function rightbarDefinition(): Record<string, unknown> {
  return {
    id: TW_RIGHTBAR_ID,
    kind: TW_RIGHTBAR_KIND,
    title: (): string => getTabLabel(),
    /**
     * Keep the body mounted while the tab is hidden (v0.30.66).
     *
     * Without this flag the suite unmounts the body whenever the tab is hidden —
     * switching tabs, switching Session, collapsing the column — and our body
     * owns the TW iframe: every return then reloads the WHOLE wiki (tens of
     * megabytes, served `no-store`, so the browser cache cannot help).
     *
     * Visibility is still driven from the outside: the body applies
     * `controller.setVisible(tab.visible)` whenever the tab record's `visible`
     * flips, so the frame stays hidden rather than rendering.
     *
     * Closing the tab still unmounts (the tab record is gone, so React drops the
     * entry and `controller.dispose()` runs) — which is what keeps the
     * `dsh-panel-activate` mutual exclusion ("one TW client at a time") intact.
     */
    keepMounted: true,
    guide: [
      {
        id: TW_RIGHTBAR_GUIDE_ID,
        order: 10,
        title: (): string => t('frame.rightbarTitle'),
        description: (): string => t('frame.rightbarDescription'),
        icon: TwTabIcon,
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
  warmTabLabel()
  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}
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
  const controllerRef = React.useRef<TwFrameController | null>(null)

  React.useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const controller = createTwFrameController(host, tab.signal)
    controllerRef.current = controller
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
    title: (): string => getTabLabel(),
    guide: [
      {
        order: 10,
        title: (): string => 'TiddlyWiki 知识库',
        description: (): string => '在右侧边栏打开 TiddlyWiki 编辑器（与聊天并排）',
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
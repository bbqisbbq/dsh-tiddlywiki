/**
 * Shared client-side read of the effective UI config (mirrors UiDefaultsPublic
 * on the host). Used by the input-dock quick-note button, the quick-note entry
 * points (which need `quickNoteMode` to decide native/card on click) and any
 * other client mount that needs a config value before building DOM.
 *
 * Cached with a short TTL so per-click reads (dock/FAB) don't hit /status on
 * every interaction, while a settings-page change still takes effect within
 * seconds without a reload.
 *
 * The cache stores the PROMISE (v0.19.5): on page load the FAB, the dock, the
 * rightbar mount and the sidebar entry all read the config at nearly the same
 * moment, and value-caching let each of them fire its own request (each one
 * makes the host shell out to git). Coalescing means one request for the burst.
 *
 * @module dsh-tiddlywiki/client/ui-config
 */

import { fetchStatus, invalidateStatus } from './status-cache.ts'

export interface UiConfig {
  /** 聊天输入框上方的「快速笔记」快捷按钮是否显示（默认 true）。 */
  showQuickNoteDock: boolean
  /** 点击「快速笔记」后的打开方式：native=直达 TW 原生编辑器；card=Markdown 卡片。 */
  quickNoteMode: 'native' | 'card'
  /** 左侧侧边栏 TW 入口的显示名称（默认「TiddlyWiki」）。 */
  sidebarLabel: string
  /** 会话顶部「知识库」Tab 的显示名称（默认「知识库」）。 */
  tabLabel: string
  /** 是否在会话顶部显示「知识库」Tab（会话相关 wiki 汇总，默认 true）。 */
  showSessionTab: boolean
  /** 是否在 DSH 右侧边栏提供 TiddlyWiki 入口/Tab（默认 true）。 */
  showRightbarTab: boolean
  /** 「知识库」FAB 菜单里的「快速笔记」入口（默认 true）。 */
  showQuickNote: boolean
  /** 「知识库」FAB 菜单里的 TW 面板/重载入口与状态行（默认 true）。 */
  showPanelStatus: boolean
  /** 「知识库」FAB 菜单里的「同步」入口（默认 true）。 */
  showSyncButton: boolean
}

const FALLBACK: UiConfig = {
  showQuickNoteDock: true, quickNoteMode: 'native', sidebarLabel: 'TiddlyWiki', tabLabel: '知识库',
  showSessionTab: true, showRightbarTab: true, showQuickNote: true, showPanelStatus: true, showSyncButton: true,
}

const CACHE_TTL_MS = 15_000
let cache: { at: number; value: Promise<UiConfig> } | undefined

/**
 * Notified after the cache is dropped so live DOM labels can re-read.
 *
 * WHY (v0.22.8): `mountSidebarEntry` read `ui.sidebarLabel` exactly once, at
 * mount. The FAB / dock / TW tab all refresh from `/status` on every poll, so
 * changing「侧边栏 TW 入口显示名称」in Settings → 保存 took effect everywhere
 * EXCEPT the sidebar entry, which kept the old name until a page reload.
 */
const listeners = new Set<() => void>()

/** Subscribe to config invalidation; returns the unsubscribe function. */
export function subscribeUiConfig(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Drop the cached config: the settings page calls this right after a successful
 * `POST /admin/config` so the next read picks up the saved `ui.*` values
 * immediately instead of waiting out the TTL (up to 15s).
 *
 * It also drops the shared `/status` probe underneath (v0.20.0): otherwise the
 * next read could still be answered from status-cache's own 2s window and the
 * FAB/dock/tab label kept the pre-save values.
 */
export function invalidateUiConfig(): void {
  cache = undefined
  invalidateStatus()
  for (const listener of [...listeners]) listener()
}

/** Read /status once and project the ui.* fields (backward compatible: a host
 *  that predates a field simply falls back to the default). Cached for
 *  `CACHE_TTL_MS`, with concurrent callers sharing one in-flight request;
 *  callers that need a fresh value call `invalidateUiConfig()` first. */
export function fetchUiConfig(): Promise<UiConfig> {
  const now = Date.now()
  if (cache !== undefined && now - cache.at < CACHE_TTL_MS) return cache.value
  const pending = (async (): Promise<UiConfig> => {
    const status = await fetchStatus()
    const ui = status?.ui
    if (status === null || ui === undefined) return FALLBACK
    return {
      showQuickNoteDock: ui.showQuickNoteDock !== false,
      quickNoteMode: ui.quickNoteMode === 'card' ? 'card' : 'native',
      sidebarLabel: typeof ui.sidebarLabel === 'string' && ui.sidebarLabel.trim().length > 0
        ? ui.sidebarLabel.trim()
        : 'TiddlyWiki',
      tabLabel: typeof ui.tabLabel === 'string' && ui.tabLabel.trim().length > 0
        ? ui.tabLabel.trim()
        : '知识库',
      showSessionTab: ui.showSessionTab !== false,
      showRightbarTab: ui.showRightbarTab !== false,
      showQuickNote: ui.showQuickNote !== false,
      showPanelStatus: ui.showPanelStatus !== false,
      showSyncButton: ui.showSyncButton !== false,
    }
  })()
  cache = { at: Date.now(), value: pending }
  return pending
}

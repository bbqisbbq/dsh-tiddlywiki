/**
 * Shared client-side read of the effective UI config (mirrors UiDefaultsPublic
 * on the host). Used by the input-dock quick-note button and any other client
 * mount that needs a config value before building DOM.
 *
 * @module dsh-tiddlywiki/client/ui-config
 */

import { STATUS_ENDPOINT } from './endpoints.ts'

export interface UiConfig {
  /** 聊天输入框上方的「快速笔记」快捷按钮是否显示（默认 true）。 */
  showQuickNoteDock: boolean
  /** 左侧侧边栏 TW 入口的显示名称（默认「TiddlyWiki」）。 */
  sidebarLabel: string
  /** 会话顶部「知识库」Tab 的显示名称（默认「知识库」）。 */
  tabLabel: string
  /** 是否在会话顶部显示「知识库」Tab（会话相关 wiki 汇总，默认 true）。 */
  showSessionTab: boolean
}

const FALLBACK: UiConfig = { showQuickNoteDock: true, sidebarLabel: 'TiddlyWiki', tabLabel: '知识库', showSessionTab: true }

/** Fetch /status once and read the ui.* fields (backward compatible: a host
 *  that predates a field simply falls back to the default). */
export async function fetchUiConfig(): Promise<UiConfig> {
  try {
    const res = await fetch(STATUS_ENDPOINT, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return FALLBACK
    const p = (await res.json()) as { ui?: { showQuickNoteDock?: boolean; sidebarLabel?: string; tabLabel?: string; showSessionTab?: boolean } }
    return {
      showQuickNoteDock: p.ui?.showQuickNoteDock !== false,
      sidebarLabel: typeof p.ui?.sidebarLabel === 'string' && p.ui.sidebarLabel.trim().length > 0
        ? p.ui.sidebarLabel.trim()
        : 'TiddlyWiki',
      tabLabel: typeof p.ui?.tabLabel === 'string' && p.ui.tabLabel.trim().length > 0
        ? p.ui.tabLabel.trim()
        : '知识库',
      showSessionTab: p.ui?.showSessionTab !== false,
    }
  } catch {
    return FALLBACK
  }
}

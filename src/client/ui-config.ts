/**
 * Shared client-side read of the effective UI config (mirrors UiDefaultsPublic
 * on the host). Used by the input-dock quick-note button and any other client
 * mount that needs a config value before building DOM.
 *
 * @module dsh-tiddlywiki/client/ui-config
 */

const STATUS_ENDPOINT = '/dsh-tiddlywiki/status'

export interface UiConfig {
  /** 聊天输入框上方的「快速笔记」快捷按钮是否显示（默认 true）。 */
  showQuickNoteDock: boolean
  /** 左侧侧边栏 TW 入口的显示名称（默认「TiddlyWiki」）。 */
  sidebarLabel: string
}

const FALLBACK: UiConfig = { showQuickNoteDock: true, sidebarLabel: 'TiddlyWiki' }

/** Fetch /status once and read the ui.* fields (backward compatible: a host
 *  that predates a field simply falls back to the default). */
export async function fetchUiConfig(): Promise<UiConfig> {
  try {
    const res = await fetch(STATUS_ENDPOINT, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return FALLBACK
    const p = (await res.json()) as { ui?: { showQuickNoteDock?: boolean; sidebarLabel?: string } }
    return {
      showQuickNoteDock: p.ui?.showQuickNoteDock !== false,
      sidebarLabel: typeof p.ui?.sidebarLabel === 'string' && p.ui.sidebarLabel.trim().length > 0
        ? p.ui.sidebarLabel.trim()
        : 'TiddlyWiki',
    }
  } catch {
    return FALLBACK
  }
}

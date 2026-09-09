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
 * @module dsh-tiddlywiki/client/ui-config
 */

import { STATUS_ENDPOINT } from './endpoints.ts'

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
  /** 是否在 DSH Better Sidebar 侧边栏注册 TiddlyWiki tab（默认 true）。 */
  showBetterSidebarTab: boolean
}

const FALLBACK: UiConfig = { showQuickNoteDock: true, quickNoteMode: 'native', sidebarLabel: 'TiddlyWiki', tabLabel: '知识库', showSessionTab: true, showRightbarTab: true, showBetterSidebarTab: true }

const CACHE_TTL_MS = 15_000
let cache: { at: number; value: UiConfig } | undefined

/** Fetch /status once and read the ui.* fields (backward compatible: a host
 *  that predates a field simply falls back to the default). Cached for
 *  `CACHE_TTL_MS`; callers that need a fresh value (settings just saved) may
 *  pass `{ force: true }`. */
export async function fetchUiConfig(opts: { force?: boolean } = {}): Promise<UiConfig> {
  const now = Date.now()
  if (!opts.force && cache !== undefined && now - cache.at < CACHE_TTL_MS) return cache.value
  try {
    const res = await fetch(STATUS_ENDPOINT, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return FALLBACK
    const p = (await res.json()) as { ui?: { showQuickNoteDock?: boolean; quickNoteMode?: 'native' | 'card'; sidebarLabel?: string; tabLabel?: string; showSessionTab?: boolean; showRightbarTab?: boolean; showBetterSidebarTab?: boolean } }
    const value: UiConfig = {
      showQuickNoteDock: p.ui?.showQuickNoteDock !== false,
      quickNoteMode: p.ui?.quickNoteMode === 'card' ? 'card' : 'native',
      sidebarLabel: typeof p.ui?.sidebarLabel === 'string' && p.ui.sidebarLabel.trim().length > 0
        ? p.ui.sidebarLabel.trim()
        : 'TiddlyWiki',
      tabLabel: typeof p.ui?.tabLabel === 'string' && p.ui.tabLabel.trim().length > 0
        ? p.ui.tabLabel.trim()
        : '知识库',
      showSessionTab: p.ui?.showSessionTab !== false,
      showRightbarTab: p.ui?.showRightbarTab !== false,
      showBetterSidebarTab: p.ui?.showBetterSidebarTab !== false,
    }
    cache = { at: Date.now(), value }
    return value
  } catch {
    return FALLBACK
  }
}

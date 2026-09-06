/**
 * "知识库" FAB — the single bottom-right entry point that consolidates the
 * three floating controls that used to stack there (quick note toggle + sync
 * button + TW panel status/reload floaters) into one button + menu.
 *
 * - The FAB carries a live git status dot (from SyncController).
 * - The menu (opens upward) exposes, gated by the same ui.* settings:
 *     · TW 服务状态行（一行；悬停弹出详细状态 tip，含 git 状态与最近日志）
 *     · 📝 快速笔记   (if ui.showQuickNote)  → opens the note card
 *     · 🖥 打开/收起 TW 面板 (if ui.showPanelStatus) → toggles the center panel
 *     · 🔄 重载 TW 面板 (if ui.showPanelStatus) → reloads the panel iframe
 *     · 🔁 同步       (if ui.showSyncButton)  → pull→commit→push
 * - 旧版菜单里的第二行（git/知识库状态行）已去掉：git 状态由 FAB 上的状态点
 *   展示，详细内容并入 TW 状态行的悬停 tip。
 * - When ALL three ui flags are off, no DOM is created.
 *
 * @module dsh-tiddlywiki/client/knowledge-fab
 */
import type { PanelState } from './state.ts'
import type { NoteWidgetHandle } from './note-widget.ts'
import type { SyncController } from './sync-button.ts'

const STATUS_ENDPOINT = '/dsh-tiddlywiki/status'

/** Book icon (same visual family as the sidebar entry). */
const BOOK_ICON = '<svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.5h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/><path d="M6 6h4M6 8.5h2.5"/></svg>'

interface UiFlags { showQuickNote: boolean; showPanelStatus: boolean; showSyncButton: boolean }

async function fetchUiFlags(): Promise<UiFlags> {
  try {
    const res = await fetch(STATUS_ENDPOINT, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return { showQuickNote: true, showPanelStatus: true, showSyncButton: true }
    const p = (await res.json()) as { ui?: { showQuickNote?: boolean; showPanelStatus?: boolean; showSyncButton?: boolean } }
    return {
      showQuickNote: p.ui?.showQuickNote !== false,
      showPanelStatus: p.ui?.showPanelStatus !== false,
      showSyncButton: p.ui?.showSyncButton !== false,
    }
  } catch {
    return { showQuickNote: true, showPanelStatus: true, showSyncButton: true }
  }
}

/** TW service health snapshot for the menu's status line + hover tip. */
interface TwHealth { state: string; text: string; logs: string[] }

/** Fetch the TW service health (state line text + recent logs for the tip). */
async function fetchTwHealth(): Promise<TwHealth> {
  try {
    const res = await fetch(STATUS_ENDPOINT, { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) return { state: 'failed', text: '状态不可达', logs: [] }
    const p = (await res.json()) as { status?: string; url?: string; error?: string; logs?: string[] }
    const logs = Array.isArray(p.logs) ? p.logs.filter((l): l is string => typeof l === 'string') : []
    if (p.status === 'running') return { state: 'running', text: `TW 在线 · ${p.url ?? ''}`, logs }
    if (p.status === 'starting') return { state: 'starting', text: 'TW 启动中…', logs }
    return { state: 'failed', text: p.error ?? `TW 状态：${p.status ?? '?'}`, logs }
  } catch {
    return { state: 'failed', text: '状态不可达', logs: [] }
  }
}

/**
 * Mount the knowledge FAB. Fetches /status first to read the ui.* flags; when
 * every entry is disabled the FAB is never created. Returns a disposer.
 */
export function mountKnowledgeFab(state: PanelState, note: NoteWidgetHandle, sync: SyncController): () => void {
  let disposed = false
  let root: HTMLDivElement | undefined
  let fabBtn: HTMLButtonElement | undefined
  let dot: HTMLSpanElement | undefined
  let menu: HTMLDivElement | undefined
  let twStatusEl: HTMLSpanElement | undefined
  let twDot: HTMLSpanElement | undefined
  let tip: HTMLDivElement | undefined
  let panelLabel: HTMLSpanElement | undefined
  let menuOpen = false
  /** Latest TW health snapshot, merged into the hover tip. */
  let twHealth: TwHealth = { state: 'unknown', text: 'TiddlyWiki 服务…', logs: [] }

  const closeMenu = (): void => {
    menuOpen = false
    if (menu !== undefined) menu.hidden = true
    if (tip !== undefined) tip.hidden = true
  }

  /** Rebuild the TW status row's hover tip (TW 服务 + git 状态 + 最近日志). */
  const renderTip = (): void => {
    if (tip === undefined) return
    const lines: string[] = [`TiddlyWiki 服务：${twHealth.text}`]
    lines.push(`知识库同步：${sync.getState().tooltip}`)
    if (twHealth.logs.length > 0) {
      lines.push('最近日志：')
      lines.push(...twHealth.logs.slice(-3))
    }
    tip.textContent = lines.join('\n')
  }

  /** Refresh the FAB git dot + its title tooltip (and the menu tip's git line). */
  const renderDot = (): void => {
    const s = sync.getState()
    if (dot !== undefined) dot.dataset.state = s.state
    if (fabBtn !== undefined) fabBtn.title = `知识库 · ${s.tooltip}`
    renderTip()
  }

  /** Refresh the TW service status line in the menu. */
  const refreshTwStatus = async (): Promise<void> => {
    twHealth = await fetchTwHealth()
    if (disposed) return
    if (twStatusEl !== undefined) twStatusEl.textContent = twHealth.text
    if (twDot !== undefined) twDot.dataset.state = twHealth.state
    renderTip()
  }

  const build = (flags: UiFlags): void => {
    if (disposed) return
    root = document.createElement('div')
    root.className = 'dsh-tw-fab-wrap'

    menu = document.createElement('div')
    menu.className = 'dsh-tw-fab-menu'
    menu.hidden = true

    // 状态区：仅保留一行 TW 服务状态（第二行 git 状态行已去掉，git 详情并入
    // 这一行的悬停 tip；FAB 上的状态点仍展示 git 颜色）。
    if (flags.showPanelStatus) {
      const twRow = document.createElement('div')
      twRow.className = 'dsh-tw-fab-status dsh-tw-fab-status-tiprow'
      twDot = document.createElement('span')
      twDot.className = 'dsh-tw-fab-status-dot'
      twDot.dataset.state = 'unknown'
      twStatusEl = document.createElement('span')
      twStatusEl.className = 'dsh-tw-fab-status-text'
      twStatusEl.textContent = 'TiddlyWiki 服务…'
      twRow.append(twDot, twStatusEl)
      // 悬停详细状态 tip（TW 服务 + git + 最近日志）。
      tip = document.createElement('div')
      tip.className = 'dsh-tw-fab-tip'
      tip.hidden = true
      twRow.append(tip)
      twRow.addEventListener('mouseenter', () => {
        renderTip()
        if (tip !== undefined) tip.hidden = false
      })
      twRow.addEventListener('mouseleave', () => {
        if (tip !== undefined) tip.hidden = true
      })
      menu.append(twRow)
    }

    if (flags.showQuickNote) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'dsh-tw-fab-item'
      item.textContent = '📝 快速笔记'
      item.addEventListener('click', () => {
        closeMenu()
        // open-only：弹窗只能由卡片上的 ✕ 关闭，触发按钮不负责收起。
        void note.open()
      })
      menu.append(item)
    }

    if (flags.showPanelStatus) {
      panelLabel = document.createElement('span')
      panelLabel.textContent = '打开 TW 面板'
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'dsh-tw-fab-item'
      item.append(document.createTextNode('🖥 '), panelLabel)
      item.addEventListener('click', () => {
        closeMenu()
        state.toggle()
      })
      menu.append(item)

      const reload = document.createElement('button')
      reload.type = 'button'
      reload.className = 'dsh-tw-fab-item'
      reload.textContent = '🔄 重载 TW 面板'
      reload.addEventListener('click', () => {
        closeMenu()
        document.dispatchEvent(new CustomEvent('dsh-tw-panel-reload'))
        void refreshTwStatus()
      })
      menu.append(reload)
    }

    if (flags.showSyncButton) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'dsh-tw-fab-item'
      item.textContent = '🔁 同步'
      item.addEventListener('click', () => {
        closeMenu()
        void sync.trigger()
      })
      menu.append(item)
    }

    fabBtn = document.createElement('button')
    fabBtn.type = 'button'
    fabBtn.className = 'dsh-tw-fab'
    fabBtn.setAttribute('aria-label', 'TiddlyWiki 知识库')
    const icon = document.createElement('span')
    icon.className = 'dsh-tw-fab-icon'
    icon.innerHTML = BOOK_ICON
    dot = document.createElement('span')
    dot.className = 'dsh-tw-fab-dot'
    dot.dataset.state = sync.getState().state
    fabBtn.append(icon, dot)
    fabBtn.addEventListener('click', () => {
      if (menu === undefined) return
      if (menuOpen) { closeMenu(); return }
      menuOpen = true
      menu.hidden = false
      renderDot()
      void refreshTwStatus()
    })

    root.append(menu, fabBtn)
    document.body.append(root)
    renderDot()

    // Outside click closes the menu.
    document.addEventListener('click', (event) => {
      if (!menuOpen) return
      const target = event.target as Node
      if (root !== undefined && root.contains(target)) return
      closeMenu()
    }, true)
  }

  // Reflect panel open/close in the menu label.
  const unsubPanel = state.subscribe(() => {
    if (panelLabel !== undefined) panelLabel.textContent = state.isOpen() ? '收起 TW 面板' : '打开 TW 面板'
  })
  const unsubSync = sync.subscribe(renderDot)

  void (async () => {
    const flags = await fetchUiFlags()
    if (disposed) return
    if (!flags.showQuickNote && !flags.showPanelStatus && !flags.showSyncButton) return
    build(flags)
  })()

  return () => {
    disposed = true
    unsubPanel()
    unsubSync()
    root?.remove()
  }
}

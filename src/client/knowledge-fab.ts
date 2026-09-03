/**
 * "知识库" FAB — the single bottom-right entry point that consolidates the
 * three floating controls that used to stack there (quick note toggle + sync
 * button + TW panel status/reload floaters) into one button + menu.
 *
 * - The FAB carries a live git status dot (from SyncController).
 * - The menu (opens upward) exposes, gated by the same ui.* settings:
 *     · TW service status line + git status line
 *     · 📝 快速笔记   (if ui.showQuickNote)  → opens the note card
 *     · 🖥 打开/收起 TW 面板 (if ui.showPanelStatus) → toggles the center panel
 *     · 🔄 重载 TW 面板 (if ui.showPanelStatus) → reloads the panel iframe
 *     · 🔁 同步       (if ui.showSyncButton)  → pull→commit→push
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

/** Fetch the TW service health for the menu's status line. */
async function fetchTwStatus(): Promise<{ state: string; text: string }> {
  try {
    const res = await fetch(STATUS_ENDPOINT, { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) return { state: 'failed', text: '状态不可达' }
    const p = (await res.json()) as { status?: string; url?: string; error?: string }
    if (p.status === 'running') return { state: 'running', text: `TW 在线 · ${p.url ?? ''}` }
    if (p.status === 'starting') return { state: 'starting', text: 'TW 启动中…' }
    return { state: 'failed', text: p.error ?? `TW 状态：${p.status ?? '?'}` }
  } catch {
    return { state: 'failed', text: '状态不可达' }
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
  let panelLabel: HTMLSpanElement | undefined
  let menuOpen = false
  let gitRowDot: HTMLSpanElement | undefined
  let gitRowText: HTMLSpanElement | undefined

  const closeMenu = (): void => {
    menuOpen = false
    if (menu !== undefined) menu.hidden = true
  }

  /** Refresh the git dot + tooltip from the controller (FAB dot + menu row). */
  const renderDot = (): void => {
    const s = sync.getState()
    if (dot !== undefined) dot.dataset.state = s.state
    if (fabBtn !== undefined) fabBtn.title = `知识库 · ${s.tooltip}`
    if (gitRowDot !== undefined) gitRowDot.dataset.state = s.state
    if (gitRowText !== undefined) gitRowText.textContent = s.tooltip
  }

  /** Refresh the TW service status line in the menu. */
  const refreshTwStatus = async (): Promise<void> => {
    const info = await fetchTwStatus()
    if (disposed) return
    if (twStatusEl !== undefined) twStatusEl.textContent = info.text
    if (twDot !== undefined) twDot.dataset.state = info.state
  }

  const build = (flags: UiFlags): void => {
    if (disposed) return
    root = document.createElement('div')
    root.className = 'dsh-tw-fab-wrap'

    menu = document.createElement('div')
    menu.className = 'dsh-tw-fab-menu'
    menu.hidden = true

    // Status section (TW service + git).
    if (flags.showPanelStatus) {
      const twRow = document.createElement('div')
      twRow.className = 'dsh-tw-fab-status'
      twDot = document.createElement('span')
      twDot.className = 'dsh-tw-fab-status-dot'
      twDot.dataset.state = 'unknown'
      twStatusEl = document.createElement('span')
      twStatusEl.className = 'dsh-tw-fab-status-text'
      twStatusEl.textContent = 'TiddlyWiki 服务…'
      twRow.append(twDot, twStatusEl)
      menu.append(twRow)
    }
    if (flags.showSyncButton) {
      const gitRow = document.createElement('div')
      gitRow.className = 'dsh-tw-fab-status'
      gitRowDot = document.createElement('span')
      gitRowDot.className = 'dsh-tw-fab-status-dot'
      gitRowDot.dataset.state = sync.getState().state
      gitRowText = document.createElement('span')
      gitRowText.className = 'dsh-tw-fab-status-text'
      gitRowText.textContent = sync.getState().tooltip
      gitRow.append(gitRowDot, gitRowText)
      menu.append(gitRow)
    }

    if (flags.showQuickNote) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'dsh-tw-fab-item'
      item.textContent = '📝 快速笔记'
      item.addEventListener('click', () => {
        closeMenu()
        void note.toggle()
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

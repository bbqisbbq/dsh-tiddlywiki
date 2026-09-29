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
import { PANEL_RELOAD_EVENT } from './tw-frame.ts'
import { ROUTE_PREFIX } from './endpoints.ts'
import { resolveFocusWiki, setFocusWiki, subscribeFocusWiki } from './wiki-focus.ts'

import { fetchStatus } from './status-cache.ts'
import { fetchUiConfig } from './ui-config.ts'

/** Book icon (same visual family as the sidebar entry). */
const BOOK_ICON = '<svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.5h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/><path d="M6 6h4M6 8.5h2.5"/></svg>'

interface UiFlags { showQuickNote: boolean; showPanelStatus: boolean; showSyncButton: boolean }

/** One knowledge base as the FAB's switcher lists it (v0.28.0). */
interface FabWiki { id: string; label: string; running: boolean; path: string }

/** The knowledge-base roster for the FAB switcher. */
interface FabRoster { mode: string; defaultId?: string; wikis: FabWiki[] }

/**
 * Fetch the roster (v0.28.0). The switcher only appears when there is MORE THAN
 * ONE wiki, so a single-wiki install keeps exactly the menu it always had.
 */
async function fetchRoster(): Promise<FabRoster> {
  const payload = await fetchStatus()
  const wikis = Array.isArray(payload?.wikis)
    ? payload.wikis.map((wiki) => ({ id: wiki.id, label: wiki.label, running: wiki.running, path: wiki.path }))
    : []
  return {
    mode: typeof payload?.mode === 'string' ? payload.mode : 'single',
    ...(typeof payload?.defaultId === 'string' ? { defaultId: payload.defaultId } : {}),
    wikis,
  }
}

/** Read the three FAB-menu gates from the shared, TTL-cached ui config.
 *
 *  Used to be a private `fetchStatus()` projection (v0.22.8): the `/status`
 *  `ui.*` shape was spelled out in three places (here, note-widget, and the
 *  shared reader), so one new field meant three edits. */
async function fetchUiFlags(): Promise<UiFlags> {
  const cfg = await fetchUiConfig()
  return { showQuickNote: cfg.showQuickNote, showPanelStatus: cfg.showPanelStatus, showSyncButton: cfg.showSyncButton }
}

/** TW service health snapshot for the menu's status line + hover tip. */
interface TwHealth { state: string; text: string; logs: string[] }

/** Fetch the TW service health (state line text + recent logs for the tip). */
async function fetchTwHealth(): Promise<TwHealth> {
  const p = await fetchStatus()
  if (p === null) return { state: 'failed', text: '状态不可达', logs: [] }
  const logs = Array.isArray(p.logs) ? p.logs.filter((l): l is string => typeof l === 'string') : []
  if (p.status === 'running') return { state: 'running', text: `TW 在线 · ${p.url ?? ''}`, logs }
  if (p.status === 'starting') return { state: 'starting', text: 'TW 启动中…', logs }
  return { state: 'failed', text: p.error ?? `TW 状态：${p.status ?? '?'}`, logs }
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
  /** 焦点库订阅（多库菜单需要，dispose 时回收）。 */
  let focusOff: (() => void) | undefined
  /**
   * 重画"知识库"分组的选中标记。打开菜单前调用一次 —— 订阅负责切库时即时重画，
   * 这里负责兜住"订阅建立之前的窗口"与外部改动（v0.28.3）。
   */
  let repaintWikiMenu: (() => void) | undefined
  /** Latest TW health snapshot, merged into the hover tip. */
  let twHealth: TwHealth = { state: 'unknown', text: 'TiddlyWiki 服务…', logs: [] }

  const closeMenu = (): void => {
    menuOpen = false
    if (menu !== undefined) menu.hidden = true
    if (tip !== undefined) tip.hidden = true
  }

  /** Capture-phase outside-click handler (closes the open menu); must be
   *  removable so unmount does not leak the document listener. */
  const onDocumentClick = (event: Event): void => {
    if (!menuOpen) return
    const target = event.target as Node
    if (root !== undefined && root.contains(target)) return
    closeMenu()
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

  /** Snapshot `build()` rendered from — lets the click path notice a stale menu. */
  let currentFlags: UiFlags | undefined
  let currentRoster: FabRoster | undefined

  /** 名册是否变过（新增 / 移除 / 改名 / 启停库）。 */
  const rosterChanged = (before: FabRoster, after: FabRoster): boolean => {
    if (before.mode !== after.mode || before.defaultId !== after.defaultId) return true
    if (before.wikis.length !== after.wikis.length) return true
    return before.wikis.some((wiki, i) => {
      const next = after.wikis[i]
      return next === undefined || next.id !== wiki.id || next.label !== wiki.label || next.running !== wiki.running
    })
  }

  /** 打开菜单 —— 点击路径与「名册变了，先重建再打开」共用这一份。 */
  const openMenuNow = (): void => {
    if (menu === undefined) return
    menuOpen = true
    menu.hidden = false
    // 每次打开都重画一次选中标记（v0.28.3）：切库可能发生在菜单关着的时候
    // （侧边栏入口、快速笔记卡片），不重画就会显示上一次的选中项。
    repaintWikiMenu?.()
    renderDot()
    void refreshTwStatus()
  }

  const build = (flags: UiFlags, roster: FabRoster): void => {
    if (disposed) return
    currentFlags = flags
    currentRoster = roster
    // 重建路径会再次调用 build()：旧的 document 监听必须先摘掉（同一个函数引用，
    // 重复 add 会让菜单外的每一次点击都多跑一遍处理器）。
    document.removeEventListener('click', onDocumentClick, true)
    root?.remove()
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
      item.title = 'ui.quickNoteMode=native 时直接打开 TW 原生编辑器；card 时打开 Markdown 卡片'
      item.addEventListener('click', () => {
        closeMenu()
        // open-only：卡片弹窗只能由卡片上的 ✕ 关闭，触发按钮不负责收起。
        // 原生模式：点击直达 TW 原生编辑页（与输入框上方的快速笔记按钮一致）。
        void fetchUiConfig().then((cfg) => {
          if (cfg.quickNoteMode === 'native') void note.openNative()
          else void note.open()
        })
      })
      menu.append(item)
    }

    if (flags.showPanelStatus) {
      // 多知识库切换（v0.28.0）：只有多于一个库时才长出这一段，单库安装的菜单不变。
      // 点一下 = 把"焦点库"切过去并打开面板——面板会加载那个库自己的 /tw/<id>/。
      if (roster.wikis.length > 1) {
        const heading = document.createElement('div')
        heading.className = 'dsh-tw-fab-group'
        heading.textContent = '知识库'
        menu.append(heading)
        /** 每个库的菜单项，便于焦点变化时就地刷新选中标记。 */
        const wikiItems = new Map<string, HTMLButtonElement>()
        /**
         * 重画选中标记（v0.28.3）。
         *
         * 原来的实现只在**菜单构建时**算一次 focus，之后无论怎么切都不再更新 ——
         * 于是"切了库、选中项还停在上一个"（作者报障）。这里改成从当前焦点重算，
         * 并在 setFocusWiki 的订阅里重画；菜单关闭时也重画，保证下次打开是对的。
         */
        const paint = (): void => {
          const current = resolveFocusWiki(roster.wikis, roster.defaultId)
          for (const [id, el] of wikiItems) {
            const isCurrent = id === current
            el.dataset.current = isCurrent ? '1' : '0'
            const wiki = roster.wikis.find((w) => w.id === id)
            el.textContent = `${isCurrent ? '●' : '○'} ${wiki?.label ?? id}`
          }
        }
        for (const wiki of roster.wikis) {
          const item = document.createElement('button')
          item.type = 'button'
          item.className = 'dsh-tw-fab-item'
          item.dataset.current = '0'
          item.title = `${wiki.path}${wiki.running ? '' : '（未运行，打开会启动）'}`
          item.addEventListener('click', () => {
            closeMenu()
            setFocusWiki(wiki.id)
            // 打开面板前把它起起来（v0.28.0）：`/tw/<id>/` 对没在跑的库回 503，
            // 而这条菜单项的提示恰恰写着"打开会启动"。启动是显式 POST——代理路由
            // 绝不能在 GET 里顺手 spawn 子进程。
            if (!wiki.running) {
              void fetch(`${ROUTE_PREFIX}/admin/wikis`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'start', id: wiki.id }),
                signal: AbortSignal.timeout(120_000),
              }).catch(() => undefined)
            }
            state.openPanel()
          })
          wikiItems.set(wiki.id, item)
          menu.append(item)
        }
        paint()
        // 焦点变化（可能来自别的入口：侧边栏某一行、快速笔记卡片）也要跟上。
        focusOff = subscribeFocusWiki(() => { paint() })
        // 每次打开菜单前重画一次，避免因为订阅时机错过而显示旧值。
        repaintWikiMenu = paint
      }

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
        document.dispatchEvent(new CustomEvent(PANEL_RELOAD_EVENT))
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
      if (menuOpen) { closeMenu(); return }
      // 名册可能在界面开着的时候变（新增 / 移除 / 改名 / 启停库）。
      // v0.29.0：打开前对一次账，变了就整块重建 —— 此前只在挂载时读一次，
      // 于是菜单里少一个库 / 高亮错行，点已移除的那一项还会把面板指到
      // `/tw/<gone>/`（侧边栏入口是每 10s 重读 /status 的，只有这里不会）。
      void (async () => {
        const fresh = await fetchRoster().catch(() => undefined)
        if (disposed) return
        if (fresh !== undefined && currentRoster !== undefined && currentFlags !== undefined && rosterChanged(currentRoster, fresh)) {
          build(currentFlags, fresh)
          openMenuNow()
          return
        }
        openMenuNow()
      })()
    })

    root.append(menu, fabBtn)
    document.body.append(root)
    renderDot()

    // Outside click closes the menu.
    document.addEventListener('click', onDocumentClick, true)
  }

  // Reflect panel open/close in the menu label.
  const unsubPanel = state.subscribe(() => {
    if (panelLabel !== undefined) panelLabel.textContent = state.isOpen() ? '收起 TW 面板' : '打开 TW 面板'
  })
  const unsubSync = sync.subscribe(renderDot)

  void (async () => {
    const [flags, roster] = await Promise.all([fetchUiFlags(), fetchRoster()])
    if (disposed) return
    if (!flags.showQuickNote && !flags.showPanelStatus && !flags.showSyncButton) return
    build(flags, roster)
  })()

  return () => {
    disposed = true
    focusOff?.()
    focusOff = undefined
    document.removeEventListener('click', onDocumentClick, true)
    unsubPanel()
    unsubSync()
    root?.remove()
  }
}

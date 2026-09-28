/**
 * Sidebar entry injection — structure ported from dsh-taskboard's
 * sidebar-entry.ts (verified live in this shell): scope to the sidebar root,
 * find the New Session button, and insert the entry as a direct child of that
 * root next to the family block. A body-level MutationObserver self-heals
 * React re-renders; a slow timer covers shells that mount late without
 * further mutations. The row is plain DOM so it never disturbs the shell's
 * reconciliation.
 *
 * @module dsh-tiddlywiki/client/sidebar-entry
 */
import type { PanelState } from './state.ts'
import { fetchUiConfig, subscribeUiConfig } from './ui-config.ts'
import { fetchStatus } from './status-cache.ts'
import { resolveFocusWiki, setFocusWiki, subscribeFocusWiki } from './wiki-focus.ts'

/** Stable data attribute identifying this entry row. */
export const ENTRY_SELECTOR = '[data-dsh-tw-entry]'

/** Inline icon: a wiki page with a TiddlyWiki-style "T" (nav-icon look). */
const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.5h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/><path d="M6 6h4M6 8.5h2.5"/></svg>'

/** Family entries from sibling plugins, kept in a stable relative order. */
const FAMILY_SELECTOR = '[data-dsh-tw-entry], [data-dsh-atb-entry], [data-dsh-taskboard-entry], [data-dsh-ssh-entry]'

/** Find the sidebar shell root element, or undefined while not yet mounted. */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>(
    '[data-pane="sidebar"], [class*="sidebarCol"], .dshDesktopUpstreamSidebar, .dshDesktopSidebarSurface',
  )
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

/** The New Session button inside the sidebar root. */
function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child instanceof HTMLButtonElement && !child.matches(ENTRY_SELECTOR)) return child
  }
  const byAria = root.querySelector<HTMLButtonElement>(
    'button[aria-label="新建会话"], button[aria-label="New Session"], button[aria-label*="新会话"], button[aria-label*="new session" i]',
  )
  if (byAria !== null) return byAria
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
  return buttons.find(button => !button.matches(ENTRY_SELECTOR) && /新会话|新建会话|new session/i.test(button.textContent ?? ''))
}

/**
 * Build one entry row (a detached button; inserted once the shell is up).
 *
 * `wikiId` is optional and only used in multi-wiki mode: clicking the row focuses
 * that knowledge base before toggling the panel, so the row a user clicks is the
 * wiki they get. Single-wiki installs pass nothing and behave exactly as before.
 */
function createEntry(
  state: PanelState,
  label: string,
  wikiId?: string,
): { entry: HTMLButtonElement; labelEl: HTMLSpanElement } {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.dataset.dshTwEntry = ''
  entry.className = 'dsh-tw-entry'
  if (wikiId !== undefined) entry.dataset.wiki = wikiId
  entry.setAttribute('aria-label', `TiddlyWiki 知识库：${label}`)
  const icon = document.createElement('span')
  icon.className = 'dsh-tw-entry-icon'
  icon.innerHTML = ICON
  const labelEl = document.createElement('span')
  labelEl.className = 'dsh-tw-entry-label'
  labelEl.textContent = label
  entry.append(icon, labelEl)
  entry.addEventListener('click', () => {
    // 多库：先把这个库设为「焦点库」，面板随后加载它自己的 /tw/<id>/。
    if (wikiId !== undefined) setFocusWiki(wikiId)
    state.toggle()
  })
  return { entry, labelEl }
}

/** Re-insert the entry before the whole family block (stable ordering). */
function placeEntry(root: HTMLElement, entry: HTMLButtonElement): boolean {
  try {
    const button = newSessionButton(root)
    if (button === undefined) return false
    if (entry.parentElement !== root) {
      const row = button.closest('[class*="logoRow"]')
      const base = (row !== null && row.parentElement === root) ? row : button
      const family = Array.from(root.children).filter(
        (el): el is HTMLElement => el instanceof HTMLElement && el.matches(FAMILY_SELECTOR),
      )
      // `base` may be a DEEP descendant (newSessionButton queries any depth):
      // insertBefore throws NotFoundError when the anchor is not a child of
      // root, so only a real root child may serve as the anchor.
      let anchor: Element | null = family.length > 0 ? (family[0] ?? null) : base.nextElementSibling
      if (anchor !== null && anchor.parentElement !== root) anchor = null
      root.insertBefore(entry, anchor)
    }
    return true
  } catch (error) {
    // DOM 挂载问题只记日志、永不 throw（插件约定）。
    console.error('[dsh-tiddlywiki] sidebar entry placement failed:', error)
    return false
  }
}

/**
 * Mount the sidebar entry, waiting for the shell and self-healing on later
 * re-renders. The row label starts at the default and is refreshed from the
 * live config (`ui.sidebarLabel`) as soon as /status answers.
 * @param state - the shared panel state the entry toggles.
 * @returns disposer removing the entry and its observers.
 */
export function mountSidebarEntry(state: PanelState): () => void {
  /** 多库：每个**在运行**的库一个入口行，用自己的显示名（作者 2026-09-28 要求）。 */
  const rows = new Map<string, { entry: HTMLButtonElement; labelEl: HTMLSpanElement }>()
  const { entry, labelEl } = createEntry(state, 'TiddlyWiki')
  rows.set('', { entry, labelEl })
  let disposed = false
  /**
   * 自定义显示名：/status 返回 ui.sidebarLabel（设置页「侧边栏入口显示名称」）。
   * 挂载时读一次，并在设置页保存后（invalidateUiConfig 会通知订阅者）重读——
   * 旧实现只读一次，改完设置要刷新整页才生效（v0.22.8）。
   */
  const applyLabel = async (): Promise<void> => {
    const cfg = await fetchUiConfig()
    // 卸载后不再改 DOM；旧 host 无该字段时保持默认名。
    if (disposed || cfg.sidebarLabel.length === 0) return
    labelEl.textContent = cfg.sidebarLabel
    entry.setAttribute('aria-label', cfg.sidebarLabel)
  }
  void applyLabel()
  const unsubscribeLabel = subscribeUiConfig(() => { void applyLabel() })

  /**
   * 多库：给**每个在运行**的库挂一个入口行（v0.28.2，作者要求"有多少个 wiki 启动了就按
   * 各自的展示名称显示入口"）。
   *
   * 为什么只列「在运行」的：一个入口行点了就该能打开那个库；没在跑的库点开会先卡在启动
   * 上。没在跑的库仍可从右下角「知识库」菜单启动（那里会把它们列全，并标注"未运行"）。
   *
   * 单库模式（名册 ≤1）：沿用**原来那一个**行与 ui.sidebarLabel —— 行为逐字不变。
   */
  const applyRoster = async (): Promise<void> => {
    const payload = await fetchStatus()
    if (disposed) return
    const list = Array.isArray(payload?.wikis) ? payload.wikis : []
    const running = list.filter((w) => w.running)
    // 单库：不建额外行，标签仍归 ui.sidebarLabel 管。
    if (running.length <= 1) {
      for (const [key, row] of rows) {
        if (key === '') continue
        row.entry.remove()
        rows.delete(key)
      }
      entry.hidden = false
      return
    }
    // 多库：默认那行让位给每个库自己的行（否则会出现一个没有库名的第 4 行）。
    entry.hidden = true
    const wanted = new Set(running.map((w) => w.id))
    // 移除已不在运行/已删除的库
    for (const [key, row] of rows) {
      if (key === '' || wanted.has(key)) continue
      row.entry.remove()
      rows.delete(key)
    }
    // 新增/更新
    for (const w of running) {
      let row = rows.get(w.id)
      if (row === undefined) {
        row = createEntry(state, w.label, w.id)
        rows.set(w.id, row)
      }
      row.labelEl.textContent = w.label
      row.entry.setAttribute('aria-label', `TiddlyWiki 知识库：${w.label}`)
      // 当前焦点库高亮
      const focused = resolveFocusWiki(running, payload?.defaultId) === w.id
      if (focused) row.entry.dataset.focus = 'true'
      else delete row.entry.dataset.focus
    }
    // 让放置逻辑把新行插进去（复用同一个 root）
    if (root !== undefined) { placed = false; tryPlace() }
  }
  void applyRoster()
  const unsubscribeFocus = subscribeFocusWiki(() => { void applyRoster() })
  const rosterTimer = window.setInterval(() => { void applyRoster() }, 10_000)
  let root: HTMLElement | undefined
  let placed = false
  /** 兜底轮询定时器：只在「尚未放置」或「shell 重建了 root」时运行。 */
  let retry: ReturnType<typeof setInterval> | undefined
  /** 本轮兜底轮询的剩余次数（有界，避免 shell 始终没有侧边栏时永久轮询）。 */
  let retryTicks = 0
  const stopRetry = (): void => {
    if (retry === undefined) return
    clearInterval(retry)
    retry = undefined
  }
  const startRetry = (): void => {
    if (retry !== undefined) return
    retryTicks = 15
    retry = setInterval(() => {
      tryPlace()
      retryTicks--
      if (placed || retryTicks <= 0) stopRetry()
    }, 2_000)
  }

  /** 当前应该出现在侧边栏里的行（隐藏的默认行不算）。 */
  const activeRows = (): HTMLButtonElement[] =>
    [...rows.values()].map((r) => r.entry).filter((el) => !el.hidden)

  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) {
      rootObserver.disconnect()
      root = undefined
      placed = false
      // shell 把 sidebar root 整体重建了：恢复兜底轮询，等新 root 出现。
      startRetry()
    }
    if (placed) {
      if (activeRows().every((el) => document.body.contains(el))) return
      rootObserver.disconnect()
      root = undefined
      placed = false
      startRetry()
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    // 逐行放置：多库时每一行都要插进侧边栏（顺序按 rows 的插入序）。
    let any = false
    for (const el of activeRows()) {
      if (placeEntry(root, el)) any = true
    }
    placed = any
    if (placed) {
      // 放置成功即停掉兜底轮询：后续自愈由 rootObserver/waitObserver 负责。
      stopRetry()
      rootObserver.observe(root, { childList: true, subtree: true })
    }
  }

  // Body-level watcher as the whole-rebuild fallback.
  const waitObserver = new MutationObserver(() => { tryPlace() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  // Self-heal: re-insert in the same frame when a re-render displaces the rows.
  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false
      startRetry()
      tryPlace()
      return
    }
    for (const el of activeRows()) {
      if (!root.contains(el)) placeEntry(root, el)
    }
  })

  // Belt-and-braces: a late shell mount with no further mutations still heals.
  // placed 成功后由 tryPlace 立即 clearInterval（见上）；仅在 root 重建时重启。
  startRetry()

  const syncActive = (): void => {
    // 面板是共享的：所有行一起高亮/取消，用户看到的"打开中"状态才一致。
    for (const el of activeRows()) {
      if (state.isOpen()) el.dataset.active = 'true'
      else delete el.dataset.active
    }
  }
  const unsubscribe = state.subscribe(syncActive)
  syncActive()
  tryPlace()

  return () => {
    disposed = true
    clearInterval(retry)
    window.clearInterval(rosterTimer)
    waitObserver.disconnect()
    rootObserver.disconnect()
    unsubscribe()
    unsubscribeLabel()
    unsubscribeFocus()
    for (const row of rows.values()) row.entry.remove()
    rows.clear()
  }
}

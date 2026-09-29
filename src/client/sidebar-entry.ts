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
import { resolveFocusWiki, setFocusWiki, subscribeFocusWiki, type FocusableWiki } from './wiki-focus.ts'
import { applyWikiIcon } from './wiki-icon.ts'

/** Stable data attribute identifying this entry row. */
export const ENTRY_SELECTOR = '[data-dsh-tw-entry]'

/** What a click on an entry row does — see {@link resolveEntryClick}. */
export type EntryClickAction = 'open' | 'close' | 'switch'

/**
 * Decide what clicking an entry row should do (v0.28.13).
 *
 * 症状（作者 2026-09-29 报障）：「左侧多 wiki 入口，有时候要点击两次才能切换到对应的库」。
 * 根因：点行**一律** `state.toggle()` —— 面板开着 A 时点 B，`setFocusWiki(B)` 确实把焦点
 * 换过去了（内核也开始换库），但同一击里的 toggle 又把面板关掉；用户看到的只是"面板没了"，
 * 得再点一次才看到 B。开着面板时点另一个库，用户要的是**切换**，不是"关面板"。
 *
 * 判定表：
 *  - 面板关着            → `open`（点哪个库就开哪个库）；
 *  - 面板开着 && 就是这个库 → `close`（入口同时也是开关，再点一次收起）；
 *  - 面板开着 && 是别的库   → `switch`（只切焦点库，面板保持打开）；
 *  - 单库那一行（`wikiId === undefined`）逐字保留原来的 toggle 语义。
 */
export function resolveEntryClick(input: {
  open: boolean
  /** 这一行绑定的库；`undefined` = 单库模式那唯一一行。 */
  wikiId: string | undefined
  /** 面板此刻**实际显示**的库（见 `mountSidebarEntry` 的 `shownWiki`）。 */
  shown: string | undefined
}): EntryClickAction {
  if (!input.open) return 'open'
  if (input.wikiId === undefined) return 'close'
  return input.wikiId === input.shown ? 'close' : 'switch'
}


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

/** What a row needs from its owner: the shared panel state and "which wiki is on screen". */
export interface EntryHooks {
  state: PanelState
  /** The wiki the panel is displaying right now (`resolveEntryClick` needs it). */
  shownWiki: () => string | undefined
}

/**
 * Run one entry-row click: decide, move the focus wiki, then open/close the panel.
 *
 * 顺序是本函数唯一容易写错的地方：`shownWiki()` 必须在 `setFocusWiki()` **之前**求值。
 * 反过来的话，刚切过去的那个库会被 `resolveEntryClick` 当成"面板此刻显示的就是它"，
 * 于是判成 `close` —— 又变回"点两次才能切库"。
 *
 * @returns the action that was taken (the guards assert on it).
 */
export function applyEntryClick(hooks: EntryHooks, wikiId: string | undefined): EntryClickAction {
  const action = resolveEntryClick({ open: hooks.state.isOpen(), wikiId, shown: hooks.shownWiki() })
  // 多库：先把这个库设为「焦点库」，面板随后加载它自己的 /tw/<id>/。
  if (wikiId !== undefined) setFocusWiki(wikiId)
  // 'open' 与 'switch' 都保持/变成打开：'switch' 时面板本来就开着，openPanel() 是空操作，
  // 换库由焦点订阅驱动内核重载（tw-frame.ts），所以**绝不能**在这里 toggle —— 那正是
  // 「点两次才能切库」的成因（v0.28.13）。
  if (action === 'close') hooks.state.closePanel()
  else hooks.state.openPanel()
  return action
}

/**
 * Build one entry row (a detached button; inserted once the shell is up).
 *
 * `wikiId` is optional and only used in multi-wiki mode: clicking the row focuses
 * that knowledge base before showing the panel, so the row a user clicks is the
 * wiki they get. Single-wiki installs pass nothing and behave exactly as before.
 */
function createEntry(
  hooks: EntryHooks,
  label: string,
  wikiId?: string,
  icon?: string,
): { entry: HTMLButtonElement; labelEl: HTMLSpanElement; iconEl: HTMLSpanElement } {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.dataset.dshTwEntry = ''
  entry.className = 'dsh-tw-entry'
  if (wikiId !== undefined) entry.dataset.wiki = wikiId
  entry.setAttribute('aria-label', `TiddlyWiki 知识库：${label}`)
  const iconEl = document.createElement('span')
  iconEl.className = 'dsh-tw-entry-icon'
  applyWikiIcon(iconEl, icon)
  const labelEl = document.createElement('span')
  labelEl.className = 'dsh-tw-entry-label'
  labelEl.textContent = label
  entry.append(iconEl, labelEl)
  entry.addEventListener('click', () => { applyEntryClick(hooks, wikiId) })
  return { entry, labelEl, iconEl }
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
  const rows = new Map<string, { entry: HTMLButtonElement; labelEl: HTMLSpanElement; iconEl: HTMLSpanElement }>()
  /**
   * `/status` 最近一次给出的「在运行库」与默认库（v0.28.13）。
   *
   * 点击一个入口行时要判断「面板此刻显示的是哪个库」，才能区分"切换"与"关面板"
   * （见 `resolveEntryClick`）——判定必须与面板/内核用**同一套解析**：
   * 记忆值 → 默认库 → 第一个可用库（`resolveFocusWiki`）。
   */
  /** 完整名册（含未运行的库）——只用于解析"面板此刻显示哪个库"（v0.29.0）。 */
  let rosterAll: FocusableWiki[] = []
  let defaultWikiId: string | undefined
  /**
   * 面板此刻显示的那个库。
   *
   * v0.29.0：必须按**完整名册**（含未运行的库）解析，与面板/内核同源 —— 内核用的就是
   * 记住的那个 id 本身（`panel.ts` 的 `getFocusWiki`），只有名册里真的没有它才回落。
   * 此前用的是"在运行的那些"，于是焦点库只是**没在跑**（还没起来 / 刚被停）时这里会
   * 回落到默认库：高亮的那一行 ≠ 面板显示的库，而点那一行会被判成"切换"而不是收起
   * （v0.28.13 修的是"点两次"的主观感受，这条是同一判定链上的第二个来源）。
   */
  const shownWiki = (): string | undefined => resolveFocusWiki(rosterAll, defaultWikiId)
  const entryHooks: EntryHooks = { state, shownWiki }
  const { entry, labelEl, iconEl } = createEntry(entryHooks, 'TiddlyWiki')
  rows.set('', { entry, labelEl, iconEl })
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
    // 点击判定与高亮都要用同一份名册（v0.28.13）：存下来，`shownWiki()` 据此解析。
    // 行只给"在运行"的库建（见函数头），但"显示的是哪个库"要按完整名册判断（v0.29.0）。
    rosterAll = list
    defaultWikiId = payload?.defaultId
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
        row = createEntry(entryHooks, w.label, w.id, w.icon)
        rows.set(w.id, row)
      }
      row.labelEl.textContent = w.label
      // 图标每次同步（v0.28.4）：在设置页改完图标，10s 内的轮询就会把它换过来。
      applyWikiIcon(row.iconEl, w.icon)
      row.entry.setAttribute('aria-label', `TiddlyWiki 知识库：${w.label}`)
    }
    // 当前焦点库高亮：与点击判定同源（`shownWiki()`），不会出现"高亮的行点一下反而关掉面板"
    paintFocus()
    // 让放置逻辑把新行插进去（复用同一个 root）
    if (root !== undefined) { placed = false; tryPlace() }
  }
  void applyRoster()
  /**
   * 焦点变化只需要重画**高亮**（v0.28.14）。
   *
   * 旧实现是 `subscribeFocusWiki(() => { void applyRoster() })`：每切一次库都**再打一次
   * `/status`**（host 处理一次要跑最多 5 个 git 进程、实测 300–400ms）并把所有行重建一遍、
   * 重新走一次放置逻辑。可是名册并没有变 —— 变的只是"哪一行亮着"。而那次往返正是
   * 「点下去要等一下界面才动」的一部分（见 tw-frame.ts 的 switchFrameNow）。
   */
  const paintFocus = (): void => {
    const focus = shownWiki()
    for (const [key, row] of rows) {
      if (key === '') continue
      if (key === focus) row.entry.dataset.focus = 'true'
      else delete row.entry.dataset.focus
    }
  }
  const unsubscribeFocus = subscribeFocusWiki(paintFocus)
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

  /**
   * Highlight the row whose knowledge base the panel is actually showing.
   *
   * NOT all rows (v0.28.6 fix): the panel is shared, but it can only display ONE
   * wiki — the focused one. Highlighting every row made it look like all three
   * were open (作者报障). The row the user clicked becomes the focus, and that is
   * the row that lights up.
   *
   * v0.28.13: the resolver is the SAME one the click handler uses (`shownWiki`),
   * so "which row is lit" and "which row closes the panel when clicked" can never
   * disagree. The old call passed `undefined` as the default id, which made the
   * highlight fall back to the FIRST running row instead of the actual default
   * wiki whenever no focus had been stored yet.
   */
  const syncActive = (): void => {
    const focus = shownWiki()
    for (const el of activeRows()) {
      const id = el.dataset.wiki
      // 单库默认行没有 data-wiki：它就是唯一那个库，面板开着时它就该亮。
      const mine = id === undefined ? activeRows().length === 1 : id === focus
      if (state.isOpen() && mine) el.dataset.active = 'true'
      else delete el.dataset.active
    }
  }
  const unsubscribe = state.subscribe(syncActive)
  const unsubscribeRowFocus = subscribeFocusWiki(syncActive)
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
    unsubscribeRowFocus()
    for (const row of rows.values()) row.entry.remove()
    rows.clear()
  }
}

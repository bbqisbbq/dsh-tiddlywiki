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
import { STATUS_ENDPOINT } from './endpoints.ts'

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

/** Build the entry row (a detached button; insert once the shell is up). */
function createEntry(state: PanelState, label: string): { entry: HTMLButtonElement; labelEl: HTMLSpanElement } {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.dataset.dshTwEntry = ''
  entry.className = 'dsh-tw-entry'
  entry.setAttribute('aria-label', 'TiddlyWiki 知识库')
  const icon = document.createElement('span')
  icon.className = 'dsh-tw-entry-icon'
  icon.innerHTML = ICON
  const labelEl = document.createElement('span')
  labelEl.className = 'dsh-tw-entry-label'
  labelEl.textContent = label
  entry.append(icon, labelEl)
  entry.addEventListener('click', () => { state.toggle() })
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

/** Debug counters (window.__twDebug) — evidence if the entry fails to appear. */
interface TwDebug { attempts: number; found: boolean; placed: boolean }

/**
 * Mount the sidebar entry, waiting for the shell and self-healing on later
 * re-renders. The row label starts at `initialLabel` and is refreshed from the
 * live config (`ui.sidebarLabel`) as soon as /status answers.
 * @param state - the shared panel state the entry toggles.
 * @param initialLabel - default display name before config loads.
 * @returns disposer removing the entry and its observers.
 */
export function mountSidebarEntry(state: PanelState, initialLabel = 'TiddlyWiki'): () => void {
  const { entry, labelEl } = createEntry(state, initialLabel)
  // 自定义显示名：/status 返回 ui.sidebarLabel（设置页「侧边栏入口显示名称」），
  // 异步到达后原地更新，无需重建 DOM（旧 host 无该字段时保持默认名）。
  void (async () => {
    try {
      const res = await fetch(STATUS_ENDPOINT, { signal: AbortSignal.timeout(5_000) })
      if (!res.ok) return
      const p = (await res.json()) as { ui?: { sidebarLabel?: string } }
      const label = p.ui?.sidebarLabel
      if (typeof label === 'string' && label.trim().length > 0) {
        labelEl.textContent = label.trim()
        entry.setAttribute('aria-label', label.trim())
      }
    } catch { /* keep the initial label */ }
  })()
  const debug: TwDebug = { attempts: 0, found: false, placed: false }
  const host = globalThis.location?.hostname
  if (host === 'localhost' || host === '127.0.0.1') {
    ;(window as unknown as { __twDebug?: TwDebug }).__twDebug = debug
  }
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

  const tryPlace = (): void => {
    debug.attempts++
    if (root !== undefined && !root.isConnected) {
      rootObserver.disconnect()
      root = undefined
      placed = false
      // shell 把 sidebar root 整体重建了：恢复兜底轮询，等新 root 出现。
      startRetry()
    }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver.disconnect()
      root = undefined
      placed = false
      startRetry()
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    debug.found = newSessionButton(root) !== undefined
    placed = placeEntry(root, entry)
    debug.placed = placed
    if (placed) {
      // 放置成功即停掉兜底轮询：后续自愈由 rootObserver/waitObserver 负责。
      stopRetry()
      rootObserver.observe(root, { childList: true, subtree: true })
    }
  }

  // Body-level watcher as the whole-rebuild fallback.
  const waitObserver = new MutationObserver(() => { tryPlace() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  // Self-heal: re-insert in the same frame when a re-render displaces the row.
  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false
      startRetry()
      tryPlace()
      return
    }
    if (!root.contains(entry)) placed = placeEntry(root, entry)
  })

  // Belt-and-braces: a late shell mount with no further mutations still heals.
  // placed 成功后由 tryPlace 立即 clearInterval（见上）；仅在 root 重建时重启。
  startRetry()

  const syncActive = (): void => {
    if (state.isOpen()) entry.dataset.active = 'true'
    else delete entry.dataset.active
  }
  const unsubscribe = state.subscribe(syncActive)
  syncActive()
  tryPlace()

  return () => {
    clearInterval(retry)
    waitObserver.disconnect()
    rootObserver.disconnect()
    unsubscribe()
    entry.remove()
  }
}

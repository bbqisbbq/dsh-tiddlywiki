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
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement !== root) {
    const row = button.closest('[class*="logoRow"]')
    const base = (row !== null && row.parentElement === root) ? row : button
    const family = Array.from(root.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.matches(FAMILY_SELECTOR),
    )
    const anchor = family.length > 0 ? (family[0] ?? null) : (base.nextElementSibling ?? null)
    root.insertBefore(entry, anchor)
  }
  return true
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
      const res = await fetch('/dsh-tiddlywiki/status', { signal: AbortSignal.timeout(5_000) })
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

  const tryPlace = (): void => {
    debug.attempts++
    if (root !== undefined && !root.isConnected) {
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    debug.found = newSessionButton(root) !== undefined
    placed = placeEntry(root, entry)
    debug.placed = placed
    if (placed) rootObserver.observe(root, { childList: true, subtree: true })
  }

  // Body-level watcher as the whole-rebuild fallback.
  const waitObserver = new MutationObserver(() => { tryPlace() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  // Self-heal: re-insert in the same frame when a re-render displaces the row.
  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false
      tryPlace()
      return
    }
    if (!root.contains(entry)) placed = placeEntry(root, entry)
  })

  // Belt-and-braces: a late shell mount with no further mutations still heals.
  const retry = setInterval(() => { tryPlace() }, 2_000)

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

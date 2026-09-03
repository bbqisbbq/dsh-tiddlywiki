/**
 * Floating "sync" button (bottom-right) — one click pulls + commits + pushes
 * the wiki git repository and reports the result, with a live status dot so
 * the human always sees whether the knowledge base is in sync.
 *
 * - honors `ui.showSyncButton`: the button is mounted async and never created
 *   when the option is off (settings page toggle);
 * - polls /dsh-tiddlywiki/status every 30s for the git state;
 * - clicking POSTs /dsh-tiddlywiki/sync (pull → commit → push) and toasts the
 *   outcome, then refreshes the dot immediately.
 *
 * Status dot mapping (git summary from /status):
 *   offline → gray   (no repo / service unreachable)
 *   dirty   → amber  (uncommitted changes)
 *   behind  → red    (remote has commits we don't — pull will rebase)
 *   clean   → green  (worktree clean)
 *
 * @module dsh-tiddlywiki/client/sync-button
 */
import { toast } from './toast.ts'

const STATUS_ENDPOINT = '/dsh-tiddlywiki/status'
const SYNC_ENDPOINT = '/dsh-tiddlywiki/sync'
const POLL_MS = 30_000

/** Public git summary shape (mirrors GitStatusViewPublic on the host). */
interface GitView {
  exists?: boolean
  branch?: string
  dirty?: boolean
  dirtyFiles?: string[]
  remote?: string
  lastCommit?: string
  ahead?: number
  behind?: number
}

interface StatusPayload {
  ok?: boolean
  status?: string
  git?: GitView | null
  ui?: { showSyncButton?: boolean }
}

/** Inline sync icon (circular arrows, stroke-based, theme-colored). */
const SYNC_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.4-3.5"/><path d="M13 2.5v3h-3"/></svg>'

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Compact local time for the tooltip (e.g. "10:32"). */
function clock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function fetchStatus(): Promise<StatusPayload | null> {
  try {
    const res = await fetch(STATUS_ENDPOINT, { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) return null
    return (await res.json()) as StatusPayload
  } catch {
    return null
  }
}

/**
 * Mount the floating sync button. Fetches /status first: when
 * `ui.showSyncButton` is off the button is never created. Returns a disposer.
 */
export function mountSyncButton(): () => void {
  let disposed = false
  let root: HTMLButtonElement | undefined
  let dot: HTMLSpanElement | undefined
  let label: HTMLSpanElement | undefined
  let lastSync: Date | undefined
  let timer: number | undefined

  const build = (): HTMLButtonElement => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'dsh-tw-sync'
    btn.title = '同步知识库（pull → commit → push）'

    const icon = document.createElement('span')
    icon.className = 'dsh-tw-sync-icon'
    icon.innerHTML = SYNC_ICON

    dot = document.createElement('span')
    dot.className = 'dsh-tw-sync-dot'
    dot.dataset.state = 'offline'

    label = document.createElement('span')
    label.className = 'dsh-tw-sync-label'
    label.textContent = '同步'

    btn.append(icon, label, dot)
    btn.addEventListener('click', () => { void doSync() })
    document.body.append(btn)
    return btn
  }

  /** Map a git summary onto the dot + label + tooltip. */
  const applyStatus = (payload: StatusPayload | null): void => {
    if (root === undefined || dot === undefined || label === undefined) return
    const git = payload?.git
    const bits: string[] = ['同步知识库']
    let state = 'offline'
    let word = '离线'

    if (git === null || git === undefined || git.exists !== true) {
      bits.push('git 仓库不可用')
    } else {
      bits.push(`分支 ${git.branch ?? '?'}`)
      if (typeof git.lastCommit === 'string') bits.push(git.lastCommit)
      const behind = typeof git.behind === 'number' ? git.behind : 0
      const ahead = typeof git.ahead === 'number' ? git.ahead : 0
      if (ahead > 0) bits.push(`领先 ${ahead}`)
      if (behind > 0) bits.push(`落后 ${behind}`)
      if (git.dirty === true) {
        state = 'dirty'
        word = '待提交'
        bits.push(`有 ${git.dirtyFiles?.length ?? 0} 个未提交改动`)
      } else if (behind > 0) {
        state = 'behind'
        word = '可更新'
      } else {
        state = 'clean'
        word = '已同步'
      }
    }
    if (lastSync !== undefined) bits.push(`上次同步 ${clock(lastSync)}`)
    root.title = bits.join(' · ')
    dot.dataset.state = state
    label.textContent = word
  }

  const doSync = async (): Promise<void> => {
    if (root === undefined) return
    root.disabled = true
    root.classList.add('dsh-tw-sync-spin')
    if (label !== undefined) label.textContent = '同步中…'
    if (dot !== undefined) dot.dataset.state = 'syncing'
    try {
      const res = await fetch(SYNC_ENDPOINT, { method: 'POST', signal: AbortSignal.timeout(120_000) })
      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; message?: string; error?: string; status?: GitView; conflictFiles?: string[]; push?: string; changed?: boolean; restarted?: boolean; restartError?: string }
        | null
      lastSync = new Date()
      if (payload === null || payload.ok !== true) {
        const msg = payload?.error ?? payload?.message ?? `HTTP ${res.status}`
        toast(`同步失败：${msg}`)
      } else {
        let detail = ''
        if (payload.push && payload.push !== 'nothing to commit') detail = `（${payload.push}）`
        if (payload.changed === true) {
          detail += payload.restarted === true ? '，TW 已重启' : '，TW 未自动重启'
          if (payload.restartError) detail += `（${payload.restartError}）`
        }
        toast(`同步完成：${payload.message ?? 'OK'}${detail}`)
      }
      applyStatus(await fetchStatus())
    } catch (err) {
      toast(`同步失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      root.disabled = false
      root.classList.remove('dsh-tw-sync-spin')
    }
  }

  const poll = async (): Promise<void> => {
    applyStatus(await fetchStatus())
  }

  void (async () => {
    const payload = await fetchStatus()
    if (disposed || payload?.ui?.showSyncButton === false) return
    root = build()
    applyStatus(payload)
    timer = window.setInterval(() => { void poll() }, POLL_MS)
  })()

  return () => {
    disposed = true
    if (timer !== undefined) window.clearInterval(timer)
    root?.remove()
  }
}

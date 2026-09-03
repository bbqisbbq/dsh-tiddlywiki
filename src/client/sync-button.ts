/**
 * Sync controller — the git pull→commit→push logic + live git status, decoupled
 * from any DOM. In v0.5 the visual (status dot, 同步 entry, syncing spinner)
 * lives in the "知识库" FAB (knowledge-fab.ts); this module only owns state,
 * polling and the one-click sync call.
 *
 * - polls /dsh-tiddlywiki/status every 30s for the git state;
 * - `trigger()` POSTs /dsh-tiddlywiki/sync (pull → commit → push), returns the
 *   fresh state and notifies subscribers.
 *
 * Status dot mapping (git summary from /status):
 *   offline → gray   (no repo / service unreachable)
 *   dirty   → amber  (uncommitted changes)
 *   behind  → red    (remote has commits we don't — pull will rebase)
 *   clean   → green  (worktree clean)
 *
 * @module dsh-tiddlywiki/client/sync-controller
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

export interface SyncStateView {
  /** Dot color key: offline | dirty | behind | clean | syncing. */
  state: 'offline' | 'dirty' | 'behind' | 'clean' | 'syncing'
  /** Short label for the menu entry ("已同步" / "待提交" / "可更新" / "离线"). */
  label: string
  /** Full tooltip line (branch / commits / dirty files / last sync). */
  tooltip: string
  lastSync?: Date
}

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

/** Map a git summary onto a SyncStateView. */
function buildState(payload: StatusPayload | null, lastSync: Date | undefined): SyncStateView {
  const git = payload?.git
  const bits: string[] = ['同步知识库']
  let state: SyncStateView['state'] = 'offline'
  let label = '离线'

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
      label = '待提交'
      bits.push(`有 ${git.dirtyFiles?.length ?? 0} 个未提交改动`)
    } else if (behind > 0) {
      state = 'behind'
      label = '可更新'
    } else {
      state = 'clean'
      label = '已同步'
    }
  }
  if (lastSync !== undefined) bits.push(`上次同步 ${clock(lastSync)}`)
  return { state, label, tooltip: bits.join(' · '), ...(lastSync !== undefined ? { lastSync } : {}) }
}

export interface SyncController {
  /** Current state snapshot. */
  getState(): SyncStateView
  /** One-click pull → commit → push; returns the fresh state. */
  trigger(): Promise<SyncStateView>
  /** Notified whenever the state changes (including during syncing). */
  subscribe(cb: () => void): () => void
  dispose(): void
}

/**
 * Create the sync controller: starts a 30s status poll immediately and exposes
 * `trigger()` for the FAB's 同步 entry. No DOM is created here.
 */
export function createSyncController(): SyncController {
  let state: SyncStateView = { state: 'offline', label: '离线', tooltip: '同步知识库' }
  let lastSync: Date | undefined
  let timer: number | undefined
  let syncing = false
  const listeners = new Set<() => void>()

  const emit = (): void => {
    for (const cb of [...listeners]) cb()
  }

  const applyStatus = (payload: StatusPayload | null): void => {
    const next = buildState(payload, lastSync)
    if (next.state !== state.state || next.tooltip !== state.tooltip) {
      state = next
      emit()
    }
  }

  const poll = async (): Promise<void> => {
    applyStatus(await fetchStatus())
  }

  const doSync = async (): Promise<SyncStateView> => {
    if (syncing) return state
    syncing = true
    state = { ...state, state: 'syncing', label: '同步中…' }
    emit()
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
      await poll()
    } catch (err) {
      toast(`同步失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      syncing = false
      // Re-sync the label (may still be dirty after a failed sync).
      await poll()
    }
    return state
  }

  void poll()
  timer = window.setInterval(() => { void poll() }, POLL_MS)

  return {
    getState: () => state,
    trigger: doSync,
    subscribe(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    dispose() {
      if (timer !== undefined) { clearInterval(timer); timer = undefined }
      listeners.clear()
    },
  }
}

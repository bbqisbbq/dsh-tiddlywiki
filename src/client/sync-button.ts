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

import { SYNC_ENDPOINT, describeSyncResult, type SyncResultPayload } from './endpoints.ts'
import { fetchStatus, type StatusPayload } from './status-cache.ts'
const POLL_MS = 30_000

/**
 * Sync state snapshot. Only the DOT colour key and the tooltip are consumed
 * (`knowledge-fab.ts` reads `.state` for the dot and `.tooltip` for the hover
 * tip) — v0.22.8 dropped the `label` / `lastSync` fields that `buildState()`
 * computed on every poll and nothing ever displayed.
 */
export interface SyncStateView {
  /** Dot color key: offline | dirty | behind | clean | syncing. */
  state: 'offline' | 'dirty' | 'behind' | 'clean' | 'syncing'
  /** Full tooltip line (branch / commits / dirty files / last sync). */
  tooltip: string
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Compact local time for the tooltip (e.g. "10:32"). */
function clock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Map a git summary onto a SyncStateView. */
function buildState(payload: StatusPayload | null, lastSync: Date | undefined): SyncStateView {
  const git = payload?.git
  const bits: string[] = ['同步知识库']
  let state: SyncStateView['state'] = 'offline'

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
      bits.push(`有 ${git.dirtyFiles?.length ?? 0} 个未提交改动`)
    } else if (behind > 0) {
      state = 'behind'
    } else {
      state = 'clean'
    }
  }
  if (lastSync !== undefined) bits.push(`上次同步 ${clock(lastSync)}`)
  return { state, tooltip: bits.join(' · ') }
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
  let state: SyncStateView = { state: 'offline', tooltip: '同步知识库' }
  let lastSync: Date | undefined
  let timer: number | undefined
  let syncing = false
  let disposed = false
  const listeners = new Set<() => void>()

  const emit = (): void => {
    for (const cb of [...listeners]) cb()
  }

  const applyStatus = (payload: StatusPayload | null): void => {
    // 同步进行中：30s 轮询不得把 syncing 覆盖成 dirty/clean（否则状态点在同步
    // 还没结束时就显示「待提交/已同步」）。同步结束后的 poll() 会正常刷新。
    if (syncing) return
    const next = buildState(payload, lastSync)
    if (next.state !== state.state || next.tooltip !== state.tooltip) {
      state = next
      emit()
    }
  }

  const poll = async (): Promise<void> => {
    if (disposed) return // unmounted: no further fetches or state churn
    const payload = await fetchStatus()
    // Re-check AFTER the await (v0.19.1): the widget may have been disposed while
    // the request was in flight — without this the late response still mutated
    // `state` and emitted into a cleared listener set, racing a freshly mounted
    // instance's own poll.
    if (disposed) return
    applyStatus(payload)
  }

  const doSync = async (): Promise<SyncStateView> => {
    if (disposed) return state
    if (syncing) {
      // 同步中重复点击不再静默 return：给用户一个明确反馈。
      toast('同步进行中…')
      return state
    }
    syncing = true
    state = { ...state, state: 'syncing' }
    emit()
    try {
      const res = await fetch(SYNC_ENDPOINT, { method: 'POST', signal: AbortSignal.timeout(120_000) })
      const payload = (await res.json().catch(() => null)) as SyncResultPayload | null
      const result = describeSyncResult(payload, res.status)
      if (!result.ok) {
        toast(`同步失败：${result.message}`)
      } else {
        // 只在成功时记录「上次同步」，失败时 tooltip 不应显示一个假的成功时间。
        lastSync = new Date()
        toast(`同步完成：${result.message}`)
      }
    } catch (err) {
      toast(`同步失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      syncing = false
      // Re-sync the state (may still be dirty after a failed sync). This is the
      // ONLY post-sync poll — a second one used to run inside the try.
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
      disposed = true
      if (timer !== undefined) { clearInterval(timer); timer = undefined }
      listeners.clear()
    },
  }
}

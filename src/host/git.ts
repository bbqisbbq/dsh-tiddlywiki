/**
 * Git face (design doc §7, D11) — the ONLY place dsh-tiddlywiki shells out to
 * git. The wiki folder itself is the repository; the folder is pure text
 * (FileSystemAdaptor writes one file per tiddler), so git is a natural sync /
 * backup channel.
 *
 * Sync model is the single-thread alternating one:
 *   1. start of work:  `git pull --rebase --autostash`
 *   2. end of work:    `git add -A && git commit && git push`
 *   3. auto-commit:    debounced 60s commit after wiki writes (AutoCommitter)
 *
 * Conflict policy (user-confirmed, no complex handling): a rebase conflict
 * (only reachable by "forgot to pull before writing") → `git rebase --abort`
 * + report the unmerged files. Never auto-merge data.
 *
 * @module dsh-tiddlywiki/host/git
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** Timeout for quick read-only queries. */
const QUICK_TIMEOUT_MS = 5_000

/** Timeout for structural/network operations. */
const HEAVY_TIMEOUT_MS = 60_000

export interface ExecResult { ok: boolean; stdout: string; stderr: string }
export type ExecFn = (args: string[], options: { cwd?: string; timeout?: number }) => Promise<ExecResult>

/** Default exec layer: run `git <args>` under a cwd with a timeout. */
const defaultExec: ExecFn = async (args, options) => {
  try {
    const { stdout, stderr } = await execFileP('git', args, {
      cwd: options.cwd,
      timeout: options.timeout ?? QUICK_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
    return { ok: true, stdout, stderr }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e.message ?? err) }
  }
}

export interface GitStatusView {
  exists: boolean
  branch: string
  dirty: boolean
  dirtyFiles: string[]
  remote: string
  lastCommit?: string
  ahead?: number
  behind?: number
}

export interface GitActionResult { ok: boolean; message: string; conflictFiles?: string[] }

function parseCount(line: string, re: RegExp): number | undefined {
  const m = line.match(re)
  return m === null ? undefined : Number(m[1])
}

export class GitFace {
  constructor(private readonly exec: ExecFn = defaultExec) {}

  async isRepo(dir: string): Promise<boolean> {
    const r = await this.exec(['rev-parse', '--is-inside-work-tree'], { cwd: dir, timeout: 2_000 })
    return r.ok && r.stdout.trim() === 'true'
  }

  async init(dir: string, branch = 'main'): Promise<boolean> {
    const r = await this.exec(['init', '-b', branch], { cwd: dir, timeout: HEAVY_TIMEOUT_MS })
    return r.ok
  }

  /** Initial commit for a fresh repo (tolerates an empty index). */
  async initialCommit(dir: string): Promise<boolean> {
    await this.exec(['add', '-A'], { cwd: dir, timeout: HEAVY_TIMEOUT_MS })
    const r = await this.exec([...identity(), 'commit', '-m', 'chore(dsh-tiddlywiki): initial commit'], { cwd: dir, timeout: HEAVY_TIMEOUT_MS })
    return r.ok || /nothing to commit/.test(r.stderr + r.stdout)
  }

  /**
   * Stage everything and commit; a local identity is always provided so the
   * plugin never depends on the machine's global git config. Returns whether
   * a commit actually happened.
   */
  async commit(dir: string, message: string): Promise<{ committed: boolean; message: string }> {
    await this.exec(['add', '-A'], { cwd: dir, timeout: HEAVY_TIMEOUT_MS })
    const staged = await this.exec(['diff', '--cached', '--quiet'], { cwd: dir, timeout: QUICK_TIMEOUT_MS })
    // `diff --cached --quiet` exits 0 when nothing is staged → nothing to commit.
    if (staged.ok) return { committed: false, message: 'nothing to commit' }
    const r = await this.exec([...identity(), 'commit', '-m', message], { cwd: dir, timeout: HEAVY_TIMEOUT_MS })
    return r.ok
      ? { committed: true, message }
      : { committed: false, message: `commit failed: ${(r.stderr.trim() || r.stdout.trim()).slice(0, 500)}` }
  }

  async status(dir: string): Promise<GitStatusView> {
    const empty: GitStatusView = { exists: false, branch: '', dirty: false, dirtyFiles: [], remote: '' }
    const r = await this.exec(['status', '--porcelain', '-b'], { cwd: dir, timeout: QUICK_TIMEOUT_MS })
    if (!r.ok) return empty
    const lines = r.stdout.split('\n').filter((l) => l.length > 0)
    const branchLine = lines.find((l) => l.startsWith('## '))
    const branch = branchLine === undefined ? '' : branchLine.slice(3).split('...')[0] ?? ''
    const ahead = branchLine === undefined ? undefined : parseCount(branchLine, /ahead (\d+)/)
    const behind = branchLine === undefined ? undefined : parseCount(branchLine, /behind (\d+)/)
    const dirty = lines.some((l) => !l.startsWith('## '))
    const dirtyFiles = lines.filter((l) => !l.startsWith('## ')).map((l) => l.slice(3).trim()).filter(Boolean)
    const remoteR = await this.exec(['remote', '-v'], { cwd: dir, timeout: QUICK_TIMEOUT_MS })
    const remote = remoteR.ok ? remoteR.stdout.split('\n').map((l) => l.trim()).find(Boolean) ?? '' : ''
    const lastR = await this.exec(['log', '-1', '--format=%h %s'], { cwd: dir, timeout: QUICK_TIMEOUT_MS })
    const lastCommit = lastR.ok && lastR.stdout.trim().length > 0 ? lastR.stdout.trim() : undefined
    return { exists: true, branch, dirty, dirtyFiles, remote, ...(lastCommit !== undefined ? { lastCommit } : {}), ...(ahead !== undefined ? { ahead } : {}), ...(behind !== undefined ? { behind } : {}) }
  }

  /** `git pull --rebase --autostash`; on conflict: abort + report files.
   *  On success, `changed: true` means HEAD actually moved (files came in /
   *  commits were replayed) — callers use it to decide whether a running TW
   *  child needs a restart to drop its stale in-memory snapshot. */
  async pull(dir: string): Promise<GitActionResult & { changed?: boolean }> {
    const before = await this.exec(['rev-parse', 'HEAD'], { cwd: dir, timeout: QUICK_TIMEOUT_MS })
    const beforeHead = before.ok ? before.stdout.trim() : ''
    const r = await this.exec(['pull', '--rebase', '--autostash'], { cwd: dir, timeout: HEAVY_TIMEOUT_MS })
    if (r.ok) {
      const after = await this.exec(['rev-parse', 'HEAD'], { cwd: dir, timeout: QUICK_TIMEOUT_MS })
      const afterHead = after.ok ? after.stdout.trim() : ''
      const changed = beforeHead.length > 0 && beforeHead !== afterHead
      return { ok: true, message: r.stdout.trim() || 'pull ok', ...(changed ? { changed: true } : {}) }
    }
    const conflictFiles = await this.unmergedFiles(dir)
    await this.exec(['rebase', '--abort'], { cwd: dir, timeout: HEAVY_TIMEOUT_MS })
    const reason = (r.stderr.trim() || r.stdout.trim()).slice(0, 500)
    return { ok: false, message: conflictFiles.length > 0 ? `conflict in ${conflictFiles.join(', ')} (rebase aborted): ${reason}` : `pull failed: ${reason}`, ...(conflictFiles.length > 0 ? { conflictFiles } : {}) }
  }

  async push(dir: string): Promise<GitActionResult> {
    const r = await this.exec(['push'], { cwd: dir, timeout: HEAVY_TIMEOUT_MS })
    return r.ok
      ? { ok: true, message: r.stdout.trim() || 'push ok' }
      : { ok: false, message: (r.stderr.trim() || r.stdout.trim()).slice(0, 500) }
  }

  /** First push with upstream tracking (called once after a remote is set). */
  async firstPush(dir: string): Promise<GitActionResult> {
    const branch = (await this.status(dir)).branch || 'main'
    const r = await this.exec(['push', '-u', 'origin', branch], { cwd: dir, timeout: HEAVY_TIMEOUT_MS })
    return r.ok
      ? { ok: true, message: `pushed ${branch} to origin` }
      : { ok: false, message: (r.stderr.trim() || r.stdout.trim()).slice(0, 500) }
  }

  /** Ensure `origin` points at `url` (add or set-url). */
  async ensureRemote(dir: string, url: string): Promise<GitActionResult> {
    const cur = await this.exec(['remote', 'get-url', 'origin'], { cwd: dir, timeout: QUICK_TIMEOUT_MS })
    if (cur.ok) {
      if (cur.stdout.trim() === url) return { ok: true, message: 'remote origin already set' }
      const set = await this.exec(['remote', 'set-url', 'origin', url], { cwd: dir, timeout: HEAVY_TIMEOUT_MS })
      return set.ok ? { ok: true, message: `remote origin → ${url}` } : { ok: false, message: set.stderr.trim() || 'remote set-url failed' }
    }
    const add = await this.exec(['remote', 'add', 'origin', url], { cwd: dir, timeout: HEAVY_TIMEOUT_MS })
    return add.ok ? { ok: true, message: `remote origin → ${url}` } : { ok: false, message: add.stderr.trim() || 'remote add failed' }
  }

  private async unmergedFiles(dir: string): Promise<string[]> {
    const r = await this.exec(['diff', '--name-only', '--diff-filter=U'], { cwd: dir, timeout: QUICK_TIMEOUT_MS })
    return r.ok ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []
  }
}

/** Always-on local identity so commits never depend on global git config. */
function identity(): string[] {
  return ['-c', 'user.name=dsh-tiddlywiki', '-c', 'user.email=dsh-tiddlywiki@local']
}

export interface AutoCommitterOptions {
  git: GitFace
  dir: string
  enabled: boolean
  debounceMs: number
  message: () => string
  onError?: (err: unknown) => void
  onCommit?: (info: { committed: boolean; message: string }) => void
}

/**
 * Debounced auto-committer: every wiki write calls `touch()`; the commit
 * fires once writes settle for `debounceMs`. Disable with git.autoCommit.
 */
export class AutoCommitter {
  private timer: NodeJS.Timeout | undefined
  private disposed = false

  constructor(private readonly options: AutoCommitterOptions) {}

  touch(): void {
    if (!this.options.enabled || this.disposed) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.flush() }, this.options.debounceMs)
  }

  /** Run a commit now (also cancels the pending debounce). */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!this.options.enabled || this.disposed) return
    try {
      const result = await this.options.git.commit(this.options.dir, this.options.message())
      this.options.onCommit?.(result)
    } catch (err) {
      this.options.onError?.(err)
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }
}

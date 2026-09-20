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
 * **Commit guard (v0.23.4, 真实事故)**: `git pull --rebase --autostash` can end
 * with the REBASE succeeding but the autostash RE-APPLY conflicting. `rebase
 * --abort` then has nothing to abort, so the conflict markers stay in the
 * working tree while every subsequent `git add -A && commit` (the 60s
 * AutoCommitter included) happily **commits and pushes them** — on 2026-09-17
 * that is exactly how `<<<<<<< Updated upstream` got permanently written into
 * this wiki's config tiddler, which in turn made the plugin unable to parse its
 * own config for a day (wechat stayed off + prompt.extra silently inactive).
 * `commit()` therefore REFUSES a conflicted tree up front (see
 * `conflictState()`), and `pull()` re-checks after its abort.
 *
 * @module dsh-tiddlywiki/host/git
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** Timeout for quick read-only queries. */
const QUICK_TIMEOUT_MS = 5_000

/** Timeout for structural/network operations. */
const HEAVY_TIMEOUT_MS = 60_000

/** Max files whose CONTENT is scanned for conflict markers (v0.25.0). */
const MAX_CONTENT_SCAN_FILES = 200

/** Max size of a file worth scanning for conflict markers (v0.25.0). */
const MAX_CONFLICT_SCAN_FILE_BYTES = 2 * 1024 * 1024

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
  /** Set when the working tree is in an UNRESOLVED conflict state (v0.23.4). */
  conflict?: { reason: string; files: string[] }
}

export interface GitActionResult { ok: boolean; message: string; conflictFiles?: string[] }

/**
 * A conflict block's opening/closing line. Only the LABELLED forms count
 * (`<<<<<<< HEAD`, `>>>>>>> Stashed changes`): a bare `=======` is far too
 * common in real content (Markdown setext headings, ASCII dividers) to treat
 * as evidence of a conflict.
 */
const CONFLICT_MARKER_RE = /^(?:<{7}|>{7}) /m

/**
 * In-progress git operations that make a plain `git commit` the WRONG move.
 *
 * ⚠️ `MERGE_HEAD` / `CHERRY_PICK_HEAD` / `REVERT_HEAD` are deliberately NOT in
 * this list: with those, `git commit` IS how you conclude the operation once the
 * conflicts are resolved and staged — refusing them would make a resolved merge
 * permanently uncommittable (v0.23.4, caught by the real-git E2E). They are still
 * covered by the two content-based checks below: an *unresolved* merge shows up
 * as unmerged index entries and/or leftover conflict blocks.
 */
const CONFLICT_STATE_REFS: ReadonlyArray<readonly [string, string]> = [
  ['rebase', 'REBASE_HEAD'],
]

/** What `conflictState()` found (all-empty when the tree is safe to commit). */
export interface ConflictState { conflicted: boolean; reason: string; files: string[] }

/**
 * Thrown by `GitFace.commit()` when the tree must NOT be committed. Carries the
 * offending files so a route/tool can tell the user exactly what to resolve.
 */
export class GitConflictStateError extends Error {
  constructor(message: string, readonly reason: string, readonly files: string[]) {
    super(message)
    this.name = 'GitConflictStateError'
  }
}

function parseCount(line: string, re: RegExp): number | undefined {
  const m = line.match(re)
  return m === null ? undefined : Number(m[1])
}

export class GitFace {
  /**
   * FIFO mutex for the index-touching operations (`commit` and `pull
   * --rebase`). The debounced AutoCommitter can fire while an explicit
   * `tiddlywiki_git_sync` is rebasing; both would fight over
   * `.git/index.lock` and intermittently fail. Per-instance, so a second
   * GitFace (e.g. the settings page's status probe) is unaffected.
   */
  private lock: Promise<unknown> = Promise.resolve()

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    this.lock = run.then(() => undefined, () => undefined)
    return run
  }

  constructor(
    private readonly exec: ExecFn = defaultExec,
    /** Injected for tests: read a working-tree file as utf8 text. */
    private readonly readTextFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
  ) {}

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
   * a commit actually happened. Serialized against `pull()` (index.lock).
   */
  commit(dir: string, message: string): Promise<{ committed: boolean; message: string }> {
    return this.withLock(() => this.commitUnlocked(dir, message))
  }

  private async commitUnlocked(dir: string, message: string): Promise<{ committed: boolean; message: string }> {
    // NEVER commit a conflicted tree (v0.23.4): the 60s AutoCommitter fires on
    // its own schedule and cannot ask a human, so a leftover conflict block would
    // be committed (and pushed) verbatim. `contentScan: true` is REQUIRED here —
    // the incident shape (a failed autostash re-apply) leaves git with no
    // operation in progress, so only the file content shows the conflict.
    const conflict = await this.conflictState(dir, { contentScan: true })
    if (conflict.conflicted) {
      throw new GitConflictStateError(describeConflict(conflict), conflict.reason, conflict.files)
    }
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
    // Conflict probe (v0.23.4). The content scan only runs on a dirty tree —
    // the common clean path stays at the cheap rev-parse/unmerged probes.
    const conflict = await this.conflictState(dir, { contentScan: dirty })
    return {
      exists: true, branch, dirty, dirtyFiles, remote,
      ...(lastCommit !== undefined ? { lastCommit } : {}),
      ...(ahead !== undefined ? { ahead } : {}),
      ...(behind !== undefined ? { behind } : {}),
      ...(conflict.conflicted ? { conflict: { reason: conflict.reason, files: conflict.files } } : {}),
    }
  }

  /** `git pull --rebase --autostash`; on conflict: abort + report files.
   *  On success, `changed: true` means HEAD actually moved (files came in /
   *  commits were replayed) — callers use it to decide whether a running TW
   *  child needs a restart to drop its stale in-memory snapshot.
   *  Serialized against `commit()` (index.lock). */
  pull(dir: string): Promise<GitActionResult & { changed?: boolean }> {
    return this.withLock(() => this.pullUnlocked(dir))
  }

  private async pullUnlocked(dir: string): Promise<GitActionResult & { changed?: boolean }> {
    const before = await this.exec(['rev-parse', 'HEAD'], { cwd: dir, timeout: QUICK_TIMEOUT_MS })
    const beforeHead = before.ok ? before.stdout.trim() : ''
    // Did a rebase already exist BEFORE we ran? (v0.23.5)
    //
    // `rebase --abort` used to run unconditionally on every pull failure, so a
    // pull that fails for an UNRELATED reason (no remote, offline, unrelated
    // permission error) while the user is mid-rebase in the wiki repo wiped their
    // in-progress rebase and conflict resolution. Commits survive in the reflog /
    // ORIG_HEAD, but the resolution work is gone. We only abort what we started.
    const preexistingRebase = await this.hasRebaseInProgress(dir)
    const r = await this.exec(['pull', '--rebase', '--autostash'], { cwd: dir, timeout: HEAVY_TIMEOUT_MS })
    if (r.ok) {
      const after = await this.exec(['rev-parse', 'HEAD'], { cwd: dir, timeout: QUICK_TIMEOUT_MS })
      const afterHead = after.ok ? after.stdout.trim() : ''
      const changed = beforeHead.length > 0 && beforeHead !== afterHead
      return { ok: true, message: r.stdout.trim() || 'pull ok', ...(changed ? { changed: true } : {}) }
    }
    const conflictFiles = await this.unmergedFiles(dir)
    // Only abort when WE left a rebase behind: either it did not exist before,
    // or it did but the failure produced unmerged paths we are responsible for.
    const rebaseNow = await this.hasRebaseInProgress(dir)
    const ourRebase = rebaseNow && !preexistingRebase
    if (ourRebase) {
      await this.exec(['rebase', '--abort'], { cwd: dir, timeout: HEAVY_TIMEOUT_MS })
    }
    // The abort does NOT clean up a failed AUTOSTASH re-apply (module docblock):
    // re-check so we report the leftover markers instead of leaving them for the
    // AutoCommitter to commit.
    const after = await this.conflictState(dir)
    const files = after.conflicted ? [...new Set([...conflictFiles, ...after.files])] : conflictFiles
    const note = after.conflicted ? `（rebase --abort 之后工作树仍有冲突：${after.reason}）` : ''
    const userRebaseNote = rebaseNow && !ourRebase
      ? '（检测到你自己的 rebase 正在进行中，已保留不动——请先手动完成或 abort 它再同步）'
      : ''
    const reason = (r.stderr.trim() || r.stdout.trim()).slice(0, 500)
    return {
      ok: false,
      message: files.length > 0
        ? `conflict in ${files.join(', ')}${ourRebase ? ' (rebase aborted)' : ''}${note}${userRebaseNote}: ${reason}`
        : `pull failed${note}${userRebaseNote}: ${reason}`,
      ...(files.length > 0 ? { conflictFiles: files } : {}),
    }
  }

  /** Is a rebase in progress in `dir`? (`REBASE_HEAD` or the on-disk state dirs.) */
  private async hasRebaseInProgress(dir: string): Promise<boolean> {
    const r = await this.exec(['rev-parse', '-q', '--verify', 'REBASE_HEAD'], { cwd: dir, timeout: QUICK_TIMEOUT_MS })
    if (r.ok && r.stdout.trim().length > 0) return true
    return existsSync(join(dir, '.git', 'rebase-merge')) || existsSync(join(dir, '.git', 'rebase-apply'))
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

  /** `git fetch` (no remote configured → failure reported by the caller). */
  async fetch(dir: string): Promise<GitActionResult> {
    const r = await this.exec(['fetch'], { cwd: dir, timeout: HEAVY_TIMEOUT_MS })
    return r.ok
      ? { ok: true, message: r.stdout.trim() || 'fetch ok' }
      : { ok: false, message: (r.stderr.trim() || r.stdout.trim()).slice(0, 500) }
  }

  /**
   * Restore the given files from the freshly fetched remote HEAD (FETCH_HEAD)
   * into the working tree + index — the "keep remote version" half of
   * tiddler-granular conflict resolution. Callers must `git fetch` first.
   */
  async checkoutFetchHead(dir: string, files: string[]): Promise<GitActionResult> {
    if (files.length === 0) return { ok: true, message: 'no files given' }
    const r = await this.exec(['checkout', 'FETCH_HEAD', '--', ...files], { cwd: dir, timeout: HEAVY_TIMEOUT_MS })
    return r.ok
      ? { ok: true, message: `已从远端检出 ${files.length} 个文件` }
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

  /**
   * Is the working tree in an unresolved conflict state? (v0.23.4)
   *
   * Three sources, cheapest first — a pure `git` probe unless `contentScan`
   * is on:
   *   1. an in-progress operation (`MERGE_HEAD` / `REBASE_HEAD` / …);
   *   2. unmerged index entries (`diff --diff-filter=U`);
   *   3. a conflict BLOCK left in a changed file (the autostash-reapply case:
   *      git itself is no longer mid-operation, so only the text shows it).
   */
  async conflictState(dir: string, options: { contentScan?: boolean } = {}): Promise<ConflictState> {
    for (const [label, ref] of CONFLICT_STATE_REFS) {
      const r = await this.exec(['rev-parse', '-q', '--verify', ref], { cwd: dir, timeout: QUICK_TIMEOUT_MS })
      if (r.ok && r.stdout.trim().length > 0) {
        return { conflicted: true, reason: `${label} in progress`, files: await this.unmergedFiles(dir) }
      }
    }
    const unmerged = await this.unmergedFiles(dir)
    if (unmerged.length > 0) return { conflicted: true, reason: 'unmerged paths', files: unmerged }
    if (options.contentScan !== true) return { conflicted: false, reason: '', files: [] }
    const marked: string[] = []
    // BOUNDED SCAN (v0.25.0): `/status` runs this on every poll, and a bulk import
    // leaves thousands of changed files — reading every one of them synchronously
    // blocked the event loop (and TW's own requests) for no extra safety: a real
    // conflict also shows up as unmerged index entries or `REBASE_HEAD`, both of
    // which the cheap probes above already cover.
    const changed = await this.changedFiles(dir)
    for (const file of changed.slice(0, MAX_CONTENT_SCAN_FILES)) {
      if (this.fileHasConflictMarkers(join(dir, file))) marked.push(file)
    }
    return marked.length > 0
      ? { conflicted: true, reason: 'conflict markers in working tree', files: marked }
      : { conflicted: false, reason: '', files: [] }
  }

  /** Working-tree files a commit would touch: modified, staged and untracked. */
  private async changedFiles(dir: string): Promise<string[]> {
    const out = new Set<string>()
    for (const args of [
      ['diff', '--name-only', 'HEAD'],
      ['diff', '--cached', '--name-only'],
      ['ls-files', '--others', '--exclude-standard'],
    ]) {
      const r = await this.exec(args, { cwd: dir, timeout: QUICK_TIMEOUT_MS })
      if (!r.ok) continue
      for (const line of r.stdout.split('\n')) {
        const name = line.trim()
        if (name.length > 0) out.add(name)
      }
    }
    return [...out]
  }

  /**
   * Does this file contain a conflict block? Read failures and binary content
   * are treated as "no" — the guard is a safety net, not a content auditor.
   *
   * Size-guarded since v0.25.0: the scan runs on every `/status` poll while the
   * tree is dirty, and a wiki can hold multi-MB attachments; those are never
   * where a rebase marker lands. A stat failure (an injected reader in tests)
   * falls through to the reader instead of silently skipping the file.
   */
  private fileHasConflictMarkers(absPath: string): boolean {
    try {
      if (!this.isScannableFile(absPath)) return false
      const text = this.readTextFile(absPath)
      if (text.includes('\u0000')) return false
      return CONFLICT_MARKER_RE.test(text)
    } catch {
      return false
    }
  }

  /** Is this a small-ish regular file worth reading? (unknown → yes) */
  private isScannableFile(absPath: string): boolean {
    try {
      const info = statSync(absPath)
      return info.isFile() && info.size <= MAX_CONFLICT_SCAN_FILE_BYTES
    } catch {
      return true
    }
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

/**
 * Wording for a refused commit — shared by the error, the AutoCommitter log and
 * the `/sync` 409 body so all three say the same actionable thing.
 */
export function describeConflict(state: ConflictState): string {
  const shown = state.files.slice(0, 5)
  const more = state.files.length > shown.length ? ` 等 ${state.files.length} 个文件` : ''
  const where = shown.length > 0 ? `涉及 ${shown.join('、')}${more}` : '（未列出具体文件）'
  return `拒绝提交：工作树处于未解决的冲突状态（${state.reason}），${where}。`
    + '带着冲突标记提交会把坏内容写进 git 历史（v0.23.3 的真实事故：wiki 配置 tiddler 被提交了 '
    + '<<<<<<< 标记，插件随即解析不了自己的配置）。请先解决冲突（tiddlywiki_git_resolve 或手动编辑）再同步。'
}

export interface AutoCommitterOptions {
  git: GitFace
  dir: string
  enabled: boolean
  debounceMs: number
  message: () => string
  onError?: (err: unknown) => void
  /** Observability hook: fired after each flush attempt (used by selftest to
   *  assert the debounce really committed). */
  onCommit?: (info: { committed: boolean; message: string }) => void
}

/**
 * Debounced auto-committer: every wiki write calls `touch()`; the commit
 * fires once writes settle for `debounceMs`. Disable with git.autoCommit.
 */
export class AutoCommitter {
  private timer: NodeJS.Timeout | undefined
  private disposed = false
  /**
   * Signature of the conflict we already reported. The debounce fires every
   * 60s and a leftover conflict block stays put until a human fixes it, so
   * reporting on every tick would bury the log; report once per distinct state
   * (v0.23.4) and reset the moment a commit succeeds.
   */
  private lastBlocked: string | undefined

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
      this.lastBlocked = undefined
      this.options.onCommit?.(result)
    } catch (err) {
      if (err instanceof GitConflictStateError) {
        const signature = `${err.reason}|${err.files.join(',')}`
        if (signature === this.lastBlocked) return
        this.lastBlocked = signature
      }
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

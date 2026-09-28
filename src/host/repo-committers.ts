/**
 * ONE debounced auto-committer per REPOSITORY (v0.28.0).
 *
 * WHY NOT ONE PER WIKI
 * --------------------
 * Two knowledge bases may be subfolders of one repository (the "工作 + 个人 共用现有
 * 仓库、按文件夹物理划分" topology). Git then has ONE index, and `git add -A` run
 * from ANY subdirectory stages the WHOLE working tree — so two per-folder
 * committers would each commit the other's changes, and one of them would
 * forever report `nothing to commit`. The unit that can safely commit is the
 * REPOSITORY, so that is the unit this class keys on.
 *
 * It also decides where the commit runs: at the REPOSITORY ROOT, never in a
 * wiki subfolder (`commit(dir)` runs `git add -A` with `cwd = dir`).
 *
 * THE DIR → REPO LOOKUP IS ASYMMETRICALLY CACHED
 * ----------------------------------------------
 * A POSITIVE answer (this folder belongs to repo X) is cached forever. A
 * NEGATIVE one is not cached at all: `git init` happens moments after the first
 * touch in a fresh install, and a cached "not a repo" would silently disable
 * auto-commit for the rest of the session — exactly the class of bug this
 * repository has paid for more than once.
 *
 * @module dsh-tiddlywiki/host/repo-committers
 */
import { AutoCommitter, type GitFace } from './git.ts'
import { pathComparisonKey } from './path-key.ts'

/** The effective auto-commit settings (re-read so a settings save applies live). */
export interface RepoCommitSettings {
  autoCommit: boolean
  debounceMs: number
}

export interface RepoCommittersOptions {
  git: GitFace
  /** Read the CURRENT effective git settings. */
  settings: () => RepoCommitSettings
  /** Commit message factory. */
  message: () => string
  log?: (message: string) => void
}

interface RepoState {
  repoRoot: string
  committer: AutoCommitter
}

export class RepoCommitters {
  /** Keyed by `pathComparisonKey(repoRoot)`. */
  private readonly repos = new Map<string, RepoState>()
  /** Positive `dir → repoRoot` cache only (see the module header). */
  private readonly dirToRepo = new Map<string, string>()
  private readonly log: (message: string) => void

  constructor(private readonly options: RepoCommittersOptions) {
    this.log = options.log ?? ((message) => { console.warn('[dsh-tiddlywiki]', message) })
  }

  /** Repositories with a live committer (diagnostics / tests). */
  repoRoots(): string[] {
    return [...this.repos.values()].map((state) => state.repoRoot)
  }

  /** The repository root owning `dir`, or undefined when it is not in one. */
  async repoRootOf(dir: string): Promise<string | undefined> {
    const key = pathComparisonKey(dir)
    const cached = this.dirToRepo.get(key)
    if (cached !== undefined) return cached
    const root = await this.options.git.repoRoot(dir)
    if (root !== undefined) this.dirToRepo.set(key, root)
    return root
  }

  /**
   * Debounced commit for the repository owning `dir`.
   *
   * Fire-and-forget friendly (the fs watcher calls it synchronously): the first
   * call for a folder pays one `git rev-parse`, every later one is a Map hit.
   */
  async touch(dir: string): Promise<void> {
    const state = await this.stateFor(dir)
    state?.committer.touch()
  }

  /** Commit now. Omit `dir` to flush every repository (teardown / switch). */
  async flush(dir?: string): Promise<void> {
    if (dir === undefined) {
      for (const state of this.repos.values()) {
        try { await state.committer.flush() } catch { /* best-effort */ }
      }
      return
    }
    const root = await this.repoRootOf(dir)
    if (root === undefined) return
    try { await this.repos.get(pathComparisonKey(root))?.committer.flush() } catch { /* best-effort */ }
  }

  /**
   * Rebuild every committer from the CURRENT settings (v0.25.0's "git.* takes
   * effect on the running plugin"): `AutoCommitter` snapshots `enabled` and
   * `debounceMs` at construction, so a settings-page save has to rebuild.
   */
  rebuild(): void {
    for (const [key, state] of [...this.repos]) {
      state.committer.dispose()
      this.repos.set(key, { repoRoot: state.repoRoot, committer: this.create(state.repoRoot) })
    }
  }

  /** Release every committer (plugin teardown). */
  dispose(): void {
    for (const state of this.repos.values()) state.committer.dispose()
    this.repos.clear()
    this.dirToRepo.clear()
  }

  private create(repoRoot: string): AutoCommitter {
    const settings = this.options.settings()
    return new AutoCommitter({
      git: this.options.git,
      // The COMMIT runs at the repository root, never in a wiki subfolder.
      dir: repoRoot,
      enabled: settings.autoCommit,
      debounceMs: settings.debounceMs,
      message: this.options.message,
      onError: (err) => this.log(`autocommit(${repoRoot}): ${err instanceof Error ? err.message : String(err)}`),
    })
  }

  private async stateFor(dir: string): Promise<RepoState | undefined> {
    const root = await this.repoRootOf(dir)
    if (root === undefined) return undefined
    const key = pathComparisonKey(root)
    const existing = this.repos.get(key)
    if (existing !== undefined) return existing
    const state: RepoState = { repoRoot: root, committer: this.create(root) }
    this.repos.set(key, state)
    this.log(`自动提交按仓库分组：${root}`)
    return state
  }
}

/**
 * dsh-tiddlywiki — host half: the auto-commit layer + the effective-config
 * accessors index.ts reads on every hot path.
 *
 * WHY THESE TWO LIVE TOGETHER (v0.28.8)
 * -------------------------------------
 * They share one owner: the REPOSITORY. `RepoCommitters` keys auto-commit by
 * repository rather than by wiki (several knowledge bases may be subfolders of
 * one repo), and the settings that drive it (`git.autoCommit` / `debounceMs` /
 * `remote`) are therefore resolved PER REPOSITORY — from the first wiki inside
 * it, in list order. The `eff()` / `workspaceMark()` / `bridgeConfig()` /
 * `wechatConfig()` accessors are the same question asked about the DEFAULT
 * wiki, so splitting them into a second file would have duplicated the
 * "resolve through the default runtime, fall back to the cordis base" rule.
 *
 * index.ts still owns the mutable state (`farm`, `disposed`, the config), and
 * passes every hop in explicitly — see `GitLayerDeps`.
 *
 * @module dsh-tiddlywiki/index-git
 */
import type { AutoCommitter, GitFace } from './host/git.ts'
import { RepoCommitters } from './host/repo-committers.ts'
import { normalizeWechatConfig, type WechatPublishConfig } from './host/wechat-publish.ts'
import type { BridgeConfig } from './host/clip-bridge.ts'
import type { PluginConfigShape } from './host/config.ts'
import type { WikiEntry } from './host/wiki-registry.ts'
import type { WikiFarm } from './host/wiki-farm.ts'
import type { WikiInstance } from './host/wiki-instance.ts'
import { entryIsInRepo } from './index-wikis.ts'

/** The resolved `git` block the cordis `config:` block carried. */
export interface ResolvedGitConfig {
  autoCommit: boolean
  debounceMs: number
  remote: string
  branch: string
}

/** The resolved `note` block (only the workspace switch is read here). */
export interface ResolvedNoteConfig {
  tag: string
  workspaceMark: boolean
}

export interface GitLayerDeps {
  /** One `GitFace` for the whole plugin (probes + remote surgery). */
  git: GitFace
  /** The RUNNING farm (undefined until the control file has been read). */
  farm: () => WikiFarm<WikiInstance> | undefined
  /** The runtime legacy/agent traffic falls back to. */
  defaultInstance: () => WikiInstance | undefined
  /** The cordis `config:` block, as the base layer of every wiki's config. */
  baseShape: () => PluginConfigShape
  /** Resolved cordis config; the fields below are its `git` / `note` blocks. */
  gitConfig: () => ResolvedGitConfig
  noteConfig: () => ResolvedNoteConfig
  /** The folder the default wiki occupies, running or not (see index-wikis.ts). */
  defaultPath: () => string
  /** The multi-wiki control file (a registry write may be needed here). */
  registryFile: () => string
  /** Teardown-aware (v0.23.5): a reapply must not re-arm after dispose. */
  isDisposed: () => boolean
}

export interface GitLayer {
  /** Auto-commit is keyed by REPOSITORY, not by wiki (v0.28.0). */
  repos: RepoCommitters
  /**
   * Release every running wiki's fs watcher AND flush every repository's pending
   * commit (plugin teardown / a wiki switch). The COMMITTERS themselves are
   * plugin-wide — one per repository — so they are NOT dropped here: a switch
   * must not throw away the debounce window of unrelated wikis that share the
   * same repository.
   */
  teardownCommitter: () => Promise<void>
  /**
   * Re-apply the EFFECTIVE git config to the running instance (v0.25.0).
   *
   * Until then, `git.*` was read ONCE: `AutoCommitter` snapshots
   * `enabled`/`debounceMs` into immutable options at construction, and the remote
   * only reached the repo through `bootstrapGit()` at startup. The settings page
   * happily saved + echoed new values that changed nothing until a dsh web
   * restart — turning 自动提交 off kept committing, changing the remote kept
   * pushing to the old one. Rebuilding the committer closes that gap; the guard
   * flag (plus teardownExtras' own idempotence) keeps a burst of saves from
   * leaving two committers or a dangling fs watcher.
   *
   * Not covered on purpose: an already-initialised repository keeps its branch
   * (`git.branch` is only consulted by `git.init`), and clearing the remote
   * field does not delete `origin` (that is a destructive repo change the UI
   * never promised). Both are documented in the settings page + README.
   */
  reapplyGitConfig: () => Promise<void>
  /**
   * The EFFECTIVE config of the DEFAULT wiki (cordis base + that wiki's config
   * tiddler), or the cordis base while nothing runs.
   */
  eff: () => PluginConfigShape
  /** Workspace (project) marking for agent-created notes (v0.24.0). */
  effectiveWorkspaceMark: () => boolean
  /** The clip bridge's effective config (default wiki's, else cordis base). */
  effectiveBridge: () => BridgeConfig
  /**
   * Effective 公众号发布 config (cordis base + settings-page overlay), read PER
   * REQUEST: enabling the feature, switching the adapter or rotating the token
   * applies without a dsh web restart. `normalizeWechatConfig` is the single
   * place that turns the loose config-tiddler JSON into the typed shape — a
   * garbage `adapter`/`command` falls back to the defaults instead of reaching
   * the spawned command line.
   */
  effectiveWechat: () => ReturnType<typeof normalizeWechatConfig>
}

export function createGitLayer(deps: GitLayerDeps): GitLayer {
  const { farm, defaultInstance, git } = deps

  /**
   * Per REPOSITORY (v0.28.0): several knowledge bases may share one repository,
   * so the setting is resolved from the first wiki INSIDE that repository (in
   * list order — deterministic), falling back to the default wiki and then to
   * the cordis base.
   *
   * Wikis in one repository disagreeing about `git.*` is almost always a
   * mistake (a repository has ONE remote, ONE branch, ONE index), so it is
   * called out rather than silently resolved.
   */
  const settingsForRepo = (repoRoot: string): { autoCommit: boolean; debounceMs: number } => {
    const live = farm()
    const members = (live?.registry.wikis ?? []).filter((entry) => entryIsInRepo(entry, repoRoot))
    const chosen = members[0]
    const runtimeConfig = (entry: WikiEntry | undefined): PluginConfigShape | undefined =>
      entry === undefined ? undefined : live?.runtime(entry.id)?.eff()
    const g = (runtimeConfig(chosen) ?? eff()).git ?? {}
    if (members.length > 1) {
      const fingerprints = new Set(members.map((entry) => JSON.stringify(runtimeConfig(entry)?.git ?? {})))
      if (fingerprints.size > 1) {
        console.warn(`[dsh-tiddlywiki] 知识库 ${members.map((entry) => entry.label ?? entry.id).join('、')} 共用同一个仓库（${repoRoot}），但各自配了不同的 git.* —— 一个仓库只有一份 git 设置，本次以「${chosen?.label ?? chosen?.id ?? '默认的那个库'}」为准`)
      }
    }
    const base = deps.gitConfig()
    return {
      autoCommit: g.autoCommit ?? base.autoCommit,
      debounceMs: g.debounceMs ?? base.debounceMs,
    }
  }

  const repos = new RepoCommitters({
    git,
    settings: settingsForRepo,
    message: () => `wiki autocommit ${new Date().toISOString()}`,
    log: (message) => console.warn('[dsh-tiddlywiki]', message),
  })

  const eff = (): PluginConfigShape => defaultInstance()?.eff() ?? deps.baseShape()
  const effectiveWorkspaceMark = (): boolean => defaultInstance()?.workspaceMark() ?? deps.noteConfig().workspaceMark
  /**
   * The clip bridge's effective config. `bridge.wiki` is OPTIONAL on the bridge's
   * own type (empty = the default wiki), so `baseShape().bridge` — where the
   * cordis block always fills it in — is exactly the fallback index.ts used.
   */
  const effectiveBridge = (): BridgeConfig => defaultInstance()?.bridgeConfig() ?? (deps.baseShape().bridge as BridgeConfig)
  const effectiveWechat = (): WechatPublishConfig => normalizeWechatConfig(eff().wechat)

  const teardownCommitter = async (): Promise<void> => {
    for (const runtime of farm()?.allRuntimes() ?? []) await runtime.teardownExtras()
    await repos.flush()
  }

  const reapplyGitConfig = async (): Promise<void> => {
    await teardownCommitter()
    const g = eff().git ?? {}
    const base = deps.gitConfig()
    const remote = (typeof g.remote === 'string' && g.remote.trim().length > 0 ? g.remote : base.remote).trim()
    if (remote.length > 0) {
      // Repo-level operation: running it inside any wiki folder of that
      // repository sets the repository's `origin` (there is only one).
      const ensured = await git.ensureRemote(deps.defaultPath(), remote)
      if (!ensured.ok) console.warn('[dsh-tiddlywiki] git remote update:', ensured.message)
    }
    repos.rebuild()
    for (const runtime of farm()?.allRuntimes() ?? []) runtime.setupExtras()
  }

  return {
    repos,
    teardownCommitter,
    reapplyGitConfig,
    eff,
    effectiveWorkspaceMark,
    effectiveBridge,
    effectiveWechat,
  }
}

/** Re-exported so index.ts keeps one import for the commit-layer types. */
export type { AutoCommitter }

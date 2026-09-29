/**
 * dsh-tiddlywiki — host half: the STARTUP stage (v0.30.50).
 *
 * `apply()` used to inline this ~100-line task between the git layer and the
 * wiki views. It is a STAGE, not wiring: it runs exactly once, in a fixed order,
 * and every step after the first await is followed by a `disposed` check.
 *
 * WHAT STAYS IN THE ENTRY POINT
 * -----------------------------
 * - `disposed` — its owner is the teardown effect (which sets it) AND the
 *   startup task (which checks it after every await). The task therefore gets it
 *   as an **accessor** (`isDisposed`) and, when it notices teardown, stops the
 *   child ITSELF (v0.19.1: otherwise the disposer finishes first and the task
 *   then spawns an orphan TW child / binds a leaked listener).
 * - `farm` — created BY this task, but owned by the whole plugin (routes, tools,
 *   wiki views all read it). So the task creates it through a `setFarm` callback
 *   instead of holding it: the entry point stays the single owner of the mutable
 *   state, exactly as `index-wikis.ts` / `index-routes.ts` do it.
 * - The control-file cache (`controlRegistry` / `controlSource` /
 *   `controlWarnings` / `controlError`) and the session scopes are filled by this
 *   task but read everywhere else ⇒ same pattern, one `setControl*` each.
 *
 * ORDER IS SEMANTICS (do not reorder):
 *   1. install the 「拆分知识库」 skill — deliberately BEFORE the wiki, because it
 *      must still happen when the wiki is slow, fails, or the config is broken.
 *      (It used to sit after `farm.startAll()`: a wiki that never became ready
 *      also silently never installed the skill. Found by restarting a real host.)
 *   2. read the CONTROL FILE (mode + list + default id) — it must be read before
 *      anything starts, which is why it lives outside every wiki.
 *   3. read the per-session scopes (a preference: an unreadable file just means
 *      "no explicit scope").
 *   4. build the farm and `startAll()` — each instance brings ITSELF up (child →
 *      its config tiddler → seeds → git → committer); one wiki failing never
 *      stops the others.
 *   5. `applyPrompt()` — the prompt section is a plugin-level singleton and the
 *      default wiki's config tiddler has only just been loaded.
 *   6. bind the clip bridge once, on the DEFAULT wiki's configured port (serving
 *      while disabled is intentional: every request re-checks the effective flag,
 *      so the settings toggle works without a dsh web restart).
 *
 * @module dsh-tiddlywiki/index-startup
 */
import type { GitFace } from './host/git.ts'
import type { RepoCommitters } from './host/repo-committers.ts'
import type { BridgeConfig } from './host/clip-bridge.ts'
import { installSplitSkill } from './host/skill-install.ts'
import { readSessionScopes } from './host/session-scope.ts'
import { readLocationState, type WikiLocation } from './host/wiki-location.ts'
import { WikiInstance, type WikiInstanceBase } from './host/wiki-instance.ts'
import { WikiFarm } from './host/wiki-farm.ts'
import { resolveTwRoot } from './host/admin.ts'
import {
  DEFAULT_WIKI_ID,
  DEFAULT_WIKI_MODE,
  readRegistry,
  singleEntryRegistry,
  type WikiEntry,
  type WikiRegistry,
} from './host/wiki-registry.ts'

/** Where the control-file read landed (the settings page reads this back). */
export interface ControlFileState {
  registry: WikiRegistry | undefined
  source: 'file' | 'legacy' | 'default'
  warnings: string[]
  error: string | undefined
}

export interface StartupStageDeps {
  /** The resolved cordis config, as every wiki's base layer. */
  config: WikiInstanceBase
  /** One `GitFace` for the whole plugin. */
  git: GitFace
  /** One commit layer for the whole plugin (keyed by repository). */
  repos: RepoCommitters
  /** The cordis-level default location (last resort in the registry chain). */
  defaultLocation: WikiLocation
  /** Pointer file the LEGACY single-wiki switch persists. */
  locationStateFile: string
  /** The multi-wiki control file: mode + wiki list + default id. */
  registryFile: string
  /** File the per-session scopes live in (outside every wiki). */
  sessionScopeFile: string
  /** The same-origin proxy base a wiki's TW frontend must use. */
  proxyBase: (entry: WikiEntry) => string
  /** The plugin has begun tearing down (checked after EVERY await below). */
  isDisposed: () => boolean
  /** Hand the newly built farm back to the entry point (its single owner). */
  setFarm: (farm: WikiFarm<WikiInstance> | undefined) => void
  /** Publish the control-file read (the settings page reads it back). */
  setControl: (state: ControlFileState) => void
  /** Publish the session scopes loaded from disk. */
  setSessionScopes: (scopes: Record<string, string>) => void
  /** Rebuild the plugin-level prompt section once the default config is loaded. */
  applyPrompt: () => void
  /** The clip bridge surface (bound here, owned by the entry point). */
  clipBridge: { start: (port: number) => Promise<void>; stop: () => Promise<void>; port: number }
  /** The EFFECTIVE bridge config (per-wiki override else the cordis base). */
  effectiveBridge: () => BridgeConfig
  /** The wiki's own location surface — only `defaultCurrentLocation` is read here. */
  defaultCurrentLocation: () => WikiLocation
}

/**
 * Build the fire-and-forget startup task. It resolves when startup has either
 * finished or given up; failures are logged and self-healing stays armed.
 */
export function createStartupStage(deps: StartupStageDeps): { start: () => Promise<void> } {
  /** single 模式的位置：旧指针文件 > cordis 默认（v0.22.0 的优先级，逐字保留）。 */
  const singleModeLocation = async (): Promise<WikiLocation> => {
    const state = await readLocationState(deps.locationStateFile)
    if (state.error !== undefined) console.warn('[dsh-tiddlywiki]', state.error)
    return state.active ?? deps.defaultLocation
  }

  const start = async (): Promise<void> => {
    try {
      /**
       * Ship the 「拆分知识库」 skill FIRST (v0.28.0).
       *
       * It is deliberately independent of the wiki: it only writes a file into
       * `$DSH_HOME/skills`, and it must still happen when the wiki is slow to
       * start, fails to start, or the user is mid-migration with a broken config.
       * A plugin cannot register a skill ROOT, so writing into the user's own root
       * is the only zero-config path; it only ever touches its own file (the
       * marker line decides — see host/skill-install.ts).
       */
      try {
        const installed = await installSplitSkill()
        if (installed.action === 'failed') console.warn('[dsh-tiddlywiki] 拆库 skill 安装失败：', installed.error)
        else console.info(`[dsh-tiddlywiki] 拆库 skill：${installed.action}（${installed.path}）`)
      } catch (err) {
        console.warn('[dsh-tiddlywiki] 拆库 skill 安装异常：', err)
      }
      // THE CONTROL FILE FIRST (v0.28.0): it carries the mode (single/multi), the
      // wiki list and the default id, and it must be read before anything starts
      // — which is exactly why it lives OUTSIDE every wiki (wiki-registry.ts).
      // The control file decides: mode + the wiki list.
      const read = await readRegistry({ file: deps.registryFile, legacyFile: deps.locationStateFile, fallback: deps.defaultLocation })
      // Per-session scopes are a PREFERENCE: an unreadable file just means "no
      // explicit scope" and every session falls back to the default wiki.
      const scopes = await readSessionScopes(deps.sessionScopeFile)
      if (scopes.error !== undefined) console.warn('[dsh-tiddlywiki]', scopes.error)
      deps.setSessionScopes(scopes.scopes)
      deps.setControl({ registry: read.registry, source: read.source, warnings: read.warnings, error: read.error })
      if (read.error !== undefined) console.warn('[dsh-tiddlywiki]', read.error)
      for (const warning of read.warnings) console.warn('[dsh-tiddlywiki]', warning)
      console.info(`[dsh-tiddlywiki] ${read.registry.mode} 模式 · ${read.registry.wikis.length} 个知识库（来源：${read.source}）`)
      // single 模式 = 今天的行为，逐字保留：位置仍由旧指针文件（其次 cordis 默认）
      // 决定，registry 此时只记住 `mode` 与候选列表 —— 所以这里合成一份单条清单。
      const runRegistry = read.registry.mode === 'multi'
        ? read.registry
        : singleEntryRegistry(await singleModeLocation(), DEFAULT_WIKI_ID, DEFAULT_WIKI_MODE)
      const farm = new WikiFarm<WikiInstance>(runRegistry, {
        createRuntime: (entry) => new WikiInstance({
          entry,
          base: deps.config,
          git: deps.git,
          twRoot: resolveTwRoot,
          touchCommit: (dir) => { void deps.repos.touch(dir) },
          flushCommits: (dir) => deps.repos.flush(dir),
          proxyBase: () => deps.proxyBase(entry),
        }),
        log: (message) => console.warn('[dsh-tiddlywiki]', message),
      })
      deps.setFarm(farm)
      // Every instance brings ITSELF up (child → its config tiddler → seeds →
      // git → committer), so this one call replaces the old step-by-step startup.
      // One wiki failing never stops the others (the farm reports it).
      const change = await farm.startAll()
      if (change.started.length > 0) console.info(`[dsh-tiddlywiki] 已启动：${change.started.join(', ')}`)
      // The prompt section is a plugin-level singleton: rebuild it now that the
      // default wiki's config tiddler has been loaded.
      deps.applyPrompt()
      if (deps.isDisposed()) {
        await farm.disposeAll()
        return
      }
      // Clip bridge: bind once on the DEFAULT wiki's configured port (works even
      // while disabled — every request re-checks the effective enabled flag, so
      // the settings-page toggle applies without a dsh web restart).
      try {
        await deps.clipBridge.start(deps.effectiveBridge().port)
        console.info(`[dsh-tiddlywiki] clip bridge listening on 127.0.0.1:${deps.clipBridge.port} (enabled=${deps.effectiveBridge().enabled})`)
      } catch (err) {
        console.warn('[dsh-tiddlywiki] clip bridge start:', err)
      }
      if (deps.isDisposed()) {
        try { await deps.clipBridge.stop() } catch { /* already closing */ }
        await farm.disposeAll()
        return
      }
    } catch (err) {
      console.warn('[dsh-tiddlywiki] startup issue (self-healing is armed):', err)
    }
  }

  return { start }
}

/** Re-exported so the entry point keeps one import for the registry types. */
export type { WikiRegistry }

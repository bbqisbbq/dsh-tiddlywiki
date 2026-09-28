/**
 * dsh-tiddlywiki — host half: the knowledge-base VIEW / LOCATION surface.
 *
 * Split out of index.ts (v0.28.8) because these helpers are a self-contained
 * sub-surface: they only read the farm / the control file / the legacy pointer
 * file and never touch the tool registry, the prompt or the routes. index.ts
 * still OWNS the mutable state (the farm, the control-file cache, the
 * `switching` single-flight guard, `disposed`) and hands it in through the
 * `deps` object below — the plugin entry stays the single place where that
 * state lives, so a wiki switch cannot end up with two owners.
 *
 * The factory shape (not a class, not free functions) is deliberate: every hop
 * is an explicit accessor, so this module cannot reach into closure state it
 * cannot see. That is also what keeps the move behaviour-free.
 *
 * @module dsh-tiddlywiki/index-wikis
 */
import { dshHomePath } from './sdk.ts'
import type { AdminWikisView } from './host/admin.ts'
import { isInsidePath, pathComparisonKey } from './host/path-key.ts'
import {
  clearLocationState,
  expandEnvPath,
  listWikiCandidates,
  locationPath,
  normalizeLocation,
  readLocationState,
  writeLocationState,
  type WikiLocation,
  type WikiLocationInfo,
  type WikiLocationSource,
} from './host/wiki-location.ts'
import { switchWiki, type WikiSwitchResult } from './host/wiki-switch.ts'
import {
  defaultEntry,
  entryPath,
  validateRegistry,
  writeRegistry,
  type WikiEntry,
  type WikiRegistry,
} from './host/wiki-registry.ts'
import type { WikiFarm } from './host/wiki-farm.ts'
import type { WikiInstance } from './host/wiki-instance.ts'
import { proxyBaseFor } from './host/wiki.ts'
import type { TiddlywikiConfig } from './index.ts'

/**
 * Resolve the DEFAULT wikiRoot: explicit config (env-expanded) else
 * $DSH_HOME/tiddlywiki. The runtime pointer file can override it — see
 * `readLocationState()` in host/wiki-location.ts.
 */
export function resolveWikiRoot(config: TiddlywikiConfig): string {
  if (config.wikiRoot !== undefined && config.wikiRoot.trim().length > 0) {
    return expandEnvPath(config.wikiRoot.trim())
  }
  return dshHomePath('tiddlywiki')
}

/** The farm, or undefined until the startup task has read the control file. */
type FarmGetter = () => WikiFarm<WikiInstance> | undefined

/** Everything the view/location surface reads from the plugin closure. */
export interface WikiViewsDeps {
  /** The RAW cordis `config:` block (the single-mode source question reads it). */
  rawConfig: () => TiddlywikiConfig
  /** The cordis-level default location (last resort in the registry chain). */
  defaultLocation: () => WikiLocation
  /** Pointer file the LEGACY single-wiki switch persists (wiki-location.ts). */
  locationStateFile: () => string
  /** The multi-wiki control file: mode + the wiki list + the default id. */
  registryFile: () => string
  /** The farm, or undefined until the startup task has read the control file. */
  farm: FarmGetter
  /** The runtime legacy/agent traffic falls back to (undefined = nothing up). */
  defaultInstance: () => WikiInstance | undefined
  /** The CONTROL FILE as the settings page edits it (see controlRegistryNow). */
  controlRegistryNow: () => WikiRegistry
  /** Where that view came from: 'file' / 'legacy' / 'default'. */
  controlSource: () => 'file' | 'legacy' | 'default'
  /** The control-file read's warnings (empty when clean). */
  controlWarnings: () => string[]
  /** The control-file read's error, when it had one. */
  controlError: () => string | undefined
  /** Single-flight guard: two concurrent switches would fight over the child. */
  isSwitching: () => boolean
  /** Claim / release the single-flight guard (index.ts owns the flag). */
  setSwitching: (value: boolean) => void
  /** Teardown-aware (v0.19.1 / v0.23.5): see the guards inside runSwitch. */
  isDisposed: () => boolean
  /** The prompt section must be rebuilt once the moved wiki's config tiddler loads. */
  applyPrompt: () => void
}

export interface WikiViews {
  /** The folder the default wiki occupies, running or not. */
  defaultPath: () => string
  /** The `{root,name}` the default wiki currently occupies (running or not). */
  defaultCurrentLocation: () => WikiLocation
  /** Source of the CURRENT location, for the settings page. */
  locationSource: () => Promise<WikiLocationSource>
  locationInfo: () => Promise<WikiLocationInfo>
  /** SINGLE mode: the legacy orchestrator, on the farm's default runtime. */
  runSwitch: (target: { root?: unknown; name?: unknown }, persist: (t: WikiLocation) => Promise<void>) => Promise<WikiSwitchResult>
  /** MULTI mode: move the DEFAULT wiki's folder, then let the farm reconcile. */
  repointDefault: (target: { root?: unknown; name?: unknown }) => Promise<WikiSwitchResult>
  /** Switch the DEFAULT wiki to another folder and remember the choice. */
  switchWikiLocation: (target: { root?: unknown; name?: unknown }) => Promise<WikiSwitchResult>
  /** 「恢复为配置默认」 (see the implementation note below). */
  resetWikiLocation: () => Promise<WikiSwitchResult>
  /** The control file's view for the settings page (see controlRegistryNow). */
  buildWikisView: () => AdminWikisView
}

export function createWikiViews(deps: WikiViewsDeps): WikiViews {
  const { farm, defaultInstance, defaultLocation, locationStateFile } = deps

  /** The folder the default wiki occupies, running or not. */
  const defaultPath = (): string => {
    const running = defaultInstance()
    if (running !== undefined) return running.path
    const live = farm()
    const entry = live === undefined ? undefined : defaultEntry(live.registry)
    return entry === undefined ? locationPath(defaultLocation()) : entryPath(entry)
  }
  /** The `{root,name}` the default wiki currently occupies (running or not). */
  const defaultCurrentLocation = (): WikiLocation => {
    const running = defaultInstance()
    if (running !== undefined) return running.server.currentLocation
    const live = farm()
    const entry = live === undefined ? undefined : defaultEntry(live.registry)
    return entry === undefined ? defaultLocation() : { root: entry.root, name: entry.name }
  }
  /** Source of the CURRENT location, for the settings page. */
  const locationSource = async (): Promise<WikiLocationSource> => {
    const state = await readLocationState(locationStateFile())
    if (state.active !== undefined && locationPath(state.active) === defaultPath()) return 'state'
    const raw = deps.rawConfig()
    return typeof raw.wikiRoot === 'string' && raw.wikiRoot.trim().length > 0 ? 'config' : 'default'
  }
  const locationInfo = async (): Promise<WikiLocationInfo> => {
    const state = await readLocationState(locationStateFile())
    const current = defaultCurrentLocation()
    return {
      current: { ...current, path: defaultPath(), source: await locationSource() },
      default: { ...defaultLocation(), path: locationPath(defaultLocation()) },
      stateFile: locationStateFile(),
      candidates: await listWikiCandidates(current.root),
      ...(state.error !== undefined ? { error: state.error } : {}),
    }
  }
  /** SINGLE mode: the legacy orchestrator, on the farm's default runtime. */
  const runSwitch = async (target: { root?: unknown; name?: unknown }, persist: (t: WikiLocation) => Promise<void>): Promise<WikiSwitchResult> => {
    if (deps.isSwitching()) return { ok: false, error: '正在切换知识库，请稍候再试', rolledBack: true }
    // A switch in flight while the plugin is being disposed (hot reload / dsh web
    // shutdown) would re-arm the committer + fs watcher AFTER teardown ran, and
    // could even spawn a fresh TW child after `stop()` (v0.23.5).
    const disposed = deps.isDisposed()
    if (disposed) return { ok: false, error: '插件正在卸载，已取消切换', rolledBack: false }
    const runtime = defaultInstance()
    if (runtime === undefined) return { ok: false, error: '默认知识库当前没有运行，无法切换位置', rolledBack: false }
    deps.setSwitching(true)
    try {
      const result = await switchWiki({
        currentLocation: () => runtime.server.currentLocation,
        currentPath: () => runtime.path,
        // v0.24.1: ironclad rule #1 lists the knowledge-base switch as a path
        // that MUST drain first; writes still in the OLD wiki's syncer queue were
        // otherwise killed with the child. `drainThenStop` is the shared primitive
        // (owned by the instance since v0.28.0); the rollback path reuses it, and a
        // missing client (child already down) is a no-op.
        stopServer: async () => { await runtime.drainStop() },
        applyLocation: (nextLocation) => {
          // Repoints the server AND drops the cached REST client (whose 2s list
          // cache belongs to the OLD wiki).
          runtime.updateEntry({ ...runtime.entry, root: nextLocation.root, name: nextLocation.name })
        },
        startServer: async () => { await runtime.server.start() },
        teardownExtras: () => runtime.teardownExtras(),
        setupExtras: () => { runtime.setupExtras() },
        reloadConfig: async () => {
          await runtime.config.load(runtime.client())
          // The new wiki carries its own config tiddler → its own prompt.*.
          deps.applyPrompt()
        },
        bootstrap: async () => {
          await runtime.bootstrapWiki()
          await runtime.bootstrapGit()
        },
        savePointer: persist,
        log: (message) => console.warn('[dsh-tiddlywiki]', message),
      }, target)
      // Teardown may have run while the switch was awaiting: the switch itself
      // succeeded, but the extras it re-armed must be released again so we do not
      // leak a committer/watcher past dispose (v0.23.5).
      if (deps.isDisposed()) await runtime.teardownExtras()
      // The farm must agree with the runtime the orchestrator just moved — its
      // registry is what a later `apply()` (add/remove an entry) diffs against.
      const live = farm()
      if (result.ok && live !== undefined) {
        const moved = runtime.entry
        live.syncRegistry({ ...live.registry, wikis: live.registry.wikis.map((entry) => (entry.id === moved.id ? moved : entry)) })
      }
      return result
    } finally {
      deps.setSwitching(false)
    }
  }
  /**
   * MULTI mode: move the DEFAULT wiki to another folder. The farm's reconcile
   * stops the old child, recycles the runtime and starts it on the new folder;
   * the registry is persisted LAST (a failed write costs restart-survival, not
   * the running wiki — same trade-off the pointer file already makes).
   */
  const repointDefault = async (target: { root?: unknown; name?: unknown }): Promise<WikiSwitchResult> => {
    if (deps.isDisposed()) return { ok: false, error: '插件正在卸载，已取消切换', rolledBack: false }
    const live = farm()
    if (live === undefined) return { ok: false, error: '插件尚未就绪，请稍后再试', rolledBack: true }
    if (deps.isSwitching()) return { ok: false, error: '正在切换知识库，请稍候再试', rolledBack: true }
    const normalized = normalizeLocation(target)
    if (normalized.location === undefined) return { ok: false, error: normalized.error ?? '位置非法', rolledBack: true }
    const next = normalized.location
    const current = defaultEntry(live.registry)
    if (current === undefined) return { ok: false, error: '清单里没有默认知识库', rolledBack: true }
    const moved: WikiEntry = { ...current, root: next.root, name: next.name }
    const nextRegistry: WikiRegistry = { ...live.registry, wikis: live.registry.wikis.map((entry) => (entry.id === moved.id ? moved : entry)) }
    // Re-validate: moving a folder can collide with (or nest inside) another
    // registered wiki, and those rules are the whole point of the registry.
    const validated = validateRegistry(nextRegistry)
    if (validated.registry === undefined) return { ok: false, error: validated.fatal.join('；'), rolledBack: true }
    deps.setSwitching(true)
    try {
      await live.apply(validated.registry)
      const applied: WikiSwitchResult = { ok: true, location: { root: moved.root, name: moved.name }, path: entryPath(moved) }
      try {
        await writeRegistry(validated.registry, deps.registryFile())
      } catch (err) {
        return { ...applied, warning: `位置已切换，但清单写入失败（重启 dsh web 后会回到原位置）：${err instanceof Error ? err.message : String(err)}` }
      }
      return applied
    } finally {
      deps.setSwitching(false)
    }
  }
  /** Switch the DEFAULT wiki to another folder and remember the choice. */
  const switchWikiLocation = (target: { root?: unknown; name?: unknown }): Promise<WikiSwitchResult> => {
    if (farm()?.registry.mode === 'multi') return repointDefault(target)
    return runSwitch(target, async (t) => { await writeLocationState(t, locationStateFile()) })
  }
  /**
   * 「恢复为配置默认」: single mode drops the pointer and goes back to the cordis
   * default (cleared EVEN when the current folder already IS the default, or the
   * stale pointer wins again after the next restart); multi mode moves the
   * default wiki back to the configured location.
   */
  const resetWikiLocation = async (): Promise<WikiSwitchResult> => {
    if (farm()?.registry.mode === 'multi') return repointDefault(defaultLocation())
    if (locationPath(defaultLocation()) === defaultPath()) {
      await clearLocationState(locationStateFile())
      return { ok: true, location: defaultLocation(), path: defaultPath() }
    }
    return runSwitch(defaultLocation(), async () => { await clearLocationState(locationStateFile()) })
  }

  /** The control file's view for the settings page (see controlRegistryNow). */
  const buildWikisView = (): AdminWikisView => {
    const registry = deps.controlRegistryNow()
    return {
      mode: registry.mode,
      defaultId: registry.defaultId,
      source: deps.controlSource(),
      registryFile: deps.registryFile(),
      ...(deps.controlError() !== undefined ? { error: deps.controlError() } : {}),
      warnings: deps.controlWarnings(),
      wikis: registry.wikis.map((entry) => {
        const runtime = farm()?.runtime(entry.id)
        return {
          id: entry.id,
          label: entry.label,
          root: entry.root,
          name: entry.name,
          path: entryPath(entry),
          agentVisible: entry.agentVisible,
          autostart: entry.autostart,
          running: runtime !== undefined,
          status: runtime?.server.status().status ?? 'stopped',
          // 每库图标（v0.28.8）：设置页的图标选择器发的是 `{ ...wiki, icon }` ——
          // 这里的 `wiki` 就是本函数的输出。漏掉这个字段时 `wiki.icon` 恒为
          // undefined，于是「选完图标、服务端回包一渲染就变回默认」（v0.28.4
          // 引入该选择器时只把 icon 加进了 `/status` 的 wikiSummaries，见下面
          // 1123 行那处，漏了这一处）。
          ...(entry.icon !== undefined ? { icon: entry.icon } : {}),
        }
      }),
    }
  }

  return {
    defaultPath,
    defaultCurrentLocation,
    locationSource,
    locationInfo,
    runSwitch,
    repointDefault,
    switchWikiLocation,
    resetWikiLocation,
    buildWikisView,
  }
}

/**
 * Restart the RUNNING wikis whose content a pull just changed (v0.28.0).
 *
 * Shared by the agent tool and the browser `/sync` route so the two cannot
 * drift. `dir` is where the pull ran (the repository is resolved from it) and
 * `changedFiles` are repository-relative — which is what makes this correct
 * when several knowledge bases share one repository.
 */
export async function restartAffectedWikis(
  deps: { farm: FarmGetter; repoRootOf: (dir: string) => Promise<string | undefined> },
  dir: string,
  changedFiles: readonly string[],
): Promise<{ restarted: string[]; failed: Array<{ id: string; message: string }> }> {
  const farm = deps.farm()
  if (farm === undefined) return { restarted: [], failed: [] }
  const repoRoot = (await deps.repoRootOf(dir)) ?? dir
  const restarted: string[] = []
  const failed: Array<{ id: string; message: string }> = []
  for (const runtime of farm.affectedBy(repoRoot, changedFiles)) {
    try {
      // `WikiInstance.restart()` drains the syncer queue first (rule #1).
      await runtime.restart()
      restarted.push(runtime.entry.id)
    } catch (err) {
      failed.push({ id: runtime.entry.id, message: err instanceof Error ? err.message : String(err) })
    }
  }
  return { restarted, failed }
}

/** Does this wiki live inside that repository (or is it the repository root)? */
export function entryIsInRepo(entry: WikiEntry, repoRoot: string): boolean {
  const path = entryPath(entry)
  return pathComparisonKey(path) === pathComparisonKey(repoRoot) || isInsidePath(repoRoot, path)
}

/**
 * The same-origin proxy base a wiki's TW frontend must use (v0.28.0).
 * The rule itself lives in host/wiki.ts (`proxyBaseFor`) so the harness and the
 * host cannot disagree about it — see that function for why it matters.
 */
export function proxyBaseForEntry(farm: FarmGetter, entry: WikiEntry): string {
  return proxyBaseFor(farm()?.registry.mode ?? 'single', entry.id)
}

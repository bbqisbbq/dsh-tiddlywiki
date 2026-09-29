/**
 * dsh-tiddlywiki — host half: the ROUTE + ADMIN assembly stage.
 *
 * Split out of `apply()` (v0.30.48) because it is a self-contained STAGE: the
 * two `Deps` objects below are the whole surface the route table and the
 * settings-panel admin routes consume, and they are built in one place from the
 * plugin closure. Reading the entry point top-to-bottom now shows the lifecycle
 * (farm → prompt/tools → startup task → routes), instead of the lifecycle
 * interrupted by ~120 lines of accessor wiring.
 *
 * WHAT THIS MODULE DELIBERATELY DOES **NOT** OWN
 * ----------------------------------------------
 * - `disposed` stays in the entry point (its owner is the teardown effect and
 *   the startup task), so the one guard that needs it is passed IN as a
 *   predicate — `isDisposed` — rather than read from a second home.
 * - The mutation lock: `createMutationLock()` is called by the caller and the
 *   SAME instance is handed to both `RouteDeps` and `AdminDeps` (v0.30.12: the
 *   plugin has exactly one lock, and it must be provably one — see
 *   scripts/verify-mutation-lock.mjs). This module never constructs one.
 * - Order is NOT this module's business: `registerXxxRoutes()` below is called
 *   by the entry point at the exact position it used to occupy, right after the
 *   wiki views and right before the teardown effect. Nothing here reorders the
 *   lifecycle.
 *
 * @module dsh-tiddlywiki/index-routes
 */
import type { IncomingMessage } from 'node:http'
import {
  registerRoutes,
  type AgentPresetsFace,
  type PermissionPresetsFace,
  type SessionControllerFace,
  type SessionPersistenceFace,
  type SessionsFace,
  type SessionQueryFace,
  type WebServerFace,
  type WorkspaceRegistryFace,
} from './host/routes.ts'
import {
  registerAdminRoutes,
  resolveTwRoot,
  type AdminDeps,
  type AdminWikisApplyResult,
  type AdminWikisView,
} from './host/admin.ts'
import { ConfigStore, type PluginConfigShape } from './host/config.ts'
import type { GitFace } from './host/git.ts'
import { checkAllSeeds, runSeedById, removeSeedById } from './host/seeds.ts'
import { describePrompt, type PromptConfig } from './host/prompt.ts'
import type { RepoCommitters } from './host/repo-committers.ts'
import { normalizeWechatConfig, checkWechatReady, type WechatPublishRunner } from './host/wechat-publish.ts'
import { tiddlywikiToolSummary } from './host/tools.ts'
import {
  DEFAULT_WIKI_ID,
  applyWikiAction,
  defaultEntry,
  entryPath,
  singleEntryRegistry,
  writeRegistry,
  type WikiRegistry,
} from './host/wiki-registry.ts'
import type { WikiLocation } from './host/wiki-location.ts'
import { writeLocationState } from './host/wiki-location.ts'
import { WikiInstance } from './host/wiki-instance.ts'
import { resolveAgentScope, stoppedWikiFromRequest, stoppedWikiMessage, targetRuntimeFor, type WikiFarm } from './host/wiki-farm.ts'
import { isSafeSessionId, setSessionScope } from './host/session-scope.ts'
import type { MutationLock } from './host/mutation-lock.ts'
import { restartAffectedWikis } from './index-wikis.ts'
import type { WikiViews } from './index-wikis.ts'

export interface RouteStageDeps {
  /** The lazy webServer handle the caller injected. */
  webServer: WebServerFace
  /** The plugin context — host services are resolved from it lazily. */
  get(name: string): unknown
  /** One `GitFace` for the whole plugin. */
  git: GitFace
  /** One commit layer for the whole plugin (keyed by repository). */
  repos: RepoCommitters
  /** The running farm (undefined until the control file has been read). */
  getFarm: () => WikiFarm<WikiInstance> | undefined
  /** The folder the default wiki occupies, running or not. */
  defaultPath: () => string
  /** The `{root,name}` the default wiki currently occupies (running or not). */
  defaultCurrentLocation: () => WikiLocation
  /** What the CONTROL FILE says right now (synthesized when it does not exist). */
  controlRegistryNow: () => WikiRegistry
  /** Cache the registry the settings page just wrote (the control-file cache). */
  setControlRegistry: (registry: WikiRegistry) => void
  /** sessionId → wikiId; read/written by the composer's per-session selector. */
  getSessionScopes: () => Record<string, string>
  setSessionScopes: (next: Record<string, string>) => void
  /** File the session scopes live in (outside every wiki). */
  sessionScopeFile: string
  /** The multi-wiki control file (a registry write goes here). */
  registryFile: string
  /** Pointer file the legacy single-wiki switch persists. */
  locationStateFile: string
  /** The cordis `config:` block, as the base layer of every wiki's config. */
  baseShape: PluginConfigShape
  /** The resolved cordis config (for the per-request fallbacks below). */
  config: { note: { tag: string }; wechat?: unknown; ui: { sendToAgent: { enabled: boolean; token?: string } } }
  /** Wiki location surface: `locationInfo` / switch / reset / the list view. */
  wikiViews: WikiViews
  /** The settings-page save hook: prompt + server tuning + git reapply. */
  onConfigChanged: () => void
  /** The saved prompt config of the TARGETED wiki (used when no draft is sent). */
  effectivePromptFor: (req: IncomingMessage | undefined) => PromptConfig
  /** ONE lock for the whole plugin (v0.30.12) — built by the caller. */
  mutationLock: MutationLock
  /** The WeChat publish runner (optional feature; owns the child process). */
  wechatRunner: WechatPublishRunner
  /** Teardown-aware: start → stop must not be accepted mid-dispose. */
  isDisposed: () => boolean
}

export interface RouteStage {
  /** Release both route tables (the caller returns this from its disposer). */
  dispose: () => void
}

/** Build `RouteDeps` + `AdminDeps` and register both route tables. */
export function createRouteStage(deps: RouteStageDeps): RouteStage {
  const { webServer: ws, git, repos, wikiViews } = deps
  const { defaultPath, defaultCurrentLocation, locationInfo, switchWikiLocation, resetWikiLocation, buildWikisView } = wikiViews

  // sessionController is a core host service; read it LAZILY per request (via
  // the plugin root ctx) because it may be registered after webServer, and the
  // agent routes must work whenever a request actually arrives.
  const getSessionController = (): SessionControllerFace | undefined =>
    deps.get('sessionController') as SessionControllerFace | undefined
  const getWorkspaceRegistry = (): WorkspaceRegistryFace | undefined =>
    deps.get('workspaceRegistry') as WorkspaceRegistryFace | undefined
  // agentPresets (工作模式 roster) + sessionPersistence (per-session preset
  // badges) are also core host services — resolve them lazily like the above.
  const getAgentPresets = (): AgentPresetsFace | undefined =>
    deps.get('agentPresets') as AgentPresetsFace | undefined
  const getSessionPersistence = (): SessionPersistenceFace | undefined =>
    deps.get('sessionPersistence') as SessionPersistenceFace | undefined
  // permissionPresets (权限 preset roster for the picker + applying the
  // chosen permission to new sessions) and the `sessions` in-memory store
  // (the created live session handed to permissionPresets.set) are core host
  // services — resolve them lazily like the ones above.
  const getPermissionPresets = (): PermissionPresetsFace | undefined =>
    deps.get('permissionPresets') as PermissionPresetsFace | undefined
  const getSessions = (): SessionsFace | undefined =>
    deps.get('sessions') as SessionsFace | undefined
  // sessionQuery (会话日志查询，供「知识库」Tab 判定「本会话相关笔记」) 也是核心
  // host 服务 —— 可选注入（本部署存在），懒解析。
  const getSessionQuery = (): SessionQueryFace | undefined =>
    deps.get('sessionQuery') as SessionQueryFace | undefined

  // v0.28.0: the request decides WHICH wiki. `?wiki=<id>` (a running wiki) else
  // the farm's default — resolved by the SHARED helper in host/wiki-farm.ts, so
  // the host wiring and the verification harness cannot disagree about the
  // selector (and an unknown id falls back instead of 404ing). Every accessor
  // falls back to the cordis BASE when nothing is running, so a stopped farm
  // degrades to "base defaults + 503 on writes" instead of throwing.
  const target = (req: IncomingMessage): WikiInstance | undefined => targetRuntimeFor(deps.getFarm(), req)
  /**
   * Why this request cannot be served (v0.29.0): set when `?wiki=<id>` names a
   * REGISTERED but STOPPED knowledge base. `targetRuntimeFor` deliberately
   * returns undefined for that case instead of falling back to the default wiki
   * (an unknown id still falls back — a stale bookmark must not 404), so every
   * route that either 503s on a missing client or has a harmless-looking
   * fallback (config / wiki path / prompt / status) can say WHICH wiki is down
   * and what to do, instead of quietly acting on a different one.
   */
  const targetProblem = (req: IncomingMessage): string | undefined => {
    const entry = stoppedWikiFromRequest(deps.getFarm(), req)
    return entry === undefined ? undefined : stoppedWikiMessage(entry)
  }
  const fallbackUi = WikiInstance.uiDefaultsFrom(deps.config as never)
  const fallbackWechat = normalizeWechatConfig((deps.config as { wechat?: unknown }).wechat)
  /** Used only while nothing runs: base defaults, no wiki tiddler to read. */
  const idleConfig = new ConfigStore(deps.baseShape)

  const disposeRoutes = registerRoutes({ webServer: ws }, {
    mutationLock: deps.mutationLock,
    server: (req) => target(req)?.server,
    // The roster the GUI selector + the settings page read. It reports what
    // the FARM serves right now (in single mode that is the one synthesized
    // entry); the control file's full candidate list is the admin route's job.
    wikiSummaries: (req) => {
      const registry = deps.getFarm()?.registry
      return {
        mode: registry?.mode ?? 'single',
        defaultId: registry?.defaultId ?? DEFAULT_WIKI_ID,
        items: (registry?.wikis ?? []).map((entry) => {
          const runtime = deps.getFarm()?.runtime(entry.id)
          return {
            id: entry.id,
            label: entry.label,
            status: runtime?.server.status().status ?? 'stopped',
            agentVisible: entry.agentVisible,
            autostart: entry.autostart,
            running: runtime !== undefined,
            path: entryPathOf(deps.getFarm(), entry.id),
            // 每库图标（v0.28.4）：侧边栏入口与设置页选择器共用这个来源。
            icon: entry.icon,
          }
        }),
      }
    },
    // The `/tw/<id>/…` form: the proxy resolves the child by NAME (it cannot
    // use `target()`, whose `?wiki=` would be lost inside the iframe).
    serverById: (id) => deps.getFarm()?.runtime(id)?.server,
    wikiIds: () => deps.getFarm()?.registry.wikis.map((entry) => entry.id) ?? [],
    getClient: (req) => target(req)?.client(),
    git,
    autoCommit: (req) => target(req)?.touchAutoCommit(),
    noteDefaults: (req) => ({ tag: target(req)?.noteTag() ?? deps.config.note.tag }),
    uiDefaults: (req) => target(req)?.uiDefaults() ?? fallbackUi,
    langOf: (req) => target(req)?.uiLanguage() ?? (typeof deps.baseShape.uiLanguage === 'string' && deps.baseShape.uiLanguage.trim().length > 0 ? deps.baseShape.uiLanguage.trim() : 'zh'),
    getWikiPath: (req) => target(req)?.path ?? defaultPath(),
    targetProblem,
    // Same helper as the agent tool (one implementation, two callers): a pull
    // can change several knowledge bases that share one repository.
    restartAffected: (_req, dir, changedFiles) => restartAffectedWikis({ farm: deps.getFarm, repoRootOf: (d) => repos.repoRootOf(d) }, dir, changedFiles),
    // The composer's per-session selector (v0.28.0). Reading is a Map lookup;
    // writing persists to session-scope.ts AND starts the wiki on demand — the
    // tools resolve the scope SYNCHRONOUSLY and never start anything, so the
    // selection itself has to bring the wiki up, or the very next tool call
    // would have to refuse.
    sessionScope: {
      get: (sessionId: string) => {
        const scopes = deps.getSessionScopes()
        const resolution = resolveAgentScope(deps.getFarm(), scopes, sessionId)
        const scopeId = scopes[sessionId]
        return {
          ...(scopeId !== undefined ? { scope: scopeId } : {}),
          ...(resolution.entry !== undefined ? { resolved: { id: resolution.entry.id, label: resolution.entry.label } } : {}),
          ...(resolution.reason !== undefined ? { reason: resolution.reason } : {}),
          // v0.29.0: the client needs to know whether "resolved" is a real
          // answer (multi: this session's tools act on THAT wiki, so its cards'
          // links must open it) or just the single install's only wiki (keep
          // the pre-multi DOM, which renders no wiki attribute at all).
          mode: deps.getFarm()?.registry.mode ?? 'single',
        }
      },
      set: async (sessionId: string, wikiId: string | undefined) => {
        if (!isSafeSessionId(sessionId)) throw new Error('会话 id 非法')
        const farm = deps.getFarm()
        if (wikiId !== undefined) {
          const entry = farm?.registry.wikis.find((item) => item.id === wikiId)
          if (entry === undefined) throw new Error(`知识库「${wikiId}」不在清单里`)
          // `agentVisible: false` means "the agent never reaches this one"; a
          // selector that allowed it would contradict the setting silently.
          if (!entry.agentVisible) throw new Error(`知识库「${entry.label}」对 Agent 隐身，不能作为会话作用域`)
          if (farm !== undefined && farm.runtime(entry.id) === undefined) await farm.startEntry(entry)
        }
        await setSessionScope(sessionId, wikiId, deps.sessionScopeFile)
        const next = { ...deps.getSessionScopes() }
        if (wikiId === undefined) delete next[sessionId]
        else next[sessionId] = wikiId
        deps.setSessionScopes(next)
      },
    },
    getSessionController,
    getWorkspaceRegistry,
    getAgentPresets,
    getSessionPersistence,
    getPermissionPresets,
    getSessions,
    getSessionQuery,
    sendToAgentEnabled: (req) => target(req)?.sendToAgent().enabled ?? deps.config.ui.sendToAgent.enabled,
    sendToAgentToken: (req) => target(req)?.sendToAgent().token ?? (deps.config.ui.sendToAgent.token ?? ''),
    // 公众号发布（v0.23.3，可选功能）：config 每请求重读（开关/adapter/token
    // 保存即生效，且每个知识库各有一份）；就绪探测每次都真跑一次
    // `opencli --version`（几百毫秒），只在按钮预检与每次起任务前发生，
    // 不做缓存以免装完 adapter 还要等 TTL。
    wechatConfig: (req) => target(req)?.wechatConfig() ?? fallbackWechat,
    wechatRunner: () => deps.wechatRunner,
    wechatReady: async (req) => {
      const cfg = target(req)?.wechatConfig() ?? fallbackWechat
      return checkWechatReady({ enabled: cfg.enabled, command: cfg.command })
    },
  })

  const adminDeps: AdminDeps = {
    mutationLock: deps.mutationLock,
    server: (req) => target(req)?.server,
    getClient: (req) => target(req)?.client(),
    getWikiPath: (req) => target(req)?.path ?? defaultPath(),
    targetProblem,
    twRoot: resolveTwRoot,
    config: (req) => target(req)?.config ?? idleConfig,
    onConfigChanged: deps.onConfigChanged,
    // No draft → the SAVED config of the TARGETED wiki (what is injected right
    // now); with a draft → the settings form's unsaved values (v0.22.7),
    // through the same builder.
    getPrompt: (draft, req) =>
      describePrompt(draft ?? deps.effectivePromptFor(req), tiddlywikiToolSummary()),
    // Runtime wiki location (v0.22.0): read the current folder + how it was
    // decided, switch to another one, or drop back to the cordis default.
    wiki: {
      info: locationInfo,
      switch: switchWikiLocation,
      reset: resetWikiLocation,
    },
    // The knowledge-base LIST (v0.28.0): `info` reports the CONTROL FILE; every
    // action is validated by the pure `applyWikiAction` and persisted BEFORE
    // the farm reconciles — the file is the user's intent, and a reconcile
    // failure is reported per wiki instead of silently discarding the edit.
    wikis: {
      info: async (): Promise<AdminWikisView> => buildWikisView(),
      apply: async (body: unknown): Promise<AdminWikisApplyResult> => {
        if (deps.isDisposed()) return { ok: false, error: '插件正在卸载，已取消修改' }
        // RUNTIME actions first (v0.28.0): `start`/`stop` do not change the list,
        // they change what is running. They live here rather than in the pure
        // `applyWikiAction` because they touch processes, not configuration —
        // and the GUI needs them: opening a wiki's panel must be able to bring
        // a stopped knowledge base up.
        const farm = deps.getFarm()
        const runtimeAction = (body as { action?: unknown } | null)?.action
        if (runtimeAction === 'start' || runtimeAction === 'stop') {
          if (farm === undefined) return { ok: false, error: '插件尚未就绪，请稍后再试' }
          const id = (body as { id?: unknown }).id
          const entry = typeof id === 'string' ? farm.registry.wikis.find((item) => item.id === id.trim().toLowerCase()) : undefined
          if (entry === undefined) return { ok: false, error: `知识库「${String(id)}」不在清单里` }
          const change = { started: [] as string[], stopped: [] as string[], updated: [] as string[], running: farm.runningIds(), errors: [] as Array<{ id: string; message: string }> }
          if (runtimeAction === 'start') {
            if (farm.runtime(entry.id) === undefined) {
              await farm.startEntry(entry)
              change.started.push(entry.id)
            }
          } else {
            await farm.stopEntry(entry.id)
            change.stopped.push(entry.id)
          }
          change.running = farm.runningIds()
          return { ok: true, info: buildWikisView(), change }
        }
        const action = applyWikiAction(deps.controlRegistryNow(), body)
        if (action.registry === undefined) return { ok: false, error: action.error ?? '动作被拒绝' }
        const registry = action.registry
        try {
          await writeRegistry(registry, deps.registryFile)
        } catch (err) {
          return { ok: false, error: `清单写入失败：${err instanceof Error ? err.message : String(err)}` }
        }
        deps.setControlRegistry(registry)
        // Reconcile. multi → the farm runs the whole list. single → it must
        // keep serving the ONE wiki the legacy pointer names, so the
        // synthesized run-registry is used and the pointer is kept in step
        // (otherwise a restart in single mode would land somewhere else).
        const single = defaultEntry(registry)
        const runRegistry = registry.mode === 'multi'
          ? registry
          : singleEntryRegistry(single === undefined ? defaultCurrentLocation() : { root: single.root, name: single.name }, DEFAULT_WIKI_ID, 'single')
        const change = farm === undefined
          ? { started: [], stopped: [], updated: [], running: [], errors: [] }
          : await farm.apply(runRegistry)
        if (registry.mode === 'single' && single !== undefined) {
          await writeLocationState({ root: single.root, name: single.name }, deps.locationStateFile).catch(() => undefined)
        }
        return { ok: true, info: buildWikisView(), change }
      },
    },
    seeds: {
      // Tool summaries feed the GENERATED seed content (the doc note's tool
      // list, v0.22.0) — pass them everywhere the registry can be re-run.
      checkAll: async (c) => checkAllSeeds({ client: c, tools: tiddlywikiToolSummary() }),
      run: async (c, id, force) => runSeedById({ client: c, tools: tiddlywikiToolSummary() }, id, force),
      remove: async (c, id) => removeSeedById({ client: c }, id),
    },
  }
  const disposeAdmin = registerAdminRoutes({ webServer: ws }, adminDeps)
  return {
    dispose: () => {
      disposeRoutes()
      disposeAdmin()
    },
  }
}

/** The folder a registered wiki occupies, running or not. */
function entryPathOf(farm: WikiFarm<WikiInstance> | undefined, id: string): string {
  const entry = farm?.registry.wikis.find((item) => item.id === id)
  return entry === undefined ? '' : entryPath(entry)
}

/**
 * HTTP half of the admin surface (design doc §13): the per-request dependency
 * face (`AdminDeps`) and the `/admin/*` handlers. Extracted verbatim from
 * `admin.ts` (a pure code move, v0.28.8) — the route shapes are unchanged.
 *
 * @module dsh-tiddlywiki/host/admin-routes
 */
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TiddlyWebClient } from './tw-api.ts'
import type { WikiServer } from './wiki.ts'
import { ROUTE_PREFIX, type WebServerFace } from './routes.ts'
import type { ConfigStore } from './config.ts'
import { json, guardHandler, rejectCrossSiteWrite } from './http.ts'
import { drainThenStop } from './seeds.ts'
import type { PromptPreviewConfig } from './prompt.ts'
import type { WikiLocationInfo } from './wiki-location.ts'
import type { WikiSwitchResult } from './wiki-switch.ts'
import type { MutationLock } from './mutation-lock.ts'
import { createAdminWikiRoutes } from './admin-routes-wikis.ts'
import { createAdminSeedRoutes } from './admin-routes-seeds.ts'
import { createAdminInfoRoutes } from './admin-routes-info.ts'
import { createAdminConfigRoutes } from './admin-routes-config.ts'

export interface AdminDeps {
  /** The TW child serving the wiki this request targets (undefined = not up). */
  server: (req: IncomingMessage) => WikiServer | undefined
  getClient: (req: IncomingMessage) => TiddlyWebClient | undefined
  getWikiPath: (req: IncomingMessage) => string
  twRoot: () => string
  /**
   * The config overlay OF THE TARGETED WIKI (v0.28.0: per request).
   *
   * Every knowledge base keeps its own `$:/plugins/dsh-tiddlywiki/config`
   * tiddler — that IS what "each wiki has independent settings" means in
   * practice, so the settings-page routes must say WHICH wiki they configure.
   */
  config: (req: IncomingMessage) => ConfigStore
  /**
   * Why this request names a knowledge base that cannot serve it (v0.29.0):
   * `?wiki=<id>` naming a REGISTERED but STOPPED wiki returns an actionable
   * sentence, everything else `undefined`.
   *
   * The settings page is the worst offender for the silent-wrong-wiki class
   * (its status row and config form are built from `/admin/state`, which would
   * otherwise answer with the DEFAULT wiki's path/git/config while the scope bar
   * says 「正在配置：books」), so the wiki-scoped admin handlers check this FIRST.
   */
  targetProblem?: (req: IncomingMessage) => string | undefined
  /**
   * The plugin-wide mutation lock (v0.30.12): `/admin/restart` and the seed runs
   * must not overlap with `/sync` or with each other — they all stop the TW child
   * and race the same syncer queue. Optional so harnesses still work.
   */
  mutationLock?: MutationLock
  /**
   * Called after a successful settings-page save (v0.21.0). The plugin rebuilds
   * its system-prompt section here, so a prompt.* edit applies to the running
   * session from its next model step — without restarting dsh web.
   */
  onConfigChanged?: () => void
  /**
   * The system-prompt text that WOULD be injected for a configuration, for the
   * settings page preview (v0.21.0). Called with no argument → the SAVED
   * effective config; called with a draft (v0.22.7) → those unsaved values.
   * Read-only and side-effect free; absent in headless contexts.
   */
  /**
   * The system-prompt text that WOULD be injected for a configuration, for the
   * settings page preview (v0.21.0). Called with no draft → the SAVED effective
   * config OF THE TARGETED WIKI; called with a draft (v0.22.7) → those unsaved
   * values. Takes the request since v0.28.0: every knowledge base carries its
   * own `prompt.*` in its own config tiddler, so "the saved config" is
   * meaningless without saying WHICH wiki.
   *
   * Read-only and side-effect free; absent in headless contexts.
   */
  getPrompt?: (draft: PromptPreviewConfig | undefined, req: IncomingMessage) => { enabled: boolean; mode: string; text: string }
  /**
   * Runtime wiki location (v0.22.0): where the wiki folder is, how that was
   * decided, and the two operations the settings page can perform. Absent in
   * headless contexts.
   */
  wiki?: {
    info: () => Promise<WikiLocationInfo>
    switch: (target: { root?: unknown; name?: unknown }) => Promise<WikiSwitchResult>
    reset: () => Promise<WikiSwitchResult>
  }
  /**
   * The knowledge-base LIST (v0.28.0): read it, and change it one action at a
   * time. `info` reports the CONTROL FILE (what the user edits), which is not
   * the same thing as what is running — in single mode the farm serves a
   * one-entry registry synthesized from the legacy pointer, while the file may
   * already list several candidates.
   */
  wikis?: {
    info: () => Promise<AdminWikisView>
    apply: (body: unknown) => Promise<AdminWikisApplyResult>
  }
  /** Seed registry for the settings-page "初始化" section. */
  seeds: {
    /**
     * `updateAvailable` / `userModified` / `legacyMarker` come from the marker's
     * content hashes (v0.22.0): the page shows 「有更新」 and refuses to imply a
     * local edit was checked for when the marker predates hashes.
     */
    checkAll: (client: TiddlyWebClient) => Promise<Array<{ id: string; title: string; description: string; present: boolean; removable: boolean; detail?: string; updateAvailable?: boolean; userModified?: boolean; legacyMarker?: boolean }>>
    run: (client: TiddlyWebClient, id: string | undefined, force: boolean) => Promise<Array<{ id: string; ok: boolean; wrote: boolean; detail?: string; error?: string }>>
    /** 反初始化: remove one (or all) optional seed's seeded tiddlers + markers. */
    remove: (client: TiddlyWebClient, id: string | undefined) => Promise<Array<{ id: string; ok: boolean; wrote: boolean; detail?: string; error?: string }>>
  }
}

/** One knowledge base as the settings page lists it. */
export interface AdminWikiItem {
  id: string
  label: string
  root: string
  name: string
  /** Absolute folder (`root/name`); shown so the user can find it in a file manager. */
  path: string
  agentVisible: boolean
  autostart: boolean
  running: boolean
  status: string
}

/** The control file's view (what the settings page edits). */
export interface AdminWikisView {
  mode: string
  defaultId: string
  /** Where the list came from: 'file' | 'legacy' (migrated pointer) | 'default'. */
  source: string
  /** Path of the control file (so a user can fix it by hand when told to). */
  registryFile: string
  /** Set when the control file exists but could not be fully trusted. */
  error?: string
  /** Non-fatal problems healed on the way (skipped entry, dangling default). */
  warnings: string[]
  wikis: AdminWikiItem[]
}

/** What one list change actually did (toast text + diagnostics). */
export interface AdminWikisChange {
  started: string[]
  stopped: string[]
  updated: string[]
  running: string[]
  /** Wikis that failed to start/stop; the change itself still stands. */
  errors: Array<{ id: string; message: string }>
}

/** Result of a list change: either the new state, or why it was refused. */
export type AdminWikisApplyResult =
  | { ok: true; info: AdminWikisView; change: AdminWikisChange }
  | { ok: false; error: string }

export function registerAdminRoutes(ctx: { webServer: WebServerFace }, deps: AdminDeps): () => void {
  /**
   * 503 when `?wiki=<id>` names a REGISTERED but STOPPED knowledge base (v0.29.0).
   *
   * The settings page is where this used to hurt most: the scope bar said
   * 「正在配置：books」 while `/admin/state` answered with the DEFAULT wiki's
   * path/git/`tiddlywiki.info` and `/admin/config` wrote the books patch into the
   * default wiki's config tiddler. Every wiki-scoped handler asks this FIRST,
   * because `deps.config` / `deps.getWikiPath` have harmless-looking fallbacks
   * that only ASK for the wrong-answer bug when the target is known-but-stopped.
   */
  const refuseStoppedTarget = (req: IncomingMessage, res: ServerResponse): boolean => {
    const problem = deps.targetProblem?.(req)
    if (problem === undefined) return false
    json(res, { ok: false, error: problem }, 503)
    return true
  }

  /** The 503 body for "no running wiki behind this request", wiki named if known. */
  const notRunning = (req: IncomingMessage): string => deps.targetProblem?.(req) ?? 'wiki service is not running'

  // v0.30.24：状态 / 插件·主题·语言那两条路由搬进 `admin-routes-info.ts`（纯搬迁 + 工厂化）。
  const { handleState, handleInfo } = createAdminInfoRoutes({
    config: deps.config,
    getClient: deps.getClient,
    getWikiPath: deps.getWikiPath,
    server: deps.server,
    targetProblem: deps.targetProblem,
    twRoot: deps.twRoot,
  }, { refuseStoppedTarget })


  // v0.30.25：常规配置 / 提示词预览那两条路由搬进 admin-routes-config.ts（纯搬迁 + 工厂化）。
  const { handleConfig, handlePrompt } = createAdminConfigRoutes({
    config: deps.config,
    getClient: deps.getClient,
    getPrompt: deps.getPrompt,
    onConfigChanged: deps.onConfigChanged,
  }, { refuseStoppedTarget, notRunning })

  const handleRestart = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      // v0.29.0: same guard the sibling route `/restart` has had — without it a
      // `?wiki=<registered but stopped>` request ran the drain against
      // `client: undefined` and `deps.getWikiPath(req)`'s DEFAULT-path fallback,
      // then answered `{ok:true, drained:true, status:undefined}`: a FAKE success
      // that restarted nothing while the settings page scoped to that wiki
      // believed it had.
      if (refuseStoppedTarget(req, res)) return
      // v0.30.12: take the SHARED mutation lock. Before this, the settings page
      // could press 「重启」 while a `/sync` was draining the same queue (or while
      // another restart was in flight) — the two operations both stop the TW child.
      const lock = deps.mutationLock
      if (lock !== undefined && !lock.begin('admin-restart')) {
        json(res, { ok: false, error: `另一个重启/同步正在进行中（${lock.current() ?? '?'}），请稍候` }, 429)
        return
      }
      try {
      // v0.24.1: drain the syncer queue first (ironclad rule #1) — this route
      // used to kill the child with writes still queued, losing them silently.
      const drained = await drainThenStop({
        client: deps.getClient(req),
        tiddlersDir: join(deps.getWikiPath(req), 'tiddlers'),
        stop: async () => { await deps.server(req)?.restart() },
        log: (message) => console.warn('[dsh-tiddlywiki]', message),
      })
      json(res, { ok: true, status: deps.server(req)?.status().status, drained })
      } finally {
        lock?.end()
      }
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }

  // v0.30.20：一次性预置那三条路由搬进 `admin-routes-seeds.ts`（纯搬迁 + 工厂化）。
  // 这一组牵着「排干后重启」与共享变更锁两条铁律，单独成文件便于审读。
  const { handleSeeds, handleSeedsRun, handleSeedsRemove } = createAdminSeedRoutes({
    getClient: deps.getClient,
    getWikiPath: deps.getWikiPath,
    mutationLock: deps.mutationLock,
    seeds: deps.seeds,
    server: deps.server,
  }, { notRunning })


  // v0.30.19：知识库列表 / 位置那四条路由搬进 `admin-routes-wikis.ts`（纯搬迁 + 工厂化）。
  // 只把这组真正用到的 deps 成员传进去 —— 依赖面写在那份文件里，改动可审。
  const { handleWikiLocation, handleWikiSwitch, handleWikiReset, handleWikisRoute } = createAdminWikiRoutes({
    server: deps.server,
    wiki: deps.wiki,
    wikis: deps.wikis,
  })


  // Same rejection safety net as routes.ts (v0.19.3).
  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/admin/state`, handler: guardHandler(handleState) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/admin/prompt`, handler: guardHandler(handlePrompt) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/admin/wikis`, handler: guardHandler(handleWikisRoute) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/admin/wiki/location`, handler: guardHandler(handleWikiLocation) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/admin/wiki/switch`, handler: guardHandler(handleWikiSwitch) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/admin/wiki/reset`, handler: guardHandler(handleWikiReset) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/admin/info`, handler: guardHandler(handleInfo) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/admin/config`, handler: guardHandler(handleConfig) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/admin/restart`, handler: guardHandler(handleRestart) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/admin/seeds`, handler: guardHandler(handleSeeds) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/admin/seeds/run`, handler: guardHandler(handleSeedsRun) }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/admin/seeds/remove`, handler: guardHandler(handleSeedsRemove) }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

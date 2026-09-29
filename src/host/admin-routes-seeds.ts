/**
 * 一次性预置（seed）那三条 admin 路由（v0.30.20 从 `admin-routes.ts` 拆出，**纯搬迁** + 工厂化）。
 *
 * GET  /admin/seeds        —— 每个 seed 的现状（设置页「初始化」小节）
 * POST /admin/seeds/run    —— 跑一个 / 全部；force = 手动「重新初始化」
 * POST /admin/seeds/remove —— 反初始化（删掉它写过的 tiddler + marker）
 *
 * 单独成文件的原因：`/seeds/run` 是全仓库**唯一**会「写完就 drain + 重启 TW」的 admin 路由
 * （seed 里的 server-route 插件只在 TW 启动时加载），因此它同时牵着两条铁律 ——
 * 排干必须走 `drainThenStop`（铁律 #1）、这一段必须持有共享变更锁（v0.30.12）。
 * 把这一组放在一起，是为了让「谁可以停子进程」这件事在 admin 侧也只有一处可读。
 *
 * 依赖面（量过）：`deps` 的 `getClient`·`getWikiPath`·`mutationLock`·`seeds`·`server`，
 * 加上 base 的闭包 helper `notRunning`（与 `createNoteRoutes(deps, helpers)` 同一形状）。
 *
 * @module dsh-tiddlywiki/host/admin-routes-seeds
 */
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readBody, rejectCrossSiteWrite, rejectNonRead } from './http.ts'
import { drainThenStop, needsRestartAfterSeeds, waitForFileWrite } from './seeds.ts'
import { RENDER_PLUGIN_FILE } from './seed-render.ts'
import type { AdminDeps } from './admin-routes.ts'

/** 这一组真正用到的 deps 成员（不是整个 AdminDeps）。 */
export type AdminSeedRouteDeps = Pick<AdminDeps, 'getClient' | 'getWikiPath' | 'mutationLock' | 'seeds' | 'server'>

export function createAdminSeedRoutes(
  deps: AdminSeedRouteDeps,
  /** base 的闭包 helper：目标库没在跑时的 503 文案（与其它 admin 路由同一份实现）。 */
  helpers: { notRunning: (req: IncomingMessage) => string },
) {
  const { notRunning } = helpers
  /**
   * GET /dsh-tiddlywiki/admin/seeds — status of every one-time seed
   * (doc-note / send-to-agent / home-index / tw-web-host) for the settings
   * page's 初始化 section.
   */
  const handleSeeds = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectNonRead(req, res)) return
      const client = deps.getClient(req)
      if (client === undefined) {
        json(res, { ok: false, error: notRunning(req) }, 503)
        return
      }
      const items = await deps.seeds.checkAll(client)
      json(res, { ok: true, items })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }

  /**
   * POST /dsh-tiddlywiki/admin/seeds/run — run one seed (or all when `id` is
   * absent); `force: true` is the manual "重新初始化" (overwrite + re-marker),
   * `force: false` keeps the one-shot write-if-missing semantics.
   */
  const handleSeedsRun = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      const body = JSON.parse(await readBody(req)) as { id?: unknown; force?: unknown }
      const id = typeof body.id === 'string' && body.id.trim().length > 0 ? body.id.trim() : undefined
      const force = body.force === true
      const client = deps.getClient(req)
      if (client === undefined) {
        json(res, { ok: false, error: notRunning(req) }, 503)
        return
      }
      const seedStartedAt = Date.now()
      const results = await deps.seeds.run(client, id, force)
      // A seeded SERVER-route plugin (render) only loads at TW BOOT, and TW's
      // syncer flushes REST writes on a ~250ms timer. Without the flush-wait +
      // restart the settings page reported「已重新初始化」while /render kept
      // 404ing (tool cards and wiki-link rendering stayed degraded). Mirrors the
      // startup path in src/index.ts — and, like there, the restart fires ONLY
      // for a seed that really rewrote the route (restarting over unflushed
      // content writes would lose them).
      let restarted = false
      let restartError: string | undefined
      // v0.30.12：这一段会 drain + 重启 TW 子进程，所以必须拿**共享**的变更锁
      // （否则设置页「初始化」与 `/sync`、`/admin/restart` 会同时停子进程）。
      // 拿不到就如实报冲突，而不是排队硬上。
      const seedLock = deps.mutationLock
      if (needsRestartAfterSeeds(results) && seedLock !== undefined && !seedLock.begin('admin-seeds')) {
        json(res, { ok: false, error: `另一个重启/同步正在进行中（${seedLock.current() ?? '?'}），请稍候` }, 429)
        return
      }
      if (needsRestartAfterSeeds(results)) {
        try {
          const flushed = await waitForFileWrite(join(deps.getWikiPath(req), 'tiddlers', RENDER_PLUGIN_FILE), 8_000, 150, seedStartedAt)
          if (!flushed) console.warn('[dsh-tiddlywiki] seeded render plugin file not seen on disk before restart')
          // Drain the rest of the syncer queue too: force-all writes every seed,
          // and a restart that boots from a stale snapshot silently loses the
          // ones still queued (v0.19.0 — repeatedly lost tw-web-host here).
          // v0.24.1: the drain+restart pair is now the shared primitive.
          const drained = await drainThenStop({
            client,
            tiddlersDir: join(deps.getWikiPath(req), 'tiddlers'),
            stop: async () => { await deps.server(req)?.restart() },
            log: (message) => console.warn('[dsh-tiddlywiki]', message),
          })
          if (!drained) console.warn('[dsh-tiddlywiki] seed writes may not have been flushed before restart')
          restarted = true
        } catch (err) {
          restartError = err instanceof Error ? err.message : String(err)
          console.warn('[dsh-tiddlywiki] restart after seeding failed:', restartError)
        }
      }
      const ok = results.every((r) => r.ok)
      seedLock?.end()
      json(res, { ok, results, restarted, ...(restartError !== undefined ? { restartError } : {}) }, ok ? 200 : 400)
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }

  /**
   * POST /dsh-tiddlywiki/admin/seeds/remove — 反初始化: remove one optional
   * seed (or all optional seeds when `id` is absent) — delete the seeded
   * tiddlers + markers so the wiki returns to the "never seeded" state.
   * Core seeds (功能必需) cannot be removed.
   */
  const handleSeedsRemove = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      const body = JSON.parse(await readBody(req)) as { id?: unknown }
      const id = typeof body.id === 'string' && body.id.trim().length > 0 ? body.id.trim() : undefined
      const client = deps.getClient(req)
      if (client === undefined) {
        json(res, { ok: false, error: notRunning(req) }, 503)
        return
      }
      const results = await deps.seeds.remove(client, id)
      const ok = results.every((r) => r.ok)
      json(res, { ok, results }, ok ? 200 : 400)
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }
  return { handleSeeds, handleSeedsRun, handleSeedsRemove }
}

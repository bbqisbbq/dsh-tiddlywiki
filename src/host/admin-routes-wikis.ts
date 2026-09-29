/**
 * 知识库列表 / 位置那四条 admin 路由（v0.30.19 从 `admin-routes.ts` 拆出，**纯搬迁** + 工厂化）。
 *
 * 这一组回答的是「插件现在服务哪个目录」以及「清单（wikis.json 的控制文件）里有什么」——
 * 与 `/admin/{state,info,config,seeds}` 那组（改**当前库**的配置）是两件事，所以单独成文件。
 * 它们**不**吃 `?wiki=`：请求问的就是「哪个库」本身。
 *
 * 依赖面（量过）：`wiki` · `wikis` · `server`；闭包 helper 一个都不需要。
 * `AdminDeps` 用 `import type` 从 base 拿（类型期闭环、运行期无环，本仓库既有约定）。
 *
 * @module dsh-tiddlywiki/host/admin-routes-wikis
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { errorStatus, json, readBody, rejectCrossSiteWrite, rejectNonRead } from './http.ts'
import type { AdminDeps } from './admin-routes.ts'

/** 这一组真正用到的 deps 成员（不是整个 AdminDeps）。 */
export type AdminWikiRouteDeps = Pick<AdminDeps, 'server' | 'wiki' | 'wikis'>

export function createAdminWikiRoutes(deps: AdminWikiRouteDeps) {
  /**
   * GET /dsh-tiddlywiki/admin/wiki/location — the folder the plugin currently
   * serves, how that was decided (pointer file / cordis config / default), the
   * config default to fall back to, and the wiki-looking folders next to it
   * (settings-page「知识库位置」, v0.22.0). Read-only + CSRF-hardened.
   */
  const handleWikiLocation = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectNonRead(req, res)) return
      if (deps.wiki === undefined) {
        json(res, { ok: false, error: 'wiki location is not available' }, 503)
        return
      }
      json(res, { ok: true, ...(await deps.wiki.info()) })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }

  /**
   * POST /dsh-tiddlywiki/admin/wiki/switch { root, name } — repoint the running
   * plugin at another wiki folder (v0.22.0). Serialized against itself by the
   * host; a failure is reported with `rolledBack` so the page can say whether
   * the old wiki is still serving.
   */
  const handleWikiSwitch = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      if (deps.wiki === undefined) {
        json(res, { ok: false, error: 'wiki location is not available' }, 503)
        return
      }
      const body = JSON.parse(await readBody(req)) as { root?: unknown; name?: unknown }
      const result = await deps.wiki.switch({ root: body.root, name: body.name })
      json(res, result.ok ? { ...result, status: deps.server(req)?.status().status } : result, result.ok ? 200 : 400)
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  /**
   * POST /dsh-tiddlywiki/admin/wiki/reset — 「恢复为配置默认」: delete the pointer
   * file and (when needed) switch back to the cordis default folder (v0.22.0).
   */
  const handleWikiReset = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      if (deps.wiki === undefined) {
        json(res, { ok: false, error: 'wiki location is not available' }, 503)
        return
      }
      const result = await deps.wiki.reset()
      json(res, result.ok ? { ...result, status: deps.server(req)?.status().status } : result, result.ok ? 200 : 400)
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  /**
   * GET /dsh-tiddlywiki/admin/wikis — the knowledge-base LIST as the settings
   * page edits it: the CONTROL FILE's contents (mode / list / default), which is
   * NOT the same as what is running. Read-only + CSRF-hardened.
   */
  const handleWikis = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectNonRead(req, res)) return
      if (deps.wikis === undefined) {
        json(res, { ok: false, error: '知识库列表不可用' }, 503)
        return
      }
      json(res, { ok: true, ...(await deps.wikis.info()) })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }

  /**
   * POST /dsh-tiddlywiki/admin/wikis { action, … } — add / update / remove /
   * set-default / set-mode. ONE action per request (see `applyWikiAction`): the
   * page then cannot post an inconsistent list, and every mutation goes through
   * the same validation the boot path uses.
   *
   * A REFUSED action is a 400 with the reason. A change whose new wiki fails to
   * START is still 200: the list is saved and the failure is reported in
   * `change.errors` — refusing the save would silently discard the user's edit
   * for a problem they can fix by restarting the wiki.
   */
  const handleWikisApply = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (deps.wikis === undefined) {
        json(res, { ok: false, error: '知识库列表不可用' }, 503)
        return
      }
      let body: unknown
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        json(res, { ok: false, error: '请求体必须是 JSON' }, 400)
        return
      }
      const result = await deps.wikis.apply(body)
      if (!result.ok) {
        json(res, { ok: false, error: result.error }, 400)
        return
      }
      json(res, { ok: true, ...result.info, change: result.change })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  /**
   * `/admin/wikis` takes BOTH methods on ONE registration: the host webserver
   * dispatches by pathname only, and registering the same exact path twice would
   * throw `duplicate exact route`.
   */
  const handleWikisRoute = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if ((req.method ?? 'GET').toUpperCase() === 'POST') {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      return handleWikisApply(req, res)
    }
    return handleWikis(req, res)
  }
  return { handleWikiLocation, handleWikiSwitch, handleWikiReset, handleWikisRoute }
}

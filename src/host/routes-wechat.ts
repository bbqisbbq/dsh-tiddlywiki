/**
 * 公众号发布 routes (v0.30.9): `guardWechat` + `/wechat/{ready,publish,publish/status}`.
 *
 * **纯搬迁**（函数体一字未改），只在最外层包了一层工厂：这三个 handler 原来直接住在
 * `registerRoutes()` 的闭包里，抽出来时把**它真正用到的那几个 deps 成员**用
 * `Pick<RouteDeps, …>` 写清楚（`import type` 只在类型期存在，运行时没有环）。
 *
 * 依赖面（量过，就这五个）：`getClient` · `wechatConfig` · `wechatReady` ·
 * `wechatRunner` · `wikiSummaries`（最后一个用于「多库模式下拒绝公众号发布」——
 * 它写的是 TW 侧那一个库，多库下会静默投错库）。
 *
 * @module dsh-tiddlywiki/host/routes-wechat
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { errorStatus, json, readBody, rejectCrossSiteWrite, rejectNonRead, safeTokenEqual } from './http.ts'
import { PATH_PREFIX as ROUTE_PREFIX } from './wiki.ts'
// ROUTE_PREFIX 就是 PATH_PREFIX（routes.ts 里那一行只是别名）。这里直接从源头导入，
// 并用 as 起同名别名：搬过来的函数体一字不用改，也避免 routes.ts 与本文件在**运行时**成环。
import { isBlockedProxyTitle } from './routes-tw-proxy.ts'
import { WECHAT_ADAPTERS, type WechatAdapter } from './wechat-publish.ts'
import type { RouteDeps } from './routes.ts'

/** 这三个 handler 真正用到的 deps 成员（不是整个 RouteDeps）。 */
export type WechatRouteDeps = Pick<RouteDeps, 'getClient' | 'wechatConfig' | 'wechatReady' | 'wechatRunner' | 'wikiSummaries'>
export function createWechatRoutes(deps: WechatRouteDeps) {
  const guardWechat = (req: IncomingMessage, res: ServerResponse): boolean => {
    const config = deps.wechatConfig(req)
    if (!config.enabled) {
      json(res, { ok: false, error: 'wechat publishing is disabled' }, 403)
      return false
    }
    const token = config.token.trim()
    if (token.length === 0) return true
    const got = req.headers['x-wechat-publish-token']
    const value = typeof got === 'string' ? got : Array.isArray(got) ? got[0] ?? '' : ''
    if (safeTokenEqual(value, token)) return true
    json(res, { ok: false, error: 'unauthorized' }, 401)
    return false
  }

  /**
   * GET /dsh-tiddlywiki/wechat/ready — precheck for the TW toolbar button:
   * is opencli on PATH and are the adapter files installed? 200 whenever the
   * feature is on; the caller reads `opencli.ok` / `adapters.*` (an installation
   * problem is NOT an HTTP error — the button shows it as an actionable notice).
   */
  const handleWechatReady = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectNonRead(req, res)) return
      if (!guardWechat(req, res)) return
      const ready = await deps.wechatReady(req)
      json(res, {
        ok: true,
        enabled: ready.enabled,
        command: ready.command,
        opencli: ready.opencli,
        adapters: ready.adapters,
      })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  /**
   * The loopback DSN the adapter calls back into (`fetch /render`): the DSH web
   * port this very request arrived on, so opencli (a local process) reaches the
   * same server regardless of which hostname the browser used. `wechat.dsn`
   * overrides it for exotic setups.
   */
  const wechatDsn = (req: IncomingMessage): string => {
    const configured = deps.wechatConfig(req).dsn
    if (configured.length > 0) return configured
    const port = req.socket.localPort
    return port === undefined ? '' : `http://127.0.0.1:${port}${ROUTE_PREFIX}`
  }

  /**
   * POST /dsh-tiddlywiki/wechat/publish — start ONE publish job.
   *
   * Body `{title, adapter?}`. The heavy work happens in the runner (spawned
   * opencli), so this returns a job id immediately; the TW overlay then polls
   * `/wechat/publish/status`. A second concurrent call gets 409: two opencli
   * runs would fight over the same browser tab.
   */
  const handleWechatPublish = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      if (!guardWechat(req, res)) return
      // v0.29.0: the publish chain cannot express WHICH knowledge base it means.
      //
      // The adapter is a separate local process handed ONE base URL (`--dsn`)
      // and it appends `/render` and `/get?title=…` to it — so a wiki id can
      // only travel in that PATH, never as `?wiki=`. In a multi-wiki install the
      // job would pass its own existence check against wiki B and then
      // render/publish the DEFAULT wiki's same-titled note: wrong content, on a
      // public platform, with nothing in the receipt saying so. Refuse loudly
      // instead. (Single-wiki installs — the overwhelming majority, and the
      // only configuration this feature was verified in — behave identically to
      // before.) The proper fix is a wiki-scoped alias prefix (`/w/<id>/render`)
      // that the DSN can point at; tracked as a follow-up, not done here.
      if (deps.wikiSummaries(req).mode !== 'single') {
        json(res, {
          ok: false,
          error: '多知识库模式下暂不支持从 TW 面板发布到公众号：发布链路回连宿主的地址无法指定库，会读到默认库的同名笔记。请在「设置 → 知识库 → 运行模式」切为单库后发布，或改用命令行 opencli 并显式传 --dsn。',
        }, 400)
        return
      }
      let body: { title?: unknown; adapter?: unknown } = {}
      try {
        body = JSON.parse(await readBody(req)) as { title?: unknown; adapter?: unknown }
      } catch {
        /* malformed body → the title check below answers */
      }
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      if (title.length === 0) {
        json(res, { ok: false, error: 'title is required' }, 400)
        return
      }
      if (title.length > 300) {
        json(res, { ok: false, error: 'title is too long' }, 400)
        return
      }
      // The title becomes a TW `/render` lookup and a text file name we generate;
      // the secret namespace must never be publishable (same predicate as /render).
      if (isBlockedProxyTitle(title)) {
        json(res, { ok: false, error: 'unsupported title' }, 400)
        return
      }
      const requested = body.adapter === undefined ? undefined : String(body.adapter)
      if (requested !== undefined && !(WECHAT_ADAPTERS as readonly string[]).includes(requested)) {
        json(res, { ok: false, error: `unsupported adapter: ${requested}` }, 400)
        return
      }
      const runner = deps.wechatRunner()
      if (runner === undefined) {
        json(res, { ok: false, error: 'publish runner unavailable' }, 503)
        return
      }
      // Fail fast on a title that does not exist: the adapter would otherwise
      // spend ~10s booting the browser only to 404 in /render.
      const client = deps.getClient(req)
      if (client !== undefined) {
        const tiddler = await client.get(title)
        if (tiddler === undefined) {
          json(res, { ok: false, error: `wiki 里找不到笔记「${title}」` }, 400)
          return
        }
      }
      const adapter = (requested ?? deps.wechatConfig(req).adapter) as WechatAdapter
      const ready = await deps.wechatReady(req)
      const adapterReady = adapter === 'publish-note-imgs' ? ready.adapters.publishNoteImgs : ready.adapters.publishNote
      if (!ready.opencli.ok || !adapterReady) {
        // `stale` (v0.23.4) = installed but outdated adapter files: the common
        // case is an old copy without `--title-file`, which would otherwise fail
        // deep inside opencli with a confusing "required argument missing".
        const stale = ready.adapters.stale ?? []
        const staleNote = stale.length > 0
          ? `adapter 版本过旧（缺 --title-file）：${stale.join('、')}`
          : null
        json(res, {
          ok: false,
          error: !ready.opencli.ok
            ? `找不到 opencli（wechat.command=${ready.command}）：请先 npm install -g @jackwener/opencli`
            : (staleNote ?? `opencli 里还没有 weixin adapter（缺 ${ready.adapters.missing.join('、') || adapter}）`)
              + '：请运行 node tools/wechat/install-wechat-adapters.mjs',
          ready,
        }, 503)
        return
      }
      const result = runner.start({ title, adapter, dsn: wechatDsn(req) })
      if (!result.ok) {
        if (result.busy) {
          json(res, { ok: false, error: 'a publish job is already running', jobId: result.job.id }, 409)
          return
        }
        json(res, { ok: false, error: result.error }, 400)
        return
      }
      json(res, { ok: true, jobId: result.job.id, title: result.job.title, adapter: result.job.adapter })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  /**
   * GET /dsh-tiddlywiki/wechat/publish/status — poll one job (`?id=`), or the
   * current/newest one when the id is omitted (the overlay loses its id when the
   * page reloads mid-publish). `job: null` = nothing has run yet.
   */
  const handleWechatPublishStatus = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectNonRead(req, res)) return
      if (!guardWechat(req, res)) return
      const runner = deps.wechatRunner()
      if (runner === undefined) {
        json(res, { ok: false, error: 'publish runner unavailable' }, 503)
        return
      }
      const id = (new URL(req.url ?? '/', 'http://x').searchParams.get('id') ?? '').trim()
      const job = runner.status(id.length > 0 ? id : undefined)
      if (job === undefined) {
        if (id.length > 0) {
          json(res, { ok: false, error: 'unknown job' }, 404)
          return
        }
        json(res, { ok: true, job: null })
        return
      }
      json(res, { ok: true, job })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }
  return { handleWechatReady, handleWechatPublish, handleWechatPublishStatus }
}


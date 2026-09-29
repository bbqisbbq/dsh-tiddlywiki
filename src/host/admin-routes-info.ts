/**
 * 状态 / 插件·主题·语言 两条 admin 路由（v0.30.24 从 `admin-routes.ts` 拆出，**纯搬迁** + 工厂化）。
 *
 * GET  /admin/state — 设置页总览（TW 运行态 + git 概览 + 目录 + 名册）
 * POST /admin/info  — 改 `tiddlywiki.info`（插件 / 主题 / 语言），必要时重启 TW
 *
 * 单独成文件的原因：这一组是设置页**唯一**会写 `tiddlywiki.info`（并因此重启 TW）的地方，
 * 同时它必须把「正在配置的是哪个库」算对（`deps.config(req)` 的回落会安静地指向默认库）。
 * 两件事都容易错、都值得单独审读，所以放在一起。
 *
 * 依赖面（量过）：deps 的 `config`·`getClient`·`getWikiPath`·`server`·`targetProblem`·`twRoot`，
 * 加上 base 的两个闭包 helper（`refuseStoppedTarget` / `notRunning`，与 `createAdminSeedRoutes` 同形状）。
 * `AdminDeps` 用 `import type` 从 base 拿（类型期闭环、运行期无环，本仓库既有约定）。
 *
 * @module dsh-tiddlywiki/host/admin-routes-info
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readBody, rejectCrossSiteWrite, rejectNonRead } from './http.ts'
import { redactLogLines, redactRemoteUrl } from './routes.ts'
import { join } from 'node:path'
import { drainThenStop } from './seeds.ts'
import { GitFace } from './git.ts'
import { maskConfigSecrets } from './admin-secrets.ts'
import { bundledCatalog, normalizeThemes, pinLanguageTiddler, readActiveThemeName, readWikiInfo, scanWikiRuntimePlugins, writeWikiInfo, type WikiInfo } from './admin-catalog.ts'
import type { AdminDeps } from './admin-routes.ts'

/** 这一组真正用到的 deps 成员（不是整个 AdminDeps）。 */
export type AdminInfoRouteDeps = Pick<AdminDeps, 'config' | 'getClient' | 'getWikiPath' | 'server' | 'targetProblem' | 'twRoot'>

export function createAdminInfoRoutes(
  deps: AdminInfoRouteDeps,
  /** base 的两个闭包 helper：目标库没在跑时拒掉 / 取它的 503 文案。 */
  /** base 的闭包 helper：目标库没在跑时拒掉这次请求。 */
  helpers: { refuseStoppedTarget: (req: IncomingMessage, res: ServerResponse) => boolean },
) {
  const { refuseStoppedTarget } = helpers
  const handleState = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectNonRead(req, res)) return
      // `/admin/state` is the settings page's whole view of "the wiki I am
      // configuring": answering with the default wiki's path/git/config while the
      // scope bar names another one is the silent-wrong-wiki bug (v0.29.0).
      if (refuseStoppedTarget(req, res)) return
      const wikiPath = deps.getWikiPath(req)
      const [info, catalog] = await Promise.all([readWikiInfo(wikiPath), bundledCatalog(deps.twRoot())])
      let git: unknown = null
      try {
        const status = await new GitFace().status(wikiPath)
        git = { ...status, remote: redactRemoteUrl(status.remote ?? '') }
      } catch {
        git = null
      }
      const view = deps.server(req)?.status() ?? { status: 'stopped' as const, wikiPath, logs: [] }
      // Which theme the runtime actually shows (v0.22.3): the settings page used
      // to derive it from the LAST entry of info.themes, so a non-last active
      // theme displayed the wrong radio — and re-applying it (even without
      // touching the radios) rewrote `$:/theme` to that wrong pick.
      const themeActive = await readActiveThemeName(deps.getClient(req))
      // Runtime plugin truth (v0.26.0): wiki-installed plugin tiddlers + the
      // disabled markers, so 插件管理 rows can be labelled honestly. `null`
      // (scan failed) is passed through — the client hides the section rather
      // than showing an empty lie (§3: read failure ≠ absence).
      const runtimePlugins = await scanWikiRuntimePlugins(wikiPath)
      json(res, {
        ok: true,
        // Same redaction as GET /status: this route is unauthenticated too.
        server: { ...view, logs: redactLogLines(view.logs) },
        info: { plugins: info.plugins, themes: info.themes, languages: info.languages ?? [], themeActive },
        catalog,
        runtimePlugins,
        config: maskConfigSecrets(deps.config(req).get()),
        // Why the overrides above are NOT in effect (v0.23.4): a stored config
        // that does not parse keeps being ignored silently otherwise, and the
        // page would show the (masked) defaults as if the user had chosen them.
        configError: deps.config(req).parseError() ?? null,
        git,
      })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }

  const handleInfo = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      // 插件/主题/语言写的是该库的 tiddlywiki.info：目标库没在跑就必须拒绝，
      // 否则会把 A 库的清单写进**默认库**的文件（v0.29.0）。
      if (refuseStoppedTarget(req, res)) return
      const body = JSON.parse(await readBody(req)) as { plugins?: unknown; themes?: unknown; themeActive?: unknown; languages?: unknown }
      const wikiPath = deps.getWikiPath(req)
      // A read failure must NEVER be turned into "the wiki has no plugins":
      // saving would then rewrite the file without them. Fail with 500 and
      // leave the file untouched.
      let info: WikiInfo
      try {
        info = await readWikiInfo(wikiPath)
      } catch (err) {
        json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
        return
      }
      const catalog = await bundledCatalog(deps.twRoot())
      const known = new Set([...catalog.plugins, ...catalog.themes].map((c) => c.name))
      const knownLangs = new Set(catalog.languages.map((c) => c.name))
      /** Snapshot for the no-op guard below (JSON compare is enough here). */
      const beforeInfo = JSON.stringify(info)
      /** Set only when the request carried a themes array with a resolvable active pick. */
      let activatedTheme: string | undefined
      const applyList = (field: 'plugins' | 'themes', raw: unknown): string[] => {
        if (!Array.isArray(raw)) return info[field]
        const next: string[] = []
        for (const name of raw) {
          if (typeof name !== 'string') continue
          if (!known.has(name) && !info[field].includes(name)) {
            throw new Error(`unknown plugin/theme: ${name}`)
          }
          if (!next.includes(name)) next.push(name)
        }
        return next
      }
      const applyLanguages = (raw: unknown): string[] => {
        if (!Array.isArray(raw)) return info.languages ?? []
        const next: string[] = []
        for (const code of raw) {
          if (typeof code !== 'string') continue
          if (!knownLangs.has(code) && !(info.languages ?? []).includes(code)) {
            throw new Error(`unknown language plugin: ${code}`)
          }
          if (!next.includes(code)) next.push(code)
        }
        return next
      }
      // Validation + in-memory mutation only: a rejected name must NOT touch
      // tiddlywiki.info (400 straight out), while a failure of the write/restart
      // below is an internal error (500) — the old code reported both as 400.
      try {
        info.plugins = applyList('plugins', body.plugins)
        // Activate the chosen theme: load its full dependency chain AND set
        // `$:/theme` so the browser's themeManager actually applies it (the
        // `themes` array alone only makes the plugin available).
        if (Array.isArray(body.themes)) {
          const themeDeps: Record<string, string[]> = {}
          for (const theme of catalog.themes) {
            if (theme.dependents && theme.dependents.length > 0) themeDeps[theme.name] = theme.dependents
          }
          const selected = applyList('themes', body.themes)
          // Explicit active-theme pick (new two-layer UI): validate and auto-add
          // it to the loaded set so its dependency closure is loaded. Without an
          // explicit pick, activate the deepest loaded overlay (old single-radio).
          const explicitActive = typeof body.themeActive === 'string' && body.themeActive.length > 0
          if (explicitActive) {
            const activeName = body.themeActive as string
            if (known.has(activeName) || info.themes.includes(activeName)) {
              if (!selected.includes(activeName)) selected.push(activeName)
              activatedTheme = activeName
            }
          }
          info.themes = normalizeThemes(selected, themeDeps)
          if (activatedTheme === undefined && info.themes.length > 0) {
            activatedTheme = info.themes[info.themes.length - 1]
          }
        } else {
          info.themes = applyList('themes', body.themes)
        }
        if (Array.isArray(body.languages)) info.languages = applyLanguages(body.languages)
      } catch (err) {
        json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 400)
        return
      }
      // NO-OP GUARD (v0.19.3): a body that changes nothing (e.g. `{}`, or the
      // same lists re-sent) used to rewrite tiddlywiki.info + restart TW — a
      // visible TW interruption for a request that asked for nothing.
      const changed = JSON.stringify(info) !== beforeInfo
      if (changed) {
        await writeWikiInfo(wikiPath, info)
        // v0.24.1: plugins/themes/languages change → restart, but drain first.
        // This path predates the "restarting over unflushed writes loses them"
        // insight that the seed path below already documents (rule #1).
        await drainThenStop({
          client: deps.getClient(req),
          tiddlersDir: join(deps.getWikiPath(req), 'tiddlers'),
          stop: async () => { await deps.server(req)?.restart() },
          log: (message) => console.warn('[dsh-tiddlywiki]', message),
        })
      }
      // Activate the chosen theme tiddler (mirrors TW's own Control Panel).
      if (Array.isArray(body.themes) && activatedTheme !== undefined) {
        const client = deps.getClient(req)
        if (client !== undefined) {
          await client
            .put({ title: '$:/theme', text: `$:/themes/${activatedTheme}`, type: 'text/vnd.tiddlywiki', tags: [] })
            .catch((err) => { console.warn('[dsh-tiddlywiki] activating theme failed:', err) })
        }
      }
      // After a languages change, pin the active language tiddler: first
      // enabled language, or en-GB when none is enabled. Only when the request
      // actually carried a languages array (plugins/themes restarts skip this).
      if (Array.isArray(body.languages)) {
        const client = deps.getClient(req)
        if (client !== undefined) {
          const langs = info.languages ?? []
          const active = langs.length > 0 ? `$:/languages/${langs[0]}` : '$:/languages/en-GB'
          // v0.24.2: conditional write — an identical body still churns the
          // `created`/`modified` in `$__language.txt.meta` and conflicts on every
          // pull across two machines.
          await pinLanguageTiddler(client, active, (message, err) => {
            if (err === undefined) console.warn('[dsh-tiddlywiki]', message)
            else console.warn('[dsh-tiddlywiki] pinning $:/language failed:', err)
          })
          // Keep the startup auto-apply hint (config uiLanguage) consistent with
          // the active language, so a later dsh-web restart doesn't re-enable
          // a language the user just disabled here.
          const hint = langs.length > 0 ? langs[0] : ''
          if ((deps.config(req).get().uiLanguage ?? '') !== hint) {
            await deps.config(req).set(client, { uiLanguage: hint }).catch(() => undefined)
          }
        }
      }
      json(res, { ok: true, changed, info: { plugins: info.plugins, themes: info.themes, languages: info.languages ?? [] } })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }
  return { handleState, handleInfo }
}

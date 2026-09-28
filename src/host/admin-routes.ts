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
import { ROUTE_PREFIX, redactLogLines, redactRemoteUrl, type WebServerFace } from './routes.ts'
import { ConfigPatchError, ConfigUnreadableError, normalizeConfigPatch, type ConfigStore, type PluginConfigShape } from './config.ts'
import { readBody, json, guardHandler, errorStatus, rejectCrossSiteWrite, rejectNonRead } from './http.ts'
import { waitForFileWrite, needsRestartAfterSeeds, drainThenStop } from './seeds.ts'
import { RENDER_PLUGIN_FILE } from './seed-render.ts'
import { normalizePromptPreview, type PromptPreviewConfig } from './prompt.ts'
import type { WikiLocationInfo } from './wiki-location.ts'
import type { WikiSwitchResult } from './wiki-switch.ts'
import { GitFace } from './git.ts'
import { readWikiInfo, writeWikiInfo, bundledCatalog, readActiveThemeName, scanWikiRuntimePlugins, normalizeThemes, pinLanguageTiddler, type WikiInfo } from './admin-catalog.ts'
import { maskConfigSecrets, stripMaskedSecrets } from './admin-secrets.ts'

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
  const handleState = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectNonRead(req, res)) return
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

  const handleConfig = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      const body = JSON.parse(await readBody(req)) as unknown
      const client = deps.getClient(req)
      if (client === undefined) {
        json(res, { ok: false, error: 'wiki service is not running' }, 503)
        return
      }
      // Validate/normalise BEFORE merging (v0.25.0): the raw body used to be
      // merged verbatim, so any JSON at all (an array → `{"0":1}` keys) became
      // permanent config, and a wrong TYPE (git.debounceMs: "abc") reached the
      // consumer and changed behaviour silently. See normalizeConfigPatch.
      const patch = normalizeConfigPatch(body)
      // Never persist the masked placeholders the page read back from /state
      // (v0.19.3): saving an untouched form must not clobber a real token.
      await deps.config(req).set(client, stripMaskedSecrets(patch as Record<string, unknown>, deps.config(req).get()) as PluginConfigShape)
      // prompt.* may have changed: let the plugin re-register its prompt
      // section now (a no-op when the built text is unchanged).
      deps.onConfigChanged?.()
      json(res, { ok: true, config: maskConfigSecrets(deps.config(req).get()) })
    } catch (err) {
      // A malformed patch is the caller's problem (400): the page can then show
      // exactly which field was wrong instead of a generic 500.
      if (err instanceof ConfigPatchError) {
        json(res, { ok: false, error: err.message }, 400)
        return
      }
      // A config tiddler that EXISTS but cannot be parsed is a user-fixable data
      // problem, not a server fault (v0.23.4): 409 + the actionable text, so the
      // settings page can tell the user what to fix instead of showing「保存失败」.
      if (err instanceof ConfigUnreadableError) {
        json(res, { ok: false, error: err.message }, 409)
        return
      }
      // Not a blanket 400 (v0.19.5): a refused/dead wiki client surfaces as a
      // 500/413 like everywhere else — reporting「参数错误」for a service failure
      // sent the settings page down the wrong recovery path.
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  const handleRestart = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      // v0.24.1: drain the syncer queue first (ironclad rule #1) — this route
      // used to kill the child with writes still queued, losing them silently.
      const drained = await drainThenStop({
        client: deps.getClient(req),
        tiddlersDir: join(deps.getWikiPath(req), 'tiddlers'),
        stop: async () => { await deps.server(req)?.restart() },
        log: (message) => console.warn('[dsh-tiddlywiki]', message),
      })
      json(res, { ok: true, status: deps.server(req)?.status().status, drained })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }

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
        json(res, { ok: false, error: 'wiki service is not running' }, 503)
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
        json(res, { ok: false, error: 'wiki service is not running' }, 503)
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
        json(res, { ok: false, error: 'wiki service is not running' }, 503)
        return
      }
      const results = await deps.seeds.remove(client, id)
      const ok = results.every((r) => r.ok)
      json(res, { ok, results }, ok ? 200 : 400)
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }

  /**
   * GET /dsh-tiddlywiki/admin/prompt — the system-prompt text that would be
   * injected right now, with the effective mode/enabled flag (v0.21.0). The
   * settings page renders it verbatim so a prompt edit is never a black box.
   * Read-only + CSRF-hardened like every other admin read.
   *
   * POST /dsh-tiddlywiki/admin/prompt — same answer for a DRAFT config sent in
   * the body (v0.22.7). The settings page previews what its form currently
   * holds, before 保存配置: the dropdown's value lived only in the browser DOM,
   * so switching 形态 and previewing used to show the still-SAVED text
   * (byte-identical) and read as "the two modes are the same". Nothing is
   * persisted here — `enabled/mode/extra/override` go through the same builder
   * `applyPrompt()` uses, so the draft cannot disagree with a later save.
   */
  const handlePrompt = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const draft = (req.method ?? 'GET').toUpperCase() === 'POST'
      if (draft) {
        if (rejectCrossSiteWrite(req, res, ['POST'])) return
        const raw = (await readBody(req)).trim()
        let body: unknown = {}
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw) as unknown
          } catch {
            json(res, { ok: false, error: 'invalid JSON body' }, 400)
            return
          }
        }
        const prompt = deps.getPrompt?.(normalizePromptPreview(body), req)
        if (prompt === undefined) {
          json(res, { ok: false, error: 'prompt preview is not available' }, 503)
          return
        }
        json(res, { ok: true, draft: true, enabled: prompt.enabled, mode: prompt.mode, length: prompt.text.length, text: prompt.text })
        return
      }
      if (rejectNonRead(req, res)) return
      const prompt = deps.getPrompt?.(undefined, req)
      if (prompt === undefined) {
        json(res, { ok: false, error: 'prompt preview is not available' }, 503)
        return
      }
      json(res, { ok: true, draft: false, enabled: prompt.enabled, mode: prompt.mode, length: prompt.text.length, text: prompt.text })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

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

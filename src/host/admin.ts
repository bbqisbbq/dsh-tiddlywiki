/**
 * Admin surface for the plugin settings page (design doc §13, config panel).
 *
 * - dynamic plugin/theme management: enumerate the bundled catalog from the
 *   installed tiddlywiki package, read/write the wiki's `tiddlywiki.info`
 *   plugins/themes arrays, then restart the TW child so the change applies;
 * - extensible config: the settings page reads/writes a config tiddler
 *   ($:/plugins/dsh-tiddlywiki/config, a JSON string) that overlays the
 *   cordis `config:` block — future config fields just extend the shape.
 *
 * Routes (all under ROUTE_PREFIX/admin, JSON):
 *   GET  /admin/state   current info + catalog + effective config + status
 *   POST /admin/info    { plugins?, themes? } → write info → restart TW
 *   POST /admin/config  { ...patch }          → write config tiddler
 *   POST /admin/restart restart the TW child
 *
 * @module dsh-tiddlywiki/host/admin
 */
import { createRequire } from 'node:module'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TiddlyWebClient } from './tw-api.ts'
import type { WikiServer } from './wiki.ts'
import { ROUTE_PREFIX, type WebServerFace } from './routes.ts'
import { CONFIG_TIDDLER, type ConfigStore, type PluginConfigShape } from './config.ts'

/** One bundled plugin/theme from the catalog. */
export interface CatalogEntry {
  /** Short name as used in tiddlywiki.info, e.g. "tiddlywiki/katex". */
  name: string
  /** Full tiddler title, e.g. "$:/plugins/tiddlywiki/katex". */
  title: string
  label: string
  description: string
  /** Dependent theme NAMES (converted from plugin.info `dependents`), e.g. heavier → ["tiddlywiki/snowwhite"]. */
  dependents?: string[]
}

export interface Catalog {
  plugins: CatalogEntry[]
  themes: CatalogEntry[]
  /** Bundled language plugins (tiddlywiki package `languages/` dir). */
  languages: CatalogEntry[]
}

/** Shape of tiddlywiki.info (plugins/themes/languages + build/description). */
export interface WikiInfo {
  description?: string
  plugins: string[]
  themes: string[]
  languages?: string[]
  build?: Record<string, unknown>
  [key: string]: unknown
}

/** Resolve the installed tiddlywiki package root (for the catalog). */
export function resolveTwRoot(): string {
  const require = createRequire(import.meta.url)
  return dirname(require.resolve('tiddlywiki/package.json'))
}

/** Read the wiki's tiddlywiki.info. */
export async function readWikiInfo(wikiPath: string): Promise<WikiInfo> {
  let raw: string
  try {
    raw = await readFile(join(wikiPath, 'tiddlywiki.info'), 'utf8')
  } catch {
    return { plugins: [], themes: [], languages: [] }
  }
  const parsed = JSON.parse(raw) as Partial<WikiInfo>
  return {
    description: parsed.description,
    plugins: parsed.plugins ?? [],
    themes: parsed.themes ?? [],
    languages: parsed.languages ?? [],
    ...parsed,
  }
}

/** Write the wiki's tiddlywiki.info (pretty-printed, ordering preserved). */
export async function writeWikiInfo(wikiPath: string, info: WikiInfo): Promise<void> {
  await writeFile(join(wikiPath, 'tiddlywiki.info'), `${JSON.stringify(info, null, 4)}\n`, 'utf8')
}

/** Enumerate bundled official plugins + themes + languages of tiddlywiki. */
export async function bundledCatalog(twRoot: string): Promise<Catalog> {
  // TW themes are SKINS layered on the vanilla base (which carries the full
  // 70KB base stylesheet). A theme whose stylesheet body is empty is a broken
  // stub (e.g. tight-heavier in some releases) — skip it so the settings list
  // never offers a no-op theme. vanilla itself is always kept.
  const themeHasCss = async (dir: string): Promise<boolean> => {
    for (const name of ['base.tid', 'styles.tid']) {
      try {
        const raw = await readFile(join(twRoot, 'themes', 'tiddlywiki', dir, name), 'utf8')
        const body = raw
          .replace(/^[\s\S]*?\r?\n\r?\n/, '')
          .split('\n')
          .filter((line) => !/^\\rules\b/.test(line.trim()))
          .join('\n')
          .trim()
        if (body.length > 0) return true
      } catch {
        /* file absent */
      }
    }
    return false
  }
  const scan = async (sub: 'plugins' | 'themes'): Promise<CatalogEntry[]> => {
    const root = join(twRoot, sub, 'tiddlywiki')
    let dirs: string[]
    try {
      dirs = await readdir(root)
    } catch {
      return []
    }
    const out: CatalogEntry[] = []
    for (const dir of dirs) {
      let info: { name?: string; description?: string; dependents?: string[] } = {}
      try {
        info = JSON.parse(await readFile(join(root, dir, 'plugin.info'), 'utf8')) as typeof info
      } catch {
        info = {}
      }
      if (sub === 'themes' && dir !== 'vanilla' && !(await themeHasCss(dir))) continue
      out.push({
        name: `tiddlywiki/${dir}`,
        title: sub === 'plugins' ? `$:/plugins/tiddlywiki/${dir}` : `$:/themes/tiddlywiki/${dir}`,
        label: info.name ?? dir,
        description: info.description ?? '',
        // plugin.info `dependents` are full plugin titles → convert to names.
        dependents: Array.isArray(info.dependents)
          ? info.dependents.map((dep) => dep.replace(/^\$:\/themes\/tiddlywiki\//, 'tiddlywiki/'))
          : undefined,
      })
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }
  // Language plugins live in the package ROOT `languages/` dir (not plugins/),
  // and are enabled via the tiddlywiki.info `languages` array (boot resolves
  // them through $tw.config.languagesPath). Fully offline — official builds.
  const scanLanguages = async (): Promise<CatalogEntry[]> => {
    const root = join(twRoot, 'languages')
    let dirs: string[]
    try {
      dirs = await readdir(root)
    } catch {
      return []
    }
    const out: CatalogEntry[] = []
    for (const dir of dirs) {
      let info: { name?: string; description?: string } = {}
      try {
        info = JSON.parse(await readFile(join(root, dir, 'plugin.info'), 'utf8')) as typeof info
      } catch {
        info = {}
      }
      out.push({
        name: dir,
        title: `$:/languages/${dir}`,
        label: info.name ?? dir,
        description: info.description ?? '',
      })
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }
  const [plugins, themes, languages] = await Promise.all([scan('plugins'), scan('themes'), scanLanguages()])
  return { plugins, themes, languages }
}

/**
 * Normalize a theme selection into the tiddlywiki.info `themes` array.
 *
 * TW themes are SKINS with a dependency chain (plugin.info `dependents`):
 *   vanilla ← snowwhite ← heavier / centralised / readonly / starlight
 *   vanilla ← tight / seamless
 * The ACTIVE theme is `$:/theme`, and switching to it registers the theme PLUS
 * its transitive dependents (boot.js accumulatePlugin) — if a dependent isn't
 * loaded, the vanilla base stylesheet is lost and the UI breaks. So we always
 * emit the transitive closure, dependency-first (base first, active overlay
 * last), and force vanilla in as the base. Empty selection → vanilla.
 */
export function normalizeThemes(selected: string[], deps: Record<string, string[]> = {}): string[] {
  const sel = selected.filter((name) => typeof name === 'string' && name.length > 0)
  if (sel.length === 0) sel.push('tiddlywiki/vanilla')
  const out: string[] = []
  const seen = new Set<string>()
  const visit = (name: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    for (const dep of deps[name] ?? []) {
      if (dep !== name) visit(dep)
    }
    out.push(name)
  }
  for (const name of sel) visit(name)
  if (!out.includes('tiddlywiki/vanilla')) out.unshift('tiddlywiki/vanilla')
  return out
}

/**
 * Ensure a language code (e.g. "zh-Hans") is in tiddlywiki.info `languages`.
 * Returns whether tiddlywiki.info changed (caller decides whether to restart).
 */
export async function ensureLanguage(wikiPath: string, twRoot: string, lang: string): Promise<boolean> {
  if (typeof lang !== 'string' || lang.trim().length === 0) return false
  const code = lang.trim()
  const catalog = await bundledCatalog(twRoot)
  if (!catalog.languages.some((l) => l.name === code)) {
    throw new Error(`unknown language plugin: ${code}`)
  }
  const info = await readWikiInfo(wikiPath)
  const current = info.languages ?? []
  if (current.includes(code)) return false
  info.languages = [...current, code]
  await writeWikiInfo(wikiPath, info)
  return true
}

function json(res: ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        rejectP(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveP(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectP)
  })
}

export interface AdminDeps {
  server: WikiServer
  getClient: () => TiddlyWebClient | undefined
  getWikiPath: () => string
  twRoot: () => string
  config: ConfigStore
  /** Seed registry for the settings-page "初始化" section. */
  seeds: {
    checkAll: (client: TiddlyWebClient) => Promise<Array<{ id: string; title: string; description: string; present: boolean; detail?: string }>>
    run: (client: TiddlyWebClient, id: string | undefined, force: boolean) => Promise<Array<{ id: string; ok: boolean; wrote: boolean; detail?: string; error?: string }>>
  }
}

export function registerAdminRoutes(ctx: { webServer: WebServerFace }, deps: AdminDeps): () => void {
  const handleState = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const wikiPath = deps.getWikiPath()
      const [info, catalog] = await Promise.all([readWikiInfo(wikiPath), bundledCatalog(deps.twRoot())])
      let git: unknown = null
      try {
        const { GitFace } = await import('./git.ts')
        git = await new GitFace().status(wikiPath)
      } catch {
        git = null
      }
      json(res, {
        ok: true,
        server: deps.server.status(),
        info: { plugins: info.plugins, themes: info.themes, languages: info.languages ?? [] },
        catalog,
        config: deps.config.get(),
        git,
      })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }

  const handleInfo = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const body = JSON.parse(await readBody(req)) as { plugins?: unknown; themes?: unknown; themeActive?: unknown; languages?: unknown }
      const wikiPath = deps.getWikiPath()
      const info = await readWikiInfo(wikiPath)
      const catalog = await bundledCatalog(deps.twRoot())
      const known = new Set([...catalog.plugins, ...catalog.themes].map((c) => c.name))
      const knownLangs = new Set(catalog.languages.map((c) => c.name))
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
      info.plugins = applyList('plugins', body.plugins)
      // Activate the chosen theme: load its full dependency chain AND set
      // `$:/theme` so the browser's themeManager actually applies it (the
      // `themes` array alone only makes the plugin available).
      let activatedTheme: string | undefined
      if (Array.isArray(body.themes)) {
        const themeDeps: Record<string, string[]> = {}
        for (const theme of catalog.themes) {
          if (theme.dependents && theme.dependents.length > 0) themeDeps[theme.name] = theme.dependents
        }
        let selected = applyList('themes', body.themes)
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
      await writeWikiInfo(wikiPath, info)
      await deps.server.restart()
      // Activate the chosen theme tiddler (mirrors TW's own Control Panel).
      if (activatedTheme !== undefined) {
        const client = deps.getClient()
        if (client !== undefined) {
          await client
            .put({ title: '$:/theme', text: `$:/themes/${activatedTheme}`, type: 'text/vnd.tiddlywiki', tags: [] })
            .catch(() => undefined)
        }
      }
      // After a languages change, pin the active language tiddler: first
      // enabled language, or en-GB when none is enabled. Only when the request
      // actually carried a languages array (plugins/themes restarts skip this).
      if (Array.isArray(body.languages)) {
        const client = deps.getClient()
        if (client !== undefined) {
          const langs = info.languages ?? []
          const active = langs.length > 0 ? `$:/languages/${langs[0]}` : '$:/languages/en-GB'
          await client.put({ title: '$:/language', text: active, type: 'text/plain', tags: [] }).catch(() => undefined)
          // Keep the startup auto-apply hint (config uiLanguage) consistent with
          // the active language, so a later dsh-web restart doesn't re-enable
          // a language the user just disabled here.
          const hint = langs.length > 0 ? langs[0] : ''
          if ((deps.config.get().uiLanguage ?? '') !== hint) {
            await deps.config.set(client, { uiLanguage: hint }).catch(() => undefined)
          }
        }
      }
      json(res, { ok: true, info: { plugins: info.plugins, themes: info.themes, languages: info.languages ?? [] } })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 400)
    }
  }

  const handleConfig = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const body = JSON.parse(await readBody(req)) as PluginConfigShape
      const client = deps.getClient()
      if (client === undefined) {
        json(res, { ok: false, error: 'wiki service is not running' }, 503)
        return
      }
      await deps.config.set(client, body)
      json(res, { ok: true, config: deps.config.get() })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 400)
    }
  }

  const handleRestart = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await deps.server.restart()
      json(res, { ok: true, status: deps.server.status().status })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }

  /**
   * GET /dsh-tiddlywiki/admin/seeds — status of every one-time seed
   * (doc-note / send-to-agent / home-index / tw-web-host) for the settings
   * page's 初始化 section.
   */
  const handleSeeds = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const client = deps.getClient()
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
      const body = JSON.parse(await readBody(req)) as { id?: unknown; force?: unknown }
      const id = typeof body.id === 'string' && body.id.trim().length > 0 ? body.id.trim() : undefined
      const force = body.force === true
      const client = deps.getClient()
      if (client === undefined) {
        json(res, { ok: false, error: 'wiki service is not running' }, 503)
        return
      }
      const results = await deps.seeds.run(client, id, force)
      const ok = results.every((r) => r.ok)
      json(res, { ok, results }, ok ? 200 : 400)
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }

  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/admin/state`, handler: (req, res) => { void handleState(req, res) } }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/admin/info`, handler: (req, res) => { void handleInfo(req, res) } }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/admin/config`, handler: (req, res) => { void handleConfig(req, res) } }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/admin/restart`, handler: (req, res) => { void handleRestart(req, res) } }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/admin/seeds`, handler: (req, res) => { void handleSeeds(req, res) } }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/admin/seeds/run`, handler: (req, res) => { void handleSeedsRun(req, res) } }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

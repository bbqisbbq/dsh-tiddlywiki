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
import { readFile, writeFile, readdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TiddlyWebClient } from './tw-api.ts'
import type { WikiServer } from './wiki.ts'
import { ROUTE_PREFIX, redactLogLines, redactRemoteUrl, type WebServerFace } from './routes.ts'
import { type ConfigStore, type PluginConfigShape } from './config.ts'
import { readBody, json, guardHandler, errorStatus, rejectCrossSiteWrite, rejectNonRead } from './http.ts'
import { waitForFileWrite, needsRestartAfterSeeds, flushPendingWrites } from './seeds.ts'
import { RENDER_PLUGIN_FILE } from './seed-render.ts'
import { GitFace } from './git.ts'

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

/**
 * Read the wiki's tiddlywiki.info.
 *
 * ONLY a missing file (ENOENT) means "no configuration yet" (first run). Every
 * other failure — EACCES/EBUSY, a truncated write, malformed JSON — PROPAGATES:
 * the settings page used to receive an empty config object, rewrite the file
 * from it and thereby DELETE the existing plugins/themes/`build`/hand-written
 * fields (v0.19.0 — the AGENTS §8 "don't treat a read failure as absence" rule,
 * applied to this path at last).
 */
export async function readWikiInfo(wikiPath: string): Promise<WikiInfo> {
  const file = join(wikiPath, 'tiddlywiki.info')
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { plugins: [], themes: [], languages: [] }
    }
    throw new Error(`读取 tiddlywiki.info 失败：${err instanceof Error ? err.message : String(err)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('tiddlywiki.info 不是合法 JSON；请先修复该文件再保存设置（已保留原文件）')
  }
  // A top-level `null`/array/primitive is NOT a valid tiddlywiki.info; the old
  // code spread it and crashed with "Cannot read properties of null" (a
  // confusing 500 instead of the intended readable error).
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('tiddlywiki.info 顶层不是对象；请先修复该文件再保存设置（已保留原文件）')
  }
  const obj = parsed as Partial<WikiInfo>
  return {
    // Spread FIRST, then the normalized fields: the old order let a literal
    // `"plugins": null` (or a non-array) overwrite the `[]` default and crash
    // every consumer with `.includes is not a function`.
    ...obj,
    description: obj.description,
    plugins: Array.isArray(obj.plugins) ? obj.plugins : [],
    themes: Array.isArray(obj.themes) ? obj.themes : [],
    languages: Array.isArray(obj.languages) ? obj.languages : [],
  }
}

/**
 * Write the wiki's tiddlywiki.info (pretty-printed, ordering preserved).
 * Keeps a `.bak` of the previous content and swaps the new content in via a
 * temp file + rename, so a crash or a full disk cannot leave a truncated file
 * behind (readWikiInfo now refuses to guess at one).
 */
export async function writeWikiInfo(wikiPath: string, info: WikiInfo): Promise<void> {
  const file = join(wikiPath, 'tiddlywiki.info')
  try {
    await writeFile(`${file}.bak`, await readFile(file, 'utf8'), 'utf8')
  } catch {
    /* first write — nothing to back up */
  }
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${JSON.stringify(info, null, 4)}\n`, 'utf8')
  await rename(tmp, file)
}

/**
 * Ensure one bundled official plugin is listed in tiddlywiki.info `plugins`
 * (idempotent). Returns whether the file changed — the caller restarts TW.
 *
 * WHY (v0.19.0): `WikiServer.ensureWiki()` scaffolds a fresh wiki with
 * `--init server`, and that edition ships ONLY tiddlyweb/filesystem/highlight.
 * The plugin nevertheless writes every agent note, quick-note, draft and clip
 * as `text/markdown`, and the `text/markdown` parser is provided exclusively by
 * the `tiddlywiki/markdown` plugin — without it a brand-new install renders
 * every Markdown note as raw wikitext/source. The author's own wiki already had
 * the plugin (added by an earlier import workflow), which is why this went
 * unnoticed.
 */
export async function ensurePlugin(wikiPath: string, twRoot: string, name: string): Promise<boolean> {
  const info = await readWikiInfo(wikiPath)
  if (info.plugins.includes(name)) return false
  const catalog = await bundledCatalog(twRoot)
  if (!catalog.plugins.some((p) => p.name === name)) {
    throw new Error(`unknown bundled plugin: ${name}`)
  }
  info.plugins = [...info.plugins, name]
  await writeWikiInfo(wikiPath, info)
  return true
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

export interface AdminDeps {
  server: WikiServer
  getClient: () => TiddlyWebClient | undefined
  getWikiPath: () => string
  twRoot: () => string
  config: ConfigStore
  /** Seed registry for the settings-page "初始化" section. */
  seeds: {
    checkAll: (client: TiddlyWebClient) => Promise<Array<{ id: string; title: string; description: string; present: boolean; removable: boolean; detail?: string }>>
    run: (client: TiddlyWebClient, id: string | undefined, force: boolean) => Promise<Array<{ id: string; ok: boolean; wrote: boolean; detail?: string; error?: string }>>
    /** 反初始化: remove one (or all) optional seed's seeded tiddlers + markers. */
    remove: (client: TiddlyWebClient, id: string | undefined) => Promise<Array<{ id: string; ok: boolean; wrote: boolean; detail?: string; error?: string }>>
  }
}

/**
 * Sentinel returned instead of a stored secret (`bridge.token` /
 * `ui.sendToAgent.token`) by `GET /admin/state` and by `POST /admin/config`'s
 * echo. `/admin/*` is an unauthenticated surface (only CSRF-hardened), and the
 * config tiddler legitimately carries shared tokens — handing them to any
 * caller of the loopback/LAN-reachable GUI is a real leak (v0.19.3). The
 * settings page renders the sentinel verbatim; posting it back is a no-op
 * (`stripMaskedSecrets` drops it), so the real value never leaves the host.
 */
export const MASKED_SECRET = '********'

/**
 * Mask secrets (and credentials inside the git remote URL) for an HTTP caller.
 *
 * v0.20.0: `auth.password` is masked too. The v0.19.3 implementation (and the
 * docs) claimed it was, but only `bridge.token` / `ui.sendToAgent.token` /
 * `git.remote` were handled — a config tiddler carrying `auth.password` (the
 * config tiddler is a wiki tiddler; a user can hand-edit it) was echoed in
 * clear text by the unauthenticated `GET /admin/state`. `passwordSet` mirrors
 * the `tokenSet` flag so the settings UI can show "a password is stored"
 * without ever receiving it.
 */
export function maskConfigSecrets(config: PluginConfigShape): PluginConfigShape {
  const bridge = (config.bridge ?? {}) as Record<string, unknown>
  const ui = (config.ui ?? {}) as Record<string, unknown>
  const sendToAgent = (ui.sendToAgent ?? {}) as Record<string, unknown>
  const git = (config.git ?? {}) as Record<string, unknown>
  const auth = (config.auth ?? {}) as Record<string, unknown>
  const maskToken = (value: unknown): string => (typeof value === 'string' && value.length > 0 ? MASKED_SECRET : '')
  return {
    ...config,
    auth: {
      ...auth,
      password: maskToken(auth.password),
      passwordSet: typeof auth.password === 'string' && auth.password.length > 0,
    },
    git: { ...git, remote: typeof git.remote === 'string' ? redactRemoteUrl(git.remote) : git.remote },
    bridge: {
      ...bridge,
      token: maskToken(bridge.token),
      tokenSet: typeof bridge.token === 'string' && bridge.token.length > 0,
    },
    ui: {
      ...ui,
      sendToAgent: {
        ...sendToAgent,
        token: maskToken(sendToAgent.token),
        tokenSet: typeof sendToAgent.token === 'string' && sendToAgent.token.length > 0,
      },
    },
  } as PluginConfigShape
}

/**
 * Drop the masked placeholders from an incoming config patch so saving the
 * settings page never overwrites a stored secret with `********` (or the
 * redacted git remote with `https://***@…`). `bridge.token`/`ui.sendToAgent.token`
 * are cleared only when the caller actually sends an empty string.
 */
export function stripMaskedSecrets<T extends Record<string, unknown>>(patch: T, current: PluginConfigShape): T {
  const copy = { ...patch } as Record<string, unknown>
  const cleanToken = (container: unknown): unknown => {
    if (typeof container !== 'object' || container === null) return container
    const obj = { ...(container as Record<string, unknown>) }
    if (obj.token === MASKED_SECRET) delete obj.token
    delete obj.tokenSet
    return obj
  }
  if (copy.bridge !== undefined) copy.bridge = cleanToken(copy.bridge)
  // v0.20.0: the same round-trip rule for auth.password (`passwordSet` is a
  // display-only flag and must never be persisted).
  if (copy.auth !== undefined && typeof copy.auth === 'object' && copy.auth !== null) {
    const auth = { ...(copy.auth as Record<string, unknown>) }
    if (auth.password === MASKED_SECRET) delete auth.password
    delete auth.passwordSet
    copy.auth = auth
  }
  if (copy.ui !== undefined) {
    const ui = typeof copy.ui === 'object' && copy.ui !== null
      ? { ...(copy.ui as Record<string, unknown>) }
      : copy.ui
    if (typeof ui === 'object' && ui !== null && (ui as Record<string, unknown>).sendToAgent !== undefined) {
      ;(ui as Record<string, unknown>).sendToAgent = cleanToken((ui as Record<string, unknown>).sendToAgent)
    }
    copy.ui = ui
  }
  if (copy.git !== undefined && typeof copy.git === 'object' && copy.git !== null) {
    const git = { ...(copy.git as Record<string, unknown>) }
    const storedRemote = typeof current.git?.remote === 'string' ? current.git.remote : ''
    if (typeof git.remote === 'string' && storedRemote.length > 0 && git.remote === redactRemoteUrl(storedRemote)) {
      delete git.remote
    }
    copy.git = git
  }
  return copy as T
}

export function registerAdminRoutes(ctx: { webServer: WebServerFace }, deps: AdminDeps): () => void {
  const handleState = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectNonRead(req, res)) return
      const wikiPath = deps.getWikiPath()
      const [info, catalog] = await Promise.all([readWikiInfo(wikiPath), bundledCatalog(deps.twRoot())])
      let git: unknown = null
      try {
        const status = await new GitFace().status(wikiPath)
        git = { ...status, remote: redactRemoteUrl(status.remote ?? '') }
      } catch {
        git = null
      }
      const view = deps.server.status()
      json(res, {
        ok: true,
        // Same redaction as GET /status: this route is unauthenticated too.
        server: { ...view, logs: redactLogLines(view.logs) },
        info: { plugins: info.plugins, themes: info.themes, languages: info.languages ?? [] },
        catalog,
        config: maskConfigSecrets(deps.config.get()),
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
      const wikiPath = deps.getWikiPath()
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
        await deps.server.restart()
      }
      // Activate the chosen theme tiddler (mirrors TW's own Control Panel).
      if (Array.isArray(body.themes) && activatedTheme !== undefined) {
        const client = deps.getClient()
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
        const client = deps.getClient()
        if (client !== undefined) {
          const langs = info.languages ?? []
          const active = langs.length > 0 ? `$:/languages/${langs[0]}` : '$:/languages/en-GB'
          await client.put({ title: '$:/language', text: active, type: 'text/plain', tags: [] })
            .catch((err) => { console.warn('[dsh-tiddlywiki] pinning $:/language failed:', err) })
          // Keep the startup auto-apply hint (config uiLanguage) consistent with
          // the active language, so a later dsh-web restart doesn't re-enable
          // a language the user just disabled here.
          const hint = langs.length > 0 ? langs[0] : ''
          if ((deps.config.get().uiLanguage ?? '') !== hint) {
            await deps.config.set(client, { uiLanguage: hint }).catch(() => undefined)
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
      const body = JSON.parse(await readBody(req)) as PluginConfigShape
      const client = deps.getClient()
      if (client === undefined) {
        json(res, { ok: false, error: 'wiki service is not running' }, 503)
        return
      }
      // Never persist the masked placeholders the page read back from /state
      // (v0.19.3): saving an untouched form must not clobber a real token.
      await deps.config.set(client, stripMaskedSecrets(body as Record<string, unknown>, deps.config.get()) as PluginConfigShape)
      json(res, { ok: true, config: maskConfigSecrets(deps.config.get()) })
    } catch (err) {
      // Not a blanket 400 (v0.19.5): a refused/dead wiki client surfaces as a
      // 500/413 like everywhere else — reporting「参数错误」for a service failure
      // sent the settings page down the wrong recovery path.
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  const handleRestart = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
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
  const handleSeeds = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectNonRead(req, res)) return
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
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      const body = JSON.parse(await readBody(req)) as { id?: unknown; force?: unknown }
      const id = typeof body.id === 'string' && body.id.trim().length > 0 ? body.id.trim() : undefined
      const force = body.force === true
      const client = deps.getClient()
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
          const flushed = await waitForFileWrite(join(deps.getWikiPath(), 'tiddlers', RENDER_PLUGIN_FILE), 8_000, 150, seedStartedAt)
          if (!flushed) console.warn('[dsh-tiddlywiki] seeded render plugin file not seen on disk before restart')
          // Drain the rest of the syncer queue too: force-all writes every seed,
          // and a restart that boots from a stale snapshot silently loses the
          // ones still queued (v0.19.0 — repeatedly lost tw-web-host here).
          const drained = await flushPendingWrites(client, join(deps.getWikiPath(), 'tiddlers'))
          if (!drained) console.warn('[dsh-tiddlywiki] seed writes may not have been flushed before restart')
          await deps.server.restart()
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
      const client = deps.getClient()
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

  // Same rejection safety net as routes.ts (v0.19.3).
  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/admin/state`, handler: guardHandler(handleState) }),
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

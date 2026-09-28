/**
 * Bundled catalog + tiddlywiki.info half of the admin surface (design doc §13).
 *
 * Extracted verbatim from `admin.ts` (a pure code move, v0.28.8): enumerate the
 * bundled catalog from the installed tiddlywiki package, read/write the wiki's
 * `tiddlywiki.info` plugins/themes/languages arrays, read the runtime plugin
 * truth of the wiki folder, and pin the active theme / language tiddlers.
 *
 * @module dsh-tiddlywiki/host/admin-catalog
 */
import { createRequire } from 'node:module'
import { readFile, writeFile, readdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TiddlyWebClient } from './tw-api.ts'

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

/**
 * The theme the TW runtime is ACTUALLY showing, as a catalog-style name
 * (`tiddlywiki/heavier`), or undefined when unknown (wiki down, no `$:/theme`).
 *
 * `$:/theme` holds the active theme title and is normally written as
 * `$:/themes/<name>` (that is what this route's own POST writes), but a user
 * who picked a theme in TW's Control Panel can leave the fully-qualified
 * title there — strip the prefix so both shapes compare against the catalog.
 * Without this the settings page could only guess "the last loaded theme"
 * (v0.22.3), and one click on 应用主题 silently overwrote the real choice.
 */
export async function readActiveThemeName(client: TiddlyWebClient | undefined): Promise<string | undefined> {
  try {
    const tiddler = await client?.get('$:/theme')
    const raw = typeof tiddler?.text === 'string' ? tiddler.text.trim() : ''
    if (raw.length === 0) return undefined
    return raw.startsWith('$:/themes/') ? raw.slice('$:/themes/'.length) : raw
  } catch {
    return undefined
  }
}

/** One plugin tiddler living INSIDE the wiki (installed via TW's own plugin library / import). */
export interface WikiPluginTiddler {
  /** Full tiddler title, e.g. "$:/plugins/kookma/pinboard". */
  title: string
  /** plugin.info `name`, e.g. "Pinboard". */
  name?: string
  description?: string
  version?: string
}

/**
 * Runtime plugin truth of the wiki folder (v0.26.0): which plugins exist as
 * TIDDLERS inside the wiki, and which are currently disabled.
 *
 * WHY this exists: the settings page's 插件管理 checkboxes mirror the
 * `tiddlywiki.info` `plugins` array (the BOOT-time install list the host
 * writes), while TW's Control Panel shows the RUNTIME set — tiddlywiki.info
 * plugins ∪ plugin tiddlers installed via TW's plugin library (they are saved
 * as `tiddlers/$__plugins_<author>_<name>.json`, never added to tiddlywiki.info)
 * MINUS those with a `$:/config/Plugins/Disabled/<title>` marker (text `yes`,
 * that is exactly TW core's own test in `core/ui/WikiInformation.tid`). A user
 * who installed TiddlyFlex in TW saw it enabled there but "not installed" in
 * the settings page; a user who disabled menubar in TW saw it checked here.
 * Both directions are real, and neither is a bug in the OTHER surface — the
 * two panels read different sources. This scan surfaces the missing half so
 * the settings page can label its rows honestly instead of lying by omission.
 *
 * HOW: a filesystem scan of the tiddlers/ directory — NOT a REST filter. The
 * tiddlyweb adaptor syncs plugin tiddlers as `.json` files with a `.json.meta`
 * companion carrying the full plugin.info (title/name/description/version), so
 * only tiny metadata files are read (a `[prefix[$:/plugins/]]` listing would
 * drag the multi-100KB plugin payloads into the response). Disabled markers
 * are `.tid` files whose own `title:` header is the exact plugin title — no
 * filename→title decoding (which is lossy for names containing underscores).
 *
 * Returns `null` when the tiddlers/ directory cannot be listed: "scan failed"
 * must stay distinguishable from "no wiki plugins" (the §3 read-failure rule),
 * so the client can hide the section instead of showing an empty lie.
 */
export async function scanWikiRuntimePlugins(wikiPath: string): Promise<{ wikiPlugins: WikiPluginTiddler[]; disabled: string[] } | null> {
  const tiddlersDir = join(wikiPath, 'tiddlers')
  let files: string[]
  try {
    files = await readdir(tiddlersDir)
  } catch {
    return null
  }
  /** Parse `key: value` lines of a .tid header / .meta file into a map. */
  const parseMetaFields = (raw: string): Map<string, string> => {
    const fields = new Map<string, string>()
    for (const line of raw.split(/\r?\n/)) {
      const idx = line.indexOf(': ')
      if (idx <= 0) continue
      const key = line.slice(0, idx).trim()
      const value = line.slice(idx + 2).trim()
      if (key.length > 0 && !fields.has(key)) fields.set(key, value)
    }
    return fields
  }
  const wikiPlugins: WikiPluginTiddler[] = []
  const disabled: string[] = []
  /** Dedupe across files: the same plugin title may appear in more than one shape. */
  const seenTitles = new Set<string>()
  for (const file of files) {
    // Plugin tiddlers: `$:/plugins/…` saved as `$__plugins_….json` (+ `.json.meta`).
    if (file.startsWith('$__plugins_') && (file.endsWith('.json') || file.endsWith('.json.meta'))) {
      if (file.endsWith('.json.meta')) {
        // Standard shape (plugin-library install): one tiddler + meta companion.
        let fields: Map<string, string>
        try {
          fields = parseMetaFields(await readFile(join(tiddlersDir, file), 'utf8'))
        } catch {
          continue
        }
        const title = fields.get('title')
        // plugin-type marks a real plugin bundle (plugin/theme/language); other
        // `$:/plugins/…` tiddlers (demo data, shadow overrides) are not plugins.
        if (typeof title !== 'string' || title.length === 0 || fields.get('plugin-type') !== 'plugin') continue
        // The dsh-* namespaces are OUR OWN seeds/bundles — plugin-managed, not
        // user-installed via TW; listing them as "installed in TW" is noise.
        if (title.startsWith('$:/plugins/dsh/') || title.startsWith('$:/plugins/dsh-tiddlywiki/')) continue
        if (seenTitles.has(title)) continue
        seenTitles.add(title)
        wikiPlugins.push({
          title,
          name: fields.get('name'),
          description: fields.get('description'),
          version: fields.get('version'),
        })
        continue
      }
      // No .meta companion: a bare `.json` tiddler file. It may hold ONE tiddler
      // or a multi-tiddler EXPORT ARRAY (drag-imported .json — real shape on the
      // author's wiki: `$__plugins_oeyoews_mermaid.json` is an array whose
      // element IS the plugin tiddler). Parse and keep plugin entries only.
      let parsed: unknown
      try {
        parsed = JSON.parse(await readFile(join(tiddlersDir, file), 'utf8'))
      } catch {
        continue
      }
      const entries = Array.isArray(parsed) ? parsed : [parsed]
      for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null) continue
        const t = entry as Record<string, unknown>
        if (t['plugin-type'] !== 'plugin') continue
        const title = typeof t.title === 'string' ? t.title : ''
        if (!title.startsWith('$:/plugins/')) continue
        if (title.startsWith('$:/plugins/dsh/') || title.startsWith('$:/plugins/dsh-tiddlywiki/')) continue
        if (seenTitles.has(title)) continue
        seenTitles.add(title)
        wikiPlugins.push({
          title,
          name: typeof t.name === 'string' ? t.name : undefined,
          description: typeof t.description === 'string' ? t.description : undefined,
          version: typeof t.version === 'string' ? t.version : undefined,
        })
      }
      continue
    }
    // Disabled markers: tiddler `$:/config/Plugins/Disabled/<plugin title>`.
    // TW core disables a plugin when that tiddler exists AND its text is `yes`
    // (WikiInformation.tid filters `[all[tiddlers]prefix[...]] :filter[{!!text}match[yes]]`).
    if (file.startsWith('$__config_Plugins_Disabled_') && file.endsWith('.tid')) {
      let raw: string
      try {
        raw = await readFile(join(tiddlersDir, file), 'utf8')
      } catch {
        continue
      }
      const header = raw.split(/\r?\n\r?\n/, 1)[0] ?? ''
      const fields = parseMetaFields(header)
      const title = fields.get('title')
      if (typeof title !== 'string' || !title.startsWith('$:/config/Plugins/Disabled/')) continue
      const pluginTitle = title.slice('$:/config/Plugins/Disabled/'.length)
      if (pluginTitle.length === 0) continue
      const body = raw.slice(header.length).trim()
      if (/^yes$/i.test(body)) disabled.push(pluginTitle)
    }
  }
  wikiPlugins.sort((a, b) => a.title.localeCompare(b.title))
  disabled.sort((a, b) => a.localeCompare(b))
  return { wikiPlugins, disabled }
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
      let info: { title?: string; name?: string; description?: string; dependents?: string[] } = {}
      try {
        info = JSON.parse(await readFile(join(root, dir, 'plugin.info'), 'utf8')) as typeof info
      } catch {
        info = {}
      }
      if (sub === 'themes' && dir !== 'vanilla' && !(await themeHasCss(dir))) continue
      // The tiddler title comes from plugin.info, NOT from the folder name
      // (v0.26.2): they normally agree, but `plugins/tiddlywiki/codemirror-fullscreen-editing`
      // declares `"title": "$:/plugins/tiddlywiki/codemirror-fullscreen"` — deriving
      // the title from the directory made every title-keyed comparison miss that
      // plugin (the settings page's 「TW 内已禁用」/「wiki 内已装」 badges match on
      // the full tiddler title, so a disabled codemirror-fullscreen showed no badge).
      // plugin.info IS the tiddler TW loads, so it is the source of truth; the
      // folder-derived form stays only as a fallback for a missing/empty title.
      const declaredTitle = typeof info.title === 'string' && info.title.length > 0 ? info.title : undefined
      out.push({
        name: `tiddlywiki/${dir}`,
        title: declaredTitle ?? (sub === 'plugins' ? `$:/plugins/tiddlywiki/${dir}` : `$:/themes/tiddlywiki/${dir}`),
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
 * Point `$:/language` at a language plugin — but ONLY when the stored text
 * differs (v0.24.2).
 *
 * WHY THE CONDITIONAL WRITE MATTERS
 * ---------------------------------
 * Both callers used to PUT this tiddler unconditionally: on EVERY dsh web
 * startup (`uiLanguage` auto-apply) and on every languages change. The body was
 * identical every time, but TW stamps a fresh `created`/`modified` into the
 * `.meta` file, so on a two-machine setup BOTH sides rewrote the same lines and
 * `git pull` conflicted on `tiddlers/$__language.txt.meta` **every single time**
 * — the repo's git log already carries a commit whose whole job was cleaning up
 * one of those leftovers. Same cause produced two conflict rounds in one session
 * on 2026-09-20.
 *
 * Returns whether anything was written (`changed: false` is the common case).
 *
 * ⚠️ A READ FAILURE MUST NOT BE TREATED AS "ALREADY CORRECT" (ironclad rule #3):
 * `client.get()` only returns undefined on a 404; anything else throws, and we
 * then write. Skipping on a transient read error would leave the user's language
 * pinned to the wrong value with no way to fix it.
 */
export async function pinLanguageTiddler(
  client: TiddlyWebClient,
  desired: string,
  log?: (message: string, err?: unknown) => void,
): Promise<boolean> {
  let existing: { text?: string } | undefined
  try {
    existing = await client.get('$:/language')
  } catch (err) {
    log?.('reading $:/language failed — writing it anyway', err)
  }
  if (existing !== undefined && existing.text === desired) return false
  await client.put({ title: '$:/language', text: desired, type: 'text/plain', tags: [] })
  return true
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

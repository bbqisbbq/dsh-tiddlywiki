/**
 * Multi-wiki registry (v0.28.0) — which knowledge bases exist, which one is the
 * default, and which of them the agent may see at all.
 *
 * WHY A FILE OUTSIDE EVERY WIKI
 * -----------------------------
 * Same reason as the single-location pointer (`host/wiki-location.ts`): the
 * settings page stores its overrides INSIDE the wiki it configures
 * (`$:/plugins/dsh-tiddlywiki/config`), so "which wikis exist / which is the
 * default" cannot live there — the answer must outlive every one of them.
 * The registry therefore lives next to the pointer:
 *
 *     $DSH_HOME/dsh-tiddlywiki/wikis.json
 *     { "version": 1, "defaultId": "main",
 *       "wikis": [ { "id": "main", "label": "工作", "root": "D:/notes",
 *                    "name": "main", "agentVisible": true, "autostart": true } ] }
 *
 * THREE SOURCES, ONE PRECEDENCE
 * -----------------------------
 *   wikis.json  >  legacy location.json (one `active` location)  >  cordis config default
 *
 * A user upgrading from a single-wiki install has only `location.json`; it is
 * migrated IN MEMORY into a one-entry registry (id `main`, agentVisible +
 * autostart true, so the upgrade reproduces the old behaviour exactly). The
 * caller writes the migrated registry back at its leisure — this module only
 * reads and validates.
 *
 * FAIL LOUD, DEGRADE TO A KNOWN-GOOD STATE
 * ----------------------------------------
 * A malformed registry is REPORTED and the fallback chain is used — it is
 * never silently acted upon (the same rule `readLocationState()` follows, and
 * for the same reason: a hand-edited JSON must not make the plugin boot
 * somewhere unexpected). Two severities:
 *
 *   - `fatal`    — the file is structurally unusable, or keeping it would be
 *                  DANGEROUS (duplicate id, two entries on one folder, nested
 *                  folders, a future schema version). → registry comes from
 *                  the fallback chain.
 *   - `warnings` — healed or skipped (one unparsable entry, `defaultId`
 *                  pointing at a wiki that is gone). → registry is usable.
 *
 * NESTED FOLDERS ARE REFUSED ON PURPOSE
 * -------------------------------------
 * Two registered wikis that contain one another (`D:/notes` and
 * `D:/notes/work`) are rejected rather than warned about: path-prefix
 * attribution becomes ambiguous for every git operation, and the OUTER wiki's
 * `git add -A` commits the inner wiki's tiddlers too (see the repo-keyed commit
 * model in `host/git.ts`). Both failure modes are silent and expensive, so the
 * cheapest correct answer is "no".
 *
 * @module dsh-tiddlywiki/host/wiki-registry
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative } from 'node:path'
import { dshHomePath } from '../sdk.ts'
import { defaultLocationStateFile, locationPath, normalizeLocation, readLocationState, type WikiLocation } from './wiki-location.ts'

/** Registry schema version (bumped only on an incompatible change). */
export const WIKI_REGISTRY_VERSION = 1

/** Id of the entry a migrated single-wiki install gets. */
export const DEFAULT_WIKI_ID = 'main'

/**
 * How many knowledge bases the plugin runs at once.
 *
 *   - `single` (default): exactly the behaviour every existing install already
 *     has — ONE wiki, chosen by the legacy pointer file over the cordis default.
 *     The registry is then only a memory of `mode` + the candidate list.
 *   - `multi`: the registry drives a farm — one TW child per entry, `autostart`
 *     entries come up at boot, and GUI/agent can address each one by id.
 *
 * WHY IT LIVES IN THIS FILE (and not in a wiki's config tiddler): the decision
 * must be readable BEFORE any wiki starts, and a config tiddler only exists
 * inside a wiki that is already running. Same reasoning as `agentVisible`.
 */
export type WikiMode = 'single' | 'multi'

/** The accepted modes, in declaration order (settings-page radio list). */
export const WIKI_MODES: readonly WikiMode[] = ['single', 'multi']

/** Mode assumed when the registry says nothing (upgrades, fresh installs). */
export const DEFAULT_WIKI_MODE: WikiMode = 'single'

/** One registered knowledge base. */
export interface WikiEntry {
  /**
   * Stable, URL-safe identifier. It is a path segment of the same-origin proxy
   * (`/dsh-tiddlywiki/tw/<id>/`) and part of the tiddler titles the session
   * scope is stored under, so the charset is deliberately narrow and lowercase.
   */
  id: string
  /** Display name used by every entry point / tab / picker (the single source). */
  label: string
  /** Absolute folder that HOLDS the wiki folder (same shape as WikiLocation). */
  root: string
  /** Wiki folder name under `root`; `.` means "the root folder itself". */
  name: string
  /**
   * May the AGENT reach this wiki at all? `false` = completely invisible: not
   * in the session picker, not mentioned in the injected prompt, never a
   * target of any `tiddlywiki_*` tool. Humans are unaffected.
   *
   * It lives HERE and not in the wiki's own config tiddler on purpose: asking
   * "should this one be hidden?" must not require starting the hidden wiki.
   */
  agentVisible: boolean
  /** Start its TW child process at boot (default false; the default wiki is true). */
  autostart: boolean
}

/** The whole registry: the mode, a non-empty list, and the default-wiki pointer. */
export interface WikiRegistry {
  version: number
  /**
   * `single` = one wiki, legacy behaviour (the pointer file still decides which);
   * `multi` = run every entry, `defaultId` decides the agent's fallback scope.
   */
  mode: WikiMode
  /** Id of the wiki a session with no explicit scope falls back to. */
  defaultId: string
  wikis: WikiEntry[]
}

/** Result of `validateRegistry()`: what survived, what ruined it, what was healed. */
export interface RegistryValidation {
  /** Best-effort registry; absent only when `fatal` is non-empty. */
  registry?: WikiRegistry
  /** Reasons the file must NOT be trusted (fall back to the legacy chain). */
  fatal: string[]
  /** Healed/skipped problems worth showing the user. */
  warnings: string[]
}

/** Result of `readRegistry()` — always yields a usable registry. */
export interface RegistryReadResult {
  registry: WikiRegistry
  /** Where the returned registry came from (settings-page display). */
  source: 'file' | 'legacy' | 'default'
  /** Joined problem text; fatal problems mean the fallback chain was used. */
  error?: string
  /** Non-fatal problems healed in the returned registry. */
  warnings: string[]
}

/** Default registry file: `$DSH_HOME/dsh-tiddlywiki/wikis.json`. */
export function defaultRegistryFile(): string {
  return dshHomePath('dsh-tiddlywiki', 'wikis.json')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalise/validate a wiki id, or undefined when unusable.
 *
 * Lowercased on purpose: the id is a URL path segment, and `/tw/Work/` vs
 * `/tw/work/` resolving to two different wikis on a case-insensitive Windows
 * filesystem would be a trap. Derivation (`deriveWikiId`) lowercases too, so a
 * round trip is stable.
 */
export function normalizeWikiId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const id = raw.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) return undefined
  return id
}

/**
 * Wiki ids that must NOT be used, because a wiki id is a PATH SEGMENT of the
 * same-origin proxy (`/dsh-tiddlywiki/tw/<id>/…`) while the TW child serves its
 * own endpoints at its ROOT (`/status`, `/recipes/…`, `/files/…`). An id equal
 * to one of those would make `/tw/status` ambiguous: is it the default wiki's
 * TW status, or the wiki named `status`? Nothing in the request can tell them
 * apart, so the id is simply refused (v0.28.0).
 *
 * This list is what lets the proxy treat "first segment looks like a known id"
 * as the per-wiki form and everything else as a TW path.
 */
export const RESERVED_WIKI_IDS: readonly string[] = [
  'status', 'recipes', 'bags', 'files', 'render', 'login', 'logout',
  'favicon.ico', 'index.html', 'static', 'assets',
]

/** Filesystem-safe slug for a wiki id (may be empty for junk input). */
function slugifyIdPart(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48)
}

/**
 * Derive a unique wiki id from a folder name (or any label), avoiding `taken`.
 * Falls back to `wiki`, `wiki-2`, … when the slug is empty or already used.
 */
export function deriveWikiId(source: unknown, taken: Iterable<string> = []): string {
  const used = new Set<string>()
  // Reserved ids are "taken" too: a folder literally named `status` must not
  // produce a wiki id the proxy could never route.
  for (const reserved of RESERVED_WIKI_IDS) used.add(reserved)
  for (const item of taken) {
    const id = normalizeWikiId(item)
    if (id !== undefined) used.add(id)
  }
  const base = normalizeWikiId(slugifyIdPart(source)) ?? 'wiki'
  if (!used.has(base)) return base
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${base}-${n}`.slice(0, 64)
    if (!used.has(candidate)) return candidate
  }
  // Unreachable for a real registry; still must return a *valid* id.
  return `wiki-${Date.now().toString(36)}`.slice(0, 64)
}

/** The `{root, name}` location this entry points at. */
export function entryLocation(entry: Pick<WikiEntry, 'root' | 'name'>): WikiLocation {
  return { root: entry.root, name: entry.name }
}

/** Absolute folder this entry serves. */
export function entryPath(entry: Pick<WikiEntry, 'root' | 'name'>): string {
  return locationPath(entryLocation(entry))
}

/**
 * Comparison key for duplicate/nesting detection.
 *
 * Case-INSENSITIVE on every platform on purpose: the check exists to catch
 * "two entries, one folder" and "one entry inside another", and on a
 * case-insensitive filesystem (Windows, default macOS) two ids differing only
 * in case ARE one folder. Rejecting the case-variant on Linux too is a
 * deliberate anti-footgun, not an oversight: no honest setup registers both
 * `D:/notes/A` and `D:/notes/a` as separate wikis.
 */
function comparisonKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Display label for an entry that came without one. */
function defaultLabel(location: WikiLocation): string {
  if (location.name !== '.') return location.name.slice(0, 60)
  return basename(locationPath(location)).slice(0, 60) || '.'
}

/**
 * Validate one entry. Missing `label` is derived, missing flags take their
 * defaults (`agentVisible` true, `autostart` false) — those are not errors.
 */
export function normalizeEntry(input: unknown): { entry?: WikiEntry; error?: string } {
  if (!isPlainObject(input)) return { error: '条目必须是一个对象' }
  const id = normalizeWikiId(input.id)
  if (id === undefined) {
    return { error: `知识库 id 非法（需以小写字母或数字开头，后接 a-z0-9._-，最长 64）：${JSON.stringify(input.id)}` }
  }
  if (RESERVED_WIKI_IDS.includes(id)) {
    return { error: `知识库 id「${id}」被保留：它会和 TW 自己的根路径 /${id} 撞名，同源代理无法区分两者` }
  }
  const normalized = normalizeLocation({ root: input.root, name: input.name })
  if (normalized.location === undefined) return { error: normalized.error ?? '位置非法' }
  const label = typeof input.label === 'string' && input.label.trim().length > 0
    ? input.label.trim().slice(0, 60)
    : defaultLabel(normalized.location)
  return {
    entry: {
      id,
      label,
      root: normalized.location.root,
      name: normalized.location.name,
      agentVisible: input.agentVisible !== false,
      autostart: input.autostart === true,
    },
  }
}

/**
 * Duplicate-folder and nested-folder problems across a candidate entry list.
 *
 * Nested = one entry's folder is strictly inside another's. Checked in both
 * directions and reported once per pair (the outer entry is named first).
 */
export function findPathConflicts(entries: readonly WikiEntry[]): string[] {
  const problems: string[] = []
  const byKey = new Map<string, WikiEntry>()
  for (const entry of entries) {
    const path = entryPath(entry)
    const key = comparisonKey(path)
    const duplicate = byKey.get(key)
    if (duplicate !== undefined) {
      problems.push(`知识库「${entry.id}」与「${duplicate.id}」指向同一个目录：${path}`)
      continue
    }
    byKey.set(key, entry)
  }
  const unique = [...byKey.values()]
  for (const outer of unique) {
    const outerPath = comparisonKey(entryPath(outer))
    for (const inner of unique) {
      if (inner === outer) continue
      const rel = relative(outerPath, comparisonKey(entryPath(inner)))
      // `''` = same path (already reported as a duplicate); `..`-prefixed or
      // absolute = not inside (different branch, or a different drive).
      if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) continue
      problems.push(
        `知识库「${inner.id}」位于「${outer.id}」目录内部（${entryPath(inner)} ⊂ ${entryPath(outer)}）：嵌套登记会让外层知识库的 git 一并提交内层内容，已拒绝`,
      )
    }
  }
  return problems
}

/**
 * Validate a parsed registry object.
 *
 * Structural/ambiguous problems are FATAL (empty `registry`): a duplicate id,
 * two entries on one folder, nested folders, a future schema version, or a
 * list where nothing parses. Per-entry junk and a stale `defaultId` are healed
 * and reported as warnings, because dropping one wiki is recoverable while
 * refusing to boot is not.
 */
export function validateRegistry(input: unknown): RegistryValidation {
  const fatal: string[] = []
  const warnings: string[] = []
  if (!isPlainObject(input)) return { fatal: ['清单必须是一个 JSON 对象'], warnings }

  const rawVersion = input.version
  if (typeof rawVersion === 'number' && Number.isFinite(rawVersion) && rawVersion > WIKI_REGISTRY_VERSION) {
    return { fatal: [`清单版本 ${rawVersion} 由更新版本的插件写入，本版本（${WIKI_REGISTRY_VERSION}）无法安全读取`], warnings }
  }
  if (!Array.isArray(input.wikis) || input.wikis.length === 0) {
    return { fatal: ['清单里没有任何知识库（wikis 必须是非空数组）'], warnings }
  }

  const entries: WikiEntry[] = []
  const seenIds = new Set<string>()
  for (const [index, item] of input.wikis.entries()) {
    const normalized = normalizeEntry(item)
    if (normalized.entry === undefined) {
      warnings.push(`跳过第 ${index + 1} 个条目：${normalized.error}`)
      continue
    }
    if (seenIds.has(normalized.entry.id)) {
      return { fatal: [`知识库 id 重复：${normalized.entry.id}`], warnings }
    }
    seenIds.add(normalized.entry.id)
    entries.push(normalized.entry)
  }
  if (entries.length === 0) {
    return { fatal: warnings.length > 0 ? [...warnings, '没有任何条目可用'] : ['清单里没有任何可用的知识库'], warnings }
  }

  const conflicts = findPathConflicts(entries)
  if (conflicts.length > 0) return { fatal: conflicts, warnings }

  const rawDefault = typeof input.defaultId === 'string' ? input.defaultId.trim().toLowerCase() : ''
  let defaultId = rawDefault
  if (!seenIds.has(defaultId)) {
    if (rawDefault.length > 0) warnings.push(`defaultId「${rawDefault}」不在清单里，已回退到「${entries[0]?.id ?? DEFAULT_WIKI_ID}」`)
    defaultId = entries[0]?.id ?? DEFAULT_WIKI_ID
  }
  // Mode: a missing field means "the behaviour you already had" (single), and an
  // UNKNOWN value is healed to single rather than being fatal — a typo must not
  // collapse a working farm into `nothing runs`.
  const rawMode = input.mode
  let mode: WikiMode = DEFAULT_WIKI_MODE
  if (rawMode !== undefined) {
    if (rawMode === 'single' || rawMode === 'multi') mode = rawMode
    else warnings.push(`未知的 mode「${String(rawMode)}」，已按 ${DEFAULT_WIKI_MODE} 处理`)
  }
  return { registry: { version: WIKI_REGISTRY_VERSION, mode, defaultId, wikis: entries }, fatal, warnings }
}

/** One localised entry for the current location, or undefined. */
export function findEntry(registry: WikiRegistry, id: unknown): WikiEntry | undefined {
  if (typeof id !== 'string') return undefined
  const key = id.trim().toLowerCase()
  return registry.wikis.find((entry) => entry.id === key)
}

/** The default entry (falls back to the first when `defaultId` dangles). */
export function defaultEntry(registry: WikiRegistry): WikiEntry | undefined {
  return findEntry(registry, registry.defaultId) ?? registry.wikis[0]
}

/** Insert or replace one entry by id (immutable); `defaultId` stays valid. */
export function upsertWiki(registry: WikiRegistry, entry: WikiEntry): WikiRegistry {
  const index = registry.wikis.findIndex((item) => item.id === entry.id)
  const wikis = index >= 0
    ? registry.wikis.map((item, i) => (i === index ? entry : item))
    : [...registry.wikis, entry]
  const defaultId = findEntry({ ...registry, wikis }, registry.defaultId) !== undefined
    ? registry.defaultId
    : (wikis[0]?.id ?? entry.id)
  return { ...registry, defaultId, wikis }
}

/**
 * Drop one entry (immutable). Refuses to empty the list — the plugin always
 * needs at least one wiki — and re-points `defaultId` when it was removed.
 */
export function removeWiki(registry: WikiRegistry, id: unknown): { registry?: WikiRegistry; error?: string } {
  const target = findEntry(registry, id)
  if (target === undefined) return { error: `知识库「${String(id)}」不在清单里` }
  if (registry.wikis.length <= 1) return { error: '至少要保留一个知识库' }
  const wikis = registry.wikis.filter((entry) => entry !== target)
  const defaultId = target.id === registry.defaultId ? (wikis[0]?.id ?? target.id) : registry.defaultId
  return { registry: { ...registry, defaultId, wikis } }
}

/**
 * A settings-page action on the wiki list (v0.28.0).
 *
 * The shape is deliberately a small discriminated union rather than "POST the
 * whole registry": the page can then never invent an inconsistent file, and
 * every mutation goes through the SAME validation the boot path uses.
 */
export type WikiAction =
  | { action: 'add'; wiki: unknown }
  | { action: 'update'; wiki: unknown }
  | { action: 'remove'; id: unknown }
  | { action: 'set-default'; id: unknown }
  | { action: 'set-mode'; mode: unknown }

/**
 * Apply ONE action to a registry, purely (v0.28.0).
 *
 * Pure on purpose: the side effects (write the file, reconcile the farm) stay in
 * the host wiring, so the RULES — which id gets derived, what a duplicate means,
 * what a folder move may collide with — are unit-testable in milliseconds
 * (`scripts/verify-wiki-registry.mjs`).
 *
 * Every action re-runs `validateRegistry()` on the RESULT, because a change can
 * create exactly the situations the registry exists to refuse: two entries on
 * one folder, or one entry nested inside another.
 */
export function applyWikiAction(registry: WikiRegistry, input: unknown): { registry?: WikiRegistry; error?: string } {
  if (!isPlainObject(input) || typeof input.action !== 'string') {
    return { error: '动作必须是一个带 action 字段的对象' }
  }
  const action = input.action
  const finish = (next: WikiRegistry): { registry?: WikiRegistry; error?: string } => {
    const validated = validateRegistry(next)
    if (validated.registry === undefined) return { error: validated.fatal.join('；') }
    return { registry: validated.registry }
  }

  if (action === 'add') {
    const raw = isPlainObject(input.wiki) ? input.wiki : undefined
    if (raw === undefined) return { error: 'add 需要 wiki 字段' }
    // The id is derived from the label/folder when the caller does not name one,
    // so the settings page can offer "add this folder" without asking for an id.
    const explicit = normalizeWikiId(raw.id)
    const id = explicit ?? deriveWikiId(typeof raw.label === 'string' && raw.label.trim().length > 0 ? raw.label : raw.name, registry.wikis.map((entry) => entry.id))
    if (findEntry(registry, id) !== undefined) return { error: `知识库「${id}」已存在（改它请用 update）` }
    const normalized = normalizeEntry({ ...raw, id })
    if (normalized.entry === undefined) return { error: normalized.error ?? '条目非法' }
    return finish({ ...registry, wikis: [...registry.wikis, normalized.entry] })
  }

  if (action === 'update') {
    const raw = isPlainObject(input.wiki) ? input.wiki : undefined
    if (raw === undefined) return { error: 'update 需要 wiki 字段' }
    const id = normalizeWikiId(raw.id)
    if (id === undefined) return { error: 'update 必须带一个合法的 id' }
    const existing = findEntry(registry, id)
    if (existing === undefined) return { error: `知识库「${id}」不在清单里（新增请用 add）` }
    const normalized = normalizeEntry({ ...raw, id })
    if (normalized.entry === undefined) return { error: normalized.error ?? '条目非法' }
    return finish(upsertWiki(registry, normalized.entry))
  }

  if (action === 'remove') {
    const removed = removeWiki(registry, input.id)
    if (removed.registry === undefined) return { error: removed.error ?? '删除失败' }
    return finish(removed.registry)
  }

  if (action === 'set-default') {
    // A DANGLING default would be healed by validateRegistry, so it is checked
    // here instead: "make this one the default" must fail loudly when it is gone.
    const target = findEntry(registry, input.id)
    if (target === undefined) return { error: `知识库「${String(input.id)}」不在清单里，无法设为默认` }
    return finish({ ...registry, defaultId: target.id })
  }

  if (action === 'set-mode') {
    if (input.mode !== 'single' && input.mode !== 'multi') {
      return { error: `mode 只能是 ${WIKI_MODES.join(' 或 ')}（收到 ${JSON.stringify(input.mode)}）` }
    }
    return finish({ ...registry, mode: input.mode })
  }

  return { error: `未知动作「${action}」（可用：add / update / remove / set-default / set-mode）` }
}

/**
 * A one-entry registry for a single location (migration / first run).
 *
 * `mode` defaults to `single` — a migrated install must reproduce exactly the
 * behaviour it had before the registry existed.
 */
export function singleEntryRegistry(location: WikiLocation, id: string = DEFAULT_WIKI_ID, mode: WikiMode = DEFAULT_WIKI_MODE): WikiRegistry {
  const normalized = normalizeLocation({ root: location.root, name: location.name })
  const resolved: WikiLocation = normalized.location ?? { root: location.root, name: location.name }
  const entryId = normalizeWikiId(id) ?? DEFAULT_WIKI_ID
  return {
    version: WIKI_REGISTRY_VERSION,
    mode,
    defaultId: entryId,
    wikis: [{
      id: entryId,
      label: defaultLabel(resolved),
      root: resolved.root,
      name: resolved.name,
      // A migrated single-wiki install IS the wiki the agent has always seen
      // and the one that has always started at boot: keep both flags on.
      agentVisible: true,
      autostart: true,
    }],
  }
}

/** Write the registry atomically (tmp + rename, mkdir -p). */
export async function writeRegistry(registry: WikiRegistry, file: string = defaultRegistryFile()): Promise<void> {
  const payload = JSON.stringify({ ...registry, updatedAt: new Date().toISOString() }, null, 2)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, payload, 'utf8')
  await rename(tmp, file)
}

/**
 * Read + validate the registry, falling back through `location.json` to the
 * cordis default. Never throws: every failure is a reported error plus a
 * usable one-entry registry.
 */
export async function readRegistry(deps: {
  file?: string
  legacyFile?: string
  /** The cordis-configured default location (last resort). */
  fallback: WikiLocation
}): Promise<RegistryReadResult> {
  const file = deps.file ?? defaultRegistryFile()
  const legacyFile = deps.legacyFile ?? defaultLocationStateFile()

  /**
   * The chain below the registry: legacy pointer, then the cordis default.
   * `reason` is prepended so the user learns WHY the registry was ignored.
   */
  const fallbackChain = async (reason: string, warnings: string[]): Promise<RegistryReadResult> => {
    const legacy = await readLocationState(legacyFile)
    // A migration — or a genuine first run — is NORMAL, not an error. Only a
    // non-empty `reason` (a registry that EXISTS but cannot be trusted) is
    // reported as one; the plain cases explain themselves through `source`.
    // Otherwise every fresh install would greet the user with a red banner.
    const legacyWarnings = legacy.error !== undefined ? [legacy.error] : []
    if (legacy.active !== undefined) {
      return {
        registry: singleEntryRegistry(legacy.active, DEFAULT_WIKI_ID),
        source: 'legacy',
        ...(reason.length > 0 ? { error: `${reason}；已回退到位置指针文件里的知识库（${locationPath(legacy.active)}）` } : {}),
        warnings: [...warnings, ...legacyWarnings],
      }
    }
    return {
      registry: singleEntryRegistry(deps.fallback, DEFAULT_WIKI_ID),
      source: 'default',
      ...(reason.length > 0 ? { error: `${reason}；已回退到配置默认知识库（${locationPath(deps.fallback)}）` } : {}),
      warnings: [...warnings, ...legacyWarnings],
    }
  }

  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      return fallbackChain(`知识库清单读不到（${file}）：${err instanceof Error ? err.message : String(err)}`, [])
    }
    // Absent registry is the normal first run / upgrade path: no error text.
    return fallbackChain('', [])
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fallbackChain(`知识库清单不是合法 JSON（${file}）`, [])
  }

  const validated = validateRegistry(parsed)
  if (validated.registry === undefined) {
    return fallbackChain(`知识库清单不可用（${validated.fatal.join('；')}）`, validated.warnings)
  }
  const warnings = validated.warnings
  return {
    registry: validated.registry,
    source: 'file',
    ...(warnings.length > 0 ? { error: warnings.join('；') } : {}),
    warnings,
  }
}

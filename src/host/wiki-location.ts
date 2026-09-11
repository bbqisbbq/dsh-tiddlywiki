/**
 * Where the wiki lives (v0.22.0 runtime switching).
 *
 * WHY A FILE OUTSIDE THE WIKI
 * ---------------------------
 * The settings page stores its overrides in the wiki itself
 * (`$:/plugins/dsh-tiddlywiki/config`). "Which wiki am I?" cannot live there:
 * switching to another wiki would take the setting with it (the new wiki would
 * read its own config tiddler and forget the choice). The active location is
 * therefore a small pointer file under the DSH home, outside every wiki:
 *
 *     $DSH_HOME/dsh-tiddlywiki/location.json
 *     { "version": 1, "active": { "root": "D:/notes", "name": "main" } }
 *
 * PRECEDENCE (see `resolveWikiLocation()` in src/index.ts):
 *     state file  >  cordis `config:` block  >  $DSH_HOME/tiddlywiki + "main"
 *
 * The cordis block keeps acting as the *default* — 「恢复为配置默认」 simply
 * deletes the pointer file. A malformed pointer is reported (never silently
 * acted upon) and falls back to the default, so a hand-edited JSON cannot make
 * the plugin boot somewhere unexpected.
 *
 * @module dsh-tiddlywiki/host/wiki-location
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { dshHomePath } from '../sdk.ts'

/** Pointer file schema version (bumped only on an incompatible change). */
export const LOCATION_STATE_VERSION = 1

/** A wiki folder = `root` + folder `name` (`.` means "root itself"). */
export interface WikiLocation {
  root: string
  name: string
}

/** Result of reading the pointer file. */
export interface WikiLocationState {
  /** Present only when a valid pointer exists. */
  active?: WikiLocation
  /** Non-fatal read problem worth surfacing in the settings page. */
  error?: string
}

/** Where the CURRENT location came from (settings-page display). */
export type WikiLocationSource = 'state' | 'config' | 'default'

/** Payload of `GET /admin/wiki/location` (built in src/index.ts). */
export interface WikiLocationInfo {
  current: { root: string; name: string; path: string; source: WikiLocationSource }
  default: { root: string; name: string; path: string }
  /** Pointer file path (shown so a user can find/delete it by hand). */
  stateFile: string
  /** Wiki-looking folders under the current root (folder names, `.` = the root). */
  candidates: string[]
  /** Set when the pointer file exists but could not be trusted. */
  error?: string
}

/** Default pointer file: `$DSH_HOME/dsh-tiddlywiki/location.json`. */
export function defaultLocationStateFile(): string {
  return dshHomePath('dsh-tiddlywiki', 'location.json')
}

/**
 * Expand `$VAR` / `${VAR}` / `%VAR%` from process.env (config uses `$DSH_HOME`).
 * Moved here (v0.22.0) so both `resolveWikiRoot()` and the location module
 * expand user input identically — the settings page accepts the same syntax as
 * the cordis config block.
 */
export function expandEnvPath(input: string, env: NodeJS.ProcessEnv = process.env): string {
  return input
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => env[name] ?? '')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => env[name] ?? '')
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_m, name: string) => env[name] ?? '')
}

/**
 * Normalise + validate a candidate location.
 *
 * `root` must be ABSOLUTE (a relative root would resolve against the dsh web
 * process cwd, i.e. "wherever it happened to be launched from" — the docs say
 * so, and now the code refuses to store it). `name` is a single folder name;
 * `.` means "the root folder itself".
 */
export function normalizeLocation(input: { root?: unknown; name?: unknown }): { location?: WikiLocation; error?: string } {
  const rawRoot = typeof input.root === 'string' ? input.root.trim() : ''
  if (rawRoot.length === 0) return { error: '路径不能为空' }
  const root = expandEnvPath(rawRoot)
  if (root.includes('\0')) return { error: '路径含非法字符' }
  if (!isAbsolute(root)) return { error: `请使用绝对路径（当前：${root}）——相对路径会按 dsh web 的启动目录解析` }
  const rawName = typeof input.name === 'string' && input.name.trim().length > 0 ? input.name.trim() : 'main'
  if (rawName !== '.' && (rawName.includes('/') || rawName.includes('\\') || rawName === '..' || isAbsolute(rawName))) {
    return { error: `文件夹名不能包含路径分隔符（当前：${rawName}）` }
  }
  return { location: { root: resolve(root), name: rawName } }
}

/** Absolute folder a location points at. */
export function locationPath(location: WikiLocation): string {
  return resolve(location.root, location.name)
}

/** Read the pointer file. Missing → `{}`; malformed → `{ error }` (never throws). */
export async function readLocationState(file: string = defaultLocationStateFile()): Promise<WikiLocationState> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return {}
    return { error: `位置指针文件读不到（${file}）：${err instanceof Error ? err.message : String(err)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { error: `位置指针文件不是合法 JSON（${file}）——已回退到配置默认值` }
  }
  if (typeof parsed !== 'object' || parsed === null) return { error: `位置指针文件格式不对（${file}）` }
  const active = (parsed as { active?: unknown }).active
  if (typeof active !== 'object' || active === null) return { error: `位置指针文件缺少 active 字段（${file}）` }
  const normalized = normalizeLocation(active as { root?: unknown; name?: unknown })
  if (normalized.location === undefined) {
    return { error: `位置指针内容非法（${normalized.error ?? '未知原因'}）——已回退到配置默认值` }
  }
  return { active: normalized.location }
}

/** Write the pointer file atomically (tmp + rename, mkdir -p). */
export async function writeLocationState(location: WikiLocation, file: string = defaultLocationStateFile()): Promise<void> {
  const payload = JSON.stringify({ version: LOCATION_STATE_VERSION, active: location, updatedAt: new Date().toISOString() }, null, 2)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, payload, 'utf8')
  await rename(tmp, file)
}

/** Delete the pointer file (「恢复为配置默认」). Missing file is a no-op. */
export async function clearLocationState(file: string = defaultLocationStateFile()): Promise<void> {
  await rm(file, { force: true })
}

/**
 * Folders under `root` that look like a TiddlyWiki server wiki (they contain
 * `tiddlywiki.info`), for the settings-page picker. `root` itself is reported
 * as `"."` when it is a wiki. Bounded: an unreadable/short directory is not an
 * error — the picker is a convenience, never a requirement.
 */
export async function listWikiCandidates(root: string, limit = 30): Promise<string[]> {
  const names: string[] = []
  try {
    const rootStat = await stat(root)
    if (!rootStat.isDirectory()) return names
    try {
      await stat(join(root, 'tiddlywiki.info'))
      names.push('.')
    } catch { /* root itself is not a wiki */ }
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      if (names.length >= limit) break
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      try {
        await stat(join(root, entry.name, 'tiddlywiki.info'))
        names.push(entry.name)
      } catch { /* not a wiki folder */ }
    }
  } catch { /* missing/unreadable root → empty picker */ }
  return names.sort((a, b) => a.localeCompare(b))
}

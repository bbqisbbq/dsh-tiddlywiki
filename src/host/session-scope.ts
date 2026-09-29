/**
 * Per-SESSION knowledge-base scope (v0.28.0) — which wiki a conversation works on.
 *
 * WHY A FILE OUTSIDE EVERY WIKI
 * -----------------------------
 * Same reason as the registry and the legacy pointer: the answer must not live
 * inside any single wiki (it would be unreadable while deciding which wiki to
 * talk to) and it must SURVIVE a `dsh web` restart — sessions are durable, so
 * "which knowledge base is this conversation using" has to be too.
 *
 *     $DSH_HOME/dsh-tiddlywiki/sessions.json
 *     { "version": 1, "sessions": { "<sessionId>": { "wikiId": "work", "at": "…" } } }
 *
 * FAIL SOFT, NEVER LOUD
 * ---------------------
 * This is a PREFERENCE, not configuration: a missing, malformed or unreadable
 * file simply means "no explicit scope" and every session falls back to the
 * farm's default wiki. It therefore never blocks anything and never throws —
 * unlike the registry, where a malformed file must be reported because it
 * decides WHERE the data lives.
 *
 * Stale entries are pruned on write (`SESSION_SCOPE_MAX_AGE_MS`): sessions come
 * and go, and this file has no other bound.
 *
 * @module dsh-tiddlywiki/host/session-scope
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '../sdk.ts'

/** Pointer-file schema version (bumped only on an incompatible change). */
export const SESSION_SCOPE_VERSION = 1

/** How long an untouched session→wiki mapping is kept (pruned on write). */
export const SESSION_SCOPE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000

/** Persisted shape. */
export interface SessionScopeState {
  version: number
  sessions: Record<string, { wikiId: string; at: string }>
}

/** Result of a read: usable mappings plus a non-fatal problem, if any. */
export interface SessionScopeReadResult {
  /** sessionId → wikiId (malformed entries are skipped). */
  scopes: Record<string, string>
  error?: string
}

/** Default file: `$DSH_HOME/dsh-tiddlywiki/sessions.json`. */
export function defaultSessionScopeFile(): string {
  return dshHomePath('dsh-tiddlywiki', 'sessions.json')
}

/**
 * Is this a usable session id?
 *
 * Session ids reach here from HTTP (the GUI selector) and are used as JSON keys,
 * so they are validated rather than trusted. The charset mirrors the one the
 * session-summary route already enforces.
 */
export function isSafeSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(id)
}

/** Is this a usable wiki id? (Shape only — the registry decides existence.) */
function isSafeWikiId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)
}

/** Drop mappings older than `maxAgeMs` (or with an unusable timestamp). */
export function pruneScopes(state: SessionScopeState, now: number, maxAgeMs: number = SESSION_SCOPE_MAX_AGE_MS): SessionScopeState {
  const sessions: SessionScopeState['sessions'] = {}
  for (const [sessionId, entry] of Object.entries(state.sessions)) {
    const at = Date.parse(entry.at)
    if (!Number.isFinite(at)) continue
    if (now - at > maxAgeMs) continue
    sessions[sessionId] = entry
  }
  return { version: SESSION_SCOPE_VERSION, sessions }
}

/** Parse a stored document into the loose shape, dropping anything unusable. */
function parseState(raw: string): { state?: SessionScopeState; error?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { error: '会话作用域文件不是合法 JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { error: '会话作用域文件格式不对' }
  const sessionsRaw = (parsed as { sessions?: unknown }).sessions
  if (typeof sessionsRaw !== 'object' || sessionsRaw === null) return { error: '会话作用域文件缺少 sessions 字段' }
  const sessions: SessionScopeState['sessions'] = {}
  let skipped = 0
  for (const [sessionId, value] of Object.entries(sessionsRaw as Record<string, unknown>)) {
    if (!isSafeSessionId(sessionId)) { skipped += 1; continue }
    const entry = value as { wikiId?: unknown; at?: unknown } | null
    if (entry === null || typeof entry !== 'object' || !isSafeWikiId(entry.wikiId) || typeof entry.at !== 'string') { skipped += 1; continue }
    sessions[sessionId] = { wikiId: entry.wikiId, at: entry.at }
  }
  return {
    state: { version: SESSION_SCOPE_VERSION, sessions },
    ...(skipped > 0 ? { error: `会话作用域文件里有 ${skipped} 条无效记录，已忽略` } : {}),
  }
}

/**
 * Read the mappings. Never throws: an unreadable/malformed file yields `{}` plus
 * an explanation (the caller may log it; nothing depends on this file).
 */
export async function readSessionScopes(file: string = defaultSessionScopeFile()): Promise<SessionScopeReadResult> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { scopes: {} }
    return { scopes: {}, error: `会话作用域文件读不到（${file}）：${err instanceof Error ? err.message : String(err)}` }
  }
  const parsed = parseState(raw)
  if (parsed.state === undefined) return { scopes: {}, ...(parsed.error !== undefined ? { error: parsed.error } : {}) }
  const scopes: Record<string, string> = {}
  for (const [sessionId, entry] of Object.entries(parsed.state.sessions)) scopes[sessionId] = entry.wikiId
  return { scopes, ...(parsed.error !== undefined ? { error: parsed.error } : {}) }
}

/** Write the state atomically (tmp + rename, mkdir -p). */
export async function writeSessionScopes(state: SessionScopeState, file: string = defaultSessionScopeFile()): Promise<void> {
  const payload = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, payload, 'utf8')
  await rename(tmp, file)
}

/**
 * Point one session at a wiki, or clear its scope (`wikiId === undefined`).
 *
 * Reads, prunes and writes in one go — the file is tiny and this happens once
 * per selection, so a read-modify-write is cheaper than any locking scheme.
 * A write failure is REPORTED (the caller surfaces it) but changes nothing else:
 * the session simply keeps falling back to the default.
 */
export async function setSessionScope(sessionId: string, wikiId: string | undefined, file: string = defaultSessionScopeFile()): Promise<void> {
  if (!isSafeSessionId(sessionId)) throw new Error(`会话 id 非法：${JSON.stringify(sessionId)}`)
  if (wikiId !== undefined && !isSafeWikiId(wikiId)) throw new Error(`知识库 id 非法：${JSON.stringify(wikiId)}`)
  /**
   * 读失败 ≠ 没有文件（铁律 #3）。
   *
   * Only ENOENT may be treated as "no scope file yet". Any other error
   * (EACCES/EBUSY, a Windows file lock, or losing the race against a concurrent
   * `writeSessionScopes` tmp+rename) used to collapse into `''` — and because the
   * next lines are a read-modify-WRITE of the whole file, that silently dropped
   * every OTHER session's knowledge-base scope. Throwing keeps the file intact
   * and surfaces the failure to the selector instead.
   */
  let existing = ''
  try {
    existing = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const parsed = existing.length > 0 ? (parseState(existing).state ?? { version: SESSION_SCOPE_VERSION, sessions: {} }) : { version: SESSION_SCOPE_VERSION, sessions: {} }
  const pruned = pruneScopes(parsed, Date.now())
  if (wikiId === undefined) delete pruned.sessions[sessionId]
  else pruned.sessions[sessionId] = { wikiId, at: new Date().toISOString() }
  await writeSessionScopes(pruned, file)
}

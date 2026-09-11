/**
 * Shared helpers for the ONE-SHOT seeds (`src/host/seed-*.ts`).
 *
 * ERROR POLICY (v0.18.0). A seed may only treat a tiddler as "missing" when the
 * server actually answered 404 — `TiddlyWebClient.get()` already does exactly
 * that (404 → `undefined`, everything else throws). Seeds must therefore NOT
 * wrap reads in `.catch(() => undefined)`: that turned a transient failure (TW
 * restarting, timeout, 5xx) into "the user has no such tiddler", after which the
 * NON-force startup seeds happily `put()` the built-in content and OVERWROTE
 * user-owned tiddlers (`$:/DefaultTiddlers`, the send-to-agent / render plugin
 * bundles, the doc note…). Letting the error propagate makes the seed report
 * `ok:false` and skip the write, which is the safe outcome.
 *
 * MARKER CONTENT HASHES (v0.22.0). A one-shot marker used to be the literal
 * text `seeded-once` — enough to mean "offered once", useless for telling
 * whether the BUILT-IN content changed since (which the settings page needs to
 * say 「有更新」) or whether the USER edited their copy (which must never be
 * overwritten silently). The marker is now JSON:
 *
 *     { "version": 1, "hashes": { "<title>": "<sha256/16>" }, "at": "<ISO>" }
 *
 * Old markers (`seeded-once`) are read as `legacy` and compared by TEXT
 * instead: identical to the built-in → ownership is proven and the marker is
 * upgraded in place; different → reported as "maybe updated / maybe edited",
 * never silently rewritten.
 *
 * The marker write stays best-effort (it is bookkeeping, not user content) but
 * is logged instead of silently swallowed, so a broken one-shot guarantee is at
 * least visible.
 *
 * @module dsh-tiddlywiki/host/seed-util
 */
import { createHash } from 'node:crypto'
import type { Tiddler, TiddlyWebClient } from './tw-api.ts'

/** Marker schema version (bump only on an incompatible change). */
export const SEED_MARKER_VERSION = 1

/** Parsed marker tiddler. */
export interface SeedMarker {
  version: number
  /** title → hash of the text this seed wrote there. */
  hashes: Record<string, string>
  at?: string
}

/** What `readSeedMarker()` found. */
export interface SeedMarkerState {
  /** Present when the marker is our JSON (any version we can read). */
  marker?: SeedMarker
  /**
   * The marker tiddler exists but is not our JSON — written before v0.22.0
   * (the literal `seeded-once`) or hand-edited. Hashes are unavailable; callers
   * fall back to comparing text.
   */
  legacy?: boolean
}

/** Short content hash used for markers (16 hex chars of sha256). */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Read one tiddler for a seed. 404 → `undefined`; every other failure (network,
 * timeout, 5xx, auth) propagates to the caller, which turns it into a failed
 * seed result instead of an overwrite.
 */
export function readSeedTiddler(client: TiddlyWebClient, title: string): Promise<Tiddler | undefined> {
  return client.get(title)
}

/** Parse a marker tiddler's text (never throws). */
export function parseSeedMarker(text: string | undefined): SeedMarkerState {
  if (typeof text !== 'string' || text.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(text) as { version?: unknown; hashes?: unknown }
    if (typeof parsed !== 'object' || parsed === null) return { legacy: true }
    const hashes = parsed.hashes
    if (typeof hashes !== 'object' || hashes === null) return { legacy: true }
    const clean: Record<string, string> = {}
    for (const [title, value] of Object.entries(hashes as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > 0) clean[title] = value
    }
    const version = typeof parsed.version === 'number' ? parsed.version : 1
    return { marker: { version, hashes: clean } }
  } catch {
    return { legacy: true }
  }
}

/**
 * Read a seed marker. 404 → `{}` (never seeded); a read FAILURE propagates like
 * every other seed read (v0.18.0 error policy).
 */
export async function readSeedMarker(client: TiddlyWebClient, title: string): Promise<SeedMarkerState> {
  const tiddler = await readSeedTiddler(client, title)
  if (tiddler === undefined) return {}
  return parseSeedMarker(typeof tiddler.text === 'string' ? tiddler.text : '')
}

/**
 * Write a one-shot marker. Best-effort: a failure is logged (never silent) and
 * does not fail the seed — the content write already succeeded and the marker
 * only records "offered once" + which built-in content was written.
 */
export async function writeSeedMarker(client: TiddlyWebClient, title: string, hashes?: Record<string, string>): Promise<void> {
  const payload: SeedMarker = { version: SEED_MARKER_VERSION, hashes: hashes ?? {}, at: new Date().toISOString() }
  try {
    await client.put({ title, text: JSON.stringify(payload), type: 'application/json', tags: [] })
  } catch (err) {
    console.warn(`[dsh-tiddlywiki] seed marker write failed (${title}):`, err instanceof Error ? err.message : err)
  }
}

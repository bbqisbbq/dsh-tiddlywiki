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
 * The one-shot MARKER write stays best-effort (it is bookkeeping, not user
 * content) but is logged instead of silently swallowed, so a broken one-shot
 * guarantee is at least visible.
 *
 * @module dsh-tiddlywiki/host/seed-util
 */
import type { Tiddler, TiddlyWebClient } from './tw-api.ts'

/**
 * Read one tiddler for a seed. 404 → `undefined`; every other failure (network,
 * timeout, 5xx, auth) propagates to the caller, which turns it into a failed
 * seed result instead of an overwrite.
 */
export function readSeedTiddler(client: TiddlyWebClient, title: string): Promise<Tiddler | undefined> {
  return client.get(title)
}

/**
 * Write a one-shot marker tiddler. Best-effort: a failure is logged (never
 * silent) and does not fail the seed — the content write already succeeded and
 * the marker only records "offered once".
 */
export async function writeSeedMarker(client: TiddlyWebClient, title: string): Promise<void> {
  try {
    await client.put({ title, text: 'seeded-once', type: 'text/plain', tags: [] })
  } catch (err) {
    console.warn(`[dsh-tiddlywiki] seed marker write failed (${title}):`, err instanceof Error ? err.message : err)
  }
}

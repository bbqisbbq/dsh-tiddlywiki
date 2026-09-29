/**
 * Tiny formatting helpers shared by client modules (v0.30.4).
 *
 * WHY THIS EXISTS: `pad()` had two byte-identical private copies
 * (`note-widget-draft.ts` and `sync-button.ts`) — the kind of duplicate that
 * silently drifts apart the first time one of them needs a tweak.
 *
 * @module dsh-tiddlywiki/client/format
 */

/** Zero-pad a number to two digits (`7` → `07`). */
export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

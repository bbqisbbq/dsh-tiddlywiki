/**
 * Small text helpers shared by the host modules (v0.20.0).
 *
 * `snippetOf` used to exist as two identical private copies (tools.ts for the
 * `tiddlywiki_recent` render, routes.ts for the quick-note/recent/search JSON)
 * with two different default widths — a drift waiting to happen.
 *
 * @module dsh-tiddlywiki/host/text-util
 */

/** Flat one-line snippet: whitespace collapsed, truncated with an ellipsis. */
export function snippetOf(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

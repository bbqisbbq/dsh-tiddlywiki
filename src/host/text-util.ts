/**
 * Small text/date helpers shared by the host modules (v0.20.0, extended v0.22.8).
 *
 * `snippetOf` used to exist as two identical private copies (tools.ts for the
 * `tiddlywiki_recent` render, routes.ts for the quick-note/recent/search JSON)
 * with two different default widths — a drift waiting to happen.
 *
 * v0.22.8 added `formatLocalMinute`: the note/draft title builder (routes.ts)
 * and the session-summary page builder (session-summary.ts) each formatted the
 * same `YYYY-MM-DD HH:mm` shape by hand — the PARSE half of this contract is
 * already centralised in `parseTiddlerDate`, so the format half belongs here too.
 *
 * @module dsh-tiddlywiki/host/text-util
 */

/** Flat one-line snippet: whitespace collapsed, truncated with an ellipsis. */
export function snippetOf(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/**
 * Local `YYYY-MM-DD HH:mm` for a Date or an epoch-ms value.
 *
 * Two-digit zero padding is deliberate (that is the shape both callers already
 * emitted, and it is what the wiki's own title convention uses). An invalid
 * Date / non-finite number yields `''` rather than `NaN-NaN-…`.
 */
export function formatLocalMinute(value: Date | number): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

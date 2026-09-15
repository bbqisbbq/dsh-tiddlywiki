/**
 * The one client-side `POST /dsh-tiddlywiki/render` caller (v0.22.8).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The reply-stream tool card (`tool-views.ts`) and the per-session 「知识库」 tab
 * (`session-summary.ts`) each carried their own copy of this request. They
 * differed only in the timeout and in whether an empty fragment was treated as
 * a failure — and the `x-requested-with: TiddlyWiki` header is LOAD-BEARING
 * (TW's server gates every POST behind the writer CSRF check, so losing it
 * turns the whole feature into a 403). One copy keeps that honest.
 *
 * The endpoint is the HOST route, never TW's raw `/tw/render`: the host proxies
 * to TW and sanitizes the fragment (`sanitizeTwFragment`) before it reaches the
 * browser, and both callers inject the result with `dangerouslySetInnerHTML`
 * inside the DSH page. See `RENDER_ENDPOINT` in `endpoints.ts`.
 *
 * Returns the fragment, or `null` on any failure. An empty/whitespace-only body
 * resolves to `null` too: TW can answer 200 with nothing for a blank tiddler,
 * and both callers' "render unavailable" branches are the correct reaction.
 *
 * @module dsh-tiddlywiki/client/render-fetch
 */
import { RENDER_ENDPOINT } from './endpoints.ts'

/** Render one tiddler by title through the host's sanitizing render route. */
export async function fetchRenderFragment(title: string, timeoutMs = 15_000): Promise<string | null> {
  try {
    const res = await fetch(RENDER_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'TiddlyWiki' },
      body: JSON.stringify({ title }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const text = await res.text()
    return text.trim().length > 0 ? text : null
  } catch {
    return null
  }
}

/**
 * The secret-namespace guard, shared by every surface that turns a
 * caller-supplied title (or title reference) into TW output.
 *
 * Titles the browser-facing TW surfaces must never serve (v0.19.3 / v0.20.0).
 *
 * `$:/plugins/dsh-tiddlywiki/config` holds the shared tokens and the git
 * remote (possibly with a PAT); `/tw` and `/api` forward ANY path to the
 * loopback TW child, whose TiddlyWeb REST answers for `$:/…` titles — a
 * route-level guard on `/get` was therefore trivially bypassed by
 * `GET /dsh-tiddlywiki/tw/recipes/default/tiddlers/%24%3A%2Fplugins%2F…`
 * (verified). The whole plugin namespace is blocked: nothing under it is
 * needed by the TW frontend, and the host itself talks to TW directly.
 *
 * v0.20.0: the SAME predicate also guards `POST /render`, which had been
 * left open — TW's `/render` route renders ANY tiddler by title, so
 * `{"title":"$:/plugins/dsh-tiddlywiki/config"}` returned the raw config
 * (tokens + PAT in plain text inside `<pre><code>`, where the fragment
 * sanitizer keeps it). Verified end-to-end against a scratch wiki before the
 * fix. Every route that turns a caller-supplied title into TW output must use
 * `isBlockedProxyTitle`.
 *
 * v0.29.0: extracted from `routes-tw-proxy.ts` into this module because the
 * AGENT TOOL layer needs it too (`tiddlywiki_get` reached `$:/plugins/
 * dsh-tiddlywiki/config` directly, so the model could read the tokens the
 * routes are careful to hide). The tool layer must not depend on a route
 * module for a security primitive — hence one shared home, imported by both.
 *
 * @module dsh-tiddlywiki/host/proxy-guard
 */

export const BLOCKED_PROXY_TITLE_PREFIXES = ['$:/plugins/dsh-tiddlywiki/']

/** True when a caller-supplied tiddler title addresses the secret namespace. */
export const isBlockedProxyTitle = (title: string): boolean =>
  BLOCKED_PROXY_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix))

/**
 * True when a proxied pathname addresses a blocked (secret-bearing) tiddler.
 *
 * Decodes the WHOLE path rather than looking for a literal `/tiddlers/` marker
 * (v0.23.5). TW core's `get-tiddler-html.js` route is a SINGLE segment
 * (`path = /^\/([^\/]+)$/`) decoded with `decodeURIComponentSafe`, so
 * `GET /tw/%24%3A%2Fplugins%2Fdsh-tiddlywiki%2Fconfig` reached the config
 * tiddler while the old marker check saw no `/tiddlers/` at all (verified
 * before the fix: 200, 715 bytes of config JSON on both `/tw` and `/api`).
 * Raw, once- and twice-decoded forms are all checked so double-encoding cannot
 * slip through either.
 */
export const isBlockedProxyPath = (pathname: string): boolean => {
  let candidate = pathname
  for (let i = 0; i < 3; i += 1) {
    if (BLOCKED_PROXY_TITLE_PREFIXES.some((prefix) => candidate.includes(prefix))) return true
    let next = candidate
    try {
      next = decodeURIComponent(candidate)
    } catch { /* malformed encoding: stop decoding and use what we have */ }
    if (next === candidate) break
    candidate = next
  }
  return BLOCKED_PROXY_TITLE_PREFIXES.some((prefix) => candidate.includes(prefix))
}

/**
 * Does caller-supplied CONTENT reference the protected namespace? (v0.23.5)
 * TW's `/render` resolves `{{…}}` transclusions server-side, so the `text`
 * branch was a second way to print the config tiddler: verified before the fix,
 * `POST /render {"text":"{{$:/plugins/dsh-tiddlywiki/config}}"}` returned 200
 * with the config JSON inside `<pre><code>` — the fragment sanitizer only strips
 * tags, it cannot know the text is a secret.
 */
export const referencesBlockedTitle = (value: string | undefined): boolean =>
  value !== undefined && BLOCKED_PROXY_TITLE_PREFIXES.some((prefix) => value.includes(prefix))

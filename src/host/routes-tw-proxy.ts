/**
 * The THREE routes that turn a caller-supplied title or path into TiddlyWiki
 * output — `/render`, `/api/*` and `/tw/*` — extracted from routes.ts so the
 * security-relevant surface lives in one file (v0.28.8).
 *
 * WHY IT EXISTS (this is a security boundary, not a size exercise): these are
 * the only routes that must apply `isBlockedProxyTitle()` /
 * `isBlockedProxyPath()` / `referencesBlockedTitle()` before anything reaches
 * the loopback TW child, and two of them (`/api/*`, `/tw/*`) are generic
 * passthroughs whose guards were historically the ones that got missed
 * (`/get` had a private copy of the literal until v0.22.8; `/render` was
 * entirely unguarded until v0.20.0; the single-segment `/tw/%24%3A…` form and
 * the `{{…}}` transclusion form both slipped through until v0.23.5). Keeping
 * the three handlers plus the shared prefix predicates and the header
 * forwarder in ONE module means a future addition to the blocked namespace or
 * to the forwarded headers has exactly one place to go, next to every caller.
 *
 * The handlers still close over the request-scoped route deps (`deps`,
 * `json`, the method/CSRF guards, `MAX_*` body caps, …), so they are built by
 * a factory, `createTwProxyRoutes()`, and destructured inside
 * `registerRoutes()` — the registration block — and the exact ordering of
 * every check inside each handler — are unchanged by design.
 *
 * @module dsh-tiddlywiki/host/routes-tw-proxy
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { TiddlyWebClient } from './tw-api.ts'
import { RenderNotFoundError } from './tw-api.ts'
import type { WikiServer } from './wiki.ts'
import { TW_PROXY_PREFIX } from './wiki.ts'
import { readBody, readBodyBuffer, json, errorStatus, rejectCrossSiteWrite, MAX_PROXY_BODY_BYTES, MAX_UPLOAD_BYTES } from './http.ts'
import { sanitizeTwFragment } from './sanitize.ts'

/** Header names forwarded to the upstream TW service by the proxy routes. */
const FORWARD_HEADER_NAMES = [
  'accept', 'accept-encoding', 'content-type', 'cookie', 'authorization',
  'if-none-match', 'if-modified-since', 'origin', 'referer', 'user-agent',
] as const

/** Copy a safe, string-valued subset of the request headers upstream. */
function forwardHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of FORWARD_HEADER_NAMES) {
    // Index through the string index signature so known header names (typed
    // `string`) do not hide the `string[]` repeat case via their specific
    // property declarations.
    const value: string | string[] | undefined = headers[name as string]
    if (typeof value === 'string') out[name] = value
    else if (Array.isArray(value) && value.length > 0) out[name] = value.join(', ')
  }
  return out
}

/**
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
 * v0.20.0: the SAME predicate now also guards `POST /render`, which had been
 * left open — TW's `/render` route renders ANY tiddler by title, so
 * `{"title":"$:/plugins/dsh-tiddlywiki/config"}` returned the raw config
 * (tokens + PAT in plain text inside `<pre><code>`, where the fragment
 * sanitizer keeps it). Verified end-to-end against a scratch wiki before the
 * fix. Every route that turns a caller-supplied title into TW output must use
 * `isBlockedProxyTitle`.
 *
 * v0.28.8: this lives here (not in routes.ts) because this module owns every
 * caller of it — but `/get` in routes.ts still uses it too, hence the export.
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

/**
 * Every request-scoped dependency the three TW-facing routes use. Deliberately
 * NOT `RouteDeps`: passing this narrower face keeps the proxy module from
 * reaching for per-request services it has no business reading (sessions,
 * wechat, presets), so the extracted handlers can only use what they used
 * before.
 */
export interface TwProxyRouteDeps {
  /** The TW child serving the wiki this request targets (undefined = not up). */
  server: (req: IncomingMessage) => WikiServer | undefined
  /** The TW child of a NAMED wiki (the `/tw/<id>/…` proxy form). */
  serverById: (id: string) => WikiServer | undefined
  /** Every registered wiki id (lets the proxy tell an id from a TW path). */
  wikiIds: () => readonly string[]
  /** Lazily resolved REST client for the same wiki (the `/render` route). */
  getClient: (req: IncomingMessage) => TiddlyWebClient | undefined
}

/** The three handlers, ready to be wrapped in `guardHandler` and registered. */
export interface TwProxyRouteHandlers {
  handleRender: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  handleApiProxy: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  handleTwProxy: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

/**
 * Build the `/render`, `/api/*` and `/tw/*` handlers over a request-scoped dep
 * face. Behaviour is byte-for-byte the handlers routes.ts used to define
 * inline, including the ORDER of the method check, the blocked-title checks
 * and the upstream resolution.
 */
export function createTwProxyRoutes(deps: TwProxyRouteDeps): TwProxyRouteHandlers {
  /**
   * POST /dsh-tiddlywiki/render — the ONLY render endpoint the GUI uses.
   *
   * Proxies to TW's own `/render` server route (installed by the `render-route`
   * seed) and **sanitizes the fragment before it leaves the host**.
   *
   * WHY (v0.19.1, security): the reply-stream tool card and the session
   * 「知识库」 Tab inject that HTML with `dangerouslySetInnerHTML` inside the DSH
   * page. TW's wikitext/markdown parsers only strip `on*` attributes — measured
   * against the live `/render`: `<iframe src="javascript:…">`,
   * `<a href="javascript:…">` and `<form action="javascript:…">` all pass
   * through, i.e. any note text (agent-written, clipped, imported) could run
   * script on the DSH origin and call the unauthenticated `/dsh-tiddlywiki/*`
   * routes. Sanitizing host-side also protects wikis whose ONE-SHOT render
   * bundle predates this fix (the client can never see raw TW output).
   */
  const handleRender = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      const client = deps.getClient(req)
      if (client === undefined) {
        json(res, { ok: false, error: 'wiki service is not running' }, 503)
        return
      }
      let body: { title?: unknown; text?: unknown; type?: unknown; contextTitle?: unknown; parseAsInline?: unknown } = {}
      try {
        body = JSON.parse(await readBody(req, MAX_PROXY_BODY_BYTES)) as typeof body
      } catch (err) {
        // `readBody` rejects with `body too large` when the cap is hit (v0.23.5):
        // that used to be swallowed by this catch and reported as 400 "invalid
        // JSON", which hides the real problem. Route it through errorStatus so an
        // oversize body is 413 like every other route.
        const status = errorStatus(err)
        if (status !== 500) {
          json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, status)
          return
        }
        json(res, { ok: false, error: 'invalid JSON body' }, 400)
        return
      }
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      const text = typeof body.text === 'string' ? body.text : undefined
      if (title.length === 0 && text === undefined) {
        json(res, { ok: false, error: 'body must provide "title" or "text"' }, 400)
        return
      }
      // SECURITY (v0.20.0): TW's /render answers for ANY title, including
      // `$:/plugins/dsh-tiddlywiki/config` (bridge/send-to-agent tokens + the
      // git remote, possibly with a PAT). This is the same secret the `/get`,
      // `/tw` and `/api` guards protect — /render was simply missed. Verified:
      // before this guard the rendered fragment contained both secrets verbatim.
      if (isBlockedProxyTitle(title)) {
        json(res, { ok: false, error: 'system tiddler not exposed' }, 403)
        return
      }
      // The `text` branch transcludes server-side, so it can reach the same
      // secret without ever mentioning it as `title` (v0.23.5). Check the body
      // and the parse context too.
      if (referencesBlockedTitle(text) || referencesBlockedTitle(
        typeof body.contextTitle === 'string' ? body.contextTitle : undefined,
      )) {
        json(res, { ok: false, error: 'system tiddler not exposed' }, 403)
        return
      }
      const request = title.length > 0
        ? { title }
        : {
            text: text as string,
            ...(typeof body.type === 'string' && body.type.length > 0 ? { type: body.type } : {}),
            ...(typeof body.contextTitle === 'string' && body.contextTitle.length > 0 ? { contextTitle: body.contextTitle } : {}),
            ...(body.parseAsInline === true ? { parseAsInline: true } : {}),
          }
      const html = await client.render(request)
      const safe = sanitizeTwFragment(html)
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(safe, 'utf8'),
      })
      res.end(safe)
    } catch (err) {
      // Structural 404 detection (v0.22.8): RenderNotFoundError carries the
      // flag, so this no longer depends on the error MESSAGE wording.
      if (err instanceof RenderNotFoundError || (err as { notFound?: unknown } | null)?.notFound === true) {
        json(res, { ok: false, notFound: true, error: err instanceof Error ? err.message : String(err) }, 404)
        return
      }
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 502)
    }
  }

  /** Passthrough /dsh-tiddlywiki/api/<rest> → TW root /<rest>. */
  const handleApiProxy = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Explicit method whitelist (v0.19.5): the host webserver dispatches by
    // pathname only, so without it every method (TRACE, or a typo'd verb) was
    // forwarded to the TW child. The set is the TiddlyWeb API surface the TW
    // frontend uses.
    if (rejectCrossSiteWrite(req, res, ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'])) return
    // The upstream base comes straight from the child (v0.28.0: per request, so
    // a named wiki can be proxied); the client is only a liveness proxy.
    const server = deps.server(req)
    if (server?.url === undefined) {
      json(res, { ok: false, error: 'wiki service is not running' }, 503)
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const rest = url.pathname.replace(/^\/dsh-tiddlywiki\/api/, '') || '/'
      if (isBlockedProxyPath(rest)) {
        json(res, { ok: false, error: 'system tiddler not exposed' }, 403)
        return
      }
      // Share the /tw proxy's header forwarding so `authorization`/`cookie`
      // reach the TW child: in locked-down mode (auth.username configured) the
      // /api passthrough used to 401 on every call because it dropped them.
      const headers: Record<string, string> = forwardHeaders(req.headers)
      const method = (req.method ?? 'GET').toUpperCase()
      // TW's CSRF gate requires X-Requested-With on writes; forward it through.
      if (method === 'PUT' || method === 'DELETE' || method === 'POST') headers['x-requested-with'] = 'TiddlyWiki'
      const init: RequestInit = { method, headers, signal: AbortSignal.timeout(15_000) }
      if (method === 'PUT' || method === 'POST') init.body = await readBody(req, MAX_PROXY_BODY_BYTES)
      const upstream = await fetch(`${server.url}${rest}${url.search}`, init)
      const data = await upstream.text()
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(data)
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 502)
    }
  }

  /**
   * SAME-ORIGIN proxy /dsh-tiddlywiki/tw/<rest> → TW root /<rest>. Serves the
   * ENTIRE TW frontend (index HTML, /files/*, the TiddlyWeb API) to the
   * browser through the DSH origin, so the embedded editor works from any
   * host/domain the user reaches DSH on (loopback, LAN, Tailscale, domain,
   * HTTPS). The browser never talks to the loopback TW child directly; DSH
   * does, on the same machine. Binary responses are buffered losslessly
   * (arrayBuffer) — unlike the /api JSON proxy, this route must never .text().
   */
  const handleTwProxy = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Explicit method whitelist (v0.22.8): the host webserver dispatches by
    // pathname only, so without it TRACE or a typo'd verb was forwarded straight
    // to the TW child. Same set the sibling /api proxy declares.
    if (rejectCrossSiteWrite(req, res, ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'])) return
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    // PER-WIKI FORM (v0.28.0): `/tw/<id>/<tw-path>`. The first segment is only
    // consumed when it names a REGISTERED wiki, so TW's own `/tw/status` and
    // `/tw/files/…` keep meaning "the default wiki's TW path" — that is exactly
    // what the reserved-id rule guarantees (a wiki id may never equal a TW root
    // segment; see RESERVED_WIKI_IDS in host/wiki-registry.ts).
    const afterPrefix = url.pathname.slice(TW_PROXY_PREFIX.length).replace(/^\//, '')
    const [firstSegment = '', ...tail] = afterPrefix.split('/')
    const named = deps.wikiIds().includes(firstSegment) ? firstSegment : undefined
    const rest = named === undefined
      ? (url.pathname.replace(new RegExp(`^${TW_PROXY_PREFIX}(?=/|$)`), '') || '/')
      : `/${tail.join('/')}`
    // The guard runs on BOTH forms: the raw path is what a crafted request
    // controls, and the stripped `rest` is what actually reaches TW.
    if (isBlockedProxyPath(url.pathname) || isBlockedProxyPath(rest)) {
      json(res, { ok: false, error: 'system tiddler not exposed' }, 403)
      return
    }
    // Resolve the child LAST, so a named-but-stopped wiki answers 503 instead of
    // being proxied to whoever happens to be the default.
    const server = named === undefined ? deps.server(req) : deps.serverById(named)
    if (server?.url === undefined) {
      json(res, { ok: false, error: 'wiki service is not running' }, 503)
      return
    }
    try {
      const method = (req.method ?? 'GET').toUpperCase()
      const headers = forwardHeaders(req.headers)
      // TW's CSRF gate requires X-Requested-With on writes; forward it through.
      if (method === 'PUT' || method === 'DELETE' || method === 'POST') headers['x-requested-with'] = 'TiddlyWiki'
      // Abort the upstream fetch when the CLIENT goes away: without this the TW
      // child kept streaming a large attachment into the DSH process until the
      // 30s timeout fired, long after the browser had cancelled (v0.19.3).
      const abort = new AbortController()
      const timeout = AbortSignal.timeout(30_000)
      const signal = typeof AbortSignal.any === 'function' ? AbortSignal.any([abort.signal, timeout]) : timeout
      const init: RequestInit = { method, headers, signal }
      if (method === 'PUT' || method === 'POST') init.body = await readBodyBuffer(req, MAX_UPLOAD_BYTES)
      // A DELETE with a body would otherwise stay unread on the socket: the
      // upstream fetch goes out, but this request never drains, so the client
      // sits on a half-open connection until the 30s timeout (v0.19.5). The TW
      // frontend does not send DELETE bodies, but the proxy is a generic
      // passthrough — drain whatever is there.
      else if (req.readableEnded === false && (req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined)) req.resume()
      const upstream = await fetch(`${server.url}${rest}${url.search}`, init)
      const responseHeaders: Record<string, string> = {
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'cache-control': upstream.headers.get('cache-control') ?? 'no-store',
      }
      for (const name of ['etag', 'last-modified', 'content-disposition', 'accept-ranges']) {
        const value = upstream.headers.get(name)
        if (value !== null) responseHeaders[name] = value
      }
      // Locked-down mode (auth.username configured) puts the TW frontend behind
      // HTTP Basic auth: without the challenge header the browser never prompts
      // and the embedded editor would just show a bare 401.
      const challenge = upstream.headers.get('www-authenticate')
      if (challenge !== null) responseHeaders['www-authenticate'] = challenge
      res.writeHead(upstream.status, responseHeaders)
      if (upstream.body === null) {
        res.end()
        return
      }
      // STREAM the body (not `arrayBuffer()`): fetching a large attachment
      // through /tw/files/… used to buffer the whole file in the DSH process
      // (v0.19.0). `content-length` is deliberately NOT forwarded — undici
      // decodes compressed responses, so the upstream length can be stale.
      const body = Readable.fromWeb(upstream.body as unknown as import('node:stream/web').ReadableStream)
      await new Promise<void>((resolveP, rejectP) => {
        body.on('error', rejectP)
        res.on('error', rejectP)
        res.on('close', () => {
          // Client hung up (aborted download / closed tab): stop pulling from the
          // TW child instead of draining it until the timeout.
          try { abort.abort() } catch { /* already aborted */ }
          try { body.destroy() } catch { /* already closed */ }
          resolveP()
        })
        res.on('finish', () => resolveP())
        body.pipe(res)
      })
    } catch (err) {
      if (res.headersSent) {
        res.end()
        return
      }
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 502)
    }
  }

  return { handleRender, handleApiProxy, handleTwProxy }
}

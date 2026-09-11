/**
 * Shared node:http helpers for the DSH webserver routes (routes.ts, admin.ts).
 *
 * One implementation of body reading + JSON response writing so the route
 * layers cannot drift (they previously carried two/three copies).
 *
 * @module dsh-tiddlywiki/host/http
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Default cap for small JSON bodies (note/restart/config…). */
export const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024

/** Cap for the /api passthrough body (tiddler content can be large). */
export const MAX_PROXY_BODY_BYTES = 16 * 1024 * 1024

/** Cap for uploaded file bodies (/tw proxy, /upload). */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

function readBodyStream(req: IncomingMessage, limit: number, encoding: true): Promise<string>
function readBodyStream(req: IncomingMessage, limit: number, encoding: false): Promise<Buffer>
function readBodyStream(req: IncomingMessage, limit: number, encoding: boolean): Promise<string | Buffer> {
  return new Promise((resolveP, rejectP) => {
    let size = 0
    let settled = false
    const chunks: Buffer[] = []
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      rejectP(err)
    }
    const succeed = (value: string | Buffer): void => {
      if (settled) return
      settled = true
      resolveP(value)
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        fail(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const buf = Buffer.concat(chunks)
      succeed(encoding ? buf.toString('utf8') : buf)
    })
    req.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
    // A caller that hangs up mid-body used to leave this promise pending
    // forever (the route handler never settled, and the socket was already
    // gone). `close` also fires after a normal `end`, hence the readableEnded
    // guard.
    req.on('aborted', () => fail(new Error('request aborted before the body was fully received')))
    req.on('close', () => {
      if (!req.readableEnded) fail(new Error('request closed before the body was read'))
    })
  })
}

/** Read a JSON (utf8) request body up to `limit` bytes (default MAX_JSON_BODY_BYTES). */
export function readBody(req: IncomingMessage, limit = MAX_JSON_BODY_BYTES): Promise<string> {
  return readBodyStream(req, limit, true)
}

/** Read a raw (binary-safe) request body up to `limit` bytes (default MAX_UPLOAD_BYTES). */
export function readBodyBuffer(req: IncomingMessage, limit = MAX_UPLOAD_BYTES): Promise<Buffer> {
  return readBodyStream(req, limit, false)
}

/** Write a JSON response (no-store, utf-8). */
export function json(res: ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/**
 * True when a NON-GET/HEAD/OPTIONS request is a cross-site (CSRF) request.
 *
 * Every legitimate caller of these routes is same-origin: the DSH GUI, the
 * embedded TW (served through the `/tw` proxy), and the TW-side "发送给 Agent"
 * button all run on the DSH origin. A page from another site can still fire a
 * simple request at a loopback/LAN-reachable DSH, and the browser tags it with
 * `Origin` / `Sec-Fetch-Site` — which is what we reject here.
 *
 * Only WRITES are checked: a cross-site navigation (Sec-Fetch-Site
 * `cross-site`) must still be able to open `/tw/` in a new tab, and cross-site
 * GETs cannot read the response (no CORS headers) so they cannot exfiltrate.
 * Requests that carry neither header (curl, server-to-server, old browsers)
 * are allowed on purpose: this is CSRF hardening, NOT an auth boundary — the
 * host's own auth is what protects a network-exposed DSH.
 */
export function isCrossSiteWrite(req: IncomingMessage): boolean {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false
  // Widen the header types explicitly: `IncomingHttpHeaders` types both as
  // `string | undefined`, so an Array.isArray() branch would otherwise be
  // narrowed to `never` (repeat headers are still possible at runtime).
  const siteHeader: string | string[] | undefined = req.headers['sec-fetch-site']
  const site = typeof siteHeader === 'string' ? siteHeader.toLowerCase() : Array.isArray(siteHeader) ? String(siteHeader[0] ?? '').toLowerCase() : ''
  if (site === 'cross-site') return true
  const originHeader: string | string[] | undefined = req.headers.origin
  const origin = typeof originHeader === 'string' ? originHeader : Array.isArray(originHeader) ? String(originHeader[0] ?? '') : ''
  if (origin.length === 0) return false
  if (origin === 'null') return true
  const host = req.headers.host
  if (typeof host !== 'string' || host.length === 0) return false
  try {
    return new URL(origin).host.toLowerCase() !== host.toLowerCase()
  } catch {
    return true
  }
}

/**
 * Guard for a route handler: enforces the expected HTTP method(s), then the
 * CSRF check for writes. Returns true after writing the error response — the
 * caller just does `if (rejectCrossSiteWrite(req, res, ['POST'])) return`.
 *
 * WHY the method check is mandatory (v0.19.0): the host webserver dispatches
 * routes by PATHNAME ONLY (dsh-host-webserver matches `rawPath` and calls the
 * handler, no method filter), and `isCrossSiteWrite` deliberately IGNORES
 * read methods. Together that meant `GET /dsh-tiddlywiki/sync` ran a
 * pull+commit+push, `GET /restart` restarted the TW child and `GET /upload`
 * wrote a file — all reachable from any web page with a bare
 * `<img src="http://127.0.0.1:3080/dsh-tiddlywiki/sync">`, since browsers send
 * no Origin/Sec-Fetch-Site that we would reject on a GET. Declaring the method
 * per route closes that class: a cross-site GET now gets 405 and no effect.
 *
 * @param allowedMethods when given, any other method → 405 (no side effect).
 */
export function rejectCrossSiteWrite(
  req: IncomingMessage,
  res: ServerResponse,
  allowedMethods?: readonly string[],
): boolean {
  const method = (req.method ?? 'GET').toUpperCase()
  if (allowedMethods !== undefined && !allowedMethods.includes(method)) {
    res.writeHead(405, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      allow: [...allowedMethods, 'OPTIONS'].join(', '),
    })
    res.end(JSON.stringify({ ok: false, error: `method not allowed: ${method}` }))
    return true
  }
  if (!isCrossSiteWrite(req)) return false
  json(res, { ok: false, error: 'cross-site request rejected' }, 403)
  return true
}

/** Read-only route guard: GET/HEAD only, no side effects on any other method. */
export function rejectNonRead(req: IncomingMessage, res: ServerResponse): boolean {
  return rejectCrossSiteWrite(req, res, ['GET', 'HEAD'])
}

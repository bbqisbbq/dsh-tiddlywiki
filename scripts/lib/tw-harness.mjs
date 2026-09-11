/**
 * Shared helpers for the verification scripts (v0.20.0).
 *
 * WHY: four scripts carried hand-copied versions of the same two helpers, and
 * they had already drifted (`waitFor` had three different default timeout/poll
 * pairs; the exact-then-longest-prefix route dispatcher was copy-pasted
 * verbatim into three mini HTTP servers). The dispatcher MUST mirror
 * `dsh-host-webserver` (exact match wins, otherwise the longest matching prefix
 * that is followed by `/` or the end of the path) — one copy keeps that honest.
 *
 * @module dsh-tiddlywiki/scripts/lib/tw-harness
 */
import { createServer } from 'node:http'

/**
 * Poll `cond` until it returns truthy (or a promise resolving truthy).
 * @param {() => unknown} cond
 * @param {number} timeoutMs
 * @param {number} stepMs
 * @returns {Promise<boolean>} false when the deadline passed first.
 */
export async function waitFor(cond, timeoutMs = 10_000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (await cond()) return true
    } catch {
      /* transient while the service starts up */
    }
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

/**
 * Pick the handler for `pathname` the way the host webserver does: an exact
 * registration wins, otherwise the longest PREFIX registration that matches
 * (`/a` matches `/a` and `/a/b` but not `/ab`).
 * @param {Array<{ kind: 'exact' | 'prefix', path: string, handler: Function }>} routes
 * @param {string} pathname
 * @returns {Function | undefined}
 */
export function matchRoute(routes, pathname) {
  const exact = routes.find((r) => r.kind === 'exact' && r.path === pathname)
  if (exact !== undefined) return exact.handler
  let best
  for (const r of routes) {
    if (r.kind !== 'prefix') continue
    if (pathname !== r.path && !pathname.startsWith(`${r.path}/`)) continue
    if (best === undefined || r.path.length > best.path.length) best = r
  }
  return best?.handler
}

/**
 * A real node:http server that drives captured route handlers over real
 * sockets (so tests observe status codes, headers and streaming behaviour, not
 * just handler return values). Returns `{ server, listen(), close() }` where
 * `listen()` resolves the loopback base URL.
 * @param {Array<{ kind: 'exact' | 'prefix', path: string, handler: Function }>} routes
 */
export function createRouteServer(routes) {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const handler = matchRoute(routes, pathname)
    if (handler === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    Promise.resolve(handler(req, res)).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(400)
        res.end(String(err))
      } else {
        res.destroy()
      }
    })
  })
  return {
    server,
    /** Bind to an ephemeral loopback port; resolves the base URL. */
    listen: () => new Promise((resolveP) => {
      server.listen(0, '127.0.0.1', () => resolveP(`http://127.0.0.1:${server.address().port}`))
    }),
    close: () => new Promise((resolveP) => server.close(resolveP)),
  }
}

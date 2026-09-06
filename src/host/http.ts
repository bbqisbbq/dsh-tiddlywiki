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
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        rejectP(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const buf = Buffer.concat(chunks)
      resolveP(encoding ? buf.toString('utf8') : buf)
    })
    req.on('error', rejectP)
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

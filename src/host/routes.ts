/**
 * DSH webserver routes for dsh-tiddlywiki (design doc §10).
 *
 * | route                     | method | purpose                                  |
 * |---------------------------|--------|------------------------------------------|
 * | /dsh-tiddlywiki/status    | GET    | panel health (service / url / git / tag) |
 * | /dsh-tiddlywiki/note      | POST   | quick-note → independent tiddler         |
 * | /dsh-tiddlywiki/restart   | POST   | one-click retry/restart of the TW child  |
 * | /dsh-tiddlywiki/api/*     | any    | passthrough to the TW service (JSON)     |
 *
 * Matching is exact-over-prefix, so the exact routes win and the `/api`
 * prefix catches the rest. Client calls are same-origin (the DSH web server),
 * so no CORS is involved.
 *
 * @module dsh-tiddlywiki/host/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, writeFile, access } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { TiddlyWebClient } from './tw-api.ts'
import type { WikiServer } from './wiki.ts'
import type { GitFace } from './git.ts'
import { PATH_PREFIX } from './wiki.ts'

export const ROUTE_PREFIX = PATH_PREFIX

/** Max JSON body for note/restart. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/** Max passthrough body (tiddler content can be large). */
const MAX_PROXY_BODY_BYTES = 16 * 1024 * 1024

/** Max uploaded file body. */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/** Tiddler type for quick-notes: Markdown, so the uploaded images/links and
 *  any Markdown in the note actually render in TW (a type-less tiddler is
 *  treated as plain wiki text and shows raw `![..]`/`[..]` instead). */
const NOTE_TYPE = 'text/markdown'

/** Structural webserver face (a subset of dsh-host-webserver). */
export interface WebServerFace {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
}

/** Effective UI visibility flags returned by /status (mirror index.ts). */
export interface UiDefaultsPublic {
  showQuickNote: boolean
  showPanelStatus: boolean
  showSyncButton: boolean
}

export interface RouteDeps {
  server: WikiServer
  getClient: () => TiddlyWebClient | undefined
  git: GitFace
  autoCommit: () => void
  noteDefaults: () => { tag: string }
  uiDefaults: () => UiDefaultsPublic
  getWikiPath: () => string
}

function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
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
    req.on('end', () => resolveP(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectP)
  })
}

/** Read a raw (binary-safe) request body up to `limit` bytes. */
function readBodyBuffer(req: IncomingMessage, limit = MAX_UPLOAD_BYTES): Promise<Buffer> {
  return new Promise((resolveP, rejectP) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        rejectP(new Error('file too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveP(Buffer.concat(chunks)))
    req.on('error', rejectP)
  })
}

/**
 * Sanitize an uploaded filename into a safe bare name (no path separators,
 * no `..`, no control characters). Returns '' when nothing usable remains.
 */
function sanitizeUploadName(input: unknown): string {
  if (typeof input !== 'string') return ''
  const name = basename(input.trim().replace(/[\\/]+/g, '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  if (name.length === 0 || name === '.' || name === '..') return ''
  if (name.length > 160) return name.slice(0, 160)
  return name
}

function json(res: ServerResponse, payload: unknown, status = 200): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Flat one-line snippet for the recent-notes picker. */
function snippetOf(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/** Default note title: `YYYY-MM-DD HH:mm` (design doc D6). */
function timestampTitle(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Open a tiddler in TW's NATIVE editor: save the tiddler (when text is
 * non-empty) as Markdown, reuse or create a DRAFT tiddler carrying
 * `draft.of`/`draft.title` (TW's story view renders drafts with the
 * EditTemplate — list.js: `isDraft && editTemplate`), and return the draft
 * title so the client can navigate the panel iframe to `#<draftTitle>`.
 * The draft carries the same `text/markdown` type as the note so saving it in
 * TW keeps Markdown (a draft without a matching type would overwrite the
 * note's type back to plain wiki text).
 */
export async function openInTwEditor(
  client: TiddlyWebClient,
  title: string,
  text: string,
  tags: string[],
): Promise<{ title: string; draftTitle: string }> {
  if (text.trim().length > 0) {
    await client.put({ title, text, tags, type: NOTE_TYPE })
  }
  // Draft content: the provided text, else the existing tiddler's content.
  let draftText = text
  if (draftText.trim().length === 0) {
    const existing = await client.get(title)
    draftText = existing?.text ?? ''
  }
  // Reuse an existing draft for this title (mirrors wiki.findDraft).
  let draftTitle: string | undefined
  try {
    const items = await client.list(undefined, true)
    for (const item of items) {
      if (item['draft.of'] === title && typeof item.title === 'string') {
        draftTitle = item.title
        break
      }
    }
  } catch {
    /* fall back to a fresh draft */
  }
  if (draftTitle === undefined) draftTitle = `Draft of "${title}" ${Date.now()}`
  await client.put({ title: draftTitle, text: draftText, 'draft.of': title, 'draft.title': title, type: NOTE_TYPE })
  return { title, draftTitle }
}

/** Resolve note tags from the request body: `tags` array wins, then the
 *  legacy single `tag` string, then the configured default tag. */
function resolveTags(
  body: { tag?: unknown; tags?: unknown },
  defaultTag: string,
): string[] {
  if (Array.isArray(body.tags)) {
    const tags = body.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim())
    if (tags.length > 0) return tags
  }
  if (typeof body.tag === 'string' && body.tag.trim().length > 0) {
    return body.tag.trim().split(/\s+/).filter(Boolean)
  }
  return [defaultTag]
}

export function registerRoutes(ctx: { webServer: WebServerFace }, deps: RouteDeps): () => void {
  const handleStatus = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const view = deps.server.status()
    let gitSummary: GitStatusViewPublic | null = null
    try {
      gitSummary = await deps.git.status(deps.getWikiPath())
    } catch {
      gitSummary = null
    }
    json(res, { ok: true, ...view, git: gitSummary, note: { tag: deps.noteDefaults().tag }, ui: deps.uiDefaults() })
  }

  const handleNote = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const body = JSON.parse(await readBody(req)) as { title?: unknown; tag?: unknown; tags?: unknown; text?: unknown }
      const text = typeof body.text === 'string' && body.text.trim().length > 0 ? body.text.trim() : null
      if (text === null) {
        json(res, { ok: false, error: 'text is required' }, 400)
        return
      }
      const client = deps.getClient()
      if (client === undefined) {
        json(res, { ok: false, error: 'wiki service is not running' }, 503)
        return
      }
      const title = typeof body.title === 'string' && body.title.trim().length > 0 ? body.title.trim() : timestampTitle()
      const tags = resolveTags(body, deps.noteDefaults().tag)
      await client.put({ title, text, tags, type: NOTE_TYPE })
      deps.autoCommit()
      json(res, { ok: true, title, tag: tags.join(' '), tags, text, type: NOTE_TYPE })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }

  const handleEdit = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const body = JSON.parse(await readBody(req)) as { title?: unknown; tag?: unknown; tags?: unknown; text?: unknown }
      const client = deps.getClient()
      if (client === undefined) {
        json(res, { ok: false, error: 'wiki service is not running' }, 503)
        return
      }
      const title = typeof body.title === 'string' && body.title.trim().length > 0 ? body.title.trim() : timestampTitle()
      const tags = resolveTags(body, deps.noteDefaults().tag)
      const text = typeof body.text === 'string' ? body.text : ''
      const result = await openInTwEditor(client, title, text, tags)
      deps.autoCommit()
      json(res, { ok: true, ...result, twUrl: deps.server.url })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }

  /** Distinct non-system tags for the quick-note tag autocomplete. */
  const handleTags = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const client = deps.getClient()
    if (client === undefined) {
      json(res, { ok: false, error: 'wiki service is not running' }, 503)
      return
    }
    try {
      const items = await client.list(undefined, false)
      const tags = new Set<string>()
      for (const item of items) {
        for (const tag of item.tags ?? []) {
          if (tag.length > 0 && !tag.startsWith('$:/')) tags.add(tag)
        }
      }
      json(res, { ok: true, tags: [...tags].sort((a, b) => a.localeCompare(b, 'zh')) })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }

  /** Recent non-system tiddlers for the quick-note "最近" picker (newest first). */
  const handleRecent = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const client = deps.getClient()
    if (client === undefined) {
      json(res, { ok: false, error: 'wiki service is not running' }, 503)
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const limitRaw = Number(url.searchParams.get('limit') ?? 15)
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.floor(limitRaw), 200)) : 15
      const items = await client.recent(limit)
      json(res, {
        ok: true,
        limit,
        items: items.map((t) => ({
          title: t.title,
          tags: t.tags ?? [],
          modified: typeof t.modified === 'string' ? t.modified : null,
          snippet: snippetOf(t.text ?? ''),
        })),
      })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }

  /** Full tiddler for the quick-note "最近" picker (load into the editor). */
  const handleGet = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const client = deps.getClient()
    if (client === undefined) {
      json(res, { ok: false, error: 'wiki service is not running' }, 503)
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const title = url.searchParams.get('title') ?? ''
      if (title.length === 0) {
        json(res, { ok: false, error: 'missing title' }, 400)
        return
      }
      const t = await client.get(title)
      if (t === undefined) {
        json(res, { ok: false, notFound: true, title }, 404)
        return
      }
      const fields: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(t)) {
        if (k === 'title' || k === 'text' || k === 'tags') continue
        fields[k] = v
      }
      json(res, { ok: true, title: t.title, text: t.text ?? '', tags: t.tags ?? [], type: t.type ?? 'text/vnd.tiddlywiki', fields })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }

  const handleRestart = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await deps.server.restart()
      json(res, { ok: true, status: deps.server.status().status })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }

  /** One-click git sync for the floating button / settings page: pull →
   *  commit → push, then return the fresh status. Mirrors the agent tool's
   *  `action=sync` (design doc §7 conflict policy — rebase conflict aborts).
   *  When the pull actually changed the working tree, the running TW child
   *  still holds the old in-memory snapshot — restart it (same port) so the
   *  UI reflects the pulled files instead of looking stale. */
  const handleSync = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const dir = deps.getWikiPath()
    const status = async (): Promise<GitStatusViewPublic | null> => {
      try { return await deps.git.status(dir) } catch { return null }
    }
    try {
      const pulled = await deps.git.pull(dir)
      if (!pulled.ok) {
        json(res, {
          ok: false,
          action: 'sync',
          message: pulled.message,
          ...(pulled.conflictFiles !== undefined ? { conflictFiles: pulled.conflictFiles } : {}),
          status: await status(),
        }, 409)
        return
      }
      let restarted = false
      let restartError: string | undefined
      if (pulled.changed === true) {
        try {
          await deps.server.restart()
          restarted = true
        } catch (err) {
          restartError = err instanceof Error ? err.message : String(err)
        }
      }
      const committed = await deps.git.commit(dir, `sync ${new Date().toISOString()}`)
      const pushed = await deps.git.push(dir)
      const fresh = await status()
      json(res, {
        ok: pushed.ok,
        action: 'sync',
        message: pushed.ok ? '同步完成' : pushed.message,
        pull: 'ok',
        ...(pulled.changed === true ? { changed: true } : {}),
        restarted,
        ...(restartError !== undefined ? { restartError } : {}),
        commit: committed.message,
        push: pushed.message,
        status: fresh,
        lastSync: new Date().toISOString(),
      }, pushed.ok ? 200 : 502)
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }

  /**
   * Save an uploaded file into the wiki's `files/` folder (git-tracked; TW's
   * core server serves it at `/files/<name>`, get-file.js — no restart
   * needed). Body is the raw file; the name arrives in `X-Filename`. A
   * collision appends `-1`, `-2`, … so nothing is ever overwritten.
   */
  const handleUpload = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const buf = await readBodyBuffer(req)
      // Name comes from ?name= (URL-encoded) or the X-Filename header.
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const nameParam = url.searchParams.get('name')
      let name = sanitizeUploadName(nameParam ?? '')
      if (name.length === 0 && typeof req.headers['x-filename'] === 'string') {
        let decoded = ''
        try { decoded = decodeURIComponent(req.headers['x-filename'] as string) } catch { decoded = req.headers['x-filename'] as string }
        name = sanitizeUploadName(decoded)
      }
      if (name.length === 0) {
        json(res, { ok: false, error: 'missing or invalid filename' }, 400)
        return
      }
      const filesDir = join(deps.getWikiPath(), 'files')
      await mkdir(filesDir, { recursive: true })
      const ext = extname(name)
      const stem = ext.length > 0 ? name.slice(0, -ext.length) : name
      // Collision avoidance: files/some.txt, files/some-1.txt, …
      let candidate = name
      for (let i = 1; ; i++) {
        try { await access(join(filesDir, candidate)) } catch { break }
        candidate = `${stem}-${i}${ext}`
      }
      await writeFile(join(filesDir, candidate), buf)
      deps.autoCommit()
      json(res, {
        ok: true,
        name: candidate,
        path: `files/${candidate}`,
        url: `/files/${encodeURIComponent(candidate)}`,
        size: buf.length,
        type: req.headers['content-type'] ?? 'application/octet-stream',
      })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, err instanceof Error && /too large/.test(err.message) ? 413 : 500)
    }
  }

  /** Passthrough /dsh-tiddlywiki/api/<rest> → TW root /<rest>. */
  const handleApiProxy = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const client = deps.getClient()
    if (client === undefined) {
      json(res, { ok: false, error: 'wiki service is not running' }, 503)
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const rest = url.pathname.replace(/^\/dsh-tiddlywiki\/api/, '') || '/'
    try {
      const headers: Record<string, string> = {}
      const ct = req.headers['content-type']
      if (typeof ct === 'string') headers['content-type'] = ct
      const method = (req.method ?? 'GET').toUpperCase()
      // TW's CSRF gate requires X-Requested-With on writes; forward it through.
      if (method === 'PUT' || method === 'DELETE' || method === 'POST') headers['x-requested-with'] = 'TiddlyWiki'
      const init: RequestInit = { method, headers, signal: AbortSignal.timeout(15_000) }
      if (method === 'PUT' || method === 'POST') init.body = await readBody(req, MAX_PROXY_BODY_BYTES)
      const upstream = await fetch(`${deps.server.url}${rest}${url.search}`, init)
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

  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/status`, handler: (req, res) => { void handleStatus(req, res) } }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/note`, handler: (req, res) => { void handleNote(req, res) } }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/edit`, handler: (req, res) => { void handleEdit(req, res) } }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/tags`, handler: (req, res) => { void handleTags(req, res) } }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/recent`, handler: (req, res) => { void handleRecent(req, res) } }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/get`, handler: (req, res) => { void handleGet(req, res) } }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/sync`, handler: (req, res) => { void handleSync(req, res) } }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/upload`, handler: (req, res) => { void handleUpload(req, res) } }),
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/restart`, handler: (req, res) => { void handleRestart(req, res) } }),
    ctx.webServer.register({ kind: 'prefix', path: `${ROUTE_PREFIX}/api`, handler: (req, res) => { void handleApiProxy(req, res) } }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** Public shape of the git status summary sent to the panel. */
export interface GitStatusViewPublic {
  exists: boolean
  branch: string
  dirty: boolean
  dirtyFiles: string[]
  remote: string
  lastCommit?: string
  ahead?: number
  behind?: number
}

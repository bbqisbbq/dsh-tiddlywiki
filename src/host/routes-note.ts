/**
 * 笔记读写 routes (v0.30.10): `/note` `/tags` `/recent` `/get` `/search` `/upload`.
 *
 * **纯搬迁 + 工厂化**（函数体除一处缺陷修复外一字未改）：这六个 handler 原来住在
 * `registerRoutes()` 的闭包里，抽出来时把**真正用到的 deps 成员**用 `Pick<RouteDeps, …>`
 * 写清楚，闭包 helper（`refuseStoppedTarget` / `notRunning` / `invalidateGitStatus`）
 * 由参数传入 —— `import type` 只在类型期存在，运行时无环。
 *
 * **顺手修掉的真缺陷（v0.30.10，多库）**：`/upload` 回给客户端的 `url` 原来是
 * `${TW_PROXY_PATH}files/<name>` —— 那是**裸路径**（等于默认库）。多库安装里，往
 * 「书籍库」上传图片拿到的链接会指到**默认库**的 `/files/`：图裂，或者更糟 ——
 * 指向另一个库里同名的文件。现在走 `uploadBase(req)`：多库给 `/tw/<id>/`，单库保持
 * 原来的裸路径（老安装一个字节都不变）。
 *
 * @module dsh-tiddlywiki/host/routes-note
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { errorStatus, json, readBody, readBodyBuffer, rejectCrossSiteWrite, rejectNonRead } from './http.ts'
import { proxyBaseFor } from './wiki.ts'
import { WORKSPACE_TAG_PREFIX } from './workspace.ts'
import type { Tiddler } from './tw-api.ts'
import { isBinaryType, toIsoDateString } from './tw-api.ts'
import { assertNoConflict, buildWriteTiddler, flattenTiddlerFields, WriteConflictError } from './write-policy.ts'
import { snippetOf } from './text-util.ts'
import { isBlockedProxyTitle } from './routes-tw-proxy.ts'
import {
  DANGEROUS_UPLOAD_EXTENSIONS,
  MAX_TAGS_LIMIT,
  NOTE_TYPE,
  conflictTokens,
  readLimit,
  readOptionalLimit,
  resolveTags,
  sanitizeUploadName,
  timestampTitle,
} from './routes-helpers.ts'
import type { RouteDeps } from './routes.ts'

/** 这六个 handler 真正用到的 deps 成员（不是整个 RouteDeps）。 */
export type NoteRouteDeps = Pick<
  RouteDeps,
  'autoCommit' | 'getClient' | 'getWikiPath' | 'noteDefaults' | 'server' | 'serverById' | 'wikiIds' | 'wikiSummaries'
>

/** 闭包 helper：路由层共享的「拒绝未运行/已停止的库」判定。 */
export interface NoteRouteHelpers {
  refuseStoppedTarget: (req: IncomingMessage, res: ServerResponse) => boolean
  notRunning: (req: IncomingMessage) => string
  invalidateGitStatus: () => void
}

export function createNoteRoutes(deps: NoteRouteDeps, helpers: NoteRouteHelpers) {
  const { refuseStoppedTarget, notRunning, invalidateGitStatus } = helpers

  /**
   * The same-origin base an uploaded file's URL must use for THIS request's wiki
   * (v0.30.10). Single mode keeps the legacy bare `/dsh-tiddlywiki/tw/files/…`
   * (byte-identical to before); multi mode prefixes `/tw/<id>/`, so an image
   * uploaded into the 书籍库 links to the 书籍库 instead of the default wiki.
   */
  const uploadBase = (req: IncomingMessage): string => {
    const farm = deps.wikiSummaries(req)
    const asked = (new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('wiki') ?? '').trim()
    const known = farm.items.some((item) => item.id === asked)
    const id = known ? asked : farm.defaultId
    return proxyBaseFor(farm.mode === 'multi' ? 'multi' : 'single', id)
  }
  const handleNote = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      const body = JSON.parse(await readBody(req)) as { title?: unknown; tag?: unknown; tags?: unknown; text?: unknown; expectedModified?: unknown; expectedRevision?: unknown; force?: unknown }
      const text = typeof body.text === 'string' && body.text.trim().length > 0 ? body.text.trim() : null
      if (text === null) {
        json(res, { ok: false, error: 'text is required' }, 400)
        return
      }
      const client = deps.getClient(req)
      if (client === undefined) {
        json(res, { ok: false, error: notRunning(req) }, 503)
        return
      }
      const title = typeof body.title === 'string' && body.title.trim().length > 0 ? body.title.trim() : timestampTitle()
      // System tiddlers ($:/…) are TW internals (theme, config, plugins): the
      // quick-note route is a user path and must not let a request overwrite
      // them. Use the editor / admin surface for that (v0.19.0).
      if (title.startsWith('$:/')) {
        json(res, { ok: false, error: 'title must not be a system tiddler ($:/…)' }, 400)
        return
      }
      const tags = resolveTags(body)
      // PRESERVE, do not blind-replace (v0.19.1): read first (404 = new note,
      // any other failure propagates), keep the existing tags/custom fields
      // unless the body explicitly provides them, and honour the optimistic
      // concurrency tokens the quick-note card sends for a note it loaded.
      const existing = await client.get(title)
      assertNoConflict(title, existing, conflictTokens(body))
      const { tiddler } = buildWriteTiddler(title, text, {
        existing,
        tags,
        defaultTags: [deps.noteDefaults(req).tag],
        agentTag: false,
      })
      await client.put(tiddler)
      deps.autoCommit(req)
      invalidateGitStatus()
      const finalTags = tiddler.tags ?? []
      json(res, { ok: true, title, tag: finalTags.join(' '), tags: finalTags, text, type: typeof tiddler.type === 'string' ? tiddler.type : NOTE_TYPE })
    } catch (err) {
      if (err instanceof WriteConflictError) {
        json(res, { ok: false, error: err.message, conflict: true }, 409)
        return
      }
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  const handleTags = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (rejectNonRead(req, res)) return
    const client = deps.getClient(req)
    if (client === undefined) {
      json(res, { ok: false, error: notRunning(req) }, 503)
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const limit = readOptionalLimit(url, MAX_TAGS_LIMIT)
      const byCount = (url.searchParams.get('sort') ?? 'alpha') === 'count'
      // Text-bearing tiddlers only (server-side filter) — the same counting the
      // `tiddlywiki_list_tags` tool uses, so the card and the model agree.
      const { total, tags: all } = await client.tagStats()
      const ordered = byCount ? all : [...all].sort((a, b) => a.tag.localeCompare(b.tag, 'zh'))
      const picked = limit === undefined ? ordered : ordered.slice(0, limit)
      json(res, {
        ok: true,
        tags: picked.map((t) => t.tag),
        items: picked,
        total,
        truncated: picked.length < total,
      })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  /** Recent non-system tiddlers for the quick-note "最近" picker (newest first). */

  const handleRecent = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (rejectNonRead(req, res)) return
    const client = deps.getClient(req)
    if (client === undefined) {
      json(res, { ok: false, error: notRunning(req) }, 503)
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const limit = readLimit(url, 15)
      // `since` must be forwarded and echoed (v0.22.8): the tool
      // (`wiki.recent(limit, since)`) and the reply-stream card both send it, so
      // dropping it here listed UNFILTERED recents for a filtered request — the
      // same route/tool drift that was fixed for /search in v0.20.0.
      const since = url.searchParams.get('since') ?? undefined
      const items = await client.recent(limit, since)
      json(res, {
        ok: true,
        limit,
        since: since ?? null,
        items: items.map((t) => ({
          title: t.title,
          tags: t.tags ?? [],
          modified: toIsoDateString(t.modified),
          snippet: snippetOf(t.text ?? '', 120),
        })),
      })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  /** Full tiddler for the quick-note "最近" picker (load into the editor). */

  const handleGet = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (rejectNonRead(req, res)) return
    const client = deps.getClient(req)
    if (client === undefined) {
      json(res, { ok: false, error: notRunning(req) }, 503)
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const title = url.searchParams.get('title') ?? ''
      if (title.length === 0) {
        json(res, { ok: false, error: 'missing title' }, 400)
        return
      }
      // The plugin's own config tiddler can carry shared tokens (bridge.token /
      // sendToAgent.token) and this route is unauthenticated: serve the note
      // picker but never the plugin's secret-bearing config (v0.19.0).
      //
      // Uses the SHARED predicate (v0.22.8): this was a second copy of the
      // literal, so adding another secret namespace to
      // BLOCKED_PROXY_TITLE_PREFIXES would have silently left /get exposed.
      if (isBlockedProxyTitle(title)) {
        json(res, { ok: false, error: 'system tiddler not exposed' }, 403)
        return
      }
      const t = await client.get(title)
      if (t === undefined) {
        json(res, { ok: false, notFound: true, title }, 404)
        return
      }
      // Custom fields are FLATTENED (v0.19.1): a single-tiddler GET nests every
      // non-known field under `fields`, so the old copy-top-level loop shipped
      // `fields: {fields: {q: …}}` — consumers could never read `q`/`due`/
      // `clip-url`. `revision` is surfaced explicitly as the concurrency token
      // the quick-note card echoes back on save.
      const binary = isBinaryType(typeof t.type === 'string' ? t.type : undefined)
      json(res, {
        ok: true,
        title: t.title,
        // Binary attachments carry base64 in `text`: never ship 20MB to the
        // note picker (it only needs metadata) — same rule as tiddlywiki_get.
        text: binary ? '' : (t.text ?? ''),
        binary,
        binaryChars: binary ? (t.text ?? '').length : undefined,
        tags: t.tags ?? [],
        type: t.type ?? 'text/vnd.tiddlywiki',
        modified: toIsoDateString(t.modified),
        revision: t.revision ?? null,
        fields: flattenTiddlerFields(t),
      })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  /**
   * GET /dsh-tiddlywiki/search — keyword search for the reply-stream tool card
   * (mirrors tools.ts tiddlywiki_search: same local substring/tag/since/type
   * matching via the TiddlyWebClient). Returns hit titles/tags/modified/
   * snippets so the card can list clickable wiki links.
   */

  const handleSearch = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (rejectNonRead(req, res)) return
    const client = deps.getClient(req)
    if (client === undefined) {
      json(res, { ok: false, error: notRunning(req) }, 503)
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const query = url.searchParams.get('query') ?? ''
      const tags = url.searchParams.getAll('tags').filter((t) => t.length > 0)
      const tag = url.searchParams.get('tag') ?? undefined
      const since = url.searchParams.get('since') ?? undefined
      const type = url.searchParams.get('type') ?? undefined
      // Custom-field filter (v0.20.0): the agent tool has always accepted
      // field/value, and the reply-stream card echoes the tool's arguments —
      // without these params the card listed UNFILTERED hits, contradicting the
      // model-visible result.
      const field = url.searchParams.get('field') ?? undefined
      const value = url.searchParams.get('value') ?? undefined
      const limit = readLimit(url, 30)
      // Workspace scope (v0.25.0): `tiddlywiki_search` narrows to the session's
      // workspace and widens only when that finds nothing, but this route did not
      // — so the reply-stream card could list a DIFFERENT (larger) result set than
      // the model saw, with no hint about the scope. The card now echoes the
      // scope it read out of the model-visible receipt (`workspace=<id>`), and we
      // mirror the tool's rules: an explicit tag/field filter is already a scope,
      // so it is never second-guessed.
      const rawWorkspace = url.searchParams.get('workspace') ?? ''
      const workspace = /^[A-Za-z0-9\u4e00-\u9fa5._-]{1,80}$/.test(rawWorkspace) ? rawWorkspace : ''
      const explicitScope = tags.length > 0 || tag !== undefined || field !== undefined || value !== undefined
      const narrowTag = workspace.length > 0 && !explicitScope ? `${WORKSPACE_TAG_PREFIX}${workspace}` : ''
      const narrowed = narrowTag.length > 0
        ? await client.search(query, { tags: [narrowTag], tag, since, type, field, value, limit })
        : undefined
      const usedWorkspace = narrowed !== undefined && narrowed.total > 0
      const { items, total } = usedWorkspace ? narrowed as { items: Tiddler[]; total: number } : await client.search(query, { tags, tag, since, type, field, value, limit })
      json(res, {
        ok: true,
        query,
        tags,
        tag: tag ?? null,
        since: since ?? null,
        type: type ?? null,
        field: field ?? null,
        value: value ?? null,
        limit,
        total,
        workspace: workspace.length > 0 ? workspace : null,
        scope: usedWorkspace ? 'workspace' : 'all',
        fellBack: narrowTag.length > 0 && !usedWorkspace,
        items: items.map((t) => ({
          title: t.title,
          tags: t.tags ?? [],
          modified: toIsoDateString(t.modified),
          snippet: snippetOf(t.text ?? '', 120),
        })),
      })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  const handleUpload = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      if (refuseStoppedTarget(req, res)) return
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
      // Refuse files the browser would EXECUTE on the DSH origin: `/files/*` is
      // served back through the same-origin `/tw` proxy, so an uploaded .html /
      // .svg would be same-origin script with access to the admin routes.
      const extension = extname(name).toLowerCase()
      if (DANGEROUS_UPLOAD_EXTENSIONS.has(extension)) {
        json(res, { ok: false, error: `不允许上传可执行/可脚本化的文件类型：${extension}` }, 400)
        return
      }
      const filesDir = join(deps.getWikiPath(req), 'files')
      await mkdir(filesDir, { recursive: true })
      // Collision avoidance with an ATOMIC create (v0.19.3): the old code did
      // `access(candidate)` then `writeFile(candidate)`, so (a) any access error
      // (EACCES/EBUSY, not just ENOENT) was read as "name free" and (b) two
      // concurrent uploads could both pick the same name and one silently
      // replaced the other — contradicting the route's own "nothing is ever
      // overwritten" contract. `flag: 'wx'` fails with EEXIST instead, and we
      // walk the suffix chain on that error only. Bounded, so a pathological
      // directory cannot spin this loop forever.
      const ext = extname(name)
      const stem = ext.length > 0 ? name.slice(0, -ext.length) : name
      let candidate = ''
      let wrote = false
      for (let i = 0; i <= 10_000 && !wrote; i++) {
        candidate = i === 0 ? name : `${stem}-${i}${ext}`
        try {
          await writeFile(join(filesDir, candidate), buf, { flag: 'wx' })
          wrote = true
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        }
      }
      if (!wrote) {
        json(res, { ok: false, error: '同名文件过多，请换一个文件名' }, 409)
        return
      }
      deps.autoCommit(req)
      invalidateGitStatus()
      json(res, {
        ok: true,
        name: candidate,
        path: `files/${candidate}`,
        // Same-origin proxy URL: the embedded TW editor resolves image links
        // against the DSH origin, so a root-absolute `/files/...` would miss.
        url: `${uploadBase(req)}files/${encodeURIComponent(candidate)}`,
        size: buf.length,
        type: req.headers['content-type'] ?? 'application/octet-stream',
      })
    } catch (err) {
      // Same mapping as every other route (v0.19.5): the old bespoke `/too
      // large/i` test disagreed with `errorStatus`'s `/body too large/i`, so the
      // 413 was decided by whichever wording the thrown error happened to use.
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }

  // The three TW-facing routes (`/render`, `/api/*`, `/tw/*`) live in
  // routes-tw-proxy.ts (v0.28.8): they are the only handlers that apply the
  // blocked-title predicates before anything reaches the loopback TW child, so
  // they belong next to those predicates rather than in the middle of this file.
  return { handleGet, handleNote, handleRecent, handleSearch, handleTags, handleUpload }
}
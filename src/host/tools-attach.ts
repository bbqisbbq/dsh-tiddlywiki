/**
 * `tiddlywiki_attach` — the only way an agent can write a binary attachment.
 *
 * Split out of `tools.ts` in v0.28.8 — pure code move, body unchanged.
 *
 * @module dsh-tiddlywiki/host/tools-attach
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import { defineTool } from '../sdk.ts'
import { isBinaryType } from './tw-api.ts'
import { downloadClipImage } from './clip-bridge.ts'
import { assertNoConflict, buildWriteTiddler } from './write-policy.ts'
import { MAX_ATTACH_BYTES, sessionIdOf } from './tools-support.ts'
import type { AttachResult, ToolEnv } from './tools-support.ts'

/** Mime types offered by `tiddlywiki_attach` for local files. */
const ATTACH_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
  ico: 'image/x-icon', pdf: 'application/pdf', zip: 'application/zip',
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4',
  epub: 'application/epub+zip',
}

export function attachTool(env: ToolEnv) {
  const { deps, requireWiki } = env
  // ── tiddlywiki_attach ────────────────────────────────────────────────────
  return defineTool({
    name: 'tiddlywiki_attach',
    description: '把一个本机文件或公网 http(s) 地址存成 wiki 的二进制附件 tiddler（图片 / PDF / 压缩包等，type + base64 正文，随 wiki 进 git）。可选把附件嵌入/链接进某篇笔记。**同名已有条目默认拒绝写入**（避免静默覆盖既有笔记；确认要覆盖才传 `force: true`，tags 与自定义字段仍会保留）。这是 agent 唯一能写入二进制附件的途径。',
    parameters: {
      title: { type: 'string', description: '附件 tiddler 标题（同时决定其在 wiki 里的名字）', required: true },
      path: { type: 'string', description: '本机绝对路径（与 url 二选一）' },
      url: { type: 'string', description: '公网 http(s) 地址（与 path 二选一；含 SSRF 守卫，拒绝内网/回环地址）' },
      tags: { type: 'array', items: { type: 'string' }, description: '可选：附件标签' },
      noteTitle: { type: 'string', description: '可选：把该附件嵌入到这篇笔记末尾（图片用 [img[标题]]，其它用 [[标题]] 链接）' },
      expectedModified: { type: 'string', description: '可选：乐观并发保护，仅在同名 tiddler 已存在时有意义（传 tiddlywiki_get 读到的 modified）' },
      expectedRevision: { type: 'integer', description: '可选：乐观并发保护的另一种令牌——传 tiddlywiki_get 返回字段里的 revision' },
      force: { type: 'boolean', description: '可选：true 时忽略 expectedModified/expectedRevision，允许覆盖同名 tiddler（默认 false；即便覆盖也会保留其 tags 与自定义字段）' },
    },
    output: {
      render: (_args, value: AttachResult) => {
        const lines = [`已保存附件「${value.title}」（${value.mime}，${value.bytes} 字节，base64 约 ${value.chars} 字符）`]
        if (value.source !== null) lines.push(`来源: ${value.source}`)
        if (value.embedInto !== null) lines.push(`已嵌入笔记「${value.embedInto}」`)
        lines.push(`打开: [${value.title}](/dsh-tiddlywiki/tw/#${encodeURIComponent(value.title)})`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { title: string; path?: string; url?: string; tags?: string[]; noteTitle?: string; expectedModified?: string; expectedRevision?: number; force?: boolean }, exec: unknown): Promise<AttachResult> => {
      const wiki = requireWiki(sessionIdOf(exec))
      const title = args.title.trim()
      if (title.length === 0) throw new Error('tiddlywiki_attach: title 不能为空')
      const hasPath = typeof args.path === 'string' && args.path.trim().length > 0
      const hasUrl = typeof args.url === 'string' && args.url.trim().length > 0
      if (hasPath === hasUrl) throw new Error('tiddlywiki_attach: path 与 url 必须且只能提供一个')
      let buffer: Buffer
      let mime: string
      let source: string
      if (hasPath) {
        const filePath = (args.path as string).trim()
        // Absolute only: a relative path would resolve against the DSH process
        // cwd, which is not something the model can reason about.
        if (!isAbsolute(filePath)) throw new Error('tiddlywiki_attach: path 必须是绝对路径')
        const info = await stat(filePath)
        if (!info.isFile()) throw new Error(`tiddlywiki_attach: ${basename(filePath)} 不是普通文件`)
        if (info.size > MAX_ATTACH_BYTES) throw new Error(`tiddlywiki_attach: 文件超过 ${Math.floor(MAX_ATTACH_BYTES / 1024 / 1024)}MB 上限`)
        buffer = await readFile(filePath)
        const ext = extname(filePath).slice(1).toLowerCase()
        mime = ATTACH_MIME_BY_EXT[ext] ?? 'application/octet-stream'
        source = filePath
      } else {
        const imageUrl = (args.url as string).trim()
        const downloaded = await downloadClipImage(imageUrl, '')
        buffer = downloaded.buffer
        const ext = extname(new URL(imageUrl).pathname).slice(1).toLowerCase()
        mime = downloaded.type?.split(';')[0]?.trim() || ATTACH_MIME_BY_EXT[ext] || 'application/octet-stream'
        source = imageUrl
      }
      if (buffer.length === 0) throw new Error('tiddlywiki_attach: 内容为空')
      if (buffer.length > MAX_ATTACH_BYTES) throw new Error(`tiddlywiki_attach: 内容超过 ${Math.floor(MAX_ATTACH_BYTES / 1024 / 1024)}MB 上限`)
      // DATA SAFETY (v0.19.5): this used to `wiki.put({title, type, text})` with
      // no read at all — attaching an image whose title collided with an existing
      // note silently replaced that note (tags, custom fields and body all gone),
      // the exact class the write policy exists to prevent. It also never added
      // the `agent-written` tag every other creating tool adds. Read first (404 =
      // new tiddler; any other failure propagates), then build the PUT from the
      // existing tiddler so a same-named note keeps everything but its body.
      const existing = await wiki.get(title)
      assertNoConflict(title, existing, {
        expectedModified: args.expectedModified,
        expectedRevision: args.expectedRevision,
        force: args.force,
      })
      // An attachment sharing a title with an existing tiddler is almost always
      // a mistake (the old code silently destroyed the note). Require explicit
      // consent: a concurrency token (the caller proved it read the tiddler) or
      // `force: true`. `expectedRevision`/`expectedModified` alone does NOT
      // consent to an overwrite — `assertNoConflict` above only rejects when the
      // tiddler changed since that token, so a stale-but-matching token would
      // still wipe the body.
      if (existing !== undefined && args.force !== true) {
        throw new Error(
          `tiddlywiki_attach: 标题「${title}」已存在（type=${typeof existing.type === 'string' ? existing.type : '?'}）。`
          + '为避免静默覆盖既有笔记，请换一个附件标题；确认要覆盖时传 force: true（tags 与自定义字段仍会保留）。',
        )
      }
      const explicitTags = Array.isArray(args.tags)
        ? args.tags.filter((t) => typeof t === 'string' && t.trim().length > 0)
        : undefined
      const { tiddler } = buildWriteTiddler(title, buffer.toString('base64'), {
        existing,
        ...(explicitTags !== undefined && explicitTags.length > 0 ? { tags: explicitTags } : {}),
        fields: {
          type: mime,
          'attach-source': source,
          'attach-at': new Date().toISOString(),
        },
      })
      await wiki.put(tiddler)
      let embedInto: string | null = null
      if (typeof args.noteTitle === 'string' && args.noteTitle.trim().length > 0) {
        embedInto = args.noteTitle.trim()
        const note = await wiki.get(embedInto)
        // A binary tiddler holds base64 in `text`: appending an embed line would
        // corrupt it (and `type: image/png` would stay, so the receipt would look
        // fine). Same class `tiddlywiki_put` refuses — refuse here too (v0.25.0).
        if (note !== undefined && isBinaryType(typeof note.type === 'string' ? note.type : undefined)) {
          throw new Error(
            `tiddlywiki_attach: noteTitle「${embedInto}」是二进制附件（type=${String(note.type)}），`
            + '把嵌入链接写进去会写坏附件；请改用普通笔记，或去掉 noteTitle 参数单独保存附件。',
          )
        }
        // `[img[Title]]` breaks if the attachment title itself contains `]]`;
        // fall back to a plain link (which has the same constraint, so strip the
        // sequence) instead of silently producing a broken embed.
        const safeTitle = title.replace(/\]\]/g, '] ]')
        const embed = mime.startsWith('image/') ? `[img[${safeTitle}]]` : `[[${safeTitle}]]`
        const text = note === undefined ? embed : `${(note.text ?? '').replace(/\s+$/, '')}\n\n${embed}`
        // Same read-modify-write policy as everywhere else: preserve the note's
        // tags/custom fields/type, only append the embed.
        const { tiddler: noteTiddler } = buildWriteTiddler(embedInto, text, { existing: note })
        await wiki.put(noteTiddler)
      }
      deps.autoCommit()
      return { ok: true, title, mime, bytes: buffer.length, chars: buffer.toString('base64').length, source, embedInto }
    },
  })
}

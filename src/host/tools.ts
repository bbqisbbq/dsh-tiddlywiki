/**
 * The `tiddlywiki_*` agent tools (design doc §11, D8) plus the extension
 * point: `registerTiddlywikiTools(ctx, deps)` registers tools list-style, so a
 * new tool is just one more `defineTool` in the array — index.ts never changes.
 *
 * Toolset (v0.19):
 *   search / get / put / batch_put / append / rename / delete / trash /
 *   backlinks / attach / lint / recent / list_tags / git_sync / git_resolve
 *
 * RENDER CONTRACT (design doc §4.3): the registry feeds `output.render(args,
 * value)` into the loop — the model sees ONLY the rendered text, never the raw
 * JSON `value`. Every render must carry the complete facts an agent needs to
 * act (titles, tags, snippets, git state); a terse UI summary starves it.
 *
 * @module dsh-tiddlywiki/host/tools
 */
import { defineTool } from '../sdk.ts'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { MISSING_TYPE_FILTER, isBinaryType, toIsoDateString } from './tw-api.ts'
import type { TiddlyWebClient, Tiddler } from './tw-api.ts'
import type { GitFace } from './git.ts'
import { downloadClipImage } from './clip-bridge.ts'
import { flushPendingWrites } from './seeds.ts'
import {
  AGENT_WRITTEN_TAG,
  DEFAULT_NOTE_TYPE,
  HUMAN_EDITED_TAG,
  assertNoConflict,
  buildWriteTiddler,
  cleanTiddler,
  finalTagsForWrite,
  finalTypeForWrite,
  flattenTiddlerFields,
  normalizeTagArg,
} from './write-policy.ts'

export { AGENT_WRITTEN_TAG, DEFAULT_NOTE_TYPE, HUMAN_EDITED_TAG } from './write-policy.ts'


/** Structural tool-registry face (subset of the dsh tools service). */
export interface ToolsCtx {
  tools: { register(tool: unknown): () => void }
}

export interface ToolsDeps {
  /** Lazy TW client — undefined while the service is not up. */
  wiki: () => TiddlyWebClient | undefined
  git: GitFace
  wikiPath: () => string
  noteTag: () => string
  /** Debounced auto-commit touch (fires after our writes). */
  autoCommit: () => void
  /** Restart the TW child (same port). Called after a pull that changed the
   *  working tree, so the server drops its stale in-memory snapshot and the
   *  agent sees the pulled content. Optional — absent in headless contexts. */
  restartWiki?: () => Promise<void>
}

function snippetOf(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/**
 * Snippet centred on the FIRST match of `query` (v0.19.0). The old snippet was
 * always the first 160 characters of the note, so a hit deep inside a long note
 * showed the model text that did not contain the term it searched for.
 */
function snippetAround(text: string, query: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return `${flat.slice(0, max)}…`
  const at = flat.toLowerCase().indexOf(needle)
  if (at < 0) return `${flat.slice(0, max)}…`
  const half = Math.max(0, Math.floor((max - needle.length) / 2))
  const start = Math.max(0, at - half)
  const end = Math.min(flat.length, start + max)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < flat.length ? '…' : ''
  return `${prefix}${flat.slice(start, end)}${suffix}`
}

/** Trash namespace for soft-deleted tiddlers (system titles: never listed by
 *  the default recipe filter, so deleted notes stop appearing in search/recent
 *  while staying recoverable). */
export const TRASH_PREFIX = '$:/dsh-tiddlywiki/trash/'

/**
 * Trash INDEX tiddler. A `$:/`-titled tiddler cannot be ENUMERATED through the
 * recipe listing at all: a fresh wiki has `$:/config/SyncSystemTiddlersFromServer
 * = "no"`, and `get-tiddlers-json.js` then appends `+[!is[system]]` to every
 * filter (verified). The trash therefore keeps its own index and reads it with a
 * plain GET (which works for system titles). (v0.19.0)
 */
export const TRASH_INDEX_TITLE = '$:/dsh-tiddlywiki/trash-index'

interface TrashIndexEntry { trash: string; of: string; at: string }

/** Build the trash title that holds one soft-deleted tiddler. */
function trashTitleFor(title: string, at = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-')
  return `${TRASH_PREFIX}${stamp}/${title}`
}

/** Read the trash index (missing/invalid → empty list). */
async function readTrashIndex(wiki: TiddlyWebClient): Promise<TrashIndexEntry[]> {
  const tiddler = await wiki.get(TRASH_INDEX_TITLE)
  if (tiddler === undefined || typeof tiddler.text !== 'string') return []
  try {
    const parsed = JSON.parse(tiddler.text) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is TrashIndexEntry => {
      if (typeof entry !== 'object' || entry === null) return false
      const e = entry as Record<string, unknown>
      return typeof e.trash === 'string' && typeof e.of === 'string'
    }).map((e) => ({ trash: e.trash, of: e.of, at: typeof e.at === 'string' ? e.at : '' }))
  } catch {
    return []
  }
}

/** Persist the trash index. */
async function writeTrashIndex(wiki: TiddlyWebClient, entries: TrashIndexEntry[]): Promise<void> {
  await wiki.put({ title: TRASH_INDEX_TITLE, text: JSON.stringify(entries, null, 2), type: 'application/json', tags: [] })
}

/** Mime types offered by `tiddlywiki_attach` for local files. */
const ATTACH_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
  ico: 'image/x-icon', pdf: 'application/pdf', zip: 'application/zip',
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4',
  epub: 'application/epub+zip',
}

/** Size cap for one attachment (mirrors the clip bridge's image cap). */
export const MAX_ATTACH_BYTES = 15 * 1024 * 1024

/**
 * Count references to `target` inside wiki text: `[[target]]`,
 * `[[display|target]]`, `[[target|display]]` is NOT a reference to target as a
 * link target in TW (the first part is the text, the second the target), so
 * only the second position counts, plus `{{target}}` transclusions.
 */
function countRefsTo(text: string, target: string): number {
  if (target.length === 0) return 0
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(`\\[\\[${escaped}\\]\\]`, 'g'),
    new RegExp(`\\[\\[[^\\]|]*\\|${escaped}\\]\\]`, 'g'),
    new RegExp(`\\{\\{${escaped}\\}\\}`, 'g'),
  ]
  let count = 0
  for (const re of patterns) count += (text.match(re) ?? []).length
  return count
}

/**
 * Junk tags produced by tooling mistakes rather than by a human. The live wiki
 * still carries `筛选器错误: Missing [ in filter expression` from the v0.16.22
 * filter bug — a lint must be able to find that class of damage again.
 */
function isJunkTag(tag: string): boolean {
  if (tag.length === 0) return false
  if (/筛选器错误|Missing \[|in filter expression/i.test(tag)) return true
  if (/[[\]{}|<>]/.test(tag)) return true
  if (/^(in|filter|expression|Missing|tags:)$/i.test(tag)) return true
  if (/^[A-Za-z]:\\/.test(tag)) return true
  if (tag.trim() !== tag) return true
  return false
}

/**
 * tiddler 的非内容字段（自定义字段 + 内容类型 + 时间戳 + revision），供模型读。
 *
 * v0.19.1 修复：单条 GET 把自定义字段**嵌在 `fields` 里**，旧实现只把顶层条目
 * 抄一遍，于是渲染出来的 `字段:` 行是 `fields=[object Object]` —— `q`/`due`/
 * `clip-url`/`workspace` 这些笔记元数据对模型完全不可见（实测）。现在统一走
 * `flattenTiddlerFields()` 摊平，并显式带上 `revision`（乐观并发令牌）。
 */
function pickFields(t: Tiddler): Record<string, unknown> {
  const out = flattenTiddlerFields(t)
  if (t.revision !== undefined) out.revision = t.revision
  return out
}

/**
 * Rewrite TiddlyWiki references to a title inside wiki text: `[[Title]]`,
 * `[[display|Title]]`, `{{Title}}` → the new title. Best-effort link/text
 * migration for tiddlywiki_rename; returns the rewritten text + hit count.
 */
function rewriteRefs(text: string, oldTitle: string, newTitle: string): { text: string; count: number } {
  if (oldTitle.length === 0) return { text, count: 0 }
  const escaped = oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(\\[\\[[^\\]|]*\\|)${escaped}(\\]\\])|(\\[\\[)${escaped}(\\]\\])|(\\{\\{)${escaped}(\\}\\})`, 'g')
  let count = 0
  const out = text.replace(re, (...args: Array<string | number>) => {
    const p = args as string[]
    count++
    const prefix = p[1] ?? p[3] ?? p[5] ?? ''
    const suffix = p[2] ?? p[4] ?? p[6] ?? ''
    return `${prefix}${newTitle}${suffix}`
  })
  return { text: out, count }
}

/**
 * Insert `addition` at the end of the section introduced by `heading` (Markdown
 * `#`/`##`… or wikitext `!`/`!!`…). Falls back to appending at the end of the
 * document when the heading is not found. Used by tiddlywiki_append so an agent
 * can add to one section of a long note without rewriting the whole file.
 */
function insertIntoSection(base: string, heading: string, addition: string): string {
  const lines = base.split('\n')
  const headingText = (line: string): string | null => {
    const md = /^#{1,6}\s+(.*)$/.exec(line)
    if (md !== null) return (md[1] ?? '').trim()
    const tw = /^!{1,6}\s*(.*)$/.exec(line)
    if (tw !== null) return (tw[1] ?? '').trim()
    return null
  }
  const start = lines.findIndex((line) => headingText(line) === heading)
  if (start < 0) {
    return base.trim().length === 0 ? addition : `${base.replace(/\s+$/, '')}\n\n${addition}`
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (headingText(lines[i] ?? '') !== null) {
      end = i
      break
    }
  }
  const before = lines.slice(0, end).join('\n').replace(/\s+$/, '')
  const after = lines.slice(end).join('\n')
  const head = `${before}\n\n${addition}`
  return after.trim().length === 0 ? head : `${head}\n\n${after.replace(/^\s+/, '')}`
}


export function registerTiddlywikiTools(ctx: ToolsCtx, deps: ToolsDeps): Array<() => void> {
  const disposers: Array<() => void> = []
  const register = (tool: unknown): void => { disposers.push(ctx.tools.register(tool)) }

  /** Every read/write tool needs a live TW client — shared guard for the 8
   *  wiki-facing tools (git tools operate on the repo path instead). */
  const requireWiki = (): TiddlyWebClient => {
    const wiki = deps.wiki()
    if (wiki === undefined) throw new Error('TiddlyWiki 服务未运行（tiddlywiki_status 可查）')
    return wiki
  }

  // ── tiddlywiki_search ────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_search',
    description: '检索 TiddlyWiki 持久知识库：按关键词（可选 tags 数组 / since 修改时间 / type / field+value / limit）搜索非系统 tiddler，按相关度排序返回标题、标签、修改时间与命中处上下文片段。二进制 tiddler（图片等附件，正文为 base64）不参与检索。',
    parameters: {
      query: { type: 'string', description: '搜索关键词（大小写不敏感，子串匹配；命中标题/标签/正文，标题命中权重最高）', required: true },
      tags: { type: 'array', items: { type: 'string' }, description: '可选：要求同时包含的标签（AND）' },
      tag: { type: 'string', description: '可选：单个精确标签（与 tags 同为 AND）' },
      since: { type: 'string', description: '可选：ISO 时间（如 2026-09-01 或 2026-09-01T00:00:00Z），只返回修改时间不早于它的 tiddler' },
      type: { type: 'string', description: '可选：精确 tiddler 类型。⚠️ 不传则不限类型（推荐）；插件默认把笔记写成 text/markdown，传 "text/vnd.tiddlywiki" 会把 Markdown 笔记全部排除' },
      field: { type: 'string', description: '可选：按自定义字段过滤（如 "q"、"clip-url"、"workspace"）' },
      value: { type: 'string', description: '可选：field 必须等于该值（不传则只要求该字段存在）' },
      limit: { type: 'integer', description: '可选：返回条数上限（默认 30，最大 200）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: SearchResult) => {
        const filters: string[] = []
        if (value.tags.length > 0) filters.push(`tags=${value.tags.join(',')}`)
        if (value.since !== null) filters.push(`since=${value.since}`)
        if (value.type !== null) filters.push(`type=${value.type}`)
        if (value.field !== null) filters.push(`field=${value.field}${value.value !== null ? `=${value.value}` : ''}`)
        const head = `TiddlyWiki 搜索「${value.query}」${filters.length > 0 ? ` (${filters.join(' · ')})` : ''}：命中 ${value.total} 条（按相关度排序）。`
        const lines = [head]
        if (value.results.length === 0) lines.push('没有匹配的 tiddler。')
        for (const r of value.results) {
          const tags = r.tags.length > 0 ? ` [${r.tags.join(', ')}]` : ''
          const modified = r.modified !== null ? ` (${r.modified})` : ''
          lines.push(`- ${r.title}${tags}${modified}`)
          if (r.snippet.length > 0) lines.push(`  ${r.snippet}`)
        }
        if (value.total > value.results.length) lines.push(`（另有 ${value.total - value.results.length} 条未展开，可用 tiddlywiki_get 读取具体标题，或提高 limit）`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { query: string; tags?: string[]; tag?: string; since?: string; type?: string; field?: string; value?: string; limit?: number }): Promise<SearchResult> => {
      const wiki = requireWiki()
      const { items, total } = await wiki.search(args.query, {
        tags: args.tags,
        tag: args.tag,
        since: args.since,
        type: args.type,
        field: args.field,
        value: args.value,
        limit: args.limit,
      })
      return {
        query: args.query,
        tags: args.tags ?? [],
        since: args.since ?? null,
        type: args.type ?? null,
        field: args.field ?? null,
        value: args.value ?? null,
        total,
        results: items.map((t) => ({ title: t.title, tags: t.tags ?? [], modified: toIsoDateString(t.modified), snippet: snippetAround(t.text ?? '', args.query) })),
      }
    },
  }))

  // ── tiddlywiki_recent ────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_recent',
    description: '查看 TiddlyWiki 知识库最近修改的笔记（按修改时间倒序，排除系统 tiddler 与图片等二进制附件），返回标题、标签、修改时间与摘要。适合开工时快速了解近期动态。',
    parameters: {
      limit: { type: 'integer', description: '可选：返回条数（默认 15，最大 200）' },
      since: { type: 'string', description: '可选：只返回修改时间不早于该 ISO 时间的 tiddler' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: RecentResult) => {
        const lines = [`TiddlyWiki 最近修改（最近 ${value.results.length} 条${value.since !== null ? `，since=${value.since}` : ''}）：`]
        if (value.results.length === 0) lines.push('暂无笔记。')
        for (const r of value.results) {
          const tags = r.tags.length > 0 ? ` [${r.tags.join(', ')}]` : ''
          lines.push(`- ${r.title}${tags} (${r.modified ?? '?'})`)
          if (r.snippet.length > 0) lines.push(`  ${r.snippet}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { limit?: number; since?: string }): Promise<RecentResult> => {
      const wiki = requireWiki()
      const items = await wiki.recent(args.limit ?? 15, args.since)
      return {
        since: args.since ?? null,
        results: items.map((t) => ({ title: t.title, tags: t.tags ?? [], modified: toIsoDateString(t.modified), snippet: snippetOf(t.text ?? '') })),
      }
    },
  }))

  // ── tiddlywiki_list_tags ─────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_list_tags',
    description: '列出 TiddlyWiki 知识库现有的非系统标签及各自计数（按使用次数降序），方便决定给笔记打什么 tag。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value: TagListResult) => {
        if (value.tags.length === 0) return [{ type: 'text', text: '知识库暂无标签。' }]
        const lines = [`现有标签（${value.tags.length} 个，按使用次数降序）：`]
        for (const t of value.tags) lines.push(`- ${t.tag} × ${t.count}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (): Promise<TagListResult> => {
      const wiki = requireWiki()
      const tags = await wiki.listTags()
      return { count: tags.length, tags }
    },
  }))

  // ── tiddlywiki_get ───────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_get',
    description: '读取一个 TiddlyWiki tiddler 的完整内容（标题、全文、标签、自定义字段）。二进制 tiddler（图片等附件）只返回元数据，不返回 base64 正文。',
    parameters: {
      title: { type: 'string', description: 'tiddler 标题（精确匹配）', required: true },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: GetResult) => {
        if (value.notFound) return [{ type: 'text', text: `tiddler「${value.title}」不存在。可用 tiddlywiki_search 检索，或用 tiddlywiki_put 新建。` }]
        if (value.binary === true) {
          const lines = [`tiddler「${value.title}」是二进制附件（type=${value.binaryType ?? '?'}，base64 正文约 ${value.binaryChars ?? 0} 字符），不返回正文。`]
          if (value.tags.length > 0) lines.push(`标签: ${value.tags.join(', ')}`)
          if (value.modified !== null) lines.push(`修改: ${value.modified}`)
          const fields = Object.entries(value.fields)
          if (fields.length > 0) lines.push(`字段: ${fields.map(([k, v]) => `${k}=${String(v)}`).join(', ')}`)
          lines.push(`如需查看附件本身，可打开 [${value.title}](/dsh-tiddlywiki/tw/#${encodeURIComponent(value.title)})。`)
          return [{ type: 'text', text: lines.join('\n') }]
        }
        const lines = [`tiddler「${value.title}」`]
        if (value.tags.length > 0) lines.push(`标签: ${value.tags.join(', ')}`)
        if (value.modified !== null) lines.push(`修改: ${value.modified}`)
        const fields = Object.entries(value.fields)
        if (fields.length > 0) lines.push(`字段: ${fields.map(([k, v]) => `${k}=${String(v)}`).join(', ')}`)
        lines.push('--- 全文 ---')
        lines.push(value.text.length > 0 ? value.text : '（空）')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { title: string }): Promise<GetResult> => {
      const wiki = requireWiki()
      const t = await wiki.get(args.title)
      if (t === undefined) return { notFound: true, title: args.title, text: '', tags: [], fields: {}, modified: null }
      const binary = isBinaryType(typeof t.type === 'string' ? t.type : undefined)
      const result: GetResult = {
        notFound: false,
        title: t.title,
        text: binary ? '' : (t.text ?? ''),
        tags: t.tags ?? [],
        fields: pickFields(t),
        modified: toIsoDateString(t.modified),
      }
      if (binary) {
        result.binary = true
        result.binaryType = typeof t.type === 'string' ? t.type : undefined
        result.binaryChars = (t.text ?? '').length
      }
      return result
    },
  }))

  // ── tiddlywiki_put ───────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_put',
    description: '写入（新建或覆盖）一个 TiddlyWiki tiddler。同名覆盖；**覆盖已有条目时，未传的 tags / 自定义字段会原样保留**（不会静默丢掉笔记原有的标签与字段），显式传 tags 才整体替换标签。写入后触发自动 commit。新建（title 不存在）时自动补打 agent-written 标签标记「由 Agent 撰写」，无需手动添加。未指定内容类型时自动默认 text/markdown（$:/ 系统条目除外）；要写原生 wikitext 需显式在 fields 传 {"type":"text/vnd.tiddlywiki"}。⚠️ fields.type 是 TW 的内容类型保留字段，不要把业务分类值（如 "meeting"）写进去——业务分类请放 tags。',
    parameters: {
      title: { type: 'string', description: 'tiddler 标题（精确匹配，覆盖同名）', required: true },
      text: { type: 'string', description: 'tiddler 全文（默认按 Markdown 解析）', required: true },
      tags: { type: 'array', items: { type: 'string' }, description: '标签数组（可选）' },
      fields: { type: 'json', description: '附加自定义字段，如 {"date":"2026-09-02"}（可选）。注意：fields.type 是 TW 内容类型（保留字段，默认已自动补 text/markdown），不要写业务分类值' },
      expectedModified: { type: 'string', description: '可选：乐观并发保护。传 tiddlywiki_get 读到的 modified 值，若该条目已被他人改动则拒绝写入（避免覆盖人类在 TW 编辑器里的修改）' },
      expectedRevision: { type: 'integer', description: '可选：乐观并发保护的另一种令牌——传 tiddlywiki_get 返回字段里的 revision（刚写入、还没落盘的条目没有 modified，此时用 revision）' },
      force: { type: 'boolean', description: '可选：true 时忽略 expectedModified/expectedRevision 强制覆盖（默认 false）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: PutResult) => {
        const lines = [`已写入 tiddler「${value.title}」`]
        if (value.tags.length > 0) lines.push(`标签: ${value.tags.join(', ')}`)
        if (value.type !== null) lines.push(`类型: ${value.type}${value.typeDefaulted === true ? '（未指定，已默认 markdown）' : ''}`)
        if (value.fields !== null) {
          const entries = Object.entries(value.fields)
          if (entries.length > 0) lines.push(`字段: ${entries.map(([k, v]) => `${k}=${String(v)}`).join(', ')}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { title: string; text: string; tags?: string[]; fields?: Record<string, unknown>; expectedModified?: string; expectedRevision?: number; force?: boolean }): Promise<PutResult> => {
      const wiki = requireWiki()
      if (args.title.trim().length === 0) throw new Error('tiddlywiki_put: title 不能为空')
      // Read WITHOUT swallowing errors: only a 404 means "new tiddler". A
      // transient failure treated as "new" would silently tag an existing
      // human note as agent-written.
      const existing = await wiki.get(args.title)
      assertNoConflict(args.title, existing, {
        expectedModified: args.expectedModified,
        expectedRevision: args.expectedRevision,
        force: args.force,
      })
      const tags = normalizeTagArg(args.tags)
      const { tiddler, typeDefaulted } = buildWriteTiddler(args.title, args.text, { existing, tags, fields: args.fields })
      await wiki.put(tiddler)
      deps.autoCommit()
      return { ok: true, title: args.title, tags: tiddler.tags ?? [], type: typeof tiddler.type === 'string' ? tiddler.type : null, ...(typeDefaulted ? { typeDefaulted: true } : {}), fields: args.fields ?? null }
    },
  }))

  // ── tiddlywiki_batch_put ─────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_batch_put',
    description: '批量写入/覆盖多个 TiddlyWiki tiddler（一次工具调用）。overwrite=false 时跳过已存在的标题；返回逐条结果（单条失败不影响其余条目，失败原因逐条列出）。写入后触发自动 commit。新建（title 不存在）的条目会自动补打 agent-written 标签，无需手动添加。未指定内容类型（fields.type）的条目自动默认 text/markdown（$:/ 系统条目除外）。',
    parameters: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          description: '要写入的 tiddler 数组',
          properties: {
            // NOTHING is `required` here on purpose (v0.19.0): argument
            // pre-validation runs BEFORE the per-item try/catch, so a declared
            // requirement made one malformed item abort the WHOLE batch and the
            // documented "one failure does not lose the others" contract was
            // unreachable. The implementation validates per item instead.
            title: { type: 'string', description: '标题（精确匹配，覆盖同名）' },
            text: { type: 'string', description: '全文（默认按 Markdown 解析）' },
            tags: { type: 'array', items: { type: 'string' }, description: '标签数组（可选）' },
            fields: { type: 'json', description: '附加自定义字段（可选）。注意：fields.type 是 TW 内容类型（保留字段，默认已自动补 text/markdown），不要写业务分类值' },
          },
        },
      },
      overwrite: { type: 'boolean', description: '可选：true=覆盖同名（默认），false=跳过已存在的标题' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: BatchResult) => {
        const lines = [`批量写入完成：成功 ${value.written}，跳过 ${value.skipped}，失败 ${value.failed}，共 ${value.items.length} 条。`]
        for (const r of value.items) {
          lines.push(`- ${r.title}：${r.written ? '已写入' : r.skipped ? '已跳过（存在）' : `失败（${r.error ?? '未知错误'}）`}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { items: Array<{ title: string; text: string; tags?: string[]; fields?: Record<string, unknown> }>; overwrite?: boolean }): Promise<BatchResult> => {
      const wiki = requireWiki()
      const list = Array.isArray(args.items) ? args.items : []
      if (list.length === 0) return { ok: true, written: 0, skipped: 0, failed: 0, items: [] }
      const overwrite = args.overwrite !== false
      const results: BatchItemResult[] = []
      let written = 0
      let skipped = 0
      let failed = 0
      // One item failing (validation, network, a rejected title) must not lose
      // the report of the items that DID land — the model needs per-item truth.
      for (const item of list) {
        const title = typeof item?.title === 'string' ? item.title : ''
        try {
          if (title.length === 0) throw new Error('缺少非空 title')
          if (typeof item.text !== 'string') throw new Error('缺少 text')
          // Read WITHOUT swallowing errors: only a 404 means "new tiddler".
          const existing = await wiki.get(title)
          if (!overwrite && existing !== undefined) {
            skipped++
            results.push({ title, written: false, skipped: true, failed: false })
            continue
          }
          const { tiddler } = buildWriteTiddler(title, item.text, { existing, tags: normalizeTagArg(item.tags), fields: item.fields })
          await wiki.put(tiddler)
          written++
          results.push({ title, written: true, skipped: false, failed: false })
        } catch (err) {
          failed++
          results.push({ title: title.length > 0 ? title : '(无标题)', written: false, skipped: false, failed: true, error: err instanceof Error ? err.message : String(err) })
        }
      }
      deps.autoCommit()
      return { ok: failed === 0, written, skipped, failed, items: results }
    },
  }))

  // ── tiddlywiki_rename ────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_rename',
    description: '重命名一个 TiddlyWiki tiddler：把旧标题的内容复制到新标题、删除旧标题，并可选地更新其他 tiddler 里的 [[旧标题]] / {{旧标题}} 引用（最佳努力）。',
    parameters: {
      oldTitle: { type: 'string', description: '当前标题', required: true },
      newTitle: { type: 'string', description: '新标题', required: true },
      updateRefs: { type: 'boolean', description: '可选：是否同步更新其他 tiddler 里的引用（默认 true）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: RenameResult) => {
        const lines = [`已重命名「${value.from}」→「${value.to}」`]
        lines.push(`更新了 ${value.refsUpdated} 处引用（${value.refsTiddlers} 个 tiddler）`)
        if (value.warning !== undefined) lines.push(`注意: ${value.warning}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { oldTitle: string; newTitle: string; updateRefs?: boolean }): Promise<RenameResult> => {
      const wiki = requireWiki()
      const { oldTitle, newTitle } = args
      if (oldTitle === newTitle) return { ok: true, from: oldTitle, to: newTitle, refsUpdated: 0, refsTiddlers: 0 }
      const existing = await wiki.get(oldTitle)
      if (existing === undefined) throw new Error(`tiddler「${oldTitle}」不存在`)
      const target = await wiki.get(newTitle)
      if (target !== undefined) throw new Error(`新标题「${newTitle}」已存在（可先用 tiddlywiki_delete 删除）`)
      let refsUpdated = 0
      let refsTiddlers = 0
      let warning: string | undefined
      if (args.updateRefs !== false) {
        const all = await wiki.list(undefined, true)
        for (const t of all) {
          if (t.title === oldTitle || t.title === newTitle) continue
          if (t.title.startsWith('$:/')) continue
          const text = t.text ?? ''
          if (text.length === 0) continue
          const rewritten = rewriteRefs(text, oldTitle, newTitle)
          if (rewritten.count > 0) {
            await wiki.put({ ...cleanTiddler(t), text: rewritten.text })
            refsUpdated += rewritten.count
            refsTiddlers++
          }
        }
      }
      await wiki.put({ ...cleanTiddler(existing), title: newTitle })
      await wiki.delete(oldTitle)
      if (refsTiddlers === 0) {
        warning = '未找到任何其他 tiddler 引用旧标题；如确实需要，可手动补充链接。'
      }
      deps.autoCommit()
      return { ok: true, from: oldTitle, to: newTitle, refsUpdated, refsTiddlers, ...(warning !== undefined ? { warning } : {}) }
    },
  }))

  // ── tiddlywiki_delete ────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_delete',
    description: '删除一个 TiddlyWiki tiddler（不存在时是幂等空操作）。默认是**软删除**：内容移入回收站（$:/dsh-tiddlywiki/trash/…，不再出现在检索/最近列表里）后删除原条目，可用 tiddlywiki_trash 恢复；permanent=true 才真正永久删除。删除后触发自动 commit。',
    parameters: {
      title: { type: 'string', description: 'tiddler 标题（精确匹配）', required: true },
      permanent: { type: 'boolean', description: '可选：true = 永久删除（回收站也拿不回来，仅剩 git 历史）；默认 false = 移入回收站' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: DeleteResult) => [{
        type: 'text',
        text: value.trashed === true
          ? `已把 tiddler「${value.title}」移入回收站（$:/dsh-tiddlywiki/trash/，可用 tiddlywiki_trash action=restore 恢复）。`
          : `已永久删除 tiddler「${value.title}」。`,
      }],
    },
    execute: async (args: { title: string; permanent?: boolean }): Promise<DeleteResult> => {
      const wiki = requireWiki()
      const existing = await wiki.get(args.title)
      // Trash entries themselves and system tiddlers are never nested.
      const canTrash = existing !== undefined && args.permanent !== true && !args.title.startsWith(TRASH_PREFIX)
      if (!canTrash) {
        await wiki.delete(args.title)
        deps.autoCommit()
        return { ok: true, title: args.title, trashed: false }
      }
      const trashTitle = trashTitleFor(args.title)
      const at = new Date().toISOString()
      await wiki.put({ ...cleanTiddler(existing), title: trashTitle, 'trash-of': args.title, 'trash-at': at })
      await wiki.delete(args.title)
      const index = await readTrashIndex(wiki)
      index.push({ trash: trashTitle, of: args.title, at })
      await writeTrashIndex(wiki, index)
      deps.autoCommit()
      return { ok: true, title: args.title, trashed: true, trashTitle }
    },
  }))

  // ── tiddlywiki_trash ─────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_trash',
    description: '回收站（软删除的笔记）：action=list 列出、action=restore 恢复某条、action=empty 清空。配合 tiddlywiki_delete（默认软删除）使用。',
    parameters: {
      action: { type: 'string', enum: ['list', 'restore', 'empty'], description: 'list=列出回收站；restore=恢复（需 title）；empty=永久清空', required: true },
      title: { type: 'string', description: 'action=restore 时的原标题（也接受回收站标题）' },
      limit: { type: 'integer', description: 'action=list 的返回上限（默认 30，最大 200）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: TrashResult) => {
        const lines = [`回收站 ${value.action}：${value.message}`]
        for (const item of value.items ?? []) lines.push(`- ${item.title}（删除于 ${item.at ?? '?'}${item.of !== undefined ? `，原名「${item.of}」` : ''}）`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { action: 'list' | 'restore' | 'empty'; title?: string; limit?: number }): Promise<TrashResult> => {
      const wiki = requireWiki()
      const indexed = await readTrashIndex(wiki)
      if (args.action === 'list') {
        const limit = Math.max(1, Math.min(args.limit ?? 30, 200))
        return {
          action: 'list',
          message: `共 ${indexed.length} 条`,
          items: indexed.slice(-limit).reverse().map((entry) => ({ title: entry.trash, at: entry.at, of: entry.of })),
        }
      }
      if (args.action === 'empty') {
        for (const entry of indexed) await wiki.delete(entry.trash)
        await writeTrashIndex(wiki, [])
        deps.autoCommit()
        return { action: 'empty', message: `已清空 ${indexed.length} 条` }
      }
      const wanted = typeof args.title === 'string' ? args.title.trim() : ''
      if (wanted.length === 0) throw new Error('tiddlywiki_trash: action=restore 需要 title')
      const match = indexed.slice().reverse().find((entry) => entry.of === wanted || entry.trash === wanted)
      if (match === undefined) throw new Error(`回收站里没有「${wanted}」`)
      const stored = await wiki.get(match.trash)
      if (stored === undefined) {
        // Stale index entry (the tiddler was removed by hand): prune and report.
        await writeTrashIndex(wiki, indexed.filter((entry) => entry.trash !== match.trash))
        throw new Error(`回收站条目「${match.trash}」已不存在（索引已清理）`)
      }
      if ((await wiki.get(match.of)) !== undefined) {
        throw new Error(`无法恢复：标题「${match.of}」已被占用，请先处理现有条目`)
      }
      const restored = cleanTiddler(stored)
      delete restored['trash-of']
      delete restored['trash-at']
      await wiki.put({ ...restored, title: match.of })
      await wiki.delete(match.trash)
      await writeTrashIndex(wiki, indexed.filter((entry) => entry.trash !== match.trash))
      deps.autoCommit()
      return { action: 'restore', message: `已恢复「${match.of}」`, items: [] }
    },
  }))

  // ── tiddlywiki_append ────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_append',
    description: '向已有 tiddler 追加/前插文本，或写入指定标题段落的末尾（无需先读全文、不会整篇覆盖）——适合日志、批注、清单的增量写入。条目不存在时默认新建（createIfMissing=false 则报错）。',
    parameters: {
      title: { type: 'string', description: 'tiddler 标题', required: true },
      text: { type: 'string', description: '要追加/前插的文本（Markdown）', required: true },
      mode: { type: 'string', enum: ['append', 'prepend'], description: '可选：append（默认，追加到末尾）/ prepend（插到开头）' },
      heading: { type: 'string', description: '可选：append 时改为插入到该标题（Markdown # 或 wikitext ! 标题，按标题文本匹配）对应段落的末尾' },
      createIfMissing: { type: 'boolean', description: '可选：条目不存在时是否新建（默认 true）' },
      tags: { type: 'array', items: { type: 'string' }, description: '可选：仅新建时使用的标签' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: AppendResult) => [{
        type: 'text',
        text: `${value.created ? '已新建并写入' : '已增量写入'} tiddler「${value.title}」（${value.mode}${value.heading !== null ? ` · 段落「${value.heading}」` : ''}）：新增 ${value.added} 字符，现共 ${value.total} 字符。`,
      }],
    },
    execute: async (args: { title: string; text: string; mode?: 'append' | 'prepend'; heading?: string; createIfMissing?: boolean; tags?: string[] }): Promise<AppendResult> => {
      const wiki = requireWiki()
      const title = args.title.trim()
      if (title.length === 0) throw new Error('tiddlywiki_append: title 不能为空')
      const existing = await wiki.get(title)
      if (existing === undefined && args.createIfMissing === false) {
        throw new Error(`tiddler「${title}」不存在（createIfMissing=false）`)
      }
      const mode = args.mode === 'prepend' ? 'prepend' : 'append'
      const base = existing?.text ?? ''
      const addition = args.text
      let next: string
      if (mode === 'append' && typeof args.heading === 'string' && args.heading.trim().length > 0) {
        next = insertIntoSection(base, args.heading.trim(), addition)
      } else if (mode === 'prepend') {
        next = base.trim().length === 0 ? addition : `${addition}\n\n${base}`
      } else {
        next = base.trim().length === 0 ? addition : `${base.replace(/\s+$/, '')}\n\n${addition}`
      }
      if (existing !== undefined) {
        await wiki.put({ ...cleanTiddler(existing), text: next })
      } else {
        const tags = finalTagsForWrite(title, undefined, Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === 'string' && t.trim().length > 0) : [], true)
        const tiddler: Tiddler = { title, text: next }
        if (tags.length > 0) tiddler.tags = tags
        finalTypeForWrite(title, tiddler)
        await wiki.put(tiddler)
      }
      deps.autoCommit()
      return { ok: true, title, mode, heading: typeof args.heading === 'string' && args.heading.trim().length > 0 ? args.heading.trim() : null, created: existing === undefined, added: addition.length, total: next.length }
    },
  }))

  // ── tiddlywiki_backlinks ─────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_backlinks',
    description: '查反向链接：哪些笔记引用了目标 tiddler（[[标题]] / [[显示|标题]] / {{标题}}），以及哪些笔记把它当作标签。用于知识图谱导航、改动前评估影响面。',
    parameters: {
      title: { type: 'string', description: '目标 tiddler 标题', required: true },
      includeTags: { type: 'boolean', description: '可选：是否把「以该标题为标签」的笔记也算作反向链接（默认 true）' },
      limit: { type: 'integer', description: '可选：最多返回多少条（默认 30，最大 200）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: BacklinkResult) => {
        const lines = [`「${value.title}」的反向链接：${value.total} 条（引用 ${value.linkCount} · 标签 ${value.tagCount}）`]
        if (value.items.length === 0) lines.push('没有任何笔记引用它。')
        for (const item of value.items) {
          lines.push(`- ${item.title}（${item.via === 'tag' ? '标签' : `${item.refs} 处引用`}）`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { title: string; includeTags?: boolean; limit?: number }): Promise<BacklinkResult> => {
      const wiki = requireWiki()
      const target = args.title.trim()
      if (target.length === 0) throw new Error('tiddlywiki_backlinks: title 不能为空')
      const includeTags = args.includeTags !== false
      const limit = Math.max(1, Math.min(args.limit ?? 30, 200))
      const items = await wiki.list(undefined, true)
      const hits: Array<{ title: string; refs: number; via: 'link' | 'tag'; modified: string | null }> = []
      let linkCount = 0
      let tagCount = 0
      for (const t of items) {
        if (t.title === target || t.title.startsWith('$:/')) continue
        const refs = countRefsTo(t.text ?? '', target)
        const tagged = includeTags && (t.tags ?? []).includes(target)
        if (refs === 0 && !tagged) continue
        if (refs > 0) linkCount++
        if (tagged) tagCount++
        hits.push({ title: t.title, refs, via: refs > 0 ? 'link' : 'tag', modified: toIsoDateString(t.modified) })
      }
      hits.sort((a, b) => b.refs - a.refs || a.title.localeCompare(b.title, 'zh'))
      return { title: target, total: hits.length, linkCount, tagCount, items: hits.slice(0, limit) }
    },
  }))

  // ── tiddlywiki_attach ────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_attach',
    description: '把一个本机文件或公网 http(s) 地址存成 wiki 的二进制附件 tiddler（图片 / PDF / 压缩包等，type + base64 正文，随 wiki 进 git）。可选把附件嵌入/链接进某篇笔记。这是 agent 唯一能写入二进制附件的途径。',
    parameters: {
      title: { type: 'string', description: '附件 tiddler 标题（同时决定其在 wiki 里的名字）', required: true },
      path: { type: 'string', description: '本机绝对路径（与 url 二选一）' },
      url: { type: 'string', description: '公网 http(s) 地址（与 path 二选一；含 SSRF 守卫，拒绝内网/回环地址）' },
      tags: { type: 'array', items: { type: 'string' }, description: '可选：附件标签' },
      noteTitle: { type: 'string', description: '可选：把该附件嵌入到这篇笔记末尾（图片用 [img[标题]]，其它用 [[标题]] 链接）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: AttachResult) => {
        const lines = [`已保存附件「${value.title}」（${value.mime}，${value.bytes} 字节，base64 约 ${value.chars} 字符）`]
        if (value.source !== null) lines.push(`来源: ${value.source}`)
        if (value.embedInto !== null) lines.push(`已嵌入笔记「${value.embedInto}」`)
        lines.push(`打开: [${value.title}](/dsh-tiddlywiki/tw/#${encodeURIComponent(value.title)})`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { title: string; path?: string; url?: string; tags?: string[]; noteTitle?: string }): Promise<AttachResult> => {
      const wiki = requireWiki()
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
      const tags = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === 'string' && t.trim().length > 0) : []
      await wiki.put({
        title,
        type: mime,
        text: buffer.toString('base64'),
        ...(tags.length > 0 ? { tags } : {}),
        'attach-source': source,
        'attach-at': new Date().toISOString(),
      })
      let embedInto: string | null = null
      if (typeof args.noteTitle === 'string' && args.noteTitle.trim().length > 0) {
        embedInto = args.noteTitle.trim()
        const note = await wiki.get(embedInto)
        const embed = mime.startsWith('image/') ? `[img[${title}]]` : `[[${title}]]`
        const text = note === undefined ? embed : `${(note.text ?? '').replace(/\s+$/, '')}\n\n${embed}`
        if (note === undefined) {
          await wiki.put({ title: embedInto, text, type: DEFAULT_NOTE_TYPE, tags: [] })
        } else {
          await wiki.put({ ...cleanTiddler(note), text })
        }
      }
      deps.autoCommit()
      return { ok: true, title, mime, bytes: buffer.length, chars: buffer.toString('base64').length, source, embedInto }
    },
  }))

  // ── tiddlywiki_lint ──────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_lint',
    description: '知识库体检（只读）：找出垃圾/异常标签、指向不存在条目的死链、空笔记、疑似 Markdown 却缺 type 的笔记。返回按类别分组的问题清单与修复建议。',
    parameters: {
      limit: { type: 'integer', description: '可选：每类最多返回多少条示例（默认 10，最大 100）' },
      checks: { type: 'array', items: { type: 'string' }, description: '可选：只跑指定检查（junk-tags / broken-links / empty-notes / missing-type）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: LintResult) => {
        const lines = [`知识库体检：扫描 ${value.scanned} 条文本笔记，发现 ${value.issues.reduce((sum, i) => sum + i.count, 0)} 个问题。`]
        if (value.issues.length === 0) lines.push('没有发现问题。')
        for (const issue of value.issues) {
          lines.push(`- ${issue.kind}：${issue.count} 处 — ${issue.hint}`)
          for (const sample of issue.samples) lines.push(`    · ${sample}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { limit?: number; checks?: string[] }): Promise<LintResult> => {
      const wiki = requireWiki()
      const limit = Math.max(1, Math.min(args.limit ?? 10, 100))
      const wanted = Array.isArray(args.checks) && args.checks.length > 0 ? new Set(args.checks) : undefined
      const want = (kind: string): boolean => wanted === undefined || wanted.has(kind)
      const items = await wiki.list(undefined, true)
      // 死链检查需要**全部**标题（含图片/PDF 等二进制附件）——只拿文本列表会
      // 把每一条 `[[图.png]]` / `{{附件}}` 都误报成死链（v0.19.1 修复）。
      // 瘦列表（不带正文）一次请求就能拿到全部标题。
      const titles = want('broken-links')
        ? new Set((await wiki.list()).map((t) => t.title))
        : new Set(items.map((t) => t.title))
      // 缺 type 判定要走 `[!has[type]]` 过滤器：TW 服务端会给 listing 里**每条**
      // 无 type 的条目补 `text/vnd.tiddlywiki`，靠响应里的 type 永远认不出来
      // （v0.19.1 修复：旧实现里这个检查永远不触发）。过滤器在服务端按真实字段
      // 求值，返回的标题就是真正没有 type 的那些。
      const typelessTitles = want('missing-type')
        ? new Set((await wiki.list(MISSING_TYPE_FILTER)).map((t) => t.title))
        : new Set<string>()
      const issues: LintIssue[] = []

      if (want('junk-tags')) {
        const samples: string[] = []
        let count = 0
        for (const t of items) {
          for (const tag of t.tags ?? []) {
            if (!isJunkTag(tag)) continue
            count++
            if (samples.length < limit) samples.push(`「${t.title}」的标签「${tag}」`)
          }
        }
        if (count > 0) issues.push({ kind: 'junk-tags', count, hint: '明显是写入事故产生的标签（如筛选器错误文本）；用 tiddlywiki_put 重写该条目的 tags 清理', samples })
      }

      if (want('broken-links')) {
        const samples: string[] = []
        let count = 0
        const linkRe = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\{\{([^}]+)\}\}/g
        for (const t of items) {
          const text = t.text ?? ''
          let match: RegExpExecArray | null
          while ((match = linkRe.exec(text)) !== null) {
            const target = (match[3] ?? match[2] ?? match[1] ?? '').trim()
            if (target.length === 0 || target.startsWith('$:/') || /^(https?|mailto|file):/.test(target)) continue
            if (target.includes('$') || target.includes('<')) continue // variable/macro, not a tiddler link
            if (titles.has(target)) continue
            count++
            if (samples.length < limit) samples.push(`「${t.title}」→「${target}」`)
          }
        }
        if (count > 0) issues.push({ kind: 'broken-links', count, hint: '被引用条目标题不存在；确认是笔误还是应新建该条目', samples })
      }

      if (want('empty-notes')) {
        const samples: string[] = []
        let count = 0
        for (const t of items) {
          if (t.title.startsWith('$:/')) continue
          if (isBinaryType(typeof t.type === 'string' ? t.type : undefined)) continue
          if ((t.text ?? '').trim().length === 0) {
            count++
            if (samples.length < limit) samples.push(`「${t.title}」`)
          }
        }
        if (count > 0) issues.push({ kind: 'empty-notes', count, hint: '正文为空的笔记；补内容或删除', samples })
      }

      if (want('missing-type')) {
        const samples: string[] = []
        let count = 0
        for (const t of items) {
          if (t.title.startsWith('$:/')) continue
          if (!typelessTitles.has(t.title)) continue
          const text = t.text ?? ''
          if (/^#{1,6}\s|\n#{1,6}\s|^\s*[-*]\s|\*\*[^*]+\*\*/m.test(text)) {
            count++
            if (samples.length < limit) samples.push(`「${t.title}」（无 type 字段，当前按 wikitext 渲染）`)
          }
        }
        if (count > 0) issues.push({ kind: 'missing-type', count, hint: '正文像 Markdown 但条目没有 type 字段，TW 会按 wikitext 渲染；用 tiddlywiki_put 的 fields.type 明确内容类型', samples })
      }

      return { scanned: items.length, issues }
    },
  }))

  // ── tiddlywiki_git_sync ──────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_git_sync',
    description: '对 TiddlyWiki 知识库的 git 仓库做同步：pull（拉取远端并 rebase 本地，冲突则 abort 并报文件）、push（推送本地提交到远端）、sync（pull → commit 本地改动 → push）。未配置 git.remote 时 push 会失败并提示。',
    parameters: {
      action: { type: 'string', enum: ['pull', 'push', 'sync'], description: '要执行的 git 操作', required: true },
      message: { type: 'string', description: 'commit 信息（可选，仅 sync 的本地 commit 使用）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: SyncResult) => renderSync(value),
    },
    execute: async (args: { action: 'pull' | 'push' | 'sync'; message?: string }): Promise<SyncResult> => {
      const dir = deps.wikiPath()
      /** Restart TW after a pull that changed the tree (stale snapshot drop). */
      const restartIfChanged = async (pulled: { changed?: boolean }): Promise<{ restarted?: boolean; restartError?: string }> => {
        if (pulled.changed !== true || deps.restartWiki === undefined) return {}
        try {
          // DRAIN THE SYNCER FIRST (v0.19.1, data safety): a PUT answers 204 as
          // soon as the tiddler is in TW's in-memory store; the filesystem
          // syncer writes it ~250ms later. Restarting TW before that flush KILLS
          // the write (the restarted server boots from the old snapshot and the
          // note is gone — not even the git commit that follows can recover it).
          // The agent path is the risky one: `tiddlywiki_put` → `git_sync`
          // back-to-back. Same sentinel trick as seeds.ts / index.ts.
          await flushPendingWrites(requireWiki(), join(dir, 'tiddlers')).catch(() => undefined)
          await deps.restartWiki()
          return { restarted: true }
        } catch (err) {
          return { restartError: err instanceof Error ? err.message : String(err) }
        }
      }
      switch (args.action) {
        case 'pull': {
          const r = await deps.git.pull(dir)
          const restart = await restartIfChanged(r)
          return { action: args.action, ok: r.ok, message: r.message, ...(r.conflictFiles !== undefined ? { conflictFiles: r.conflictFiles } : {}), ...(r.changed === true ? { changed: true } : {}), ...restart }
        }
        case 'push': {
          const r = await deps.git.push(dir)
          return { action: args.action, ok: r.ok, message: r.message }
        }
        case 'sync': {
          const pulled = await deps.git.pull(dir)
          if (!pulled.ok) return { action: args.action, ok: false, message: pulled.message, ...(pulled.conflictFiles !== undefined ? { conflictFiles: pulled.conflictFiles } : {}) }
          const restart = await restartIfChanged(pulled)
          const committed = await deps.git.commit(dir, args.message ?? `sync ${new Date().toISOString()}`)
          const pushed = await deps.git.push(dir)
          const status = await deps.git.status(dir)
          return {
            action: args.action,
            ok: pushed.ok,
            message: pushed.ok ? '同步完成' : pushed.message,
            pull: 'ok',
            ...(pulled.changed === true ? { changed: true } : {}),
            ...restart,
            commit: committed.message,
            push: pushed.message,
            status,
          }
        }
      }
    },
  }))

  // ── tiddlywiki_git_resolve ───────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_git_resolve',
    description: '在 tiddlywiki_git_sync action=pull 冲突（已 abort）后，按 tiddler 二选一解决：keep-local 保留本地版本；keep-remote 用 git fetch 拉取远端并检出远端版本（需已配置 git.remote）；list 仅报告当前状态。解决后建议重新 pull/sync 整合其余改动。',
    parameters: {
      strategy: { type: 'string', enum: ['keep-local', 'keep-remote', 'list'], description: 'keep-local=保留本地；keep-remote=改用远端版本；list=仅报告当前 git 状态', required: true },
      files: { type: 'array', items: { type: 'string' }, description: '冲突文件名数组（来自 pull 返回的 conflictFiles；list 时忽略）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: ResolveResult) => {
        const lines = [`git resolve ${value.action}: ${value.ok ? '成功' : '失败'}`]
        lines.push(`  ${value.message}`)
        if (value.files !== undefined && value.files.length > 0) lines.push(`涉及文件: ${value.files.join(', ')}`)
        if (value.commit !== undefined) lines.push(`本地 commit: ${value.commit}`)
        if (value.status !== undefined) lines.push(`状态: ${gitStatusBits(value.status)}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { strategy: 'keep-local' | 'keep-remote' | 'list'; files?: string[] }): Promise<ResolveResult> => {
      const dir = deps.wikiPath()
      if (args.strategy === 'list') {
        const status = await deps.git.status(dir)
        return { ok: true, action: 'list', message: '当前仓库状态（pull 冲突已 abort，工作区即本地版本，不会残留未合并状态）', status }
      }
      const files = (args.files ?? []).filter((f) => typeof f === 'string' && f.length > 0)
      if (files.length === 0) {
        return { ok: false, action: args.strategy, message: '请提供 conflictFiles（来自 pull 返回）', hint: '可先执行 tiddlywiki_git_sync action=pull 查看冲突文件' }
      }
      if (args.strategy === 'keep-local') {
        const status = await deps.git.status(dir)
        return {
          ok: true,
          action: 'keep-local',
          message: `已保留本地版本（${files.length} 个文件；abort 后本地即为工作区内容）。建议重新 tiddlywiki_git_sync action=sync 整合远端其余改动。`,
          files,
          status,
        }
      }
      const fetched = await deps.git.fetch(dir)
      if (!fetched.ok) {
        return { ok: false, action: 'keep-remote', message: `fetch 失败（可能未配置 git.remote）：${fetched.message}` }
      }
      const checked = await deps.git.checkoutFetchHead(dir, files)
      if (!checked.ok) {
        return { ok: false, action: 'keep-remote', message: `从远端检出失败：${checked.message}` }
      }
      const committed = await deps.git.commit(dir, `resolve conflict (keep remote) ${new Date().toISOString()}`)
      deps.autoCommit()
      const status = await deps.git.status(dir)
      return {
        ok: true,
        action: 'keep-remote',
        message: `已把 ${files.length} 个冲突文件改为远端版本并提交。建议继续 tiddlywiki_git_sync action=sync 完成整合与推送。`,
        files,
        commit: committed.message,
        status,
      }
    },
  }))

  return disposers
}

// ── tool result shapes + renders ───────────────────────────────────────────

interface SearchHit { title: string; tags: string[]; modified: string | null; snippet: string }
interface SearchResult { query: string; tags: string[]; since: string | null; type: string | null; field: string | null; value: string | null; total: number; results: SearchHit[] }
interface RecentResult { since: string | null; results: SearchHit[] }
interface TagListResult { count: number; tags: Array<{ tag: string; count: number }> }
interface GetResult {
  notFound: boolean
  title: string
  text: string
  tags: string[]
  fields: Record<string, unknown>
  modified: string | null
  /** Binary attachment (image/audio/…): `text` is withheld, these carry its type+size. */
  binary?: boolean
  binaryType?: string
  binaryChars?: number
}
interface PutResult { ok: boolean; title: string; tags: string[]; type: string | null; typeDefaulted?: boolean; fields: Record<string, unknown> | null }
interface BatchItemResult { title: string; written: boolean; skipped: boolean; failed: boolean; error?: string }
interface BatchResult { ok: boolean; written: number; skipped: number; failed: number; items: BatchItemResult[] }
interface RenameResult { ok: boolean; from: string; to: string; refsUpdated: number; refsTiddlers: number; warning?: string }
interface DeleteResult { ok: boolean; title: string; /** true = moved to the trash (recoverable). */ trashed?: boolean; trashTitle?: string }
interface TrashItem { title: string; at?: string; of?: string }
interface TrashResult { action: string; message: string; items?: TrashItem[] }
interface AppendResult { ok: boolean; title: string; mode: 'append' | 'prepend'; heading: string | null; created: boolean; added: number; total: number }
interface BacklinkHit { title: string; refs: number; via: 'link' | 'tag'; modified: string | null }
interface BacklinkResult { title: string; total: number; linkCount: number; tagCount: number; items: BacklinkHit[] }
interface AttachResult { ok: boolean; title: string; mime: string; bytes: number; chars: number; source: string | null; embedInto: string | null }
interface LintIssue { kind: string; count: number; hint: string; samples: string[] }
interface LintResult { scanned: number; issues: LintIssue[] }
interface SyncResult {
  action: string
  ok: boolean
  message: string
  conflictFiles?: string[]
  pull?: string
  commit?: string
  push?: string
  changed?: boolean
  restarted?: boolean
  restartError?: string
  status?: GitStatusView
}
interface ResolveResult {
  ok: boolean
  action: string
  message: string
  files?: string[]
  commit?: string
  hint?: string
  status?: GitStatusView
}

/** Shape of deps.git.status() as surfaced to the model (shared by renders). */
interface GitStatusView {
  branch: string
  dirty: boolean
  dirtyFiles: string[]
  remote: string
  lastCommit?: string
  ahead?: number
  behind?: number
}

/** One-line 状态 summary: 分支 … 领先 … 落后 … 工作区未提交 … 最近提交. */
function gitStatusBits(s: GitStatusView): string {
  const bits = [`分支 ${s.branch}`]
  if (s.ahead !== undefined) bits.push(`领先 ${s.ahead}`)
  if (s.behind !== undefined) bits.push(`落后 ${s.behind}`)
  if (s.dirty) bits.push(`工作区有 ${s.dirtyFiles.length} 个未提交改动`)
  if (s.lastCommit !== undefined) bits.push(`最近提交 ${s.lastCommit}`)
  return bits.join(' · ')
}

function renderSync(value: SyncResult): Array<{ type: 'text'; text: string }> {
  const lines = [`git ${value.action}: ${value.ok ? '成功' : '失败'}`]
  lines.push(`  ${value.message}`)
  if (value.conflictFiles !== undefined && value.conflictFiles.length > 0) {
    lines.push(`冲突文件（rebase 已 abort，勿自动覆盖）:`)
    for (const f of value.conflictFiles) lines.push(`  - ${f}`)
    lines.push('处理方式：用 tiddlywiki_git_resolve files=[以上文件] strategy=keep-local|keep-remote 按 tiddler 二选一解决，再重新 sync；也可以直接让用户处理。')
  }
  if (value.commit !== undefined) lines.push(`本地 commit: ${value.commit}`)
  if (value.push !== undefined) lines.push(`远端 push: ${value.push}`)
  if (value.changed === true) {
    lines.push(value.restarted === true
      ? '本次 pull 拉取了新内容，TW 服务已自动重启（同端口），读取/搜索均为最新快照。'
      : '本次 pull 拉取了新内容，但 TW 服务未能自动重启（如需最新快照，请手动重启 TW）。')
  }
  if (value.restartError !== undefined) lines.push(`TW 重启失败: ${value.restartError}`)
  if (value.status !== undefined) {
    lines.push(`状态: ${gitStatusBits(value.status)}`)
    const s = value.status
    if (s.dirty && s.dirtyFiles.length > 0) lines.push(`  未提交: ${s.dirtyFiles.join(', ')}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

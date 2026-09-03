/**
 * The five `tiddlywiki_*` agent tools (design doc §11, D8) plus the extension
 * point: `registerTiddlywikiTools(ctx, deps)` registers tools list-style, so a
 * new tool is just one more `defineTool` in the array — index.ts never changes.
 *
 * RENDER CONTRACT (design doc §4.3): the registry feeds `output.render(args,
 * value)` into the loop — the model sees ONLY the rendered text, never the raw
 * JSON `value`. Every render must carry the complete facts an agent needs to
 * act (titles, tags, snippets, git state); a terse UI summary starves it.
 *
 * @module dsh-tiddlywiki/host/tools
 */
import { defineTool } from '../sdk.ts'
import type { TiddlyWebClient, Tiddler } from './tw-api.ts'
import type { GitFace } from './git.ts'

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

/** Strip dsh-tiddlywiki internal fields from a tiddler for the model. */
function pickFields(t: Tiddler): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(t)) {
    if (k === 'title' || k === 'text' || k === 'tags') continue
    out[k] = v
  }
  return out
}

export function registerTiddlywikiTools(ctx: ToolsCtx, deps: ToolsDeps): Array<() => void> {
  const disposers: Array<() => void> = []
  const register = (tool: unknown): void => { disposers.push(ctx.tools.register(tool)) }

  // ── tiddlywiki_search ────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_search',
    description: '检索 TiddlyWiki 持久知识库：按关键词（可选 tag 精确匹配）搜索非系统 tiddler，返回标题、标签与摘要片段。',
    parameters: {
      query: { type: 'string', description: '搜索关键词（大小写不敏感，子串匹配）', required: true },
      tag: { type: 'string', description: '可选：只返回带该 tag 的 tiddler' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: SearchResult) => {
        const lines = [`TiddlyWiki 搜索「${value.query}」${value.tag !== null ? ` (tag=${value.tag})` : ''}：命中 ${value.count} 条。`]
        if (value.results.length === 0) lines.push('没有匹配的 tiddler。')
        for (const r of value.results) {
          const tags = r.tags.length > 0 ? ` [${r.tags.join(', ')}]` : ''
          lines.push(`- ${r.title}${tags}`)
          if (r.snippet.length > 0) lines.push(`  ${r.snippet}`)
        }
        if (value.count > value.results.length) lines.push(`（另有 ${value.count - value.results.length} 条未展开，可用 tiddlywiki_get 读取具体标题）`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { query: string; tag?: string }): Promise<SearchResult> => {
      const wiki = deps.wiki()
      if (wiki === undefined) throw new Error('TiddlyWiki 服务未运行（tiddlywiki_status 可查）')
      const results = await wiki.search(args.query, args.tag)
      return {
        query: args.query,
        tag: args.tag ?? null,
        count: results.length,
        results: results.map((t) => ({ title: t.title, tags: t.tags ?? [], snippet: snippetOf(t.text ?? '') })),
      }
    },
  }))

  // ── tiddlywiki_get ───────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_get',
    description: '读取一个 TiddlyWiki tiddler 的完整内容（标题、全文、标签、自定义字段）。',
    parameters: {
      title: { type: 'string', description: 'tiddler 标题（精确匹配）', required: true },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: GetResult) => {
        if (value.notFound) return [{ type: 'text', text: `tiddler「${value.title}」不存在。可用 tiddlywiki_search 检索，或用 tiddlywiki_put 新建。` }]
        const lines = [`tiddler「${value.title}」`]
        if (value.tags.length > 0) lines.push(`标签: ${value.tags.join(', ')}`)
        const fields = Object.entries(value.fields)
        if (fields.length > 0) lines.push(`字段: ${fields.map(([k, v]) => `${k}=${String(v)}`).join(', ')}`)
        lines.push('--- 全文 ---')
        lines.push(value.text.length > 0 ? value.text : '（空）')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { title: string }): Promise<GetResult> => {
      const wiki = deps.wiki()
      if (wiki === undefined) throw new Error('TiddlyWiki 服务未运行（tiddlywiki_status 可查）')
      const t = await wiki.get(args.title)
      if (t === undefined) return { notFound: true, title: args.title, text: '', tags: [], fields: {} }
      return { notFound: false, title: t.title, text: t.text ?? '', tags: t.tags ?? [], fields: pickFields(t) }
    },
  }))

  // ── tiddlywiki_put ───────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_put',
    description: '写入（新建或覆盖）一个 TiddlyWiki tiddler。同名覆盖；tags 为标签数组，fields 为附加自定义字段（json 对象，会写入 tiddler 字段）。写入后触发自动 commit。',
    parameters: {
      title: { type: 'string', description: 'tiddler 标题（精确匹配，覆盖同名）', required: true },
      text: { type: 'string', description: 'tiddler 全文（wiki 文本）', required: true },
      tags: { type: 'array', items: { type: 'string' }, description: '标签数组（可选）' },
      fields: { type: 'json', description: '附加自定义字段，如 {"type":"meeting","date":"2026-09-02"}（可选）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: PutResult) => {
        const lines = [`已写入 tiddler「${value.title}」`]
        if (value.tags.length > 0) lines.push(`标签: ${value.tags.join(', ')}`)
        if (value.fields !== null) {
          const entries = Object.entries(value.fields)
          if (entries.length > 0) lines.push(`字段: ${entries.map(([k, v]) => `${k}=${String(v)}`).join(', ')}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { title: string; text: string; tags?: string[]; fields?: Record<string, unknown> }): Promise<PutResult> => {
      const wiki = deps.wiki()
      if (wiki === undefined) throw new Error('TiddlyWiki 服务未运行（tiddlywiki_status 可查）')
      const tiddler: Tiddler = { title: args.title, text: args.text }
      if (Array.isArray(args.tags) && args.tags.length > 0) tiddler.tags = args.tags
      if (args.fields !== undefined && typeof args.fields === 'object' && args.fields !== null) Object.assign(tiddler, args.fields)
      await wiki.put(tiddler)
      deps.autoCommit()
      return { ok: true, title: args.title, tags: args.tags ?? [], fields: args.fields ?? null }
    },
  }))

  // ── tiddlywiki_delete ────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_delete',
    description: '删除一个 TiddlyWiki tiddler（不存在时是幂等空操作）。删除后触发自动 commit。',
    parameters: {
      title: { type: 'string', description: 'tiddler 标题（精确匹配）', required: true },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: DeleteResult) => [{ type: 'text', text: `已删除 tiddler「${value.title}」。` }],
    },
    execute: async (args: { title: string }): Promise<DeleteResult> => {
      const wiki = deps.wiki()
      if (wiki === undefined) throw new Error('TiddlyWiki 服务未运行（tiddlywiki_status 可查）')
      await wiki.delete(args.title)
      deps.autoCommit()
      return { ok: true, title: args.title }
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

  return disposers
}

// ── tool result shapes + renders ───────────────────────────────────────────

interface SearchHit { title: string; tags: string[]; snippet: string }
interface SearchResult { query: string; tag: string | null; count: number; results: SearchHit[] }
interface GetResult { notFound: boolean; title: string; text: string; tags: string[]; fields: Record<string, unknown> }
interface PutResult { ok: boolean; title: string; tags: string[]; fields: Record<string, unknown> | null }
interface DeleteResult { ok: boolean; title: string }
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
  status?: { branch: string; dirty: boolean; dirtyFiles: string[]; remote: string; lastCommit?: string; ahead?: number; behind?: number }
}

function renderSync(value: SyncResult): Array<{ type: 'text'; text: string }> {
  const lines = [`git ${value.action}: ${value.ok ? '成功' : '失败'}`]
  lines.push(`  ${value.message}`)
  if (value.conflictFiles !== undefined && value.conflictFiles.length > 0) {
    lines.push(`冲突文件（rebase 已 abort，勿自动覆盖）:`)
    for (const f of value.conflictFiles) lines.push(`  - ${f}`)
    lines.push('处理方式：git checkout --ours <file> 保留本地，或人工编辑后 git add + git rebase --continue；也可以直接让用户处理。')
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
    const s = value.status
    const bits = [`分支 ${s.branch}`]
    if (s.ahead !== undefined) bits.push(`领先 ${s.ahead}`)
    if (s.behind !== undefined) bits.push(`落后 ${s.behind}`)
    if (s.dirty) bits.push(`工作区有 ${s.dirtyFiles.length} 个未提交改动`)
    if (s.lastCommit !== undefined) bits.push(`最近提交 ${s.lastCommit}`)
    lines.push(`状态: ${bits.join(' · ')}`)
    if (s.dirty && s.dirtyFiles.length > 0) lines.push(`  未提交: ${s.dirtyFiles.join(', ')}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

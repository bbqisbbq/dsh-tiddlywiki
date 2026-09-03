/**
 * The `tiddlywiki_*` agent tools (design doc §11, D8) plus the extension
 * point: `registerTiddlywikiTools(ctx, deps)` registers tools list-style, so a
 * new tool is just one more `defineTool` in the array — index.ts never changes.
 *
 * Toolset (v0.5):
 *   search / get / put / batch_put / rename / delete / recent / list_tags /
 *   git_sync / git_resolve
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

/** A put-ready copy of a tiddler (no created/modified, tags as array). */
function cleanTiddler(t: Tiddler): Tiddler {
  const out: Tiddler = { title: t.title, text: t.text ?? '', tags: t.tags ?? [] }
  if (typeof t.type === 'string') out.type = t.type
  for (const [k, v] of Object.entries(t)) {
    if (k === 'title' || k === 'text' || k === 'tags' || k === 'type' || k === 'created' || k === 'modified' || k === 'fields') continue
    out[k] = v
  }
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

export function registerTiddlywikiTools(ctx: ToolsCtx, deps: ToolsDeps): Array<() => void> {
  const disposers: Array<() => void> = []
  const register = (tool: unknown): void => { disposers.push(ctx.tools.register(tool)) }

  // ── tiddlywiki_search ────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_search',
    description: '检索 TiddlyWiki 持久知识库：按关键词（可选 tags 数组 / since 修改时间 / type / limit）搜索非系统 tiddler，返回标题、标签、修改时间与摘要片段。',
    parameters: {
      query: { type: 'string', description: '搜索关键词（大小写不敏感，子串匹配）', required: true },
      tags: { type: 'array', items: { type: 'string' }, description: '可选：要求同时包含的标签（AND）' },
      tag: { type: 'string', description: '可选：单个精确标签（与 tags 同为 AND）' },
      since: { type: 'string', description: '可选：ISO 时间（如 2026-09-01 或 2026-09-01T00:00:00Z），只返回修改时间不早于它的 tiddler' },
      type: { type: 'string', description: '可选：精确 tiddler 类型（默认 text/vnd.tiddlywiki）' },
      limit: { type: 'integer', description: '可选：返回条数上限（默认 30，最大 200）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: SearchResult) => {
        const filters: string[] = []
        if (value.tags.length > 0) filters.push(`tags=${value.tags.join(',')}`)
        if (value.since !== null) filters.push(`since=${value.since}`)
        if (value.type !== null) filters.push(`type=${value.type}`)
        const head = `TiddlyWiki 搜索「${value.query}」${filters.length > 0 ? ` (${filters.join(' · ')})` : ''}：命中 ${value.total} 条。`
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
    execute: async (args: { query: string; tags?: string[]; tag?: string; since?: string; type?: string; limit?: number }): Promise<SearchResult> => {
      const wiki = deps.wiki()
      if (wiki === undefined) throw new Error('TiddlyWiki 服务未运行（tiddlywiki_status 可查）')
      const { items, total } = await wiki.search(args.query, {
        tags: args.tags,
        tag: args.tag,
        since: args.since,
        type: args.type,
        limit: args.limit,
      })
      return {
        query: args.query,
        tags: args.tags ?? [],
        since: args.since ?? null,
        type: args.type ?? null,
        total,
        results: items.map((t) => ({ title: t.title, tags: t.tags ?? [], modified: typeof t.modified === 'string' ? t.modified : null, snippet: snippetOf(t.text ?? '') })),
      }
    },
  }))

  // ── tiddlywiki_recent ────────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_recent',
    description: '查看 TiddlyWiki 知识库最近修改的笔记（按修改时间倒序，排除系统 tiddler），返回标题、标签、修改时间与摘要。适合开工时快速了解近期动态。',
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
      const wiki = deps.wiki()
      if (wiki === undefined) throw new Error('TiddlyWiki 服务未运行（tiddlywiki_status 可查）')
      const items = await wiki.recent(args.limit ?? 15, args.since)
      return {
        since: args.since ?? null,
        results: items.map((t) => ({ title: t.title, tags: t.tags ?? [], modified: typeof t.modified === 'string' ? t.modified : null, snippet: snippetOf(t.text ?? '') })),
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
      const wiki = deps.wiki()
      if (wiki === undefined) throw new Error('TiddlyWiki 服务未运行（tiddlywiki_status 可查）')
      const tags = await wiki.listTags()
      return { count: tags.length, tags }
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
        if (value.modified !== null) lines.push(`修改: ${value.modified}`)
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
      if (t === undefined) return { notFound: true, title: args.title, text: '', tags: [], fields: {}, modified: null }
      return { notFound: false, title: t.title, text: t.text ?? '', tags: t.tags ?? [], fields: pickFields(t), modified: typeof t.modified === 'string' ? t.modified : null }
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

  // ── tiddlywiki_batch_put ─────────────────────────────────────────────────
  register(defineTool({
    name: 'tiddlywiki_batch_put',
    description: '批量写入/覆盖多个 TiddlyWiki tiddler（一次工具调用）。overwrite=false 时跳过已存在的标题；返回逐条结果。写入后触发自动 commit。',
    parameters: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          description: '要写入的 tiddler 数组',
          properties: {
            title: { type: 'string', description: '标题（精确匹配，覆盖同名）', required: true },
            text: { type: 'string', description: '全文（wiki 文本）', required: true },
            tags: { type: 'array', items: { type: 'string' }, description: '标签数组（可选）' },
            fields: { type: 'json', description: '附加自定义字段（可选）' },
          },
        },
      },
      overwrite: { type: 'boolean', description: '可选：true=覆盖同名（默认），false=跳过已存在的标题' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value: BatchResult) => {
        const lines = [`批量写入完成：成功 ${value.written}，跳过 ${value.skipped}，共 ${value.items.length} 条。`]
        for (const r of value.items) {
          lines.push(`- ${r.title}：${r.written ? '已写入' : '已跳过（存在）'}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { items: Array<{ title: string; text: string; tags?: string[]; fields?: Record<string, unknown> }>; overwrite?: boolean }): Promise<BatchResult> => {
      const wiki = deps.wiki()
      if (wiki === undefined) throw new Error('TiddlyWiki 服务未运行（tiddlywiki_status 可查）')
      const list = Array.isArray(args.items) ? args.items : []
      if (list.length === 0) return { ok: true, written: 0, skipped: 0, items: [] }
      const overwrite = args.overwrite !== false
      const results: Array<{ title: string; written: boolean; skipped: boolean }> = []
      let written = 0
      let skipped = 0
      for (const item of list) {
        if (typeof item.title !== 'string' || item.title.length === 0) throw new Error('batch_put: 每条 items 都需要非空 title')
        if (typeof item.text !== 'string') throw new Error(`batch_put: items「${item.title}」缺少 text`)
        if (!overwrite) {
          const existing = await wiki.get(item.title).catch(() => undefined)
          if (existing !== undefined) {
            skipped++
            results.push({ title: item.title, written: false, skipped: true })
            continue
          }
        }
        const tiddler: Tiddler = { title: item.title, text: item.text }
        if (Array.isArray(item.tags) && item.tags.length > 0) tiddler.tags = item.tags
        if (item.fields !== undefined && typeof item.fields === 'object' && item.fields !== null) Object.assign(tiddler, item.fields)
        await wiki.put(tiddler)
        written++
        results.push({ title: item.title, written: true, skipped: false })
      }
      deps.autoCommit()
      return { ok: true, written, skipped, items: results }
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
      const wiki = deps.wiki()
      if (wiki === undefined) throw new Error('TiddlyWiki 服务未运行（tiddlywiki_status 可查）')
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
        if (value.status !== undefined) {
          const s = value.status
          const bits = [`分支 ${s.branch}`]
          if (s.ahead !== undefined) bits.push(`领先 ${s.ahead}`)
          if (s.behind !== undefined) bits.push(`落后 ${s.behind}`)
          if (s.dirty) bits.push(`工作区有 ${s.dirtyFiles.length} 个未提交改动`)
          if (s.lastCommit !== undefined) bits.push(`最近提交 ${s.lastCommit}`)
          lines.push(`状态: ${bits.join(' · ')}`)
        }
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
interface SearchResult { query: string; tags: string[]; since: string | null; type: string | null; total: number; results: SearchHit[] }
interface RecentResult { since: string | null; results: SearchHit[] }
interface TagListResult { count: number; tags: Array<{ tag: string; count: number }> }
interface GetResult { notFound: boolean; title: string; text: string; tags: string[]; fields: Record<string, unknown>; modified: string | null }
interface PutResult { ok: boolean; title: string; tags: string[]; fields: Record<string, unknown> | null }
interface BatchResult { ok: boolean; written: number; skipped: number; items: Array<{ title: string; written: boolean; skipped: boolean }> }
interface RenameResult { ok: boolean; from: string; to: string; refsUpdated: number; refsTiddlers: number; warning?: string }
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
interface ResolveResult {
  ok: boolean
  action: string
  message: string
  files?: string[]
  commit?: string
  hint?: string
  status?: { branch: string; dirty: boolean; dirtyFiles: string[]; remote: string; lastCommit?: string; ahead?: number; behind?: number }
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

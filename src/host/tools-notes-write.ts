/**
 * Note WRITE tools: `get` / `put` / `batch_put`.
 *
 * v0.30.7：从 	ools-notes.ts **纯搬迁**拆出（职责分组），函数体一字未改。
 * 原来的文件变成 barrel，	ools.ts 的注册顺序与导入路径都没变。
 *
 * @module dsh-tiddlywiki/host/tools-notes-write
 */
import { defineTool } from '../sdk.ts'
import { isBinaryType, toIsoDateString } from './tw-api.ts'
import { isBlockedProxyTitle } from './proxy-guard.ts'
import { assertNoConflict, buildWriteTiddler, normalizeTagArg } from './write-policy.ts'
import { WORKSPACE_FIELD, WORKSPACE_TAG_PREFIX } from './workspace.ts'
import { normalizeBatchItemsFields, normalizeFieldsInArgs, pickFields, sessionIdOf, typeChangeOf, withWorkspaceMark, workspaceMarkFor } from './tools-support.ts'
import type { BatchItemResult, BatchResult, GetResult, PutResult, ToolEnv } from './tools-support.ts'

export function getTool(env: ToolEnv) {
  const { requireWiki } = env
  // ── tiddlywiki_get ───────────────────────────────────────────────────────
  return defineTool({
    name: 'tiddlywiki_get',
    description: '读取一个 TiddlyWiki tiddler 的完整内容（标题、全文、标签、自定义字段）。二进制 tiddler（图片等附件）只返回元数据，不返回 base64 正文。',
    parameters: {
      title: { type: 'string', description: 'tiddler 标题（精确匹配）', required: true },
    },
    output: {
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
    execute: async (args: { title: string }, exec: unknown): Promise<GetResult> => {
      // Ironclad rule #6 (v0.29.0): every path that turns a caller-supplied
      // title into TW output runs the secret-namespace guard. `/get`, `/tw`,
      // `/api` and `/render` already did; the tool did not, so the MODEL could
      // read `$:/plugins/dsh-tiddlywiki/config` (bridge/ui/wechat tokens +
      // a credentialed git remote) that those routes exist to hide.
      if (isBlockedProxyTitle(args.title)) {
        throw new Error(
          `tiddlywiki_get: 「${args.title}」属于插件自身命名空间（$:/plugins/dsh-tiddlywiki/），可能含密钥，工具层拒绝读取。需要看配置请让人类在 DSH 设置页查看。`,
        )
      }
      const wiki = requireWiki(sessionIdOf(exec))
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
  })
}

export function putTool(env: ToolEnv) {
  const { deps, requireWiki } = env
  // ── tiddlywiki_put ───────────────────────────────────────────────────────
  return defineTool({
    name: 'tiddlywiki_put',
    description: '写入（新建或覆盖）一个 TiddlyWiki tiddler。同名覆盖；**覆盖已有条目时，未传的 tags / 自定义字段 / 内容类型都会原样保留**（不会静默丢掉笔记原有的标签、字段或 type；显式传 tags 才整体替换标签，**传空数组 [] 表示清空全部标签**）。写入后触发防抖自动 commit（默认 60s；手动同步用 tiddlywiki_git_sync）。新建（title 不存在）时自动补打 agent-written 标签标记「由 Agent 撰写」，无需手动添加；同时按当前会话工作目录自动打 `ws/<项目名>` 工作区标签与 `workspace` 字段（可用配置 `note.workspaceMark` 关闭；要归到别的项目就显式传 fields.workspace）。内容类型：**只有新建**条目且未指定时才默认 text/markdown（$:/ 系统条目除外）——覆盖 text/css、wikitext 等既有条目时保持原类型；要改类型用 fields 传 {"type":"..."}。⚠️ fields.type 是 TW 的内容类型保留字段，不要把业务分类值（如 "meeting"）写进去——业务分类请放 tags。',
    parameters: {
      title: { type: 'string', description: 'tiddler 标题（精确匹配，覆盖同名）', required: true },
      text: { type: 'string', description: 'tiddler 全文（默认按 Markdown 解析）', required: true },
      tags: { type: 'array', items: { type: 'string' }, description: '标签数组（可选）。不传 = 保留既有条目的原标签；传空数组 [] = 清空全部标签；有内容 = 整体替换' },
      fields: { type: 'object', additionalProperties: true, description: '附加自定义字段，如 {"date":"2026-09-02"}（可选）。fields.type 是**改内容类型的正规入口**（如 {"type":"text/css"}）：新建条目未指定时默认 text/markdown，覆盖既有条目时保留原类型。注意不要把业务分类值（如 "meeting"）写进 type——业务分类请放 tags' },
      expectedModified: { type: 'string', description: '可选：乐观并发保护。传 tiddlywiki_get 读到的 modified 值，若该条目已被他人改动则拒绝写入（避免覆盖人类在 TW 编辑器里的修改）' },
      expectedRevision: { type: 'integer', description: '可选：乐观并发保护的另一种令牌——传 tiddlywiki_get 返回字段里的 revision（刚写入、还没落盘的条目没有 modified，此时用 revision）' },
      force: { type: 'boolean', description: '可选：true 时忽略 expectedModified/expectedRevision 强制覆盖（默认 false）' },
    },
    // v0.26.5: `fields` 是对象，但模型可能按 JSON 字符串发来（历史遗留），
    // 归一化必须发生在 schema 预校验之前——见 normalizeFieldsArg。
    normalizeArgs: normalizeFieldsInArgs,
    output: {
      render: (_args, value: PutResult) => {
        const lines = [`已写入 tiddler「${value.title}」`]
        if (value.workspace !== undefined) lines.push(`已自动标记工作区: ${WORKSPACE_TAG_PREFIX}${value.workspace}（字段 ${WORKSPACE_FIELD}）`)
        if (value.tags.length > 0) lines.push(`标签: ${value.tags.join(', ')}`)
        if (value.type !== null) lines.push(`类型: ${value.type}${value.typeDefaulted === true ? '（新建且未指定，已默认 markdown）' : ''}`)
        // 覆盖时若类型真的变了，必须说出来（v0.20.1）——内容类型决定解析方式，
        // 静默变化会让 CSS/JS 被当 Markdown、Markdown 笔记被当 wikitext。
        if (value.typeChanged !== undefined) lines.push(`⚠️ 内容类型已从 ${value.typeChanged.from} 改为 ${value.typeChanged.to}（覆盖前请确认这是你要的）`)
        if (value.fields !== null) {
          const entries = Object.entries(value.fields)
          if (entries.length > 0) lines.push(`字段: ${entries.map(([k, v]) => `${k}=${String(v)}`).join(', ')}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { title: string; text: string; tags?: string[]; fields?: Record<string, unknown>; expectedModified?: string; expectedRevision?: number; force?: boolean }, exec: unknown): Promise<PutResult> => {
      const wiki = requireWiki(sessionIdOf(exec))
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
      // DATA SAFETY (v0.23.5): a binary tiddler (image/PDF/…) holds base64 in
      // `text`. Writing prose into it keeps `type: image/png` (the write policy
      // preserves the base type on purpose), so the result is an attachment whose
      // base64 no longer decodes — the image breaks and the receipt reports
      // "type unchanged". Refusing is the only honest answer: overwriting an
      // attachment is `tiddlywiki_attach`'s job. An explicit `fields.type` that
      // leaves the binary family (or force) is treated as a deliberate conversion.
      if (existing !== undefined && isBinaryType(typeof existing.type === 'string' ? existing.type : undefined)) {
        const wantedType = typeof args.fields?.type === 'string' ? args.fields.type : undefined
        const deliberate = args.force === true || (wantedType !== undefined && !isBinaryType(wantedType))
        if (!deliberate) {
          throw new Error(
            `tiddlywiki_put: 「${args.title}」是二进制附件（type=${String(existing.type)}，正文为 base64），`
            + '直接写文本会把附件写坏。要替换附件请用 tiddlywiki_attach；'
            + '确实要转成文本条目，请显式传 fields: {"type":"text/markdown"}（或 force: true）。',
          )
        }
      }
      const marked = existing === undefined && !args.title.startsWith('$:/')
        ? withWorkspaceMark(workspaceMarkFor(deps, exec), tags, args.fields)
        : { tags, fields: args.fields }
      const { tiddler, typeDefaulted } = buildWriteTiddler(args.title, args.text, { existing, tags: marked.tags, fields: marked.fields })
      await wiki.put(tiddler)
      deps.autoCommit()
      return {
        ok: true,
        title: args.title,
        tags: tiddler.tags ?? [],
        type: typeof tiddler.type === 'string' ? tiddler.type : null,
        ...(typeDefaulted ? { typeDefaulted: true } : {}),
        ...typeChangeOf(existing, tiddler),
        fields: marked.fields ?? null,
        ...(marked.workspace !== undefined ? { workspace: marked.workspace } : {}),
      }
    },
  })
}

export function batchPutTool(env: ToolEnv) {
  const { deps, requireWiki } = env
  // ── tiddlywiki_batch_put ─────────────────────────────────────────────────
  return defineTool({
    name: 'tiddlywiki_batch_put',
    description: '批量写入/覆盖多个 TiddlyWiki tiddler（一次工具调用）。overwrite=false 时跳过已存在的标题；返回逐条结果（单条失败不影响其余条目，失败原因逐条列出）。写入后触发防抖自动 commit（默认 60s）。新建（title 不存在）的条目会自动补打 agent-written 标签与 `ws/<项目名>` 工作区标记，无需手动添加。内容类型：只有**新建**条目未指定 fields.type 时才默认 text/markdown（$:/ 系统条目除外）；**覆盖既有条目时保留其原有 type/tags/自定义字段**。每条目可带 `expectedModified`（来自 tiddlywiki_get）做乐观并发保护：该条在你读取后被改过就只让这一条失败，其余照常写入。条目内传 `tags: []` 表示清空该条目的标签。',
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
            tags: { type: 'array', items: { type: 'string' }, description: '标签数组（可选）。不传 = 保留原标签；传空数组 [] = 清空全部标签' },
            fields: { type: 'object', additionalProperties: true, description: '附加自定义字段（可选）。注意：fields.type 是 TW 内容类型（保留字段，默认已自动补 text/markdown），不要写业务分类值' },
            expectedModified: { type: 'string', description: '可选（v0.25.0）：该条目的乐观并发令牌，来自 tiddlywiki_get 的 modified。覆盖已存在条目时若已被改动，只让这一条失败并说明原因，其余条目照常' },
          },
        },
      },
      overwrite: { type: 'boolean', description: '可选：true=覆盖同名（默认），false=跳过已存在的标题' },
    },
    normalizeArgs: (args) => ({ ...args, items: normalizeBatchItemsFields(args.items) }),
    output: {
      render: (_args, value: BatchResult) => {
        const lines = [`批量写入完成：成功 ${value.written}，跳过 ${value.skipped}，失败 ${value.failed}，共 ${value.items.length} 条。`]
        for (const r of value.items) {
          const ws = r.workspace !== undefined ? `（已标记工作区 ${WORKSPACE_TAG_PREFIX}${r.workspace}）` : ''
          lines.push(`- ${r.title}：${r.written ? `已写入${ws}` : r.skipped ? '已跳过（存在）' : `失败（${r.error ?? '未知错误'}）`}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { items: Array<{ title: string; text: string; tags?: string[]; fields?: Record<string, unknown>; expectedModified?: string }>; overwrite?: boolean }, exec: unknown): Promise<BatchResult> => {
      const wiki = requireWiki(sessionIdOf(exec))
      const list = Array.isArray(args.items) ? args.items : []
      if (list.length === 0) return { ok: true, written: 0, skipped: 0, failed: 0, items: [] }
      const overwrite = args.overwrite !== false
      const results: BatchItemResult[] = new Array<BatchItemResult>(list.length)
      let written = 0
      let skipped = 0
      let failed = 0
      // One item failing (validation, network, a rejected title) must not lose
      // the report of the items that DID land — the model needs per-item truth.
      //
      // BOUNDED CONCURRENCY (v0.19.5): the previous sequential loop issued 2N
      // REST round-trips (a GET + a PUT per item) — a 200-item import spent
      // minutes in request latency. Four workers share the same client (its
      // listing caches are invalidated per write, which only costs a refetch),
      // and results are stored BY INDEX so the report keeps the caller's order
      // regardless of completion order.
      const writeOne = async (item: { title: string; text: string; tags?: string[]; fields?: Record<string, unknown>; expectedModified?: string }, index: number): Promise<void> => {
        const title = typeof item?.title === 'string' ? item.title : ''
        try {
          if (title.length === 0) throw new Error('缺少非空 title')
          if (typeof item.text !== 'string') throw new Error('缺少 text')
          // Read WITHOUT swallowing errors: only a 404 means "new tiddler".
          const existing = await wiki.get(title)
          if (!overwrite && existing !== undefined) {
            skipped++
            results[index] = { title, written: false, skipped: true, failed: false }
            return
          }
          // Per-item optimistic guard (v0.25.0): an overwrite built from a stale
          // read silently reverts whatever a human changed in between. A mismatch
          // fails THIS item only (the batch contract keeps the others) — which is
          // why the check lives inside the per-item try, not before the loop.
          assertNoConflict(title, existing, { expectedModified: item.expectedModified })
          const marked = existing === undefined && !title.startsWith('$:/')
            ? withWorkspaceMark(workspaceMarkFor(deps, exec), normalizeTagArg(item.tags), item.fields)
            : { tags: normalizeTagArg(item.tags), fields: item.fields }
          const { tiddler } = buildWriteTiddler(title, item.text, { existing, tags: marked.tags, fields: marked.fields })
          await wiki.put(tiddler)
          written++
          results[index] = { title, written: true, skipped: false, failed: false, ...(marked.workspace !== undefined ? { workspace: marked.workspace } : {}) }
        } catch (err) {
          failed++
          results[index] = { title: title.length > 0 ? title : '(无标题)', written: false, skipped: false, failed: true, error: err instanceof Error ? err.message : String(err) }
        }
      }
      const workers = Math.max(1, Math.min(4, list.length))
      let next = 0
      await Promise.all(Array.from({ length: workers }, async () => {
        for (;;) {
          const index = next++
          if (index >= list.length) return
          await writeOne(list[index] as { title: string; text: string }, index)
        }
      }))
      deps.autoCommit()
      return { ok: failed === 0, written, skipped, failed, items: results }
    },
  })
}

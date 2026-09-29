/**
 * Note read/write `tiddlywiki_*` tools: get / put / batch_put / append / rename /
 * delete / trash.
 *
 * Split out of `tools.ts` in v0.28.8 — pure code move, bodies unchanged.
 *
 * @module dsh-tiddlywiki/host/tools-notes
 */
import { defineTool } from '../sdk.ts'
import { isBinaryType, toIsoDateString } from './tw-api.ts'
import { isBlockedProxyTitle } from './proxy-guard.ts'
import { assertNoConflict, buildWriteTiddler, normalizeTagArg } from './write-policy.ts'
import { WORKSPACE_FIELD, WORKSPACE_TAG_PREFIX } from './workspace.ts'
import {
  TRASH_INDEX_TITLE,
  TRASH_PREFIX,
  TrashIndexUnavailableError,
  insertIntoSection,
  normalizeBatchItemsFields,
  normalizeFieldsInArgs,
  pickFields,
  readTrashIndex,
  rewriteRefs,
  sessionIdOf,
  trashTitleFor,
  typeChangeOf,
  withWorkspaceMark,
  workspaceMarkFor,
  writeTrashIndex,
} from './tools-support.ts'
import type {
  AppendResult,
  BatchItemResult,
  BatchResult,
  DeleteResult,
  GetResult,
  PutResult,
  RenameResult,
  ToolEnv,
  TrashResult,
} from './tools-support.ts'

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

export function renameTool(env: ToolEnv) {
  const { deps, requireWiki } = env
  // ── tiddlywiki_rename ────────────────────────────────────────────────────
  return defineTool({
    name: 'tiddlywiki_rename',
    description: '重命名一个 TiddlyWiki tiddler：把旧标题的内容复制到新标题、删除旧标题，并可选地更新其他 tiddler 里的 [[旧标题]] / {{旧标题}} 引用（最佳努力）。引用更新会逐个整篇回写引用者，所以每个引用者在写入前都会重新读一次：**遍历期间被改动过的会被跳过而不是覆盖**，跳过数量在回执里报告。',
    parameters: {
      oldTitle: { type: 'string', description: '当前标题', required: true },
      newTitle: { type: 'string', description: '新标题', required: true },
      updateRefs: { type: 'boolean', description: '可选：是否同步更新其他 tiddler 里的引用（默认 true）' },
      expectedModified: { type: 'string', description: '可选（v0.25.0）：旧标题的乐观并发令牌，传 tiddlywiki_get 读到的 modified；不匹配则拒绝重命名（避免把人类刚改过的正文写进新标题）' },
      expectedRevision: { type: 'integer', description: '可选：乐观并发保护的另一种令牌——tiddlywiki_get 返回字段里的 revision' },
      force: { type: 'boolean', description: '可选：true 时忽略 expectedModified/expectedRevision 强制重命名（默认 false）' },
    },
    output: {
      render: (_args, value: RenameResult) => {
        const lines = [`已重命名「${value.from}」→「${value.to}」`]
        lines.push(`更新了 ${value.refsUpdated} 处引用（${value.refsTiddlers} 个 tiddler）`)
        if ((value.refsSkipped ?? 0) > 0) {
          const names = (value.skippedTitles ?? []).join('、')
          lines.push(`跳过了 ${value.refsSkipped} 个引用者（遍历期间被改动过，未覆盖）${names.length > 0 ? `：${names}` : ''}`)
        }
        if (value.warning !== undefined) lines.push(`注意: ${value.warning}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { oldTitle: string; newTitle: string; updateRefs?: boolean; expectedModified?: string; expectedRevision?: number; force?: boolean }, exec: unknown): Promise<RenameResult> => {
      const wiki = requireWiki(sessionIdOf(exec))
      const { oldTitle, newTitle } = args
      if (oldTitle === newTitle) return { ok: true, from: oldTitle, to: newTitle, refsUpdated: 0, refsTiddlers: 0 }
      const existing = await wiki.get(oldTitle)
      if (existing === undefined) throw new Error(`tiddler「${oldTitle}」不存在`)
      // The rename re-writes the OLD note's body under the NEW title: an edit that
      // landed after the caller's read would be lost silently (v0.25.0).
      assertNoConflict(oldTitle, existing, {
        expectedModified: args.expectedModified,
        expectedRevision: args.expectedRevision,
        force: args.force,
      })
      const target = await wiki.get(newTitle)
      if (target !== undefined) throw new Error(`新标题「${newTitle}」已存在（可先用 tiddlywiki_delete 删除）`)
      let refsUpdated = 0
      let refsTiddlers = 0
      let refsSkipped = 0
      const skippedTitles: string[] = []
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
            // The list is a SNAPSHOT (and may come from the client's short-TTL
            // listing cache): re-read this referrer and skip it when it changed
            // since. A skipped link is recoverable by hand; a silently clobbered
            // paragraph is not (v0.25.0).
            const fresh = await wiki.get(t.title)
            if (fresh === undefined) continue
            if (fresh.modified !== t.modified) {
              refsSkipped++
              skippedTitles.push(t.title)
              continue
            }
            // Shared policy (v0.22.10): a rewrite of the note's text is an
            // overwrite — keep its `created`, refresh `modified`, and preserve
            // tags/custom fields/type. Hand-building the PUT (the old
            // `cleanTiddler(t)` + text) carried the STALE `modified` through.
            const { tiddler } = buildWriteTiddler(t.title, rewritten.text, { existing: fresh })
            await wiki.put(tiddler)
            refsUpdated += rewritten.count
            refsTiddlers++
          }
        }
      }
      // Renaming is an overwrite from the new title's point of view: TW's own
      // rename keeps the source's `created` and stamps a fresh `modified`
      // (`new $tw.Tiddler(getCreationFields(), tiddler, {...}, getModificationFields())`).
      const { tiddler: renamed } = buildWriteTiddler(newTitle, existing.text ?? '', { existing })
      await wiki.put(renamed)
      // The new title is already written; a failure here leaves BOTH copies on
      // disk, so report the partial state instead of throwing a bare error (the
      // caller would otherwise assume the rename never happened) — v0.19.5.
      let deleteFailed: string | undefined
      try {
        await wiki.delete(oldTitle)
      } catch (err) {
        deleteFailed = err instanceof Error ? err.message : String(err)
      }
      // v0.29.0: only a scan can conclude "nothing references the old title".
      // With `updateRefs: false` nothing was scanned, so the old condition
      // (`refsTiddlers === 0 && refsSkipped === 0`) was vacuously true and the
      // receipt LIED — it told the model there were no references while every
      // referrer still pointed at the old title.
      if (args.updateRefs === false) {
        warning = 'updateRefs=false：已跳过引用更新，其它笔记里指向旧标题的链接仍然指向旧标题，需要时请手动处理（或重新执行一次不传 updateRefs 的重命名）。'
      } else if (refsTiddlers === 0 && refsSkipped === 0) {
        warning = '未找到任何其他 tiddler 引用旧标题；如确实需要，可手动补充链接。'
      }
      if (refsSkipped > 0) {
        const note = `有 ${refsSkipped} 个引用者因在遍历期间被改动而跳过（${skippedTitles.join('、')}），它们里面仍指向旧标题，请手动确认或重跑一次重命名。`
        warning = warning === undefined ? note : `${warning} ${note}`
      }
      if (deleteFailed !== undefined) {
        const partial = `新标题「${newTitle}」已写入，但旧标题「${oldTitle}」删除失败（${deleteFailed}）：现在两个标题都存在同一份内容，请手动删除旧标题。`
        warning = warning === undefined ? partial : `${warning} ${partial}`
      }
      deps.autoCommit()
      return {
        ok: true,
        from: oldTitle,
        to: newTitle,
        refsUpdated,
        refsTiddlers,
        ...(refsSkipped > 0 ? { refsSkipped, skippedTitles } : {}),
        ...(warning !== undefined ? { warning } : {}),
      }
    },
  })
}

export function deleteTool(env: ToolEnv) {
  const { deps, requireWiki } = env
  // ── tiddlywiki_delete ────────────────────────────────────────────────────
  return defineTool({
    name: 'tiddlywiki_delete',
    description: '删除一个 TiddlyWiki tiddler（不存在时是幂等空操作）。默认是**软删除**：内容移入回收站（$:/dsh-tiddlywiki/trash/…，不再出现在检索/最近列表里）后删除原条目，可用 tiddlywiki_trash 恢复；permanent=true 才真正永久删除。删除后触发自动 commit。⚠️ 例外：`$:/` 系统条目不进回收站（回收站的约定是只收普通笔记，且系统标题无法被枚举），删除它们等同于 permanent=true——只有 git 历史可回退。',
    parameters: {
      title: { type: 'string', description: 'tiddler 标题（精确匹配）', required: true },
      permanent: { type: 'boolean', description: '可选：true = 永久删除（回收站也拿不回来，仅剩 git 历史）；默认 false = 移入回收站' },
      expectedModified: { type: 'string', description: '可选：乐观并发保护。传 tiddlywiki_get 读到的 modified；若条目在你读取之后被改动（人类在 TW 编辑器里改过）则拒绝删除' },
      expectedRevision: { type: 'integer', description: '可选：乐观并发保护的另一种令牌——传 tiddlywiki_get 返回字段里的 revision' },
      force: { type: 'boolean', description: '可选：true 时忽略 expectedModified/expectedRevision 强制删除（默认 false）' },
    },
    output: {
      render: (_args, value: DeleteResult) => [{
        type: 'text',
        text: value.trashed === true
          ? `已把 tiddler「${value.title}」移入回收站（$:/dsh-tiddlywiki/trash/，可用 tiddlywiki_trash action=restore 恢复）。`
          : `已永久删除 tiddler「${value.title}」。`,
      }],
    },
    execute: async (args: { title: string; permanent?: boolean; expectedModified?: string; expectedRevision?: number; force?: boolean }, exec: unknown): Promise<DeleteResult> => {
      const wiki = requireWiki(sessionIdOf(exec))
      const existing = await wiki.get(args.title)
      // Deleting something the caller never saw is fine only when it does not
      // exist; a token means the note WAS read, so a changed revision since then
      // must abort (v0.19.5 — delete used to have no concurrency protection at
      // all, while put/batch_put did: `get` → human edits in TW → `delete` threw
      // the human's work into the trash with no warning).
      assertNoConflict(args.title, existing, {
        expectedModified: args.expectedModified,
        expectedRevision: args.expectedRevision,
        force: args.force,
      })
      // Trash entries themselves and SYSTEM tiddlers are never nested.
      // v0.23.5: the condition used to only exclude TRASH_PREFIX, so
      // `delete('$:/dsh-tiddlywiki/trash-index')` trashed the index itself —
      // the next read then 404s, looks like "trash is empty", and the index is
      // rewritten with a single entry, silently dropping every record (exactly
      // the loss v0.19.5 set out to prevent, just through another door).
      const canTrash = existing !== undefined
        && args.permanent !== true
        && !args.title.startsWith(TRASH_PREFIX)
        && !args.title.startsWith('$:/')
      // The trash index is the ONLY way to enumerate what is in the trash
      // (`$:/` tiddlers cannot be listed through a recipe — see the module
      // docblock). Deleting it orphans every trashed note: `trash list` can no
      // longer see them, `restore` cannot find them, `empty` cannot clean them.
      // Use `tiddlywiki_trash action=empty` to clear the trash deliberately.
      if (args.title === TRASH_INDEX_TITLE && existing !== undefined) {
        throw new Error(
          `tiddlywiki_delete: 「${TRASH_INDEX_TITLE}」是回收站索引，删掉它会让回收站里的条目全部变成不可恢复的孤儿`
          + '（列不出、恢复不了、也清不掉）。要清空回收站请用 tiddlywiki_trash action=empty；'
          + '确实要丢弃索引请显式传 permanent: true。',
        )
      }
      if (!canTrash) {
        await wiki.delete(args.title)
        deps.autoCommit()
        return { ok: true, title: args.title, trashed: false }
      }
      const trashTitle = trashTitleFor(args.title)
      const at = new Date().toISOString()
      // ORDER MATTERS (v0.23.5, data safety): read + validate the index BEFORE
      // any destructive step. The old order trashed the note first and only then
      // read the index, so a failed/corrupt read aborted the tool AFTER the
      // original was already gone and BEFORE the index recorded it — the note
      // became an unreachable orphan (`trash list` cannot see it, `restore`
      // cannot find it, `empty` cannot clean it), while the tool reported
      // "aborted". Aborting first means the note simply is not deleted.
      const index = await readTrashIndex(wiki)
      if (!index.readOk || index.corrupted) throw new TrashIndexUnavailableError()
      // The snapshot is a COPY: it keeps the original's created/modified (they
      // describe the note — deleting must not rewrite its history, and a later
      // restore must bring the note back with the same times). `trash-at` records
      // when it was deleted. buildWriteTiddler refreshes `modified` to now (it
      // cannot tell a copy from an edit), so put the original back explicitly.
      const { tiddler: trashTiddler } = buildWriteTiddler(trashTitle, existing.text ?? '', { existing })
      trashTiddler.created = existing.created ?? trashTiddler.created
      trashTiddler.modified = existing.modified ?? trashTiddler.modified
      await wiki.put({ ...trashTiddler, 'trash-of': args.title, 'trash-at': at })
      await wiki.delete(args.title)
      index.entries.push({ trash: trashTitle, of: args.title, at })
      await writeTrashIndex(wiki, index.entries)
      deps.autoCommit()
      return { ok: true, title: args.title, trashed: true, trashTitle }
    },
  })
}

export function trashTool(env: ToolEnv) {
  const { deps, requireWiki } = env
  // ── tiddlywiki_trash ─────────────────────────────────────────────────────
  return defineTool({
    name: 'tiddlywiki_trash',
    description: '回收站（软删除的笔记）：action=list 列出、action=restore 恢复某条、action=empty 清空。配合 tiddlywiki_delete（默认软删除）使用。',
    parameters: {
      action: { type: 'string', enum: ['list', 'restore', 'empty'], description: 'list=列出回收站；restore=恢复（需 title）；empty=永久清空', required: true },
      title: { type: 'string', description: 'action=restore 时的原标题（也接受回收站标题）' },
      limit: { type: 'integer', description: 'action=list 的返回上限（默认 30，最大 200）' },
    },
    output: {
      render: (_args, value: TrashResult) => {
        const lines = [`回收站 ${value.action}：${value.message}`]
        for (const item of value.items ?? []) lines.push(`- ${item.title}（删除于 ${item.at ?? '?'}${item.of !== undefined ? `，原名「${item.of}」` : ''}）`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { action: 'list' | 'restore' | 'empty'; title?: string; limit?: number }, exec: unknown): Promise<TrashResult> => {
      const wiki = requireWiki(sessionIdOf(exec))
      const index = await readTrashIndex(wiki)
      // A failed/corrupt index must never be treated as「回收站是空的」: `empty`
      // would then report success while doing nothing, and `restore` would claim
      // the note was never trashed (v0.19.5).
      if (!index.readOk) throw new TrashIndexUnavailableError()
      if (index.corrupted) {
        throw new Error('回收站索引已损坏（JSON 解析失败），本次操作已中止以免误删记录；可手动检查 $:/dsh-tiddlywiki/trash-index 后重试。')
      }
      const indexed = index.entries
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
      // A restore means「恢复原状」: bring the note back with the SAME
      // created/modified it had before deletion. The trash snapshot deliberately
      // preserved both (see the delete branch), so restoring must not stamp a new
      // modified — otherwise that preservation would be pointless and a restored
      // note would jump to the top of every「最近修改」view as if it were edited.
      // Both fields are still guaranteed present: `buildWriteTiddler` stamps a
      // legacy snapshot that lacks them, and `put()` is the final safety net.
      const { tiddler: restored } = buildWriteTiddler(match.of, stored.text ?? '', { existing: stored })
      restored.created = stored.created ?? restored.created
      restored.modified = stored.modified ?? restored.modified
      delete restored['trash-of']
      delete restored['trash-at']
      await wiki.put(restored)
      await wiki.delete(match.trash)
      await writeTrashIndex(wiki, indexed.filter((entry) => entry.trash !== match.trash))
      deps.autoCommit()
      return { action: 'restore', message: `已恢复「${match.of}」`, items: [] }
    },
  })
}

export function appendTool(env: ToolEnv) {
  const { deps, requireWiki } = env
  // ── tiddlywiki_append ────────────────────────────────────────────────────
  return defineTool({
    name: 'tiddlywiki_append',
    description: '向已有 tiddler 追加/前插文本，或写入指定标题段落的末尾（无需先读全文、不会整篇覆盖）——适合日志、批注、清单的增量写入。条目不存在时默认新建（createIfMissing=false 则报错）。**写入既有条目走与 tiddlywiki_put 同一套写策略**：原有 tags、自定义字段与**内容类型**全部保留（不会把 Markdown 笔记改成 wikitext、也不会把 CSS 改成 Markdown）；可用 fields 显式覆盖字段/类型。新建条目未指定内容类型时才默认 text/markdown（并像 tiddlywiki_put 一样自动补 agent-written 与 `ws/<项目名>` 工作区标记）。⚠️ 本工具内部是「读全文 → 整篇回写」，属于覆盖写入：改前请先 `tiddlywiki_get`，并把读到的 `modified` 作为 `expectedModified` 传回（v0.25.0 起支持），否则人类在 TW 编辑器里的并发修改会被静默回滚。带 `heading` 时返回 `headingMatched`：`false` = 没找到该标题、文本已追加到**文末**（CRLF 行尾的笔记也能正确定位）。',
    parameters: {
      title: { type: 'string', description: 'tiddler 标题', required: true },
      text: { type: 'string', description: '要追加/前插的文本（默认按 Markdown 写；既有条目保持它自己的内容类型）', required: true },
      mode: { type: 'string', enum: ['append', 'prepend'], description: '可选：append（默认，追加到末尾）/ prepend（插到开头）' },
      heading: { type: 'string', description: '可选：append 时改为写入指定标题的位置（Markdown # 或 wikitext ! 标题，按标题文本匹配、忽略标题级别）。**落点 = 该标题之后、下一个任意级别标题之前**：若该标题后紧跟子标题，内容插在两者之间（即章节开头），**不是整节末尾**。标题不存在时不报错，改为追加到文末，并在回执与返回的 headingMatched=false 里明确说明（别把「没命中」当「写进去了」）' },
      createIfMissing: { type: 'boolean', description: '可选：条目不存在时是否新建（默认 true）' },
      tags: { type: 'array', items: { type: 'string' }, description: '可选：标签（不传则保留既有条目的原标签，传空数组 [] 表示清空全部标签；新建条目会额外自动补 agent-written）' },
      fields: { type: 'object', additionalProperties: true, description: '可选：显式覆盖的自定义字段（如 {"type":"text/css"}）。不传则保留既有条目的原字段与内容类型' },
      expectedModified: { type: 'string', description: '可选：乐观并发保护。传 tiddlywiki_get 读到的 modified；若条目在你读取之后被改动（人类在 TW 编辑器里改过）则拒绝写入——本工具是整篇回写，这一步能防止吞掉别人的修改' },
      expectedRevision: { type: 'integer', description: '可选：乐观并发保护的另一种令牌——传 tiddlywiki_get 返回字段里的 revision（注意 revision 是 TW 的内存计数器，重启后会复位，长时间跨度请用 expectedModified）' },
      force: { type: 'boolean', description: '可选：true 时忽略 expectedModified/expectedRevision 强制写入（默认 false）' },
    },
    normalizeArgs: normalizeFieldsInArgs,
    output: {
      render: (_args, value: AppendResult) => {
        // v0.26.6：标题没定位到时必须说出来。以前回执无条件打「段落「X」」，
        // 于是「静默追加到文末」看起来跟「精确写进那一节」一模一样。
        const headingNote = value.heading === null
          ? ''
          : value.headingMatched === false
            ? ` · ⚠️ 未找到标题「${value.heading}」，已改为追加到文末`
            : ` · 段落「${value.heading}」`
        const lines = [`${value.created ? '已新建并写入' : '已增量写入'} tiddler「${value.title}」（${value.mode}${headingNote}）：新增 ${value.added} 字符，现共 ${value.total} 字符。`]
        if (value.type !== null) lines.push(`类型: ${value.type}${value.typeDefaulted === true ? '（新建且未指定，已默认 markdown）' : ''}`)
        if (value.typeChanged !== undefined) lines.push(`⚠️ 内容类型已从 ${value.typeChanged.from} 改为 ${value.typeChanged.to}`)
        if (value.workspace !== undefined) lines.push(`已自动标记工作区: ${WORKSPACE_TAG_PREFIX}${value.workspace}（字段 ${WORKSPACE_FIELD}）`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { title: string; text: string; mode?: 'append' | 'prepend'; heading?: string; createIfMissing?: boolean; tags?: string[]; fields?: Record<string, unknown>; expectedModified?: string; expectedRevision?: number; force?: boolean }, exec: unknown): Promise<AppendResult> => {
      const wiki = requireWiki(sessionIdOf(exec))
      const title = args.title.trim()
      if (title.length === 0) throw new Error('tiddlywiki_append: title 不能为空')
      const existing = await wiki.get(title)
      // v0.25.0: append is a read-modify-write of the WHOLE note (`next` below is
      // the stale base plus the addition), so it needs the same optimistic guard
      // as put/delete. Without it, a human edit landing between our GET and PUT
      // was silently reverted — and the injected prompt recommends append for
      // exactly the incremental writes that hit this path most often.
      assertNoConflict(title, existing, {
        expectedModified: args.expectedModified,
        expectedRevision: args.expectedRevision,
        force: args.force,
      })
      if (existing === undefined && args.createIfMissing === false) {
        throw new Error(`tiddler「${title}」不存在（createIfMissing=false）`)
      }
      const mode = args.mode === 'prepend' ? 'prepend' : 'append'
      const base = existing?.text ?? ''
      const addition = args.text
      let next: string
      let headingMatched: boolean | undefined
      if (mode === 'append' && typeof args.heading === 'string' && args.heading.trim().length > 0) {
        const placed = insertIntoSection(base, args.heading.trim(), addition)
        next = placed.text
        headingMatched = placed.matched
      } else if (mode === 'prepend') {
        next = base.trim().length === 0 ? addition : `${addition}\n\n${base}`
      } else {
        next = base.trim().length === 0 ? addition : `${base.replace(/\s+$/, '')}\n\n${addition}`
      }
      // v0.20.1: ONE write policy for every write path. The old append built its
      // PUT by hand, which (a) dropped the existing tiddler's `type` and
      // (b) ignored `fields` entirely — appending a paragraph to a Markdown note
      // silently downgraded it to wikitext. buildWriteTiddler preserves
      // tags/custom fields/type for an existing tiddler and only defaults the
      // type when creating.
      const appendMarked = existing === undefined && !title.startsWith('$:/')
        ? withWorkspaceMark(workspaceMarkFor(deps, exec), normalizeTagArg(args.tags), args.fields)
        : { tags: normalizeTagArg(args.tags), fields: args.fields }
      const { tiddler, typeDefaulted } = buildWriteTiddler(title, next, {
        existing,
        tags: appendMarked.tags,
        fields: appendMarked.fields,
      })
      await wiki.put(tiddler)
      deps.autoCommit()
      return {
        ok: true,
        title,
        mode,
        // `heading` only has an effect in append mode (v0.23.5): reporting it for
        // a prepend made the model believe the text landed in that section.
        heading: mode === 'append' && typeof args.heading === 'string' && args.heading.trim().length > 0
          ? args.heading.trim()
          : null,
        // v0.26.6：给了 heading 时它到底有没有定位成功。false = 没找到该标题、文本被
        // 追加到了**文末**。此前这个回退是静默的，回执还照打「段落「X」」，
        // 导致一次定位失败看起来完全像成功（Agent 无法自检）。
        ...(headingMatched !== undefined ? { headingMatched } : {}),
        created: existing === undefined,
        added: addition.length,
        total: next.length,
        type: typeof tiddler.type === 'string' ? tiddler.type : null,
        ...(appendMarked.workspace !== undefined ? { workspace: appendMarked.workspace } : {}),
        ...(typeDefaulted ? { typeDefaulted: true } : {}),
        ...typeChangeOf(existing, tiddler),
      }
    },
  })
}

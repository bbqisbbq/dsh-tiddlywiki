/**
 * Note STRUCTURE tools: `rename` / `append`.
 *
 * v0.30.7：从 	ools-notes.ts **纯搬迁**拆出（职责分组），函数体一字未改。
 * 原来的文件变成 barrel，	ools.ts 的注册顺序与导入路径都没变。
 *
 * @module dsh-tiddlywiki/host/tools-notes-structure
 */
import { defineTool } from '../sdk.ts'
import { isBinaryType } from './tw-api.ts'
import { assertNoConflict, buildWriteTiddler, normalizeTagArg } from './write-policy.ts'
import { WORKSPACE_FIELD, WORKSPACE_TAG_PREFIX } from './workspace.ts'
import { insertIntoSection, normalizeFieldsInArgs, rewriteRefs, sessionIdOf, typeChangeOf, withWorkspaceMark, workspaceMarkFor } from './tools-support.ts'
import type { AppendResult, RenameResult, ReplaceResult, ToolEnv } from './tools-support.ts'

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

export function replaceTool(env: ToolEnv) {
  const { deps, requireWiki } = env
  // ── tiddlywiki_replace ────────────────────────────────────────────────────
  return defineTool({
    name: 'tiddlywiki_replace',
    description: '对笔记正文做**局部替换**（读全文 → 替换 → 整篇回写），用于只改笔记里的几处文字、不用整篇重写。`old` 是精确匹配的子串（原文）；`new` 是替换后的文本（传空字符串 = 删除该片段）。默认只替换**第一处**，`all: true` 替换全部出现。⚠️ 本工具内部是「读全文 → 整篇回写」，属于覆盖写入：改前请先 `tiddlywiki_get`，并把读到的 `modified` 作为 `expectedModified` 传回，否则人类在 TW 编辑器里的并发修改会被静默回滚。`old` 没找到时**不报错**，回执 `replaced: 0` 并说明未找到（别把「没命中」当「改好了」）。',
    parameters: {
      title: { type: 'string', description: 'tiddler 标题（精确匹配）', required: true },
      old: { type: 'string', description: '要被替换的原文（精确匹配子串；找不到则不报错，replaced=0）', required: true },
      new: { type: 'string', description: '替换后的文本（传空字符串表示删除该片段）', required: true },
      all: { type: 'boolean', description: '可选：是否替换所有出现（默认 false = 只替换第一处）' },
      expectedModified: { type: 'string', description: '可选：乐观并发保护。传 tiddlywiki_get 读到的 modified；若条目在你读取之后被改动则拒绝写入（本工具是整篇回写，这一步能防止吞掉别人的修改）' },
      expectedRevision: { type: 'integer', description: '可选：乐观并发保护的另一种令牌——tiddlywiki_get 返回字段里的 revision' },
      force: { type: 'boolean', description: '可选：true 时忽略 expectedModified/expectedRevision 强制替换（默认 false）' },
    },
    output: {
      render: (_args, value: ReplaceResult) => {
        if (value.found === false) {
          return [{ type: 'text', text: `⚠️ tiddler「${value.title}」里没找到要替换的原文，未做任何改动。请先 tiddlywiki_get 读原文、确认要替换的精确子串。` }]
        }
        return [{ type: 'text', text: `已替换 tiddler「${value.title}」：命中 ${value.replaced} 处，现共 ${value.total} 字符。` }]
      },
    },
    execute: async (args: { title: string; old: string; new: string; all?: boolean; expectedModified?: string; expectedRevision?: number; force?: boolean }, exec: unknown): Promise<ReplaceResult> => {
      const wiki = requireWiki(sessionIdOf(exec))
      const title = args.title.trim()
      if (title.length === 0) throw new Error('tiddlywiki_replace: title 不能为空')
      if (typeof args.old !== 'string' || args.old.length === 0) throw new Error('tiddlywiki_replace: old 不能为空')
      const existing = await wiki.get(title)
      assertNoConflict(title, existing, {
        expectedModified: args.expectedModified,
        expectedRevision: args.expectedRevision,
        force: args.force,
      })
      if (existing === undefined) throw new Error(`tiddler「${title}」不存在（replace 只改已有笔记；新建用 tiddlywiki_put）`)
      if (isBinaryType(typeof existing.type === 'string' ? existing.type : undefined)) {
        throw new Error(`tiddlywiki_replace: 「${title}」是二进制附件（正文为 base64），不能做文本替换。`)
      }
      const base = existing.text ?? ''
      const idx = base.indexOf(args.old)
      if (idx === -1) {
        return { ok: true, title, replaced: 0, found: false, total: base.length, type: typeof existing.type === 'string' ? existing.type : null }
      }
      const next = args.all === true
        ? base.split(args.old).join(args.new)
        : `${base.slice(0, idx)}${args.new}${base.slice(idx + args.old.length)}`
      const replaced = args.all === true ? base.split(args.old).length - 1 : 1
      const { tiddler } = buildWriteTiddler(title, next, { existing })
      await wiki.put(tiddler)
      deps.autoCommit()
      return { ok: true, title, replaced, found: true, total: next.length, type: typeof tiddler.type === 'string' ? tiddler.type : null }
    },
  })
}

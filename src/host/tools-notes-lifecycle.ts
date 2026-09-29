/**
 * Note LIFECYCLE tools: `delete` / `trash` (soft delete).
 *
 * v0.30.7：从 	ools-notes.ts **纯搬迁**拆出（职责分组），函数体一字未改。
 * 原来的文件变成 barrel，	ools.ts 的注册顺序与导入路径都没变。
 *
 * @module dsh-tiddlywiki/host/tools-notes-lifecycle
 */
import { defineTool } from '../sdk.ts'
import { assertNoConflict, buildWriteTiddler } from './write-policy.ts'
import { TRASH_INDEX_TITLE, TRASH_PREFIX, TrashIndexUnavailableError, readTrashIndex, sessionIdOf, trashTitleFor, writeTrashIndex } from './tools-support.ts'
import type { DeleteResult, ToolEnv, TrashResult } from './tools-support.ts'

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

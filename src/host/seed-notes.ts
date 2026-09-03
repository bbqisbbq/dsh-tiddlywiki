/**
 * Built-in doc note for the plugin (design doc §14): a short user-facing
 * "how to use dsh-tiddlywiki" note seeded into the wiki the first time the
 * plugin runs on a wiki.
 *
 * ONE-SHOT seed: a marker tiddler (`seed-doc-note`) records that the note has
 * been offered once; after that the note is the user's own content — deleting
 * it and restarting dsh web does NOT recreate it, and edits are never
 * overwritten.
 *
 * @module dsh-tiddlywiki/host/seed-notes
 */
import type { TiddlyWebClient } from './tw-api.ts'

/** Note tiddler title (a normal, searchable note — not a system tiddler). */
export const DOC_NOTE_TITLE = 'dsh-tiddlywiki 插件说明'

/** Tag that makes the note easy to find via `tiddlywiki_search tag=docs`. */
export const DOC_NOTE_TAG = 'docs'

/** One-time marker: its presence means "the note was offered once — hands off". */
export const SEED_MARKER_TITLE = '$:/plugins/dsh-tiddlywiki/seed-doc-note'

/** The note body, TiddlyWiki wiki-text. */
export const DOC_NOTE_TEXT = `! dsh-tiddlywiki 插件说明

本插件把 **TiddlyWiki 5** 作为 DSH 的持久知识库（wiki 文件夹本身就是一个 git 仓库，随内容自动提交/同步）。

!! 它能做什么

* **10 个 agent 工具**：\`tiddlywiki_search\`（检索，支持 tags/since/type/limit 过滤）/ \`tiddlywiki_get\`（读）/ \`tiddlywiki_put\`（写）/ \`tiddlywiki_batch_put\`（批量写）/ \`tiddlywiki_rename\`（重命名+同步引用）/ \`tiddlywiki_delete\`（删）/ \`tiddlywiki_recent\`（最近修改）/ \`tiddlywiki_list_tags\`（标签清单）/ \`tiddlywiki_git_sync\`（git 同步）/ \`tiddlywiki_git_resolve\`（冲突按 tiddler 二选一）。
* **TW 编辑器面板**：侧边栏「TiddlyWiki」按钮 → 在界面中央打开完整版 TW 编辑器。
* **快速笔记**：右下角「知识库」悬浮按钮 → 「📝 快速笔记」写随手记（Markdown 高亮、文件上传、多选/自动补全 tag，草稿自动保存到本地），\`Ctrl+Enter\` 保存；「🕘 最近」可一键载入旧笔记继续编辑；「✏️ 在 TW 中编辑」会弹出独立小窗用 TW 原生编辑器编辑。
* **一键同步**：「知识库」按钮 → 「🔁 同步」一键 pull → commit → push，按钮上的状态点实时反映 git 状态。
* **git 同步**：写入自动防抖 commit（默认 60 秒）；手动 \`tiddlywiki_git_sync action=sync\` 做 pull → commit → push。
* **设置页**：DSH 设置 → 「TiddlyWiki 知识库」管理插件/主题/语言与运行配置（含「知识库」按钮相关显示开关）。

!! 知识库纪律（三条）

1. 开工先 \`tiddlywiki_git_sync action=pull\`（rebase + autostash，真冲突会自动 abort 并报文件）。
2. 冲突后：\`tiddlywiki_git_resolve files=[冲突文件] strategy=keep-local|keep-remote\` 按 tiddler 二选一解决，再重新 sync。
3. 收工 \`tiddlywiki_git_sync action=sync\`。
4. 插件自动 commit 兜底，手动 sync 用于需要主动推送的场合。

!! 主题与语言

* **主题**分两层：每行一个「☑ 加载」（多选 = TW 里可用的主题，依赖链自动带上）和「◉ 活动」（单选 = 当前视觉主题）。应用后自动重启 TW。
* **语言**：设置页勾选 \`zh-Hans\`（简体）并应用，TW 界面即切换为中文。

!! 说明

* 本笔记由插件在**首次启动**时自动写入（一次性：只写一次）。删除后重启 dsh web **不会自动恢复**——它从此归你所有。
* 更多细节见插件仓库 README。`

/**
 * Seed the doc note exactly once per wiki. A marker tiddler records that the
 * note has been offered; from then on the note is user-owned and is never
 * re-created (deleting it survives restarts). Returns whether a note was
 * written this call. Never throws.
 */
export async function seedDocNote(client: TiddlyWebClient): Promise<boolean> {
  const marker = await client.get(SEED_MARKER_TITLE).catch(() => undefined)
  if (marker !== undefined) return false
  const existing = await client.get(DOC_NOTE_TITLE).catch(() => undefined)
  let wrote = false
  if (existing === undefined) {
    await client.put({
      title: DOC_NOTE_TITLE,
      text: DOC_NOTE_TEXT,
      type: 'text/vnd.tiddlywiki',
      tags: [DOC_NOTE_TAG],
    })
    wrote = true
  }
  // Record the offer regardless, so an existing note (upgrade from an older
  // create-if-missing version) also becomes user-owned from here on.
  await client
    .put({ title: SEED_MARKER_TITLE, text: 'seeded-once', type: 'text/plain', tags: [] })
    .catch(() => undefined)
  return wrote
}

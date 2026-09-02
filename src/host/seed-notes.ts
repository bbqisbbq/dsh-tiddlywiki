/**
 * Built-in doc note for the plugin (design doc §14): a short user-facing
 * "how to use dsh-tiddlywiki" note that is seeded into the wiki on first run.
 *
 * Idempotent seed (create-if-missing): on every plugin start we check whether
 * the note tiddler exists and only write it when it is absent — deleting it
 * and restarting dsh web recreates it, but editing it never gets overwritten.
 *
 * @module dsh-tiddlywiki/host/seed-notes
 */
import type { TiddlyWebClient } from './tw-api.ts'

/** Note tiddler title (a normal, searchable note — not a system tiddler). */
export const DOC_NOTE_TITLE = 'dsh-tiddlywiki 插件说明'

/** Tag that makes the note easy to find via `tiddlywiki_search tag=docs`. */
export const DOC_NOTE_TAG = 'docs'

/** The note body, TiddlyWiki wiki-text. */
export const DOC_NOTE_TEXT = `! dsh-tiddlywiki 插件说明

本插件把 **TiddlyWiki 5** 作为 DSH 的持久知识库（wiki 文件夹本身就是一个 git 仓库，随内容自动提交/同步）。

!! 它能做什么

* **5 个 agent 工具**：\`tiddlywiki_search\`（检索）/ \`tiddlywiki_get\`（读）/ \`tiddlywiki_put\`（写）/ \`tiddlywiki_delete\`（删）/ \`tiddlywiki_git_sync\`（git 同步）。
* **TW 编辑器面板**：侧边栏「TiddlyWiki」按钮 → 在界面中央打开完整版 TW 编辑器。
* **快速笔记**：右下角悬浮「📝 快速笔记」写随手记，\`Ctrl+Enter\` 保存；点「✏️ 在 TW 中编辑」会弹出独立小窗用 TW 原生编辑器编辑。
* **git 同步**：写入自动防抖 commit（默认 60 秒）；手动 \`tiddlywiki_git_sync action=sync\` 做 pull → commit → push。
* **设置页**：DSH 设置 → 「TiddlyWiki 知识库」管理插件/主题/语言与运行配置。

!! 知识库纪律（三条）

1. 开工先 \`tiddlywiki_git_sync action=pull\`（rebase + autostash，真冲突会自动 abort 并报文件）。
2. 收工 \`tiddlywiki_git_sync action=sync\`。
3. 插件自动 commit 兜底，手动 sync 用于需要主动推送的场合。

!! 主题与语言

* **主题**分两层：每行一个「☑ 加载」（多选 = TW 里可用的主题，依赖链自动带上）和「◉ 活动」（单选 = 当前视觉主题）。应用后自动重启 TW。
* **语言**：设置页勾选 \`zh-Hans\`（简体）并应用，TW 界面即切换为中文。

!! 说明

* 本笔记由插件在首次启动时自动写入 wiki（幂等：不存在才写）。删除后重启 dsh web 会重建；手动编辑过的内容不会被覆盖。
* 更多细节见插件仓库 README。`

/**
 * Seed the doc note when it is absent. Returns whether a note was written.
 * Never throws (missing wiki or note already present → no-op / false).
 */
export async function seedDocNote(client: TiddlyWebClient): Promise<boolean> {
  const existing = await client.get(DOC_NOTE_TITLE).catch(() => undefined)
  if (existing !== undefined) return false
  await client.put({
    title: DOC_NOTE_TITLE,
    text: DOC_NOTE_TEXT,
    type: 'text/vnd.tiddlywiki',
    tags: [DOC_NOTE_TAG],
  })
  return true
}

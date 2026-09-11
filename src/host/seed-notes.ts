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
import { readSeedTiddler, writeSeedMarker } from './seed-util.ts'
import { toolSignatureLines, type PromptToolSummary } from './prompt.ts'

/** Note tiddler title (a normal, searchable note — not a system tiddler). */
export const DOC_NOTE_TITLE = 'dsh-tiddlywiki 插件说明'

/** Tag that makes the note easy to find via `tiddlywiki_search tag=docs`. */
export const DOC_NOTE_TAG = 'docs'

/**
 * Shared tag that collects every plugin-seeded doc into the seeded home's
 *「📚 插件文档」tabs strip (see seed-starter-docs.ts DSH_DOCS_TAG).
 */
export const DOC_NOTE_DSH_DOCS_TAG = 'dsh-docs'

/** One-time marker: its presence means "the note was offered once — hands off". */
export const SEED_MARKER_TITLE = '$:/plugins/dsh-tiddlywiki/seed-doc-note'

/** The note body, TiddlyWiki wiki-text. */
const DOC_NOTE_HEAD = `! dsh-tiddlywiki 插件说明

本插件把 **TiddlyWiki 5** 作为 DSH 的持久知识库（wiki 文件夹本身就是一个 git 仓库，随内容自动提交/同步）。

!! 它能做什么
`

/**
 * Tool-list bullet for the doc note, GENERATED from the live tool registry
 * (v0.22.0). The note used to hard-code 「10 个 agent 工具」 and was 5 tools
 * behind by the time anyone noticed — the same class of drift the prompt
 * catalogue had. With no registry available (headless callers) it degrades to
 * a pointer instead of an outdated list.
 */
function docToolBullet(tools: readonly PromptToolSummary[]): string {
  if (tools.length === 0) {
    return "* **agent 工具**：`tiddlywiki_*` 系列（检索 / 读写 / 批量写 / 增量追加 / 重命名 / 删除与回收站 / 反向链接 / 附件 / 体检 / git 同步与冲突解决）——完整清单与参数见 DSH 设置页与各工具的 schema。"
  }
  return ['* **' + String(tools.length) + ' 个 agent 工具**（参数以工具 schema 为准，\u0060?\u0060 表示可选）：', ...toolSignatureLines(tools, '* ')].join('\n')
}

const DOC_NOTE_TAIL = `* **TW 编辑器面板**：侧边栏「TiddlyWiki」按钮 → 在界面中央打开完整版 TW 编辑器。
* **快速笔记**：点击聊天输入框上方或右下角「知识库」菜单里的「📝 快速笔记」——默认**直达 TW 原生编辑页**（独立小窗，草稿自动续写）；也可在设置页切回 Markdown 卡片（语法高亮、文件上传、多选 tag、草稿自动保存、Ctrl+Enter 保存）。「✏️ 在 TW 中编辑」会弹出独立小窗用 TW 原生编辑器编辑。
* **一键同步**：「知识库」按钮 → 「🔁 同步」一键 pull → commit → push，按钮上的状态点实时反映 git 状态。
* **git 同步**：写入自动防抖 commit（默认 60 秒）；手动 \`tiddlywiki_git_sync action=sync\` 做 pull → commit → push。
* **设置页**：DSH 设置 → 「TiddlyWiki 知识库」管理插件/主题/语言与运行配置（含「知识库」按钮相关显示开关）。
* **注入给 Agent 的提示词可配置**（设置页「系统提示词」区块）：默认**精简版**只约定同步纪律/标签/链接格式（工具参数由工具 schema 提供，不重复）；可切完整版（附参数索引）、追加自定义规范（\`extra\`）、整段替换（\`override\`）或整体停用。保存即生效，无需重启 dsh web；点「查看当前注入文本」可预览下一步实际注入的全文。

!! 知识库纪律（四条）

1. 开工先 \`tiddlywiki_git_sync action=pull\`（rebase + autostash，真冲突会自动 abort 并报文件）。
2. 冲突后：\`tiddlywiki_git_resolve files=[冲突文件] strategy=keep-local|keep-remote\` 按 tiddler 二选一解决，再重新 sync。
3. 收工 \`tiddlywiki_git_sync action=sync\`。
4. 插件自动 commit 兜底，手动 sync 用于需要主动推送的场合。

!! 主题与语言

* **主题**分两层：每行一个「☑ 加载」（多选 = TW 里可用的主题，依赖链自动带上）和「◉ 活动」（单选 = 当前视觉主题）。应用后自动重启 TW。
* **语言**：设置页勾选 \`zh-Hans\`（简体）并应用，TW 界面即切换为中文。

!! 说明

* 本笔记由插件在**首次启动**时自动写入（一次性：只写一次）。删除后重启 dsh web **不会自动恢复**——它从此归你所有。
* 本笔记带 \`dsh-docs\` 标签，会出现在首页「📚 插件文档」栏（与「示例与文档」seed 的教程/模板一起），不需要可自由删除。
* 更多细节见插件仓库 README。`

/**
 * The doc note text. `tools` should be the live registry summary
 * (`tiddlywikiToolSummary()`), so the tool list can never go stale.
 */
export function docNoteText(tools: readonly PromptToolSummary[] = []): string {
  return `${DOC_NOTE_HEAD}${docToolBullet(tools)}${DOC_NOTE_TAIL}`
}

/** Back-compat constant: the note as built without a live registry. */
export const DOC_NOTE_TEXT = docNoteText()

/**
 * Seed the doc note once per wiki (mirrors the one-shot policy). A marker
 * tiddler records that the note has been offered; from then on the note is
 * user-owned and is never re-created (deleting it survives restarts).
 *
 * With `opts.force` the note is (re)written even when it already exists and
 * the marker is (re)written — the settings page uses this for
 * "重新初始化". Returns whether a note was written this call. Throws when a read fails (the seed registry reports it as `ok:false`).
 */
export async function seedDocNote(client: TiddlyWebClient, opts?: { force?: boolean; tools?: readonly PromptToolSummary[] }): Promise<boolean> {
  const force = opts?.force === true
  if (!force) {
    const marker = await readSeedTiddler(client, SEED_MARKER_TITLE)
    if (marker !== undefined) return false
  }
  const existing = await readSeedTiddler(client, DOC_NOTE_TITLE)
  let wrote = false
  if (force || existing === undefined) {
    await client.put({
      title: DOC_NOTE_TITLE,
      text: docNoteText(opts?.tools ?? []),
      type: 'text/vnd.tiddlywiki',
      tags: [DOC_NOTE_TAG, DOC_NOTE_DSH_DOCS_TAG],
    })
    wrote = true
  }
  // Record the offer regardless, so an existing note (upgrade from an older
  // create-if-missing version) also becomes user-owned from here on.
  await writeSeedMarker(client, SEED_MARKER_TITLE)
  return wrote
}

/**
 * Un-seed (反初始化): remove the doc note and its one-shot marker, returning
 * the wiki to the "never offered" state. Deletion is idempotent — a tiddler
 * that was already gone is simply not listed. Throws when a read fails (the seed registry reports it as `ok:false`).
 */
export async function unseedDocNote(client: TiddlyWebClient): Promise<{ removed: string[] }> {
  const removed: string[] = []
  for (const title of [DOC_NOTE_TITLE, SEED_MARKER_TITLE]) {
    const t = await readSeedTiddler(client, title)
    if (t !== undefined) {
      await client.delete(title)
      removed.push(title)
    }
  }
  return { removed }
}

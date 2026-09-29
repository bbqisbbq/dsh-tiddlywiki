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
import { DSH_DOCS_TAG } from './seed-starter-docs.ts'
import { toolSignatureLines, type PromptToolSummary } from './prompt.ts'

/** Note tiddler title (a normal, searchable note — not a system tiddler). */
export const DOC_NOTE_TITLE = 'dsh-tiddlywiki 插件说明'

/** Tag that makes the note easy to find via `tiddlywiki_search tag=docs`. */
export const DOC_NOTE_TAG = 'docs'

/**
 * Shared tag that collects every plugin-seeded doc into the seeded home's
 *「📚 插件文档」tabs strip.
 *
 * Alias of `DSH_DOCS_TAG` (v0.22.8): this module used to declare its OWN copy of
 * the same literal, so the doc note and the starter docs shared a tag only by
 * coincidence — changing one spelled the home's tabs strip empty for the other.
 * Kept as a named alias because it reads better at the call site below.
 */
export const DOC_NOTE_DSH_DOCS_TAG = DSH_DOCS_TAG

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

!! 多知识库（v0.28.0 起）

同一个 dsh web 里可以**同时跑多个知识库**，每个库独立配置、独立 git，各自一个 TW 子进程。

* **现在有几个库？**右下角「知识库」按钮的菜单会列出全部（● 是当前打开的那个）；输入框上方也会有「知识库」下拉，用来选**本会话**让 Agent 用哪个库（单选，选择会被记住）。
* **加一个库**：DSH 设置 → 「TiddlyWiki 知识库」→ **知识库列表** → 填根目录 + 文件夹名 →「添加知识库」。目录不存在会自动初始化一个全新库；已存在的目录直接接管。
* **让某个库对 Agent 隐身**：知识库列表里点该行「对 Agent 隐身」。隐身 = Agent 永远碰不到它（不进检索、不进工具、不进会话选择器），**你自己照常用**——适合只读语料、书籍扫描、导入归档。
* **每个库一套设置**：笔记标签、语言、主题、提示词都在该库自己的配置里。设置页顶部会显示「**配置作用域**：…」，点某一行「配置」即可切换在编辑哪个库。
* **git 按仓库生效**：多个库可以共用一个仓库（例如两个库是同一仓库下的两个子目录），也可以各自独立仓库。共用仓库时只有一个自动提交者，pull 后只重启内容真的变了的库。
* **想拆分现有的大库**：见设置页文档或仓库里的 \`docs/wiki-split.md\`——那里有一段可以直接复制给 Agent 的话，它会先只读体检、再问你几个问题、出方案等你确认后才动手。

!! 从旧版本升级上来（重要）

**升级后不会自动变成多库**，仍然是单库模式（\`mode: single\`），行为与升级前完全一致。

* **想继续用单库**：什么都不用做。设置页里「知识库位置（可切换）」只在单库模式出现，用法和以前一样。
* **想开始用多库**：去设置页「知识库列表」添加第二个库，再把「运行模式」切到**多库**。此后清单里的库都会可用（标了「开局自启」的随 DSH 启动，其余在你打开或选中它时启动）。
* **控制文件在哪**：\`$DSH_HOME/dsh-tiddlywiki/wikis.json\`（在每本 wiki **之外**，所以它不会随某个库被搬走）。运行模式、库清单、以及哪个库是默认的，都在里面；也可以在设置页里改，效果一样。
* **旧的「知识库位置」指针文件**（\`location.json\`）在单库模式下仍然是权威的——多库模式下它不再参与，改由清单决定。
* **每个库要有自己的 \`tiddlywiki.info\`**：把一个大库拆成多个目录时，每个目录都要有一个（缺了 TW 认不出它是库）。从旧库整体搬过来的目录通常已经有了。
* **拆分大库的注意**：书籍/语料这类只读内容建议**独立仓库 + 对 Agent 隐身**；工作与个人笔记可以共用一个仓库、按子目录划分。搬运用 \`git mv\` 保留历史，别用\"复制粘贴再删\"。

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

/**
 * The "示例与文档" starter seed (v0.16.22): the generic docs / templates /
 * example pages that give a fresh wiki a working "文档中心" out of the box —
 * 主题汇总页·模板 (blank template) + 教程：按主题/标签做汇总页 (how-to) + three
 * runnable 主题页 examples (日志 / 决策记录 / 排障).
 *
 * Sanitized: every tiddler carries NO personal data — the tutorial's
 * 配套产物清单 points only at the tiddlers this seed actually provides, and
 * the example pages auto-collect by tag (text verbatim from the author's wiki,
 * they were already generic). Every item gets the shared `dsh-docs` tag so the
 * seeded home's「📚 插件文档」tabs strip collects them automatically.
 *
 * Tier: STARTER — seeded automatically on first install (safe-skip: any
 * same-named tiddler already present is never overwritten) and removable via
 *「反初始化」from the settings page (ONE-SHOT marker-gated, like doc-note).
 *
 * @module dsh-tiddlywiki/host/seed-starter-docs
 */
import type { TiddlyWebClient } from './tw-api.ts'
import { readSeedTiddler, writeSeedMarker } from './seed-util.ts'

/** One-time marker: presence means "the docs were offered once — hands off". */
export const STARTER_DOCS_MARKER_TITLE = '$:/plugins/dsh-tiddlywiki/seed-starter-docs'

/** Shared tag that collects every plugin-seeded doc into the home docs tab. */
export const DSH_DOCS_TAG = 'dsh-docs'

export interface StarterDocItem {
  title: string
  tags: string[]
  type: string
  text: string
}

/** The docs, exactly as seeded (user-owned afterwards, freely deletable). */
export const STARTER_DOCS_ITEMS: StarterDocItem[] = [
  {
    title: '主题汇总页·模板',
    tags: ['索引', 'dsh-docs'],
    type: 'text/vnd.tiddlywiki',
    text: `\\whitespace trim

!! 📌 主题汇总页

<div style="color:#888; font-size:0.85em; border:1px dashed rgba(128,128,128,0.35); border-radius:8px; padding:6px 10px; margin-bottom:8px;">【模板】复制本页 → 改名（如「XX主题汇总」）→ 把下面两处 <code>主题A</code> 替换成你的标签名 → 保存。给笔记打上该标签即自动收录，本页无需维护。</div>

<div class="tc-message-box">自动收集带 <code>主题A</code> 标签的笔记，按最近修改排序，共 <strong>{{{[tag[主题A]!is[system]!has[draft.of]count[]]}}}</strong> 篇。</div>

<<list-links "[tag[主题A]!is[system]!has[draft.of]] +[!sort[modified]]">>

---

### 可选：自定义样式的 <$list> 版（想更花哨时用它替换上面的 list-links）

<ul>
<$list filter="[tag[主题A]!is[system]!has[draft.of]] +[!sort[modified]]">
<li><$link to=<<currentTiddler>>><$view field="title"/></$link><span style="color:#aaa; font-size:0.85em;"> · <$view field="modified" format="relativedate"/></span></li>
</$list>
</ul>

### 可选：把本页收进「一页多主题」tabs

给本页打上 <code>主题页</code> 标签、并加一个 <code>caption</code> 字段（按钮文字），然后在总览页写：<code>&lt;&lt;tabs "[tag[主题页]!is[system]]"&gt;&gt;</code>。详见 [[教程：按主题/标签做汇总页]]。
`,
  },
  {
    title: '教程：按主题/标签做汇总页',
    tags: ['教程', 'dsh-docs'],
    type: 'text/markdown',
    text: `# 教程：按主题/标签做汇总页

> 适用：本 wiki 的 TiddlyWiki 5.3.x 内核。⚠️ 网上大量教程是 5.1/5.2 时代写的，其中 \`<<tabs "筛选器" "标签">>\` 和 \`<<count "筛选器">>\` 两种写法在本版本已**改版/移除**，照抄会报错，注意甄别。

## 核心思路（一句话）

「汇总页」不是 TW 的特殊功能，而是：**一个普通笔记 + 正文里一段筛选器（filter）**。渲染时 TW 实时从整个 wiki 挑出符合条件的笔记列出来。**新笔记只要打上对应标签，汇总页自动出现，零维护**——不用像手工目录那样每次手动更新。

## 方法一：零代码，直接用内置标签页

- 打开任意笔记，点正文底部的**标签链接**；
- 或侧边栏「标签」（标签云）里点某个标签。
- TW 会自动生成该标签的页面，列出所有带此标签的笔记。
- 优点：一行代码都不用写；缺点：不能加说明文字、不能自定义排序/样式，也做不了「多主题合一」。

## 方法二：一页一主题（最常用）

新建一个笔记（wikitext），正文写：

\`\`\`wikitext
!! 📔 日志主题汇总
<div class="tc-message-box">自动收集带 <code>日志</code> 标签的笔记，共 <strong>{{{[tag[日志]!is[system]!has[draft.of]count[]]}}}</strong> 篇，按最近修改排序。</div>

<<list-links "[tag[日志]!is[system]!has[draft.of]] +[!sort[modified]]">>
\`\`\`

各片段含义：

- \`[tag[日志]]\`：挑出所有带「日志」标签的笔记；
- \`!is[system]\`：排除 \`$:/\` 系统页；
- \`!has[draft.of]\`：排除未保存的草稿副本；
- \`+[!sort[modified]]\`：按修改时间**倒序**（\`sort[modified]\` 为正序）；
- \`{{{[...count[]]}}}\`：筛选器计数（旧版 \`<<count>>\` 宏已移除，这是 5.3 新写法）。

想自定义每行样式（带相对时间、复选框等），用你更熟悉的 \`<$list>\` 写法：

\`\`\`wikitext
<ul>
<$list filter="[tag[日志]!is[system]!has[draft.of]] +[!sort[modified]]">
<li><$link to=<<currentTiddler>>><$view field="title"/></$link><span style="color:#aaa; font-size:0.85em;"> · <$view field="modified" format="relativedate"/></span></li>
</$list>
</ul>
\`\`\`

## 方法三：一页多主题（Dashboard，5.3 新版 tabs）

5.3 的 \`tabs\` 宏签名：\`<<tabs "选中标签页的筛选器" "默认选中项">>\`。思路分两步：

1. **每个主题各建一个汇总页**（就是方法二那种），全部打上同一个标签（本插件 seed 的示例用 \`主题页\`）；要自定义按钮文字，就给该页加一个 \`caption\` 字段（如 \`📔 日志\`）。
2. **建一个总览页**，正文只写一行：

\`\`\`wikitext
<<tabs "[tag[主题页]!is[system]]" "主题页·日志">>
\`\`\`

效果：页面上方一排按钮，点哪个就内嵌显示哪个主题的汇总。第二个参数是默认展开的页（可省略，省略则初始不展开）。

> 老教程的 \`<<tabs "筛选器A" "标签A" "筛选器B" "标签B">>\` 在 5.3 已失效，别用。

本插件已 seed 了可直接运行的示例：[主题页·日志]、[主题页·决策记录]、[主题页·排障]（都带 \`主题页\` 标签），复制改造即可。

## 筛选器速查表（背熟这几行就够用）

| 想要 | 写法 |
| --- | --- |
| 某标签下的笔记 | \`[tag[主题]]\` |
| 排除系统页 / 草稿 | \`[tag[主题]!is[system]!has[draft.of]]\` |
| 修改时间倒序 / 正序 | \`+[!sort[modified]]\` / \`+[sort[modified]]\` |
| 按标题排序 | \`+[sort[title]]\` |
| 交集（同时有两个标签） | \`[tag[A]+tag[B]]\` |
| 并集（有任一标签） | \`[tag[A]] [tag[B]]\` |
| 差集（有 A 无 B） | \`[tag[A]-tag[B]]\` |
| 排除某标签 | \`-[tag[排除项]]\` |
| 限定时间段 | \`[tag[主题]modified[2026-09]]\` |
| 计数 | \`{{{[tag[主题]!is[system]count[]]}}}\`（或 \`<$count filter="[tag[主题]]"/>\`） |
| 整个 wiki 的非系统非草稿 | \`all[tiddlers]!is[system]!has[draft.of]\` |

## 进阶玩法

1. **按字段筛选**：\`[tag[todo]get[due]compare:date:lt<today>]\` 可列出「到期日早于今天」的笔记（主页的逾期看板就是这么写的）。
2. **树状目录**：\`<<toc tag:"主题">>\` 显示层级目录，适合一个主题下还有子主题的情况。
3. **模板复用**：复制 [主题汇总页·模板] 改标题和标签即可，不用每次重写。
4. **打开直达**：把 \`$:/DefaultTiddlers\` 改成 \`[[主题页·日志]]\`，启动即打开汇总页（当前默认是 [🏠 主页]）。
5. **导航收录**：给汇总页打 \`索引\` 标签，它就会从「全部笔记 / 所有文章」里消失、只作为导航页存在；再在 [🏠 主页] 的按钮区加一个入口按钮即可。
6. **标签整理**：控制台 → 工具 → 标签管理器，可重命名/合并标签，改名后所有笔记自动跟随，汇总页筛选器无需改动（筛选器按标签名匹配，自动跟随改名）。

## 配套产物清单（插件 seed 提供了什么）

- [主题页·日志]、[主题页·决策记录]、[主题页·排障] —— 单主题汇总页实例（各自可独立打开，也可作为「一页多主题」tabs 的标签页）
- [主题汇总页·模板] —— 空白模板，复制即用
- 本教程 —— 就是这一页

以上都来自「示例与文档」seed（tag \`dsh-docs\`），不需要可自由删除，删除后不会自动恢复。
`,
  },
  {
    title: '主题页·日志',
    tags: ['主题页', '索引', 'dsh-docs'],
    type: 'text/vnd.tiddlywiki',
    text: `\\whitespace trim

!! 📔 日志主题汇总

<div class="tc-message-box">自动收集带 <code>日志</code> 标签的笔记，按最近修改排序，共 <strong>{{{[tag[日志]!is[system]!has[draft.of]count[]]}}}</strong> 篇。给笔记打上「日志」标签即自动收录，本页无需维护（做法见 [[教程：按主题/标签做汇总页]]）。</div>

<<list-links "[tag[日志]!is[system]!has[draft.of]] +[!sort[modified]]">>
`,
  },
  {
    title: '主题页·决策记录',
    tags: ['主题页', '索引', 'dsh-docs'],
    type: 'text/vnd.tiddlywiki',
    text: `\\whitespace trim

!! 📌 决策记录主题汇总

<div class="tc-message-box">自动收集带 <code>决策记录</code> 标签的笔记，按最近修改排序，共 <strong>{{{[tag[决策记录]!is[system]!has[draft.of]count[]]}}}</strong> 篇。给笔记打上「决策记录」标签即自动收录，本页无需维护（做法见 [[教程：按主题/标签做汇总页]]）。</div>

<<list-links "[tag[决策记录]!is[system]!has[draft.of]] +[!sort[modified]]">>
`,
  },
  {
    title: '主题页·排障',
    tags: ['主题页', '索引', 'dsh-docs'],
    type: 'text/vnd.tiddlywiki',
    text: `\\whitespace trim

!! 🔧 排障主题汇总

<div class="tc-message-box">自动收集带 <code>troubleshooting</code> 标签的笔记，按最近修改排序，共 <strong>{{{[tag[troubleshooting]!is[system]!has[draft.of]count[]]}}}</strong> 篇。给笔记打上「troubleshooting」标签即自动收录，本页无需维护（做法见 [[教程：按主题/标签做汇总页]]）。</div>

<<list-links "[tag[troubleshooting]!is[system]!has[draft.of]] +[!sort[modified]]">>
`,
  },
]

/**
 * Seed the starter docs once per wiki (safe-skip: same-named tiddlers already
 * present are NEVER overwritten — user data stays user data). Marker-gated
 * ONE-SHOT; with `opts.force` the tiddlers are (re)written and the marker
 * (re)recorded — the settings page uses this for "重新初始化".
 * Returns whether anything was written this call. Throws when a read fails (the seed registry reports it as `ok:false`).
 */
export async function seedStarterDocs(client: TiddlyWebClient, opts?: { force?: boolean }): Promise<boolean> {
  const force = opts?.force === true
  if (!force) {
    const marker = await readSeedTiddler(client, STARTER_DOCS_MARKER_TITLE)
    if (marker !== undefined) return false
  }
  let wrote = false
  for (const item of STARTER_DOCS_ITEMS) {
    const existing = await readSeedTiddler(client, item.title)
    if (force || existing === undefined) {
      await client.put({ title: item.title, text: item.text, type: item.type, tags: item.tags })
      wrote = true
    }
  }
  await writeSeedMarker(client, STARTER_DOCS_MARKER_TITLE)
  return wrote
}

/**
 * Un-seed (反初始化): remove the starter docs and their marker. Deletion is
 * idempotent — a tiddler already gone is not listed. Throws when a read fails (the seed registry reports it as `ok:false`).
 */
export async function unseedStarterDocs(client: TiddlyWebClient): Promise<{ removed: string[] }> {
  const removed: string[] = []
  for (const item of STARTER_DOCS_ITEMS) {
    const t = await readSeedTiddler(client, item.title)
    if (t !== undefined) {
      await client.delete(item.title)
      removed.push(item.title)
    }
  }
  const marker = await readSeedTiddler(client, STARTER_DOCS_MARKER_TITLE)
  if (marker !== undefined) {
    await client.delete(STARTER_DOCS_MARKER_TITLE)
    removed.push(STARTER_DOCS_MARKER_TITLE)
  }
  return { removed }
}
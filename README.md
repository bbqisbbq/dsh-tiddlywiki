# dsh-tiddlywiki

> 把 **TiddlyWiki 5** 变成你和 Agent 之间的**文档中心**：一个嵌在 DSH 里、人手一个的私人知识库——Agent 用 `tiddlywiki_*` 工具读写，你在界面里用完整 TW 编辑器记录，一切通过 **git** 自动同步备份。

[![npm](https://img.shields.io/npm/v/dsh-tiddlywiki)](https://www.npmjs.com/package/dsh-tiddlywiki)
[![license](https://img.shields.io/npm/l/dsh-tiddlywiki)](https://github.com/bbqisbbq/dsh-tiddlywiki/blob/main/LICENSE)
[![GitHub](https://img.shields.io/github/stars/bbqisbbq/dsh-tiddlywiki)](https://github.com/bbqisbbq/dsh-tiddlywiki)

---

## 🗂 它是什么：你的「文档 × Agent」一站式文档中心

这个插件**首先不是一个"AI 记忆工具"**（虽然它顺带就是）。它把一件事做顺了——**文档和人、文档和 Agent 之间的协作**：

- **TiddlyWiki 天生适合当文档中心**：卡片化组织（标签 / 双向链接 / 一键成文 / 一个文件夹就是整个 wiki）、纯文本 git 仓库天然可迁移可备份。它能是你的**私人笔记本**、**GTD 工具**、**Agent 的记忆库**，甚至让 AI 帮你把电子书导入 TW 来阅读批注——**TW + DSH 能做到的唯一限制，只是人类的想象力**。
- **人会参与**：完整 TW 5 编辑器内嵌在 DSH 里，随时翻、随时改、随时批注。文档不是 Agent 写给你的黑盒，而是**方便人类参与的文档中心**。
- **Agent 也能进**：Agent 用 10 个 `tiddlywiki_*` 工具读写；TW 里「发送给 Agent」把笔记一键注入某个会话；每个会话顶部自动汇总它读写过的 wiki 笔记。**切换会话、方案终结、多轮合作，成果最终都回到文档里**——文档成为跨会话、跨 Agent 的公共底座。
- **AI 填平 TiddlyWiki 的门槛**：TW 功能强大但上手有门槛，这正是 AI 擅长的——让 Agent 按你的习惯定制首页、标签体系、样式与工作流。曾经要折腾 Obsidian / Logseq 插件体系才能搭出来的个人知识库，现在**一句话就能初始化一整套开箱即用的文档中心**。

> Obsidian、Logseq 也能做到其中一部分，但**从没有像这样一站式地顺畅**：编辑器、工具、会话、同步、主题全部在同一个界面里闭环。

## ✨ 特性一览

| 能力 | 说明 |
|---|---|
| 🏠 **文档中心起步包** | 首次安装自动 seed：插件说明 + 「示例与文档」（主题汇总模板 / 教程 / 三个示例主题页），首页「📚 插件文档」栏一键查阅；**同名 tiddler 已存在一律安全跳过，绝不覆盖你的数据**（v0.16.22） |
| 🎨 **自定义样式** | 「自定义样式」seed：编辑器美化 / 窄屏侧栏隐藏 / menubar 加高 / 批注弹窗等 5 张通用样式表，新 wiki 也能一键初始化（可选，v0.16.22） |
| 🤖 **Agent 工具** | 15 个 `tiddlywiki_*` 工具：检索（**相关度排序 + 命中处片段 + 字段过滤**）、读写、**增量追加**、批量、重命名、**软删除/回收站**、**反向链接**、**附件入库**、**知识库体检**、git 同步与冲突解决（v0.19.0；检索/最近仍在**服务端**排除二进制附件，大 wiki 上从 515MB/17s 降到 ~0.4s） |
| 🛡️ **不会被覆盖的写入** | 所有写入路径（agent 工具 **与** 快速笔记/编辑器路由）都**先读后写**：不传 tags 就保留原有标签、自定义字段与**内容类型**（`text/css`/wikitext 等不会被重置成 Markdown，v0.20.1）；`tiddlywiki_put(..., expectedModified/expectedRevision)` 与 `tiddlywiki_delete(..., expectedModified/expectedRevision)` 乐观并发——读取后若有人（在 TW 编辑器里）改过，写入/删除被拒绝（HTTP 409）而不是静默覆盖或丢进回收站；`tiddlywiki_attach` 的同名标题**默认拒绝**（要覆盖必须 `force: true`）；`tiddlywiki_delete` 默认**软删除进回收站**，`tiddlywiki_trash` 可恢复（v0.19.0 / v0.19.1 / v0.19.5） |
| 🧼 **渲染片段净化** | 回复流卡片与会话汇总注入的 TW 片段先经 **host 白名单净化**（丢 `iframe`/`script`/`svg`/`on*`/`javascript:`/`data:text/html` 等）——TW 自己的解析器只剥 `on*`，`<iframe src="javascript:…">` 会原样通过并在 DSH 页面里执行（v0.19.1 修复的存储型 XSS） |
| 🔒 **写路由方法校验** | 每个写路由只接受自己的 HTTP 方法：跨站 `GET /sync`、`GET /restart`、`GET /upload` 一律 405 且无副作用（v0.19.0 修复了「任意网页一张 `<img>` 即可触发 pull/commit/push」的 CSRF 面） |
| 🔑 **密钥不外泄** | `bridge.token` / `ui.sendToAgent.token` / **`auth.password`**（v0.20.0）在 `/admin/state`、`/admin/config` 的回包里是 `********`（设置页原样保存 ≠ 覆盖，清空即删除），`git.remote` 里的 PAT 打码；**`/tw`、`/api` 与 `POST /render` 都拒绝 `$:/plugins/dsh-tiddlywiki/` 命名空间**——此前 `/render` 能把配置 tiddler 连 token 与 PAT 一起渲染出来（v0.19.3 / v0.20.0） |
| 🧯 **路由不会拖垮进程** | 所有路由经 `guardHandler` 包装：任何 rejection（含代理里 try 之外的 `new URL()`）都变成 413/500 响应，而不是宿主未处理的 promise rejection（那会**直接结束 dsh web 进程**并挂死请求）；剪藏桥 listen 后保留常驻 `error` 监听（v0.19.3） |
| 📊 **回复流卡片** | 工具结果显示原生 TW 卡片（**按笔记自己的内容类型渲染**：Markdown 笔记就是 Markdown，v0.18.0）；`[标题](/dsh-tiddlywiki/tw/#标题)` 点击直达 TW 面板 |
| 📤 **发送给 Agent** | TW 笔记工具栏一键把当前笔记注入所选 dsh 会话（可选工作模式/权限/附加说明）；成功/失败会弹出提示（v0.20.0 修复：此前提示把自由文本当 tiddler 标题传给 TW notifier，全部静默） |
| 🧭 **内嵌编辑器** | 中央列内嵌完整 TW 5 编辑器（同源代理，Tailscale/内网/域名/HTTPS 均可） |
| 🗂️ **右侧边栏 Tab** | DSH 新右侧栏（rightbar）：首页「TiddlyWiki 知识库」入口一键打开，与聊天并排；链接点击可直达（v0.16.21） |
| 🧪 **审计守门** | 第四轮审计（v0.20.0）把 CI 与 `npm run verify:*` 合成一份清单，并补上 `verify-constants`（filter 长度预算）、`/render` 403、auth 打码、notify 与草稿避让回归 |
| 🧩 **Better Sidebar 共存** | 与 dsh-better-sidebar 侧边栏共存（其展开/收起按钮浮在 TW 面板之上）；**不再向该侧边栏注册 TW tab**（v0.17.0 移除了 tab 注册，避免 tab kind 冲突） |
| 📚 **会话知识库 Tab** | 每个会话顶部汇总本会话读写过的 wiki 笔记，TW 原生渲染（host `/render` 片段管线 + 白名单净化，v0.16.19 / v0.19.1） |
| 📝 **快速笔记** | 输入框上方快捷按钮或右下角「知识库」FAB；原生编辑页或 Markdown 卡片两种模式；首页内置「快速记笔记（完整编辑器）」 |
| 📌 **本地剪藏桥** | 可选「剪藏桥 + 书签小工具」：DSH 监听 127.0.0.1 端口接收剪藏请求（Host 校验防 rebinding），点书签弹出浮层——可改标题/编辑选中文字/**勾选图片**，一键写入知识库；文字成笔记（默认 `clip` 标签），图片由桥下载存为**二进制附件**（`type: image/*` + base64，笔记内 `[img[标题]]` 内嵌），随 wiki 自动进 git；图片下载有 **SSRF 守卫**（仅公网 http(s)、逐跳校验重定向，v0.18.0） |
| 🔐 **写操作防跨站** | 所有写路由（笔记/上传/同步/后台/代理）拒绝跨站请求（403），仅同源的 GUI 与内嵌 TW 可写；跨站 GET 与浏览器地址栏直达不受影响（v0.18.0） |
| ✅ **待办四象限** | 首页看板：任务打 `todo` 标签即收录，拖动即可分类/完成（正文附 `q` 字段），逾期/今日到期自动统计 |
| 🌗 **跟随主题** | 内嵌 TW 自适应 DSH 深浅主题（纯内存切换，不进 git） |
| 🔄 **一键同步** | FAB「同步」一键 pull→commit→push，状态点实时反映 git 状态 |
| 💾 **数据即备份** | wiki 文件夹本身就是 git 仓库，自动 commit（60s 防抖） |

---

## 📦 安装

```bash
# ① npm 发布包（推荐）
dsh plugin --profile web add dsh-tiddlywiki

# ② 直接从 GitHub 安装
dsh plugin --profile web add github:bbqisbbq/dsh-tiddlywiki

# ③ 本地开发（link 方式，改完 src 后 npm run build 即生效）
dsh plugin --profile web add link:/path/to/dsh-tiddlywiki
```

装完**重启 dsh web** 生效。首次启动自动完成：初始化 wiki 目录、`git init` 并提交基线、写入**功能必需的 seed**（发送给 Agent 按钮 + 原生渲染路由 + 同源代理基址）与**起步文档**（插件说明 + 示例与文档）；首页/所有文章/自定义样式等为可选项，需要时在设置页「初始化」手动写入。

---

## 🚀 快速开始

1. **安装并重启** dsh web。
2. 侧边栏「**TiddlyWiki**」→ 中央打开完整 TW 编辑器。
3. **随手记**：点输入框上方「📝」或右下角「知识库」→「快速笔记」；或在首页直接用「✍️ 快速记笔记」区块，写完保存即成为 tiddler 并自动进 git。
4. **看文档**：新 wiki 首页（初始化 home-index 后）有「**📚 插件文档**」栏——插件说明、汇总教程、模板都在里面，可自由删改。
5. **收工同步**：「知识库」→「🔁 同步」一键 push 备份。
6. **让 Agent 参与**：直接说「把刚才的会议纪要存进知识库」——Agent 用 `tiddlywiki_*` 工具读写。
7. **发笔记给 Agent**：TW 里打开笔记 → 工具栏「发送给 Agent」→ 选会话 → 作为消息注入。

---

## 📖 使用指南

### 🤖 Agent 工具（15 个）

| 工具 | 说明 |
|---|---|
| `tiddlywiki_search` | 检索（`query` + 可选 `tags[]/tag/since/type/field/value/limit`），**按相关度排序**（标题命中 > 标签 > 正文命中次数），摘要取自**命中处上下文**而不是正文开头 |
| `tiddlywiki_recent` | 最近修改的笔记（倒序），开工快速了解动态 |
| `tiddlywiki_list_tags` | 现有非系统 tag 及计数（已排除只挂在二进制附件上的 tag）；默认列使用最多的 200 个（`limit` 可调、上限 1000），截断时返回 `total`/`truncated` |
| `tiddlywiki_get` | 读单个 tiddler 全文（`modified` 以 ISO 返回，可直接用作 `expectedModified`） |
| `tiddlywiki_put` | 写/覆盖；**新建**未指定类型时默认 `text/markdown`（`$:/` 系统条目除外），**覆盖既有条目时保留原 `type`/tags/自定义字段**（v0.20.1，改类型要显式 `fields.type`）；`expectedModified` + `force` 提供乐观并发保护 |
| `tiddlywiki_batch_put` | 批量写入（`overwrite=false` 跳过已存在；单条失败不影响其余、逐条报错；4 路并发但结果保持入参顺序） |
| `tiddlywiki_append` | **增量追加**：`mode=append\|prepend`、`heading=某标题` 定位段落，写日志/批注无需读全文；与 `put` 同一套写策略（保留原 `type`/tags/自定义字段，新条目才默认 markdown），支持 `fields` 显式覆盖 |
| `tiddlywiki_rename` | 重命名 + 尽量同步其他条目里的引用；旧标题删除失败时如实回报「两份副本都在」 |
| `tiddlywiki_delete` | 删除（幂等）。默认**软删除**进 `$:/dsh-tiddlywiki/trash/`，`permanent=true` 才真删；支持 `expectedModified`/`expectedRevision`/`force` 乐观并发（读后被改动则拒绝，不把人类的新改动丢进回收站） |
| `tiddlywiki_trash` | 回收站：`action=list\|restore\|empty`（索引读不到或损坏时显式报错，绝不把回收站当空的重建） |
| `tiddlywiki_backlinks` | 反向链接：谁用 `[[标题]]`/`{{标题}}` 引用了它、谁把它当标签 |
| `tiddlywiki_attach` | 把**本机文件或公网 http(s) 地址**存成二进制附件（图片/PDF/…），可嵌入某篇笔记；URL 走 SSRF 守卫；**同名 tiddler 已存在时默认拒绝**（避免静默覆盖笔记），确认覆盖要传 `force: true`（tags/自定义字段仍保留） |
| `tiddlywiki_lint` | 知识库体检：垃圾标签 / 死链 / 空笔记 / 缺内容类型的类 Markdown 笔记 |
| `tiddlywiki_git_sync` | `action: pull\|push\|sync` |
| `tiddlywiki_git_resolve` | pull 冲突后按 tiddler 二选一（`keep-local\|keep-remote`） |

**知识库同步纪律**：
1. 开工先 `tiddlywiki_git_sync action=pull`（rebase + autostash，真冲突会 abort 并报文件）。
2. 冲突后用 `tiddlywiki_git_resolve` 二选一解决，再重新 sync（**绝不自动覆盖**）。
3. 收工 `tiddlywiki_git_sync action=sync`（pull → commit → push）。

> 🔍 **检索/最近跳过二进制附件**（v0.16.20）：`search`/`recent` 在**服务端**只取文本 tiddler（无 `type` 字段或 `text/*`），图片/音频/视频/PDF/zip 等二进制 tiddler（base64 正文）不参与检索、不出现在结果里——大 wiki（如数千张书籍扫描页图）从此从 515MB/17s 降到 ~0.4s，也不会被同名书页图刷屏。`get` 对二进制 tiddler 只返回元数据（`binary=true` + 类型/大小 + 链接），不返回 base64 正文。

> ⚠️ `fields.type` 是 TW 的**内容类型保留字段**（`text/markdown` 等），业务分类请放 `tags`，别写进 `fields.type`。

### 🧑‍💻 界面操作

- **📤 发送给 Agent**：TW 工具栏按钮（首次启动自动写入 wiki，ONE-SHOT）。弹层可选**附加说明**（位于消息末尾）、**工作模式**（Agent 预设）、**权限**（权限预设），按工作区分组选会话或新建。消息自带待办说明。
- **🧭 中央列编辑器**：侧边栏「TiddlyWiki」开关（显示名可改 `ui.sidebarLabel`）。
- **🗂️ 右侧边栏 Tab**（v0.16.21）：DSH 新右侧栏展开后，首页会出现「**TiddlyWiki 知识库**」入口盒，点击即在右侧栏以 tab 形式打开完整 TW 编辑器——**与聊天并排**，适合边聊边查/边记。由 `ui.showRightbarTab` 控制（默认开）；老版本 DSH（无右侧栏）自动跳过。
- **🧩 Better Sidebar 共存**：装了 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 时，插件只做 UI 共存（中央 TW 面板的 z-index 自动压在其侧边栏展开/收起按钮之下，按钮始终可点）。**v0.17.0 起不再向 dsh-better-sidebar 注册「TiddlyWiki 知识库」tab**（旧版可用 `ui.showBetterSidebarTab` 关闭）——该 tab 的 kind 会与其它注册方冲突报 `tab kind "dsh-tiddlywiki" is already registered`。右侧边栏入口请用上面的 **右侧边栏 Tab**（DSH 原生 rightbar）。
- **📝 快速笔记**：输入框上方快捷按钮（`ui.showQuickNoteDock`）或 FAB；`ui.quickNoteMode` 选打开方式——**native**（默认，直达 TW 原生编辑页，草稿自动续写）或 **card**（CodeMirror 6 Markdown 高亮、文件上传、多选 tag、草稿自动保存、「🕘 最近」载入、Ctrl+Enter 保存）。
- **📌 本地剪藏桥**（可选，v0.16.24+/v0.16.25 支持图片）：DSH 设置 → 常规配置 → 勾选「**启用本地剪藏桥**」（保存后立即生效）——DSH 即监听 `127.0.0.1:8618` 接收剪藏请求。浏览器书签栏新建书签，把知识库文档里的 JS 代码粘贴为地址，点一下弹出**浮层**：确认/修改标题与划线文字、勾选页面图片（封面自动标出）→「剪藏」即写入 wiki。文字成笔记（默认 `clip` 标签、正文含来源与选中文字、重名自动 `（2）` 去重）；**图片由 DSH 本机下载字节存为二进制附件**（`clip-url`/`clip-note` 溯源字段，笔记内 `[img[标题]]` 内嵌展示；某张下载失败自动降级为链接），全部随 wiki 自动 git commit。「📚 插件文档」栏的 `本地剪藏桥（书签小工具）` seed 文档含完整步骤、书签代码、安全说明与 curl 用法。安全：桥只监听 127.0.0.1 + Host 白名单防 DNS rebinding；**强烈建议设 `bridge.token`**（非空时校验书签的 `x-clip-token` 头，防止任意网页往 wiki 里塞内容）。图片附件按设计不参与 `search`/`recent`（避免刷屏），`get` 只回元数据。
- **🏠 首页（初始化 home-index 后）**：待办四象限（`todo` 标签 + `q` 字段拖放分类）+ 快速记笔记（完整编辑器，勾选「同时加入待办」即建任务）+「所有标签 / 所有文章」入口 +「📚 插件文档」栏（自动收录所有带 `dsh-docs` 标签的 seed 文档）。
- **📚 会话知识库 Tab**：会话顶部 Tab（`ui.tabLabel` 改名、`ui.showSessionTab` 关闭），自动汇总本会话读写过的 wiki 笔记（写入 volatile `$:/temp`，不落盘不进 git），**TW 原生渲染**（v0.16.19 起 `/tw/render` 片段管线，与回复流工具卡同链路），链接点击直达中央 TW 面板，不可编辑。
- **🌗 跟随 DSH 主题**：内嵌 TW 随 DSH 深浅切换 palette，纯内存不写回 wiki（`ui.followDshTheme`/`ui.darkPalette`）。
- **🔧 知识库 FAB**：统一入口（TW 面板开关/重载、快速笔记、同步、TW 服务状态悬停 tip）。同步拉取到新内容会自动重启 TW（同端口）。
- **⚙️ 设置页**：DSH 设置 →「TiddlyWiki 知识库」：状态/重启、常规配置、插件/主题/语言管理、**初始化**（seed 状态与重新初始化）。配置写入 `$:/plugins/dsh-tiddlywiki/config` tiddler，覆盖 cordis `config:` 块（tiddler 优先）。

### 🧩 初始化（一次性预置 seed）：哪些「必备」，哪些「可有可无」

seed 是把「wiki 里预置内容」随插件分发的机制：**ONE-SHOT（只写缺失）+ 安全跳过（同名 tiddler 已存在绝不覆盖你的数据）**，需要时可「重新初始化」恢复、可「反初始化」移除。详细见 [docs/seed-initialization.md](docs/seed-initialization.md)。

| 层级 | seed | 说明 | 首次安装 |
|---|---|---|---|
| 🔒 **核心**（功能必需，不可移除） | `send-to-agent` | TW 工具栏「发送给 Agent」按钮插件 | 自动写 |
| | `render-route` | 原生渲染路由（回复流卡片 / 链接直达依赖） | 自动写 |
| | `tw-web-host` | TW 前端 API 基址 → 同源代理（内嵌编辑器前提） | 自动写 |
| 📖 **起步**（默认写、可移除，**想要完整体验建档案**） | `doc-note` | 「dsh-tiddlywiki 插件说明」笔记 | 自动写 |
| | `starter-docs` | 「示例与文档」：主题汇总页·模板 + 教程 + 三个示例主题页（日志/决策记录/排障） | 自动写 |
| 🎀 **可选**（默认不写、设置页手动、可移除，**可有可无**） | `home-index` | 首页（四象限待办 + 快速记笔记 + 所有标签/所有文章 + 📚 文档栏）——文档中心的「门面」 | 手动 |
| | `all-articles` | 「所有文章」两列分页总览（🤖 Agent / 👤 人工） | 手动 |
| | `ui-styles` | 自定义样式 5 张（编辑器美化 / 窄屏侧栏 / menubar 加高 / 批注弹窗等） | 手动 |
| | `menubar-theme` | menubar 顶栏跟随 DSH 主题换色 | 手动 |
| | `clip-bridge` | 「本地剪藏桥（书签小工具）」使用说明——含书签代码 / 启用步骤 / 安全说明（真功能在插件运行时代码里，此 seed 只预置文档） | 手动 |

- **想获得完整插件体验**：核心 3 项首次安装就有；再补 `home-index`（首页）+ `starter-docs`（示例文档）即是一个开箱即用的文档中心。
- **一个可选项都不想要**：完全不影响功能——设置页「反初始化」即可，核心项受保护不可移除。
- **文档怎么扩散到更多**：以后插件新增的任何说明 / 教程 / 模板类内容都走 seed 并带 **`dsh-docs`** 标签——首页「📚 插件文档」栏自动收录，你无需任何配置。

---

## 🛠 配置

插件行默认配置（缺省即默认，无需手动配置）：

```yaml
- id: dsh-tiddlywiki
  config:
    wikiRoot: "$DSH_HOME/tiddlywiki"   # 缺省自动展开
    wiki: "main"
    port: 0                            # 0 = 自动探测空闲端口
    git:
      autoCommit: true
      debounceMs: 60000
      remote: ""                       # 空 = 仅本地 commit；填了才 push
      branch: "main"
    note:
      tag: "inbox"                     # 快速笔记默认 tag
    bridge:
      enabled: false                   # 本地剪藏桥（书签小工具）；保存后立即生效
      port: 8618                       # 监听端口（127.0.0.1；改后需重启 dsh web 才绑定新端口）
      token: ""                        # 共享口令；非空时校验书签的 x-clip-token 头（强烈建议设置）
      tag: "clip"                      # 剪藏笔记默认 tag
    ui:
      showQuickNote: true              # FAB 里显示快速笔记入口
      showQuickNoteDock: true          # 输入框上方快捷按钮
      quickNoteMode: "native"          # native=TW 原生编辑页 / card=Markdown 卡片
      sidebarLabel: "TiddlyWiki"       # 侧边栏入口显示名
      showPanelStatus: true
      showSyncButton: true
      followDshTheme: true             # 跟随 DSH 深浅主题
      darkPalette: "$:/palettes/CupertinoDark"
      tabLabel: "知识库"               # 会话 Tab 名
      showSessionTab: true
      showRightbarTab: true            # DSH 右侧边栏提供 TiddlyWiki 入口/Tab
      sendToAgent: { enabled: true }
    uiLanguage: ""                     # 留空不干预；"zh-Hans" 自动启用简体
    auth:
      username: ""                     # 默认 loopback 匿名；暴露到非回环才需要
      password: ""                     # 非空时插件内置客户端/就绪探测/浏览器代理都带 Basic 认证（v0.18.0 起真正可用）
```

> **运行时配置**：设置页写入的 `$:/plugins/dsh-tiddlywiki/config` tiddler 是 `config:` 块之上的覆盖层（tiddler 优先、随 wiki git 同步），改 note tag / git / ui 开关**以及剪藏桥端口**都无需动 cordis（端口改动仍需重启 dsh web 重新绑定监听）。

---

## 🌐 远程访问

TW 子进程只监听 **127.0.0.1 回环**；Agent 工具/快速笔记/同步都走 DSH 宿主进程→回环 TW，不受访问入口影响。浏览器里的 TW 编辑器 iframe 经**同源代理** `<DSH origin>/dsh-tiddlywiki/tw/` 访问（v0.6.0 起），所以通过 Tailscale / 内网 / 域名 / HTTPS 访问 DSH 时编辑器照常工作，且 TW 重启不打断编辑中的内容。

---

## 👨‍💻 开发

需要 **Node.js ≥ 22**。

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run build         # clean + host tsdown + client tsdown + wrap（wrap 会校验 id 与体积 <900KB）
npm run selftest      # headless：spawn TW → REST 读写 → git → 退出回收
npm run smoke:client  # client bundle 的 module-loader 形状冒烟
npm run verify        # = verify:static + verify:unit + verify:e2e（本地一键；CI 同款分档）
npm run verify:large  # 3000+ 条目大 wiki：检索耗时 / 二进制零出现 / 真跑 commit（约 1 分钟）
node scripts/verify-send-to-agent-bundle.mjs  # bundle 字段 + 源件逐字一致
node scripts/verify-seed-send-to-agent.mjs    # 全新 wiki 上的 seed E2E
node scripts/verify-clip-bridge.mjs   # 剪藏桥 headless 验收（含 SSRF 守卫）
node scripts/verify-seeds-admin.mjs   # /admin/seeds 状态与 run 的 E2E
```

> 📦 从 **npm 包**安装的用户只有 `lib/` + `src/` + `docs/`（`scripts/` 不在发布包里，避免把构建脚本塞进依赖树）——想跑上面的验收脚本请用 git 仓库：`git clone https://github.com/bbqisbbq/dsh-tiddlywiki && npm install`。

**改 bundle/seed 的再生成流水线**（不要手改 `seed-*.ts` 里的生成常量；bundle 版本号只在 `scripts/bundle/versions.mjs` 定义一处）：

```bash
# 发送给 Agent 按钮（改 scripts/bundle/send-to-agent/ 后）
node scripts/build-send-to-agent-bundle.mjs
node scripts/gen-seed-send-to-agent.mjs scripts/bundle/send-to-agent.bundle.json src/host/seed-send-to-agent.ts
node scripts/verify-send-to-agent-bundle.mjs

# 渲染路由（改 scripts/bundle/render/server-routes/render.js 后；版本在 versions.mjs）
node scripts/build-render-bundle.mjs
node scripts/gen-seed-render.mjs scripts/bundle/render.bundle.json src/host/seed-render.ts

# 首页（改 wiki 的 🏠 主页/所有标签/标签笔记 .tid 后；默认就剥离作者私有人口 +
# 注入「📚 插件文档」栏，确要保留私有内容才加 --keep-private）
node scripts/gen-seed-home.mjs '<wiki>/tiddlers/🏠 主页.tid' '<wiki>/tiddlers/所有标签.tid' '<wiki>/tiddlers/标签笔记.tid' src/host/seed-home.ts

# 自定义样式（改 wiki 的样式 .css + .meta 后；tag 自动收窄为 $:/tags/Stylesheet）
node scripts/gen-seed-ui-styles.mjs '<wiki>/tiddlers/<样式.css>' … src/host/seed-ui-styles.ts

# 示例与文档（starter-docs）/ menubar 主题：直接维护 src/host/seed-starter-docs.ts / seed-menubar-theme.ts

# 随后 npm run build
```

**产物约定**：`lib/` 内**零** `@deepseek-ai` 运行时 import；client 必须 minify（否则 >1MB 被注册表校验拒绝）；`react`/`tiddlywiki` 不打包（运行时解析）。

### 路由参考（开发者）

| 路由 | 方法 | 用途 |
|---|---|---|
| `/dsh-tiddlywiki/status` | GET | 面板健康（service/url/git/tag/ui） |
| `/dsh-tiddlywiki/note` `/edit` `/tags` `/recent` `/get` `/search` | POST/GET | 快速笔记、打开编辑器、tag/最近/单个/搜索（列表路由都支持 `limit`；`/tags` 另支持 `sort=alpha\|count` 与 `total`/`truncated`，v0.19.4） |
| `/dsh-tiddlywiki/render` | POST | TW 片段渲染（host 净化后返回，回复流卡片/会话汇总用，v0.19.1） |
| `/dsh-tiddlywiki/sync` `/upload` `/restart` | POST | 一键同步、文件上传、重启 TW |
| `/dsh-tiddlywiki/session/summary` | POST | 会话「知识库」Tab 汇总 |
| `/dsh-tiddlywiki/agent/sessions` `/modes` `/send` `/create` | GET/POST | TW「发送给 Agent」：会话/模式/发送/新建 |
| `/dsh-tiddlywiki/api/*` | any | 透传 TW 服务（JSON） |
| `/dsh-tiddlywiki/tw/*` | any | 同源 TW 代理（远程访问核心） |
| `/dsh-tiddlywiki/admin/seeds` `/run` `/remove` | GET/POST | seed 状态 / 运行 / 反初始化 |

### 项目结构

```
src/
├── index.ts            # host 入口：装配 WikiServer/路由/工具/提示词/自动 commit
├── sdk.ts              # 自包含 defineTool + dshHomePath（零 @deepseek-ai 运行时依赖）
├── host/
│   ├── wiki.ts         # WikiServer：spawn/kill/自愈/端口探测/就绪轮询；TW_PROXY_PATH 同源代理
│   ├── tw-api.ts       # TiddlyWeb REST 客户端
│   ├── git.ts          # git init/commit/pull/push/sync/status + AutoCommitter
│   ├── routes.ts       # 全部 DSH 路由 + agent-send/create/modes + session/summary
│   ├── http.ts         # 共用 HTTP 助手（readBody/json）
│   ├── clip-bridge.ts  # 本地剪藏桥（v0.16.24）：127.0.0.1 监听 + POST /clip 写 wiki（Host 校验/token/CORS preflight）
│   ├── session-summary.ts # 会话「知识库」Tab 后端
│   ├── admin.ts        # 设置页后台：tiddlywiki.info 读写 + /admin/*
│   ├── config.ts       # ConfigStore：cordis config 基底 + 配置 tiddler 覆盖层
│   ├── seeds.ts        # 统一 seed 注册表（10 项，三层：核心/起步/可选）
│   ├── seed-*.ts       # 各 seed 实现（bundle/首页/ui-styles 常量脚本生成；starter-docs/menubar/clip-bridge 手工维护）
│   └── tools.ts        # 15 个 tiddlywiki_* 工具（列表式注册）
└── client/             # 浏览器半部
    ├── index.ts        # client 入口（inject ['slots']，纯 DOM，永不 throw）
    ├── endpoints.ts    # 客户端同源端点常量
    ├── knowledge-fab.ts / quick-note-dock.ts / note-widget.ts / editor-popup.ts
    │                   # 知识库 FAB / 快捷按钮 / 快速笔记 / 原生编辑弹窗
    ├── markdown-editor.ts  # CodeMirror 6 Markdown 编辑器
    ├── session-summary.ts  # 会话「知识库」Tab（conversation.view 槽位）
    ├── tool-views.ts       # 回复流工具卡片（tool.call.toolview）
    ├── theme-sync.ts / panel.ts / sidebar-entry.ts / sync-button.ts / rightbar-tab.ts
    │                   # 共享 TW iframe 机制在 tw-frame.ts（v0.16.23：lazy-load/status/主题/互斥/live-frame 路由）；
    │                   # TW tab 只注册在 DSH 原生右侧栏（rightbar-tab.ts）
    └── settings-page.ts / ui-config.ts / state.ts / styles.ts / toast.ts
scripts/                # 构建/校验/再生成脚本
docs/seed-initialization.md  # seed 机制详解（权威）
lib/                    # 预构建产物（发布含 lib/**，提交入库；零 @deepseek-ai 运行时 import）
```

---

## 🕘 版本记录

> 最近几个主要版本的一句话记录（完整变更见 [Releases](https://github.com/bbqisbbq/dsh-tiddlywiki/releases) / git log）。

- **v0.20.1**（2026-09-11）：**修复「覆盖已有条目时内容类型被静默重置」**（数据正确性）。`tiddlywiki_put` / `tiddlywiki_append` / `tiddlywiki_batch_put` 覆盖既有条目时会丢掉它的 `type`：`cleanTiddler()` 把 `type` 当成「构造 PUT body 时跳过的字段」，于是 `finalTypeForWrite()` 再补默认值——`put` 把 `text/css` 的样式条目改成 `text/markdown`（整篇 CSS 被当 Markdown 渲染、样式静默失效）、把 wikitext 笔记改成 Markdown；`append` 更彻底：它自己手写 PUT body，连 `type` 都不写，TW 于是回落 `text/vnd.tiddlywiki`（磁盘上 `.md` + `.meta` 变成 `.tid`，`##`/`**粗体**`/表格全按 wikitext 解析）。现在：**覆盖路径一律保留原 `type`**，Markdown 默认值只给**新建**条目（`$:/` 系统条目除外）；`tiddlywiki_append` 与 `put` 共用同一套写策略（`buildWriteTiddler`），并补上了此前缺失的 `fields` 参数；`rename` 与回收站恢复同样不再丢类型。回执也补了诚实提示：新建默认时写「新建且未指定，已默认 markdown」，覆盖时若类型真的变了会写「⚠️ 内容类型已从 X 改为 Y」。守门：新增 `scripts/verify-write-policy.mjs`（7 条纯函数单测，已进 `verify:unit`）与 `verify-audit-fixes.mjs` 的 6 条 E2E（css 保持 css / wikitext 保持 wikitext / markdown 追加不变 / 新建仍默认 markdown / `fields.type` 是唯一改类型入口 / rename+回收站恢复保类型）。

- **v0.20.0**（2026-09-11）：**第四轮代码审计的修复版**（安全 / 用户可见缺陷 / 工程守门 / 死代码清理）。**安全**：① `POST /dsh-tiddlywiki/render` 没有像 `/get`、`/tw`、`/api` 那样拦插件命名空间——TW 的 `/render` 对**任意标题**都渲染，于是 `{"title":"$:/plugins/dsh-tiddlywiki/config"}` 能把配置 tiddler 连 `bridge.token` 与带 PAT 的 `git.remote` 一起渲染出来（本机临时 wiki 实测复现；片段净化器只管标签、管不住正文）。现在抽出一份 `isBlockedProxyTitle()` 并覆盖 `/render`（selftest 断言 403）。② `maskConfigSecrets()` 此前**只遮 token 与 git remote**，而文档一直声称 `auth.password` 也被遮——实测原样返回；现在 `auth.password` 一并打码并附 `passwordSet` 展示位，回填掩码同样被 `stripMaskedSecrets()` 丢弃。**用户可见缺陷**：③ TW 的 `$tw.notifier.display()` 只认**已存在的 tiddler 标题**、不存在时**什么都不做**，而「发送给 Agent」的 `notify()` 传的是自由文本——**所有成功/失败提示都是空操作**（用户点完按钮毫无反馈）；现在先写 `$:/temp/dsh/send-to-agent/notice` 再 display（bundle 0.3.4 → 0.3.5）。④ 快速笔记卡片丢掉了 `404 + {notFound:true}` 的响应体，`notFound` 分支永不成立，于是「条目不存在」被显示成「wiki 服务不可用」；`fetchJson` 现在保留 404 正文。⑤ `/edit` 的草稿查找在 v0.19.5 重构时把分支写反：规范草稿**已存在**时反而直接覆盖（丢用户未保存的编辑），扫描到的异构草稿被改名为新条目（留孤儿）；恢复 `free ? canonical : 复用既有草稿 ?? 时间戳` 的避让语义，并补 E2E 断言。⑥ 会话「知识库」Tab 的「修改」时间用 `Date.parse()` 解析 TW 紧凑格式（`20260101000000000` → NaN）后原样回显成 17 位数字；改用 `parseTiddlerDate()`。⑦ 设置页点「同步 / 重启 TW」会 `refresh()` 重建整块配置表单，**静默丢弃未保存的输入**；现在只有服务端配置真的变了才重建。⑧ `tiddlywiki_search` 的 `field`/`value` 只在工具层生效，客户端卡片不发送、host 路由也不读——卡片列出的是**未过滤**结果；两侧已打通。⑨ 草稿自动保存调用了带副作用的 `getTags()`，会把 tag 框里没回车的半截词提交成标签；新增纯读的 `peekTags()`。**工程守门**：⑩ CI 之前各自维护一份脚本清单，与 `package.json` 双向漂移——`verify-status-cache` 与 `verify-audit-fixes`（v0.19.5 全部数据安全修复的唯一回归）**从未在 CI 跑过**；现在 CI 只调 `npm run verify:static|verify:unit|verify:e2e|verify:large`。⑪ `verify-render-bundle` 的 `module-type` 断言查的是源码注释而不是 tiddler 字段（假断言，字段丢了照样绿）；`verify-package-contents` 不守 `src`/`docs` 也不禁 `scripts/`；均已修正。⑫ 三个浏览器脚本硬编码 `D:/npm-global/...puppeteer-core` 且 Chrome 候选表漂移（Linux 上恒 SKIP），抽出 `scripts/lib/browser-env.mjs`；`waitFor` 与迷你路由分发器各抽成 `scripts/lib/tw-harness.mjs`；`TEXT_LIST_FILTER` 长度预算移进新的 `verify-constants.mjs`（static 档，不再只在两个最重的 TW 套件里断言）。**死代码 / 重复**：⑬ 开启 `tsconfig.noUnusedLocals` 并清掉 16 处死 import/死类型；删 `FLUSH_PROBE_FILE`、`fetchUiConfig({force})`、`sidebar-entry` 的 `initialLabel`、`ToolCallOwnerProps` 未用字段、四个卡片的死 `text` prop、`headerTitle` 的 7 个空 case、`__twDebug`、`panel.ts` 的兼容 re-export、一行包装 `setSessionSummaryTabLabel`；`invalidateStatus()` 由 `invalidateUiConfig()` 一并调用（设置页保存后 FAB/侧栏立即读新值）；`GitStatusView` 三份合成一份，`snippetOf`/`safeEqual`/`assertPublicImageUrl` 各合成一份；客户端端点字面量统一收进 `endpoints.ts`；`defineTool` 从不被读取的 `output.schema` 参数移除。**文档**：修掉过期注释与文档（客户端仍写 `/tw/render`、`tool-views` 头部仍称「HTML 来自本地 wiki 所以安全」、`host/routes.ts` 文件头只列 6 条路由、生成的 seed docstring 仍写 `Never throws.`）。守门：`verify-send-to-agent-bundle` 补外层 version 断言与 notify 回归，`verify-secret-masking` 补 auth 用例，`verify-status-cache` 补 invalidate 联动，selftest 补 `/render` 403。

- **v0.19.5**（2026-09-11）：**第三轮代码审计的修复版**（数据安全 / 正确性 / 客户端网络卫生 / 工具性能）。**数据安全**：① `tiddlywiki_attach` 此前**完全不读旧条目**就 `PUT`——附件标题一旦撞上既有笔记（`会议纪要.png` 之类）会把那篇笔记连 tags/自定义字段/正文一起**静默替换成 base64**，是本轮最危险的一条。现在先读后写（004 = 新建，其余错误照常抛出），撞名时**默认拒绝**并要求 `force: true`（并发令牌只证明「读过」、不等于「同意覆盖」），覆盖时仍保留原 tags 与自定义字段，新建附件也会补 `agent-written`；嵌入笔记（`noteTitle`）同样走写策略。② `/edit`（快速笔记直达 TW 原生编辑器）此前把草稿写死 `text/markdown`，而 TW 保存草稿会把字段抄回原条目——**任何 wikitext 笔记被这样编辑一次就降级成 Markdown**，`!` 标题 / `<$list>` / `[[链接]]` 下次全渲染成源码。现在草稿类型跟随原条目，只有新笔记才回落 Markdown。③ 回收站索引读失败/JSON 损坏时，`delete` 此前把它当「空索引」再全量覆盖 → **之前所有回收站记录变成既查不到、也清不掉的孤儿**（体积还留在 git 里）。现在读失败即中止（新增 `TrashIndexUnavailableError`），损坏也不静默重建，`trash list/restore/empty` 一律显式报错。④ `rename` 先写新标题、再删旧标题，此前若删除失败会**抛裸错**让调用方以为整个重命名没发生；现在如实回报「两份副本都在，请手动删除旧标题」。⑤ `tiddlywiki_delete` 支持 `expectedModified`/`expectedRevision`/`force`——删除比覆盖更具破坏性，此前却没有任何乐观并发保护（`get` → 人类在 TW 里改动 → `delete` 会把新改动一起丢进回收站）。**正确性**：⑥ 会话汇总只探测前 300 篇，却把**所有**条目按探测结果渲染，超出上限的会被谎报成「⚠️ 已删除/不存在」；现在未探测的条目标「（未探测，超出单次查询上限）」。⑦ `/api` 透传补上方法白名单（宿主按 pathname 分发，此前 TRACE 之类的任意方法都会被转发给 TW）。⑧ `/tw` 代理遇到带 body 的 DELETE 不再把请求体留在 socket 上（此前会挂到 30s 超时）。⑨ `/admin/config` 不再把所有失败都当 400（服务不可用/超限走 413/500）；`/upload` 的「超限」判定与 `errorStatus` 统一。⑩ `WikiServer` 成功启动时清掉上一次失败的 `error`（自愈成功后 `/status` 与面板提示不再长期显示过期故障）。**工具性能**：⑪ `batch_put` 从「顺序 2N 次 REST」改为 **4 路有界并发**（结果按入参下标回填，顺序与逐条容错完全不变），`autoCommit` 移出循环。⑫ 快速笔记找草稿从「拉整份 listing」改为**先单条 GET 规范草稿名**，listing 只作兜底。**客户端网络卫生**：⑬ 新增共享的 `/status` 读取器（2s TTL + **在途合并**）——此前中央面板、侧栏框架、同步按钮、快速笔记配置**四处各有一份 `fetchStatus`**，页面加载时会同时发多次请求，而 host 每处理一次 `/status` 要起最多 5 个 git 进程；⑭ `ui-config` 的缓存同样改为 promise（并发调用共享一次请求），失败不缓存。**其它**：`ToolsDeps.noteTag` 死代码删除；`put`/`batch_put` 描述改为「防抖自动 commit（默认 60s）」以免模型误以为写完即提交。守门：新增 `scripts/verify-audit-fixes.mjs`（10 条 E2E，真实 TW + 真实路由，每条都能复现旧缺陷）与 `scripts/verify-status-cache.mjs`（5 条单测，`tsx` 直跑源码），均已并入 `verify:unit` / `verify:e2e`。

- **v0.19.4**（2026-09-11）：**标签列表全面「有界」——最后一个没有上限的列表接口**。`GET /dsh-tiddlywiki/tags` 此前会把**每一个**去重标签（大 wiki 上千个）连同计数全量回给浏览器，而回复流工具卡只是展示前 60 个；`tiddlywiki_list_tags` 更严重——同样全量灌进**模型上下文**。现在：① `/tags` 支持 `limit`（1–500，缺省仍是全量，快速笔记的标签自动补全保留完整词表）与 `sort=alpha|count`（默认 `alpha`，`count` 按使用次数降序），回包新增 `total`（去重后的真实总数）与 `truncated`；② 工具 `tiddlywiki_list_tags` 新增可选 `limit`（默认 200、上限 1000），截断时 render 明说「共 N 个，仅列出最多的 M 个」，不再让模型以为那就是全部；③ 客户端 `TagsCard` 改为直接请求 `?limit=60&sort=count`（不再下载上千条再丢掉），并用 `total` 显示「共 N 个 · …另有 M 个」；④ 顺手消掉重复实现：路由与工具现在共用 `TiddlyWebClient.tagStats()` 一份计数逻辑（此前路由自己遍历一遍，且不跳过 `$:/` 系统标题，两侧口径可能不一致），`/recent`、`/search`、`/tags` 的 limit 解析收进 `readLimit()`/`readOptionalLimit()` 两个助手。守门：selftest 增 6 条断言（截断/`total` 不丢分母/`tags` 与 `items` 同集同序/上限 500/`sort=count` 单调递减/无 limit 时 `truncated=false`），`verify-tools` 增 `list_tags` 的 limit 用例。

- **v0.19.3**（2026-09-11）：**清掉审计清单里剩下的中优先级项**（安全面 / 健壮性 / 正确性）。**密钥不再外泄**：`bridge.token` / `ui.sendToAgent.token` 会被 `GET /admin/state` 与 `POST /admin/config` 的回包替换成 `********`（并给 `tokenSet` 标记），设置页原样保存不会把真 token 覆盖成掩码、清空即删除；`git.remote` 里的 PAT 同时打码，回填同值也被丢弃。更要紧的是**代理旁路**：`/get` 早先禁止读插件配置 tiddler，但 `/tw` 与 `/api` 会把任意路径转发给 TW 子进程，而它的 TiddlyWeb REST 对 `$:/…` 标题照答不误——`GET /dsh-tiddlywiki/tw/recipes/default/tiddlers/%24%3A%2Fplugins%2Fdsh-tiddlywiki%2Fconfig` 实测能拿到配置正文。现在两个代理都拦截 `$:/plugins/dsh-tiddlywiki/` 命名空间（selftest 有回归断言）。**健壮性**：所有路由统一经 `guardHandler` 包装——此前每个注册都是 `void handleX(req,res)`，而宿主没有 `unhandledRejection` 处理器，任何一次 rejection（含代理里 try 之外的 `new URL()`）都会**直接结束 dsh web 进程**、请求挂死；剪藏桥 listen 之后补上**常驻 `error` 监听**（此前移除唯一监听后，运行期 server error 就是未处理事件 → 崩进程），`stop()` 用 `closeAllConnections()` + 1s 上限，keep-alive 不再是卸载时的死等；`/tw` 代理在客户端断连时**中止上游 fetch 并销毁流**（此前会一直拉到 30s 超时）。**正确性**：会话汇总不再把查询失败（超时/5xx）报成「已删除/不存在」（只有 404 才算不存在），来自请求体/会话日志的 sessionId、rename 旧标题、检索词一律 HTML 转义（TW 会原样透传 HTML，汇总片段又会被注入 DSH 页面），sessionId 还加了字符集白名单；`/upload` 改**原子写**（`wx` + 仅对 EEXIST 走后缀链，修掉 TOCTOU 与「任何 access 错误都当名字可用」）、文件名末尾点/空格先规范化（`evil.html.` 此前能绕过可执行扩展名黑名单）；SSRF 白名单补上多播 `224/4`、保留 `240/4`（含 `255.255.255.255`）、`192.0.2.0/24`、`198.51.100.0/24`、`203.0.113.0/24`、`192.88.99.0/24`；`readWikiInfo` 对顶层 `null`/数组给出可读错误而不是 `TypeError`；`/admin/info` 空操作不再重写 `tiddlywiki.info` + 重启 TW，校验失败 400 / 内部失败 500 分开；`/agent/create` 先校验工作模式再建目录（此前未知模式会留下孤儿目录）；body 超限统一 413。

- **v0.19.2**（2026-09-11）：**v0.19.1 的内容 + 让 flush 哨兵真正生效**。v0.19.1 在 npm 上只是被 **staged**（未确认），而那份 tarball 少了下面这个修复，所以补一个版本号（**请以 0.19.2 为准，0.19.1 可以取消掉**）。修复内容：`flushPendingWrites`（「重启 TW 前把 syncer 队列排干」的哨兵）**从来没成功过**——① 它写 `type: 'text/plain'` 却去等 `.tid` 文件，而 TW 的文件系统适配器按内容类型决定扩展名（`text/plain` 实际落 `.txt` + `.txt.meta`）；② 它用 `mtime >= startedAt` 判定，而哨兵是紧接在等待之前写的，Windows 上新文件的 mtime 可能落在同一/前一个时钟刻，条件永不成立。两者叠加 → 每次调用都超时返回 false，而**所有调用方只把它当 warning**：`/sync`、工具 `git_sync`、seed 重启与启动路径的「排干 syncer」全部静默失效（启动路径还白等 8 秒）。现在按「文件名含 `dsh-tiddlywiki_flush-probe` + 文件内容含本次随机戳」判定（与扩展名/时钟无关），实测 <1.2s 返回；selftest 加了断言，另修掉一处「轮询结果被忽略就重启」的测试竞态（首轮 GitHub CI selftest 抓到的 404）。**其余同 v0.19.1**：CI 复活（`.gitattributes` LF + sourcemap 可复现）、渲染片段净化（存储型 XSS）、`/note` `/edit` 共享写策略（不再清掉人类笔记的标签/自定义字段）、重启单飞与启动/teardown 握手、`tiddlywiki_get` 字段摊平、`lint` 两个坏检查、客户端泄漏与草稿回写等。
- **v0.19.1**（2026-09-11）：**第二轮代码审计的修复版 + 让 CI 重新变绿**。**顺带抓出一个"静默失效"的哨兵**：`flushPendingWrites` 一直用 `type: 'text/plain'` 写哨兵、却去等 `.tid` 文件（TW 的文件系统适配器按内容类型决定扩展名，`text/plain` 实际落 `.txt` + `.txt.meta`），叠加 `mtime >= startedAt` 的判定在新写入的同一时钟刻可能永不成立 → 每次调用都超时返回 false，而所有调用方只把它当 warning。也就是说 v0.19.0 声称的「重启前排干 syncer」**其实一直没生效**（`/sync`、工具 `git_sync`、seed 重启与启动路径全都受影响，启动路径还会白等 8 秒）。现在改成**按内容随机戳匹配**（不依赖扩展名、不依赖文件时间），实测 <1.2s 返回，并有 selftest 断言守门。**CI 其实是红的**：`lib/index.js.map` 内嵌源文件原文（sourcemap 的 `sourcesContent`），Windows 工作区是 CRLF、GitHub runner 检出是 LF，Linux 上重建出的 map 与提交版必然不同 → `static` 作业的 `git diff --exit-code -- lib/` 每次失败，而它一挂，另外三个 job（`needs: static`）**根本不会跑**（v0.19.0 声称的四档守门实际停摆）。修法：新增 **`.gitattributes`（`* text=auto eol=lf`）** 把工作区钉成 LF 并重建提交 lib/；顺带补上 **send-to-agent 的「bundle ↔ seed 逐字节」守门**（render 早就有，缺这条时「跑了 build 忘跑 gen」会 CI 全绿却发旧按钮）、`prepublishOnly` 预检、CI 失败时能看懂的错误提示。**安全（存储型 XSS）**：回复流卡片与会话汇总把 TW 片段 `dangerouslySetInnerHTML` 进 DSH 页面，而 TW 的解析器只剥 `on*`——实测 `<iframe src="javascript:…">`、`<a href="javascript:…">`、`<form action="javascript:…">` 全部原样通过（任何写进 wiki 的正文——agent 笔记、剪藏、导入——都能在 DSH 同源页面执行脚本并调用未鉴权的 `/dsh-tiddlywiki/*` 路由）。新增 **host 侧片段净化器**（`src/host/sanitize.ts`：丢 script/style/iframe/object/embed/form/svg/math…、丢 `on*`/`srcdoc`/`srcset`、URL 属性只放行 http(s)/mailto/tel/相对路径/栅格 `data:image/*`，并先做实体解码挡 `&#106;avascript:` 这类混淆），新增 **`POST /dsh-tiddlywiki/render`** 作为客户端唯一渲染入口（客户端不再直连 TW 的未净化 `/tw/render`，因此**老 wiki 也立刻受保护**）；配套 payload 回归 `scripts/verify-render-sanitizer.mjs`（已进 CI）。**数据安全**：`/note` 与 `/edit` 此前不读旧条目就整体 PUT，用同名标题保存会**清掉人类笔记的标签与自定义字段**——现在两条人类路径与 agent 工具共用新的 **`src/host/write-policy.ts`**（先读后写、保留字段、`agent-written` 只给 agent 新建的条目）；快速笔记卡片对「🕘 最近」载入的笔记回传 **`expectedRevision`**，人类在 TW 里的并发修改会让保存得到 **409** 而不是被覆盖；**重启 TW 前先排干 syncer**（`/sync` 与工具 `git_sync` 此前漏了 flush 哨兵——刚保存的笔记可能被重启吞掉）；`WikiServer.restart()` 改为**内部单飞**（admin 路由不受 routes 层互斥保护，并发重启会留下孤儿 TW 进程）；启动任务是 fire-and-forget，teardown 现在**先置 `disposed` 并等它收尾**（插件热更新/禁用时不再「disposer 先跑完、startup 后 spawn」留下孤儿进程与泄漏监听）。**工具层**：`tiddlywiki_get` 的自定义字段此前渲染成 `fields=[object Object]`（单条 GET 的 `fields` 嵌套没摊平）——`q`/`due`/`clip-url` 对模型完全不可见，已修；`tiddlywiki_lint` 的死链检查把**每一条指向图片/附件的链接**都误报成死链（标题集合取自排除二进制的列表），`missing-type` 则**永远不触发**（TW 服务端会给无 type 的条目补 `text/vnd.tiddlywiki`，改用 `[!has[type]]` 过滤器判定），描述与 `checks` 里的 `large-binary` 从未实现，已删除；`tw-api` 的瘦列表（`/tags`、lint 用）加短 TTL 缓存。**客户端**：TW 就绪重试的 40×150ms 定时器、`sync-button` 卸载后的迟到回调、`injectStyles` 的共享 `<style>` 被旧 disposer 删掉、渲染阶段改模块级缓存（改到 effect 阶段）、`tiddlywiki_list_tags` 卡片不截断（现最多 60 个 + 提示余量）；快速笔记「在 TW 中编辑」成功后不再把同一份内容重新写成「未保存草稿」。**工程**：工具层 E2E 从 10 个工具补齐到 **15 个**（并断言一个都不能少）、selftest 新增「人类写路径保留字段 / 409 冲突」与「host /render 净化」端到端断言、`package-lock.json` 版本与 npm 描述同步。

- **v0.19.0**（2026-09-11）：**按代码审计结论做的全量修复 + 一批新能力**（安全 / 数据安全 / 工具层 / 客户端 / 工程）。**安全**：① 每个路由现在**校验 HTTP 方法**（此前 `http.ts` 主动放行 GET、宿主按 pathname 分发，于是 `GET /dsh-tiddlywiki/sync` 会 pull+commit+**push**、`GET /restart` 重启 TW、`GET /upload` 落文件——任意网页一张 `<img>` 即可触发；实测复现，现已一律 405 且无副作用）；② 剪藏桥 SSRF 守卫的 IPv6 判定改为**按字节解析**（此前 `::ffff:7f00:1`、`0:0:0:0:0:0:0:1`、`::0:1` 等回环写法全部放行——实测复现）；图片下载改为**逐跳 pin 住已校验的 IP**（堵 DNS rebinding TOCTOU）、**流式限长**（不再先全量缓冲再判 15MB）、禁用透明解压；③ TW 子进程的 spawn 日志**不再写明文口令**（该日志经无需认证的 `GET /status` 返回），`/status` 还会脱敏 git remote 里的 token、剪藏桥健康接口不再回显 port/tag/tokenSet、`/get` 不再暴露插件配置 tiddler、`/agent/sessions` 补上 token 守卫、token 比较改常数时间、`/tw` 代理改为**流式转发**（大附件不再整包进内存）、上传拒绝 html/svg 等可在同源执行的文件、`/note`/`/edit` 拒绝 `$:/` 标题。**数据安全**：④ 新增 `tiddlywiki/markdown` **插件自举**——全新 wiki 是用 `--init server` 建的，不含 markdown 插件，而插件默认把每篇笔记写成 `text/markdown`，此前新用户开箱即见 Markdown 源码；⑤ `tiddlywiki_put` 覆盖已有笔记时**不再丢掉原有的标签与自定义字段**（PUT 是整体替换，旧实现只发 title+text；单条 GET 的自定义字段还嵌套在 `fields` 里，一并修掉）；⑥ 新增**乐观并发**：`expectedRevision`/`expectedModified` + `force`，人类在 TW 编辑器里的改动不再被静默覆盖；⑦ `tiddlywiki_delete` 默认**软删除进回收站**（`tiddlywiki_trash` 可 list/restore/empty）；⑧ `readWikiInfo` 只把 ENOENT 当「没有配置」（此前读失败=空配置，设置页保存会整文件覆盖 `tiddlywiki.info`），写入改为备份 + 原子替换；seed 的 `tw-web-host` check 不再吞错；重启 TW 前用**flush 哨兵**排出 syncer 队列（force 重新初始化曾随机丢掉 `tw-web-host`）。**工具层（10 → 15 个）**：新增 `tiddlywiki_append`（增量追加 / 段落定位）、`tiddlywiki_backlinks`、`tiddlywiki_attach`（本机文件或公网 URL → 二进制附件）、`tiddlywiki_lint`（垃圾标签 / 死链 / 空笔记 / 缺内容类型）、`tiddlywiki_trash`；`search` 改为**相关度排序 + 命中处上下文片段 + 字段过滤 + limit 上限 + TW 紧凑日期解析**（此前 `since` 过滤恒为空）、`list_tags` 不再统计只挂在二进制附件上的标签、`batch_put` 的单条失败不再被参数预校验整批打断、列表加短 TTL 缓存。**客户端**：草稿卸载/刷新前落盘、草稿按窗口分键（不再跨标签页互相覆盖）、`session-summary` 自愈循环与卸载后 setState 修复、中央面板 `hidden` 状态修正、三个常驻定时器加上停止条件、wiki 链接不再吞掉 Ctrl/中键、编辑器弹窗补 `role=dialog` 与焦点、列表项键盘可达、21 处 `:focus-visible`、移动端 `touch-action`、`numField` 的 `0` 不再被吞。**工程**：新增 **GitHub Actions CI**（静态检查 + 自测 + 单元 + E2E 四档，含 `git diff --exit-code -- lib/` 抓「改了 src 忘了 build」）、9 个新验收脚本（auth 模式此前零覆盖、工具层、seed 读失败反例、git 冲突、崩溃自愈、大 wiki、render bundle 逐字节、发布包内容、版本一致性）、`npm run verify:*` 方便本地一键跑、`lib/client.bundle.js` 不再入库、AGENTS 的 `grep @deepseek-ai` 检查修正为「真实 import」。**升级提示**：重启 dsh web 后新会话生效；客户端改动需刷新页面。
- **v0.18.0**（2026-09-10）：**一轮全量代码审计后的修复版**（数据安全 / 安全面 / 前端稳定性 / 工程卫生，共 40+ 项）。**数据不再静默丢失**：① seed 只在**真的 404** 时才认为条目缺失（此前任何读取错误都被当「不存在」，瞬时故障会让非 force 的启动 seed 覆盖你改过的同名笔记、`$:/DefaultTiddlers`、send-to-agent / render bundle）；② `wiki/.gitignore` 不再每次启动被整份重写（用户自定规则改前会被冲掉）；③ 配置 tiddler 读失败不再清空内存覆盖层（随后在设置页保存一项配置会丢掉其余全部覆盖）；④ 只有 **render-route 真的重写后**才重启 TW，且要等它落盘（否则重启会丢掉未 flush 的写入——这条是本版新引入又被测试抓出的回归）。**正确性**：`/render` 现在按 tiddler 自己的 `type` 渲染——**Markdown 笔记在回复流卡片/汇总里终于按 Markdown 渲染**（此前硬编码 wikitext，`## 现象` 会被当成 wikitext 列表，实测复现）。**安全**：所有写路由（`/admin/*`、`/note`、`/edit`、`/upload`、`/sync`、`/restart`、`/api`、`/tw` 的写方法）加**同源/CSRF 守卫**（跨站写请求 403，跨站 GET 不受影响）；剪藏桥图片下载加 **SSRF 守卫**（仅公网 http(s)，逐跳校验重定向，拒绝回环/内网/云元数据地址）；`bridge.port` 设置页改动现在**真的生效**（此前只读 cordis 基座）；`auth.username/password` 从此**可用**（内置 REST 客户端与就绪探测带 Basic 认证，代理转发 `WWW-Authenticate` 让浏览器弹登录框，此前配置了用户名会让插件 20s 后启动失败）。**前端**：编辑器弹窗不再因同草稿重开而整机重载、并纳入面板互斥；中央面板自愈列元素重建；右栏 Tab 重新可见会重新探测状态；侧边栏入口插入不再抛 `NotFoundError` 连带拖垮 FAB/面板；同步中不再被 30s 轮询覆盖状态；`injectStyles` 可卸载（热重载拿到新样式）；每处 mount 独立 try/catch；面板的 DOM 观察/滚动测量合并到 requestAnimationFrame（流式输出时不再每帧强制样式重算）。**工具与仓库**：`put`/`batch_put` 不再把读取失败当新条目而误打 `agent-written`，`fields` 不能覆盖 `title/text/tags`，`batch_put` 逐条报告失败；git 的 commit 与 pull 串行化（不再争 `.git/index.lock`）；`/status` 的 git 摘要加 2s 缓存（每次调用少跑 5 个 git 进程）；请求中途断开不再挂住路由；自动端口被占时会重新探测；`tiddlywiki.info` 损坏不再让后台 500；会话汇总对后代会话/条目数设上限。**工程卫生**：bundle 版本单一来源（`scripts/bundle/versions.mjs`，渲染路由 0.2.0）、生成器从 bundle 读版本（外层 0.3.2 漂移修正为 0.3.4）、发布包不再带 `client.bundle.js` 中间产物、`verify-*` 假阳性修复（未 await 的用例、被当成断言的 console.log）、selftest 失败也会回收 TW 子进程、`gen-seed-home` 默认剥离私有人口、`verify-menubar-theme` 不再默认打作者本机端口。
- **v0.17.0**（2026-09-10）：**移除：DSH Better Sidebar（dsh-better-sidebar）Tab 集成**。旧版通过 `ctx.betterSidebar.registerTab({id:'dsh-tiddlywiki'})` 注册的 tab kind 会与其它注册方冲突，浏览器控制台报 `sidebarRight: tab kind "dsh-tiddlywiki" is already registered (extension)`；本版**整体删除**该注册路径（删除 `better-sidebar-tab.ts`、client 入口的挂载块，以及 `ui.showBetterSidebarTab` 配置项/设置页开关），插件不再引用 `ctx.betterSidebar` 服务。与 dsh-better-sidebar 的**界面共存**（中央面板 z-index 让位于其侧边栏按钮）保留；右侧边栏入口请用 DSH 原生 rightbar（`ui.showRightbarTab`）。**更新后刷新页面**生效；旧版可临时用 `ui.showBetterSidebarTab=false` 规避冲突。
- **v0.16.28**（2026-09-10）：**修：拖拽版剪藏书签在知乎等真实页面报 `SyntaxError: Unexpected token ';'`**。根因（真实 Chrome 实验证实）：0.16.27 把书签 href 做 **HTML 实体转义**（`&quot;`/`&amp;`/`&lt;`），但浏览器的 `a.href` **不做实体还原**——拖拽成书签后存的就是实体文本，执行时即解析失败。修复：href 改为 **percent-encoding**（`CLIP_BRIDGE_DRAG_HREF`，属性里只剩 `%XX`，天然无需任何属性转义）；Chrome 执行 `javascript:` URL 前会 percent 解码（实测通过）。浏览器 E2E 升级为**直接以编码 href 走 `location.href` 执行**（完全等价拖拽书签的执行路径）并断言浮层弹出；静态验收改为 `decodeURIComponent(href) === 代码常量` 一致性校验。行为不变——**已拖过旧版书签的用户需重新初始化 seed 后重新拖一次**（旧书签仍然坏的，因为里面的代码是实体文本）。
- **v0.16.27**（2026-09-10）：**剪藏书签支持「拖拽安装」**。seed 文档新增一个**可拖拽按钮**（markdown 内嵌原始 HTML 锚点，href 即书签代码）——按住拖到浏览器书签栏/地址栏松手即装好，免去复制粘贴；代码 fence 保留作兜底。书签代码抽成单一常量 `CLIP_BRIDGE_BOOKMARKLET`（锚点 href 做 HTML 实体转义），并新增**同步一致性校验**（`verify-clip-bridge.mjs`：href 解码后与代码逐字相等）与**浏览器 E2E**（`verify-clip-bridge-browser.mjs`：真实 TW + 无头 Chrome 渲染真实 seed 文档，断言 javascript: href 原样保留 / draggable / 解码一致 / 真浏览器里执行书签弹出浮层 / 无 JS 异常）。
- **v0.16.26**（2026-09-10）：**修：剪藏书签在真实页面上崩溃**（`Cannot set properties of null (setting 'value')`）。根因：浮层字段在 `p` 尚未挂到 document 前就用 `document.getElementById` 取值（脱离文档树查不到 → null）；同时 `cb_*` id 可能与页面自身元素冲突。修复：所有浮层字段改为 `p.querySelector` 作用域内查找 + 字段赋值挪到 `appendChild` 之后；并把书签放进 **jsdom 真实 DOM 端到端跑通**（浮层/填充/选图/提交载荷/结果态 12 项全过）作为验证，`verify-clip-bridge.mjs` 新增静态回归断言（禁未限定 getElementById + 挂载时序）。行为无变化，仅书签代码（seed 文档）修复。
- **v0.16.25**（2026-09-10）：**剪藏桥支持图片剪藏（浮层选图）**。书签升级为**选择式浮层**：可改标题/编辑选中文字，浮层列出页面图片缩略图（自动跳过 <80px 小图标与 data:/blob: 占位、去重，`og:image` 标「封面」并默认勾选）勾选图片后一键剪藏。图片由桥（DSH 进程侧）**下载字节存为二进制附件 tiddler**（`type: image/*` + base64 正文，即 TW 原生附件形态；`clip-url`/`clip-note` 溯源），笔记改用 wikitext 用 `[img[标题]]` 内嵌展示；某张下载失败自动降级为链接、不阻塞整次剪藏；纯文字剪藏保持原 markdown 路径不变。安全不变（127.0.0.1 + Host 校验 + 可选 token；下载带 referer/UA 应对常见防盗链）。验收新增 image-flow 测试 + 书签语法检查（`verify-clip-bridge.mjs` 24 项全过）。

- **v0.16.24**（2026-09-09）：**新：本地剪藏桥 + 书签小工具**。DSH 进程内新增只监听 **127.0.0.1** 的 HTTP 桥（配置组 `bridge.*`：`enabled` 默认关、`port` 默认 8618、`token` 可选共享口令、`tag` 默认 `clip`）——浏览器书签（JS 小工具）把当前页标题/URL/选中文字 POST 给它，经唯一写入通道落进 wiki（markdown、重名自动 `（2）` 去重、默认 `clip` 标签、随 wiki 自动 git commit）。安全：Host 头白名单防 DNS rebinding、CORS/PNA 预检放行（https 页面书签可用）、`bridge.token` 强烈建议设置。附**可选 seed** `clip-bridge`：「本地剪藏桥（书签小工具）」说明文档（含书签代码/启用步骤/安全说明/curl 用法，打 `dsh-docs` 标签进「📚 插件文档」栏，可反初始化）；设置页新增 4 个配置字段。`enabled`/`token`/`tag` 设置页保存即生效，改端口需重启 dsh web。

- **v0.16.23**（2026-09-09）：**新：DSH Better Sidebar（dsh-better-sidebar）集成**。插件通过 `ctx.betterSidebar` 服务注册 TiddlyWiki 为 Better Sidebar 侧边栏的 tab 类型——+ 菜单点击即以 tab 打开完整 TW 编辑器（同源代理 iframe，与聊天并排）；TW iframe 机制抽成共享模块（rightbar/better-sidebar 复用：lazy-load / status 轮询 / 主题同步 / hash 导航 / 互斥协议），回复流 wiki 链接在同一处统一路由到任一可见的侧边 TW tab。配置 `ui.showBetterSidebarTab`（默认 true）可开关；未安装 Better Sidebar 自动跳过。**更新后刷新页面**即可看到入口。
- **v0.16.22**（2026-09-09）：**seed 体系三层化 + 文档中心起步包**。① 分层：**核心**（自动、不可移除：发送按钮/渲染路由/代理基址）+ **起步**（首次安装默认写、可移除：插件说明 + 新增「示例与文档」seed——主题汇总模板/教程/三个示例主题页）+ **可选**（手动：首页/所有文章/新增「自定义样式」seed/顶栏主题）；所有种子**安全跳过**（同名 tiddler 已存在绝不覆盖）。② 新增 **`dsh-docs`** 文档合集约定：所有 seed 文档打该标签，首页「📚 插件文档」tabs 栏自动收录。③ seed 版首页改为**通用版**（`gen-seed-home --strip-private`：剥离作者私有人口，注入文档栏）。④ **修**：首页快速记笔记的 tags 筛选器 bug（`then[[todo]]` 操作数双括号导致「筛选器错误」被拆成 6 个 tag → 改为 `then[todo]`）。
- **v0.16.21**（2026-09-09）：**新：DSH 右侧边栏（rightbar）集成**。注册 TiddlyWiki 为右侧栏 tab 类型——rightbar 首页出现「**TiddlyWiki 知识库**」入口盒，点击即在右侧栏以 tab 形式打开完整 TW 编辑器（同源代理 iframe，跟随 DSH 主题），**与聊天并排**；配置 `ui.showRightbarTab`（默认 true）可开关。**更新后刷新页面**即可看到入口。
- **v0.16.20**（2026-09-09）：**修：`search`/`recent` 在大 wiki 上超时**。根因：列表请求把全部 tiddler（含图片等二进制附件）的 base64 正文拉回来（2418 个 tiddler ≈ 515MB/17s）。修复：`search`/`recent`/`get` 在**服务端**只取文本 tiddler（无 `type` 或 `text/*`）；二进制 tiddler 完全排除，`get` 对二进制只回元数据。实测 515MB/17s → **6.24MB/0.3s**。
- **v0.16.19**（2026-09-07）：**修：会话「知识库」Tab 把汇总当源码显示**——TW 5.4.1 把 `$:/temp/` 条目一律按代码块渲染；改为 `/tw/render` 原生片段管线（与回复流工具卡同链路），不再用 iframe/story view。
- **v0.16.18**（2026-09-07）：README 全面精简重写；seed 优化——首页 seed 跟随 wiki 现状、修「所有文章」回主页死链、doc-note 文案修正。
- **v0.16.17**（2026-09-07）：点击快速笔记可选直达 TW 原生编辑页（`ui.quickNoteMode`）+ 修「在 TW 中编辑」弹窗 ✕ 关不掉。
- **v0.16.16**（2026-09-07）：修会话知识库 Tab 误入编辑草稿显示源码——三层防误编辑（清残留草稿/吞草稿创建/禁 ✏️）。
- **v0.16.15**（2026-09-07）：`put`/`batch_put` 未指定类型自动默认 `text/markdown`；警告 `fields.type` 是内容类型保留字段。
- **v0.16.14**（2026-09-07）：修知识库 Tab「佚失条目」根因——浏览器端 TW 天生排除 `$:/temp`，改为 iframe 就绪后注入 + 原生 hash 导航。
- **v0.16.11**（2026-09-06）：新增会话顶部「知识库」Tab（本会话相关 wiki 汇总，volatile `$:/temp`）。
- **v0.16.0**（2026-09-05）：回复流原生 TW 工具卡片 + 可点击 wiki 链接（新增 `render-route` seed）。
- **v0.15.0**（2026-09-05）：初始化不强制 + 可反初始化（seed 拆核心/可选两层）。
- **v0.14.0**（2026-09-05）：「发送给 Agent」按钮独立图标 + 附加说明 + 权限选择。
- **v0.13.0**（2026-09-04）：menubar 顶栏主题自适应。
- **v0.12.0**（2026-09-04）：新默认主页 + 「所有文章」两列分页页。
- **v0.11.0**（2026-09-04）：「发送给 Agent」支持选择工作模式（Agent 预设）。
- **v0.10.0**（2026-09-04）：统一 seed 注册表 + 设置页「初始化」。
- **v0.8.0**（2026-09-04）：嵌入式 TW 跟随 DSH 深浅主题。
- **v0.7.0**（2026-09-03）：TW 一键把当前笔记发送到 dsh 会话。
- **v0.6.0**（2026-09-03）：同源代理（远程访问核心）。
- **v0.5.0**（2026-09-03）：Agent 工具扩充 + 快速笔记草稿自动保存 + 统一知识库 FAB。

---

## 📦 发布

```bash
npm publish    # 版本号在 package.json；文件白名单见 files 字段
```

`tiddlywiki` 依赖体较大（含全部语言包/插件）。

---

## 🔗 仓库与发布元数据

- **GitHub**：https://github.com/bbqisbbq/dsh-tiddlywiki
- **npm**：`dsh-tiddlywiki`（https://www.npmjs.com/package/dsh-tiddlywiki）
- 说明笔记、首页、示例文档、样式等预置内容由 seed 机制写入 wiki（见 [🧩 初始化](#-初始化一次性预置-seed哪些必备哪些可有可无)）
- MIT；Node ≥ 22；GitHub topics：`dsh` `dsh-plugin` `tiddlywiki` `knowledge-base` `note-taking` `git-sync` `agent-tools` 等
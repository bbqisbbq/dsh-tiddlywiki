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
| 🤖 **Agent 工具** | 10 个 `tiddlywiki_*` 工具：检索、读写、批量、重命名、删除、git 同步与冲突解决（v0.16.20 起检索/最近在**服务端**排除二进制附件，大 wiki 上从 515MB/17s 降到 ~0.4s） |
| 📊 **回复流卡片** | 工具结果显示原生 TW 卡片；`[标题](/dsh-tiddlywiki/tw/#标题)` 点击直达 TW 面板 |
| 📤 **发送给 Agent** | TW 笔记工具栏一键把当前笔记注入所选 dsh 会话（可选工作模式/权限/附加说明） |
| 🧭 **内嵌编辑器** | 中央列内嵌完整 TW 5 编辑器（同源代理，Tailscale/内网/域名/HTTPS 均可） |
| 🗂️ **右侧边栏 Tab** | DSH 新右侧栏（rightbar）：首页「TiddlyWiki 知识库」入口一键打开，与聊天并排；链接点击可直达（v0.16.21） |
| 🧩 **Better Sidebar Tab** | dsh-better-sidebar 侧边栏：+ 菜单注册 TiddlyWiki tab，与聊天并排；链接点击可直达；未安装该插件自动跳过（v0.16.23） |
| 📚 **会话知识库 Tab** | 每个会话顶部汇总本会话读写过的 wiki 笔记，TW 原生渲染（`/tw/render` 片段管线，v0.16.19） |
| 📝 **快速笔记** | 输入框上方快捷按钮或右下角「知识库」FAB；原生编辑页或 Markdown 卡片两种模式；首页内置「快速记笔记（完整编辑器）」 |
| 📌 **本地剪藏桥** | 可选「剪藏桥 + 书签小工具」：DSH 监听 127.0.0.1 端口接收剪藏请求（Host 校验防 rebinding），点书签弹出浮层——可改标题/编辑选中文字/**勾选图片**，一键写入知识库；文字成笔记（默认 `clip` 标签），图片由桥下载存为**二进制附件**（`type: image/*` + base64，笔记内 `[img[标题]]` 内嵌），随 wiki 自动进 git |
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

### 🤖 Agent 工具（10 个）

| 工具 | 说明 |
|---|---|
| `tiddlywiki_search` | 检索（`query` + 可选 `tags[]/tag/since/type/limit`），返回标题/标签/修改时间/摘要 |
| `tiddlywiki_recent` | 最近修改的笔记（倒序），开工快速了解动态 |
| `tiddlywiki_list_tags` | 现有非系统 tag 及计数 |
| `tiddlywiki_get` | 读单个 tiddler 全文 |
| `tiddlywiki_put` | 写/覆盖；未指定类型时自动默认 `text/markdown`（`$:/` 系统条目除外） |
| `tiddlywiki_batch_put` | 批量写入（`overwrite=false` 跳过已存在） |
| `tiddlywiki_rename` | 重命名 + 尽量同步其他条目里的引用 |
| `tiddlywiki_delete` | 删除（幂等） |
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
- **🧩 Better Sidebar Tab**（v0.16.23）：安装了 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 插件时，其侧边栏 **+ 菜单**会出现「TiddlyWiki 知识库」tab，点击即打开完整 TW 编辑器（同一套同源代理 iframe / 主题跟随 / 互斥协议，与右侧栏完全相同），**与聊天并排**。由 `ui.showBetterSidebarTab` 控制（默认开）；未安装 Better Sidebar 自动跳过；Better Sidebar 自己的设置页也会为该 tab 提供独立的启用开关。**更新后刷新页面**即可看到入口。
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
      port: 8618                       # 监听端口（127.0.0.1；改后需重启 dsh web）
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
      password: ""
```

> **运行时配置**：设置页写入的 `$:/plugins/dsh-tiddlywiki/config` tiddler 是 `config:` 块之上的覆盖层（tiddler 优先、随 wiki git 同步），改 note tag / git / ui 开关无需动 cordis。

---

## 🌐 远程访问

TW 子进程只监听 **127.0.0.1 回环**；Agent 工具/快速笔记/同步都走 DSH 宿主进程→回环 TW，不受访问入口影响。浏览器里的 TW 编辑器 iframe 经**同源代理** `<DSH origin>/dsh-tiddlywiki/tw/` 访问（v0.6.0 起），所以通过 Tailscale / 内网 / 域名 / HTTPS 访问 DSH 时编辑器照常工作，且 TW 重启不打断编辑中的内容。

---

## 👨‍💻 开发

需要 **Node.js ≥ 22**。

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run build         # clean + host tsdown + client tsdown + wrap
npm run selftest      # headless：spawn TW → REST 读写 → git → 退出回收
node scripts/verify-clip-bridge.mjs   # 剪藏桥 headless 验收（build 后跑）
node scripts/verify-seeds-admin.mjs   # /admin/seeds 状态与 run 的 E2E
```

**改 bundle/seed 的再生成流水线**（不要手改 `seed-*.ts` 里的生成常量）：

```bash
# 发送给 Agent 按钮（改 scripts/bundle/send-to-agent/ 后）
node scripts/build-send-to-agent-bundle.mjs
node scripts/gen-seed-send-to-agent.mjs scripts/bundle/send-to-agent.bundle.json src/host/seed-send-to-agent.ts
node scripts/verify-send-to-agent-bundle.mjs

# 渲染路由（改 scripts/bundle/render/server-routes/render.js 后）
node scripts/build-render-bundle.mjs
node scripts/gen-seed-render.mjs scripts/bundle/render.bundle.json src/host/seed-render.ts

# 首页（改 wiki 的 🏠 主页/所有标签/标签笔记 .tid 后；必须 --strip-private，
# 产出通用版：剥离作者私有人口 + 注入「📚 插件文档」栏）
node scripts/gen-seed-home.mjs '<wiki>/tiddlers/🏠 主页.tid' '<wiki>/tiddlers/所有标签.tid' '<wiki>/tiddlers/标签笔记.tid' src/host/seed-home.ts --strip-private

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
| `/dsh-tiddlywiki/note` `/edit` `/tags` `/recent` `/get` `/search` | POST/GET | 快速笔记、打开编辑器、tag/最近/单个/搜索 |
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
│   └── tools.ts        # 10 个 tiddlywiki_* 工具（列表式注册）
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
    │                   # better-sidebar-tab.ts 经 ctx.betterSidebar 注册 DSH Better Sidebar 的 TW tab（v0.16.23）
    └── settings-page.ts / ui-config.ts / state.ts / styles.ts / toast.ts
scripts/                # 构建/校验/再生成脚本
docs/seed-initialization.md  # seed 机制详解（权威）
lib/                    # 预构建产物（发布含 lib/**，提交入库；零 @deepseek-ai 运行时 import）
```

---

## 🕘 版本记录

> 最近几个主要版本的一句话记录（完整变更见 [Releases](https://github.com/bbqisbbq/dsh-tiddlywiki/releases) / git log）。

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
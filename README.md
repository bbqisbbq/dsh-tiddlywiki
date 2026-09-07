# dsh-tiddlywiki

> 把 **TiddlyWiki 5** 变成 DSH 的**持久知识库**：Agent 用 `tiddlywiki_*` 工具读写笔记，你在界面里用完整 TW 编辑器或快速笔记记录，一切通过 **git** 自动同步备份。

[![npm](https://img.shields.io/npm/v/dsh-tiddlywiki)](https://www.npmjs.com/package/dsh-tiddlywiki)
[![license](https://img.shields.io/npm/l/dsh-tiddlywiki)](https://github.com/bbqisbbq/dsh-tiddlywiki/blob/main/LICENSE)
[![GitHub](https://img.shields.io/github/stars/bbqisbbq/dsh-tiddlywiki)](https://github.com/bbqisbbq/dsh-tiddlywiki)

---

## ✨ 特性一览

| 能力 | 说明 |
|---|---|
| 🤖 **Agent 工具** | 10 个 `tiddlywiki_*` 工具：检索、读写、批量、重命名、删除、git 同步与冲突解决 |
| 📊 **回复流卡片** | 工具结果显示原生 TW 卡片；`[标题](/dsh-tiddlywiki/tw/#标题)` 点击直达 TW 面板 |
| 📤 **发送给 Agent** | TW 笔记工具栏一键把当前笔记注入所选 dsh 会话（可选工作模式/权限/附加说明） |
| 🧭 **内嵌编辑器** | 中央列内嵌完整 TW 5 编辑器（同源代理，Tailscale/内网/域名/HTTPS 均可） |
| 📚 **会话知识库 Tab** | 每个会话顶部汇总本会话读写过的 wiki 笔记，TW 原生渲染（`/tw/render` 片段管线，v0.16.19） |
| 📝 **快速笔记** | 输入框上方快捷按钮或右下角「知识库」FAB；原生编辑页或 Markdown 卡片两种模式 |
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

装完**重启 dsh web** 生效。首次启动自动完成：初始化 wiki 目录、`git init` 并提交基线、写入**功能必需**的 seed（「发送给 Agent」按钮 + 同源代理基址）。可选项（说明笔记/首页/所有文章/menubar 主题）需在设置页「初始化」手动写入。

---

## 🚀 快速开始

1. **安装并重启** dsh web。
2. 侧边栏「**TiddlyWiki**」→ 中央打开完整 TW 编辑器。
3. **随手记**：点输入框上方「📝」或右下角「知识库」→「快速笔记」，写完保存即成为 tiddler 并自动进 git。
4. **收工同步**：「知识库」→「🔁 同步」一键 push 备份。
5. **让 Agent 参与**：直接说「把刚才的会议纪要存进知识库」——Agent 用 `tiddlywiki_*` 工具读写。
6. **发笔记给 Agent**：TW 里打开笔记 → 工具栏「发送给 Agent」→ 选会话 → 作为消息注入。

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

> ⚠️ `fields.type` 是 TW 的**内容类型保留字段**（`text/markdown` 等），业务分类请放 `tags`，别写进 `fields.type`。

### 🧑💻 界面操作

- **📤 发送给 Agent**：TW 工具栏按钮（首次启动自动写入 wiki，ONE-SHOT）。弹层可选**附加说明**（位于消息末尾）、**工作模式**（Agent 预设）、**权限**（权限预设），按工作区分组选会话或新建。消息自带待办说明。
- **🧭 中央列编辑器**：侧边栏「TiddlyWiki」开关（显示名可改 `ui.sidebarLabel`）。
- **📝 快速笔记**：输入框上方快捷按钮（`ui.showQuickNoteDock`）或 FAB；`ui.quickNoteMode` 选打开方式——**native**（默认，直达 TW 原生编辑页，草稿自动续写）或 **card**（CodeMirror 6 Markdown 高亮、文件上传、多选 tag、草稿自动保存、「🕘 最近」载入、Ctrl+Enter 保存）。
- **📚 会话知识库 Tab**：会话顶部 Tab（`ui.tabLabel` 改名、`ui.showSessionTab` 关闭），自动汇总本会话读写过的 wiki 笔记（写入 volatile `$:/temp`，不落盘不进 git），**TW 原生渲染**（v0.16.19 起 `/tw/render` 片段管线，与回复流工具卡同链路，不再用 iframe/story view），链接点击直达中央 TW 面板，不可编辑。
- **🌗 跟随 DSH 主题**：内嵌 TW 随 DSH 深浅切换 palette，纯内存不写回 wiki（`ui.followDshTheme`/`ui.darkPalette`）。
- **🔧 知识库 FAB**：统一入口（TW 面板开关/重载、快速笔记、同步、TW 服务状态悬停 tip）。同步拉取到新内容会自动重启 TW（同端口）。
- **⚙️ 设置页**：DSH 设置 →「TiddlyWiki 知识库」：状态/重启、常规配置、插件/主题/语言管理、**初始化**（seed 状态与重新初始化）。配置写入 `$:/plugins/dsh-tiddlywiki/config` tiddler，覆盖 cordis `config:` 块（tiddler 优先）。

### 🧩 初始化（一次性预置）

seed 注册表分两层（详细见 [docs/seed-initialization.md](docs/seed-initialization.md)）：

- **核心项**（功能必需，首次启动自动写入、不可移除）：`send-to-agent`（发送按钮）、`render-route`（原生渲染路由）、`tw-web-host`（同源代理基址）。
- **可选项**（默认不写，设置页可「重新初始化」/「反初始化」）：`doc-note`（说明笔记）、`home-index`（首页 🏠 主页/所有标签/标签笔记 + `$:/DefaultTiddlers`）、`all-articles`（所有文章两列分页）、`menubar-theme`（menubar 顶栏跟随主题）。

语义：**ONE-SHOT**——只写缺失、绝不覆盖你的改动；删掉重启不会自动恢复（用「重新初始化」找回）。

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

# 首页（改 wiki 的 🏠 主页/所有标签/标签笔记 .tid 后）
node scripts/gen-seed-home.mjs '<wiki>/tiddlers/🏠 主页.tid' '<wiki>/tiddlers/所有标签.tid' '<wiki>/tiddlers/标签笔记.tid' src/host/seed-home.ts

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
│   ├── session-summary.ts # 会话「知识库」Tab 后端
│   ├── admin.ts        # 设置页后台：tiddlywiki.info 读写 + /admin/*
│   ├── config.ts       # ConfigStore：cordis config 基底 + 配置 tiddler 覆盖层
│   ├── seeds.ts        # 统一 seed 注册表（7 项：check/run(force)/remove）
│   ├── seed-*.ts       # 各 seed 实现（bundle/首页常量由脚本生成，勿手改）
│   └── tools.ts        # 10 个 tiddlywiki_* 工具（列表式注册）
└── client/             # 浏览器半部
    ├── index.ts        # client 入口（inject ['slots']，纯 DOM，永不 throw）
    ├── endpoints.ts    # 客户端同源端点常量
    ├── knowledge-fab.ts / quick-note-dock.ts / note-widget.ts / editor-popup.ts
    │                   # 知识库 FAB / 快捷按钮 / 快速笔记 / 原生编辑弹窗
    ├── markdown-editor.ts  # CodeMirror 6 Markdown 编辑器
    ├── session-summary.ts  # 会话「知识库」Tab（conversation.view 槽位）
    ├── tool-views.ts       # 回复流工具卡片（tool.call.toolview）
    ├── theme-sync.ts / panel.ts / sidebar-entry.ts / sync-button.ts
    └── settings-page.ts / ui-config.ts / state.ts / styles.ts / toast.ts
scripts/                # 构建/校验/再生成脚本
docs/seed-initialization.md  # seed 机制详解（权威）
lib/                    # 预构建产物（发布含 lib/**，提交入库；零 @deepseek-ai 运行时 import）
```

---

## 🕘 版本记录

> 最近几个主要版本的一句话记录（完整变更见 [Releases](https://github.com/bbqisbbq/dsh-tiddlywiki/releases) / git log）。

- **v0.16.19**（2026-09-07）：**修：会话「知识库」Tab 把汇总当源码显示（整页 wikitext、像包在代码标签里）**。根因（headless $tw 实测）：TW 5.4.1 核心的视图模板级联（`$:/config/ViewTemplateBodyFilters/system` 的 system 规则）把所有 `$:/temp/` 前缀 tiddler 一律按**代码块**渲染（`$:/core/ui/ViewTemplate/body/code` → `<pre><code>`）——因此即便 v0.16.14+ 把 volatile 条目注入 iframe store 再原生导航，story view 仍把汇总当源码展示。修复：客户端**不再用 iframe / story view**，改走与回复流工具卡同一条原生渲染管线——`POST /tw/render {title}`（服务端把汇总 wikitext 块解析成 HTML 片段，`[[链接]]` 重写为 `/dsh-tiddlywiki/tw/#标题`）→ 注入滚动容器（样式复用 `.dsh-tw-toolcard-native` 的 tc-* 重主题）；片段内链接点击仍打开中央 TW 面板。无 iframe → 无编辑按钮/草稿，v0.16.16 的三层防误编辑随之不再需要；保留 30s 自愈（volatile 条目被清自动重建）与「🔄 刷新」。**刷新页面**即生效。
- **v0.16.18**（2026-09-07）：README 全面精简重写；seed 优化——首页 seed 跟随 wiki 现状（🏠 主页）、修「所有文章」回主页死链、doc-note 文案修正。
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
- 说明笔记、首页、所有文章等预置内容由 seed 机制写入 wiki（见 [🧩 初始化](#🧩-初始化一次性预置)）
- MIT；Node ≥ 22；GitHub topics：`dsh` `dsh-plugin` `tiddlywiki` `knowledge-base` `note-taking` `git-sync` `agent-tools` 等

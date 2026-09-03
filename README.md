# dsh-tiddlywiki

> TiddlyWiki 5 as the DSH **persistent knowledge base** — a shared long-term memory for AI and human: the agent reads/writes tiddlers through `tiddlywiki_*` tools, you edit in a full TiddlyWiki editor or jot notes in a floating widget, and everything syncs/backs up through **git**.

[![npm](https://img.shields.io/npm/v/dsh-tiddlywiki)](https://www.npmjs.com/package/dsh-tiddlywiki)
[![license](https://img.shields.io/npm/l/dsh-tiddlywiki)](https://github.com/bbqisbbq/dsh-tiddlywiki/blob/main/LICENSE)
[![GitHub](https://img.shields.io/github/stars/bbqisbbq/dsh-tiddlywiki)](https://github.com/bbqisbbq/dsh-tiddlywiki)

等 Agent 干活的时候，人常是干坐着的——想随手写点什么，又不想切来切去。TiddlyWiki 单文件、纯文本、wiki 语法、自带 git 同步，天生适合**随手写点小东西**。于是把它做成 DSH 原生插件：不用离开当前界面，聊天区右下角就有快速笔记；要正经编辑，弹出 TW 原生编辑器；写下的内容自动进 git，既是知识库也是备份。

---

## ✨ 特性一览

| 能力 | 说明 |
|---|---|
| 🤖 **Agent 工具** | `tiddlywiki_search` / `get` / `put` / `delete` / `git_sync` 五个工具：检索、读写、删除、git 同步 |
| 🧭 **内嵌编辑器** | 侧边栏「TiddlyWiki」入口 → 中央列内嵌完整 TW 5 编辑器（iframe 直连 TW 服务） |
| 📝 **快速笔记** | 聊天区右下角悬浮控件：**CodeMirror 6** Markdown 编辑器（语法高亮 + 撤销/重做）、文件上传、多选/自动补全 tag，Ctrl+Enter 保存；可整体隐藏 |
| 🔄 **一键同步** | 右下角「同步」按钮：pull → commit → push；状态点实时反映 git 状态（已同步/待提交/可更新/离线） |
| ⚙️ **设置页** | DSH 设置 →「TiddlyWiki 知识库」：插件/主题/语言管理与运行配置，应用后自动重启 TW |
| 🛡 **零摩擦生命周期** | 随 dsh 自动启停；TW 子进程崩溃自动重启（退避）；端口/目录/首次 git init 全自动 |
| 💾 **数据即备份** | wiki 文件夹本身就是一个 git 仓库；自动 commit（60s 防抖，可关），配置随 dsh-market 迁移 |

---

## 📦 安装

插件随 dsh 插件系统安装，三种方式任选（装完**重启 dsh web** 生效；把 `--profile web` 换成你自己的 profile 名）：

```bash
# ① npm 发布包（推荐）
dsh plugin --profile web add dsh-tiddlywiki

# ② 直接从 GitHub 安装（需要 git；仓库已含预构建 lib，开箱即用）
dsh plugin --profile web add github:bbqisbbq/dsh-tiddlywiki

# ③ 本地开发 / 改源码（link 方式：改完 src 后 npm run build 即生效，免重装）
dsh plugin --profile web add link:/path/to/your/dsh-tiddlywiki
```

首次启动会自动完成三件事：**初始化 wiki 目录**、**`git init` 并提交基线**、向 wiki **写入一次**「dsh-tiddlywiki 插件说明」笔记（tag `docs`）。

---

## 🚀 快速开始（2 分钟上手）

1. **安装并重启** dsh web（见上）。
2. 点左侧侧边栏「**TiddlyWiki**」→ 中央打开完整 TW 编辑器；此时右下角已有「📝 快速笔记」和「🔄 同步」两个悬浮按钮。
3. **随手记**：点右下角「快速笔记」，写两行、打上 tag，`Ctrl+Enter` 保存——它成为一个独立 tiddler，并自动进入 git。
4. **正经排版**：在笔记里点「✏️ 在 TW 中编辑」，弹出 TW 原生编辑器小窗继续写。
5. **收工同步**：点右下角「同步」按钮，一键 pull → commit → push，把今天的记录推到远端备份。
6. **让 Agent 参与**：直接在聊天里说「把刚才的会议纪要存进知识库」——Agent 会用 `tiddlywiki_*` 工具读写。

> 想直接看 Agent 侧完整能力？跳到 [📖 使用指南](#-使用指南)。

---

## 📖 使用指南

### 🤖 给 Agent：5 个工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `tiddlywiki_search` | `query`, `tag?` | 检索非系统 tiddler，返回标题/标签/摘要 |
| `tiddlywiki_get` | `title` | 读单个 tiddler 全文 |
| `tiddlywiki_put` | `title`, `text`, `tags?`, `fields?` | 写/覆盖 tiddler；`fields` 可带业务字段（如 `{"type":"meeting","date":"2026-09-02"}`） |
| `tiddlywiki_delete` | `title` | 删除 tiddler（幂等） |
| `tiddlywiki_git_sync` | `action: pull\|push\|sync`, `message?` | git 操作 |

**知识库同步纪律（三条）**：

1. 开工先 `tiddlywiki_git_sync action=pull`（rebase + autostash；真冲突会自动 abort 并报冲突文件）。
2. 收工 `tiddlywiki_git_sync action=sync`（pull → commit → push）。
3. 插件自动 commit 兜底（60s 防抖，可关），手动 sync 用于需要主动推送的场合。

> ⚠️ pull 若拉到新内容，`pull` / `sync` 会自动**重启 TW（同端口）**，后续读写/搜索都是最新快照，不会读到旧缓存。

**建议**：把 wiki 当作长期记忆库——会议纪要、决策记录、调研笔记、随手的想法都可存成独立 tiddler（tag 建议 `inbox` / `meeting` / `decision` 等便于检索）；自动建笔记时，除业务 tag 外也带上**当前 workspace 名**，方便按项目归集。

### 🧑‍💻 给人：界面操作

**🧭 中央列编辑器** — 侧边栏「TiddlyWiki」按钮开关中央编辑器面板（iframe 直连 TW 服务），完整 TW 5 编辑器。

**📝 快速笔记** — 聊天区右下角悬浮控件（可折叠）：
- **CodeMirror 6 编辑器**：真正的 Markdown 语法树高亮（标题/列表/代码/链接/表格/任务清单/删除线等，GFM），支持撤销/重做与行内编辑体验；
- **文件上传**：点「📎 上传」或直接把文件拖进编辑器——文件存到 wiki 的 `files/` 文件夹并随 git 同步；图片插入 `![名](/files/名)`、其它文件插入 `[名](/files/名)`，在 TW 里可直接打开；
- **Ctrl+Enter 保存**为独立 tiddler；笔记 `type` 自动设为 `text/markdown`，所以上传的图片/链接在 TW 里按 Markdown 正常渲染；
- 点「**✏️ 在 TW 中编辑**」→ 保存后弹出**独立小窗**（可拖动/缩放）加载 TW 原生编辑器编辑该条。

**🔄 一键同步** — 右下角「同步」悬浮按钮：点一下做 pull → commit → push，按钮上的状态点实时反映 git 状态：
🟢 已同步 · 🟡 有未提交改动 · 🔴 落后于远端 · ⚪ 离线；悬停可看分支/领先/落后/上次同步时间；每 30s 自动刷新。
若这次 pull 拉到了新内容，TW 服务自动重启（同端口），界面立即显示最新快照（无需手动去面板点「重启 TW」）。

**🔧 面板异常** — 面板服务异常时显示错误 +「重试」按钮（POST `/dsh-tiddlywiki/restart`）。

### ⚙️ 设置页（DSH 设置 →「TiddlyWiki 知识库」）

| 区块 | 内容 |
|---|---|
| 状态/重启 | TW 运行状态 + git 概览 + 「同步」按钮 + 「重启 TW」按钮 |
| 常规配置 | 快速笔记默认 tag、git 自动 commit/防抖/远端/分支、ui 开关（快速笔记/面板状态/同步按钮）——改了什么保存什么 |
| 插件管理 | 自带官方插件勾选（可搜索）→ 应用并自动重启 TW |
| 主题管理 | 自带主题**多选加载 + 单选活动** → 应用并自动重启 TW |
| 语言管理 | 自带官方语言包勾选（含 zh-Hans 简体）→ 应用并自动重启 TW |

- 配置写入 wiki 内的 `$:/plugins/dsh-tiddlywiki/config` tiddler（JSON），随 git 同步，作为 **cordis `config:` 块之上的覆盖层**（tiddler 优先）。
- git 类配置修改后**重启 dsh web 生效**（bootstrap 时读取）。
- 插件/主题/语言只管理 tiddlywiki 包**自带**的官方清单（`plugins/tiddlywiki/*`、`themes/tiddlywiki/*`、包根 `languages/*`），全部离线、官方原版。

**主题机制（重点）**：TW 视觉主题由 **`$:/theme`** tiddler 决定，`info.themes` 只决定**加载哪些主题插件**。主题之间有**依赖链**（`plugin.info` 的 `dependents`）：`vanilla ← snowwhite ← heavier/centralised/readonly/starlight`，`vanilla ← tight/seamless`。设置页因此是**两层**：每行主题一个 `☑ 加载`（多选 = TW 里可用的主题）+ `◉ 活动`（单选 = 当前视觉主题）。应用时插件会：

1. 把加载集（含所选活动主题）的**完整依赖链**写入 `info.themes`（如 heavier → `[vanilla, snowwhite, heavier]`），否则激活 heavier 时会丢掉 70KB 的 vanilla 基座样式；
2. 把 **`$:/theme`** 设为所选活动主题，然后重启 TW。

样式为空壳的主题（如 tight-heavier）会自动从清单里隐藏，避免选了没效果。

### 🌐 界面语言（中文）

TW 的界面语言由**语言插件**决定，不是某个配置字符串。tiddlywiki 包自带全部官方语言包（`node_modules/tiddlywiki/languages/`，含 zh-Hans 简体、zh-CN、zh-Hant、en-GB、ja-JP…），本插件离线启用即可：

- **设置页 → 语言管理**：勾选 `zh-Hans`（简体）→「应用语言（重启 TW）」——写入 `tiddlywiki.info` 的 `languages` 数组并固定 `$:/language` 为 `$:/languages/zh-Hans`，重启后 TW 界面即简体中文（持久化，重启仍在）。
- **配置自动应用**：在常规配置写入 `uiLanguage: "zh-Hans"`，每次启动 dsh web 时自动启用该语言并固定 `$:/language`（若尚未启用）。留空则不干预。
- **想换繁中**：语言管理里改勾 `zh-Hant` / `zh-TW` 再应用。

---

## 🔄 同步与数据

- wiki 文件夹**本身就是一个 git 仓库**（默认 `$DSH_HOME/tiddlywiki`，`wiki` 子目录为内容）。插件自动维护 `.gitignore`（忽略 TW 临时文件）与自动 commit（默认 60s 防抖）。
- **同步模型**：单线程交替——开工 `pull`，收工 `commit + push`；冲突策略是 **rebase + autostash，真冲突 abort 并报文件**，绝不自动吞数据。
- 配置远端（`git.remote`）后，插件首次启动会 `ensureRemote` 并尝试首次 push；失败可稍后用 `tiddlywiki_git_sync` 或「同步」按钮重试。
- **插件配置**（`config` tiddler）随 wiki 的 git 同步；**插件本体**（cordis 行与配置块）随 profile 被 dsh-market 带走。

---

## 🛠 配置

插件行默认如下（缺省即用默认值，无需手动配置）。如需自定义，编辑 `profiles/web/cordis.patch.yml` 或 profile 的 bundle 层，给该行加 `config:`：

```yaml
- id: dsh-tiddlywiki
  name: dsh-tiddlywiki
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
      tag: "inbox"
    ui:
      showQuickNote: true           # 是否显示右下角「快速笔记」按钮
      showPanelStatus: true         # 是否显示 TW 面板右下角「状态/重载」悬浮按钮
      showSyncButton: true          # 是否显示右下角「同步」悬浮按钮
    auth:
      username: ""                     # 默认 loopback 匿名；暴露到非 loopback 时才需要
      password: ""
```

> **运行时配置**：设置页写入的 `$:/plugins/dsh-tiddlywiki/config` tiddler 是 `config:` 块之上的覆盖层（tiddler 优先、随 wiki 的 git 同步）。无需改动 cordis 也能改 note tag / git 开关 / ui 开关等。
> `config:` 块随 profile 被 dsh-market 带走；wiki 数据走 git，不走 dsh-market。

---

## 👨‍💻 开发

需要 **Node.js ≥ 22**（DSH 本身已满足）。

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run build         # clean + host tsdown + client tsdown + wrap
npm run selftest      # headless：spawn TW → REST 读写 → git → 退出回收
```

**产物约定**（发布必守）：`lib/` 内**零** `@deepseek-ai` 运行时 import（`src/sdk.ts` 自实现 `defineTool` / `dshHomePath`，类型用结构接口）。发布前用 `grep -r "@deepseek-ai" lib/` 验证。

**客户端依赖**：快速笔记编辑器用 CodeMirror 6（`@codemirror/*`、`@lezer/*`）做 Markdown 高亮，构建时由 tsdown **打包进 `lib/client.bundle.js`**（它们放在 `devDependencies`，因为运行时用的是预构建 bundle，用户安装无需拉取）。「零依赖自研高亮」已成历史——浏览器端只要求构建产物自包含。

### 路由参考（开发者）

同源路由（走 DSH web server），Client 直连、无 CORS：

| 路由 | 方法 | 用途 |
|---|---|---|
| `/dsh-tiddlywiki/status` | GET | 面板健康（service / url / git / tag / ui） |
| `/dsh-tiddlywiki/note` | POST | 快速笔记 → 独立 tiddler |
| `/dsh-tiddlywiki/edit` | POST | 打开 TW 原生编辑器（draft） |
| `/dsh-tiddlywiki/tags` | GET | 现有非系统 tag（自动补全） |
| `/dsh-tiddlywiki/sync` | POST | 一键 pull → commit → push |
| `/dsh-tiddlywiki/upload` | POST | 文件上传到 `files/`（原始 body + `X-Filename`） |
| `/dsh-tiddlywiki/restart` | POST | 重启 TW 子进程 |
| `/dsh-tiddlywiki/api/*` | any | 透传到 TW 服务（JSON） |

---

## 📦 发布

```bash
# 版本号在 package.json；文件白名单见 files 字段
npm publish
```

`tiddlywiki` 依赖体较大（含全部语言包/插件），发布文档需注明。

---

## 🗂 项目结构

```
src/
├── index.ts            # host 入口：装配 WikiServer/路由/工具/prompt/自动 commit
├── sdk.ts              # 自包含 defineTool + dshHomePath（零 @deepseek-ai 运行时依赖）
├── host/
│   ├── wiki.ts         # WikiServer：spawn/kill/自愈/端口探测/就绪轮询
│   ├── tw-api.ts       # TiddlyWeb REST 客户端
│   ├── git.ts          # git init/commit/pull/push/sync/status + AutoCommitter
│   ├── routes.ts       # /status /note /edit /tags /sync /upload /restart /api/* 路由
│   ├── admin.ts        # 设置页后台：tiddlywiki.info 读写 + 目录枚举 + /admin/* 路由
│   ├── config.ts       # ConfigStore：cordis config 基底 + 配置 tiddler 覆盖层
│   ├── seed-notes.ts   # 首次启动一次性写入「插件说明」笔记
│   └── tools.ts        # 5 个工具（列表式注册，可扩展）
└── client/
    ├── index.ts        # client 入口（纯 DOM + settings.section 注册，永不 throw）
    ├── styles.ts / state.ts / toast.ts
    ├── sidebar-entry.ts  # 侧边栏入口
    ├── panel.ts          # 中央列 iframe 面板（fixed 覆盖层，钉住整列）
    ├── note-widget.ts      # 悬浮快速笔记
    ├── markdown-editor.ts  # 快速笔记编辑器（CodeMirror 6 + Lezer Markdown 高亮）
    ├── sync-button.ts      # 一键同步悬浮按钮
    ├── editor-popup.ts     # 原生编辑器弹出小窗
    └── settings-page.ts    # 设置页（插件/主题/语言管理 + 常规配置）
```

---

## 🔗 仓库与发布元数据

- **GitHub（公开）**：https://github.com/bbqisbbq/dsh-tiddlywiki
- **npm**：`dsh-tiddlywiki`（https://www.npmjs.com/package/dsh-tiddlywiki）
- **说明笔记**：插件在**首次启动**时向 wiki **写入一次**「`dsh-tiddlywiki 插件说明`」笔记（tag `docs`）——只写一次、手动编辑不被覆盖、**删除后重启不会自动恢复**（一次性标记；清空 wiki 重装会再写入）。

**可被检索的标准字段**（为 GitHub / npm / 搜索引擎发现）：

| 字段 | 值 |
|---|---|
| npm 包名 | `dsh-tiddlywiki` |
| npm `keywords` | `dsh` `dsh-plugin` `tiddlywiki` `knowledge-base` `note-taking` `notes` `wiki` `git-sync` `agent-tools` `plugin` |
| GitHub topics | `dsh` `dsh-plugin` `tiddlywiki` `wiki` `knowledge-base` `knowledge-management` `note-taking` `notes` `second-brain` `productivity` `git` `git-sync` `plugin` `agent` `agent-tools` `ai` `typescript` `nodejs`（共 18 个） |
| `description` | 见 package.json（一句话说明插件的用途） |
| `license` | MIT |
| `homepage` / `repository` / `bugs` | 均指向 https://github.com/bbqisbbq/dsh-tiddlywiki |

> GitHub topics 规范（[官方文档](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics)）：仅小写字母/数字/连字符、≤50 字符、每仓库 ≤20 个；用官方 **Replace all repository topics** 端点（`PUT /repos/{owner}/{repo}/topics`）设置。上表已按此执行并覆盖「用途 / 主题 / 语言 / 技术栈」。

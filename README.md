# dsh-tiddlywiki

TiddlyWiki 5 as the DSH **persistent knowledge base**. Agent can read/write
tiddlers through `tiddlywiki_*` tools; the human edits in a full TiddlyWiki
editor embedded in the GUI center column; the chat area gets a floating
quick-note widget. Data syncs/backs up through **git**; configuration moves
between machines through **dsh-market**.

> 设计文档：`notes/dsh-tiddlywiki-plugin-design.md`（已锁定）。本 README 是安装/配置/使用/发布要点。

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| Agent 工具 | `tiddlywiki_search` / `get` / `put` / `delete` / `git_sync` |
| 人编辑 | 侧边栏「TiddlyWiki」入口 → 中央列内嵌完整 TW 编辑器（iframe 直连 TW 服务） |
| 快速笔记 | 聊天区右下角常驻悬浮控件（可折叠，标题/tag 可自定义，Ctrl+Enter 保存） |
| 零摩擦生命周期 | 随 dsh 自动启动/关闭；TW 子进程崩溃自动重启（退避）；端口/目录/首次 git init 全自动 |
| 同步 | 单线程交替模型：开工 pull，收工 commit+push，自动 commit（60s 防抖，可关） |

## 安装

```bash
# 本地开发 / 本机安装（link 方式，改源码后重新 build 即生效）
dsh plugin --profile web add link:C:\Users\bbq\.dsh\plugins\dsh-tiddlywiki

# 重启 dsh web（会重新加载 profile 与插件）
```

从 npm 发布包安装则是：

```bash
dsh plugin --profile web add dsh-tiddlywiki
```

## 发布 / 仓库

- **GitHub（公开）**：https://github.com/bbqisbbq/dsh-tiddlywiki
- **npm**：`dsh-tiddlywiki`（`npm i dsh-tiddlywiki`；https://www.npmjs.com/package/dsh-tiddlywiki ）
- **说明笔记**：插件在首次启动时向 wiki **幂等写入**一篇「`dsh-tiddlywiki 插件说明`」笔记（tag `docs`）——不存在才写、手动编辑不被覆盖、删除后重启会重建；当前 live wiki 里已有一份。

## 配置

插件行默认如下（缺省即用默认值，无需手动配置）。如需自定义，编辑
`profiles/web/cordis.patch.yml` 或 profile 的 bundle 层，给该行加 `config:`：

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
    auth:
      username: ""                     # 默认 loopback 匿名；暴露到非 loopback 时才需要
      password: ""
```

`config:` 块随 profile 被 dsh-market 带走；wiki 数据（`$DSH_HOME/tiddlywiki`）
走 git，不走 dsh-market。

> 运行时配置：设置页（见「设置页」）写入的 `$:/plugins/dsh-tiddlywiki/config`
> tiddler 是 `config:` 块之上的覆盖层（tiddler 优先、随 wiki 的 git 同步）。
> 无需改动 cordis 也能改 note tag / git 开关等。

## 使用

### Agent（工具）

- `tiddlywiki_search {query, tag?}` — 检索非系统 tiddler，返回标题/标签/摘要。
- `tiddlywiki_get {title}` — 读单个 tiddler 全文。
- `tiddlywiki_put {title, text, tags?, fields?}` — 写/覆盖 tiddler。
- `tiddlywiki_delete {title}` — 删除 tiddler。
- `tiddlywiki_git_sync {action: pull|push|sync, message?}` — git 操作。

同步纪律（三条）：开工先 `pull --rebase --autostash`；收工 `commit + push`；
自动 commit 防抖 60s。真冲突 → abort 并报冲突文件，agent 人工处理，不自动吞数据。

### 人（GUI）

- 侧边栏「TiddlyWiki」按钮开关中央编辑器面板。
- 右下角「快速笔记」悬浮控件：写草稿/随手记，Ctrl+Enter 保存为独立 tiddler；
  或点「**✏️ 在 TW 中编辑**」——保存后**弹出独立小窗**（可拖动/缩放）加载 TiddlyWiki **原生编辑器**编辑该条。
- 面板服务异常时显示错误 +「重试」按钮（POST `/dsh-tiddlywiki/restart`）。

### 设置页（插件/主题管理 + 配置）

DSH **设置 → TiddlyWiki 知识库** 是插件的配置面板（`settings.section`）：

| 区块 | 内容 |
|---|---|
| 状态/重启 | TW 运行状态 + git 概览 + 「重启 TW」按钮 |
| 常规配置 | 快速笔记默认 tag、git 自动 commit/防抖/远端/分支——改了什么保存什么 |
| 插件管理 | 自带官方插件勾选（可搜索）→ 应用并自动重启 TW |
| 主题管理 | 自带主题**多选加载 + 单选活动** → 应用并自动重启 TW |
| 语言管理 | 自带官方语言包勾选（含 zh-Hans/zh-CN 简体）→ 应用并自动重启 TW |

- 配置写入 wiki 内的 `$:/plugins/dsh-tiddlywiki/config` tiddler（JSON），随 git 同步；
  作为 **cordis `config:` 块之上的覆盖层**（tiddler 优先），以后加配置项只需扩展该对象。
- git 类配置修改后在 **重启 dsh web 后生效**（bootstrap 时读取）。
- 插件/主题/语言均只管理 tiddlywiki 包**自带**的官方清单（`plugins/tiddlywiki/*`、
  `themes/tiddlywiki/*`、包根 `languages/*`），全部离线、官方原版。
- **主题机制（重点）**：TW 视觉主题由 **`$:/theme`** tiddler 决定（浏览器 themeManager），
  `info.themes` 只决定**加载哪些主题插件**。主题之间有**依赖链**
  （`plugin.info` 的 `dependents`）：`vanilla ← snowwhite ← heavier/centralised/readonly/starlight`，
  `vanilla ← tight/seamless`。设置页因此是**两层**：每行主题一个 `☑ 加载`（多选，
  = TW 里可用的主题）加一个 `◉ 活动`（单选 = 当前视觉主题）。应用时插件会：
  1. 把加载集（含所选活动主题）的**完整依赖链**写入 `info.themes`（如 heavier →
     `[vanilla, snowwhite, heavier]`），否则激活 heavier 时会丢掉 70KB 的 vanilla 基座样式；
  2. 把 **`$:/theme` 设为所选活动主题**（激活它），然后重启 TW。
  样式为空壳的主题（如本版 tight-heavier）会自动从清单里隐藏，避免选了没效果。

### 界面语言（中文）

TW 的界面语言由**语言插件**决定，不是某个配置字符串。tiddlywiki 包在
`node_modules/tiddlywiki/languages/` 下**自带全部官方语言包**（zh-Hans 简体、zh-CN、
zh-Hant、en-GB、ja-JP…），本插件离线启用即可：

- **设置 → TiddlyWiki 知识库 → 语言管理**：勾选 `zh-Hans`（简体）→「应用语言（重启 TW）」。
  插件会把它写入 `tiddlywiki.info` 的 `languages` 数组，并固定 `$:/language` 为
  `$:/languages/zh-Hans`，重启后 TW 界面即变为简体中文（已持久化，重启仍在）。
- **配置自动应用**：在设置页常规配置里写入 `uiLanguage: "zh-Hans"`，每次启动 dsh web 时
  自动启用该语言并固定 `$:/language`（若尚未启用）。留空则不干预。
- 中文包缺字/想换繁中：语言管理里改勾 `zh-Hant` 或 `zh-TW` 再应用即可。

## 开发

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run build         # clean + host tsdown + client tsdown + wrap
npm run selftest      # headless：spawn TW → REST 读写 → git → 退出回收
```

产物约定（§4.4 教训，发布必守）：`lib/` 内**零** `@deepseek-ai` 运行时 import
（`src/sdk.ts` 自实现 `defineTool` / `dshHomePath`，类型用结构接口）。
发布前用 `grep -r "@deepseek-ai" lib/` 验证。

## 发布

```bash
# 版本号在 package.json；文件白名单见 files 字段
npm publish
```

`tiddlywiki` 依赖体较大（含全部语言包/插件），发布文档需注明。

## 结构

```
src/
├── index.ts            # host 入口：装配 WikiServer/路由/工具/prompt/自动 commit
├── sdk.ts              # 自包含 defineTool + dshHomePath（零 @deepseek-ai 运行时依赖）
├── host/
│   ├── wiki.ts         # WikiServer：spawn/kill/自愈/端口探测/就绪轮询
│   ├── tw-api.ts       # TiddlyWeb REST 客户端
│   ├── git.ts          # git init/commit/pull/push/sync/status + AutoCommitter
│   ├── routes.ts       # /status /note /restart /api/* 路由
│   ├── admin.ts        # 设置页后台：tiddlywiki.info 读写 + 目录枚举 + /admin/* 路由
│   ├── config.ts       # ConfigStore：cordis config 基底 + 配置 tiddler 覆盖层
│   └── tools.ts        # 5 个工具（列表式注册，可扩展）
└── client/
    ├── index.ts        # client 入口（纯 DOM + settings.section 注册，永不 throw）
    ├── styles.ts / state.ts / toast.ts
    ├── sidebar-entry.ts  # 侧边栏入口
    ├── panel.ts          # 中央列 iframe 面板（fixed 覆盖层，钉住整列）
    ├── note-widget.ts    # 悬浮快速笔记
    └── settings-page.ts  # 设置页（插件/主题/语言管理 + 常规配置）
```

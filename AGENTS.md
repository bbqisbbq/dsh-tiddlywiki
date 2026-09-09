# AGENTS.md — dsh-tiddlywiki 项目速览

> 目的：让每次新会话**不用重新扫描项目**就能快速了解项目并开发功能。本文档随项目演进更新——涉及「易变清单」（§1）的任何改动，**必须在同一 commit 里同步更新对应小节**，规则见 §7。
>
> 权威来源：代码即事实；本文件与代码冲突时以代码为准，并顺手修正本文件。

## 0. 项目是什么

**dsh-tiddlywiki** —— 把 **TiddlyWiki 5 变成 DSH 的持久知识库**的官方插件（npm：`dsh-tiddlywiki`，GitHub：`bbqisbbq/dsh-tiddlywiki`，MIT）。

- **Agent 侧**：10 个 `tiddlywiki_*` 工具读写 wiki；插件把一份中文**系统提示词**注入每个会话（`systemPrompt.section`），约定同步纪律、标签规则、链接格式等。
- **人侧**：DSH 中央列内嵌完整 TW 5 编辑器（同源代理 `/dsh-tiddlywiki/tw/`）、右下角「知识库」FAB（快速笔记 + 同步 + TW 面板重载）、TW 工具栏「发送给 Agent」按钮（把当前笔记注入某个 DSH 会话）。
- **数据**：wiki 文件夹本身是 git 仓库，自动 commit（60s 防抖）+ 手动同步；回复流里 `tiddlywiki_*` 工具结果显示原生 TW 卡片，`[标题](/dsh-tiddlywiki/tw/#标题)` 点击直达 TW 面板。

## 1. 易变清单（★ 改这里必同步 AGENTS.md）

> 以下每一项都是**高频变动点**。改完代码记得在**同一 commit** 更新本小节（规则见 §7）。

| 项 | 当前值 | 位置 |
|---|---|---|
| **插件版本** | `0.16.20`（npm latest = 0.16.20；git tag `v0.16.20`） | `package.json` `version` |
| **「发送给 Agent」bundle 版本** | `0.3.4`（提示词注入消息：附加说明放**消息末尾**） | `scripts/build-send-to-agent-bundle.mjs` + `scripts/verify-send-to-agent-bundle.mjs` |
| **渲染路由 bundle 版本** | `0.1.0` | `scripts/build-render-bundle.mjs` |
| **Agent 工具集（10 个）** | `search` `get` `put` `batch_put` `rename` `delete` `recent` `list_tags` `git_sync` `git_resolve` | `src/host/tools.ts`（列表式注册，加一个就是再加一条 `defineTool`） |
| **Seed 注册表（7 项）** | 核心：`send-to-agent`、`render-route`、`tw-web-host`；可选：`doc-note`、`home-index`、`all-articles`、`menubar-theme` | `src/host/seeds.ts` 的 `SEED_DEFS` |
| **注入提示词** | `PROMPT_TEXT`（name `dsh-tiddlywiki`，order 100）：工具清单 / 同步纪律 / 冲突处理 / 标签约定（`agent-written`/`human-edited`/workspace tag）/ **内容类型约定**（默认 markdown，`fields.type` 是内容类型保留字段勿放业务分类）/ **想法沉淀约定**（`todo`+`agent-written` 写将来有用的 idea）/ **二进制附件说明**（v0.16.20：`search`/`recent` 不含二进制，`get` 只回元数据）/ 可点击链接格式 | `src/index.ts` |
| **配置项** | `wikiRoot`/`wiki`/`port`/`git{autoCommit,debounceMs,remote,branch}`/`note{tag}`/`ui{showQuickNote,showQuickNoteDock,quickNoteMode,sidebarLabel,showPanelStatus,showSyncButton,followDshTheme,darkPalette,sendToAgent{enabled,endpoint,token},allArticles{pageSize},tabLabel,showSessionTab}`/`uiLanguage`/`auth{username,password}` | `src/host/config.ts` |
| **DSH 路由** | `/status` `/note` `/edit` `/tags` `/recent` `/get` `/search` `/sync` `/upload` `/restart` `/session/summary` `/agent/sessions` `/agent/modes` `/agent/send` `/agent/create` `/api/*` `/tw/*`；admin：`/admin/state` `/admin/info` `/admin/config` `/admin/restart` `/admin/seeds` `/admin/seeds/run` `/admin/seeds/remove` | `src/host/routes.ts` + `src/host/admin.ts` |
| **客户端 Slot** | `settings.section`（id `dsh-tiddlywiki`，order 50）；`conversation.input.dock`（id `quick-note`，order 8，输入框上方快速笔记按钮，受 `ui.showQuickNoteDock` 控制；点击行为由 `ui.quickNoteMode` 决定——native=直达 TW 原生编辑弹窗（默认，`openNative`+`openEditorPopup`），card=Markdown 卡片，见 `src/client/quick-note-dock.ts`、`src/client/note-widget.ts`、`src/client/editor-popup.ts`）；`conversation.view`（id `dsh-tiddlywiki-summary`，order 20，会话顶部「知识库」Tab = 本会话相关 wiki 汇总，**TW 原生渲染**：后端写 volatile `$:/temp/dsh/session-summary/<会话ID>`，前端 **POST /tw/render 取原生片段**注入 Tab——v0.16.19 起**不再用 iframe / story view**（TW 核心把 `$:/temp/` 前缀 tiddler 一律按代码块渲染，见 §8），链接点击直达中央 TW 面板，不可编辑；受 `ui.showSessionTab` 控制、tab 名跟随 `ui.tabLabel`，见 `src/client/session-summary.ts`）；回复流工具卡片 `tool.call.toolview`（10 个工具各自 key） | `src/client/index.ts`、`src/client/quick-note-dock.ts`、`src/client/session-summary.ts`、`src/client/tool-views.ts` |

## 2. 仓库布局与关键文件

```
src/
├── index.ts            # host 入口 apply(ctx, config)：装配 WikiServer/路由/工具/提示词/自动 commit
├── sdk.ts              # 自包含 defineTool + dshHomePath（lib/ 必须零 @deepseek-ai 运行时依赖）
├── host/
│   ├── wiki.ts         # WikiServer：spawn/kill/自愈/端口探测/就绪轮询；TW_PROXY_PATH 同源代理路径
│   ├── tw-api.ts       # TiddlyWeb REST 客户端（/recipes/default/tiddlers/...，回环）
│   ├── git.ts          # git init/commit/pull/push/sync/status + AutoCommitter
│   ├── routes.ts       # 全部 DSH 路由（见 §1 路由表）+ agent-send/create/modes/sessions + session/summary
│   ├── http.ts         # 共用 HTTP 助手：readBody/readBodyBuffer（带大小上限）+ json() 响应（routes/admin 共用）
│   ├── session-summary.ts # 会话「知识库」Tab 后端：sessionQuery 读日志+后代 → 产生/读取/检索 → $:/temp 汇总 wikitext
│   ├── admin.ts        # 设置页后台：tiddlywiki.info 读写 + /admin/* 路由（seeds run/remove）
│   ├── config.ts       # ConfigStore：cordis config 基底 + 配置 tiddler 覆盖层（tiddler 优先）
│   ├── seeds.ts        # 统一 seed 注册表 SEED_DEFS（check/run(force)/remove）
│   ├── tools.ts        # 10 个 tiddlywiki_* 工具（列表式注册）
│   ├── seed-*.ts       # 各 seed 实现（内含由脚本生成的 bundle/首页 常量，勿手改）
├── client/             # 浏览器半部：panel/theme-sync/note-widget/knowledge-fab/tool-views/settings-page…
│   ├── index.ts        # client 入口（inject ['slots']，纯 DOM，永不 throw）
│   ├── endpoints.ts    # 客户端同源端点常量（/dsh-tiddlywiki/status 等，与 §1 路由表对应）
│   ├── session-summary.ts # 会话「知识库」Tab（conversation.view 槽位）：POST 生成 → /tw/render 原生片段注入（不走 story view，见 §1 客户端 Slot）
scripts/                # 构建/校验/再生成脚本（见 §4）
docs/seed-initialization.md  # seed 机制详解（权威）
cordis.patch.yml        # 插件行插入 web profile（dsh.bundle.patch）
lib/                    # 预构建产物（发布含 lib/**，提交入库；零 @deepseek-ai 运行时 import）
```

## 3. 构建 / 校验 / 自测

```bash
npm run typecheck     # tsc --noEmit
npm run build         # clean-lib → build:host(tsdown→lib/index.js, esm) → build:client(tsdown→lib/client.bundle.js cjs+minify → wrap-client.mjs→lib/client.js)
npm run build:host    # 只重建 host（改 src/index.ts / src/host/** 时用）
npm run build:client  # 只重建 client（改 src/client/** 时用）
npm run selftest      # headless：spawn TW → REST 读写 → git → 退出回收（改核心路径后跑）
node scripts/verify-send-to-agent-bundle.mjs  # bundle 字段/内容校验
node scripts/verify-seed-send-to-agent.mjs    # E2E：全新 wiki 上验证按钮 seed
node scripts/verify-seeds-admin.mjs           # E2E：/admin/seeds 状态与 run
```

**构建约束（踩过的坑）**：host 端 `tiddlywiki` **不打包**（运行时 `createRequire().resolve('tiddlywiki/tiddlywiki.js')`）；client 端 `react` **不打包**（web app 运行时解析）；client 必须 **minify**（否则 >1MB，被 dsh.pub 等注册表校验拒绝）。发布前验证 `grep -r "@deepseek-ai" lib/` 为空。

## 4. 特殊再生成流水线（改 bundle/seed 必走，别手改常量）

`src/host/seed-*.ts` 里的 bundle/首页常量是**脚本生成的**，`/* Generated ... do not hand-edit */`。

- **发送给 Agent 按钮**：改 `scripts/bundle/send-to-agent/`（`startup.js` / `button.tid` / `icon.svg` / `item-template.tid`）→
  ```bash
  node scripts/build-send-to-agent-bundle.mjs                        # → scripts/bundle/send-to-agent.bundle.json
  node scripts/gen-seed-send-to-agent.mjs scripts/bundle/send-to-agent.bundle.json src/host/seed-send-to-agent.ts
  node scripts/verify-send-to-agent-bundle.mjs
  npm run build
  ```
  版本号在 `build-send-to-agent-bundle.mjs`（改了行为要 bump），`verify-*.mjs` 里同步检查。
- **渲染路由**：改 `scripts/bundle/render/server-routes/render.js` → `node scripts/build-render-bundle.mjs` → `node scripts/gen-seed-render.mjs scripts/bundle/render.bundle.json src/host/seed-render.ts` → `npm run build`。
- **首页**：改 wiki 里的 `🏠 主页.tid`/`所有标签.tid`/`标签笔记.tid` → `node scripts/gen-seed-home.mjs <wiki>/tiddlers/🏠 主页.tid <wiki>/tiddlers/所有标签.tid <wiki>/tiddlers/标签笔记.tid src/host/seed-home.ts` → `npm run build`。

> 改 bundle 后要**同步到线上 wiki**（见 §5「运行时装配 / 部署」）——seed 是 ONE-SHOT，旧 wiki 不会自动更新。

## 5. 架构事实与约定

### 运行时装配（host/client、生效时机）

- host 半部跑在 DSH Node 进程（从 `lib/index.js` 加载，`dsh plugin --profile web add link:<repo>` 挂载）；改 host 源码 → **`npm run build:host` + 重启 dsh web** 才对新会话生效（提示词、工具集都是启动时装配）。
- client 半部是浏览器 JS（`/plugins/dsh-tiddlywiki/client.js`）；改 client → `npm run build:client` + **刷新页面**（若 DSH checkout 里同时跑着 `pnpm run dev:web`，client 改动才自动热更，否则必须重建）。
- 插件生命周期：所有 side effect（路由/工具/定时器/监听）用 `ctx.effect`/`disposer` 注册，保证热更新不泄漏。

### 工具（src/host/tools.ts）

10 个 `tiddlywiki_*` 工具，列表式注册。输出有 `render` 契约：模型看到的只是 render 后的文本，必须携带完整事实（标题/标签/摘要/git 状态），别写"UI 摘要"。

- **内容类型默认**（v0.16.15）：`put`/`batch_put` 对未指定 `type` 的条目自动补 `text/markdown`（`$:/` 系统条目除外；显式 `fields.type` 优先）；`fields.type` 是 TW 内容类型**保留字段**，工具描述/提示词都明确警告勿放业务分类值。
- **检索/最近跳过二进制附件**（v0.16.20）：`search`/`recent` 的列表在**服务端**用外部 filter 只取文本 tiddler（无 `type` 或 `text/*`，见 `tw-api.ts` 的 `TEXT_LIST_FILTER`），图片等二进制 tiddler（base64 正文）完全不参与检索/不出现在结果（含标题命中，防同名书页图刷屏）；`get` 对二进制 tiddler 只回元数据（`binary=true`/`binaryType`/`binaryChars` + 链接）。403 时自动 PUT `$:/config/Server/ExternalFilters/<filter>`="yes" 自愈重试，仍 403 降级瘦身列表。**filter 串必须保持短**（白名单 tiddler 文件名 = 整个 filter，见 §8）。

### 提示词注入（src/index.ts `PROMPT_TEXT`）

`systemPrompt.section({name:'dsh-tiddlywiki', order:100, text})`，内容要点：工具清单、知识库同步纪律（开工 pull / 收工 sync）、pull 冲突处理（`git_resolve` keep-local|keep-remote）、wiki 当长期记忆、自动建笔记带 workspace 标签、`agent-written`/`human-edited` 标签约定、**内容类型约定**（agent 正文默认 Markdown，工具自动补 `text/markdown`；要写 wikitext 才显式传 `fields.type`；`fields.type` 勿放业务分类）、**想法沉淀约定**（有价值但不在当前范围的 idea → `todo`+`agent-written` 独立 tiddler + 工作区/会话背景）、**二进制附件说明**（v0.16.20：`search`/`recent` 不返回图片等二进制 tiddler，`get` 对二进制只回元数据）、`[标题](/dsh-tiddlywiki/tw/#标题)` 可点击链接格式。

### Seed 机制（src/host/seeds.ts）

- `core: true`（功能必需）启动自动写：`send-to-agent`、`render-route`、`tw-web-host`；可选（默认不写、可反初始化）：`doc-note`、`home-index`、`all-articles`、`menubar-theme`。
- 语义：非 force = ONE-SHOT（只写缺失、绝不覆盖用户改动）；force = 设置页「重新初始化」；`remove` = 反初始化（仅可选）。带 server route 的 seed（render）写完后要**重启 TW** 才生效（`waitForFileWrite` 先等磁盘 flush 再重启）。
- 详细见 `docs/seed-initialization.md`。

### 配置双层

cordis `config:` 块（基底） + 配置 tiddler `$:/plugins/dsh-tiddlywiki/config`（覆盖层，tiddler 优先，随 wiki git 同步）。`ConfigStore.get()` 返回有效配置。

### 「发送给 Agent」消息格式（TW 侧 `startup.js` doSend）

```
《标题》
标签: ...
类型: ...
（空行）
【待办说明】以下内容是我（用户）提前编辑在 TiddlyWiki 知识库中的待办事项……不清楚请主动提问。
（空行）
<笔记正文>
（空行）【附加说明】<用户补充要求>   ← 位于消息末尾（v0.16.3 起），作为最终补充要求
```

### 标签 / 约定

- `agent-written`：`tiddlywiki_put`/`batch_put` 新建 tiddler 时工具**自动补打**（系统 `$:/` 除外）；覆盖已有人类笔记不加。
- `human-edited`：人类编辑过某篇 agent 笔记时补打，首页归入「Agent + 人工」档。
- workspace 标签：自动建笔记时把当前工作区名也作为 tag。
- `todo`：想法沉淀约定里标记「将来可能要做」的 idea。

### 知识库（wiki）同步纪律

开工先 `tiddlywiki_git_sync action=pull`；收工 `action=sync`（pull→commit→push）；插件自动防抖 commit（默认 60s）。pull 真冲突会 abort 并报文件，用 `tiddlywiki_git_resolve` 按 tiddler 二选一，**绝不自动覆盖**。

### 部署线上 wiki（与开发同名机器）

- 改 bundle（send-to-agent 等）后：用 API/TW 工具**覆盖** wiki 里的 `$:/plugins/dsh/send-to-agent` tiddler（外层字段保留：`plugin-type`/`name`/`author`/`version`/`description`），然后用户需在 DSH 里点「知识库」FAB →「🔄 重载 TW 面板」让浏览器加载新 `startup.js`。
- 提示词/工具改动：重启 dsh web 后**新会话**生效（现有会话不更新）。
- 改完记得把 wiki 也 `sync` 提交推送。

## 6. 发布流程（★ 每次功能开发完成后强制执行）

> 这是项目铁律：**功能开发完成 = 收尾发布**，别停在"代码改完"。

1. **跑校验**：`npm run typecheck`；改了核心路径跑 `npm run selftest`；改了 bundle 跑对应 `verify-*.mjs`；最终 `npm run build`（lib/ 要提交入库）。
2. **更新 README.md**：
   - 「特性一览」有对应能力行就补/改；
   - 「使用指南」相关小节更新（工具/界面行为/消息格式等）；
   - 「版本记录」**顶部新增** `- **vX.Y.Z**（日期）：一句话更新记录（详细）`。
3. **bump 版本**：`package.json` `version`（语义化递增，如 0.16.3 → 0.16.4；bundle 版本如有行为变化也同步 bump，见 §1）。
4. **同步 AGENTS.md**：更新 §1 易变清单 + 相关小节（§7 规则）。
5. **提交推送**：`git add -A && git commit -m "..."` → `git push origin main`。
6. **打 tag 并推送**：`git tag vX.Y.Z && git push origin vX.Y.Z`（tag 命名 `vX.Y.Z`）。
7. **发布 npm**：`npm publish`（本机 npm 账号已登录：`ok1989223`）→ `npm view dsh-tiddlywiki version` 确认 latest。
8. **同步线上 wiki**（如改了 bundle/提示词）：覆盖对应 tiddler + 提示用户重载 TW 面板 / 重启 dsh web。
9. 若本轮改动影响了本次会话相关的 wiki 笔记，顺手把 wiki `sync` 提交推送。

## 7. AGENTS.md 维护规则

**触发更新的情形（都在同一 commit 里更新）**：

| 代码变化 | AGENTS.md 要改的地方 |
|---|---|
| `package.json` 版本 / 发布 / 打 tag | §1「插件版本」行 + §6（如流程有变） |
| 新增/改名/删除工具 | §1「Agent 工具集」+ §5 工具小节 |
| 修改注入提示词内容 | §1「注入提示词」+ §5 提示词小节 |
| 新增/删除 seed，或改 bundle 版本/消息格式 | §1「Seed 注册表」「bundle 版本」+ §5 Seed / 消息格式小节 |
| 新增/删除 DSH 路由 | §1「DSH 路由」 |
| 新增/改名配置项 | §1「配置项」+ §5 配置双层 |
| 改构建/发布流程、改脚本 | §3 / §4 / §6 |
| 改了文件结构 | §2 |

**一般原则**：
- 本文件只放**稳定事实 + 易变清单**，不放大段代码/教程（那些在 README 与 docs/）。
- 每次新会话开工：先读 AGENTS.md（本文件）+ `tiddlywiki_git_sync action=pull` 拉 wiki。
- 发现本文件与代码不一致 → 以代码为准，并当场修正本文件（加进同一个 commit）。
- 发布（§6）步骤 4 是强制项：**版本/工具/seed/路由/配置/提示词有变就必须同步 §1**，否则下个会话拿到过期信息。

## 8. 常见坑（踩过，别重踩）

- **不要手改 `src/host/seed-*.ts` 里的 bundle/首页常量**——由 `gen-*.mjs` 生成，改了也会被覆盖；改 `scripts/bundle/**` 源件后走 §4 流水线。
- **send-to-agent 的 icon tiddler 不能带 `type: image/svg+xml`**：`{{icon}}` 会走 imageparser → `<img data-uri>`，Chrome 解析失败 → 裂图。保持无 type（默认 wikitext）→ 内联 `<svg>` 正常。核心图标也是这个约定。
- **`scripts/bundle/send-to-agent/` 下的 `.tid` 源文件不要带 `title:` 头**：build 脚本把整个文件**原样**塞进 bundle tiddler 的 `text` 字段，正文第一行若是 `title: ...` 会被当普通文本渲染（pragma 全部失效，源码原样显示在页面上）。这些文件只放纯正文/纯代码（`button.tid`/`item-template.tid` 都如此）；`verify-send-to-agent-bundle.mjs` 有回归检查「ItemTemplate 正文不得以 `title:` 开头」。
- **client 必须 minify**，否则 >1MB 会被插件目录注册表（dsh.pub）校验拒绝。
- **`lib/` 零 `@deepseek-ai` 运行时 import**（`sdk.ts` 自实现），否则 npm 镜像的 dsh-tools 会遮蔽 CLI 内置实现、搞坏 agent 循环。
- **`react` / `tiddlywiki` 不打包**：react 由 web app 运行时解析；tiddlywiki 由 host 运行时 resolve 安装包入口。
- **seed 带 server route 的（render-route）**：写入后要等磁盘 flush（`waitForFileWrite`）再重启 TW，否则重启从旧快照 boot、路由缺失。
- **提示词/工具改动只影响重启 dsh web 后的新会话**；现有会话（含自己）不会变。
- **`$:/temp` 条目在 iframe 的 story view 里永远无法正常显示**（「汇总显示成源码」的完整机理，v0.16.11–19 的教训）：① 浏览器端 TW 同步天生排除 `$:/temp`——服务端 recipe 列表默认 `[all[tiddlers]!is[system]]`（`get-tiddlers-json.js`）排除一切 `$:/` 条目，tiddlyweb adaptor 的请求过滤器又显式 `-[prefix[$:/temp/]]`（`tiddlywebadaptor.js getSkinnyTiddlers`），lazyLoad 只补「已知 skinny」不拉「完全缺失」——所以 iframe 里的 TW 拿不到 volatile 条目，`#<标题>` hash 直达必然渲染「佚失条目」；② 即便客户端把条目注入 iframe store（v0.16.14–18 的 `addTiddler` 注入 + 原生 hash 导航），TW 5.4.1 核心的视图模板级联（`$:/config/ViewTemplateBodyFilters/system` 的 system 规则）仍把所有 `$:/temp/` 前缀 tiddler 一律按**代码块**渲染（`$:/core/ui/ViewTemplate/body/code` → `<pre><code>`，headless $tw 实测），整页 wikitext 源码、像包在代码标签里——与 tiddler 的 `type` 字段无关。**因此 v0.16.19 起汇总 Tab 完全不用 iframe / story view**，改走与回复流工具卡同一条 `/tw/render` 原生片段管线（服务端 renderText 块解析 wikitext → HTML 片段，链接重写为 `/dsh-tiddlywiki/tw/#标题`）。排查「汇总显示源码」：先在 headless $tw 里渲染 `$:/core/ui/ViewTemplate/body`（currentTiddler=该标题）看是不是 `<pre><code>`；再查 TW 日志有没有「…的草稿」save 任务（v0.16.16 的 ✏️ 误编辑路径，现已被 v0.16.19 的片段渲染整体消除）。服务端直连 REST（tw-api）不受影响——单条 GET 一直能读到 `$:/temp`。
- **bundle 是 ONE-SHOT、用户自有**：改了 bundle 源件后旧 wiki 不会自动更新，要手动覆盖 wiki tiddler + 用户重载 TW 面板。
- **在「知识库」Tab 的汇总条目上点 ✏️ 编辑 → 整页显示 wikitext 源码、链接点不动**（v0.16.16 的坑）：TW 的编辑草稿 `Draft of '…'` 会**继承全文**并以编辑框（textarea）呈现，看起来就是「没正确渲染」；草稿还会被浏览器端同步回流服务端日志（`syncer-server-filesystem: Dispatching 'save' task: "…"的草稿`）甚至短暂落盘。根因不是渲染坏了（数据/类型/服务端 render 实测均正常；TW 5.4.1 也没有 `wiki.refreshTiddler`，强制重渲染要走 `$tw.rootWidget.refresh(changes)`）。v0.16.16 起插件在注入后对汇总条目做三层防误编辑：清残留草稿 + 吞 `draft.of` 指向汇总之新草稿（包 `wiki.addTiddler`，幂等 WeakSet）+ 禁用 ✏️ 按钮（本地化 tooltip 定位）。排查「汇总显示源码」类问题时先看 TW 日志有没有「…的草稿」save 任务。
- Windows 下 git 的 LF→CRLF 警告无害。
- **TiddlyWeb 外部 filter 的坑（v0.16.20 教训）**：① 非默认 filter 一律 403，除非 `$:/config/Server/ExternalFilters/<filter串>` = "yes"（白名单 tiddler 文件名 = **整个 filter 串**——filter 必须短：此前 180 字符版在 Windows 上文件名顶到 217 字符，撑爆 MAX_PATH，`git add` 报 "Filename too long"、自动 commit 失效；86 字符版文件名 ~123 字符安全。selftest 的 git 段就是这个回归的守门员）；② `prefix`/`match` 只匹配 **title**，字段匹配用 `regexp:type[...]`/`field:type[...]`；③ `[has[type]]`=有 type 字段，`[has:type[]]` 是另一种调用（suffix+空 operand，匹配一切）；④ 空格分隔=**并集**、`+`=交集；⑤ 取反的 `regexp:type`/`field:type` 会**丢掉无 type 字段**的 tiddler——「排除二进制」必须写成正向并集（无 type OR `text/*`），见 `tw-api.ts` 的 `TEXT_LIST_FILTER`。
- 消息里**附加说明放消息末尾**（正文之后），别插在待办说明与正文之间。

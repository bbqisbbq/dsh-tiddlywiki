# AGENTS.md — dsh-tiddlywiki 项目速览

> 目的：让每次新会话**不用重新扫描项目**就能快速了解项目并开发功能。本文档随项目演进更新——涉及「易变清单」（§1）的任何改动，**必须在同一 commit 里同步更新对应小节**，规则见 §7。
>
> 权威来源：代码即事实；本文件与代码冲突时以代码为准，并顺手修正本文件。

## 0. 项目是什么

**dsh-tiddlywiki** —— 把 **TiddlyWiki 5 变成 DSH 的持久知识库**的官方插件（npm：`dsh-tiddlywiki`，GitHub：`bbqisbbq/dsh-tiddlywiki`，MIT）。

- **Agent 侧**：15 个 `tiddlywiki_*` 工具读写 wiki；插件把一份中文**系统提示词**注入每个会话（`systemPrompt.section`），约定同步纪律、标签规则、链接格式等。
- **人侧**：DSH 中央列内嵌完整 TW 5 编辑器（同源代理 `/dsh-tiddlywiki/tw/`）、右下角「知识库」FAB（快速笔记 + 同步 + TW 面板重载）、TW 工具栏「发送给 Agent」按钮（把当前笔记注入某个 DSH 会话）。
- **数据**：wiki 文件夹本身是 git 仓库，自动 commit（60s 防抖）+ 手动同步；回复流里 `tiddlywiki_*` 工具结果显示原生 TW 卡片，`[标题](/dsh-tiddlywiki/tw/#标题)` 点击直达 TW 面板。

## 1. 易变清单（★ 改这里必同步 AGENTS.md）

> 以下每一项都是**高频变动点**。改完代码记得在**同一 commit** 更新本小节（规则见 §7）。

| 项 | 当前值 | 位置 |
|---|---|---|
| **插件版本** | `0.19.5`（git tag `v0.19.5`；npm 上 0.19.1 曾被 staged 且不含后续修复，以最新 tag 为准） | `package.json` `version`（三处版本一致性由 `scripts/verify-version-consistency.mjs` 守门） |
| **「发送给 Agent」bundle 版本** | `0.3.4`（提示词注入消息：附加说明放**消息末尾**） | `scripts/bundle/versions.mjs` + `scripts/build-send-to-agent-bundle.mjs` + `scripts/verify-send-to-agent-bundle.mjs` |
| **渲染路由 bundle 版本** | `0.2.0`（v0.18.0：`/render` 按 tiddler 自己的 `type` 渲染） | `scripts/bundle/versions.mjs` + `scripts/build-render-bundle.mjs` + `scripts/verify-render-bundle.mjs`（v0.19.0 新增逐字节守门） |
| **Agent 工具集（15 个）** | `search` `get` `put` `batch_put` `append` `rename` `delete` `trash` `backlinks` `attach` `lint` `recent` `list_tags` `git_sync` `git_resolve` | `src/host/tools.ts`（列表式注册，加一个就是再加一条 `defineTool`；客户端 `TOOL_VIEW_KEYS` 要同步加 key） |
| **Seed 注册表（10 项，三层）** | 核心（自动写、不可移除）：`send-to-agent`、`render-route`、`tw-web-host`；起步（首次安装默认写、可移除）：`doc-note`、`starter-docs`；可选（手动）：`home-index`、`all-articles`、`ui-styles`、`menubar-theme`、`clip-bridge`（剪藏桥使用说明，真功能在 `clip-bridge.ts` 运行时代码里）。文档类内容统一打 `dsh-docs` 标签（进首页「📚 插件文档」栏） | `src/host/seeds.ts` 的 `SEED_DEFS` |
| **注入提示词** | `PROMPT_TEXT`（name `dsh-tiddlywiki`，order 100）：工具清单（15 个）/ **覆盖前先 `tiddlywiki_get` 拿 `modified` 并作为 `expectedModified` 写回**（v0.19.0 并发纪律）/ 同步纪律 / 冲突处理 / 标签约定（`agent-written`/`human-edited`/workspace tag）/ **内容类型约定**（默认 markdown，`fields.type` 是内容类型保留字段勿放业务分类）/ **想法沉淀约定**（`todo`+`agent-written` 写将来有用的 idea）/ **二进制附件说明**（`search`/`recent` 不含二进制，`get` 只回元数据）/ 可点击链接格式 | `src/index.ts` |
| **配置项** | `wikiRoot`/`wiki`/`port`/`git{autoCommit,debounceMs,remote,branch}`/`note{tag}`/`bridge{enabled,port,token,tag}`/`ui{showQuickNote,showQuickNoteDock,quickNoteMode,sidebarLabel,showPanelStatus,showSyncButton,followDshTheme,darkPalette,sendToAgent{enabled,endpoint,token},allArticles{pageSize},tabLabel,showSessionTab,showRightbarTab}`/`uiLanguage`/`auth{username,password}` | `src/host/config.ts` |
| **DSH 路由** | `/status` `/note` `/edit` `/tags` `/recent` `/get` `/search` `/render` `/sync` `/upload` `/restart` `/session/summary` `/agent/sessions` `/agent/modes` `/agent/send` `/agent/create` `/api/*` `/tw/*`；admin：`/admin/state` `/admin/info` `/admin/config` `/admin/restart` `/admin/seeds` `/admin/seeds/run` `/admin/seeds/remove` | `src/host/routes.ts` + `src/host/admin.ts` |
| **客户端 Slot** | `settings.section`（id `dsh-tiddlywiki`，order 50）；`conversation.input.dock`（id `quick-note`，order 8，输入框上方快速笔记按钮，受 `ui.showQuickNoteDock` 控制；点击行为由 `ui.quickNoteMode` 决定——native=直达 TW 原生编辑弹窗（默认，`openNative`+`openEditorPopup`），card=Markdown 卡片，见 `src/client/quick-note-dock.ts`、`src/client/note-widget.ts`、`src/client/editor-popup.ts`）；`conversation.view`（id `dsh-tiddlywiki-summary`，order 20，会话顶部「知识库」Tab = 本会话相关 wiki 汇总，**TW 原生渲染**：后端写 volatile `$:/temp/dsh/session-summary/<会话ID>`，前端 **POST /dsh-tiddlywiki/render 取原生片段**（host 转 TW `/render` 并**净化**后返回，v0.19.1）注入 Tab——v0.16.19 起**不再用 iframe / story view**（TW 核心把 `$:/temp/` 前缀 tiddler 一律按代码块渲染，见 §8），链接点击直达中央 TW 面板，不可编辑；受 `ui.showSessionTab` 控制、tab 名跟随 `ui.tabLabel`，见 `src/client/session-summary.ts`）；`sidebar.right.pane.tab`（keyed，key=`dsh-tiddlywiki`，**右侧栏 TW tab**（v0.16.21）：type 注册进 `ctx.sidebarRightTabs`（服务**可选访问** `ctx.get('sidebarRightTabs')`，老版本 DSH 自动跳过），body 为 React 包装的 TW iframe（同源代理 + theme-sync + 链接 hash 导航），guide 首页入口盒点击打开；受 `ui.showRightbarTab` 控制、tab 名跟随 `ui.tabLabel`，见 `src/client/rightbar-tab.ts`）；**~~DSH Better Sidebar TW tab~~（v0.16.23 引入，v0.17.0 已移除：不再向 dsh-better-sidebar 注册 tab 类型，避免 tab kind 重复注册冲突；侧边栏只用 rightbar）**；回复流工具卡片 `tool.call.toolview`（15 个工具各自 key） | `src/client/index.ts`、`src/client/quick-note-dock.ts`、`src/client/rightbar-tab.ts`、`src/client/tw-frame.ts`、`src/client/session-summary.ts`、`src/client/tool-views.ts` |

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
│   ├── http.ts         # 共用 HTTP 助手：readBody/readBodyBuffer（带大小上限）+ json() 响应 + rejectCrossSiteWrite（写路由的同源/CSRF 守卫）
│   ├── sanitize.ts     # 渲染片段白名单净化器（v0.19.1）：丢 script/iframe/object/embed/form/svg…、丢 on*/srcdoc、URL 只放行 http(s)/相对路径/栅格 data:image
│   ├── write-policy.ts # 共享写策略（v0.19.1）：cleanTiddler/buildWriteTiddler/assertNoConflict/flattenTiddlerFields —— agent 工具与 /note /edit 路由共用
│   ├── clip-bridge.ts  # 本地剪藏桥（v0.16.25 图片 / v0.18.0 SSRF 守卫）：只监听 127.0.0.1 的 HTTP 桥，POST /clip 把书签剪藏写进 wiki；「浮层选图」——桥下载所选图片字节存为二进制附件 tiddler（type image/* + base64，笔记 [img[标题]] 内嵌，失败降级链接）；Host 校验防 DNS rebinding + 可选 token + CORS/PNA preflight；端口按 **effective config** 绑定一次（改端口需重启 dsh web），enabled/token/tag 每请求读 effective config；`assertPublicImageUrl` 只放行公网 http(s)（逐跳校验重定向）
│   ├── session-summary.ts # 会话「知识库」Tab 后端：sessionQuery 读日志+后代 → 产生/读取/检索 → $:/temp 汇总 wikitext（后代/条目/检索记录都有上限）
│   ├── admin.ts        # 设置页后台：tiddlywiki.info 读写 + /admin/* 路由（seeds run/remove；seed 写了 render-route 才等 flush 并重启 TW）
│   ├── config.ts       # ConfigStore：cordis config 基底 + 配置 tiddler 覆盖层（tiddler 优先；读失败保留缓存、set 先读回再合并）
│   ├── seeds.ts        # 统一 seed 注册表 SEED_DEFS（check/run(force)/remove，三层：核心/起步/可选）+ waitForFileWrite / needsRestartAfterSeeds
│   ├── seed-util.ts    # seed 共用助手：readSeedTiddler（**只有 404 才算缺失**）/ writeSeedMarker（失败只 warn）
│   ├── tools.ts        # 15 个 tiddlywiki_* 工具（列表式注册）
│   ├── seed-*.ts       # 各 seed 实现（bundle/首页/ui-styles 常量由脚本生成，勿手改；starter-docs/menubar-theme/clip-bridge 为手工维护的净化常量）
├── client/             # 浏览器半部：panel/theme-sync/note-widget/knowledge-fab/tool-views/settings-page…
│   ├── index.ts        # client 入口（inject ['slots']，纯 DOM，永不 throw）
│   ├── endpoints.ts    # 客户端同源端点常量（/dsh-tiddlywiki/status 等，与 §1 路由表对应）
│   ├── status-cache.ts # 共享 /status 读取器（v0.19.5）：2s TTL + **在途合并**，所有客户端面（面板/侧栏框架/同步按钮/快速笔记配置/FAB/侧边栏入口）都走这里，别再各自 fetch
│   ├── rightbar-tab.ts # 右侧栏 TW tab（v0.16.21）：type 注册 + guide 入口 + React body（TW iframe）/互斥
│   ├── tw-frame.ts     # 共享 TW iframe 机制（v0.16.23）：lazy-load/status 轮询/主题同步/hash 导航/互斥 + live-frame 链接路由注册表
│   ├── session-summary.ts # 会话「知识库」Tab（conversation.view 槽位）：POST 生成 → /dsh-tiddlywiki/render 原生片段注入（host 净化后返回，不走 story view，见 §1 客户端 Slot）
scripts/                # 构建/校验/再生成脚本（见 §4）；bundle/versions.mjs = bundle 版本唯一来源
docs/seed-initialization.md  # seed 机制详解（权威）
cordis.patch.yml        # 插件行插入 web profile（dsh.bundle.patch）
lib/                    # 预构建产物（发布只含 lib/index.js + lib/index.js.map + lib/client.js；零 @deepseek-ai 运行时 import）
```

## 3. 构建 / 校验 / 自测

```bash
npm run typecheck     # tsc --noEmit
npm run build         # clean-lib → build:host(tsdown→lib/index.js, esm) → build:client(tsdown→lib/client.bundle.js cjs+minify → wrap-client.mjs→lib/client.js)
npm run build:host    # 只重建 host（改 src/index.ts / src/host/** 时用）
npm run build:client  # 只重建 client（改 src/client/** 时用）
npm run selftest      # headless：spawn TW → REST 读写 → git → 15 个工具 → seed → 退出回收（改核心路径后跑；失败也会 stop 子进程）
npm run smoke:client  # client bundle 的 module-loader 形状冒烟（wrap-client 之外的第二道）
npm run verify        # = verify:static + verify:unit + verify:e2e（本地一键；CI 同款分档）
npm run verify:static # send-to-agent bundle 逐字节 / render bundle 逐字节 / 发布包内容 / 版本一致性
npm run verify:unit   # 剪藏桥（含 IPv6/保留网段 SSRF 回归）/ seed 读失败策略 / 渲染片段净化器 / 配置密钥遮掩（v0.19.1–3）/ 客户端 status-cache 合并（tsx 直跑源码）
npm run verify:e2e    # auth 模式 / 工具层 / **审计回归 verify-audit-fixes**（attach 覆盖保护 / 草稿类型 / 回收站索引 / delete 并发 / rename 部分失败 / 汇总未探测 / batch_put 并发顺序）/ git 冲突解决 / 崩溃自愈+并发写
npm run verify:large  # 3000+ 条目大 wiki：filter 长度、检索耗时、二进制零出现、真跑 commit（约 1 分钟）
# 另有（不进 CI，依赖本机 Chrome / 线上 wiki）：
node scripts/verify-seed-send-to-agent.mjs  # E2E：全新 wiki 上验证按钮 seed
node scripts/verify-seeds-admin.mjs         # E2E：/admin/seeds 状态与 run（force → 落盘 → 重启 → 内容仍在）
node scripts/verify-clip-bridge-browser.mjs # 真实无头 Chrome：书签 href 保留 / 执行弹浮层
node scripts/verify-menubar-theme.mjs / verify-theme-browser.mjs
```

**CI**：`.github/workflows/ci.yml`（v0.19.0 起）4 个 job——`static`（typecheck + build + `git diff --exit-code -- lib/` + 静态 verify）、`selftest`、`verify-unit`、`verify-e2e`；后三者 `needs: static`。浏览器类脚本不进 CI（会静默 SKIP，等于假绿）。

**⚠️ 行尾必须 LF（v0.19.1 教训）**：仓库根有 **`.gitattributes`（`* text=auto eol=lf`）**。`lib/index.js.map` 内嵌源文件原文（`sourcesContent`），Windows 工作区若是 CRLF，生成的 map 里就是 `\r\n` 转义，而 GitHub runner 检出为 LF → 重建出的 map 与提交版不同 → `static` 的 `git diff --exit-code -- lib/` 必失败，且它一挂其余三个 job（`needs: static`）**根本不会跑**（v0.19.0 的 CI 实际就是这个状态）。改完 src 一律 `npm run build` 后提交 lib/；不要绕开 `.gitattributes` 的 LF 约定。

**构建约束（踩过的坑）**：host 端 `tiddlywiki` **不打包**（运行时 `createRequire().resolve('tiddlywiki/tiddlywiki.js')`）；client 端 `react` **不打包**（web app 运行时解析）；client 必须 **minify**（否则 >1MB，被 dsh.pub 等注册表校验拒绝）。发布前的自包含检查要断言**不存在真实的 import 语句**（`grep -nE "(from|require\()\s*['\"]@deepseek-ai" lib/*.js` 必须无输出）——简单的 `grep -r "@deepseek-ai" lib/` 会命中 `sdk.ts` 的说明注释（2 处），永远失败。

## 4. 特殊再生成流水线（改 bundle/seed 必走，别手改常量）

`src/host/seed-*.ts` 里的 bundle/首页常量是**脚本生成的**，`/* Generated ... do not hand-edit */`。

- **发送给 Agent 按钮**：改 `scripts/bundle/send-to-agent/`（`startup.js` / `button.tid` / `icon.svg` / `item-template.tid`）→
  ```bash
  node scripts/build-send-to-agent-bundle.mjs                        # → scripts/bundle/send-to-agent.bundle.json
  node scripts/gen-seed-send-to-agent.mjs scripts/bundle/send-to-agent.bundle.json src/host/seed-send-to-agent.ts
  node scripts/verify-send-to-agent-bundle.mjs
  npm run build
  ```
  版本号只在 `scripts/bundle/versions.mjs` 定义（`SEND_TO_AGENT_BUNDLE_VERSION`；改了行为要 bump），build/verify 都引用它，`gen-seed-send-to-agent.mjs` 则**从 bundle 的 plugin.info 读**并写进外层 tiddler（别再手写第二处）。
- **渲染路由**：改 `scripts/bundle/render/server-routes/render.js` → `node scripts/build-render-bundle.mjs` → `node scripts/gen-seed-render.mjs scripts/bundle/render.bundle.json src/host/seed-render.ts` → `npm run build`。版本取 `scripts/bundle/versions.mjs` 的 `RENDER_BUNDLE_VERSION`。⚠️ `/render` 必须按 **tiddler 自己的 `type`** 渲染（`$tw.utils.getParser` 对未知类型会自动回退 wikitext）：插件默认把笔记写成 `text/markdown`，硬编码 wikitext 会把 Markdown 渲染成源码（v0.18.0 修复）。
- **首页**：改 wiki 里的 `🏠 主页.tid`/`所有标签.tid`/`标签笔记.tid` → `node scripts/gen-seed-home.mjs <wiki>/tiddlers/🏠 主页.tid <wiki>/tiddlers/所有标签.tid <wiki>/tiddlers/标签笔记.tid src/host/seed-home.ts` → `npm run build`。⚠️ 脚本**默认就剥离作者私有人口**（主题页 tabs / 主题汇总死链 / 书籍书架）并注入「📚 插件文档」tabs 栏；只有明确想保留私有内容才加 `--keep-private`（`--strip-private` 作兼容 no-op 保留）。
- **自定义样式**：改 wiki 里的样式 `.css`（+ `.meta`）→ `node scripts/gen-seed-ui-styles.mjs <wiki>/tiddlers/<样式.css> … src/host/seed-ui-styles.ts` → `npm run build`（脚本会把 tag 收窄为只留 `$:/tags/Stylesheet`）。
- **示例与文档**（starter-docs）/ **menubar 顶栏主题** / **剪藏桥说明**（seed-clip-bridge）：内容维护在 `src/host/seed-starter-docs.ts` / `seed-menubar-theme.ts` / `seed-clip-bridge.ts`（**手工维护的净化常量**，无 gen 脚本）。

> 改 bundle 后要**同步到线上 wiki**（见 §5「运行时装配 / 部署」）——seed 是 ONE-SHOT，旧 wiki 不会自动更新。

## 5. 架构事实与约定

### 运行时装配（host/client、生效时机）

- host 半部跑在 DSH Node 进程（从 `lib/index.js` 加载，`dsh plugin --profile web add link:<repo>` 挂载）；改 host 源码 → **`npm run build:host` + 重启 dsh web** 才对新会话生效（提示词、工具集都是启动时装配）。
- **本地剪藏桥**（v0.16.24+/v0.16.25 图片 / v0.18.0 SSRF）：监听端口按 **effective config**（设置页覆盖层优先）在启动时绑定一次（改 `bridge.port` 需重启 dsh web）；`enabled`/`token`/`tag` **每请求**读 effective config，设置页保存即生效。桥只绑定 127.0.0.1 + Host 头白名单（防 DNS rebinding）+ 可选 `x-clip-token` 校验；CORS 预检放行（含 `Access-Control-Allow-Private-Network`）以便 https 页面书签可用——**因此 token 为空时，用户浏览器里访问的任意网站都能向桥写入**，文档与设置页都强烈建议设 token。图片下载走 `deps.download`（服务端 fetch，带 referer/UA 对付防盗链；上限 15MB/张、10 张/次），**每个 URL 与每一跳重定向都要过 `assertPublicImageUrl`**（仅公网 http(s)；拒绝回环/内网/链路本地/云元数据/`.local` 等，DNS 先解析再放行；`redirect: 'manual'` 手动跟跳）；二进制附件 = `type: image/*` + base64 `text`（TW 5.4.1 REST 无原生二进制上传，此即官方形态，proven：selftest BigImage.jpg 段 + verify-clip-bridge 图片测试）；带图笔记自动改 wikitext。写入走 tw-api 唯一通道。
- client 半部是浏览器 JS（`/plugins/dsh-tiddlywiki/client.js`）；改 client → `npm run build:client` + **刷新页面**（若 DSH checkout 里同时跑着 `pnpm run dev:web`，client 改动才自动热更，否则必须重建）。
- 插件生命周期：所有 side effect（路由/工具/定时器/监听）用 `ctx.effect`/`disposer` 注册，保证热更新不泄漏。

### 工具（src/host/tools.ts）

15 个 `tiddlywiki_*` 工具，列表式注册。输出有 `render` 契约：模型看到的只是 render 后的文本，必须携带完整事实（标题/标签/摘要/git 状态），别写"UI 摘要"。

- **内容类型默认**（v0.16.15）：`put`/`batch_put` 对未指定 `type` 的条目自动补 `text/markdown`（`$:/` 系统条目除外；显式 `fields.type` 优先）；`fields.type` 是 TW 内容类型**保留字段**，工具描述/提示词都明确警告勿放业务分类值。
- **读取错误策略**（v0.18.0）：`put`/`batch_put` 判「是否新条目」的 `wiki.get()` **不得吞错**——只有 404 才算新条目，否则网络故障会把人类笔记误判为新建并补打 `agent-written`。`fields` 也不能覆盖 `title`/`text`/`tags`/`created`/`modified`（`type` 例外，那是改内容类型的正规入口）；`batch_put` 逐条 try/catch，单条失败不影响其余，结果含 `failed` 与逐条 `error`（`items[].title/text` **故意不是 required**，否则参数预校验会在逐条容错之前整批抛错）。
- **写入保留字段（v0.19.0 / 抽成共享策略 v0.19.1，数据安全）**：写策略住在 **`src/host/write-policy.ts`**（`cleanTiddler`/`buildWriteTiddler`/`assertNoConflict`/`flattenTiddlerFields`），**agent 工具与 `/note`、`/edit` 人类路由共用同一份实现**——v0.19.0 只在工具层修了「不丢 tags/自定义字段」，HTTP 路由仍在盲覆盖（同名保存会清掉人类笔记的标签与 `q`/`due`）。`buildWriteTiddler()` 以**已有条目为基底**构造 PUT：不传 `tags` 就保留原标签/自定义字段/内容类型，显式传 `tags` 才整体替换；`agentTag: false`（人类路由）不补 `agent-written`。⚠️ 单条 GET 的自定义字段是**嵌套在 `fields` 里**的（`get-tiddler.js` 把 knownFields 之外的字段收进 `fields`），必须摊平，否则 put/append/rename/trash 会静默丢字段，`tiddlywiki_get` 也会渲染成 `fields=[object Object]`。
- **`tiddlywiki_lint` 的两个坑（v0.19.1 修复）**：① 死链检查的标题集合必须取**全部**标题（瘦列表），只取文本列表会把每条指向图片/附件的 `[[x.png]]`/`{{x}}` 误报成死链；② 「缺 type」不能用响应里的 `type` 判断——TW 服务端会给无 type 的条目补 `text/vnd.tiddlywiki`，只能靠 `MISSING_TYPE_FILTER`（`[all[tiddlers]!is[system]!has[type]]`，服务端按真实字段求值）列标题，再回文本列表取正文。
- **乐观并发（v0.19.0 / 扩展到 delete v0.19.5）**：`put` 与 `delete` 都支持 `expectedRevision` / `expectedModified` + `force`；`revision` 是 GET 响应里的 changeCount，**刚 PUT 还没落盘的条目没有 `modified`**，所以两个令牌都支持（比较前经 `parseTiddlerDate` 归一）。**删除比覆盖更不可逆**，需要并发保护时要走同一套令牌（`get` → 人类在 TW 里改动 → `delete` 必须拒绝）。
- **`attach` 的覆盖保护（v0.19.5，数据安全）**：`attach` 与其他写路径一样**先 `get` 再写**（004 = 新建），同名 tiddler 已存在时**默认拒绝**（`force: true` 才覆盖，覆盖仍保留原 tags/自定义字段），新建附件补 `agent-written`；`noteTitle` 嵌入也用 `buildWriteTiddler`。并发令牌只证明「读过」，**不等于同意覆盖**。
- **`append`/`rename`/`trash` 的边界（v0.19.5）**：`rename` 先写新标题再删旧标题，旧标题删除失败时**不得抛裸错**（调用方会以为整个重命名没发生）——要在 `warning` 里如实说明「两份副本都在」。`readTrashIndex` 的读失败（抛错）与 JSON 损坏都必须**中止**：把它当空索引再全量覆盖会丢光回收站索引，那些 trashed tiddler 就变成既列不出、也清不掉的孤儿（`TrashIndexUnavailableError`）。
- **检索/最近跳过二进制附件**（v0.16.20）：`search`/`recent` 的列表在**服务端**用外部 filter 只取文本 tiddler（无 `type` 或 `text/*`，见 `tw-api.ts` 的 `TEXT_LIST_FILTER`），图片等二进制 tiddler（base64 正文）完全不参与检索/不出现在结果（含标题命中，防同名书页图刷屏）；`get` 对二进制 tiddler 只回元数据（`binary=true`/`binaryType`/`binaryChars` + 链接）。403 时自动 PUT `$:/config/Server/ExternalFilters/<filter>`="yes" 自愈重试；**显式 filter 仍 403 就抛错**（不再偷换成默认列表），只有插件自用的 `TEXT_LIST_FILTER` 会降级瘦身列表。带正文的列表有 **2s TTL + in-flight 合并缓存**（写后失效）。**filter 串必须保持短**（白名单 tiddler 文件名 = 整个 filter，见 §8）。
- **检索质量（v0.19.0）**：`search` 按 `标题命中 6 > 标签命中 3 > 正文命中次数` 打分排序，片段取**命中处上下文**（`snippetAround`），支持 `field`/`value` 自定义字段过滤，`limit` 统一 clamp 到 200。⚠️ TW 的 listing 返回的 `modified` 是**紧凑格式**（`YYYYMMDDhhmmssSSS`），必须走 `parseTiddlerDate`，用 `new Date()` 会让 `since` 过滤恒为空。
- **软删除 / 回收站（v0.19.0）**：`delete` 默认把条目移入 `$:/dsh-tiddlywiki/trash/<ISO>/<原标题>`（系统标题 ⇒ 自动不出现在 search/recent/listTags），并用 `$:/dsh-tiddlywiki/trash-index`（JSON）做**索引**；`trash` 工具 list/restore/empty。⚠️ 不能靠 filter 列回收站：新 wiki 的 `$:/config/SyncSystemTiddlersFromServer` 默认 `"no"`，`get-tiddlers-json.js` 会给**每个** filter 追加 `+[!is[system]]`，`$:/` 条目永远列不出来（实测）。
- **标签列表有界（v0.19.4）**：`GET /tags` 支持 `limit`（1–500，**缺省仍是全量**——快速笔记的标签自动补全需要完整词表）与 `sort=alpha|count`（默认 `alpha`），回包带 `total`/`truncated`；工具 `tiddlywiki_list_tags` 的 `limit` 默认 200、上限 1000，截断时 render 必须写明「共 N 个，仅列出最多的 M 个」，别让模型以为那就是全部。两侧共用 **`TiddlyWebClient.tagStats()`** 一份计数逻辑（此前路由自己遍历一遍且不跳过 `$:/` 标题，两侧口径可能漂），`/recent`、`/search`、`/tags` 的 limit 解析统一走 `readLimit()`/`readOptionalLimit()`。客户端 `TagsCard` 直接请求 `?limit=60&sort=count`（不再下载上千条再丢掉）。
- **新增工具（v0.19.0）**：`append`（append/prepend/按 `heading` 定位段落，写日志批注不必读全文）、`backlinks`（`[[标题]]`/`{{标题}}`/标签归属）、`attach`（本机绝对路径或公网 URL → 二进制附件，复用 `downloadClipImage` 的 SSRF 守卫）、`lint`（垃圾标签/死链/空笔记/缺内容类型）。
- **`batch_put` 有界并发（v0.19.5）**：4 路 worker 共享一个 client，**结果按入参下标回填**（顺序与逐条容错是契约，别改成 push）；`autoCommit()` 在循环外只调一次。顺序实现会为 N 条发 2N 次 REST（GET+PUT）。
- **客户端 `/status` 只有一个入口（v0.19.5）**：`src/client/status-cache.ts` 的 `fetchStatus()`（2s TTL + 在途合并，失败不缓存）。面板/tw-frame/sync-button/ui-config/FAB/sidebar-entry 原先各有一份 `fetchStatus`，加载瞬间会重复请求，而 host 每处理一次 `/status` 最多起 5 个 git 进程。新增客户端面一律用它。

### 提示词注入（src/index.ts `PROMPT_TEXT`）

`systemPrompt.section({name:'dsh-tiddlywiki', order:100, text})`，内容要点：工具清单、知识库同步纪律（开工 pull / 收工 sync）、pull 冲突处理（`git_resolve` keep-local|keep-remote）、wiki 当长期记忆、自动建笔记带 workspace 标签、`agent-written`/`human-edited` 标签约定、**内容类型约定**（agent 正文默认 Markdown，工具自动补 `text/markdown`；要写 wikitext 才显式传 `fields.type`；`fields.type` 勿放业务分类）、**想法沉淀约定**（有价值但不在当前范围的 idea → `todo`+`agent-written` 独立 tiddler + 工作区/会话背景）、**二进制附件说明**（v0.16.20：`search`/`recent` 不返回图片等二进制 tiddler，`get` 对二进制只回元数据）、`[标题](/dsh-tiddlywiki/tw/#标题)` 可点击链接格式。

### Seed 机制（src/host/seeds.ts）

- **三层**：核心（启动自动写、不可反初始化）：`send-to-agent`、`render-route`、`tw-web-host`；**起步**（首次安装默认写、可反初始化，`startup: true`）：`doc-note`、`starter-docs`；可选（默认不写、可反初始化）：`home-index`、`all-articles`、`ui-styles`、`menubar-theme`、`clip-bridge`（剪藏桥使用说明文档 seed，ONE-SHOT + marker；真功能在 `clip-bridge.ts`）。
- **文档合集约定**：所有说明/教程/模板/示例类 seed 内容打 **`dsh-docs`** 标签——seed 版首页「📚 插件文档」tabs 栏（`[tag[dsh-docs]!is[system]]`）自动收录。以后新增 TW 侧说明/配置文档一律走 seed（ONE-SHOT + 同名跳过，绝不覆盖用户数据）。
- 语义：非 force = ONE-SHOT（只写缺失、**同名 tiddler 已存在即安全跳过**、绝不覆盖用户改动）；force = 设置页「重新初始化」；`remove` = 反初始化（非核心 seed）。
- **错误策略（v0.18.0）**：seed 读取一律走 `readSeedTiddler`（= `client.get`，**只有 404 才当缺失**）；**禁止**再写 `.catch(() => undefined)`——它会把瞬时故障当「条目不存在」，于是非 force 的启动 seed 也会覆盖用户数据。读取抛错 → 该 seed 返回 `ok:false` 并安全跳过；marker 写失败只 warn（`writeSeedMarker`），不再静默。
- **重启规则（v0.18.0 / v0.19.0）**：只有 `render-route` 真的写了才重启 TW（`needsRestartAfterSeeds`），并且要用 `waitForFileWrite(file, 8s, 150ms, seedStartedAt)` 等 **mtime 前进**，再用 `flushPendingWrites(client, tiddlersDir)` 写哨兵把整个 syncer 队列排干，然后才 `restart()`。
- **启动自举（v0.19.0）**：`apply()` 启动时会调 `ensurePlugin(..., 'tiddlywiki/markdown')`（全新 wiki 的 `--init server` 不含它，而笔记默认是 `text/markdown`）；它变更了 `tiddlywiki.info` 就重启一次 TW。
- 详细见 `docs/seed-initialization.md`。

### 写路由的方法校验、同源守卫与 auth（v0.18.0 / v0.19.0 / v0.19.3）

- **方法校验（v0.19.0，必读）**：`rejectCrossSiteWrite(req, res, ['POST'])` 先判方法、再判同源；读路由用 `rejectNonRead`（GET/HEAD）。**每个 handler 都必须声明自己的方法**——宿主 webserver（`dsh-host-webserver`）**只按 pathname 分发**，旧版 `isCrossSiteWrite` 又主动放行 GET，于是 `GET /dsh-tiddlywiki/sync` 会 pull+commit+push、`GET /restart` 会重启子进程、`GET /upload` 会落文件，任意网页一张 `<img>` 即可触发（实测复现）。selftest 有回归断言：这些路径的 GET 必须 405 且无副作用。
- 同源守卫：`Sec-Fetch-Site: cross-site` 或 `Origin` 与 `Host` 不同源即 403；GET/HEAD/OPTIONS 一律放行（跨站导航要能打开 `/tw/`），无这两个头的调用方（curl/服务端）也放行——这是 CSRF 硬化，不是鉴权边界（网络暴露由宿主认证负责）。
- 重活路由（`/restart`、`/sync`）有 **in-flight 互斥**：并发调用返回 429，不再叠加重启/拉取。
- `auth.username/password` 非空时：TW 子进程带 `readers`/`writers` 启动，因此**内置 `TiddlyWebClient` 与 `WikiServer.waitReady()` 都必须带 preemptive Basic 头**（否则全站 401、启动 20s 后 failed）；`/tw` 与 `/api` 代理由此都要转发 `authorization`（`forwardHeaders`）并回传 `WWW-Authenticate`，浏览器才会弹登录框。spawn 日志会**打码 `password=`**（日志经无需认证的 `/status` 返回）。
- **配置密钥只出「打码」形态（v0.19.3）**：`/admin/state` 与 `/status` 一样是**只读、无鉴权的读路由**，v0.19.2 之前它把 `config` 原样回给浏览器（设置页需要读），于是任何同源请求都能取到 `bridge.token`、`auth.password`、`git.remote`（可能带凭据的 URL）。现在 `admin.ts` 的 `maskConfigSecrets()` 把密钥替换成 `********`（`MASKED_SECRET`），`/admin/config` 收到回传的 `********` 用 `stripMaskedSecrets()` 丢弃（表示"未修改"）——**新增返回 config 的接口必须过这道打码**，回归在 `scripts/verify-secret-masking.mjs`。设置页的密钥输入框也据此显示占位语义。
- **`$:/plugins/dsh-tiddlywiki/` 命名空间不给代理（v0.19.3）**：`/tw/*` 与 `/api/*` 是同源代理，此前能直接 `GET /dsh-tiddlywiki/tw/tiddlers/$:/plugins/dsh-tiddlywiki/config` 拿到**未打码**的配置 tiddler（密钥暴露的第二条路）。`BLOCKED_PROXY_TITLE_PREFIXES` + `isBlockedProxyPath()` 现在对**插件自身命名空间**返回 403（selftest 断言 `tw`/`api` 两条路径都是 403）；插件配置只能经 `/admin/state`（已打码）读写。TW 自身系统 tiddler（`$:/config/...` 等）不受影响。
- **每个路由 handler 都要包 `guardHandler`（v0.19.3）**：宿主 webserver 拿到 `async` handler 的 rejection 时既不回包也不回收，路由层的 `await` 抛错会变成**挂死请求**（此前几十个注册点全靠手写 try/catch）。`http.ts` 的 `guardHandler(fn)` 统一兜住 rejection → 已发头就 `res.end()`、否则按 `errorStatus(err)` 回 413/500 JSON；**新增路由注册一律 `guardHandler(...)` 包裹**。`errorStatus()` 把 `/body too large/i` 映射成 413，其余 500。

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
- **别把「读取失败」当「条目不存在」（v0.18.0 教训）**：`tw-api` 的 `get()` 只有 404 返回 `undefined`，其余抛错。任何 `.catch(() => undefined)` 都会把超时/重启/5xx 变成「用户没有这条」，于是 seed 覆盖用户内容、工具给人类笔记补打 `agent-written`。统一用 `seed-util.ts` 的 `readSeedTiddler`，工具里直接 `await wiki.get(...)`。
- **重启 TW 前必须确认写入已落盘（v0.18.0 / v0.19.0 教训）**：`waitForFileWrite` 只判「文件存在」时，文件早就存在会立即返回，重启随即杀掉还没 flush 的 REST 写入（verify-seeds-admin 抓到过：force 重新初始化首页后内容消失）。要传 `newerThanMs`（seed 开始的时刻）等 mtime 前进；而且**等一个文件不够**——`flushPendingWrites()` 会先写一枚 flush 哨兵 tiddler 再等它的文件出现（syncer 按队列顺序落盘），把「其他 seed 的写入」也排干（v0.19.0：force-all 曾在磁盘忙时随机丢掉 `tw-web-host`）。只有 `render-route` 这类带 server route 的 seed 才需要重启。
- **写路由必须显式声明 HTTP 方法（v0.19.0）**：宿主 webserver 只按 pathname 分发，`isCrossSiteWrite` 又放行 GET，所以漏写方法的写路由会被 `GET`（乃至跨站 `<img>`）触发。新加写路由时用 `rejectCrossSiteWrite(req, res, ['POST'])`，读路由用 `rejectNonRead`。
- **SSRF 守卫要按字节判 IPv6（v0.19.0）**：字符串前缀法漏掉 `0:0:0:0:0:0:0:1`、`::0:1`、`::ffff:7f00:1`（都是回环）。`isPrivateAddress` 现在用 `ipv6ToBytes` 展开成 16 字节，并处理 IPv4-mapped / 6to4 / NAT64；下载用 `lookup` **pin 住已校验的 IP**，避免 DNS rebinding 在 check 与 connect 之间换答案。
- **TW REST 的 PUT 是整体替换（v0.19.0 数据安全）**：只发 `{title, text}` 会抹掉既有 tags 与自定义字段。所有「基于已有条目改写」的路径都要走 `buildWriteTiddler()`；而单条 GET 返回的自定义字段**嵌套在 `fields` 下**，`cleanTiddler()` 必须摊平（否则 rename/append/trash 一样会丢字段）。
- **任何重启 TW 之前都要 `flushPendingWrites()`（v0.19.1 补漏）**：REST PUT 返回 204 时 syncer 还握着这条写入（~250ms 定时器），此时重启会**直接吞掉它**（v0.19.0 只在 seed 路径做了，`/sync` 与工具 `git_sync` 漏了 → agent 连续 `put → git_sync` 时可能丢笔记）。两条路径现在都先写哨兵再重启。
- **flush 哨兵的两个静默陷阱（v0.19.1 实测）**：① **扩展名**——TW 的文件系统适配器按内容类型决定扩展名（`text/plain` → `.txt` + `.txt.meta`、`application/json` → `.json`、默认 wikitext → `.tid`），旧实现写 `text/plain` 却等 `.tid`，永远等不到；② **mtime**——哨兵是紧接在等待之前写的，Windows 上新文件的 mtime 可能落在同一/前一个时钟刻，`mtime >= startedAt` 永不成立。两者都会让 `flushPendingWrites` **每次都超时返回 false，而调用方只当 warning**（v0.19.0 的「排干 syncer」实际没生效）。现在按「文件名含 `dsh-tiddlywiki_flush-probe` + 文件内容含本次随机戳」判定，与扩展名/时钟无关。
- **Host 侧注入浏览器的 TW 片段必须净化（v0.19.1 安全）**：回复流卡片与会话汇总用 `dangerouslySetInnerHTML` 把 TW 渲染结果插进 **DSH 同源页面**，而 TW 的解析器只剥 `on*`——`<iframe src="javascript:…">`、`<a href="javascript:…">`、`<form action="javascript:…">` 全部原样通过（实测）。客户端一律走 **`POST /dsh-tiddlywiki/render`**（`src/host/sanitize.ts` 的 `sanitizeTwFragment` 净化后返回），不要直连 TW 的 `/tw/render`；新增注入点时 `verify-render-sanitizer.mjs` 会断言它引用 `RENDER_ENDPOINT`。
- **重启是有状态的，必须单飞（v0.19.1）**：`WikiServer.restart()` 内部串行（routes 层的 `beginMutation` 只覆盖 `/restart` 与 `/sync`，`/admin/*` 那三处够不着——并发重启会留下孤儿 TW 进程）。启动任务（`apply()` 里的 fire-and-forget IIFE）与 teardown 也要靠 `disposed` 标志握手：先置位再 await，否则「disposer 先跑完、startup 后 spawn」同样留孤儿。
- **读路由也会泄露密钥（v0.19.3）**：`/status`、`/admin/state` 都**不需要认证**（宿主 auth 只管页面，不管这些 JSON 路由），而设置页需要读配置 → 曾经把 `bridge.token`/`auth.password`/带凭据的 `git.remote` 原样回给浏览器。现在一律经 `maskConfigSecrets()` 打成 `********`（`/admin/config` 回传时 `stripMaskedSecrets()` 视为「未修改」丢弃）。**任何新增的"返回 config"接口都必须过打码**；改完跑 `node scripts/verify-secret-masking.mjs`。
- **代理路由要挡插件自己的命名空间（v0.19.3）**：`/tw/*`、`/api/*` 是**原样转发**的同源代理，打码管不到——`GET /dsh-tiddlywiki/tw/tiddlers/$:/plugins/dsh-tiddlywiki/config` 能直接读到未打码的配置 tiddler。`isBlockedProxyPath()` 对 `$:/plugins/dsh-tiddlywiki/` 前缀返回 403（selftest 有断言）；新加代理前缀时别忘了这个命名空间。
- **async 路由 handler 的 rejection 会挂死请求（v0.19.3）**：宿主 webserver 只调 handler 不 await，未捕获的 rejection 既不回包也不回收连接。所有注册点统一包 `guardHandler(fn)`（`http.ts`）：已发头就 `res.end()`，否则按 `errorStatus(err)` 回 413（超限）/500 JSON。新增路由忘了包 → 一个 await 抛错就是一个永久挂起的请求。
- **`/upload` 的"存在即改后缀"要原子（v0.19.3）**：先 `existsSync` 再 `writeFile` 是 TOCTOU，两个并发上传会互相覆盖。改成 `writeFile(..., {flag:'wx'})` 并用 **EEXIST-only** 判定重试（其它 errno 直接抛），重试有上界。文件名也会先去掉结尾的 `.`/空格（Windows 会把 `x.html.` 规范化成 `x.html`，判重与落盘名字不一致）。
- **剪藏桥 listen 之后必须常驻 `error` 监听（v0.19.3）**：只在 `listen()` 那一次挂一次性 error handler，之后任何 socket 级错误都是 `unhandledRejection`/进程级 uncaught——桥是长驻服务，`server.on('error')` 要永久挂着；`stop()` 用 `closeAllConnections()` 收掉 keep-alive 连接（1s 兜底），否则 `close()` 回调可能永远不触发。
- **列表接口都必须有 `limit`（v0.19.4）**：`GET /tags` 曾是**唯一没有上限**的列表路由（大 wiki 上千个标签连计数全量回给浏览器，客户端只是展示前 60 个就丢掉），工具 `tiddlywiki_list_tags` 更严重——同样全量灌进**模型上下文**。现在两者都能截断并报告 `total`/`truncated`；**标签计数只有 `TiddlyWebClient.tagStats()` 一处实现**（路由曾自己遍历一遍且不跳 `$:/` 标题，与工具口径不一致），新加「标签/最近/搜索」类接口时套 `readLimit()`/`readOptionalLimit()`，别再造第四份 clamp。
- **「先把旧条目读出来」是所有写路径的铁律（v0.19.5 教训）**：`attach` 曾直接 `PUT {title,type,text}`（不读旧条目）——附件标题一旦撞上既有笔记就把那篇笔记连 tags/自定义字段/正文一起替换成 base64。任何新增写路径都必须 `get` → `buildWriteTiddler`；**同名 + 非新建 + 无 `force` 时宁可报错也不要静默覆盖**（并发令牌只证明「读过」，不等于「同意覆盖」）。
- **草稿的 `type` 必须跟随原条目（v0.19.5 教训）**：`/edit` 的草稿写死 `text/markdown` 会把 wikitext 笔记降级——TW 保存草稿时把草稿字段抄回原 tiddler，`!` 标题/`<$list>`/`[[链接]]` 下次全渲染成源码。草稿的 `type` 取 `existing?.type ?? NOTE_TYPE`。
- **回收站索引读失败 ≠ 空索引（v0.19.5 教训）**：`readTrashIndex` 返回 `{readOk, corrupted, entries}`；`!readOk`（抛错）或 `corrupted`（JSON 坏）都必须**中止**操作。旧的 `catch → []` + 全量覆盖会把整个索引写成只剩一条，之前的 trashed tiddler 变成既列不出、也清不掉的孤儿（体积还留在 git 里）。
- **删除也要乐观并发（v0.19.5）**：`delete` 与 `put` 一样接受 `expectedModified`/`expectedRevision`/`force`。「`get` → 人类在 TW 里改 → `delete`」此前会把人类的新改动直接丢进回收站；删除是不可逆操作，**比覆盖更该拒绝**。
- **客户端不要再各自 `fetch('/dsh-tiddlywiki/status')`（v0.19.5）**：host 每处理一次 `/status` 最多起 5 个 git 进程，而同一页面有 6 个面在加载时读它。统一走 `src/client/status-cache.ts` 的 `fetchStatus()`（TTL + 在途合并）；新增客户端面时先看这里有没有现成读取器。
- **`batch_put` 的结果必须按入参下标回填（v0.19.5）**：改成并发后若用 `push`，模型看到的逐条报告顺序就会和入参不一致（`items[i]` 与请求错位）。顺序与逐条容错是**契约**，`verify-audit-fixes.mjs` 有断言。
- **`$:/` 条目无法通过 recipe listing 枚举（v0.19.0 实测）**：新 wiki 的 `$:/config/SyncSystemTiddlersFromServer` 默认 `"no"`，`get-tiddlers-json.js` 于是给每个 filter 追加 `+[!is[system]]`。要靠 listing 找 `$:/` 条目（如回收站）必须另建**非系统索引 tiddler** 并用 `get` 读（回收站就是这么做的）。
- **TW 的日期字段是紧凑格式（v0.19.0）**：listing 返回 `modified` 形如 `20260101000000000`（UTC），`new Date()` 会得到 Invalid Date——`since` 过滤曾因此恒为空。统一用 `parseTiddlerDate()` / `toIsoDateString()`（`tw-api.ts` 导出）。
- **新装的 wiki 没有 markdown 插件（v0.19.0）**：`--init server` 只带 tiddlyweb/filesystem/highlight，而插件把每篇笔记都写成 `text/markdown`。`ensurePlugin(wikiPath, twRoot, 'tiddlywiki/markdown')` 在启动时幂等补齐并在变更后重启一次；作者本机 wiki 因历史导入流程早有该插件，所以这个坑长期没暴露。
- **`/render` 必须按 tiddler 的 `type` 渲染**：插件默认写 `text/markdown`，硬编码 `text/vnd.tiddlywiki` 会把 `## x` 渲成 wikitext 列表（实测 `## 现象` → `<ol><li>…`）。`$tw.utils.getParser` 对未注册类型会自动回退 wikitext，所以直接传 tiddler 的 type 是安全的。
- **剪藏桥的图片 URL 必须过 SSRF 守卫**：桥是「浏览器的代理」，无验证时可被用来打内网/云元数据。`assertPublicImageUrl` 只放行公网 http(s) 并在 fetch 前解析 DNS；下载用 `redirect: 'manual'` 逐跳复检。写 verify 时注意：stub 图片地址要用**公网字面 IP**（如 `http://93.184.216.34/x.png`），伪造主机名（`https://cdn/...`）会被守卫直接拒。
- **提示词/工具改动只影响重启 dsh web 后的新会话**；现有会话（含自己）不会变。
- **`$:/temp` 条目在 iframe 的 story view 里永远无法正常显示**（「汇总显示成源码」的完整机理，v0.16.11–19 的教训）：① 浏览器端 TW 同步天生排除 `$:/temp`——服务端 recipe 列表默认 `[all[tiddlers]!is[system]]`（`get-tiddlers-json.js`）排除一切 `$:/` 条目，tiddlyweb adaptor 的请求过滤器又显式 `-[prefix[$:/temp/]]`（`tiddlywebadaptor.js getSkinnyTiddlers`），lazyLoad 只补「已知 skinny」不拉「完全缺失」——所以 iframe 里的 TW 拿不到 volatile 条目，`#<标题>` hash 直达必然渲染「佚失条目」；② 即便客户端把条目注入 iframe store（v0.16.14–18 的 `addTiddler` 注入 + 原生 hash 导航），TW 5.4.1 核心的视图模板级联（`$:/config/ViewTemplateBodyFilters/system` 的 system 规则）仍把所有 `$:/temp/` 前缀 tiddler 一律按**代码块**渲染（`$:/core/ui/ViewTemplate/body/code` → `<pre><code>`，headless $tw 实测），整页 wikitext 源码、像包在代码标签里——与 tiddler 的 `type` 字段无关。**因此 v0.16.19 起汇总 Tab 完全不用 iframe / story view**，改走与回复流工具卡同一条 `/tw/render` 原生片段管线（服务端 renderText 块解析 wikitext → HTML 片段，链接重写为 `/dsh-tiddlywiki/tw/#标题`）。排查「汇总显示源码」：先在 headless $tw 里渲染 `$:/core/ui/ViewTemplate/body`（currentTiddler=该标题）看是不是 `<pre><code>`；再查 TW 日志有没有「…的草稿」save 任务（v0.16.16 的 ✏️ 误编辑路径，现已被 v0.16.19 的片段渲染整体消除）。服务端直连 REST（tw-api）不受影响——单条 GET 一直能读到 `$:/temp`。
- **bundle 是 ONE-SHOT、用户自有**：改了 bundle 源件后旧 wiki 不会自动更新，要手动覆盖 wiki tiddler + 用户重载 TW 面板。
- **在「知识库」Tab 的汇总条目上点 ✏️ 编辑 → 整页显示 wikitext 源码、链接点不动**（v0.16.16 的坑）：TW 的编辑草稿 `Draft of '…'` 会**继承全文**并以编辑框（textarea）呈现，看起来就是「没正确渲染」；草稿还会被浏览器端同步回流服务端日志（`syncer-server-filesystem: Dispatching 'save' task: "…"的草稿`）甚至短暂落盘。根因不是渲染坏了（数据/类型/服务端 render 实测均正常；TW 5.4.1 也没有 `wiki.refreshTiddler`，强制重渲染要走 `$tw.rootWidget.refresh(changes)`）。v0.16.16 起插件在注入后对汇总条目做三层防误编辑：清残留草稿 + 吞 `draft.of` 指向汇总之新草稿（包 `wiki.addTiddler`，幂等 WeakSet）+ 禁用 ✏️ 按钮（本地化 tooltip 定位）。排查「汇总显示源码」类问题时先看 TW 日志有没有「…的草稿」save 任务。
- Windows 下 git 的 LF→CRLF 警告无害。
- **TiddlyWeb 外部 filter 的坑（v0.16.20 教训）**：① 非默认 filter 一律 403，除非 `$:/config/Server/ExternalFilters/<filter串>` = "yes"（白名单 tiddler 文件名 = **整个 filter 串**——filter 必须短：此前 180 字符版在 Windows 上文件名顶到 217 字符，撑爆 MAX_PATH，`git add` 报 "Filename too long"、自动 commit 失效；86 字符版文件名 ~123 字符安全。selftest 的 git 段就是这个回归的守门员）；② `prefix`/`match` 只匹配 **title**，字段匹配用 `regexp:type[...]`/`field:type[...]`；③ `[has[type]]`=有 type 字段，`[has:type[]]` 是另一种调用（suffix+空 operand，匹配一切）；④ 空格分隔=**并集**、`+`=交集；⑤ 取反的 `regexp:type`/`field:type` 会**丢掉无 type 字段**的 tiddler——「排除二进制」必须写成正向并集（无 type OR `text/*`），见 `tw-api.ts` 的 `TEXT_LIST_FILTER`。
- **筛选器操作数别用 `[[...]]` 双括号**（v0.16.22 首页快速记笔记 tags 变「筛选器错误」的坑）：`then` 等**操作符**的 operand 只接受普通 `[...]`（或 `{$var}`），`then[[todo]]` 会被解析器报 `Missing [ in filter expression`——`{{{...}}}` 求值失败后错误文本被当成 tags 写入（`Tiddler` 构造按空白切分 → 出现「筛选器错误: / Missing / [ / in ...」6 个 tag）。正确写法 `then[todo]`。selftest 已断言首页 seed 不含 `then[[`。
- **不要向 dsh-better-sidebar 注册 tab kind（v0.17.0 教训）**：`ctx.betterSidebar.registerTab({id})` 的 id 是**全局 tab kind**——同一 kind 被注册两次即报 `sidebarRight: tab kind "dsh-tiddlywiki" is already registered (extension)`（热更新/重复 apply/别的插件占用都会触发）。v0.16.23 曾用 `id: 'dsh-tiddlywiki'` 注册 TW tab，v0.17.0 已**整体移除**该集成；插件不再引用 `ctx.betterSidebar`。若将来要重新支持，务必用插件私有前缀（如 `dsh-tiddlywiki/tw`）并做幂等注册。
- 消息里**附加说明放消息末尾**（正文之后），别插在待办说明与正文之间。

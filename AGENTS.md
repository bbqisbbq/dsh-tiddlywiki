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
| **插件版本** | `0.22.0`（git tag `v0.22.0`；v0.22.0 = 运行时切换知识库 + seed 内容哈希更新检测 + flush 真正排干；v0.21.0 = 注入提示词精简+可配置；v0.20.1 = 内容类型保留修复） | `package.json` `version`（三处版本一致性由 `scripts/verify-version-consistency.mjs` 守门） |
| **「发送给 Agent」bundle 版本** | `0.3.5`（v0.20.0 修复 `notify()`：TW 的 notifier 只认**已存在的 tiddler 标题**，传自由文本＝静默无提示；现在先写 `$:/temp/dsh/send-to-agent/notice` 再 display。提示词注入消息：附加说明放**消息末尾**） | `scripts/bundle/versions.mjs` + `scripts/build-send-to-agent-bundle.mjs` + `scripts/verify-send-to-agent-bundle.mjs`（含外层 version 守门） |
| **渲染路由 bundle 版本** | `0.2.0`（v0.18.0：`/render` 按 tiddler 自己的 `type` 渲染） | `scripts/bundle/versions.mjs` + `scripts/build-render-bundle.mjs` + `scripts/verify-render-bundle.mjs`（v0.19.0 新增逐字节守门） |
| **Agent 工具集（15 个）** | `search` `get` `put` `batch_put` `append` `rename` `delete` `trash` `backlinks` `attach` `lint` `recent` `list_tags` `git_sync` `git_resolve` | `src/host/tools.ts`（列表式注册，加一个就是再加一条 `defineTool`；客户端 `TOOL_VIEW_KEYS` 要同步加 key） |
| **Seed 注册表（10 项，三层）** | 核心（自动写、不可移除）：`send-to-agent`、`render-route`、`tw-web-host`；起步（首次安装默认写、可移除）：`doc-note`、`starter-docs`；可选（手动）：`home-index`、`all-articles`、`ui-styles`、`menubar-theme`、`clip-bridge`（剪藏桥使用说明，真功能在 `clip-bridge.ts` 运行时代码里）。文档类内容统一打 `dsh-docs` 标签（进首页「📚 插件文档」栏）。**v0.22.0 起**：有 `markerTitle` + `content` 的 seed 会在标记里记**内容哈希**（`{version,hashes,at}`）以支持「有更新/本地已修改」检测；`doc-note` 的正文**由工具注册表生成**（`docNoteText(tools)`，不再手抄工具清单） | `src/host/seeds.ts` 的 `SEED_DEFS` + `src/host/seed-util.ts`（`hashText`/`parseSeedMarker`/`readSeedMarker`/`writeSeedMarker`） |
| **注入提示词** | `buildPromptText()`（name `dsh-tiddlywiki`，order 100，**默认 `slim`**）：工具能力一句话 + 可点击链接格式 / 写入与并发纪律（先 `get` 拿 `modified`→`expectedModified`；`attach` 同名默认拒绝；不传 tags 保留原标签/字段/类型）/ 同步纪律三条 + pull 冲突处理 / 标签约定（`agent-written`/`human-edited`/workspace tag）/ 内容类型约定 / 想法沉淀（`todo`）约定。`full` 形态另附**由 `tiddlywikiToolSummary()` 实时生成**的工具参数索引（禁止再手抄 schema）。配置 `prompt{enabled,mode,extra,override}`；用户文本里的 `{{…}}` 必须转义 | `src/host/prompt.ts`（v0.21.0 从 `src/index.ts` 抽出） |
| **配置项** | `wikiRoot`/`wiki`（**v0.22.0 起只是默认值**：运行中实际位置 = 指针文件 > cordis config > 内置默认）/`port`/`git{autoCommit,debounceMs,remote,branch}`/`note{tag}`/`prompt{enabled,mode,extra,override}`/`bridge{enabled,port,token,tag}`/`ui{showQuickNote,showQuickNoteDock,quickNoteMode,sidebarLabel,showPanelStatus,showSyncButton,followDshTheme,darkPalette,sendToAgent{enabled,endpoint,token},allArticles{pageSize},tabLabel,showSessionTab,showRightbarTab}`/`uiLanguage`/`auth{username,password}` | `src/host/config.ts` |
| **DSH 路由** | `/status` `/note` `/edit` `/tags` `/recent` `/get` `/search` `/render` `/sync` `/upload` `/restart` `/session/summary` `/agent/sessions` `/agent/modes` `/agent/send` `/agent/create` `/api/*` `/tw/*`；admin：`/admin/state` `/admin/prompt` `/admin/info` `/admin/config` `/admin/restart` `/admin/seeds` `/admin/seeds/run` `/admin/seeds/remove`／**v0.22.0 知识库位置**：`/admin/wiki/location`（GET 读）、`/admin/wiki/switch`（POST 切）、`/admin/wiki/reset`（POST 恢复默认） | `src/host/routes.ts` + `src/host/admin.ts` |
| **知识库位置（v0.22.0）** | 指针文件 `$DSH_HOME/dsh-tiddlywiki/location.json`（`{version,active:{root,name},updatedAt}`）> cordis `config.wikiRoot/wiki` > 内置默认。`wikiRoot` 必须绝对路径，`name="."` = 直接用 root；`root` 可含 `$DSH_HOME`/`${VAR}`/`%VAR%`。切换 = 停 TW → 释放 committer/watcher → 改指 → 起 TW → 重载配置 tiddler → `bootstrapWiki()`（markdown 插件 + seeds + 语言，与启动路径同一份代码）→ 重建 git → **最后**才写指针；失败自动回滚（`rolledBack`），指针损坏只报告并回退默认 | `src/host/wiki-location.ts`（解析/校验/指针/候选目录，纯函数）+ `src/host/wiki-switch.ts`（编排，deps 注入便于 E2E）+ `src/index.ts` 的 `runSwitch/switchWikiLocation/resetWikiLocation` + `WikiServer.setLocation()/currentLocation` |
| **客户端 Slot** | `settings.section`（id `dsh-tiddlywiki`，order 50）；`conversation.input.dock`（id `quick-note`，order 8，输入框上方快速笔记按钮，受 `ui.showQuickNoteDock` 控制；点击行为由 `ui.quickNoteMode` 决定——native=直达 TW 原生编辑弹窗（默认，`openNative`+`openEditorPopup`），card=Markdown 卡片，见 `src/client/quick-note-dock.ts`、`src/client/note-widget.ts`、`src/client/editor-popup.ts`）；`conversation.view`（id `dsh-tiddlywiki-summary`，order 20，会话顶部「知识库」Tab = 本会话相关 wiki 汇总，**TW 原生渲染**：后端写 volatile `$:/temp/dsh/session-summary/<会话ID>`，前端 **POST /render 取净化后的原生片段**注入（不用 iframe/story view，原因见 §8）；`ui.showSessionTab`/`ui.tabLabel` 控制，见 `src/client/session-summary.ts`）；`sidebar.right.pane.tab`（keyed `dsh-tiddlywiki`，**右侧栏 TW tab**（v0.16.21）：type 注册进 `ctx.sidebarRightTabs`（**可选访问** `ctx.get(...)`，老 DSH 自动跳过），body 为 React 包装的 TW iframe；`ui.showRightbarTab`/`ui.tabLabel` 控制，见 `src/client/rightbar-tab.ts`）；**不向 dsh-better-sidebar 注册 tab kind**（v0.17.0 移除——重复注册会报错，见 §8）；回复流工具卡片 `tool.call.toolview`（15 个工具各自 key） | `src/client/index.ts`、`src/client/quick-note-dock.ts`、`src/client/rightbar-tab.ts`、`src/client/tw-frame.ts`、`src/client/session-summary.ts`、`src/client/tool-views.ts` |

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
│   ├── http.ts         # 共用 HTTP 助手：readBody/readBodyBuffer（带大小上限）+ json() 响应 + guardHandler + rejectCrossSiteWrite/rejectNonRead（方法 + 同源守卫）+ safeTokenEqual（常数时间比较，v0.20.0 起 routes/clip-bridge 共用）
│   ├── sanitize.ts     # 渲染片段白名单净化器（v0.19.1）：丢 script/iframe/object/embed/form/svg…、丢 on*/srcdoc、URL 只放行 http(s)/相对路径/栅格 data:image
│   ├── write-policy.ts # 共享写策略（v0.19.1）：cleanTiddler/buildWriteTiddler/assertNoConflict/flattenTiddlerFields —— agent 工具与 /note /edit 路由共用
│   ├── clip-bridge.ts  # 本地剪藏桥（v0.16.25 图片 / v0.18.0 SSRF 守卫）：只监听 127.0.0.1 的 HTTP 桥，POST /clip 把书签剪藏写进 wiki；「浮层选图」——桥下载所选图片字节存为二进制附件 tiddler（type image/* + base64，笔记 [img[标题]] 内嵌，失败降级链接）；Host 校验防 DNS rebinding + 可选 token + CORS/PNA preflight；端口按 **effective config** 绑定一次（改端口需重启 dsh web），enabled/token/tag 每请求读 effective config；`assertPublicImageUrl` 只放行公网 http(s)（逐跳校验重定向）
│   ├── session-summary.ts # 会话「知识库」Tab 后端：sessionQuery 读日志+后代 → 产生/读取/检索 → $:/temp 汇总 wikitext（后代/条目/检索记录都有上限）
│   ├── admin.ts        # 设置页后台：tiddlywiki.info 读写 + /admin/* 路由（seeds run/remove；seed 写了 render-route 才等 flush 并重启 TW）
│   ├── config.ts       # ConfigStore：cordis config 基底 + 配置 tiddler 覆盖层（tiddler 优先；读失败保留缓存、set 先读回再合并）
│   ├── seeds.ts        # 统一 seed 注册表 SEED_DEFS（check/run(force)/remove，三层：核心/起步/可选）+ waitForFileWrite / needsRestartAfterSeeds
│   ├── seed-util.ts    # seed 共用助手：readSeedTiddler（**只有 404 才算缺失**）/ writeSeedMarker + **内容哈希**（v0.22.0：hashText/parseSeedMarker/readSeedMarker，标记 JSON `{version,hashes,at}`；旧 `seeded-once` 标记读成 legacy 并按文本比对）
│   ├── wiki-location.ts # 知识库位置（v0.22.0）：expandEnvPath / normalizeLocation（必须绝对路径）/ 指针文件读写清（`$SH_HOME/dsh-tiddlywiki/location.json`）/ listWikiCandidates —— 纯函数 + 文件 IO，便于单测
│   ├── wiki-switch.ts  # 运行时切换编排（v0.22.0）：stop → applyLocation → start → reloadConfig → bootstrap → setupExtras → **最后**写指针；任一步失败回滚旧 wiki 并返回 `rolledBack`；deps 注入（供 verify-wiki-switch.mjs 用真 WikiServer 驱动）
│   ├── text-util.ts    # 共享文本助手 snippetOf（v0.20.0：原先 tools.ts / routes.ts 各一份）
│   ├── prompt.ts       # 注入提示词（v0.21.0）：slim（默认）/full 两种形态 + extra/override；full 的参数索引由 tiddlywikiToolSummary() 生成；escapePromptBraces 防 DSH 变量装配失败
│   ├── tools.ts        # 15 个 tiddlywiki_* 工具（列表式注册；tiddlywikiToolSummary() 暴露规范工具名/参数给提示词与守门脚本）
│   ├── seed-*.ts       # 各 seed 实现（bundle/首页/ui-styles 常量由脚本生成，勿手改；starter-docs/menubar-theme/clip-bridge 为手工维护的净化常量）
├── client/             # 浏览器半部：panel/theme-sync/note-widget/knowledge-fab/tool-views/settings-page…
│   ├── index.ts        # client 入口（inject ['slots']，纯 DOM，永不 throw）
│   ├── endpoints.ts    # 客户端同源端点常量（/dsh-tiddlywiki/status 等，与 §1 路由表对应）
│   ├── status-cache.ts # 共享 /status 读取器（v0.19.5）：2s TTL + **在途合并**，所有客户端面（面板/侧栏框架/同步按钮/快速笔记配置/FAB/侧边栏入口）都走这里，别再各自 fetch
│   ├── rightbar-tab.ts # 右侧栏 TW tab（v0.16.21）：type 注册 + guide 入口 + React body（TW iframe）/互斥
│   ├── tw-frame.ts     # 共享 TW iframe 机制（v0.16.23）：lazy-load/status 轮询/主题同步/hash 导航/互斥 + live-frame 链接路由注册表
│   ├── session-summary.ts # 会话「知识库」Tab（conversation.view 槽位）：POST 生成 → /dsh-tiddlywiki/render 原生片段注入（host 净化后返回，不走 story view，见 §1 客户端 Slot）
scripts/                # 构建/校验/再生成脚本（见 §4）；bundle/versions.mjs = bundle 版本唯一来源
scripts/lib/            # 脚本共享助手：tw-harness.mjs（waitFor / matchRoute / createRouteServer）+ browser-env.mjs（puppeteer / Chrome 发现）
docs/seed-initialization.md  # seed 机制详解（权威）
cordis.patch.yml        # 插件行插入 web profile（dsh.bundle.patch）
lib/                    # 预构建产物（发布只含 lib/index.js + lib/index.js.map + lib/client.js；零 @deepseek-ai 运行时 import）
```

## 3. 构建 / 校验 / 自测

```bash
npm run typecheck     # tsc --noEmit（noUnusedLocals 已开：新增死 import/死变量会直接红）
npm run build         # clean-lib → build:host(tsdown→lib/index.js, esm) → build:client(tsdown→lib/client.bundle.js cjs+minify → wrap-client.mjs→lib/client.js)
npm run build:host    # 只重建 host（改 src/index.ts / src/host/** 时用）
npm run build:client  # 只重建 client（改 src/client/** 时用）
npm run selftest      # headless：spawn TW → REST 读写 → git → 15 个工具 → seed → 退出回收（改核心路径后跑；失败也会 stop 子进程）
npm run smoke:client  # client bundle 的 module-loader 形状冒烟（wrap-client 之外的第二道）
npm run verify        # = verify:static + verify:unit + verify:e2e + verify:large（本地一键）
npm run verify:static # send-to-agent bundle 逐字节 / render bundle 逐字节 / 发布包内容 / 版本一致性 / 静态常量（TEXT_LIST_FILTER 长度预算）
npm run verify:unit   # 剪藏桥（含 IPv6/保留网段 SSRF 回归）/ seed 读失败策略 / 渲染片段净化器 / 配置密钥遮掩（含 auth.password，v0.20.0）/ **写策略纯函数（type 保留，v0.20.1）** / **注入提示词（slim 无参数清单、full 与工具注册表逐项一致、治理约定不丢，v0.21.0）** / 客户端 status-cache 合并（tsx 直跑源码）
npm run verify:e2e    # auth 模式 / 工具层 / **审计回归 verify-audit-fixes**（attach 覆盖保护 / 草稿类型 / 回收站索引 / delete 并发 / rename 部分失败 / 汇总未探测 / batch_put 并发顺序）/ git 冲突解决 / 崩溃自愈+并发写 / seed 两个 E2E / **verify-wiki-switch（v0.22.0：真起两个 wiki，切换 / 回滚 / 指针文件 / 非法输入）**
npm run verify:large  # 3000+ 条目大 wiki：检索耗时、二进制零出现、真跑 commit（约 1–3 分钟）
# 另有（不进 CI，依赖本机 Chrome / 线上 wiki）：
node scripts/verify-clip-bridge-browser.mjs # 真实无头 Chrome：书签 href 保留 / 执行弹浮层（可用 PUPPETEER_CORE_PATH / CHROME_PATH 指定）
node scripts/verify-menubar-theme.mjs / verify-theme-browser.mjs
```

**CI**：`.github/workflows/ci.yml` 4 个 job——`static`（typecheck + build + `git diff --exit-code -- lib/` + `npm run verify:static`）、`selftest`（+`smoke:client`）、`verify-unit`（`npm run verify:unit`）、`verify-e2e`（`npm run verify:e2e` + `npm run verify:large`）；后三者 `needs: static`。**CI 只调用 npm 聚合脚本，不再各自维护第二份脚本清单**（v0.20.0 审计：两边清单漂移导致 `verify-status-cache`/`verify-audit-fixes` 从未在 CI 跑过）。浏览器类脚本不进 CI（会静默 SKIP，等于假绿）。

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
- **本地剪藏桥**（v0.16.24+/v0.16.25 图片 / v0.18.0 SSRF）：端口按 **effective config** 启动时绑定一次（改 `bridge.port` 需重启 dsh web）；`enabled`/`token`/`tag` **每请求**读，设置页保存即生效。只绑 127.0.0.1 + Host 白名单（防 rebinding）+ 可选 `x-clip-token`；CORS 预检放行（含 PNA）——**token 为空时任意网页都能往桥写入**，务必设 token。图片下载走 `deps.download`（服务端 fetch、带 referer/UA；≤15MB/张、10 张/次），**每个 URL 与每一跳重定向都过 `assertPublicImageUrl`**（仅公网 http(s)，拒绝回环/内网/链路本地/云元数据/`.local`，先解析 DNS，`redirect:'manual'` 手动跟跳）；二进制附件 = `type: image/*` + base64 `text`（TW 5.4.1 REST 无原生二进制上传，官方形态；proven：selftest BigImage.jpg + verify-clip-bridge）；带图笔记自动改 wikitext。写入统一走 tw-api。
- client 半部是浏览器 JS（`/plugins/dsh-tiddlywiki/client.js`）；改 client → `npm run build:client` + **刷新页面**（若 DSH checkout 里同时跑着 `pnpm run dev:web`，client 改动才自动热更，否则必须重建）。
- 插件生命周期：所有 side effect（路由/工具/定时器/监听）用 `ctx.effect`/`disposer` 注册，保证热更新不泄漏。

### 工具（src/host/tools.ts）

15 个 `tiddlywiki_*` 工具，列表式注册。输出有 `render` 契约：模型看到的只是 render 后的文本，必须携带完整事实（标题/标签/摘要/git 状态），别写"UI 摘要"。

- **内容类型：默认只给新建，覆盖一律保留**（v0.16.15 引入默认 / **v0.20.1 修正**）：`text/markdown` 默认值**只适用于新建条目**（`$:/` 系统条目除外）。覆盖/追加既有条目时 `type` 必须原样保留——`cleanTiddler()` 曾把 `type` 当跳过字段，导致 `put` 把 `text/css` 改成 `text/markdown`（CSS 被当 Markdown 渲染）、`append` 干脆不写 type（TW 回落 `text/vnd.tiddlywiki`，`.md + .meta` 变 `.tid`）。现在 `cleanTiddler()` 保留 `type`、`finalTypeForWrite(title, tiddler, isNew)` 只在 `isNew` 时套默认；`append` 与 `put` 共用 `buildWriteTiddler`（并补了 `fields` 参数）。**改内容类型是显式动作**：`fields.type`（`fields.type` 是 TW 内容类型**保留字段**，业务分类值请放 tags）。
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
- **写路径的内容类型守门（v0.20.1）**：`scripts/verify-write-policy.mjs`（纯函数，7 条：cleanTiddler 保留 type / 覆盖 css 与 wikitext / 新建才默认 + 补 agent-written / `$:/` 不默认 / `fields.type` 改类型 / human 路径）+ `verify-audit-fixes.mjs` 的 6 条 E2E（css、wikitext、markdown 追加、新建默认、`fields.type` 回执、rename 与回收站恢复保类型）。回执里类型变化必须显式写出（`⚠️ 内容类型已从 X 改为 Y`）。
- **`batch_put` 有界并发（v0.19.5）**：4 路 worker 共享一个 client，**结果按入参下标回填**（顺序与逐条容错是契约，别改成 push）；`autoCommit()` 在循环外只调一次。顺序实现会为 N 条发 2N 次 REST（GET+PUT）。
- **客户端 `/status` 只有一个入口（v0.19.5）**：`src/client/status-cache.ts` 的 `fetchStatus()`（2s TTL + 在途合并，失败不缓存）。面板/tw-frame/sync-button/ui-config/FAB/sidebar-entry 原先各有一份 `fetchStatus`，加载瞬间会重复请求，而 host 每处理一次 `/status` 最多起 5 个 git 进程。新增客户端面一律用它。

### 提示词注入（src/host/prompt.ts + src/index.ts `applyPrompt()`）

- `buildPromptText({ mode, extra, override, tools, enabled })` 组装 section 文本；注册点 `systemPrompt.section({name:'dsh-tiddlywiki', order:100, text})`。**默认 `slim`**：工具能力一句话（个数由注册表算）+ 写入/并发纪律 + 同步纪律/冲突处理 + 标签约定（`agent-written`/`human-edited`/workspace tag）+ 内容类型约定 + 想法沉淀 + 可点击链接格式；**不再手抄工具参数**。`full` 形态追加 `- \`tiddlywiki_x\`（p1, p2?）` 目录，**由 `tiddlywikiToolSummary()` 从 `registerTiddlywikiTools()` 的注册结果生成**。
- **v0.21.0 的由来（别再犯）**：手抄的参数清单一停就是 4 个版本（v0.19.0 → v0.20.1 期间 6 处过期：delete/append/attach/batch_put/trash/list_tags）。任何「把 schema 抄进提示词」的冲动都应改成「从注册表生成」。
- **可配置 + 即时生效**：配置 `prompt{enabled,mode,extra,override}`（设置页「系统提示词」区块）。`applyPrompt()` 在 tool 注册后、`configStore.load()` 后、以及 `/admin/config` 保存后（`AdminDeps.onConfigChanged`）各调一次；**文本未变则跳过重注册**（避免无关设置引起 prompt 抖动）。DSH 的注册/注销会 emit `system-prompt/change` 并把系统消息更新进历史，所以**保存后当前会话下一步即生效**（不需要重启 dsh web、也不只影响新会话——这推翻了 v0.16–v0.20 的说法）。
- **用户文本必须过 `escapePromptBraces()`**：DSH 对 `{{…}}` 做严格变量插值，未知/畸形变量**直接抛错**，一条 `{{cwd}}` 就能让整个系统提示词装配失败。
- **预览接口**：`GET /admin/prompt`（只读、CSRF 硬化）回 `{enabled, mode, length, text}`，设置页「查看当前注入文本」用。
- 守门：`scripts/verify-prompt.mjs`（进 `verify:unit`）——slim 不得含参数清单、长度 ≤1800；full 的每个工具与每个参数都必须在其目录行出现；两种形态都必须包含全部治理约定块；`enabled:false` 返回空串；`extra`/`override` 组合语义；`{{` 转义。E2E 在 `verify-seeds-admin.mjs` 第 8 段（GET `/admin/prompt` 的内容与模式、POST `/admin/config` 触发 `onConfigChanged`、POST 预览 → 405）。
- ⚠️ 顺序约束：`applyPrompt()` 必须在 `registerTiddlywikiTools()` **之后**首次调用，否则 `full` 目录是空的。

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
- **配置密钥只出「打码」形态（v0.19.3）**：`/admin/state` 是**只读、无鉴权**的读路由（设置页要读配置），曾把 `config` 原样回给浏览器→任何同源请求都能取到 `bridge.token`/`auth.password`/带凭据的 `git.remote`。现在 `maskConfigSecrets()` 把密钥换成 `********`（v0.20.0 起 `auth.password` 也打码 + `passwordSet` 展示位），`/admin/config` 收到 `********` 用 `stripMaskedSecrets()` 当「未修改」丢弃。**新增返回 config 的接口必须过打码**，回归在 `scripts/verify-secret-masking.mjs`。
- **`$:/plugins/dsh-tiddlywiki/` 命名空间不给代理（v0.19.3）**：`/tw/*` 与 `/api/*` 是同源代理，此前能直接 `GET /dsh-tiddlywiki/tw/tiddlers/$:/plugins/dsh-tiddlywiki/config` 拿到**未打码**的配置 tiddler（密钥暴露的第二条路）。`BLOCKED_PROXY_TITLE_PREFIXES` + `isBlockedProxyPath()` 现在对**插件自身命名空间**返回 403（selftest 断言 `tw`/`api` 两条路径都是 403）；v0.20.0 把同一谓词抽成 `isBlockedProxyTitle()` 并套到 **`POST /render`**——TW 的 `/render` 对任意标题都作答，实测能把配置 tiddler 连 token 与 git PAT 一起渲染出来（渲染片段净化器只管标签，管不住正文）。**任何把调用方标题变成 TW 输出的路由都必须过 `isBlockedProxyTitle()`**。插件配置只能经 `/admin/state`（已打码）读写。TW 自身系统 tiddler（`$:/config/...` 等）不受影响。
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
- 提示词改动（v0.21.0 起）：设置页保存即生效（当前会话下一步）；**工具集/默认提示词文本**的改动仍需重启 dsh web（`applyPrompt()` 是启动时装配的）。
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
7. **发布 npm**（本机 npm 账号已登录：`ok1989223`）→ `npm view dsh-tiddlywiki version` 确认 latest。
   - ⚠️ **本机默认 registry 是 `registry.npmmirror.com`（只读镜像）**，直接 `npm publish` 会 `ENEEDAUTH`；必须显式指定官方源：`npm publish --registry=https://registry.npmjs.org`。
   - ⚠️ **发布后有传播延迟，别被两个假信号误导**：① 第一次 `npm view dsh-tiddlywiki version`（默认走 npmmirror）会**一直显示旧版本**，要加 `--registry=https://registry.npmjs.org` 或直接查 `https://registry.npmjs.org/dsh-tiddlywiki` 的 `dist-tags`；② `dist-tags.latest` 可能**先**变成新版本，而 `GET /dsh-tiddlywiki/<新版本>` 还 404（版本文档仍在同步），此时重发会报 `E409 Cannot publish over previously staged version` / `E403 You cannot publish over the previously published versions` —— 这两种都不是失败，**等 1–2 分钟再查一次**（v0.19.5 实测：`dist-tags` 已是 0.19.5、版本文档 404 约 30s 后才出现）。
   - 发布包只含 `lib/` + `src/` + `docs/`（不含 `scripts/`）：要跑 `npm run verify*` 请用 git 仓库。
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
- **重启 TW 前必须确认写入已落盘（v0.18.0 / v0.19.0）**：`waitForFileWrite` 要传 `newerThanMs`（等 **mtime 前进**），只判「存在」会在文件早就存在时立刻返回、重启随即杀掉未 flush 的 REST 写入；且**等一个文件不够**——必须再跑 `flushPendingWrites()` 排干 syncer（见下面两条）。只有 `render-route` 这类带 server route 的 seed 才需要重启。
- **写路由必须显式声明 HTTP 方法（v0.19.0）**：宿主 webserver 只按 pathname 分发，`isCrossSiteWrite` 又放行 GET，所以漏写方法的写路由会被 `GET`（乃至跨站 `<img>`）触发。新加写路由时用 `rejectCrossSiteWrite(req, res, ['POST'])`，读路由用 `rejectNonRead`。
- **SSRF 守卫要按字节判 IPv6（v0.19.0）**：字符串前缀法漏掉 `0:0:0:0:0:0:0:1`、`::0:1`、`::ffff:7f00:1`（都是回环）。`isPrivateAddress` 现在用 `ipv6ToBytes` 展开成 16 字节，并处理 IPv4-mapped / 6to4 / NAT64；下载用 `lookup` **pin 住已校验的 IP**，避免 DNS rebinding 在 check 与 connect 之间换答案。
- **TW REST 的 PUT 是整体替换（v0.19.0 数据安全）**：只发 `{title, text}` 会抹掉既有 tags 与自定义字段。所有「基于已有条目改写」的路径都要走 `buildWriteTiddler()`；而单条 GET 返回的自定义字段**嵌套在 `fields` 下**，`cleanTiddler()` 必须摊平（否则 rename/append/trash 一样会丢字段）。
- **任何重启 TW 之前都要 `flushPendingWrites()`（v0.19.1 补漏）**：REST PUT 返回 204 时 syncer 还握着这条写入（~250ms 定时器），此时重启会**直接吞掉它**（v0.19.0 只在 seed 路径做了，`/sync` 与工具 `git_sync` 漏了 → agent 连续 `put → git_sync` 时可能丢笔记）。两条路径现在都先写哨兵再重启。
- **flush 哨兵的三个陷阱（v0.19.1 / v0.22.0 实测）**：① **扩展名**——TW 按内容类型决定扩展名（`text/plain` → `.txt` + `.txt.meta`、`application/json` → `.json`、默认 wikitext → `.tid`），旧实现写 `text/plain` 却等 `.tid`，永远等不到；② **mtime**——哨兵紧接在等待之前写，Windows 上新文件 mtime 可能落在同一/前一个时钟刻，`mtime >= startedAt` 永不成立。两者都让 `flushPendingWrites` 每次都超时返回 false 而调用方只当 warning（等于没生效）。③ **单枚哨兵证明不了队列排干（v0.22.0）**——TW syncer 会**跳过最近 1s 内保存过的标题**（`syncer.js: throttleInterval` / `chooseNextTask` 的 `isReadyToSave`），而哨兵是另一个标题、随时可写：它会「插队」先落盘，被 throttle 的标题仍在队列里。v0.22.0 新增的 marker 写入改变了时序，让 `tw-web-host` **每次**都被这样丢掉（verify-seeds-admin 稳定复现）。现在 `flushPendingWrites` **两段式**：写哨兵 A 等落盘 → 睡一个 throttle 窗口（从 `$:/config/SyncThrottleInterval` 读，默认 1s）→ 再写哨兵 B 等落盘；这期间所有被 throttle 的标题都会变 ready 并被写出，第二枚哨兵才真正是最后一个。
- **Host 侧注入浏览器的 TW 片段必须净化（v0.19.1 安全）**：卡片/汇总用 `dangerouslySetInnerHTML` 插进 **DSH 同源页面**，而 TW 解析器只剥 `on*`——`<iframe src="javascript:…">`、`<a href="javascript:…">`、`<form action="javascript:…">` 原样通过（实测）。客户端一律走 **`POST /dsh-tiddlywiki/render`**（`sanitize.ts` 的 `sanitizeTwFragment`），不直连 TW `/tw/render`；`verify-render-sanitizer.mjs` 会断言新注入点引用 `RENDER_ENDPOINT`。
- **重启是有状态的，必须单飞（v0.19.1）**：`WikiServer.restart()` 内部串行（routes 层的 `beginMutation` 只覆盖 `/restart` 与 `/sync`，`/admin/*` 那三处够不着——并发重启会留下孤儿 TW 进程）。启动任务（`apply()` 里的 fire-and-forget IIFE）与 teardown 也要靠 `disposed` 标志握手：先置位再 await，否则「disposer 先跑完、startup 后 spawn」同样留孤儿。
- **读路由也会泄露密钥（v0.19.3）**：`/status`、`/admin/state` 都**不需要认证**（宿主 auth 只管页面），设置页又要读配置→曾把 `bridge.token`/`auth.password`/带凭据的 `git.remote` 原样回给浏览器（现一律打码，见 §5 配置密钥那条）。
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
- **提示词别再手抄工具 schema（v0.21.0 教训）**：旧 `PROMPT_TEXT` 手写的参数清单停更 4 个版本、6 处过期（delete/append/attach/batch_put/trash/list_tags）。现在 `slim`（默认）不含参数清单，`full` 的目录由 `tiddlywikiToolSummary()` 生成，`verify-prompt.mjs` 守住「工具改了而提示词没跟上」。**改工具不必动提示词；改治理约定两个形态都要过 verify。** 生效时机分两类：设置页改 `prompt.*` **保存即生效**（当前会话下一步，靠 `system-prompt/change` 更新历史系统消息）；改 `prompt.ts` 内置文本或工具集要 `build:host` + 重启 dsh web。用户文本必须过 `escapePromptBraces()`——DSH 对 `{{…}}` 严格插值，未知变量**直接抛错**、一条 `{{cwd}}` 就能炸掉整个装配。
- **`$:/temp` 条目在 iframe 的 story view 里永远无法正常显示**（「汇总显示成源码」，v0.16.11–19 教训）：① 浏览器端同步排除 `$:/temp`（recipe 默认 `[all[tiddlers]!is[system]]`，tiddlyweb adaptor 又 `-[prefix[$:/temp/]]`，lazyLoad 只补已知 skinny），`#标题` hash 直达必然「佚失条目」；② 即便把条目注入 iframe store，TW 5.4.1 的 `$:/config/ViewTemplateBodyFilters/system` 仍把 `$:/temp/` 一律按**代码块**渲染（`<pre><code>`，headless 实测），与 tiddler 的 `type` 无关。**故 v0.16.19 起汇总 Tab 不用 iframe/story view**，走与工具卡同一条 `/tw/render` 片段管线（renderText 把 wikitext 解析成 HTML，链接重写为 `/dsh-tiddlywiki/tw/#标题`）。排查：headless 渲染 `$:/core/ui/ViewTemplate/body`（currentTiddler=该标题）看是否 `<pre><code>`，并查 TW 日志有无「…的草稿」save 任务（v0.16.16 的误编辑路径，已被 v0.16.19 整体消除）。服务端直连 REST（tw-api）不受影响。
- **bundle 是 ONE-SHOT、用户自有**：改了 bundle 源件后旧 wiki 不会自动更新，要手动覆盖 wiki tiddler + 用户重载 TW 面板。
- **在「知识库」Tab 的汇总条目上点 ✏️ 编辑 → 整页显示 wikitext 源码、链接点不动**（v0.16.16）：TW 的编辑草稿 `Draft of '…'` 会继承全文并以编辑框呈现，看起来像「没正确渲染」，还会经浏览器同步回流服务端日志（`Dispatching 'save' task: "…"的草稿`）。根因不是渲染坏了（数据/类型/服务端 render 均正常；TW 5.4.1 没有 `wiki.refreshTiddler`，强制重渲染要走 `$tw.rootWidget.refresh(changes)`）。v0.16.16 起对汇总条目做三层防误编辑：清残留草稿 + 吞 `draft.of` 指向汇总之新草稿（包 `wiki.addTiddler`，幂等 WeakSet）+ 禁用 ✏️（本地化 tooltip 定位）。排查「汇总显示源码」先看 TW 日志有没有「…的草稿」save 任务。
- **Tw 的 notifier 只认「已存在的 tiddler 标题」（v0.20.0 教训）**：`$tw.notifier.display(x)` 在 `$tw.wiki.getTiddler(x)` 为空时**什么都不做**（core/modules/utils/dom/notifier.js）。send-to-agent 的 `notify()` 曾把自由文本当标题传，于是按钮的成功/失败提示**全部静默**（用户点完毫无反馈）。要提示就先写一个 `$:/temp/...` 提示 tiddler 再 display 它；bundle 改动后必须重跑 §4 流水线并 bump 版本。
- **`/render` 也必须挡插件命名空间（v0.20.0 安全）**：`/get`、`/tw`、`/api` 都挡了 `$:/plugins/dsh-tiddlywiki/`，唯独 `POST /render` 漏了——TW 侧 `render.js` 的 `{title}` 分支对任意 tiddler 都渲染，于是打码与代理拦截被整体绕过（实测：返回的 `<pre><code>` 里含 `bridge.token` 与带 PAT 的 `git.remote`）。新增任何「调用方给标题、TW 出正文」的路径都要过 `isBlockedProxyTitle()`，selftest 有 `/render` 403 断言。
- **`/edit` 的草稿永远不许覆盖既有草稿（v0.19.5 回归 / v0.20.0 修复）**：v0.19.5 的「先单条 GET 规范草稿名」重构把分支写反了——规范草稿**已存在**时反而直接写进去（覆盖用户未保存的编辑），而扫描到的异构草稿被改名成新条目（留孤儿）。正确语义是 `free ? canonical : (复用扫描到的草稿 ?? canonical+时间戳)`，重排时务必保留这个方向。
- **覆盖写入绝不能「顺手」改内容类型（v0.20.1 教训）**：TW 的解析方式完全由 `type` 决定，改错类型不会报错、只会静默换一个 parser——CSS 被当 Markdown（样式失效）、Markdown 被当 wikitext（`##` 字面量）。两个易踩点：① 任何「跳过字段」白名单都别把 `type` 放进去（`cleanTiddler()` 就是这么坑的）；② `append` 这类「只是加一段文字」的路径也必须走共享写策略，手写 PUT body 会漏字段（连 type 都没写 → TW 补默认 wikitext）。
- **seed 更新检测的三个「不许猜」（v0.22.0）**：① marker 里的哈希记录的是**我们写下的内置正文**，不是当前 wiki 内容——`stored != recorded` 才是「用户改过」，`recorded != 内置` 才是「内置有更新」，两者不可混；② 旧 marker（`seeded-once`，无哈希）**不得**判成「用户改过」（否则升级后满屏误报）——只在文本恰好等于内置时认定归属并顺带升级 marker，否则报 `updateAvailable + userModified: undefined`（无法确认）；③ `updateAvailable` 只是**提示**，绝不自动改写用户的 wiki（自动更新意味着覆盖，必须由用户点）。`doc-note` 正文里的工具清单也**由注册表生成**（`docNoteText(tools)`）——它曾经写死「10 个 agent 工具」而实际 15 个，是提示词漂移的同类问题。
- **知识库指针必须在 wiki 之外（v0.22.0）**：设置页的覆盖层存在 wiki 自己的配置 tiddler 里，所以「用哪个 wiki」若也存那里就会鸡生蛋（切过去就丢选择）。故指针固定为 `$DSH_HOME/dsh-tiddlywiki/location.json`，优先级 state > cordis config > 默认，且**最后**才写（此前任何一步失败都回滚旧 wiki，指针仍指向那个可用的）。切换会 `stop → applyLocation → start → reloadConfig → bootstrap → setupExtras`，`applyLocation` 必须**在 child 停止时**调用（`WikiServer.setLocation` 会拒绝运行中的切换）；`WikiServer` 的端口**故意保留**（iframe src 与 REST client 不失效），但 `clientCache` 必须清掉（它缓存的是旧 wiki 的列表）。切换期间并发请求要么被 `switching` 拒绝、要么直接失败——都别静默排队。
- **`tsconfig.json` 已开 `noUnusedLocals`（v0.20.0）**：审计发现的 16 处死 import / 死类型（`index.ts` 的 12 个 re-export 冗余 import、`tw-frame.ts` 重复的 `StatusPayload` 等）正是它没开时积累的。删引用时**别只 grep `*.ts`**——`AutoCommitter.onCommit` 就是被 `scripts/selftest.mjs`（.mjs）使用的，只查 .ts 会把它误判成死代码（selftest 当场红了）。
- Windows 下 git 的 LF→CRLF 警告无害。
- **TiddlyWeb 外部 filter 的坑（v0.16.20）**：① 非默认 filter 一律 403，除非 `$:/config/Server/ExternalFilters/<filter串>`="yes"，且**白名单文件名 = 整个 filter 串**——所以 filter 必须短（180 字符版在 Windows 上文件名顶到 217 字符、撑爆 MAX_PATH，`git add` 报 "Filename too long" 让自动 commit 失效；86 字符版安全，selftest git 段守门）；② `prefix`/`match` 只匹配 **title**，字段用 `regexp:type[...]`/`field:type[...]`；③ `[has[type]]` 与 `[has:type[]]` 不是一回事；④ 空格=**并集**、`+`=交集；⑤ 取反的 `regexp:type`/`field:type` 会**丢掉无 type 字段**的 tiddler——「排除二进制」必须写成正向并集（无 type OR `text/*`），见 `tw-api.ts` 的 `TEXT_LIST_FILTER`。
- **筛选器操作数别用 `[[...]]` 双括号**（v0.16.22 首页快速记笔记 tags 变「筛选器错误」的坑）：`then` 等**操作符**的 operand 只接受普通 `[...]`（或 `{$var}`），`then[[todo]]` 会被解析器报 `Missing [ in filter expression`——`{{{...}}}` 求值失败后错误文本被当成 tags 写入（`Tiddler` 构造按空白切分 → 出现「筛选器错误: / Missing / [ / in ...」6 个 tag）。正确写法 `then[todo]`。selftest 已断言首页 seed 不含 `then[[`。
- **不要向 dsh-better-sidebar 注册 tab kind（v0.17.0 教训）**：`ctx.betterSidebar.registerTab({id})` 的 id 是**全局 tab kind**——同一 kind 被注册两次即报 `sidebarRight: tab kind "dsh-tiddlywiki" is already registered (extension)`（热更新/重复 apply/别的插件占用都会触发）。v0.16.23 曾用 `id: 'dsh-tiddlywiki'` 注册 TW tab，v0.17.0 已**整体移除**该集成；插件不再引用 `ctx.betterSidebar`。若将来要重新支持，务必用插件私有前缀（如 `dsh-tiddlywiki/tw`）并做幂等注册。
- 消息里**附加说明放消息末尾**（正文之后），别插在待办说明与正文之间。

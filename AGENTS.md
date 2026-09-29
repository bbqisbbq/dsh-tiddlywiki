# AGENTS.md — dsh-tiddlywiki 项目速览

> **本文件只放「必须无条件遵守的规则 + 速查指针」**。所有细节（架构事实、踩过的坑、仓库布局、构建清单、版本演进史、发布流程全文）都已拆到 **wiki 笔记**里——见下面 §5 的「开发文档索引」。
>
> 为什么这么分：本文件会作为 workspace instructions 注入每个会话，预算是 **65536 字节**；过去它长到 ~120KB，**截断正好砍掉最后几节（发布流程 / 维护规则 / 常见坑）**，等于新会话默认看不到最容易踩雷的部分。现在拆完约 12KB，且 §5 的索引让 Agent 知道「要细节去读哪篇」。
>
> 权威来源：代码即事实。本文件与代码冲突时以代码为准，并顺手修正本文件。

## 1. 项目是什么

**dsh-tiddlywiki** —— 把 **TiddlyWiki 5** 变成 DSH 的持久知识库的官方插件（npm：`dsh-tiddlywiki`，GitHub：`bbqisbbq/dsh-tiddlywiki`，MIT）。

- **Agent 侧**：15 个 `tiddlywiki_*` 工具读写 wiki；插件向每个会话注入一段中文系统提示词（`systemPrompt.section`），约定同步纪律、标签规则、链接格式等。
- **人侧**：DSH 中央列内嵌完整 TW 5 编辑器（同源代理 `/dsh-tiddlywiki/tw/`）、右下角「知识库」FAB、TW 工具栏「发送给 Agent」按钮。
- **数据**：wiki 文件夹本身是 git 仓库（自动 commit 60s 防抖 + 手动同步）；回复流里 `tiddlywiki_*` 工具结果显示原生 TW 卡片。

## 2. 速查表（当前值）

> 只列「改了必须同步本表」的当前值。**逐版本的演进说明与原因在 wiki「易变清单（全量）」**。

| 项 | 当前值 | 位置 |
|---|---|---|
| **插件版本** | `0.30.30` | `package.json` `version`（三处一致性由 `scripts/verify-version-consistency.mjs` 守门：package.json / 本文件 / **`docs/CHANGELOG.md` 顶部第一条**。**README 里不再放版本记录**（作者 2026-09-29 要求：README 只放最新最重要的信息，历史单独一个文档）——脚本另有反向断言，防止 README 又慢慢长回一堆逐版本条目） |
| **Agent 工具集（15 个）** | `search` `get` `put` `batch_put` `append` `rename` `delete` `trash` `backlinks` `attach` `lint` `recent` `list_tags` `git_sync` `git_resolve` | `src/host/tools.ts`（列表式注册；v0.28.8 起实现按模块族拆到 `tools-{support,read,notes,attach,git}.ts`，注册**顺序**由 `tools.ts` 的装配段逐行写死——它生成 `full` 提示词的参数索引，`verify-prompt.mjs` 按顺序断言）。客户端 `TOOL_VIEW_KEYS` 由 `scripts/verify-tool-views.mjs` 源码级守门——必须与注册表完全一致。**`git_sync`（v0.30.5，作者裁定）作用于所有配了 `git.remote` 的库**：按**仓库**去重（多库共用一个工作树只同步一次）、逐仓库独立成败、回执逐仓库标注库名与仓库；没配 remote 的库被列在 `skipped` 里，可同步的库为 0 时 `ok:false`（守门 `scripts/verify-git-multi-sync.mjs`，进 `verify:unit`）。`git_resolve` 新增可选 `wiki`（库 id）用于多仓库下选对仓库。并发令牌现覆盖 `put`/`delete`/`attach`/`append`/`rename`/`batch_put`（逐条目 `expectedModified`）；`tags: []` = 清空标签（不传 = 保留）；`fields` 必须是**对象**（v0.26.5：曾声明 `type:'json'` → 编译后无类型约束 → 模型发字符串被按字符拆成单字符字段；现 schema 为 `object` + 工具层 `normalizeFieldsArg()` 兜底）；**变更锁（v0.30.12）**：整插件**一把** `host/mutation-lock.ts`，`/restart` `/sync` `/admin/restart` `/admin/seeds/run`（会 drain+重启的那一段）全部走它，拿不到回 429 并报持有者；由 `index.ts` 建唯一实例、同时注入 `RouteDeps.mutationLock` 与 `AdminDeps.mutationLock`（守门 `scripts/verify-mutation-lock.mjs`，进 `verify:unit`；此前 admin 侧**一把锁都没有**，可与 `/sync` 同时停子进程）。`append` 的 `heading` 落点是「该标题之后、**下一个任意级别标题之前**」（标题后紧跟子标题时落在两者之间＝章节开头，不是整节末尾），**未命中不再静默**——返回 `headingMatched=false` 且回执明说「未找到标题…已改为追加到文末」（v0.26.6：CRLF 正文曾让标题正则全数失配、静默落文末） |
| **Seed 注册表（13 项，三层）** | 核心（自动写、不可移除）：`send-to-agent`、`render-route`、`tw-web-host`；起步（默认写、可移除）：`doc-note`、`starter-docs` + **gated 3 项**（`publish-spec`/`wechat-setup`/`wechat-publish`，仅 `wechat.enabled` 开启时写）；可选（手动）：`home-index`、`all-articles`、`ui-styles`、`menubar-theme`、`clip-bridge` | `src/host/seeds-registry.ts` 的 `SEED_DEFS`（v0.30.27 起；`seeds.ts` 原样再导出）+ `src/host/seed-util.ts`。`seeds.ts` 只留**编排**（check/run/remove）|
| **bundle 版本** | send-to-agent `0.3.6` · render `0.2.0` · wechat-publish `0.2.0` | `scripts/bundle/versions.mjs`（唯一来源） |
| **注入提示词** | `prompt{enabled,mode,extra,override}`，默认 `slim`（v0.29.0 去重后 **1011 字符 / 预算 1200**，守门 `scripts/verify-prompt.mjs`）；`full` 的参数索引由 `tiddlywikiToolSummary()` 实时生成。**去重原则**：只留 schema 表达不了的约定（同步时机 / 被拒后重读而不用 force / 时效标注 / 淘汰权归人 / `human-edited` / 链接格式 / todo）；与工具 description 重复的（工作区标记、先窄后宽、多词 AND、tags·type 保留）**只留 schema 一份**，`verify-prompt.mjs` 会在 **schema 侧**逐条断言"从提示词删 ≠ 丢了"（两处一起删立刻红）。intro 里**不许**再手写工具类别清单（那是唯一还会漂移的副本） | `src/host/prompt.ts` |
| **工作区标记** | 新建笔记自动带 `ws/<项目名>` 标签 + `workspace` 字段（取自会话 cwd，`note.workspaceMark` 可关）；检索先在工作区内查、0 条才扩全库；`query` 多词 **AND** | `src/host/workspace.ts` + `src/host/tools.ts`（守门 `verify-workspace.mjs` / `verify-tools.mjs`） |
| **配置项** | `wikiRoot`/`wiki`（**只是默认值**，运行中以指针文件优先）/`port`/`git{autoCommit,debounceMs,remote,branch}`/`note{tag,workspaceMark}`/`startup{readyTimeoutMs}`/`prompt{…}`/`bridge{enabled,port,token,tag,wiki}`/`wechat{enabled,command,token,adapter,dsn}`/`ui{…}`/`uiLanguage`/`auth{username,password}` | `src/host/config.ts`。`git.autoCommit/debounceMs/remote` 保存后**即时生效**（`reapplyGitConfig` 重建 committer）；`/admin/config` 的补丁必须先过 `normalizeConfigPatch()`（数值夹取 / 类型错误 400 / `__proto__` 等拒绝 / 未知键透传，守门 `scripts/verify-config-patch.mjs`）；**数值区间三处同源**（宿主夹取表 / 设置页表单的 min·max / 表单在未配置时的默认回显），由 `scripts/verify-config-ranges.mjs` 逐字段**比对数字**（v0.30.16）。**只在单库模式露出的字段**：`ui.sidebarLabel`（多库下每库各用自己的 label，露出来就是"改了不生效"，守门 `verify-wiki-focus.mjs`；模式探测失败按单库渲染）。`bridge.wiki`（v0.28.8）= 剪藏写进哪个库，空 = 默认库——剪藏来自书签、没有"当前会话"可跟随，所以只能显式钉死；`clipTarget()` 找不到那个 id 时**记一次日志并回落默认库**，`/clip` 回执带实际 `wiki` 字段（守门 `verify-clip-bridge.mjs`）。⚠️ v0.28.8–v0.29.0 期间这条设置**实际无效**：`WikiInstance.bridgeConfig()` 是手写对象字面量，重建时丢掉了 `wiki` 键，从未传进 `clipTarget()`（v0.30.0 修），且剪藏桥现在拒绝 `$:/` 系统命名空间标题（否则任意网页可 PUT `$:/plugins/dsh-tiddlywiki/config`）。**姿态（作者 2026-09-29 裁定）：桥不做认证、对任意页面开放 —— 「任意页面能给你的 wiki 建笔记」是许可的，不允许的只有覆盖系统项**；`bridge.token` 只是可选的额外收紧，不是设计前提 |
| **DSH 路由** | `/status`（带 `mode`/`defaultId`/`wikis[]` 名册）`/note` `/edit` `/tags` `/recent` `/get` `/search` `/render` `/sync` `/upload` `/restart` `/session/summary` `/session/wiki`（会话级知识库作用域，GET/POST 同路径；v0.29.0 起回 `mode`）`/agent/{sessions,modes,send,create}` `/wechat/{ready,publish,publish/status}` `/api/*` `/tw/*`（**`/tw/<id>/…` 按库定向**；裸 `/tw/` = 默认库别名）；admin：`/admin/{state,prompt,info,config,restart,seeds,seeds/run,seeds/remove}` + `/admin/wiki/{location,switch,reset}` + `/admin/wikis`（列表读写：add/update/remove/set-default/set-mode + 运行态 start/stop） | `src/host/routes.ts` + `src/host/admin.ts`。非代理路由都吃 `?wiki=<id>`；**三种语义（v0.29.0 定稿，只有一份实现 `wiki-farm.ts`）**：命名的库在跑 → 就是它；**已登记但没在跑 → 503 并点名那个库**（`stoppedWikiFromRequest()` / `stoppedWikiMessage()`，路由侧先查 `deps.targetProblem` —— 否则设置页写着「正在配置 X」却改默认库，`/admin/info`/`/status`/`/sync`/`/restart`/快速笔记全都中招）；**未知 id → 回落默认库**（老书签不能 404）。守门 `scripts/verify-wiki-farm-boot.mjs`（行为级：503 + 点名 + 未知 id 仍回落） |
| **客户端 Slot** | `settings.section`(50) · `conversation.input.dock`(`quick-note`,8；会话知识库选择器 v0.28.7 起由它的 `scope` 参数**渲染在同一行内**，不再是独立条目——该槽位一个条目 = 一整行，两条目永远对不齐) · `conversation.input.selector.context`(v0.28.8：**空白会话**的座位；v0.28.11 起**不再"声明不到就回落 dock"**——那个回落会注册第二个 dock 条目，正是「新会话出现两个知识库选择」的成因。现在 dock 里的内联选择器是唯一常驻的家，context 那一格挂上后靠 `blankOnly` + `scope-seat.ts` 的 `blankSeat` 标记让位，守门 `verify-wiki-focus.mjs`) · `conversation.view`(`dsh-tiddlywiki-summary`,20) · `sidebar.right.pane.tab`(keyed `dsh-tiddlywiki`) · `tool.call.toolview`(15 个工具 key) | `src/client/index.ts` 等。选择器在可见库 ≤1 时返回 null 不渲染。**回复流里的 TW 链接打开哪个库**（v0.28.11）：链接自带 `/tw/<id>/` 就用它；裸 `/tw/#标题` 取所在卡片 / 会话汇总面板上的 `data-dsh-tw-wiki`；都没有（助手正文里的链接）才跟随焦点库。`panel.ts` 拿到 `wiki` 会先 `setFocusWiki()` 再路由（此前整个丢掉 → 点「在 TW 打开」跳到最后打开的那个库），内核 `tw-frame.ts` 的 `wikiSwitchPending` 保证先换库、再把 hash 落到新文档。守门：`verify-wiki-focus.mjs`（源码级）+ `verify-frame-surface.mjs`（行为级）。**「默认库」不作为名字出现在界面上**（v0.28.12，作者要求）：被设为默认的那个库一律用自己的显示名 + 「（默认）」身份标记——会话选择器（读 `/session/wiki` 的 `resolved{id,label}`，新会话打开即选中它，选中它 = 发 null 清空显式作用域）、快速笔记「写入」目标、设置页剪藏目标（空值那一项代表它，且该库不再单独列一遍）、`单库（只跑 X）` 与切单库确认文案；`verify-wiki-focus.mjs` 会**剥掉注释**后断言这四个模块的代码里没有「默认库」字样。**左侧多库入口的点击语义**（v0.28.13）：点**另一个**库 = 切换（面板保持打开），点**当前显示的那个**库才收起——判定收在 `sidebar-entry.ts` 的 `resolveEntryClick()`/`applyEntryClick()`（纯函数 + 真 `PanelState`，行为级守门），且**必须在 `setFocusWiki()` 之前**求值；行高亮与点击判定同源（都用 `shownWiki()`），入口行里**不许再出现 `toggle()`**。**切库的延迟**（v0.28.14）：焦点一变就**同步**把 iframe 指到新库（`switchFrameNow()` 复用上一次 `/status` 的 payload），**不许等 `/status` 往返**（host 每次要跑最多 5 个 git 进程，实测 300–400ms）——那次往返曾是"点下去先空一下"的第一段；侧边栏焦点变化只重画高亮（`paintFocus`，不再重跑名册）；换文档期间挂一条 `.dsh-tw-loading` 提示（整份 wiki 是 10–30MB 且 TW 回 `no-store`，缓存不了，那 1–2 秒必须给可见说明），`load` 到达或 15s 兜底收起。守门 `verify-frame-surface.mjs`（行为级：让 `/status` 永不返回也必须换）+ `verify-wiki-focus.mjs` |
| **客户端 i18n（v0.30.6）** | 两个语言：`zh`（默认）/`en`。**唯一入口** `src/client/i18n.ts` 的 `t(key, vars?)`（`{name}` 插值）；**目录按区域分片**：`i18n-{chrome,note,card,settings,config,plugins,frame}.ts`，每个分片导出 `{zh, en}` 且**键集合必须一致**，键名 = `<区域>.<东西>`。语言来源：**插件配置 `uiLanguage`**（与 TW 子进程同一个设置）→ host 在 `/status` 回 `lang` → `status-cache.ts` 的 `fetchStatus()` 调 `setLang()`；客户端另在 `localStorage` 缓存一份，**刷新后首屏即为该语言**（改语言后其余界面下次刷新生效，设置页会说明）。守门 `scripts/verify-client-i18n.mjs`（进 `verify:unit`）：① 每个分片 zh/en 键集合一致；② 每个 `t('…')` 的键都存在；③ 没有从未使用的键；④ **客户端字符串字面量里不得残留中文**，除非是 `t()` 的第一个参数或在脚本内 ALLOWLIST 里（每条都写明"这是与 host 中文回执匹配的协议，不是文案"）。新增文案一律走 `t()`，别直接写中文。**尚未转换的文件**列在守门脚本的 `PENDING_CONVERSION` 里（v0.30.14 实况：**283 → 467 键 / 7 个分片**，`PENDING_CONVERSION` 已**清空** —— `src/client/` 下不再有未转换的用户可见中文；本轮转掉的是工具卡 `tool-views.ts`（同时拆成模块族）、设置页的插件/主题/语言/初始化 `settings-page-catalog.ts` 与常规配置 `settings-page-config.ts`），该清单**只减不增**且自清洁：某个文件转完后没从清单删掉，守门会红并点名它 | `src/client/i18n.ts` + `i18n-*.ts` || **模块拆分（v0.28.8 / v0.30.0–v0.30.29）** | v0.28.8：`tools.ts`→`tools-{support,read,notes,attach,git}.ts`、`admin.ts`→`admin-{catalog,secrets,routes}.ts`、`index.ts`→`index-{wikis,git,prompt,clip}.ts`、`note-widget.ts`→`note-widget-{draft,tags,upload}.ts`、`settings-page.ts`→`settings-page-{runtime,wikis,config,catalog}.ts`；v0.30.0：`styles.ts`(945)→**47 行**（900 行 CSS 正文移入 `styles-css.ts`）+ 新增共享安全原语 `proxy-guard.ts`；v0.30.1（纯搬迁）：`clip-bridge.ts`(872)→**574**（SSRF 层 `clip-bridge-ssrf.ts` 315 + 尺寸上限 `clip-bridge-limits.ts` 17）、`seeds.ts`(824)→**658**（排干/重启原语 `seeds-flush.ts` 198）；v0.30.2：`routes-session.ts`(632)→**274**（`createSessionRoutes()` 那个 432 行的函数按族拆成 `routes-session-summary.ts` + `routes-session-agent.ts`，装配只剩两行工厂调用）；v0.30.3：`clip-bridge.ts`(574)→**414**（payload 层 `clip-bridge-payload.ts` 189）；`<base>.ts` 一律保留为**组装/barrel**。v0.30.7：`tools-notes.ts`(683)→**14 行的 barrel**（七个工厂按职责搬进 `tools-notes-write.ts`（get/put/batch_put）· `tools-notes-structure.ts`（rename/append）· `tools-notes-lifecycle.ts`（delete/trash），导入路径与注册顺序不变）。v0.30.9：`routes.ts`(1373)→**983**（`routes-helpers.ts` 256：纯 helper 与 `openInTwEditor`，公开的三个由 routes.ts 原样 re-export；`routes-wechat.ts` 210：`guardWechat` + 三条公众号路由抽成 `createWechatRoutes(deps)`，依赖面用 `Pick<RouteDeps,…>` 写明）。v0.30.10：`routes.ts`(983)→**667**（`routes-note.ts` 373：`/note` `/tags` `/recent` `/get` `/search` `/upload` 抽成 `createNoteRoutes(deps, helpers)`；顺手修掉 `/upload` 回执 url 缺 `/tw/<id>/` 的多库缺陷）；v0.30.14：`tool-views.ts`(940)→**7 个模块 + 组装口**（`tool-views-{types,fetch,shell,body,search,misc,links}.ts`：类型与参数解码 / 取数·`useAsync`·正文 LRU 缓存 / 卡片外壳与知识库作用域 / 原生渲染正文卡与列表原语 / 检索·最近·批量卡 / 附件·标签·git·删除卡 / TW 代理路径判定与链接拦截器。`tool-views.ts` 只剩调度器 + `TOOL_VIEW_KEYS` 注册，公共面原样 re-export。同一轮把这一族的文案全接进 i18n（`i18n-card.ts` 49 键），并让三个**按精确文件名**读源码的守门改读模块族）；v0.30.18：`src/host/session-summary.ts`(633)→**416**（扫描层 `session-summary-scan.ts` 239：`NOTE_TOOL_NAMES` + 两个扫描上限 + 六个只与「读事件日志」有关的函数（`collectDescendantIds`·`isPlausibleTitle`·`record`·`trimTrailingClosers`·`scanRefs`·`scanSnapshot`）；**值**型常量搬进扫描层、base 反向 import，依赖只有一个方向、不造运行期环）；v0.30.19：`admin-routes.ts`(746)→**632**（`admin-routes-wikis.ts` 145：`/admin/wikis` 与 `/admin/wiki/{location,switch,reset}` 四条 handler 收进 `createAdminWikiRoutes(deps)`，依赖面用 `Pick<AdminDeps,'server'|'wiki'|'wikis'>` 写明、一个闭包 helper 都不需要；这一组**不吃 `?wiki=`** —— 它问的就是「哪个库」本身，所以也不需要 `refuseStoppedTarget`；注册表 12 行一行未改）；v0.30.20：`admin-routes.ts`(632)→**535**（`admin-routes-seeds.ts` 142：`/admin/seeds` 三条收进 `createAdminSeedRoutes(deps, helpers)`，依赖面 `Pick<AdminDeps,'getClient'|'getWikiPath'|'mutationLock'|'seeds'|'server'>` + base 的 `notRunning`；这一组是全仓库**唯一**「写完就 drain + 重启 TW」的 admin 路由，同时牵着铁律 #1 与共享变更锁 v0.30.12，单独成文件让「谁能停子进程」在 admin 侧只有一处可读；顺带清掉三条因此未使用的 import）；v0.30.24：`admin-routes.ts`(535)→**358**（`admin-routes-info.ts` 224：`GET /admin/state` 与 `POST /admin/info`（写 `tiddlywiki.info`）收进 `createAdminInfoRoutes(deps, helpers)`；⚠️ 这一组的 `handleInfo` **也**会 `drainThenStop` + 重启 —— 「会停子进程的 admin 路由」不止 seeds 一组，所以它同样在铁律 #1 的守门范围内；靠 `noUnusedLocals` 精确清掉三条只被这一组使用的 import）；v0.30.25：`admin-routes.ts`(358)→**272**（`admin-routes-config.ts` 131：`POST /admin/config` 与 `GET|POST /admin/prompt` 收进 `createAdminConfigRoutes(deps, helpers)`，依赖面 `Pick<AdminDeps,'config'|'getClient'|'getPrompt'|'onConfigChanged'>` 是**按代码生成**的；本文件至此成为**纯组装点**（接口 + 闭包 helper + 四个工厂调用 + 注册表），与 `routes.ts` 同形态。⚠️ 搬迁脚本的两条教训：切范围要**按内容找终点**（按「下一条注释」猜会把相邻的工厂调用卷进去），且脚本必须自带前置断言 —— 否则会在破损状态上再切一刀）；v0.30.27：`src/host/seeds.ts`(657)→**262**（`seeds-registry.ts` 422：`SEED_DEFS` 那张表 + 装配它的 `defineSeed`/`inspectSeedContent`/`refreshSeedMarker`/三个小判定。分界线是**策略 vs 编排**；`isOurProxyBase` 必须跟着搬，否则「注册表 → base → 注册表」就是真环；base 原样再导出 `SEED_DEFS`/`isOurProxyBase`，外部导入路径不变。搬迁手法升级为**编译器驱动**：按 region 实际用到的名字重生成 import、base 侧按 `noUnusedLocals` 只删「确实是 import」的行）；v0.30.28：`src/client/tw-frame.ts`(736)→**652**（`tw-frame-api.ts` 107：公共 API 层 —— 事件名 / `reloadTwSurfaces` / 标签文字 accessor / `requestRestart` / `TwTabIcon` / `loadableFrameUrl`。**先扫引用确认「只引用自己人」才动手**（与 v0.30.27 相反：这里不需要 base 反向 import ⇒ 无环）；内核里两处直接读模块级 `tabLabel` 改成 `getTabLabel()`（搬迁逼出「谁有权碰这份状态」，答案是 accessor）；守门 `verify-tw-origin.mjs` 那条**钉死 import 字面量**的断言改为「族里从 endpoints.ts 取到了必需符号」+ 单独钉住 `RESTART_ENDPOINT` 仍在族内）；v0.30.29：`src/host/wechat-publish.ts`(700)→**450**（`wechat-publish-contract.ts` 275：适配器/配置归一化/调用拼装/输出判定/任务视图类型 —— 契约层，**无状态无子进程**；base 只留 `WechatPublishRunner`。⚠️ 两个「入口版本哨兵」`WECHAT_ADAPTER_MARKER`/`WECHAT_TITLE_FILE_ARG` **故意留在 base**：守门按精确文件读它们的**赋值字面量**，而它们只被 base 的 `WECHAT_FRESHNESS_MATCHERS` 用到 ⇒ 留得住也不成环。生成器两个缺陷已修：别名 import 要按 `as` 之后的**局部名**判定、非 export 的声明搬走后要 `export` 化且 base 的清单应从新文件**实际导出**反推）| 守门按**模块族**读源码：`scripts/lib/source-family.mjs` 的 `readFamily(repoRoot, '<relBase>')` 把 `<base>.ts` + `<base>-*.ts` 拼成一份文本。**新增拆分文件必须用 `<base>-xxx.ts` 命名**，否则守门读不到、断言会静默失效。纯搬迁时不要动 `scripts/`。**仍未拆**（审计给了逐文件方案，见 wiki 审计笔记；**行数为 2026-09-29 实测**）：`index.ts`(1036)、`note-widget.ts`(993)、`tw-frame.ts`(652，v0.30.28 已出公共 API 层)、`wechat-publish.ts`(450, v0.30.29 已出契约层)、`seeds.ts`(657)——`routes.ts` 已从 1373 拆到策略 702（v0.30.9/0.30.10） |

## 3. 铁律（不可协商）

1. **重启/停止 TW 前必须把 syncer 队列排干** —— **只能经 `drainThenStop()`**（`src/host/seeds.ts`，v0.24.1）：排干（`flushPendingWrites` 两段式哨兵 + throttle 窗口）就发生在它内部，裸调 `server.restart()` / `server.stop()` 等于丢写入。**所有**路径（启动自举 / seed / `/sync` / `/restart` / 知识库切换）都必须走它；启动自举（v0.29.0 起）与 `start()` 的卸载中止一律调 `instance.restart()` / `drainStop()`，**全文件不得再有裸 `this.server.restart()/stop()`**（唯一例外 `dispose()`，它按设计不排干）。守门 `scripts/verify-restart-drain.mjs`（源码级：**枚举全部调用点**并逐个断言落在 `drainThenStop` 的 stop 回调里——旧版用 `indexOf` 只看第一处，漏掉了自举路径上两处裸 restart + 行为级：stop 必须在排干之后、排干失败也必须继续 stop）。
2. **所有写路径必须「先读旧条目、再走共享写策略」** —— `get` → `buildWriteTiddler()`。TW REST 的 PUT 是**整体替换**，手拼 body 会丢 tags / 自定义字段 / `type` / 时间戳。同名且非新建、无 `force` 时**宁可报错也不静默覆盖**。
3. **绝不把「读取失败」当「条目不存在」** —— `wiki.get()` 只有 404 返回 `undefined`，其余抛错。禁止 `.catch(() => undefined)` 兜底（那会让 seed 覆盖用户内容、给人类笔记误打 `agent-written`）。
4. **每个写路由必须显式声明 HTTP 方法** —— 宿主 webserver 只按 pathname 分发。写用 `rejectCrossSiteWrite(req,res,['POST'])`，读用 `rejectNonRead`。
5. **每个路由 handler 必须包 `guardHandler()`** —— 未捕获的 rejection 既不回包也不回收连接 = 永久挂起的请求。
6. **所有「把调用方标题变成 TW 输出」的路径必须过 `isBlockedProxyTitle()`** —— `/get`、`/tw`、`/api`、`/render` **以及 agent 工具 `tiddlywiki_get`**（v0.30.0：工具曾是唯一漏网的一条，模型能原样读出 `$:/plugins/dsh-tiddlywiki/config` 里的密钥）都要；`/render` 的 `text` 分支还要过 `referencesBlockedTitle()`（`{{…}}` 转写能绕过 title 检查）。原语现在住在 `src/host/proxy-guard.ts`（工具层不该为安全原语 import 路由模块），`routes-tw-proxy.ts` 原样再导出。
7. **Host 侧注入浏览器的 TW 片段必须净化** —— 一律走 `POST /dsh-tiddlywiki/render`（`sanitize.ts`），客户端不直连 TW，因为注入点是 DSH 同源页面的 `dangerouslySetInnerHTML`。
8. **`lib/` 必须零 `@deepseek-ai` 运行时 import** —— `sdk.ts` 自实现 `defineTool`；否则 npm 镜像的 dsh-tools 会遮蔽 CLI 内置实现、搞坏 agent 循环。
9. **client 必须 minify**（否则 >1MB 被插件注册表校验拒绝）；**行尾必须 LF**（`.gitattributes`；`lib/index.js.map` 内嵌源文，CRLF 会让 CI 的 `git diff --exit-code -- lib/` 必失败）。守门 `scripts/verify-line-endings.mjs`（进 `verify:static`）：扫 `src/` `scripts/` `tools/` `docs/` `lib/` + 根目录全部文本文件，**工作区里任何 CRLF 直接红** —— `.gitattributes` 会把 CRLF 归一成 LF，所以 `git status`/`git diff` **看不见**这个状态，而它会让「用 PowerShell 做批量改写/反向验证注入」变成**静默空操作**、让 `/^…$/m` 锚点带上尾部 `\r`（v0.26.6 的 CRLF 正文事故、v0.30.17 的反向验证空转都栽在这上面）。
10. **改完 `src/` 必须 `npm run build` 并提交 `lib/`** —— CI 的 `static` job 校验两者一致，它挂了其余三个 job 根本不跑。
11. **不要手改 `src/host/seed-*.ts` 里的生成常量** —— 由 `scripts/gen-*.mjs` 生成；改 `scripts/bundle/**` 源件后走再生成流水线（见 wiki 布局笔记 §4）。
12. **`package-lock.json` 必须与 `package.json` 同步** —— 用官方源重新生成（`npm install --package-lock-only --registry=https://registry.npmjs.org`）后 `npm ci --dry-run` 自检；lock 脏会让 `npm ci` 秒红、连带三个 job 不跑。

## 4. 发布流程（★ 功能开发完成 = 收尾发布，别停在「代码改完」）

1. **跑校验**：`npm run typecheck`；改核心路径跑 `npm run selftest`；改 bundle 跑对应 `verify-*.mjs`；最终 `npm run build`（`lib/` 必须提交）。
2. **更新文档**（v0.27.1 起 README 只是**入口页**，不再是全集；v0.28.11 起 README 连版本记录也不放）：能力清单改 `docs/features.md`、使用指南与配置改 `docs/usage.md`、开发发布流程改 `docs/development.md`；**变更历史在 `docs/CHANGELOG.md` 顶部新增** `- **vX.Y.Z**（日期）：…`（`verify-version-consistency` 只认 CHANGELOG 顶部第一条，并反向断言 README 里没有逐版本条目）。改完跑 `npm run verify:static`——其中的 `scripts/verify-doc-links.mjs`（v0.27.3 新增）会挡住指向不存在文件的相对链接：**在 `docs/` 内部写链接要用相对 `docs/` 自身的路径**，写 `docs/xxx.md` 必红（v0.27.1 拆文档时正是断在这 6 处）。
3. **bump 版本**：`package.json` `version`（bundle 行为有变也同步 bump）。
4. **同步本文件 §2 速查表** + 相关规则（§7）。
5. **提交推送**：`git add -A && git commit -m "..."` → `git push origin main`。
6. **打 tag 并推送**：`git tag vX.Y.Z && git push origin vX.Y.Z`。
7. **发布 npm**（账号 `ok1989223`）。⚠️ 本机默认 registry 是 `registry.npmmirror.com`（只读镜像），必须显式 `npm publish --registry=https://registry.npmjs.org`；发布后有传播延迟（`npm view` 走镜像会一直显示旧版本，`dist-tags` 可能先更新而版本文档还 404 —— 都不代表失败，等 1–2 分钟再查）。
8. **同步线上 wiki**（如改了 bundle / 提示词）：覆盖对应 tiddler，并提示用户重载 TW 面板 / 重启 dsh web。

> 完整说明（含步骤 7 的两个假信号细节、步骤 9 的 wiki sync）见 wiki「发布流程与维护规则」。

## 5. 开发文档索引（细节都在 wiki 里，按需读）

> ⚠️ 这些是**权威细节来源**，本文件不重复。开工时按任务类型点开对应笔记即可，不必全读。

| 要查什么 | wiki 笔记 |
|---|---|
| **踩过的坑（踩前必读）** | [[dsh-tiddlywiki 开发·常见坑（踩过别重踩）]] |
| 架构事实：装配时机 / 工具写策略 / seed 机制 / 守卫 / 提示词注入 | [[dsh-tiddlywiki 开发·架构事实与约定]] |
| 文件布局 / 构建与校验命令清单 / **bundle 与 seed 再生成流水线** | [[dsh-tiddlywiki 开发·仓库布局 / 构建 / 校验]] |
| 每个版本的演进说明与「为什么是这样」 | [[dsh-tiddlywiki 开发·易变清单（全量）]] |
| 发布流程与 AGENTS.md 维护规则全文 | [[dsh-tiddlywiki 开发·发布流程与维护规则]] |

**注意**：wiki 里的开发文档**不进注入预算**，所以细节可以放心写全；但**改代码后要同步更新对应 wiki 笔记**（见 §7），别让指针指向过期内容。

## 6. 每次新会话开工

1. 读本文件（已自动注入）。
2. `tiddlywiki_git_sync action=pull` 拉 wiki（同步纪律见注入的系统提示词）。
3. 按任务类型查 §5 索引里的对应笔记——**改核心路径前至少读一遍「常见坑」**。

## 7. 本文件的维护规则

- **本文件只放规则与指针**：发现自己在往这里抄「为什么当年会出这个 bug」「某个函数怎么实现」时，停手——那属于 wiki。
- **触发更新**（都在同一 commit 里做）：
  | 代码变化 | 要改的地方 |
  |---|---|
  | 版本 / 发布 / tag | §2 版本行 + §4 |
  | 新增/改名/删除工具 | §2 工具行 + wiki 架构笔记的对应小节 |
  | 修改注入提示词 | §2 提示词行 + wiki 架构笔记 |
  | 新增/删除 seed、改 bundle 版本 | §2 两个对应行 + wiki 架构笔记 |
  | 新增/删除 DSH 路由 | §2 路由行 |
  | 新增/改名配置项 | §2 配置行 |
  | 新增踩坑教训 | **wiki「常见坑」笔记** + 对应守门脚本 |
  | 改构建/发布流程 | §3 / §4 + wiki 布局笔记 |
- **守门脚本是规则的执行者**：写规则时可以只写一句结论并注明「守门：`scripts/verify-xxx.mjs`」——细节与反向验证都在脚本里。

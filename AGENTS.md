# AGENTS.md — dsh-tiddlywiki 项目速览

> **本文件只放「必须无条件遵守的规则 + 速查指针」**。所有细节（架构事实、踩过的坑、仓库布局、构建清单、版本演进史、发布流程全文）都已拆到 **wiki 笔记 / 仓库 `docs/`** 里——见下面 §5 的「开发文档索引」。
>
> 为什么这么分：本文件会作为 workspace instructions 注入每个会话，预算是 **65536 字节**；过去它长到 ~120KB，**截断正好砍掉最后几节（发布流程 / 维护规则 / 常见坑）**，等于新会话默认看不到最容易踩雷的部分。现在拆完约 33KB，且 §5 的索引让 Agent 知道「要细节去读哪篇」。
>
> ⚠️ **这句话有守门**：`scripts/verify-agents-budget.mjs`（进 `verify:static`）会量实际字节数（软上限 48KB / 硬上限 65536）并核对上面这个自述值。**要往本文件加内容，先想清楚是不是该写进 wiki。**
>
> 权威来源：代码即事实。本文件与代码冲突时以代码为准，并顺手修正本文件。

## 1. 项目是什么

**dsh-tiddlywiki** —— 把 **TiddlyWiki 5** 变成 DSH 的持久知识库的官方插件（npm：`dsh-tiddlywiki`，GitHub：`bbqisbbq/dsh-tiddlywiki`，MIT）。

- **Agent 侧**：17 个 `tiddlywiki_*` 工具读写 wiki；插件向每个会话注入一段中文系统提示词（`systemPrompt.section`），约定同步纪律、标签规则、链接格式等。
- **人侧**：DSH 中央列内嵌完整 TW 5 编辑器（同源代理 `/dsh-tiddlywiki/tw/`）、右下角「知识库」FAB、TW 工具栏「发送给 Agent」按钮。
- **数据**：wiki 文件夹本身是 git 仓库（自动 commit 60s 防抖 + 手动同步）；回复流里 `tiddlywiki_*` 工具结果显示原生 TW 卡片。

## 2. 速查表（当前值）

> 只列「改了必须同步本表」的当前值。**逐版本的演进说明与原因在仓库 `docs/CHANGELOG.md`**（版本历史的唯一所在地，2026-09-29 起 README 不再放）。

| 项 | 当前值 | 位置 |
|---|---|---|
| **插件版本** | `0.35.0` | `package.json` `version`（三处一致性由 `scripts/verify-version-consistency.mjs` 守门：package.json / 本文件 / **`docs/CHANGELOG.md` 顶部第一条**。**README 里不再放版本记录**（作者 2026-09-29 要求：README 只放最新最重要的信息，历史单独一个文档）——脚本另有反向断言，防止 README 又慢慢长回一堆逐版本条目） |
| **DSH 基线（v0.35.0）** | `engines.dsh = ">=0.2.1-rc.3 <0.3.0"`；插件卡元数据 `locale/{zh,en}.json`（只放 `meta.title`/`description`）+ 包根 `icon.svg`（`exports["./icon"]`） | `package.json`。0.2.2 的 `dsh-app-boot` **真校验** `engines.dsh`（有它则 peer 被完全忽略 ⇒ **别再加 DSH peer**）；上界挡住未来破坏版，下限留在 0.2.1——新增挂点全是可选的。⚠️ 元数据两样**必须同时在 `exports` 开出来**才生效（宿主用 Node ESM 解析器读，没导出＝静默当"没有"）。守门 `verify-package-contents.mjs` |
| **Agent 工具集（17 个）** | `search` `get` `put` `batch_put` `append` `replace` `rename` `delete` `trash` `backlinks` `attach` `lint` `recent` `list_tags` `export` `git_sync` `git_resolve` | `src/host/tools.ts`（列表式注册；v0.28.8 起实现按模块族拆到 `tools-{support,read,notes,attach,git}.ts`，注册**顺序**由 `tools.ts` 的装配段逐行写死——它生成 `full` 提示词的参数索引，`verify-prompt.mjs` 按顺序断言）。客户端 `TOOL_VIEW_KEYS` 由 `scripts/verify-tool-views.mjs` 源码级守门——必须与注册表完全一致。**`git_sync` 作用于所有可同步的库**：按**仓库**去重（多库共用一个工作树只同步一次）、逐仓库独立成败、回执逐仓库标注库名/仓库/**远端及其来源**（凭据已剥）；「有远端」= 配了 `git.remote` **或**该库所在仓库自己的 `origin`（**v0.30.58** 起；此前只认配置字段，于是界面「同步」按钮能推、工具却回「没有任何知识库配置了 git.remote」——见 wiki「同步口径」），两者都没有的库被列在 `skipped` 里，可同步的库为 0 时 `ok:false`（守门 `scripts/verify-git-multi-sync.mjs`，进 `verify:unit`）。`git_resolve` 新增可选 `wiki`（库 id）用于多仓库下选对仓库。**v0.30.62 会话作用域修正**：`git_resolve`（不传 `wiki` 时的默认目标）与 `git_sync` 的排干目录都改从 `ToolScope.dir`（= 会话作用域那个库）读——此前走 `ToolsDeps.wikiPath()`（永远解析成**默认库**），于是作用域在别的库时「排干哨兵写进 A 库、却在 B 库目录里等文件」（必然 12s 超时 + 假 `drainFailed`），而 `git_resolve` 会在**错的仓库**里 checkout+commit（守门 `scripts/verify-git-multi-sync.mjs`，含「哨兵必须落在会话库目录」的行为用例）。`trash` 的两种格式现在**同时**列出/恢复（此前 trashbin 枚举成功就整段跳过内置索引 ⇒ 装了 trashbin 的库看不到内置条目，`list` 报 共 0 条；守门 `scripts/verify-trashbin-probe.mjs` 15 条，含「恢复不得把副本的溯源字段留在笔记上」）。并发令牌现覆盖 `put`/`delete`/`attach`/`append`/`rename`/`batch_put`（逐条目 `expectedModified`）；`tags: []` = 清空标签（不传 = 保留）；`fields` 必须是**对象**（v0.26.5：曾声明 `type:'json'` → 编译后无类型约束 → 模型发字符串被按字符拆成单字符字段；现 schema 为 `object` + 工具层 `normalizeFieldsArg()` 兜底）；**变更锁（v0.30.12）**：整插件**一把** `host/mutation-lock.ts`，`/restart` `/sync` `/admin/restart` `/admin/seeds/run`（会 drain+重启的那一段）全部走它，拿不到回 429 并报持有者，`end(label)` **校验持有者**（v0.33.4：此前无校验，`/admin/seeds/run` 每条响应都 end ⇒ 会释放 `/sync` 的锁）；由 `index.ts` 建唯一实例、同时注入 `RouteDeps.mutationLock` 与 `AdminDeps.mutationLock`（守门 `scripts/verify-mutation-lock.mjs`，进 `verify:unit`；此前 admin 侧**一把锁都没有**，可与 `/sync` 同时停子进程）。`append` 的 `heading` 落点是「该标题之后、**下一个任意级别标题之前**」（标题后紧跟子标题时落在两者之间＝章节开头，不是整节末尾），**未命中不再静默**——返回 `headingMatched=false` 且回执明说「未找到标题…已改为追加到文末」（v0.26.6：CRLF 正文曾让标题正则全数失配、静默落文末）。**写侧同样过 `isBlockedProxyTitle()`**（v0.33.4：put/batch_put/delete/rename/append/replace/attach 此前无守卫，模型可直接改写 `$:/plugins/dsh-tiddlywiki/config` ⇒ `git.remote` 下次同步生效）。**`search` 的 `query` 可省略**（v0.34.1，issue #1）：只传 tags/tag/since/type/field 就是「按条件列出」——此前这种调用会崩 `reading 'split'`，修掉崩溃后又被空 query 的短路判成 0 条，回执还把 `undefined` 回给宿主被 lossless-JSON 判 invalid；现在短路只在**没有任何其它过滤条件**时生效（守门 `verify-tools.mjs`） |
| **工具出口 schema（v0.31.0）** | 17 个工具各自声明 `output.schema`（`src/host/tool-output-schemas.ts`；**只声明必定存在且类型稳定**的字段，可空/可选交给 `additionalProperties: true`） | DSH 0.2.1+ 每次调用后跑 `validateJsonSchemaValue`，不过即抛 `ToolOutputError` ⇒ 写错＝线上工具直接坏（v0.35.0 复核：0.2.2 把派发管线搬进了 `dsh-tools/lib/pipeline.js`，**调用点与语义都没变，校验器 `json-schema.js` 两版字节相同**）；而 `sdk.ts` 的该字段自 v0.20.0 起写死 `{}`（注释称"没人读它"，**实测为假**）。守门 `verify-tools.mjs`：每个工具必须有非空 object schema + **用 E2E 真实返回值反查声明** |
| **宿主集成（v0.31.0）** | 拆库 skill 优先 `ctx.skills.register`（**内存**注册、随插件卸载消失、不碰用户目录），无该服务才回落写 `$DSH_HOME/skills`；新增 `/note <标题>\n<正文>` 命令（`ctx.commands.register`，写进会话知识库、**不产生模型消息**；同名笔记**已存在就拒绝**、**不打 `agent-written`**） | `src/host/skill-install.ts` · `src/host/command-note.ts`（守门 `verify-embedded-skill.mjs` / `verify-note-command.mjs`，含「先注册后回落」；宿主没有这些服务时静默跳过） |
| **Seed 注册表（10 项，三层）** | 核心（自动写、不可移除）：`send-to-agent`、`render-route`、`tw-web-host`；起步（默认写、可移除）：`doc-note`、`starter-docs`；可选（手动）：`home-index`、`all-articles`、`ui-styles`、`menubar-theme`、`clip-bridge` | `src/host/seeds-registry.ts` 的 `SEED_DEFS`（v0.30.27 起；`seeds.ts` 原样再导出）+ `src/host/seed-util.ts`。`seeds.ts` 只留**编排**（check/run/remove）|
| **bundle 版本** | send-to-agent `0.3.6` · render `0.2.0` | `scripts/bundle/versions.mjs`（唯一来源） |
| **注入提示词** | `prompt{enabled,mode,extra,override}`，默认 `slim`（v0.31.0 加「先查再答」「时效与去重」两块后 **1390 字符 / 预算 1470**，守门 `scripts/verify-prompt.mjs`）；`full` 的参数索引由 `tiddlywikiToolSummary()` 实时生成。**去重原则**：只留 schema 表达不了的约定（同步时机 / 被拒后重读而不用 force / 时效标注 / 淘汰权归人 / `human-edited` / 链接格式 / todo）；与工具 description 重复的（并发令牌、工作区标记、先窄后宽、多词 AND、tags·type 保留、自动 commit 间隔）**只留 schema 一份**，`verify-prompt.mjs` 会在 **schema 侧**逐条断言"从提示词删 ≠ 丢了"（两处一起删立刻红）。**多库时正文会自动换成带库 id 的链接格式**（v0.30.62：裸 `/tw/#标题` 在助手正文里跟随**焦点库**、写进笔记则把中央 TW 的 iframe 导航到**默认库**——`promptTextFor()` 把作用域的 `/tw/<id>/` 传进正文并明说要写那个 id）；intro 里**不许**再手写工具类别清单，也不许再写「本机有一个知识库」（多库下是错的） | `src/host/prompt.ts` |
| **工作区标记** | 新建笔记自动带 `ws/<项目名>` 标签 + `workspace` 字段（取自会话 cwd，`note.workspaceMark` 可关）；检索先在工作区内查、0 条才扩全库；`query` 多词 **AND** | `src/host/workspace.ts` + `src/host/tools.ts`（守门 `verify-workspace.mjs` / `verify-tools.mjs`） |
| **配置项** | `wikiRoot`/`wiki`（**只是默认值**，运行中以指针文件优先）/`port`/`git{autoCommit,debounceMs,remote,branch}`/`note{tag,workspaceMark}`/`startup{readyTimeoutMs}`/`prompt{…}`/`bridge{enabled,port,token,tag,wiki}`/`ui{…}`/`uiLanguage`/`auth{username,password}` | `src/host/config.ts`。`git.autoCommit/debounceMs/remote` 保存后**即时生效**（`reapplyGitConfig` 重建 committer）；`/admin/config` 的补丁必须先过 `normalizeConfigPatch()`（数值夹取 / 类型错误 400 / `__proto__` 等拒绝 / 未知键透传，守门 `scripts/verify-config-patch.mjs`）；**数值区间三处同源**（宿主夹取表 / 设置页表单的 min·max / 表单在未配置时的默认回显），由 `scripts/verify-config-ranges.mjs` 逐字段**比对数字**（v0.30.16）。**只在单库模式露出的字段**：`ui.sidebarLabel`（多库下每库各用自己的 label，露出来就是"改了不生效"，守门 `verify-wiki-focus.mjs`；模式探测失败按单库渲染）。`bridge.wiki`（v0.28.8）= 剪藏写进哪个库，空 = 默认库——剪藏来自书签、没有"当前会话"可跟随，所以只能显式钉死；`clipTarget()` **已登记但没在跑**的目标库 ⇒ **503 并点名**（v0.30.62，与 `?wiki=` 路由同口径：此前静默回落默认库，而书签根本不看回执里的 `wiki`，用户以为剪进了目标库）；**未知 id** ⇒ 记一次日志并回落默认库（老书签不能 404）；空 = 默认库。`/clip` 回执带实际 `wiki` 字段，成功提示也会显示它（v0.30.62）。⚠️ 这一组是**插件级**设置（一个监听端口、一个写入目标），读取它的是**默认库**那份 config ⇒ 设置页只在「未选中具体库」的作用域里露出它（否则改了静默无效）。守门 `scripts/verify-clip-target.mjs`（新建：运行中/未运行/未知 id/清单未就绪 + 端到端 503 文案）与 `scripts/verify-clip-bridge.mjs`。⚠️ v0.28.8–v0.29.0 期间这条设置**实际无效**：`WikiInstance.bridgeConfig()` 是手写对象字面量，重建时丢掉了 `wiki` 键，从未传进 `clipTarget()`（v0.30.0 修），且剪藏桥现在拒绝 `$:/` 系统命名空间标题（否则任意网页可 PUT `$:/plugins/dsh-tiddlywiki/config`）。**姿态（作者 2026-09-29 裁定）：桥不做认证、对任意页面开放 —— 「任意页面能给你的 wiki 建笔记」是许可的，不允许的只有覆盖系统项**；`bridge.token` 只是可选的额外收紧，不是设计前提 |
| **DSH 路由** | `/status`（带 `mode`/`defaultId`/`wikis[]` 名册）`/note` `/edit` `/tags` `/recent` `/get` `/search` `/render` `/sync` `/upload` `/restart` `/session/summary` `/session/wiki`（会话级知识库作用域，GET/POST 同路径；v0.29.0 起回 `mode`）`/agent/{sessions,modes,send,create}` `/api/*` `/tw/*`（**`/tw/<id>/…` 按库定向**；裸 `/tw/` = 默认库别名）；admin：`/admin/{state,prompt,info,config,restart,seeds,seeds/run,seeds/remove}` + `/admin/wiki/{location,switch,reset}` + `/admin/wikis`（列表读写：add/update/remove/set-default/set-mode + 运行态 start/stop） | `src/host/routes.ts` + `src/host/admin.ts`。非代理路由都吃 `?wiki=<id>`；**三种语义（v0.29.0 定稿，只有一份实现 `wiki-farm.ts`）**：命名的库在跑 → 就是它；**已登记但没在跑 → 503 并点名那个库**（`stoppedWikiFromRequest()` / `stoppedWikiMessage()`，路由侧先查 `deps.targetProblem` —— 否则设置页写着「正在配置 X」却改默认库，`/admin/info`/`/status`/`/sync`/`/restart`/快速笔记全都中招）；**未知 id → 回落默认库**（老书签不能 404）。守门 `scripts/verify-wiki-farm-boot.mjs`（行为级：503 + 点名 + 未知 id 仍回落） |
| **客户端 Slot** | `settings.section`(50) · `conversation.input.dock`(`quick-note`,8；**只有快速笔记**。v0.31.0 起选库**不再**内联在这里——它搬去了官方座位 `conversation.input.left`) · `conversation.input.left`(id 为 `wiki-scope`、order 9，v0.31.0：会话知识库选择器的**家**。它此前挂在 `conversation.input.selector.context`——而那个座位在 **DSH 0.2.1（0.2.2 也一样）里根本不存在**，于是 v0.28.8 起的 `scope-seat.ts` 整个是死代码（永不渲染、也永不报错）⇒ 已删除；`wiki-scope-dock.ts` 不再吃 `scope` 参数、也不再自测宽度，守门 `verify-wiki-focus.mjs` 反向断言这些死名字不会再回来。**别再往 `conversation.input.selector.context` 上挂东西**：0.2.1 无此座位) · `conversation.view`(`dsh-tiddlywiki-summary`,20) · `sidebar.right.pane.tab`(keyed `dsh-tiddlywiki`) · `tool.call.toolview`(17 个工具 key) · **`ctx.documentPreviews.register`（`.tid`/`.tiddler`，id `dsh-tiddlywiki-tid`，`priority: external` / `title` 传函数 / `wrap: false`）+ 正文进 keyed Session 子槽 `sidebar.right.tab.document`**（v0.33.1 修正：正文**按 `key:` 注册**，写成 `id:` 会静默退化成内置纯文本；两者用同一个 id 常量配对。正文 props `{ content: { kind: text, pages } }`，每页 `{ offset, lines, text }`；v0.33.3 起摘要只单列 title/tags/时间（`summarizeTid`），机械字段折进一行小字，实现名改成「真 TiddlyWiki 渲染」以便在宿主的实现选择菜单里一眼认出；契约全文见 wiki 事实总表「v0.31.0 → v0.33.x 落地与新增坑」） | `src/client/index.ts` 等。选择器在可见库 ≤1 时返回 null 不渲染。**回复流里的 TW 链接打开哪个库**（v0.28.11）：链接自带 `/tw/<id>/` 就用它；裸 `/tw/#标题` 取所在卡片 / 会话汇总面板上的 `data-dsh-tw-wiki`；都没有（助手正文里的链接）才跟随焦点库。`panel.ts` 拿到 `wiki` 会先 `setFocusWiki()` 再路由（此前整个丢掉 → 点「在 TW 打开」跳到最后打开的那个库），内核 `tw-frame.ts` 的 `wikiSwitchPending` 保证先换库、再把 hash 落到新文档。守门：`verify-wiki-focus.mjs`（源码级）+ `verify-frame-surface.mjs`（行为级）。**「默认库」不作为名字出现在界面上**（v0.28.12，作者要求）：被设为默认的那个库一律用自己的显示名 + 「（默认）」身份标记——会话选择器（读 `/session/wiki` 的 `resolved{id,label}`，新会话打开即选中它，选中它 = 发 null 清空显式作用域）、快速笔记「写入」目标、设置页剪藏目标（空值那一项代表它，且该库不再单独列一遍）、`单库（只跑 X）` 与切单库确认文案；`verify-wiki-focus.mjs` 会**剥掉注释**后断言这四个模块的代码里没有「默认库」字样。**左侧多库入口的点击语义**（v0.28.13）：点**另一个**库 = 切换（面板保持打开），点**当前显示的那个**库才收起——判定收在 `sidebar-entry.ts` 的 `resolveEntryClick()`/`applyEntryClick()`（纯函数 + 真 `PanelState`，行为级守门），且**必须在 `setFocusWiki()` 之前**求值；行高亮与点击判定同源（都用 `shownWiki()`），入口行里**不许再出现 `toggle()`**。**切库的延迟**（v0.28.14）：焦点一变就**同步**把 iframe 指到新库（`switchFrameNow()` 复用上一次 `/status` 的 payload），**不许等 `/status` 往返**（host 每次要跑最多 5 个 git 进程，实测 300–400ms）——那次往返曾是"点下去先空一下"的第一段；侧边栏焦点变化只重画高亮（`paintFocus`，不再重跑名册）；换文档期间挂一条 `.dsh-tw-loading` 提示（整份 wiki 是 10–30MB 且 TW 回 `no-store`，缓存不了，那 1–2 秒必须给可见说明），`load` 到达或 15s 兜底收起。守门 `verify-frame-surface.mjs`（行为级：让 `/status` 永不返回也必须换）+ `verify-wiki-focus.mjs`。**v0.35.0 新增两个 0.2.2 挂点（均可选降级）**：① `settings.section.icon`（与 `settings.section` **同 id**、共用 `SETTINGS_SECTION_ID`；不传 `label`，卸载即回落齿轮）；② **会话右键「绑定本会话知识库」**（`ctx.get('contextMenus')` 注册 `target:'session'` provider；`resolve` **必须同步**——宿主 1s 竞速预算；可见库 ≤1 返回 `[]`；切库复用 `session-wiki.ts` 那一份实现。⚠️ `contextMenus` **不许进 `dsh.client.inject`**、也不许占 `contextMenu.content` 的 `'session'` key（shadows-shipped-ui）。守门 `verify-context-menu.mjs`） |
| **客户端 i18n（v0.30.6）** | 两个语言：`zh`（默认）/`en`。**唯一入口** `src/client/i18n.ts` 的 `t(key, vars?)`（`{name}` 插值）；**目录按区域分片**：`i18n-{chrome,note,card,settings,config,plugins,frame}.ts`，每个分片导出 `{zh, en}` 且**键集合必须一致**，键名 = `<区域>.<东西>`。语言来源：**插件配置 `uiLanguage`**（与 TW 子进程同一个设置）→ host 在 `/status` 回 `lang` → `status-cache.ts` 的 `fetchStatus()` 调 `setLang()`；客户端另在 `localStorage` 缓存一份，**刷新后首屏即为该语言**（改语言后其余界面下次刷新生效，设置页会说明）。守门 `scripts/verify-client-i18n.mjs`（进 `verify:unit`）：① 每个分片 zh/en 键集合一致；② 每个 `t('…')` 的键都存在；③ 没有从未使用的键；④ **客户端字符串字面量里不得残留中文**，除非是 `t()` 的第一个参数或在脚本内 ALLOWLIST 里（每条都写明"这是与 host 中文回执匹配的协议，不是文案"）。新增文案一律走 `t()`，别直接写中文。**尚未转换的文件**列在守门脚本的 `PENDING_CONVERSION` 里（v0.33.1 实况：**283 → 475 键 / 7 个分片**，`PENDING_CONVERSION` 已**清空** —— `src/client/` 下不再有未转换的用户可见中文；本轮转掉的是工具卡 `tool-views.ts`（同时拆成模块族）、设置页的插件/主题/语言/初始化 `settings-page-catalog.ts` 与常规配置 `settings-page-config.ts`），该清单**只减不增**且自清洁：某个文件转完后没从清单删掉，守门会红并点名它 | `src/client/i18n.ts` + `i18n-*.ts` || **模块拆分与守门读法** | 守门按**模块族**读源码：`scripts/lib/source-family.mjs` 的 `readFamily(repoRoot, '<relBase>')` 把 `<base>.ts` + `<base>-*.ts` 拼成一份文本 ⇒ **新增拆分文件必须用 `<base>-xxx.ts` 命名**，否则守门读不到、断言静默失效；纯搬迁时不要动 `scripts/`。**逐轮拆分史（v0.28.8 / v0.30.x）在 `docs/CHANGELOG.md`**，这里只留仍然承重的约束 | ① `index.ts` 的装配顺序**不能重排**（farm → 锁 → 路由 → 工具）；② `note-widget.ts` 里 `const mark = …note.defaultMark…` 那一行**必须留在卡片里**（`verify-wiki-focus.mjs` 按精确路径读该文件）；③ `verify-frame-guards` 按**函数名**钉着 `resetForNewNote` / `flushDraft` 两段函数体（族读仍命中，改名才红）。⚠️ **"还有哪些文件要拆"的清单不可信** —— 动手前自己数行数 |

## 3. 铁律（不可协商）

1. **重启/停止 TW 前必须把 syncer 队列排干** —— **只能经 `drainThenStop()`**（`src/host/seeds.ts`，v0.24.1）：排干（`flushPendingWrites` 两段式哨兵 + throttle 窗口）就发生在它内部，裸调 `server.restart()` / `server.stop()` 等于丢写入。**所有**路径（启动自举 / seed / `/sync` / `/restart` / 知识库切换）都必须走它；启动自举（v0.29.0 起）与 `start()` 的卸载中止一律调 `instance.restart()` / `drainStop()`，**全文件不得再有裸 `this.server.restart()/stop()`**（唯一例外 `dispose()`，它按设计不排干）。守门 `scripts/verify-restart-drain.mjs`（源码级：**枚举全部调用点**并逐个断言落在 `drainThenStop` 的 stop 回调里——旧版用 `indexOf` 只看第一处，漏掉了自举路径上两处裸 restart + 行为级：stop 必须在排干之后、排干失败也必须继续 stop）。
2. **所有写路径必须「先读旧条目、再走共享写策略」** —— `get` → `buildWriteTiddler()`。TW REST 的 PUT 是**整体替换**，手拼 body 会丢 tags / 自定义字段 / `type` / 时间戳。同名且非新建、无 `force` 时**宁可报错也不静默覆盖**。**例外只有两类**（v0.30.31 逐调用点核实，清单与理由在 `write-policy.ts` 模块头）：① **我们完全拥有内容**的条目（seed marker / `$:/temp` 会话汇总 / 剪藏写入 / seed 的内置内容）—— 读一遍没有信息量，内容由我们现算；② **flush 探针**（它的用途就是给一次写入计时，读-改-写会引入额外往返、改变时序语义）。⚠️ `const { tiddler } = buildWriteTiddler(…)` 之后再 `client.put(tiddler)` **就是本策略本身**、不是绕过 —— 第二轮审计把它算成「21 个文件绕过共享写策略」，**那个数字大半是假的**。判据是**这次 PUT 的 body 是不是基于某条已存在的用户条目改写的**，不是文件名或行数。 守门：`scripts/verify-write-call-sites.mjs`（进 `verify:unit`）—— 它只钉**手拼 body**（`client.put({`）这一种形态，并要求每个这样的文件都在**自清洁**的例外清单里、每项写明 `why`。
3. **绝不把「读取失败」当「条目不存在」** —— `wiki.get()` 只有 404 返回 `undefined`，其余抛错。禁止 `.catch(() => undefined)` 兜底（那会让 seed 覆盖用户内容、给人类笔记误打 `agent-written`）。
4. **每个写路由必须显式声明 HTTP 方法** —— 宿主 webserver 只按 pathname 分发。写用 `rejectCrossSiteWrite(req,res,['POST'])`，读用 `rejectNonRead`。
5. **每个路由 handler 必须包 `guardHandler()`** —— 未捕获的 rejection 既不回包也不回收连接 = 永久挂起的请求。
6. **所有「把调用方标题变成 TW 输出」的路径必须过 `isBlockedProxyTitle()`** —— `/get`、`/tw`、`/api`、`/render` **以及 agent 工具 `tiddlywiki_get`**（v0.30.0：工具曾是唯一漏网的一条，模型能原样读出 `$:/plugins/dsh-tiddlywiki/config` 里的密钥）都要；`/render` 的 `text` 分支还要过 `referencesBlockedTitle()`（`{{…}}` 转写能绕过 title 检查）。原语现在住在 `src/host/proxy-guard.ts`（工具层不该为安全原语 import 路由模块），`routes-tw-proxy.ts` 原样再导出。
7. **Host 侧注入浏览器的 TW 片段必须净化** —— 一律走 `POST /dsh-tiddlywiki/render`（`sanitize.ts`），客户端不直连 TW，因为注入点是 DSH 同源页面的 `dangerouslySetInnerHTML`。
8. **`lib/` 必须零 `@deepseek-ai` 运行时 import** —— `sdk.ts` 自实现 `defineTool`；否则 npm 镜像的 dsh-tools 会遮蔽 CLI 内置实现、搞坏 agent 循环。
9. **client 必须 minify**（否则 >1MB 被插件注册表校验拒绝）；**行尾必须 LF**（`.gitattributes`；`lib/index.js.map` 内嵌源文，CRLF 会让 CI 的 `git diff --exit-code -- lib/` 必失败）。守门 `scripts/verify-line-endings.mjs`（进 `verify:static`）：扫 `src/` `scripts/` `tools/` `docs/` `lib/` + 根目录全部文本文件，**工作区里任何 CRLF 直接红** —— `.gitattributes` 会把 CRLF 归一成 LF，所以 `git status`/`git diff` **看不见**这个状态，而它会让「用 PowerShell 做批量改写/反向验证注入」变成**静默空操作**、让 `/^…$/m` 锚点带上尾部 `\r`（v0.26.6 的 CRLF 正文事故、v0.30.17 的反向验证空转都栽在这上面）。
10. **改完 `src/` 必须 `npm run build` 并提交 `lib/`** —— 这条以前**只由 CI** 的 `static` job 保护（本地 `npm run verify` 四档都不查它，是全仓库唯一「本地全绿、CI 才红」的类别）。现在本地也有守门：`npm run verify:sync`（`scripts/verify-lib-sync.mjs`）——重建 `lib/` 后要求 `git status --porcelain -- lib/` 为空（构建逐字节可复现，所以判据可以这么硬），并顺带把 CI 那条 `@deepseek-ai` 检查（铁律 #8）搬到本地。⚠️ 它**故意不在 `verify`/`verify:static` 里**：那两处必须只读，而本守门是唯一会**写 `lib/`** 的守门 ⇒ **准备提交时跑它**。
11. **不要手改 `src/host/seed-*.ts` 里的生成常量** —— 由 `scripts/gen-*.mjs` 生成；改 `scripts/bundle/**` 源件后走再生成流水线（见 wiki 布局笔记 §4）。
12. **`package-lock.json` 必须与 `package.json` 同步** —— 用官方源重新生成（`npm install --package-lock-only --registry=https://registry.npmjs.org`）后 `npm ci --dry-run` 自检；lock 脏会让 `npm ci` 秒红、连带三个 job 不跑。**本地守门（v0.30.54）：`scripts/verify-lock-sync.mjs`（进 `verify:static` 第一步，零网络零副作用）** —— 版本三处一致（`package.json` / lock 顶层 / `packages[""].version`，**发版时三处一起改**）、`lockfileVersion >= 2`、四个依赖字段的集合与**范围**双向一致、每个依赖有实体条目且 **locked 版本满足声明的 range**（semver 判定）。它拦的是「改了 `package.json` 忘了重生成 lock」这类事故；**真正的全量可解析性仍只有 `npm ci` 能验**（需要网络，交给 CI）。

## 4. 发布流程（★ 功能开发完成 = 收尾发布，别停在「代码改完」）

1. **跑校验**：**`npm run verify` 现在等于 CI**（v0.30.53 起：`typecheck` + `build` + 四个 verify 档 + `selftest` + `smoke:client`，8 步）。改 bundle 再跑对应 `verify-*.mjs`；提交前跑 **`npm run verify:all`**（= `verify:sync` + `verify`）—— 那是「完整跑一遍」的唯一入口。**`lib/` 必须提交**。
   ⚠️ 两者的一致性由 `scripts/verify-ci-parity.mjs`（进 `verify:static`）守：**CI 里出现的每个 npm script 都必须能从本地到达**，例外表当前为空。改 CI 或改 `verify` 链条之前先读它的模块头。
2. **更新文档**（v0.27.1 起 README 只是**入口页**，不再是全集；v0.28.11 起 README 连版本记录也不放）：能力清单改 `docs/features.md`、使用指南与配置改 `docs/usage.md`、开发发布流程改 `docs/development.md`；**变更历史在 `docs/CHANGELOG.md` 顶部新增** `- **vX.Y.Z**（日期）：…`（v0.33.4 起该文件保持「最近 8 条详细 + 一句话历史表」，292 KB → 32 KB；超 8 条就把最老一条压成表格一行）（`verify-version-consistency` 只认 CHANGELOG 顶部第一条，并反向断言 README 里没有逐版本条目）。改完跑 `npm run verify:static`——其中的 `scripts/verify-doc-links.mjs`（v0.27.3 新增）会挡住指向不存在文件的相对链接：**在 `docs/` 内部写链接要用相对 `docs/` 自身的路径**，写 `docs/xxx.md` 必红（v0.27.1 拆文档时正是断在这 6 处）。
3. **bump 版本**：`package.json` `version`（bundle 行为有变也同步 bump）。
4. **同步本文件 §2 速查表** + 相关规则（§7）。**提交前跑 `npm run verify:sync`**（铁律 #10 的本地守门；它是唯一会写 `lib/` 的守门，所以不在 `verify` 里）。
5. **提交推送**：`git add -A && git commit -m "..."` → `git push origin main`。
6. **打 tag 并推送**：`git tag vX.Y.Z && git push origin vX.Y.Z`。
7. **发布 npm**（账号 `ok1989223`）。⚠️ 本机默认 registry 是 `registry.npmmirror.com`（只读镜像），必须显式 `npm publish --registry=https://registry.npmjs.org`；发布后有传播延迟（`npm view` 走镜像会一直显示旧版本，`dist-tags` 可能先更新而版本文档还 404 —— 都不代表失败，等 1–2 分钟再查）。
8. **同步线上 wiki**（如改了 bundle / 提示词）：覆盖对应 tiddler，并提示用户重载 TW 面板 / 重启 dsh web。

> 完整说明（含步骤 7 的两个假信号细节、步骤 9 的 wiki sync）见仓库 `docs/development.md`。

## 5. 开发文档索引（细节都在 wiki 里，按需读）

> ⚠️ 这些是**权威细节来源**，本文件不重复。开工时按任务类型点开对应笔记即可，不必全读。
>
> **2026-10-04 那次整理**把 32 篇开发笔记压缩成了下面这张事实总表（旧的「常见坑」「架构事实与约定」「仓库布局 / 构建 / 校验」「易变清单（全量）」「发布流程与维护规则」五篇**已合并进它并删除**，别再按旧名去搜）。

| 要查什么 | wiki 笔记 / 权威来源 |
|---|---|
| **插件事实总表**：架构与数据模型 / 工具与 API 契约 / 路由 / 客户端与配置 / 环境与路径 / 版本与兼容 / 构建与校验流水线 / **坑与解法** / 未决 | [[dsh-tiddlywiki 事实总表（架构·约定·坑·审计）]] |
| **TW 侧使用与技巧**：剪藏桥 / 批注的手工装配 / 官方插件 / 界面调整 / Obsidian 迁移 / 自动打标签 | [[TiddlyWiki 使用与技巧事实总表]] |
| 拆库后的三库拓扑、以及「哪些系统条目没跟过来」 | [[拆库丢失的系统条目清单（外观_偏好类，2026-09-29）]] |
| 每个版本的演进说明与「为什么是这样」 | 仓库 `docs/CHANGELOG.md`（**版本历史的唯一所在地**，2026-09-29 起 README 不再放） |
| 发布流程全文 / bundle 与 seed 再生成流水线 | 本文件 §3 §4 + 仓库 `docs/development.md` |

**注意**：wiki 里的开发文档**不进注入预算**，所以细节可以放心写全；但**改代码后要同步更新对应 wiki 笔记**（见 §7），别让指针指向过期内容。**上面这些 `[[…]]` 指针有守门**（`scripts/verify-wiki-pointers.mjs`，进 `verify:sync`）：指向不存在的笔记会当场红——2026-10-04 收拾完笔记后，这个守门红过一次（见 §4 步骤 5 之前要先跑 `verify:all`）。

## 6. 每次新会话开工

1. 读本文件（已自动注入）。
2. `tiddlywiki_git_sync action=pull` 拉 wiki（同步纪律见注入的系统提示词）。
3. 按任务类型查 §5 索引里的对应笔记——**改核心路径前至少读一遍《dsh-tiddlywiki 事实总表》的「坑与解法」表**。

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
  | 新增踩坑教训 | **《dsh-tiddlywiki 事实总表》（§5 索引）的「坑与解法」表** + 对应守门脚本 |
  | 改构建/发布流程 | §3 / §4 + wiki 布局笔记 |
- **守门脚本是规则的执行者**：写规则时可以只写一句结论并注明「守门：`scripts/verify-xxx.mjs`」——细节与反向验证都在脚本里。

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
| **插件版本** | `0.26.3` | `package.json` `version`（三处一致性由 `scripts/verify-version-consistency.mjs` 守门：package.json / 本文件 / README「版本记录」顶部） |
| **Agent 工具集（15 个）** | `search` `get` `put` `batch_put` `append` `rename` `delete` `trash` `backlinks` `attach` `lint` `recent` `list_tags` `git_sync` `git_resolve` | `src/host/tools.ts`（列表式注册；客户端 `TOOL_VIEW_KEYS` 由 `scripts/verify-tool-views.mjs` 源码级守门——必须与注册表完全一致）。并发令牌现覆盖 `put`/`delete`/`attach`/`append`/`rename`/`batch_put`（逐条目 `expectedModified`）；`tags: []` = 清空标签（不传 = 保留） |
| **Seed 注册表（13 项，三层）** | 核心（自动写、不可移除）：`send-to-agent`、`render-route`、`tw-web-host`；起步（默认写、可移除）：`doc-note`、`starter-docs` + **gated 3 项**（`publish-spec`/`wechat-setup`/`wechat-publish`，仅 `wechat.enabled` 开启时写）；可选（手动）：`home-index`、`all-articles`、`ui-styles`、`menubar-theme`、`clip-bridge` | `src/host/seeds.ts` 的 `SEED_DEFS` + `src/host/seed-util.ts` |
| **bundle 版本** | send-to-agent `0.3.5` · render `0.2.0` · wechat-publish `0.2.0` | `scripts/bundle/versions.mjs`（唯一来源） |
| **注入提示词** | `prompt{enabled,mode,extra,override}`，默认 `slim`（v0.24.0 起 1918 字符 / 预算 2100，守门 `scripts/verify-prompt.mjs`）；`full` 的参数索引由 `tiddlywikiToolSummary()` 实时生成 | `src/host/prompt.ts` |
| **工作区标记** | 新建笔记自动带 `ws/<项目名>` 标签 + `workspace` 字段（取自会话 cwd，`note.workspaceMark` 可关）；检索先在工作区内查、0 条才扩全库；`query` 多词 **AND** | `src/host/workspace.ts` + `src/host/tools.ts`（守门 `verify-workspace.mjs` / `verify-tools.mjs`） |
| **配置项** | `wikiRoot`/`wiki`（**只是默认值**，运行中以指针文件优先）/`port`/`git{autoCommit,debounceMs,remote,branch}`/`note{tag,workspaceMark}`/`startup{readyTimeoutMs}`/`prompt{…}`/`bridge{enabled,port,token,tag}`/`wechat{enabled,command,token,adapter,dsn}`/`ui{…}`/`uiLanguage`/`auth{username,password}` | `src/host/config.ts`。`git.autoCommit/debounceMs/remote` 保存后**即时生效**（`reapplyGitConfig` 重建 committer）；`/admin/config` 的补丁必须先过 `normalizeConfigPatch()`（数值夹取 / 类型错误 400 / `__proto__` 等拒绝 / 未知键透传，守门 `scripts/verify-config-patch.mjs`） |
| **DSH 路由** | `/status` `/note` `/edit` `/tags` `/recent` `/get` `/search` `/render` `/sync` `/upload` `/restart` `/session/summary` `/agent/{sessions,modes,send,create}` `/wechat/{ready,publish,publish/status}` `/api/*` `/tw/*`；admin：`/admin/{state,prompt,info,config,restart,seeds,seeds/run,seeds/remove}` + `/admin/wiki/{location,switch,reset}` | `src/host/routes.ts` + `src/host/admin.ts` |
| **客户端 Slot** | `settings.section`(50) · `conversation.input.dock`(`quick-note`,8) · `conversation.view`(`dsh-tiddlywiki-summary`,20) · `sidebar.right.pane.tab`(keyed `dsh-tiddlywiki`) · `tool.call.toolview`(15 个工具 key) | `src/client/index.ts` 等 |

## 3. 铁律（不可协商）

1. **重启/停止 TW 前必须把 syncer 队列排干** —— **只能经 `drainThenStop()`**（`src/host/seeds.ts`，v0.24.1）：排干（`flushPendingWrites` 两段式哨兵 + throttle 窗口）就发生在它内部，裸调 `server.restart()` / `server.stop()` 等于丢写入。**所有**路径（启动自举 / seed / `/sync` / `/restart` / 知识库切换）都必须走它；守门 `scripts/verify-restart-drain.mjs`（源码级：routes/admin 里每个 restart 都必须包在 `drainThenStop` 内 + 行为级：stop 必须在排干之后、排干失败也必须继续 stop）。
2. **所有写路径必须「先读旧条目、再走共享写策略」** —— `get` → `buildWriteTiddler()`。TW REST 的 PUT 是**整体替换**，手拼 body 会丢 tags / 自定义字段 / `type` / 时间戳。同名且非新建、无 `force` 时**宁可报错也不静默覆盖**。
3. **绝不把「读取失败」当「条目不存在」** —— `wiki.get()` 只有 404 返回 `undefined`，其余抛错。禁止 `.catch(() => undefined)` 兜底（那会让 seed 覆盖用户内容、给人类笔记误打 `agent-written`）。
4. **每个写路由必须显式声明 HTTP 方法** —— 宿主 webserver 只按 pathname 分发。写用 `rejectCrossSiteWrite(req,res,['POST'])`，读用 `rejectNonRead`。
5. **每个路由 handler 必须包 `guardHandler()`** —— 未捕获的 rejection 既不回包也不回收连接 = 永久挂起的请求。
6. **所有「把调用方标题变成 TW 输出」的路径必须过 `isBlockedProxyTitle()`** —— `/get`、`/tw`、`/api`、`/render` 都要；`/render` 的 `text` 分支还要过 `referencesBlockedTitle()`（`{{…}}` 转写能绕过 title 检查）。
7. **Host 侧注入浏览器的 TW 片段必须净化** —— 一律走 `POST /dsh-tiddlywiki/render`（`sanitize.ts`），客户端不直连 TW，因为注入点是 DSH 同源页面的 `dangerouslySetInnerHTML`。
8. **`lib/` 必须零 `@deepseek-ai` 运行时 import** —— `sdk.ts` 自实现 `defineTool`；否则 npm 镜像的 dsh-tools 会遮蔽 CLI 内置实现、搞坏 agent 循环。
9. **client 必须 minify**（否则 >1MB 被插件注册表校验拒绝）；**行尾必须 LF**（`.gitattributes`；`lib/index.js.map` 内嵌源文，CRLF 会让 CI 的 `git diff --exit-code -- lib/` 必失败）。
10. **改完 `src/` 必须 `npm run build` 并提交 `lib/`** —— CI 的 `static` job 校验两者一致，它挂了其余三个 job 根本不跑。
11. **不要手改 `src/host/seed-*.ts` 里的生成常量** —— 由 `scripts/gen-*.mjs` 生成；改 `scripts/bundle/**` 源件后走再生成流水线（见 wiki 布局笔记 §4）。
12. **`package-lock.json` 必须与 `package.json` 同步** —— 用官方源重新生成（`npm install --package-lock-only --registry=https://registry.npmjs.org`）后 `npm ci --dry-run` 自检；lock 脏会让 `npm ci` 秒红、连带三个 job 不跑。

## 4. 发布流程（★ 功能开发完成 = 收尾发布，别停在「代码改完」）

1. **跑校验**：`npm run typecheck`；改核心路径跑 `npm run selftest`；改 bundle 跑对应 `verify-*.mjs`；最终 `npm run build`（`lib/` 必须提交）。
2. **更新 README.md**：特性一览补/改对应行；使用指南相关小节更新；「版本记录」**顶部新增** `- **vX.Y.Z**（日期）：…`。
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

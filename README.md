# dsh-tiddlywiki

> TiddlyWiki 5 as the DSH **persistent knowledge base** — a shared long-term memory for AI and human: the agent reads/writes tiddlers through `tiddlywiki_*` tools, you edit in a full TiddlyWiki editor or jot notes in a floating widget, and everything syncs/backs up through **git**.

[![npm](https://img.shields.io/npm/v/dsh-tiddlywiki)](https://www.npmjs.com/package/dsh-tiddlywiki)
[![license](https://img.shields.io/npm/l/dsh-tiddlywiki)](https://github.com/bbqisbbq/dsh-tiddlywiki/blob/main/LICENSE)
[![GitHub](https://img.shields.io/github/stars/bbqisbbq/dsh-tiddlywiki)](https://github.com/bbqisbbq/dsh-tiddlywiki)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

> 📚 **文档索引**：[🧩 初始化（一次性预置）](#🧩-初始化一次性预置) · [docs/seed-initialization.md](docs/seed-initialization.md)（统一 seed 注册表 / 核心项与可选项 / ONE-SHOT / force / 反初始化 / 后台 API / 重新生成内置常量）

等 Agent 干活的时候，人常是干坐着的——想随手写点什么，又不想切来切去。TiddlyWiki 单文件、纯文本、wiki 语法、自带 git 同步，天生适合**随手写点小东西**。于是把它做成 DSH 原生插件：不用离开当前界面，聊天区右下角就有快速笔记；要正经编辑，弹出 TW 原生编辑器；写下的内容自动进 git，既是知识库也是备份。

---

## ✨ 特性一览

| 能力 | 说明 |
|---|---|
| 🤖 **Agent 工具** | `tiddlywiki_search` / `get` / `put` / `batch_put` / `rename` / `delete` / `recent` / `list_tags` / `git_sync` / `git_resolve` 十个工具：检索、读写、批量、重命名、删除、git 同步与冲突解决 |
| 📊 **回复流工具卡片** | `tiddlywiki_*` 工具结果在回复流里显示**原生 TW 卡片**（v0.16.0）：`get`/`put`/`rename` 把 tiddler 原生渲染进卡片、`search`/`recent`/`batch` 列可点击行、`list_tags` 计数 chips、`git`/`delete` 显示文本；`[标题](/dsh-tiddlywiki/tw/#标题)` 点击直达中央 TW 面板 |
| 📤 **一键发送给 Agent** | TW 笔记工具栏「**发送给 Agent**」按钮（首次启动自动写入 wiki；**独立加粗纸飞机图标**，遵循核心工具栏图标约定，工具栏设置列表也显示各按钮图标/说明）：把当前笔记作为消息注入所选 dsh 会话（按工作区分组选择，可新建工作区/会话，**可选「工作模式」= Agent 预设**、**可选「权限」= 权限预设**（沙箱+审批），**可选附加说明**随消息一起发给 Agent（**位于消息末尾**，作为你的最终补充要求，v0.16.3），已有会话显示其当前模式）；**消息自动附加待办说明**——告知 Agent 这是用户提前编辑在 wiki 中的待办事项，不清楚应主动提问 |
| 🧭 **内嵌编辑器** | 侧边栏「TiddlyWiki」入口（**显示名可自定义**，`ui.sidebarLabel`）→ 中央列内嵌完整 TW 5 编辑器（**同源代理**，经 DSH origin 访问，Tailscale/内网/域名/HTTPS 均可用） |
| 📚 **会话「知识库」Tab** | 每个会话顶部新增「知识库」Tab（v0.16.11，`ui.tabLabel` 可改、`ui.showSessionTab` 可关）：**本会话产生/读取/检索过的 wiki 笔记汇总**，TW 原生渲染；后端用 DSH `sessionQuery` 读本会话 + 后代子代理的完整事件日志判定相关性，汇总写入 **volatile `$:/temp`**（不落盘、不进 git、重启即消失），绝无 UI 重复造轮子 |
| 🌗 **跟随 DSH 主题** | 嵌入式 TW（中央面板 +「在 TW 中编辑」弹窗）**自适应 DSH 深浅主题**：暗色自动切深色 palette、浅色恢复原 palette；**纯内存切换，不写回 wiki、不进 git**；设置页可关可换深色 palette |
| 📝 **快速笔记** | 右下角「知识库」悬浮按钮 **或聊天输入框上方的快捷按钮**（`ui.showQuickNoteDock`，与 todo/cost-meter/goal 等插件内容同槽位纵向排列、不重叠；按钮右缘实时贴齐输入框）→ 快速笔记卡片：**CodeMirror 6** Markdown 编辑器（语法高亮 + 撤销/重做）、文件上传、多选/自动补全 tag、**草稿自动保存（刷新不丢）**、**「🕘 最近」一键载入旧笔记**，Ctrl+Enter 保存；**从按钮打开时卡片在按钮上方弹出、按住标题栏可自由拖动、再次点按钮可收起**；**卡片只允许点右上角 ✕ 或输入框按钮关闭**（点页面其他位置不会误关）；可整体隐藏 |
| 🔄 **一键同步** | 「知识库」按钮 →「🔁 同步」：pull → commit → push；FAB 上的状态点实时反映 git 状态（已同步/待提交/可更新/离线），菜单里的状态行**悬停弹出详细 tip**（TW 服务 + git 状态 + 最近日志） |
| ⚙️ **设置页** | DSH 设置 →「TiddlyWiki 知识库」：插件/主题/语言管理与运行配置，应用后自动重启 TW；**「初始化」区块**列出所有一次性预置项（说明笔记/发送按钮/首页/所有文章/**menubar 顶栏主题自适应**/同源代理基址）的实时状态：**功能必需项**（发送按钮 + 代理基址）启动自动写入，**可选项默认不写入、不强绑定**——每项可手动**重新初始化**，可选项可**反初始化**（移除）；**「所有文章」每页条数**可在配置里调整（实时生效，无需重新初始化） |
| 🛡 **零摩擦生命周期** | 随 dsh 自动启停；TW 子进程崩溃自动重启（退避）；端口/目录/首次 git init 全自动 |
| 💾 **数据即备份** | wiki 文件夹本身就是一个 git 仓库；自动 commit（60s 防抖，可关），配置随 dsh-market 迁移 |

---

## 🕘 版本记录

> 最近几个主要版本的一句话更新记录（完整变更见 git log / Releases）。

- **v0.16.14**（2026-09-07）：**修：「知识库」Tab 仍显示「佚失条目」——根因是浏览器端 TW 根本看不到 `$:/temp`**。v0.16.13 的过滤/自愈治标不治本：TW 浏览器端同步机制天生排除 volatile 条目——服务端 recipe 列表默认 `[all[tiddlers]!is[system]]`（`get-tiddlers-json.js`），tiddlyweb adaptor 的请求过滤器又显式 `-[prefix[$:/temp/]]`（`tiddlywebadaptor.js getSkinnyTiddlers`），lazyLoad 只补「已知 skinny」不拉「完全缺失」——所以 iframe 里的 TW 永远拿不到 `$:/temp/dsh/session-summary/<会话ID>`，`#<标题>` hash 直达必然渲染「佚失条目」，客户端再怎么自动重新生成也无济于事（服务端有、浏览器没有）。修复（纯客户端，host 无变化）：iframe **不带 hash** 挂载（注入落地前盖加载浮层，不闪现默认页），就绪后由客户端**注入**——同源 `/get` 读回汇总字段 → `iframe.contentWindow.$tw.wiki.addTiddler(...)` 写进 iframe 的 TW store → 设 `contentWindow.location.hash` 走 TW 原生 hash 导航（与中央面板 `openTiddler` 同一机制，落地重试绕开 boot 时序竞争）；自愈升级：30s 探测在「服务端丢失（TW 重启）→ 重新生成」之外，新增「服务端仍在而 iframe store 丢失（iframe 自身重载）→ 重新注入并导航」，不打扰用户在 iframe 内的浏览。汇总条目仍只存在于服务端内存 + iframe 内存——**不落盘、不进 git、重启即消失（设计不变）**。刷新页面即生效。
- **v0.16.13**（2026-09-07）：**修：会话「知识库」Tab 出现「佚失条目」**。① 汇总内容里的死链/垃圾条目：会话日志常混入模型的示例/残缺写法（`#…`、`#标题`、带反引号的截断链接），旧代码会把它们原样收进汇总并写成 `[[…`]]` 这种坏 wikitext，TW 渲染成「佚失条目」——现在采集时统一过滤（控制字符 / `]` `|` 反引号 `#` / `…` 占位 / 超长标题一律丢弃）。② 汇总条目本身是 volatile 的 `$:/temp`，**TW 重启即消失**，若 Tab 一直开着，iframe 会停在 TW 的「佚失条目」页——客户端新增自愈：每 30s 探测一次 `/get`，条目不存在就自动重新生成（连续 3 次仍缺失则交还手动「🔄 刷新」）。刷新页面 + 重启 dsh web 后，重新打开 Tab 即生成干净汇总。
- **v0.16.12**（2026-09-07）：**深度代码优化（内部重构，行为不变）**。① **配置链修复**：`ui.sendToAgent`/`ui.allArticles` 默认值不再被 cordis 宽松类型吞掉（改为显式逐层合并），`uiLanguage` 不再被配置覆盖层丢弃；设置页「常规配置」补齐「发送给 Agent」开关/token/endpoint 字段（此前只在代码里生效、设置页没有）。② **去重**：新增 `src/host/http.ts`（路由/管理后台共用的 body 读取 + JSON 响应，删掉 3 份重复实现）与 `src/client/endpoints.ts`（`/status` 端点六处合一）；`seeds.ts` 引入 `defineSeed` 工厂（每个 seed 的 id/标题/描述三处重复 + try/catch 样板全部收敛，7 项注册表缩到声明式）；`tools.ts` 抽出 `requireWiki`（8 处重复守卫）与 `gitStatusBits`（git 状态文案两处合一）；事件名常量统一（`NOTE_STATE_EVENT`/`PANEL_RELOAD_EVENT`）。③ **泄漏修复**：快速笔记卡片标签编辑器与「知识库」FAB 的 document 级监听器在卸载时正确移除；TW 面板的 40×150ms 哈希等待链在卸载后停止（不再驱动已移除 iframe）；编辑器弹窗拖拽改用 Pointer Capture（鼠标在 iframe 上松手不再残留 window 监听）；保存按钮/同步控制器加防连点与卸载后停轮询。④ **清理**：删除约 40 行无引用 CSS 与 2 个死导出（`mountNoteWidget`/`PANEL_VIEW_SELECTOR`）；`admin.ts` 去掉无效的动态 import（消除构建警告）；会话「知识库」汇总的笔记状态改为 8 路并发查询。已过 `typecheck` / `build` / `selftest`（含 `session/summary` 端到端用例）。
- **v0.16.11**（2026-09-06）：**新：会话顶部「知识库」Tab（本会话相关 wiki 汇总）**。每个会话顶部在「对话 | 轨迹」旁新增 Tab（默认名「知识库」，`ui.tabLabel` 可改、`ui.showSessionTab` 可关），显示本会话**产生/读取/检索过的 wiki 笔记汇总**，**TW 原生渲染**（同源代理 iframe，不另造 UI）。后端新路由 `POST /dsh-tiddlywiki/session/summary`：用 DSH `sessionQuery.readSession` + `traceSession` 读**本会话 + 后代子代理**的完整事件日志，按 `tool/call` 的 `tiddlywiki_*` 工具名归类——产生 📝（put/batch_put/rename）、读取 👀（get + 助手回复 `/dsh-tiddlywiki/tw/#…` 链接）、检索 🔍（search/recent 记关键词）；每篇列出当前标签/修改时间/是否已删除，仅子代理触达的标注「（子代理）」。汇总页写入 **volatile `$:/temp/dsh/session-summary/<会话ID>`**——已实测验证 TW 默认 SyncFilter 显式排除 `$:/temp`，**不落盘、不进 git、TW 重启即消失**。进入 Tab 自动生成、顶栏可手动刷新；侧边栏完整 TW 面板保持原样。本 Tab 判定来源（sessionQuery 服务、conversation.view 槽位契约、$:/temp 行为）均已通过 Inspect 与实测核实，并有 `selftest` 新增 `session/summary` 端到端用例覆盖。
- **v0.16.10**（2026-09-06）：**修：关闭侧边栏后快速笔记按钮不再对齐**。v0.16.8 的 `ResizeObserver` 只观察了 dock 容器，而侧边栏开/关改变的是**对话列宽度**（composer 输入卡片居中、有 max-width，右缘随之移动），dock 容器未必触发 resize → 按钮停在上次位置、卡在侧边栏开着时的对齐上。现在改为观察「从 dock 条目一直到对话根节点（`data-phase`）的整条祖先链」，任一祖先尺寸变化都重测对齐；另加 1.5s 自愈兜底定时器 + `visibilitychange` 重测，任何未观测到的布局变化也会在下一秒内纠正。刷新页面即生效。
- **v0.16.9**（2026-09-06）：**修：「设置 → 外观 → 工具栏」渲染出源码文本**。根因：send-to-agent bundle 里 shadow 核心 `$:/core/ui/ControlPanel/Toolbars/ItemTemplate` 的 tiddler，其**正文第一行被错误地写成了 `title: ...` 头**（`item-template.tid` 源文件是 `.tid` 格式、带 title 行，构建脚本把整个文件原样塞进 `text` 字段），导致该模板的 `\define`/`\whitespace trim` pragma 全部失效、源码被当作文本原样显示在工具栏设置页（每个工具栏标签重复输出一次）。修复：`item-template.tid` 去掉首行 title 头（与 `button.tid` 一致，构建脚本原样读取即得纯正文），重新组装 bundle（v0.3.3 → **0.3.4**）+ 生成 seed + 构建，并给 `verify-send-to-agent-bundle.mjs` 新增回归检查「ItemTemplate 正文不得以 `title:` 开头」。线上 wiki 的 `$:/plugins/dsh/send-to-agent` 已覆盖为新 bundle，**刷新 TW 面板后**设置页恢复正常。在线 wiki 重载方式：「知识库」FAB →「🔄 重载 TW 面板」。
- **v0.16.8**（2026-09-06）：**修：快速笔记按钮真正贴齐输入框**。此前对齐测量作用域写错了——`conversation.input.dock` 槽位会把各条目包在一个容器里、与输入栏是**兄弟节点**，所以永远测不到输入框、按钮仍悬在整列最右端。现在改为**逐级向上爬祖先**、用「包含 >300px 宽输入框的最近祖先」定位输入栏，再取输入框到列之间的最宽盒子（即带圆角边框的可见输入卡片），把按钮右缘与卡片右缘对齐；窗口/列宽变化自动重对齐。刷新页面即生效。
- **v0.16.7**（2026-09-06）：**输入框上方「快速笔记」按钮改为开关**：打开时**再次点击按钮也会收起**（打开仍在按钮上方弹出、可拖动；✕ 依旧可关）。纯客户端改动，刷新页面即生效。
- **v0.16.6**（2026-09-06）：**快速笔记按钮与输入框对齐 + 卡片在按钮上方弹出 + 卡片可自由拖动**。① dock 按钮 mount 后实时测量 composer 输入框右缘、把按钮右缘贴齐（含窗口/列宽变化重新对齐），不再悬在整列最右端；② 从按钮打开时卡片在**按钮上方跟随弹出**（水平居中、视口内自动收拢；FAB 打开仍走右下角默认位）；③ 卡片**按住标题栏可自由拖动**（pointer events + setPointerCapture，触屏可用），✕ 仍是唯一关闭方式。纯客户端改动，刷新页面即生效。
- **v0.16.5**（2026-09-06）：**修：输入框上方「快速笔记」按钮放到横条末尾（右端）**（原为靠左、视觉悬空；改为 `justify-content: flex-end`）。纯客户端样式调整，刷新页面即生效。
- **v0.16.4**（2026-09-06）：**一批零散界面优化**。① **输入框上方「快速笔记」快捷按钮**（`ui.showQuickNoteDock`，默认开）：挂在 DSH 官方 `conversation.input.dock` 槽位，与 todo/cost-meter/goal/queue/git-graph 等插件内容同区纵向排列、**不重叠不遮挡**；② 快速笔记卡片**只能点 ✕ 关闭**（移除「点页面其他位置即收起」，不会误关）；③ 侧边栏 TW 入口**显示名可自定义**（`ui.sidebarLabel`，默认「TiddlyWiki」，设置页可改）；④ 「知识库」菜单去掉第二行 git 状态行，**第一行（TW 服务状态）悬停弹出详细 tip**（TW 服务 + git 状态 + 最近日志）；⑤ **退出/重启 dsh web 时确保 TW 后端子进程真正关闭**——host teardown 现在返回 Promise，随 cordis fiber.dispose 被 await（dsh web 关机控制器最多等 5s），不再 fire-and-forget 遗留孤儿 TW 进程。改动均向后兼容（旧配置无新字段时走默认值）。
- **v0.16.3**（2026-09-06）：**「发送给 Agent」附加说明移到消息末尾 + 注入提示词补充「想法沉淀」约定**。① bundle v0.3.3：`【附加说明】` 段从「待办说明与正文之间」移到**正文之后、消息最末尾**——作为用户的最终补充要求（指令越靠后越优先遵循）；弹层交互不变，在线 wiki 在「知识库」FAB →「🔄 重载 TW 面板」后生效；② 注入提示词（`PROMPT_TEXT`）新增「**想法沉淀**」段落：鼓励 Agent 把「未来可能有用 / 值得做」但不在当前执行范围内的想法，用 `tiddlywiki_put` 写成独立 tiddler，打上 `todo` + `agent-written` 标签（并附当前工作区名），正文说明来源（会话 / 工作区 / 项目背景），由用户决定是否继续；新会话在下次重启 dsh web 后生效。
- **v0.16.0**（2026-09-05）：**回复流原生 TW 工具卡片 + 可点击 wiki 链接**。新增 seed `render-route`（核心项）：TW 内注册 `POST /render` 服务路由把 wiki 文本渲染成原生 HTML 片段，并把内部 wiki 链接改写为同源代理 hash（`tv-wikilink-template`，首次 seed 后自动重启 TW）；全部 10 个 `tiddlywiki_*` 工具在回复流里显示**原生 TW 工具卡片**（`tool.call.toolview`）：`get`/`put`/`rename` 原生渲染 tiddler、`search`/`recent`/`batch` 列可点击行、`list_tags` 计数 chips、`git`/`delete` 显示文本；**文档级点击拦截**——`[标题](/dsh-tiddlywiki/tw/#标题)` 与渲染片段里的 wiki 链接点击后打开中央 TW 面板并跳转该 tiddler；host 新增 `/search` 路由（关键词 + tags/tag/since/type/limit）、`/tags` 返回带计数的 items、`/get` 返回 modified。
- **v0.16.1**（2026-09-05）：修：工具卡片改为 `slots.inject` 注册（子 slot 需父声明），卡片在回复流正常挂载。
- **v0.16.2**（2026-09-05）：修：iframe 内 TW ready 后再设 hash，消除 startup 监听竞态导致的跳转丢失。
- **v0.15.0**（2026-09-05）：**初始化不强制 + 可反初始化 + 设置页样式修复**。① **不给用户强绑定**——seed 注册表拆两层：启动只自动写入**功能必需项**（「发送给 Agent」按钮 + TW 前端 API 基址）；**可选项**（说明笔记 / 首页 / 所有文章 / menubar 顶栏主题自适应）默认不写入，设置页「初始化」区块可随时「重新初始化」写入；② **「反初始化」**——可选 seed 每项（及「全部反初始化」）可一键删除其写入的 tiddler + marker，恢复未初始化状态（核心项不可移除；home-index 反初始化会顺带把 `$:/DefaultTiddlers` 从 `[[主页]]` 恢复为 GettingStarted）；后台新增 `POST /admin/seeds/remove`；③ **menubar 顶栏主题自适应不再自动写入**（改的不对可去——本 wiki 已移除该样式表，顶栏恢复默认外观；想要可随时在设置页重新初始化）；④ **设置页样式修复**——说明/次要文字不再依赖可能缺失的 `label-dimmed` token，改由主题主文字色派生（任意深浅主题下可读，不再出现白色文字）；配置字段标签改为自然换行、输入框右对齐限宽，行内名称/说明单行省略，长选项不再断行错乱。
- **v0.14.0**（2026-09-05）：TW「**发送给 Agent**」一键发送三处优化。① **工具栏按钮修复**——之前按钮在 控制台→外观→工具栏 里**不显示图标与说明**（还和「导出此条目」用同一个导出图标）：现为按钮补上 `icon`/`caption`/`description` 字段，并在 bundle 里**自带独立的「发送」图标**（不再借用 core 的 export-button），工具栏设置与条目标题栏都显示独立图标；后续小修：图标改用**更饱满的实心纸飞机**并遵循核心图标约定（`\parameters (size:"22pt")` + `width/height` + `tc-image-button` class + `$:/tags/Image` 标签），修复宽度比相邻图标窄的问题；同时 bundle **shadow 覆盖核心 `$:/core/ui/ControlPanel/Toolbars/ItemTemplate`**（镜像 EditorItemTemplate），让 查看/页面/编辑工具栏 的设置列表**也显示每个按钮的图标**（原来只有编辑器工具栏列表显示）；**再修「图标裂了」**——根因是 bundle 里 icon tiddler 被设了 `type: image/svg+xml`：`{{icon}}` 会走 imageparser 渲染成 `<img src="data:image/svg+xml,...">`，数据 URI 保留原始文本（开头的 `\parameters` 与未展开的 `width=<<size>>` 不是合法独立 SVG），Chrome/Edge 直接加载失败显示裂图；核心图标**不带 type 字段**（默认 wikitext），`{{icon}}` 被 wiki 化成语法展开后的**内联 `<svg width="22pt">`**。修复：icon tiddler 去掉 type 字段（保持 wikitext，与核心一致），已在真实浏览器验证图标渲染尺寸与核心图标完全一致（32.9×24.7）且无裂图；② **可选「附加说明」**——发送弹层新增文本输入框，填写的说明会以 `【附加说明】` 段随消息一起发给 Agent（不填则无此段）；③ **可选「权限」**——弹层新增「权限（权限预设）」选择器（来自 DSH `permissionPresets`，如 工作区写入+询问 / 完全访问+免确认），**新建会话并发送**时 `/agent/create` 传 `permission` → 创建后对会话日志应用该预设（`permission/preset` + `sandbox/mode` + `approval/policy` 事件），覆盖部署默认；对旧宿主**向后兼容**：权限服务缺失时选择器降级为提示、不发送该字段。bundle 源码收进仓库 `scripts/bundle/send-to-agent/`（startup.js/button.tid/icon.svg/item-template.tid）+ 组装脚本 `scripts/build-send-to-agent-bundle.mjs`，改按钮后重跑组装 → gen-seed → build 即可。
- **v0.13.1**（2026-09-04）：**客户端 bundle 压缩（minify）**。CodeMirror 6 + Lezer markdown 让 `lib/client.js`（`./client` 导出）达到 1.06MB，超过插件目录注册表（如 dsh.pub 收录校验）经 GitHub Contents API 检查的 **1MB 上限**，导致 dsh.pub 收录 PR 首轮校验失败（`invalid_file`）；开启 tsdown `minify` 后产物降到 **0.58MB**（gzip ~193KB），浏览器加载更快，dsh.pub 收录 PR #83 校验全绿并已合并。构建配置见 `tsdown.client.config.ts`。
- **v0.13.0**（2026-09-04）：**menubar 顶栏主题自适应**。tiddlywiki/menubar 顶栏背景原来一直停在默认色映射的蓝色（`$:/config/DefaultColourMappings/` → `#5778d8`），不随 DSH 深浅主题变化——根因是大部分浅色 palette（Vanilla/Blanca…）不定义 `menubar-background`，`<<colour menubar-background>>` 落回插件硬编码的蓝色。新增 seed `menubar-theme`：写入样式表覆盖 `$:/plugins/dsh-tiddlywiki/menubar-theme`（tag `$:/tags/Stylesheet`），把顶栏改为跟随**活动 palette** 的 `background`/`foreground`（`!important` 压过插件自身规则）；嵌入式 TW 的 `$:/palette` 由主题同步随 DSH 翻转时，TW 会实时重渲染全部样式表，menubar 即自动换色。作为新 seed 进统一注册表（`menubar-theme`），首次启动自动写入（ONE-SHOT，不覆盖你的改动），设置页「初始化」可单独/全部**重新初始化**。
- **v0.12.0**（2026-09-04）：**新默认主页「主页」+ 「所有文章」两列分页页**。把首页拆成三页：**主页**（默认打开，`$:/DefaultTiddlers` 指向它）= 四象限待办 + 「所有标签」「所有文章」入口；**所有标签**瘦身为独立标签统计页（标签 + Agent 区块 + 回主页链接）；新增 **所有文章**——全部条目分两列（🤖 Agent 撰写 / 👤 人工·人类，含 `human-edited` 的 Agent 笔记）**各自分页**展示（排除系统页、草稿与 `索引` 导航页），每页条数取配置 `ui.allArticles.pageSize`（默认 10，设置页可调、实时生效）。**所有文章**作为新 seed 进统一注册表（`all-articles`），设置页可单独/全部**重新初始化**。
- **v0.11.0**（2026-09-04）：TW「**发送给 Agent**」选择器新增**「工作模式」（Agent 预设）**——弹层顶部可选择会话挂载的 Agent 预设（如 默认/cordis/blade，来自 DSH `agentPresets`），**新建工作区/会话并发送**时以所选模式创建（`/agent/create` 新增 `mode` 参数 → `sessionController.create(agentPreset)`）；已有会话显示其当前模式（`🧭` 徽标）。新增 `GET /agent/modes` 返回可用模式清单 + 部署默认。对旧宿主**向后兼容**：模式接口缺失时选择器降级为默认模式，功能不受影响。
- **v0.10.0**（2026-09-04）：**统一 seed 注册表**——把「与 dsh 联动、需要 wiki 预置」的全部一次性项收进 `SEED_DEFS`（说明笔记、发送给 Agent 按钮、**首页「所有标签/标签笔记」**、**TW 前端同源代理基址**），首次启动只写缺失、不覆盖用户内容；设置页新增「**初始化**」区块：列出每项实时状态 + 手动「**重新初始化**」（force 重写内置内容，含缺失项补齐与 TW 前端基址修复）。新装用户开箱即有**首页**（四象限待办 + 标签统计 + Agent 区块），不再手工放 tiddler。配套文档：[🧩 初始化小节](#🧩-初始化一次性预置) + [docs/seed-initialization.md](docs/seed-initialization.md)。
- **v0.9.0**（2026-09-04）：TW「**发送给 Agent**」按钮随插件**首次启动自动写入 wiki**（ONE-SHOT：只写一次、用户可删可改不复活）——新装用户开箱即用，无需手工往 wiki 塞插件 bundle；消息格式更新：**去掉 `【TiddlyWiki 笔记一键发送】` 前缀**，并**附加待办说明**告知 Agent 这是用户提前编辑在 wiki 中的待办事项、不清楚应主动提问。
- **v0.8.0**（2026-09-04）：嵌入式 TW **跟随 DSH 深浅主题**——暗色自动切深色 palette（默认 CupertinoDark）、浅色恢复原 palette，纯内存切换**不写回 wiki、不进 git**，设置页可开关/换深色 palette。
- **v0.7.2**（2026-09-03）：「一键发送到 dsh」改为**工作区优先**——新增 POST `/agent/create` 按 cwd 落入真实 Workspace，新会话不再丢到「未分组」；自动给新笔记补打 `agent-written` 标签并在首页分区展示。
- **v0.7.0**（2026-09-03）：TW 里**一键把当前笔记发送到 dsh 会话**（`/agent/sessions` + `/agent/send` + TW 按钮，可配置开关）。
- **v0.6.0**（2026-09-03）：**同源代理**——嵌入式 TW 编辑器改为经 DSH origin（`/dsh-tiddlywiki/tw/`）访问，Tailscale / 内网 / 域名 / HTTPS 下都能正常加载与编辑。
- **v0.5.0**（2026-09-03）：Agent 工具扩充（搜索 tag/type/since 过滤，`recent` / `list_tags` / `batch_put` / `rename` / `git_resolve`）；快速笔记**草稿自动保存**与「🕘 最近」一键载入；右下角统一「知识库」悬浮按钮（快速笔记 + 同步 + TW 面板）。

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

首次启动会自动完成：**初始化 wiki 目录**、**`git init` 并提交基线**、把「与 dsh 联动、功能必需」的一次性项写入 wiki（**统一 seed 注册表**，见「初始化」）：**写入一次**「发送给 Agent」TW 按钮插件（`$:/plugins/dsh/send-to-agent`）、把 `$:/config/tiddlyweb/host` 指向同源代理。它们都是 ONE-SHOT：只写缺失、不覆盖你的改动、删掉重启也不会自动恢复。**可选项不自动写入、不强制**：说明笔记 / 首页 / 所有文章 / menubar 顶栏主题自适应 需要时在设置页「初始化」手动「重新初始化」，不想要可「反初始化」移除。

---

## 🚀 快速开始（2 分钟上手）

1. **安装并重启** dsh web（见上）。
2. 点左侧侧边栏「**TiddlyWiki**」→ 中央打开完整 TW 编辑器；此时右下角已有「**知识库**」悬浮按钮（内含快速笔记/同步/TW 面板入口）。
3. **随手记**：点右下角「知识库」→「📝 快速笔记」，写两行、打上 tag，`Ctrl+Enter` 保存——它成为一个独立 tiddler，并自动进入 git；草稿会自动保存到本地，关掉/刷新都不丢。
4. **正经排版**：在笔记里点「✏️ 在 TW 中编辑」，弹出 TW 原生编辑器小窗继续写；想接着改旧笔记，点「🕘 最近」一键载入。
5. **收工同步**：点「知识库」→「🔁 同步」，一键 pull → commit → push，把今天的记录推到远端备份。
6. **让 Agent 参与**：直接在聊天里说「把刚才的会议纪要存进知识库」——Agent 会用 `tiddlywiki_*` 工具读写。
7. **一键把笔记发给 Agent**：在 TW 里打开任意笔记，点工具栏「**发送给 Agent**」→ 选择目标会话（按工作区分组）→ 笔记作为消息注入该会话；消息自带待办说明，Agent 不清楚会主动提问。

> 想直接看 Agent 侧完整能力？跳到 [📖 使用指南](#-使用指南)。

---

## 📖 使用指南

### 🤖 给 Agent：10 个工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `tiddlywiki_search` | `query`, `tags?[]`, `tag?`, `since?`, `type?`, `limit?` | 检索非系统 tiddler，返回标题/标签/修改时间/摘要；`tags` 为 AND 标签，`since` 按修改时间过滤，`limit` 上限 200 |
| `tiddlywiki_recent` | `limit?`, `since?` | 最近修改的笔记（倒序），开工快速了解近期动态 |
| `tiddlywiki_list_tags` | — | 现有非系统 tag 及各自计数（按使用次数降序） |
| `tiddlywiki_get` | `title` | 读单个 tiddler 全文 |
| `tiddlywiki_put` | `title`, `text`, `tags?`, `fields?` | 写/覆盖 tiddler；`fields` 可带业务字段（如 `{"type":"meeting","date":"2026-09-02"}`） |
| `tiddlywiki_batch_put` | `items[]`, `overwrite?` | 批量写入；`overwrite=false` 跳过已存在标题 |
| `tiddlywiki_rename` | `oldTitle`, `newTitle`, `updateRefs?` | 重命名 + 尽量更新其他 tiddler 里的 `[[旧]]`/`{{旧}}` 引用 |
| `tiddlywiki_delete` | `title` | 删除 tiddler（幂等） |
| `tiddlywiki_git_sync` | `action: pull\|push\|sync`, `message?` | git 操作 |
| `tiddlywiki_git_resolve` | `files[]`, `strategy: keep-local\|keep-remote\|list` | pull 冲突后按 tiddler 二选一解决（keep-remote 需已配置远端） |

**知识库同步纪律（四条）**：

1. 开工先 `tiddlywiki_git_sync action=pull`（rebase + autostash；真冲突会自动 abort 并报冲突文件）。
2. 冲突后：`tiddlywiki_git_resolve files=[冲突文件] strategy=keep-local|keep-remote` 按 tiddler 二选一解决，再重新 sync。
3. 收工 `tiddlywiki_git_sync action=sync`（pull → commit → push）。
4. 插件自动 commit 兜底（60s 防抖，可关），手动 sync 用于需要主动推送的场合。

> ⚠️ pull 若拉到新内容，`pull` / `sync` 会自动**重启 TW（同端口）**，后续读写/搜索都是最新快照，不会读到旧缓存。

**建议**：把 wiki 当作长期记忆库——会议纪要、决策记录、调研笔记、随手的想法都可存成独立 tiddler（tag 建议 `inbox` / `meeting` / `decision` 等便于检索）；自动建笔记时，除业务 tag 外也带上**当前 workspace 名**，方便按项目归集。**想法沉淀**（v0.16.3 起写入注入提示词）：遇到「未来可能有用 / 值得做」但不在当前执行范围内的想法，用 `tiddlywiki_put` 写成独立 tiddler，打上 `todo` + `agent-written` 标签（并附当前 workspace 名），正文说明来源（会话 / 工作区 / 项目背景），由用户决定是否继续。

### 🧑‍💻 给人：界面操作

**📤 一键发送给 Agent** — 插件首次启动会把「发送给 Agent」按钮插件写入 wiki（`$:/plugins/dsh/send-to-agent`，ONE-SHOT）。在 TW 里打开任意笔记，工具栏点「**发送给 Agent**」：
- 弹层顶部有**「附加说明」（可选）**输入框（v0.14.0）：填写的说明会以 `【附加说明】` 段随消息一起发给 Agent（不填则没有该段）；v0.16.3 起该段放在消息**最末尾**（正文之后，作为你的最终补充要求）；
- 弹层顶部有**「工作模式」（Agent 预设）**选择器（v0.11.0）：列出 DSH 全部可用预设（`/agent/modes`，标记部署默认），**新建工作区/会话并发送**时按所选模式创建（`/agent/create` 传 `mode` → `sessionController.create(agentPreset)`）；已有会话旁显示其当前模式徽标（🧭）；
- 弹层顶部还有**「权限」（权限预设）**选择器（v0.14.0）：列出 DSH 权限预设（沙箱 + 审批的捆绑，如 工作区写入+询问 / 完全访问+免确认，来自 `permissionPresets`），**新建会话并发送**时应用所选权限（`/agent/create` 传 `permission` → 创建后 `permissionPresets.set` 写入会话日志）；权限服务不可用时选择器自动隐藏、按部署默认；
- 弹层**按工作区（cwd）分组**列出可见会话，点选即把当前笔记作为消息注入（`sessionController.prompt`，与聊天输入同 API）；
- 也可以**新建工作区/会话**再发送（`/agent/create` 按 cwd 落入真实 Workspace，会话不落「未分组」）；
- 消息格式为 `《标题》` + 标签/类型 + **待办说明**（告知 Agent 这是用户提前编辑在 wiki 中的待办事项、不清楚应主动提问）+ 正文 + **附加说明**（可选，位于消息末尾，v0.16.3）；
- 按钮在 控制台→外观→工具栏 里带**独立加粗图标与说明**（v0.14.0 起不再借用「导出此条目」的图标；bundle 还 shadow 覆盖核心工具栏行模板，让查看/页面/编辑工具栏的设置列表都显示每个按钮的图标）；
- 开关与 token 见设置页「常规配置」/配置项 `ui.sendToAgent`（默认开）。

**🧭 中央列编辑器** — 侧边栏「TiddlyWiki」按钮开关中央编辑器面板（**同源代理**：iframe 指向 `<DSH origin>/dsh-tiddlywiki/tw/`，由 DSH 转发到回环上的 TW 服务），完整 TW 5 编辑器。入口显示名可在设置页「常规配置」→「侧边栏 TW 入口显示名称」自定义（`ui.sidebarLabel`，默认「TiddlyWiki」，改后刷新页面生效）。

**🌗 跟随 DSH 主题** — 中央面板与「✏️ 在 TW 中编辑」弹窗里的 TW **自动跟随 DSH 的深浅主题**（v0.8.0 起，`ui.followDshTheme`，默认开）：
- DSH 处于**暗色**时，TW 的活动 palette 临时切到深色 palette（默认 `$:/palettes/CupertinoDark`）；切回**浅色**时自动恢复你原来的 palette；
- 如果你本来就用着深色 palette（如 SolarizedDark），暗色下不打扰；浅色下也不会把你的选择改掉；
- 切换是**纯内存**的（写入 `$:/palette` 后同步校准 syncer 的 changeCount，阻止它 PUT 回服务端）——**不写回 wiki、不进 git 历史**，你的 palette 选择与知识库 git 状态始终干净；
- 开关与深色 palette 可在设置页「常规配置」调整。

**📝 快速笔记** — 两个入口，同一张卡片：
- **入口一**：聊天输入框上方的**快捷按钮**（v0.16.4，`ui.showQuickNoteDock` 控制、默认开）——挂在 DSH 官方 `conversation.input.dock` 槽位（「输入框上方的全宽条目」，todo/cost-meter/goal/queue/git-graph 等插件内容也在这里），纵向 flex 排列，**天然不重叠**；按钮**右缘实时贴齐输入框**（v0.16.6，随窗口/列宽变化自动重对齐），不再悬在整列最右端；
- **入口二**：右下角「**知识库**」悬浮按钮 →「📝 快速笔记」；
- 从**输入框按钮**打开时，卡片在**按钮上方跟随弹出**（水平居中、自动收进视口；v0.16.6）；从 FAB 打开走右下角默认位；
- 卡片**按住标题栏可自由拖动**到页面任意位置（v0.16.6，pointer events，触屏可用），拖动后位置即时生效；
- 卡片（可折叠）**只能点右上角 ✕ 关闭，或再次点输入框上方的按钮收起**——点页面其他位置不会误关（v0.16.4 起移除「点外部收起」），草稿照常防抖自动保存；
- **CodeMirror 6 编辑器**：真正的 Markdown 语法树高亮（标题/列表/代码/链接/表格/任务清单/删除线等，GFM），支持撤销/重做与行内编辑体验；
- **草稿自动保存**：正文/标题/标签 500ms 防抖写入本地，关掉卡片或刷新页面都不丢；重开自动恢复，可一键「丢弃」；
- **🕘 最近**：一键列出最近修改的笔记，点标题直接载入编辑器继续改（不需要开完整 TW 去找）；
- **文件上传**：点「📎 上传」或直接把文件拖进编辑器——文件存到 wiki 的 `files/` 文件夹并随 git 同步；图片插入 `![名](/dsh-tiddlywiki/tw/files/名)`、其它文件插入 `[名](/dsh-tiddlywiki/tw/files/名)`（**同源代理 URL**，在 TW 与快速笔记预览里都能打开）；
- **Ctrl+Enter 保存**为独立 tiddler；笔记 `type` 自动设为 `text/markdown`，所以上传的图片/链接在 TW 里按 Markdown 正常渲染；
- 点「**✏️ 在 TW 中编辑**」→ 保存后弹出**独立小窗**（可拖动/缩放）加载 TW 原生编辑器编辑该条。

**🔧 一键同步 + 面板** —「知识库」按钮是一个**统一入口**，替代了旧版三个叠在右下角的悬浮按钮：
- **🖥 打开/收起 TW 面板** 与 **🔄 重载 TW 面板**（`ui.showPanelStatus` 控制）；
- **📝 快速笔记**（`ui.showQuickNote` 控制）；
- 菜单顶部一行 **TW 服务状态**（v0.16.4 起去掉旧版第二行 git 状态行），**鼠标悬停弹出详细 tip**：TW 服务状态/地址 + git 状态（分支/领先/落后/上次同步）+ 最近日志；
- **🔁 同步**：pull → commit → push；FAB 右下角的**状态点**实时反映 git 状态：
  🟢 已同步 · 🟡 有未提交改动 · 🔴 落后于远端 · ⚪ 离线；悬停 FAB 可看分支/领先/落后/上次同步时间；每 30s 自动刷新。
  若这次 pull 拉到了新内容，TW 服务自动重启（同端口），界面立即显示最新快照（无需手动去面板点「重启 TW」）。

**🔧 面板异常** — 面板服务异常时显示错误 +「重试」按钮（POST `/dsh-tiddlywiki/restart`）。

**📚 会话「知识库」Tab（本会话相关 wiki 汇总）** — 每个会话顶部在「对话 | 轨迹」旁新增一个 Tab（v0.16.11，默认名**「知识库」**，可在设置页改 `ui.tabLabel`；`ui.showSessionTab` 可整体关闭）：
- 进入 Tab 自动生成当前会话的 wiki 汇总页，**TW 原生渲染**（复用同源代理 iframe + TW 自己的主题/链接/导航，不另造 UI）；顶栏有「🔄 刷新」按钮可重新生成；
- 渲染机制（v0.16.14）：浏览器端 TW 的同步过滤器天生排除 `$:/temp`（volatile 条目到不了 iframe），因此由客户端在 iframe 就绪后**注入**汇总条目（`addTiddler`）再走 TW 原生 hash 导航显示；
- 判定「哪些笔记和本会话相关」由后端 `POST /dsh-tiddlywiki/session/summary` 完成：用 DSH `sessionQuery` 读本会话（**含后代子代理**，`traceSession` 递归）的完整事件日志，按工具调用归类——**产生 📝**（`put`/`batch_put`/`rename`）、**读取 👀**（`get` + 助手回复里 `/dsh-tiddlywiki/tw/#…` 引用链接）、**检索 🔍**（`search`/`recent` 记关键词）；每篇列出当前标签/修改时间/是否已删除，仅子代理触达的标注「（子代理）」；
- 汇总页写入 TW 的 **volatile 命名空间 `$:/temp/dsh/session-summary/<会话ID>`**——TW 默认 SyncFilter 显式排除 `$:/temp`，**不落盘、不进 git、TW 重启即消失**，绝不污染知识库；
- 与左侧边栏「TiddlyWiki」完整面板互不影响：那里保持原样，本 Tab 只是多一个快速入口。

### ⚙️ 设置页（DSH 设置 →「TiddlyWiki 知识库」）

| 区块 | 内容 |
|---|---|
| 状态/重启 | TW 运行状态 + git 概览 + 「同步」按钮 + 「重启 TW」按钮 |
| 常规配置 | 快速笔记默认 tag、git 自动 commit/防抖/远端/分支、ui 开关（快速笔记/输入框上方快捷按钮/面板状态/同步按钮——分别控制对应入口）、**侧边栏 TW 入口显示名称**、**跟随 DSH 主题开关 + 深色 palette**——改了什么保存什么 |
| 插件管理 | 自带官方插件勾选（可搜索）→ 应用并自动重启 TW |
| 主题管理 | 自带主题**多选加载 + 单选活动** → 应用并自动重启 TW |
| 语言管理 | 自带官方语言包勾选（含 zh-Hans 简体）→ 应用并自动重启 TW |
| **初始化** | 一次性预置项实时状态（说明笔记/发送按钮/首页/所有文章/menubar 顶栏主题自适应/同源代理基址）→ 每项「重新初始化」；可选 seed 另有「反初始化」+ 「全部反初始化」 |

- 配置写入 wiki 内的 `$:/plugins/dsh-tiddlywiki/config` tiddler（JSON），随 git 同步，作为 **cordis `config:` 块之上的覆盖层**（tiddler 优先）。
- git 类配置修改后**重启 dsh web 生效**（bootstrap 时读取）。
- 插件/主题/语言只管理 tiddlywiki 包**自带**的官方清单（`plugins/tiddlywiki/*`、`themes/tiddlywiki/*`、包根 `languages/*`），全部离线、官方原版。

**主题机制（重点）**：TW 视觉主题由 **`$:/theme`** tiddler 决定，`info.themes` 只决定**加载哪些主题插件**。主题之间有**依赖链**（`plugin.info` 的 `dependents`）：`vanilla ← snowwhite ← heavier/centralised/readonly/starlight`，`vanilla ← tight/seamless`。设置页因此是**两层**：每行主题一个 `☑ 加载`（多选 = TW 里可用的主题）+ `◉ 活动`（单选 = 当前视觉主题）。应用时插件会：

1. 把加载集（含所选活动主题）的**完整依赖链**写入 `info.themes`（如 heavier → `[vanilla, snowwhite, heavier]`），否则激活 heavier 时会丢掉 70KB 的 vanilla 基座样式；
2. 把 **`$:/theme`** 设为所选活动主题，然后重启 TW。

样式为空壳的主题（如 tight-heavier）会自动从清单里隐藏，避免选了没效果。

### 🧩 初始化（一次性预置）

插件与 dsh 联动、需要在 wiki 里预置 tiddler/配置的项，全部收在**统一 seed 注册表**中（`SEED_DEFS`），分两层（v0.15.0）：

- **核心项**（功能必需）：「发送给 Agent」按钮 + TW 前端 API 基址——**首次启动自动写入**（非 force：只写缺失、绝不覆盖你的改动）；
- **可选项**：说明笔记 / 首页 / 所有文章 / menubar 顶栏主题自适应——**默认不写入、不强制**，可在设置页「**初始化**」区块随时手动「**重新初始化**」（force：重写内置内容）或「**反初始化**」（移除写入的 tiddler + marker）。

| seed id | 层级 | 预置内容 | 与 dsh 的联动 | ONE-SHOT 语义 |
|---|---|---|---|---|
| `send-to-agent` | **核心** | 「发送给 Agent」TW 按钮插件 `$:/plugins/dsh/send-to-agent` | 一键把笔记注入 dsh 会话的入口 | marker 门控：只写一次，删掉重启不复活 |
| `tw-web-host` | **核心** | `$:/config/tiddlyweb/host` → `/dsh-tiddlywiki/tw/` | 嵌入式 TW 编辑器的同源代理 API 基址（远程访问模式前提） | 非 force = 缺失/旧默认才写、用户自定义保留；force = 强制写回代理基址 |
| `doc-note` | 可选 | 「dsh-tiddlywiki 插件说明」笔记（tag `docs`） | 新手引导 | marker 门控：只写一次，删掉重启不复活；可反初始化 |
| `home-index` | 可选 | 默认主页「主页 / 所有标签 / 标签笔记」+ `$:/DefaultTiddlers` → 主页 | **首页**：四象限待办 + 「所有标签」「所有文章」入口 + 标签统计 + **Agent 区块**（纯 Agent / Agent+人工 分区，主标签列表排除 `agent-written`） | 同上；反初始化会一并把 `$:/DefaultTiddlers` 恢复为 GettingStarted |
| `all-articles` | 可选 | 「所有文章」——两列（🤖 Agent 撰写 / 👤 人工·人类）各自分页 | 全部条目的分栏总览；每页条数实时读 `ui.allArticles.pageSize`（设置页可调） | 同上；可反初始化 |
| `menubar-theme` | 可选 | `$:/plugins/dsh-tiddlywiki/menubar-theme` 样式表（tag `$:/tags/Stylesheet`） | 把 tiddlywiki/menubar 顶栏从默认蓝色改为跟随活动 palette 的 `background`/`foreground`，随 DSH 深浅主题自动换色 | 同上；可反初始化 |

**用法**：
- **查看状态**：设置页 →「初始化」→ 每项一个状态点（✓ 已就绪 / ✗ 缺失）+ 说明。
- **重新初始化单项**：点该项「重新初始化」——force 重写内置内容（覆盖你对该 tiddler 的改动）并重记 marker，用于「我把首页改坏了想恢复模板」「按钮被我删了想补回」「menubar 又变回蓝色了」等场景。
- **反初始化**：可选 seed 每项（及「全部反初始化」）——删除其写入的 tiddler + marker，恢复未初始化状态（核心项不可移除；点击前有确认弹窗）。
- **全部重新初始化**：底部「全部重新初始化」一键重跑全部。
- **为什么删掉重启不会自动恢复**：ONE-SHOT marker（`$:/plugins/dsh-tiddlywiki/seed-*`）记录「已提供过」，之后归用户所有——想恢复请手动「重新初始化」，而非依赖重启。

详细设计（后台 API、force / remove 语义、如何重新生成内置常量）见 [docs/seed-initialization.md](docs/seed-initialization.md)。

### 🌐 界面语言（中文）

TW 的界面语言由**语言插件**决定，不是某个配置字符串。tiddlywiki 包自带全部官方语言包（`node_modules/tiddlywiki/languages/`，含 zh-Hans 简体、zh-CN、zh-Hant、en-GB、ja-JP…），本插件离线启用即可：

- **设置页 → 语言管理**：勾选 `zh-Hans`（简体）→「应用语言（重启 TW）」——写入 `tiddlywiki.info` 的 `languages` 数组并固定 `$:/language` 为 `$:/languages/zh-Hans`，重启后 TW 界面即简体中文（持久化，重启仍在）。
- **配置自动应用**：在常规配置写入 `uiLanguage: "zh-Hans"`，每次启动 dsh web 时自动启用该语言并固定 `$:/language`（若尚未启用）。留空则不干预。
- **想换繁中**：语言管理里改勾 `zh-Hant` / `zh-TW` 再应用。

### 🌐 远程访问（Tailscale / 内网 / 域名 / HTTPS）

TW 子进程只监听 **127.0.0.1 回环**（更安全），**agent 工具、快速笔记、git 同步本来就全程走 DSH 宿主进程→回环 TW**，所以无论你从哪个入口访问 DSH，这些能力都不受影响。唯一受影响的是**浏览器里的 TW 编辑器 iframe**：早期版本让 iframe 直接指向 `http://127.0.0.1:<port>`——只有浏览器和 DSH 在同一台机器时才行；一旦通过 Tailscale / 内网 IP / 域名访问 DSH，`127.0.0.1` 会指向浏览器自己那台机器，编辑器就加载不出来了。

从 **v0.6.0** 起，内嵌编辑器改为**同源代理**：

- 浏览器里的 TW 编辑器 iframe 指向 `<DSH origin>/dsh-tiddlywiki/tw/`（与 DSH 同源），DSH 把整个 TW 前端（页面 + `/files/*` + TiddlyWeb API）透传到回环上的 TW 服务；
- TW 前端的 API 基址由 wiki 内的 `$:/config/tiddlyweb/host` 控制，插件启动时把它固定为 `/dsh-tiddlywiki/tw/`（仅当缺失或仍是旧默认值时写入，用户自定义会被保留）；
- 因为代理 URL 与端口无关，TW 重启也不会让编辑器 iframe 重新加载，编辑中的内容不丢。

效果：**DSH 跑在服务器上、你用 Tailscale / 域名 / 内网 IP 从任意设备打开 DSH Web 时，中央列编辑器和「在 TW 中编辑」弹窗都正常工作**；以后 DSH 挂到域名 + HTTPS 反向代理后面也同样成立（同源、无 mixed-content、无 CORS）。

> ⚠️ 迁移说明：v0.6.0 之前上传的文件在笔记里写的是根路径 `/files/名`，本插件**不再**占用 DSH 根命名空间（避免与其他插件冲突），所以这些旧链接在嵌入编辑器里会失效；新上传的文件使用 `/dsh-tiddlywiki/tw/files/名` 前缀 URL，可直接打开。若需要旧链接，可在 TW 里把对应笔记的 `/files/` 前缀改回 `/dsh-tiddlywiki/tw/files/`。

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
      showQuickNote: true           # 是否显示「知识库」按钮里的「快速笔记」入口
      showQuickNoteDock: true       # 是否显示聊天输入框上方的「快速笔记」快捷按钮
      sidebarLabel: "TiddlyWiki"    # 左侧侧边栏 TW 入口的显示名称（可自定义）
      showPanelStatus: true         # 是否显示「知识库」按钮里的 TW 面板/重载入口与状态行
      showSyncButton: true          # 是否显示「知识库」按钮里的「同步」入口（git 状态点常驻 FAB）
      followDshTheme: true          # 嵌入式 TW 是否跟随 DSH 深浅主题（纯内存切换）
      darkPalette: "$:/palettes/CupertinoDark"   # DSH 暗色时 TW 使用的深色 palette
    auth:
      username: ""                     # 默认 loopback 匿名；暴露到非 loopback 时才需要
      password: ""
```

> **运行时配置**：设置页写入的 `$:/plugins/dsh-tiddlywiki/config` tiddler 是 `config:` 块之上的覆盖层（tiddler 优先、随 wiki 的 git 同步）。无需改动 cordis 也能改 note tag / git 开关 / ui 开关等。
> `config:` 块随 profile 被 dsh-market 带走；wiki 数据走 git，不走 dsh-market。
>
> **远程访问（v0.6.0）**：TW 前端的 API 基址来自 `$:/config/tiddlyweb/host`，插件启动时固定为 `/dsh-tiddlywiki/tw/`（同源代理）。TW 子进程始终只监听 `127.0.0.1`；`auth.username/password` 仅在你想把 TW 直接暴露到非回环地址（绕过 DSH）时才需要，正常情况下无需配置。

---

## 👨‍💻 开发

需要 **Node.js ≥ 22**（DSH 本身已满足）。

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run build         # clean + host tsdown + client tsdown + wrap
npm run selftest      # headless：spawn TW → REST 读写 → git → 退出回收
node scripts/verify-theme-browser.mjs   # 可选：真实浏览器验证「跟随 DSH 主题」的 palette 切换与不持久化（需 puppeteer-core + Chrome，缺则 SKIP）
node scripts/verify-menubar-theme.mjs   # 可选：真实浏览器验证 menubar 顶栏随 palette 换色（浅色→白、深色→深，不再蓝色；可 TW_URL=… 指定活动 wiki）
node scripts/verify-seed-send-to-agent.mjs  # 可选：全新 wiki 上 E2E 验证「发送给 Agent」按钮 seed（bundle 写入/幂等/marker）
node scripts/verify-seeds-admin.mjs         # 可选：全新 wiki + 真实 HTTP 验证 /admin/seeds 状态与 /admin/seeds/run（单跑/全跑/force/unknown id）

# 改了 scripts/bundle/send-to-agent/ 下的按钮源码（startup.js / button.tid / icon.svg）后，
# 重新组装 bundle → 重新生成内置常量：
node scripts/build-send-to-agent-bundle.mjs
node scripts/gen-seed-send-to-agent.mjs scripts/bundle/send-to-agent.bundle.json src/host/seed-send-to-agent.ts && npm run build
node scripts/verify-send-to-agent-bundle.mjs  # 可选：校验组装出的 bundle 字段/内容

# 改了 wiki 首页「主页 / 所有标签 / 标签笔记」后，重新生成内置 seed 常量：
node scripts/gen-seed-home.mjs '<wiki>/tiddlers/主页.tid' '<wiki>/tiddlers/所有标签.tid' '<wiki>/tiddlers/标签笔记.tid' src/host/seed-home.ts && npm run build
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
| `/dsh-tiddlywiki/recent` | GET | 最近修改的笔记（快速笔记「最近」入口） |
| `/dsh-tiddlywiki/get` | GET | 读单个 tiddler（快速笔记「最近」载入） |
| `/dsh-tiddlywiki/sync` | POST | 一键 pull → commit → push |
| `/dsh-tiddlywiki/upload` | POST | 文件上传到 `files/`（原始 body + `X-Filename`） |
| `/dsh-tiddlywiki/restart` | POST | 重启 TW 子进程 |
| `/dsh-tiddlywiki/agent/sessions` | GET | 可见会话列表（TW「发送给 Agent」选择器；含每会话 `agentPreset` 模式徽标） |
| `/dsh-tiddlywiki/agent/modes` | GET | 可用「工作模式」（Agent 预设）清单 + 部署默认；同时返回 `permissions`（权限预设 roster：`{defaultId, items:[{value,name,description}]}`，v0.14.0，来自 `permissionPresets`，缺失时 `null`） |
| `/dsh-tiddlywiki/agent/send` | POST | 把笔记作为消息注入一个会话（`sessionController.prompt`） |
| `/dsh-tiddlywiki/agent/create` | POST | 按 cwd 新建/复用 Workspace + 会话（工作区优先）；可选 `mode`（Agent 预设）、可选 `permission`（权限预设，创建后经 `permissionPresets.set` 应用到会话日志，v0.14.0；未知预设 400 拒绝） |
| `/dsh-tiddlywiki/api/*` | any | 透传到 TW 服务（JSON） |
| `/dsh-tiddlywiki/tw/*` | any | **同源 TW 代理**：整个 TW 前端（index + `/files/*` + TiddlyWeb API）→ 回环 TW（v0.6.0，远程访问核心） |
| `/dsh-tiddlywiki/admin/seeds` | GET | 一次性预置项实时状态（含 `removable` 标记） |
| `/dsh-tiddlywiki/admin/seeds/run` | POST | 运行一个/全部 seed（`force` = 重新初始化） |
| `/dsh-tiddlywiki/admin/seeds/remove` | POST | 反初始化：移除一个/全部可选 seed（核心项 400 拒绝） |

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
docs/
└── seed-initialization.md  # 统一 seed 注册表详解：ONE-SHOT/force 语义、后台 API、设置页操作、重新生成内置常量
src/
├── index.ts            # host 入口：装配 WikiServer/路由/工具/prompt/自动 commit
├── sdk.ts              # 自包含 defineTool + dshHomePath（零 @deepseek-ai 运行时依赖）
├── host/
│   ├── wiki.ts         # WikiServer：spawn/kill/自愈/端口探测/就绪轮询；TW_PROXY_PATH 同源代理路径
│   ├── tw-api.ts       # TiddlyWeb REST 客户端
│   ├── git.ts          # git init/commit/pull/push/sync/status + AutoCommitter
│   ├── routes.ts       # /status /note /edit /tags /sync /upload /restart /api/* /tw/* 路由
│   ├── admin.ts        # 设置页后台：tiddlywiki.info 读写 + 目录枚举 + /admin/* 路由
│   ├── config.ts       # ConfigStore：cordis config 基底 + 配置 tiddler 覆盖层
│   ├── seed-notes.ts   # seed: 首次一次性写入「插件说明」笔记（支持 force）
│   ├── seed-send-to-agent.ts  # seed: 首次一次性写入「发送给 Agent」TW 按钮插件（bundle 内嵌常量，支持 force）
│   ├── seed-home.ts    # seed: 默认主页「主页/所有标签/标签笔记」+ $:/DefaultTiddlers（生成自 wiki .tid，支持 force）
│   ├── seed-all-articles.ts  # seed: 「所有文章」两列分页页（支持 force）
│   ├── seed-menubar-theme.ts # seed: menubar 顶栏主题自适应样式表（支持 force）
│   ├── seeds.ts        # 统一 seed 注册表：doc-note / send-to-agent / home-index / all-articles / menubar-theme / tw-web-host，check + run(force)
│   └── tools.ts        # 5 个工具（列表式注册，可扩展）
└── client/
    ├── index.ts        # client 入口（纯 DOM + settings.section 注册，永不 throw）
    ├── styles.ts / state.ts / toast.ts
    ├── sidebar-entry.ts  # 侧边栏入口
    ├── panel.ts          # 中央列 iframe 面板（fixed 覆盖层，钉住整列）
    ├── theme-sync.ts     # 跟随 DSH 主题：检测深浅 + 纯内存切 TW palette（不写回 wiki）
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
- **说明笔记**：插件在**首次启动**时把「与 dsh 联动、**功能必需**」的一次性项写入 wiki（**统一 seed 注册表**，见 [🧩 初始化](#🧩-初始化一次性预置)）：「发送给 Agent」按钮插件（`$:/plugins/dsh/send-to-agent`）、`$:/config/tiddlyweb/host` 同源代理基址——只写一次、手动编辑不被覆盖、**删除后重启不会自动恢复**（一次性标记）。**可选项**（`dsh-tiddlywiki 插件说明` 笔记、默认主页「主页/所有标签/标签笔记」+ `$:/DefaultTiddlers`、「所有文章」两列分页页、`menubar` 顶栏主题自适应样式表 `$:/plugins/dsh-tiddlywiki/menubar-theme`）**默认不写入、不强制**——需要时设置页「初始化」手动「重新初始化」，不想要可「反初始化」移除。

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

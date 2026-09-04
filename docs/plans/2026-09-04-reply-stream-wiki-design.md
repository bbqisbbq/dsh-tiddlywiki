# 设计：在 DSH 回复流中展示原生 TiddlyWiki 信息与界面

日期：2026-09-04
状态：设计定稿（讨论已确认方向）
范围：路径 1（工具卡原生视图）+ 路径 2a（seed 原生渲染路由）+ 回复流中 wiki 链接点击跳转原生页面

## 1. 目标

让 DSH 对话流（conversation chat）中的 wiki 相关内容以 **TW 原生形态**呈现，而不是纯文本：

1. **工具卡原生视图**：agent 在回复中途调用 `tiddlywiki_*` 工具时，流里的调用点渲染成原生 wiki 卡片（渲染后的正文、标签、修改时间、一键「在 TW 打开」）。
2. **真·原生渲染**：wiki 文本（`[[链接]]`、`{{嵌入}}`、宏、过滤器、表格）在**正在运行的 TW 实例**里渲染成 HTML 片段，而不是客户端弱实现。
3. **可点击 wiki 链接**：回复流中出现的 wiki 链接（agent 约定的 markdown 链接 + 渲染片段内部链接）点击后跳转到 TW 原生页面（中央面板内对应 tiddler）。

## 2. 已核实的架构事实

| 事实 | 依据 | 对设计的影响 |
|---|---|---|
| `tool.call.toolview` 是 keyed 槽（scope=session），key=wire 工具名，domain 开放；`tiddlywiki_*` 未被占用 | Slots.listSubTree 精确查询 | 注册 `tiddlywiki_get/search/…` 的 key 是**加性**的，不覆盖 shell 内容 |
| 工具卡组件收到 `ToolCallOwnerProps = {callId, toolName, block, cwd?, home?, openFile, inspect?}`；`block = RunningToolCall \| ToolResultNode`；settled 含 `call:{name,argsRaw}`、`content` | dsh-client-ui-conversation contract/records.d.ts | 卡片可从 `argsRaw` 解析出标题/查询，再取全量数据渲染 |
| TW5 服务端路由 = module-type `route` 模块，POST body 经 `state.data` | core-server/server/server.js L76；put-tiddler.js | seed 一个含 `server-routes/render.js` 的插件即注册新路由 |
| TW5 内核已有原生渲染：`$tw.wiki.renderText("text/html","text/vnd.tiddlywiki", text, opts)` / `renderTiddler` | core-server/routes/get-tiddler-html.js | render 路由插件复用同一 API，输出纯片段 |
| 同源代理 `/dsh-tiddlywiki/tw/*` → 回环 TW，浏览器同源直连 | src/host/routes.ts handleTwProxy | 浏览器 `POST /dsh-tiddlywiki/tw/render` 直达原生渲染，零 CORS |
| Panel iframe 同源；TW 前端用 hash 路由（`#Title` 打开 story） | src/client/panel.ts；editor-popup.ts `twUrl#draftTitle` | 跳转原生页面 = 打开面板 + 设 iframe hash |

## 3. 组件设计

### 3.1 原生渲染路由插件（路径 2a）

新增 seed：`$:/plugins/dsh/render`（对照 `seed-send-to-agent.ts` 的 bundle 先例）。

- `plugin.info`：`{"title":"$:/plugins/dsh/render","plugin-type":"plugin",…}`
- `server-routes/render.js`（module-type: `route`）：
  - `methods = ["POST"]`，`path = /^\/render$/`
  - body（`state.data`，JSON）：`{ "title" }`（渲染一个 tiddler）或 `{ "text", "contextTitle"? }`（渲染任意 wiki 文本，可给 `currentTiddler` 变量）
  - 实现：`var html = $tw.wiki.renderText("text/html", "text/vnd.tiddlywiki", text, { parseAsInline: true, variables: { currentTiddler: title } })`
  - 返回 `text/html` **纯片段**（无 `<html>`/`<head>`/`<body>` 包装）
- **链接改写**（让片段内 `[[Foo]]` 可点击跳原生页）：把 wiki 链接的 href 统一写为 `/dsh-tiddlywiki/tw/#<title>`（同源代理 hash）。首选方案：在渲染变量里设 wikilink 模板（`tv-wikilink-template` 指向 `$uri$` 前缀路径，仿内核静态模板 `$uri_doubleencoded$.html` 机制）；若编码语义难控，则在返回前做一次服务端字符串重写 `href="#…"` → `href="/dsh-tiddlywiki/tw/#…"`。**实现时先验证 wikilink 模板的实际输出再定**。
- **激活**：服务路由在 TW **启动时**加载，所以 seed 写入后需 `server.restart()` 一次（index.ts 已有 `ensureLanguage` 的 `if (changed) await server.restart()` 先例）。首次安装：start → seed → restart；设置页「重新初始化」同样处理。

### 3.2 工具卡原生视图（路径 1）

在 client 半身注册 `tool.call.toolview`，为以下工具各注册一个 key：

| 工具 key | 卡片内容 | 数据来源 |
|---|---|---|
| `tiddlywiki_get` | 原生渲染正文 + 标签 chips + 修改时间 + 「在 TW 打开」 | 从 `block.call.argsRaw` 解析 `title` → `GET /dsh-tiddlywiki/get?title=`（现有路由）取全量 → `POST /dsh-tiddlywiki/tw/render {title}` 渲染片段；服务不可用时降级显示 `block.content` 文本 |
| `tiddlywiki_search` | 结果行（标题/标签/摘要），每行可点跳转 | 需新增 `GET /dsh-tiddlywiki/search`（镜像 tools.ts 逻辑）或复用 `GET /dsh-tiddlywiki/recent` 范式 |
| `tiddlywiki_recent` | 最近笔记列表，可点跳转 | `GET /dsh-tiddlywiki/recent`（现有） |
| `tiddlywiki_list_tags` | 标签计数列表 | `GET /dsh-tiddlywiki/tags`（现有） |
| `tiddlywiki_put` / `batch_put` | 确认卡 + 「查看」按钮（跳转新建/写入的 tiddler） | 从 `argsRaw` 解析标题 → 跳转 |
| `git_sync` / `git_resolve` / `rename` / `delete` | 轻量状态卡（可选，先用通用卡） | `block.content` |

注册：`ctx.slots.register({ name: 'tool.call.toolview', key: 'tiddlywiki_get' }, TiddlyGetterCard)`。注意本插件的 client 入口用的是**普通 DOM + React 仅用于 settings.section**；`tool.call.toolview` 组件是 **React 组件**（owner 是 shell 的 React 树），因此新增的卡片组件必须写成 React 组件并用 `React.createElement`（不引 JSX；tsdown 不转译 JSX）。构建仍走现有 client bundle（React 由 web app 运行时解析，`neverBundle: ['react']` 已配置）。

### 3.3 可点击 wiki 链接（跳转原生页面）

两层，共用同一个拦截器：

- **agent 约定链接**：在系统提示（`PROMPT_TEXT`）中加一条约定——引用 wiki 笔记时用 markdown 链接 `[标题](/dsh-tiddlywiki/tw/#标题)`（同源代理 hash）。
- **渲染片段内链接**：由 3.1 的链接改写统一生成同一形状的 href。
- **全局 click 拦截器**（document capture 阶段，纯加性，不动 shell 渲染器）：
  - 命中 `a[href^="/dsh-tiddlywiki/tw/"]` 且带 `#` → `preventDefault()`，调用面板跳转。
  - 面板跳转：`state.openPanel()`；随后把 panel iframe 导航到对应 tiddler——**首选** `iframe.contentWindow.location.hash = '#Title'`（同源，TW 监听 hashchange 打开 story，且不重载 iframe、不丢编辑）；不可行时降级 `iframe.src = twProxy + '#Title'`（重载一次，TW 自动保存 draft，可接受）。**实现时先验证 contentWindow.hash 路径**。

### 3.4 数据流

```
[agent 调 tiddlywiki_get]  →  [流中渲染 tool.call.toolview 卡]
       ↓ block.call.argsRaw.title
[client 卡] --GET /dsh-tiddlywiki/get?title=--> [host] --TiddlyWeb--> [TW child]
       ↓ full tiddler (text/tags/modified)
[client 卡] --POST /dsh-tiddlywiki/tw/render {title}--> [proxy] --> [TW native renderText]
       ↓ HTML 片段（链接已改写为 /dsh-tiddlywiki/tw/#…）
[React 卡渲染 dangerouslySetInnerHTML]  ← 信任边界：wiki 是本地可信内容（与嵌入编辑器同信任级）
       ↓ 用户点击片段内链接
[document click 拦截器] → preventDefault → panel.openPanel + iframe.hash → TW 原生页面
```

## 4. 信任与安全

- 渲染的 HTML 来自**本地 wiki**，信任级别与中央列嵌入编辑器相同；可接受 `dangerouslySetInnerHTML`。文档注明：若将来 wiki 含不可信来源内容，需先 sanitize。
- render 路由插件随 wiki 的 git 同步（`$:/plugins/dsh/render` 是普通 tiddler），与 send-to-agent 同理。

## 5. 明确的边界

- **流式正文内部注入原生卡**：`conversation.chat.node` 的 `assistant-step` 槽被 shell 占用（replaceRisk=shadows-shipped-ui），接管属替换风险，**不做**。原生内容落在**工具调用点**（天然随流出现）与**片段内链接**。
- 不做 turnTail「相关笔记」汇总（本轮范围外，可后续再加）。

## 6. 实施步骤（建议顺序）

1. `src/host/seed-render.ts`（新）：render 插件 bundle + `seedRenderRoute(client,{force})` + marker，完全对照 `seed-send-to-agent.ts`。
2. `src/host/seeds.ts`：注册 `render-route` seed（check + run）。
3. `src/index.ts`：seed 后若 `wrote` → `server.restart()`；`PROMPT_TEXT` 追加链接约定。
4. `src/host/routes.ts`：新增 `GET /dsh-tiddlywiki/search`（镜像 tools.ts 的 search 逻辑，供 search 卡片用）。
5. `src/client/tool-views.ts`（新）：React 组件 + 注册辅助（`React.createElement`，无 JSX）。
6. `src/client/index.ts`：注册各工具 key + 全局 click 拦截器。
7. `src/client/panel.ts`：增加 `openTiddler(title)`（openPanel + iframe hash），并在 reload 事件路径上兼容。
8. `src/client/styles.ts`：卡片样式。
9. 验证：`npm run typecheck`、`npm run build`、selftest 扩展（seed render → POST /render 断言片段含原生渲染）；可选浏览器 verify（工具卡渲染 + 链接跳转）。

## 7. 相关文件（现状）

- seed 先例：`src/host/seed-send-to-agent.ts`（bundle + marker + force）
- seed 注册表：`src/host/seeds.ts`（SEED_DEFS）
- 启动装配：`src/index.ts`（seed 在 server.start 后跑；ensureLanguage 的 restart 先例）
- 路由：`src/host/routes.ts`（handleTwProxy / get / recent / tags）
- 面板：`src/client/panel.ts`（iframe 同源，`data-dsh-tw-active`）
- 客户端构建：`tsdown.client.config.ts`（`neverBundle: ['react']`，minify）
- 槽位契约：`tool.call.toolview`（keyed, session, key=wire tool name, open domain）

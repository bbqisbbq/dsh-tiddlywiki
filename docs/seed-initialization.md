# 统一 seed 注册表 & 后台「重新初始化 / 反初始化」

> 本文档说明 dsh-tiddlywiki 的「一次性预置」机制：哪些东西需要随插件初始化写入 wiki、它们与 dsh 的联动关系、**核心项 / 起步项 / 可选项**三层划分、ONE-SHOT / force / remove 语义、后台 API 与设置页操作，以及开发时如何重新生成内置常量。
>
> 版本沿革：v0.10.0 引入统一注册表 + 后台「重新初始化」；v0.13.0 新增 `menubar-theme` seed；v0.15.0 拆成核心/可选两层；**v0.16.22 引入「起步项」（starter）层 + 文档合集约定**——启动除功能必需项外，还默认写入**插件说明 + 示例与文档**（两者都带 `dsh-docs` 标签，自动汇聚到首页「📚 插件文档」栏），且全部带**安全跳过**（同名 tiddler 已存在绝不覆盖用户数据）；同时新增 `ui-styles`（自定义样式）可选 seed，seed 版首页剥离作者私有人口（主题页 tabs / 书籍书架）。

---

## 1. 背景：为什么需要 seed

插件与 dsh 有多个联动功能，**前提是 wiki 里存在特定 tiddler / 配置**。这些项历史上靠手工往 wiki 里塞（只存在于个别 wiki 的 git 历史中），**初次安装插件的新用户拿不到**，导致联动功能残缺：

| 联动功能 | 依赖的 wiki 预置 | 缺失时的表现 | 层级 |
|---|---|---|---|
| 一键发送给 Agent | `$:/plugins/dsh/send-to-agent` 按钮插件 | TW 工具栏没有「发送给 Agent」按钮，后端路由在但无入口 | **核心**（功能必需） |
| 嵌入式 TW 编辑器 | `$:/config/tiddlyweb/host` 指向同源代理 | iframe 里的 TW 前端 API 基址指向错误的 origin，编辑/保存失效 | **核心**（功能必需） |
| 回复流卡片 / wiki 链接直达 | `$:/plugins/dsh/render` 服务端渲染路由 | 工具卡与 wiki 链接不能原生渲染 | **核心**（功能必需） |
| 新手说明 | 「dsh-tiddlywiki 插件说明」笔记（tag `docs` + `dsh-docs`） | 新用户没有入门说明 | **起步**（首次安装默认写，可反初始化） |
| 文档中心起步包 | 「示例与文档」：主题汇总页·模板、教程（按主题/标签做汇总页）、三个示例主题页（日志 / 决策记录 / 排障）——全带 `dsh-docs` 标签 | 新用户没有「一页多主题 / 按标签汇总」的现成范例 | **起步**（首次安装默认写，可反初始化） |
| 首页（待办四象限 / 标签统计 / Agent 区块 / 📚 插件文档栏） | 「🏠 主页」「所有标签」「标签笔记」三个 tiddler + `$:/DefaultTiddlers` → 🏠 主页 | 没有承诺的首页；TW 打开的是 GettingStarted | 可选（不强制） |
| 所有文章（两列分页总览） | 「所有文章」tiddler | 没有一键总览全部条目的入口 | 可选（不强制） |
| 自定义样式（编辑器美化等 5 张样式表） | `编辑器美化 CSS`、`标题与按钮区分开`、`侧边栏窄屏自动隐藏.css`、`批注弹窗样式`、`menubar 顶栏加高样式`（tag `$:/tags/Stylesheet`） | 编辑器/窄屏侧栏没有作者沉淀的易用性调优 | 可选（不强制） |
| menubar 顶栏主题自适应 | `$:/plugins/dsh-tiddlywiki/menubar-theme` 样式表（tag `$:/tags/Stylesheet`） | tiddlywiki/menubar 顶栏停留在默认色映射的蓝色（`$:/config/DefaultColourMappings/` → `#5778d8`） | 可选（不强制） |

**v0.16.22 分层原则：**
- **核心**（启动自动写、不可反初始化）：与插件自身功能强关联，缺了功能就残缺；
- **起步**（启动自动写、可反初始化）：无副作用的说明/示例/模板文档，让新 wiki 开箱即有一个像样的「文档中心」；全部**安全跳过**——同名 tiddler 已存在就不写，绝不覆盖用户真实内容；
- **可选**（默认不自动写，设置页手动「重新初始化」/「反初始化」）：首页、总览页、样式等外观/导航类内容，不给用户强绑定。

> 💡 **文档合集约定（dsh-docs）**：以后新增任何「TW 侧功能说明 / 配置说明 / 模板 / 示例」类内容，都按 seed 方式随插件发布（避免覆盖用户数据），并打上 **`dsh-docs`** 标签——首页「📚 插件文档」栏的 tabs 筛选器（`[tag[dsh-docs]!is[system]]`）会自动收录，用户无需任何配置即可在首页查阅。

---

## 2. 统一 seed 注册表（`SEED_DEFS`）

源码：`src/host/seeds.ts`。每一项是一个 `SeedDef`：

```ts
interface SeedDef {
  id: string                              // doc-note / send-to-agent / home-index / tw-web-host
  title: string                           // 设置页显示名
  description: string                     // 说明
  core: boolean                           // true=功能必需（启动自动 seed）；false=可选（不强制，可反初始化）
  check(ctx): Promise<SeedStatus>         // 当前状态（present / removable / detail），供 UI 展示
  run(ctx, force): Promise<SeedRunResult> // 执行；force=false 保持 ONE-SHOT，force=true 重写内置内容
  remove?(ctx): Promise<SeedRunResult>    // 反初始化：删除写入的 tiddler + marker（仅可选 seed 实现）
}
```

| id | 实现 | 写什么 | marker | 层级 |
|---|---|---|---|---|
| `doc-note` | `seed-notes.ts` → `seedDocNote` / `unseedDocNote` | 「dsh-tiddlywiki 插件说明」（tag `docs` + `dsh-docs`） | `$:/plugins/dsh-tiddlywiki/seed-doc-note` | **起步** |
| `starter-docs` | `seed-starter-docs.ts` → `seedStarterDocs` / `unseedStarterDocs` | 「主题汇总页·模板」+「教程：按主题/标签做汇总页」+「主题页·日志 / 决策记录 / 排障」示例（全带 `dsh-docs`，教程为净化版文案） | `$:/plugins/dsh-tiddlywiki/seed-starter-docs` | **起步** |
| `send-to-agent` | `seed-send-to-agent.ts` → `seedSendToAgent` | `$:/plugins/dsh/send-to-agent` 按钮 bundle（`application/json`） | `$:/plugins/dsh-tiddlywiki/seed-send-to-agent` | **核心** |
| `render-route` | `seed-render.ts` → `seedRenderRoute` | `$:/plugins/dsh/render` 服务端渲染路由 bundle（`application/json`） | `$:/plugins/dsh-tiddlywiki/seed-render` | **核心** |
| `home-index` | `seed-home.ts` → `seedHomeIndex` / `unseedHomeIndex` | 「🏠 主页」+「所有标签」+「标签笔记」（tag `索引`，标题/标签跟随生成时的 wiki 现状），并把 `$:/DefaultTiddlers` 指向 `[[🏠 主页]]` | `$:/plugins/dsh-tiddlywiki/seed-home-index` | 可选 |
| `all-articles` | `seed-all-articles.ts` → `seedAllArticles` / `unseedAllArticles` | 「所有文章」（tag `索引`）——两列分页总览，每页条数实时读 `ui.allArticles.pageSize`（默认 10） | `$:/plugins/dsh-tiddlywiki/seed-all-articles` | 可选 |
| `ui-styles` | `seed-ui-styles.ts` → `seedUiStyles` / `unseedUiStyles` | 5 张通用样式表（只带功能 tag `$:/tags/Stylesheet`，剥离 wiki 本地标签与个人数据）：编辑器美化、标题与按钮区分开、侧边栏窄屏自动隐藏、批注弹窗、menubar 顶栏加高 | `$:/plugins/dsh-tiddlywiki/seed-ui-styles` | 可选 |
| `menubar-theme` | `seed-menubar-theme.ts` → `seedMenubarTheme` / `unseedMenubarTheme` | `$:/plugins/dsh-tiddlywiki/menubar-theme`（tag `$:/tags/Stylesheet`）——覆盖 tiddlywiki/menubar 顶栏：把 `<<colour menubar-background>>` 的「默认色映射蓝色」改为跟随活动 palette 的 `background`/`foreground`，随 DSH 主题切换（`$:/palette` 翻转）自动换色 | `$:/plugins/dsh-tiddlywiki/seed-menubar-theme` | 可选 |
| `clip-bridge` | `seed-clip-bridge.ts` → `seedClipBridge` / `unseedClipBridge` | 「本地剪藏桥 + 书签小工具」使用说明（Markdown 文档，带书签代码 / 启用步骤 / 安全说明，tag `dsh-docs`）——真功能在 `clip-bridge.ts` 运行时代码里 | `$:/plugins/dsh-tiddlywiki/seed-clip-bridge` | 可选 |
| `tw-web-host` | `seeds.ts` 内联 | `$:/config/tiddlyweb/host` → `/dsh-tiddlywiki/tw/` | 无 marker（ensure 型，见 §4） | **核心** |

> ℹ️ `home-index` 的 seed 版首页是**通用版**：生成脚本**默认**剥离作者 wiki 里的个人元素（主题页 tabs、书籍书架入口等，仅 `--keep-private` 才原样嵌入），并内置「📚 插件文档」tabs 栏（`[tag[dsh-docs]!is[system]]`，默认展开插件说明）。作者自己的 wiki 首页不受影响（seed 是 ONE-SHOT，不会覆盖）。
>
> ℹ️ **v0.22.0 起 marker 记内容哈希**：marker tiddler（`$:/plugins/dsh-tiddlywiki/seed-*`）的正文从一行 `seeded-once` 升级为 JSON `{ version, hashes: { <标题>: <sha256 前 16 位> }, at }`——哈希记录的是**我们写下的内置正文**，据此可区分「内置内容更新了」与「用户自己改过」（见 §3.1）。旧 marker 仍可读，按文本比对，并在下一次重新初始化时升级。
>
> ℹ️ **v0.22.0 起 `doc-note` 正文是生成的**：工具清单来自 `tiddlywikiToolSummary()`（`docNoteText(tools)`），不再手抄「N 个 agent 工具」。无注册表的 headless 调用会退化成一句指针，绝不写出过期数量。

### 统一入口（`src/index.ts` 导出）

- `runAllSeeds(ctx)` —— **启动路径**：**seed 核心项 + 起步项**（`core: true` 的发送给 Agent 按钮 / 原生渲染路由 / TW 前端 API 基址，`startup: true` 的插件说明 / 示例与文档），全部非 force（只写缺失，同名 tiddler 已存在即安全跳过）。可选项**不自动写入**。启动时序在 `configStore.load()` 之后、`bootstrapGit()` 之前，保证 seed 写入的内容进入首次 git 提交。
- `checkAllSeeds(ctx)` —— 返回每项当前状态数组（设置页「初始化」区块数据源，含 `removable` 标记）。
- `runSeedById(ctx, id?, force)` —— 单跑（`id` 指定）或全跑（`id` 为 `undefined`）；`force` 为手动「重新初始化」；未知 `id` 返回显式错误结果而非抛异常。
- `removeSeedById(ctx, id?)` —— **反初始化**：删除单个（或全部）可选 seed 写入的 tiddler + marker，恢复「从未初始化」状态；核心项拒绝移除。

---

## 3. ONE-SHOT 语义（非 force）

**核心原则：seed 只提供一次，之后内容归用户所有。**

- **marker 门控**（doc-note / starter-docs / send-to-agent / home-index / all-articles / ui-styles / menubar-theme）：首次执行写入内容 + 写 marker；此后只要 marker 在，seed 就**不再写**（无论目标 tiddler 是否存在）。
- **用户删除 tiddler 后，重启不会复活**（marker 仍在）——这是刻意的：用户删掉 = 不想要。
- **用户编辑过 tiddler，永远不会被启动 seed 覆盖**（marker 在，seed 根本不触碰）。
- **升级兼容**：老 wiki 已有这些 tiddler（旧版本手工放的）时，首次执行只补写 marker、不覆盖现有内容，从这一刻起同样归用户所有。起步项（doc-note / starter-docs）在**首次安装/升级后启动**时也是这个逻辑：**同名 tiddler 已存在 = 你自己的数据，安全跳过，绝不覆盖**。

**tw-web-host 例外**：它不是 marker 型，而是 **ensure 型**——非 force 时仅在 **tiddler 缺失**或**仍是旧默认值**（`$protocol$//$host$/`）时写入代理路径；**用户自定义的其它基址会被保留**（例如确实在专属域名上暴露 TW 的场景）。

---

## 3.1 内容哈希与「更新检测」（v0.22.0）

seed 是 ONE-SHOT，所以**插件升级后旧 wiki 的内容不会自动更新**——这正是「插件说明里写着 10 个工具、实际已有 15 个」这类问题的根源。v0.22.0 让检测变成可能，但**不改变 ONE-SHOT 的安全性**：

| 判定 | 条件 | 设置页表现 |
|---|---|---|
| 内置内容有更新 | marker 记录的哈希 ≠ 当前内置正文的哈希 | 「⬆ 有更新」chip，按钮变为「更新到内置版本」 |
| 用户改过 | 当前 tiddler 正文的哈希 ≠ marker 记录的哈希 | 「✏️ 本地已修改」chip；覆盖前**二次确认** |
| 两者都不是 | 哈希一致 | 无 chip |
| 旧 marker（无哈希） | marker 不是我们的 JSON | 「更新检测尚未启用（重新初始化一次即可）」 |
| 旧 marker + 文本已不同 | 无法判断是用户改的还是内置变了 | 报 `updateAvailable` 且 `userModified: undefined`（**无法确认**），UI 明说可能覆盖你的改动 |

三条不容妥协的规则：

1. **绝不猜**：没有哈希就不编造「用户改过」——否则升级后满屏误报；
2. **绝不自动改写**：`updateAvailable` 只是提示，更新必须在设置页手动点（自动更新等于覆盖用户内容）；
3. **哈希只在「写入的确实是我们写的内容」时记录**：`refreshSeedMarker()` 只对「当前正文 === 内置正文」的 tiddler 记哈希，用户改过的副本不进账；已有哈希**合并而非清空**，一次跳过不会忘掉其余条目。

实现：`src/host/seed-util.ts`（`hashText` / `parseSeedMarker` / `readSeedMarker` / `writeSeedMarker`）+ `src/host/seeds.ts` 的 `inspectSeedContent()` / `refreshSeedMarker()`（`SeedDef.markerTitle` + `SeedDef.content` 两个钩子启用检测）。回归在 `scripts/verify-seeds-admin.mjs` 第 9 段（5 组断言：新鲜 / 用户改过 / 内置更新 / 旧标记两种 / 重新初始化后刷新）。

---

## 4. force 语义（手动「重新初始化」）

设置页「初始化」区块的「重新初始化」按钮（以及后台 `POST /admin/seeds/run` 带 `force: true`）触发：

- **无视 marker**：即使已提供过，也会重新执行；
- **覆盖现有内容**：把目标 tiddler 重写为内置内容（会覆盖你对该 tiddler 的改动——按钮点击前有提示文案）；
- **重记 marker**：执行后 marker 重新记录，回到「已提供」状态。

典型使用场景：

- 「我把首页改坏了，想恢复成模板」→ `home-index` 重新初始化（恢复 🏠 主页/所有标签/标签笔记 + `$:/DefaultTiddlers` → 🏠 主页）；
- 「所有文章页被删了 / 改坏了」→ `all-articles` 重新初始化；
- 「编辑器/侧栏/顶栏样式被我改乱了，想恢复初始样式」→ `ui-styles` 重新初始化（恢复 5 张内置样式表）；
- 「教程/模板/示例主题页被我删了，想要回来」→ `starter-docs` 重新初始化；
- 「menubar 顶栏又变回蓝色了 / 样式表被我改了」→ `menubar-theme` 重新初始化（恢复跟随 palette 的样式覆盖）；
- 「发送给 Agent 按钮被我删了 / 改坏了」→ `send-to-agent` 重新初始化；
- 「TW 编辑器打不开，疑似 `$:/config/tiddlyweb/host` 被改错」→ `tw-web-host` 重新初始化（force 强制写回代理基址）；
- 「刚装完发现 wiki 里缺了说明/首页」→ 对应项重新初始化或「全部重新初始化」。

> ⚠️ force 会**覆盖你对目标 tiddler 的编辑**，仅用于明确想要恢复内置内容时。日常「补缺失」不需要 force——启动流程与「全部重新初始化」之外的场景由 ONE-SHOT 语义兜底。

### 反初始化（remove，v0.15.0）

设置页「初始化」区块的「反初始化」按钮（以及后台 `POST /admin/seeds/remove`）触发，**只对可选 seed 提供**：

- 删除该 seed 写入的全部 tiddler **与** 一次性 marker，把 wiki 恢复到「从未初始化」状态；
- 之后该 seed 在设置页状态为「缺失」，需要时可再用「重新初始化」写回；
- `home-index` 反初始化时，若 `$:/DefaultTiddlers` 仍指向 seed 写出的 `[[🏠 主页]]`，一并恢复为 `[[GettingStarted]]`（用户自定义的默认页不受影响）；
- **核心 seed（发送给 Agent 按钮 / 原生渲染路由 / TW 前端 API 基址）不可反初始化**——它们与插件自身功能强关联，移除会破坏对应能力；**起步项（doc-note / starter-docs）与可选项都可反初始化**，「全部反初始化」处理所有非核心 seed。

---

## 5. 后台 API

挂载在插件管理路由下（`ROUTE_PREFIX = /dsh-tiddlywiki`），与设置页同源。

### `GET /dsh-tiddlywiki/admin/seeds`

返回每项实时状态（`checkAllSeeds`）：

```jsonc
{
  "ok": true,
  "items": [
    { "id": "doc-note",      "title": "插件说明笔记",                "description": "…", "present": true,  "removable": true,  "detail": "已存在" },
    { "id": "starter-docs",  "title": "示例与文档（汇总模板 / 教程 / 主题页示例）", "description": "…", "present": true,  "removable": true,  "detail": "已存在" },
    { "id": "send-to-agent", "title": "「发送给 Agent」按钮",         "description": "…", "present": true,  "removable": false, "detail": "已存在" },
    { "id": "home-index",    "title": "首页（主页 / 所有标签 / 标签笔记）", "description": "…", "present": false, "removable": true,  "detail": "缺失：🏠 主页" },
    { "id": "all-articles",  "title": "所有文章（两列分页总览）",       "description": "…", "present": true,  "removable": true,  "detail": "已存在" },
    { "id": "ui-styles",     "title": "自定义样式（编辑器美化 / 窄屏侧栏 / menubar 加高 / 批注弹窗）", "description": "…", "present": true,  "removable": true,  "detail": "已存在" },
    { "id": "menubar-theme", "title": "menubar 顶栏主题自适应",        "description": "…", "present": true,  "removable": true,  "detail": "已存在" },
    { "id": "tw-web-host",   "title": "TW 前端 API 基址（同源代理）",   "description": "…", "present": true,  "removable": false, "detail": "已指向 /dsh-tiddlywiki/tw/" }
  ]
}
```

- `removable: true` = 非核心 seed（起步项 + 可选项，可「反初始化」移除）；`false` = 核心 seed（功能必需，不可移除）。
- wiki 服务未运行时返回 `503 { ok: false, error: "wiki service is not running" }`。

### `POST /dsh-tiddlywiki/admin/seeds/run`

请求体：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string, 可选 | 指定运行单项；缺省 = 全部 |
| `force` | boolean, 默认 false | true = 手动「重新初始化」（重写内置内容）；false = ONE-SHOT（只写缺失） |

响应：

```jsonc
{
  "ok": true,
  "results": [
    { "id": "home-index", "ok": true, "wrote": true, "detail": "已重新初始化" },
    { "id": "tw-web-host", "ok": true, "wrote": false, "detail": "已指向自定义基址，未覆盖" }
  ]
}
```

- `results` 顺序 = 注册表顺序；
- 任一失败 → HTTP `400`，`ok: false`，失败项在 `results[].error` 里有原因；
- 未知 `id` → `400 { ok: false, results: [{ id, ok: false, error: "unknown seed: <id>" }] }`；
- 请求体过大（> 1MB）或非法 JSON → `400`。

### `POST /dsh-tiddlywiki/admin/seeds/remove`

反初始化（v0.15.0）。请求体：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string, 可选 | 指定移除单项；缺省 = 全部可选 seed |

响应与 `/admin/seeds/run` 同构（`results[]`）：

```jsonc
{
  "ok": true,
  "results": [
    { "id": "menubar-theme", "ok": true, "wrote": false, "detail": "已移除：$:/plugins/dsh-tiddlywiki/menubar-theme、$:/plugins/dsh-tiddlywiki/seed-menubar-theme" }
  ]
}
```

- 核心 seed（发送给 Agent 按钮 / TW 前端 API 基址）**不可移除**——指定它们 → `400 { ok: false, results: [{ id, ok: false, error: "该 seed 为核心项（功能必需），不可反初始化" }] }`；「全部反初始化」会自动跳过核心项；
- 未知 `id` → `400`，`error: "unknown seed: <id>"`；
- wiki 服务未运行时 → `503`。

---

## 6. 设置页操作

DSH 设置 →「TiddlyWiki 知识库」→ 最底部「**初始化（一次性预置）**」区块：

- 顶部状态行：`共 N 项，M 项已就绪；可移除 K 项`；
- 每项一行：状态点（✓ 已就绪 / ✗ 缺失）+ 名称 + 实时详情（如缺失了哪个 tiddler）+ 「重新初始化」按钮；**可选 seed 另有「反初始化」按钮**（核心 seed 不显示）；
- 底部：「**全部重新初始化**」按钮（force 全部）+「**全部反初始化**」按钮（移除全部可选 seed，核心项保留；点击前有确认弹窗）。

前端源码：`src/client/settings-page.ts` 的 `renderSeedsSection`；样式 `src/client/styles.ts`（状态点 `ok` / `missing`、危险按钮 `dsh-tw-settings-danger`）。

---

## 7. 开发：重新生成内置常量

seed 的内容以**内嵌常量**形式随插件发布，修改来源后需重新生成：

```bash
# 改了「发送给 Agent」按钮的源件（scripts/bundle/send-to-agent/ 下 startup.js / button.tid /
# icon.svg / item-template.tid）——三段式：build → gen → verify：
node scripts/build-send-to-agent-bundle.mjs                                                     # 1) build → scripts/bundle/send-to-agent.bundle.json
node scripts/gen-seed-send-to-agent.mjs scripts/bundle/send-to-agent.bundle.json src/host/seed-send-to-agent.ts   # 2) gen → 内嵌常量（外层 version 从 bundle 内层 plugin.info 读取）
node scripts/verify-send-to-agent-bundle.mjs                                                    # 3) verify（字段 + 源件逐字一致 + 版本常量）

# 改了原生渲染路由源件（scripts/bundle/render/server-routes/render.js）——同样三段式：
node scripts/build-render-bundle.mjs                                                            # 1) build → scripts/bundle/render.bundle.json
node scripts/gen-seed-render.mjs scripts/bundle/render.bundle.json src/host/seed-render.ts      # 2) gen（外层 version 同样从 bundle 内层 plugin.info 读取）
# 3) verify：无独立 verify 脚本，/render 行为由 selftest 5c2 段覆盖
#    （两个 bundle 的版本号单一来源：scripts/bundle/versions.mjs）

# 改了 wiki 首页（🏠 主页 / 所有标签 / 标签笔记）：
#   默认即剥离作者私有人口（主题页 tabs / 主题汇总死链 / 书籍书架）并注入「📚 插件文档」tabs 栏，
#   产出通用版 seed 首页；仅作者本机想原样嵌入时才传 --keep-private（绝不用于发布）。
node scripts/gen-seed-home.mjs '<wiki>/tiddlers/🏠 主页.tid' '<wiki>/tiddlers/所有标签.tid' '<wiki>/tiddlers/标签笔记.tid' src/host/seed-home.ts

# 改了 wiki 里的自定义样式（.css + .meta，tag 只保留 $:/tags/Stylesheet）：
node scripts/gen-seed-ui-styles.mjs '<wiki>/tiddlers/编辑器美化 CSS.css' '<wiki>/tiddlers/标题与按钮区分开.css' '<wiki>/tiddlers/侧边栏窄屏自动隐藏.css' '<wiki>/tiddlers/批注弹窗样式.css' '<wiki>/tiddlers/menubar 顶栏加高样式.css' src/host/seed-ui-styles.ts

# 「所有文章」页的内容维护在 src/host/seed-all-articles.ts 的 ALL_ARTICLES_TEXT
# （来源：<wiki>/tiddlers/所有文章.tid；改 wiki 页后同步手工更新该常量）。

# 「示例与文档」（starter-docs）与「menubar 顶栏主题自适应」的内容维护在
# src/host/seed-starter-docs.ts / seed-menubar-theme.ts（手工维护的净化常量，
# 教程文案已剔除对私有/不存在页面的引用；改内容后直接改这两个文件）。

# 重新生成后务必：
npm run typecheck && npm run build && npm run selftest
```

> PowerShell 注意：含空格/中文的 wiki 路径（如 `'<wiki>/tiddlers/menubar 顶栏加高样式.css'`）要用**单引号**包裹，否则会被拆成多个参数。

**文档合集约定（日常新增文档 seed 时）**：任何新的 TW 侧说明/模板/示例类内容，都走 seed（ONE-SHOT + 同名跳过），并给 tiddler 打 **`dsh-docs`** 标签——首页「📚 插件文档」栏自动收录，用户无需配置。doc-note 与 starter-docs 是 `startup: true` 起步项（首次安装默认写入），其余文档类内容按需要可设起步或可选。

新增一个 seed 的步骤：

1. 写实现（或复用现有 `seedXxx(client, { force? })` 模式；非核心 seed 再补 `unseedXxx(client)` 返回 `{ removed: string[] }`）；
2. 在 `src/host/seeds.ts` 的 `SEED_DEFS` 里登记（`core` + `startup` + `check` + `run`，非核心 seed 加 `remove`）；
3. 核心/起步 seed 会被启动路径 `runAllSeeds` 自动覆盖；可选 seed 仅设置页手动触发；
4. selftest 增加对应断言段，跑 `verify-seeds-admin.mjs` 验证后台 API；
5. bump 版本、更新本文档与 README。

---

## 8. 验证

- `npm run typecheck` / `npm run build`：编译与打包；
- `npm run selftest`：5d 段覆盖注册表清单（10 项，含 `core` / `removable` / `startup`）、**启动只 seed 核心 + 起步项（5 项）且不碰可选项**、手动全跑只写缺失、单跑幂等、force 重写、unknown id、tw-web-host 三分支（custom 保留 / force 写回 / legacy 修复）、**反初始化**（单移除 / 核心拒绝 / unknown / 全部移除保留核心）——另含 starter-docs 安全跳过、ui-styles 仅功能 tag、seed 版首页剥离私有人口 + 文档栏等断言；
- `node scripts/verify-seeds-admin.mjs`：全新 wiki + 真实 HTTP，端到端验证 `GET /admin/seeds` 状态流转（10 项全缺失 → 启动后核心+起步就绪、可选项仍缺失）与 `POST /admin/seeds/run`（force 单跑恢复被改坏的首页、非 force 不覆盖用户内容、force-all 恢复代理基址、unknown id 400）+ `POST /admin/seeds/remove`（移除非核心、核心 400、remove-all 仅剩核心）。

---

## 9. 生效方式

- seed 注册表属插件源码逻辑：**重启 dsh web** 后生效（会中断当前会话，注意时机）。
- 本 wiki（已存在上述 tiddler）：重启后启动路径**只补核心项与起步项**（发送给 Agent 按钮 / 原生渲染路由 / TW 前端 API 基址 / 插件说明 / 示例与文档，缺才写、同名跳过），**不覆盖任何现有内容**；可选项维持现状，可在设置页「初始化」手动「重新初始化」或「反初始化」。
- 新装 wiki：首次启动自动获得**核心预置**（发送按钮 + 渲染路由 + 代理基址）与**起步文档**（插件说明 + 示例与文档）；首页 / 所有文章 / 自定义样式 / menubar 顶栏主题自适应为可选项，需要时在设置页写入，不想要也不会被强制。

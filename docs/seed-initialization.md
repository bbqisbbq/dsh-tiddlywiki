# 统一 seed 注册表 & 后台「重新初始化」

> 本文档说明 dsh-tiddlywiki **v0.10.0** 引入的「一次性预置」机制：哪些东西需要随插件初始化写入 wiki、它们与 dsh 的联动关系、ONE-SHOT / force 语义、后台 API 与设置页操作，以及开发时如何重新生成内置常量。

---

## 1. 背景：为什么需要 seed

插件与 dsh 有多个联动功能，**前提是 wiki 里存在特定 tiddler / 配置**。这些项历史上靠手工往 wiki 里塞（只存在于个别 wiki 的 git 历史中），**初次安装插件的新用户拿不到**，导致联动功能残缺：

| 联动功能 | 依赖的 wiki 预置 | 缺失时的表现 |
|---|---|---|
| 一键发送给 Agent | `$:/plugins/dsh/send-to-agent` 按钮插件 | TW 工具栏没有「发送给 Agent」按钮，后端路由在但无入口 |
| 首页（Agent 区块 / 标签统计） | 「所有标签」「标签笔记」两个 tiddler | 系统提示承诺的「首页把 Agent 笔记单独列在 Agent 区块、主标签列表只统计人类笔记」完全不存在 |
| 嵌入式 TW 编辑器 | `$:/config/tiddlyweb/host` 指向同源代理 | iframe 里的 TW 前端 API 基址指向错误的 origin，编辑/保存失效 |
| 新手引导 | 「dsh-tiddlywiki 插件说明」笔记 | 新用户没有入门说明 |

v0.10.0 把**全部**这类项收进一个**统一 seed 注册表**，随插件首次启动自动预置；并给后台加「重新初始化」能力，让缺失/被改坏的项可以随时由用户手动恢复。

---

## 2. 统一 seed 注册表（`SEED_DEFS`）

源码：`src/host/seeds.ts`。每一项是一个 `SeedDef`：

```ts
interface SeedDef {
  id: string                              // doc-note / send-to-agent / home-index / tw-web-host
  title: string                           // 设置页显示名
  description: string                     // 说明
  check(ctx): Promise<SeedStatus>         // 当前状态（present / detail），供 UI 展示
  run(ctx, force): Promise<SeedRunResult> // 执行；force=false 保持 ONE-SHOT，force=true 重写内置内容
}
```

| id | 实现 | 写什么 | marker |
|---|---|---|---|
| `doc-note` | `seed-notes.ts` → `seedDocNote` | 「dsh-tiddlywiki 插件说明」（tag `docs`） | `$:/plugins/dsh-tiddlywiki/seed-doc-note` |
| `send-to-agent` | `seed-send-to-agent.ts` → `seedSendToAgent` | `$:/plugins/dsh/send-to-agent` 按钮 bundle（`application/json`） | `$:/plugins/dsh-tiddlywiki/seed-send-to-agent` |
| `home-index` | `seed-home.ts` → `seedHomeIndex` | 「所有标签」+「标签笔记」（tag `索引`） | `$:/plugins/dsh-tiddlywiki/seed-home-index` |
| `tw-web-host` | `seeds.ts` 内联 | `$:/config/tiddlyweb/host` → `/dsh-tiddlywiki/tw/` | 无 marker（ensure 型，见 §4） |

### 统一入口（`src/index.ts` 导出）

- `runAllSeeds(ctx)` —— **启动路径**：四项全部非 force 执行（只写缺失）。启动时序在 `configStore.load()` 之后、`bootstrapGit()` 之前，保证 seed 写入的内容进入首次 git 提交。
- `checkAllSeeds(ctx)` —— 返回每项当前状态数组（设置页「初始化」区块数据源）。
- `runSeedById(ctx, id?, force)` —— 单跑（`id` 指定）或全跑（`id` 为 `undefined`）；`force` 为手动「重新初始化」；未知 `id` 返回显式错误结果而非抛异常。

---

## 3. ONE-SHOT 语义（非 force）

**核心原则：seed 只提供一次，之后内容归用户所有。**

- **marker 门控**（doc-note / send-to-agent / home-index）：首次执行写入内容 + 写 marker；此后只要 marker 在，seed 就**不再写**（无论目标 tiddler 是否存在）。
- **用户删除 tiddler 后，重启不会复活**（marker 仍在）——这是刻意的：用户删掉 = 不想要。
- **用户编辑过 tiddler，永远不会被启动 seed 覆盖**（marker 在，seed 根本不触碰）。
- **升级兼容**：老 wiki 已有这些 tiddler（旧版本手工放的）时，首次执行只补写 marker、不覆盖现有内容，从这一刻起同样归用户所有。

**tw-web-host 例外**：它不是 marker 型，而是 **ensure 型**——非 force 时仅在 **tiddler 缺失**或**仍是旧默认值**（`$protocol$//$host$/`）时写入代理路径；**用户自定义的其它基址会被保留**（例如确实在专属域名上暴露 TW 的场景）。

---

## 4. force 语义（手动「重新初始化」）

设置页「初始化」区块的「重新初始化」按钮（以及后台 `POST /admin/seeds/run` 带 `force: true`）触发：

- **无视 marker**：即使已提供过，也会重新执行；
- **覆盖现有内容**：把目标 tiddler 重写为内置内容（会覆盖你对该 tiddler 的改动——按钮点击前有提示文案）；
- **重记 marker**：执行后 marker 重新记录，回到「已提供」状态。

典型使用场景：

- 「我把首页改坏了，想恢复成模板」→ `home-index` 重新初始化；
- 「发送给 Agent 按钮被我删了 / 改坏了」→ `send-to-agent` 重新初始化；
- 「TW 编辑器打不开，疑似 `$:/config/tiddlyweb/host` 被改错」→ `tw-web-host` 重新初始化（force 强制写回代理基址）；
- 「刚装完发现 wiki 里缺了说明/首页」→ 对应项重新初始化或「全部重新初始化」。

> ⚠️ force 会**覆盖你对目标 tiddler 的编辑**，仅用于明确想要恢复内置内容时。日常「补缺失」不需要 force——启动流程与「全部重新初始化」之外的场景由 ONE-SHOT 语义兜底。

---

## 5. 后台 API

挂载在插件管理路由下（`ROUTE_PREFIX = /dsh-tiddlywiki`），与设置页同源。

### `GET /dsh-tiddlywiki/admin/seeds`

返回每项实时状态（`checkAllSeeds`）：

```jsonc
{
  "ok": true,
  "items": [
    { "id": "doc-note",      "title": "插件说明笔记",            "description": "…", "present": true,  "detail": "已存在" },
    { "id": "send-to-agent", "title": "「发送给 Agent」按钮",     "description": "…", "present": true,  "detail": "已存在" },
    { "id": "home-index",    "title": "首页（所有标签 / 标签笔记）", "description": "…", "present": false, "detail": "缺失：所有标签" },
    { "id": "tw-web-host",   "title": "TW 前端 API 基址（同源代理）", "description": "…", "present": true,  "detail": "已指向 /dsh-tiddlywiki/tw/" }
  ]
}
```

wiki 服务未运行时返回 `503 { ok: false, error: "wiki service is not running" }`。

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

---

## 6. 设置页操作

DSH 设置 →「TiddlyWiki 知识库」→ 最底部「**初始化（一次性预置）**」区块：

- 顶部状态行：`共 N 项，M 项已就绪`；
- 每项一行：状态点（✓ 已就绪 / ✗ 缺失）+ 名称 + 实时详情（如缺失了哪个 tiddler）+ 「重新初始化」按钮；
- 底部：「**全部重新初始化**」按钮（force 全部四项）。

前端源码：`src/client/settings-page.ts` 的 `renderSeedsSection`；样式 `src/client/styles.ts`（状态点 `ok` / `missing`）。

---

## 7. 开发：重新生成内置常量

两个 seed 的内容以**内嵌常量**形式随插件发布，修改来源后需重新生成：

```bash
# 改了 wiki 里的「发送给 Agent」按钮 bundle（$:/plugins/dsh/send-to-agent）：
node scripts/gen-seed-send-to-agent.mjs '<wiki>/tiddlers/$__plugins_dsh_send-to-agent.json' src/host/seed-send-to-agent.ts

# 改了 wiki 首页（所有标签 / 标签笔记）：
node scripts/gen-seed-home.mjs '<wiki>/tiddlers/所有标签.tid' '<wiki>/tiddlers/标签笔记.tid' src/host/seed-home.ts

# 重新生成后务必：
npm run typecheck && npm run build && npm run selftest
```

> PowerShell 注意：含 `$` 的路径（如 `$__plugins_dsh_send-to-agent.json`）要用**单引号**包裹，否则 `$` 会被当作变量展开。

新增一个 seed 的步骤：

1. 写实现（或复用现有 `seedXxx(client, { force? })` 模式）；
2. 在 `src/host/seeds.ts` 的 `SEED_DEFS` 里登记（`check` + `run`）；
3. （若需要展示/强制恢复）确认启动路径 `runAllSeeds` 自动覆盖它；
4. selftest 增加对应断言段，跑 `verify-seeds-admin.mjs` 验证后台 API；
5. bump 版本、更新本文档与 README。

---

## 8. 验证

- `npm run typecheck` / `npm run build`：编译与打包；
- `npm run selftest`：5d 段覆盖注册表清单、runAllSeeds、单跑幂等、force 重写、unknown id、tw-web-host 三分支（custom 保留 / force 写回 / legacy 修复）；
- `node scripts/verify-seeds-admin.mjs`：全新 wiki + 真实 HTTP，端到端验证 `GET /admin/seeds` 状态流转（全缺失 → 启动后全就绪）与 `POST /admin/seeds/run`（force 单跑恢复被改坏的首页、非 force 不覆盖用户内容、force-all 恢复代理基址、unknown id 400）。

---

## 9. 生效方式

- seed 注册表属插件源码逻辑：**重启 dsh web** 后生效（会中断当前会话，注意时机）。
- 本 wiki（已存在上述 tiddler）：重启只补写 marker，**不覆盖现有内容**；要强制恢复内置内容，用设置页「初始化」。
- 新装 wiki：首次启动自动获得全部预置（说明笔记 / 发送按钮 / 首页 / 代理基址），无需手工放 tiddler。

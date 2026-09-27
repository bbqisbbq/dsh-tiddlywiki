# dsh-tiddlywiki 开发与发布

> 从 README 拆出：给维护者。用户不需要读。

需要 **Node.js ≥ 22**。

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run build         # clean + host tsdown + client tsdown + wrap（wrap 会校验 id 与体积 <900KB）
npm run selftest      # headless：spawn TW → REST 读写 → git → 退出回收
npm run smoke:client  # client bundle 的 module-loader 形状冒烟
npm run verify        # = verify:static + verify:unit + verify:e2e（本地一键；CI 同款分档）
npm run verify:large  # 3000+ 条目大 wiki：检索耗时 / 二进制零出现 / 真跑 commit（约 1 分钟）
node scripts/verify-send-to-agent-bundle.mjs  # bundle 字段 + 源件逐字一致
node scripts/verify-seed-send-to-agent.mjs    # 全新 wiki 上的 seed E2E
node scripts/verify-clip-bridge.mjs   # 剪藏桥 headless 验收（含 SSRF 守卫）
node scripts/verify-seeds-admin.mjs   # /admin/seeds 状态与 run 的 E2E
node scripts/verify-prompt.mjs        # 注入提示词守门（slim 无参数清单 / full 与工具注册表逐项一致 / 治理约定不丢）
node scripts/verify-wiki-switch.mjs   # 运行时切换知识库 E2E（真起 TW：切换 / 回滚 / 指针文件 / 非法输入，v0.22.0）
```

> 📦 从 **npm 包**安装的用户只有 `lib/` + `src/` + `docs/`（`scripts/` 不在发布包里，避免把构建脚本塞进依赖树）——想跑上面的验收脚本请用 git 仓库：`git clone https://github.com/bbqisbbq/dsh-tiddlywiki && npm install`。

**改 bundle/seed 的再生成流水线**（不要手改 `seed-*.ts` 里的生成常量；bundle 版本号只在 `scripts/bundle/versions.mjs` 定义一处）：

```bash
# 发送给 Agent 按钮（改 scripts/bundle/send-to-agent/ 后）
node scripts/build-send-to-agent-bundle.mjs
node scripts/gen-seed-send-to-agent.mjs scripts/bundle/send-to-agent.bundle.json src/host/seed-send-to-agent.ts
node scripts/verify-send-to-agent-bundle.mjs

# 渲染路由（改 scripts/bundle/render/server-routes/render.js 后；版本在 versions.mjs）
node scripts/build-render-bundle.mjs
node scripts/gen-seed-render.mjs scripts/bundle/render.bundle.json src/host/seed-render.ts

# 首页（改 wiki 的 🏠 主页/所有标签/标签笔记 .tid 后；默认就剥离作者私有人口 +
# 注入「📚 插件文档」栏，确要保留私有内容才加 --keep-private）
node scripts/gen-seed-home.mjs '<wiki>/tiddlers/🏠 主页.tid' '<wiki>/tiddlers/所有标签.tid' '<wiki>/tiddlers/标签笔记.tid' src/host/seed-home.ts

# 自定义样式（改 wiki 的样式 .css + .meta 后；tag 自动收窄为:/tags/Stylesheet）
node scripts/gen-seed-ui-styles.mjs '<wiki>/tiddlers/<样式.css>' … src/host/seed-ui-styles.ts

# 示例与文档（starter-docs）/ menubar 主题：直接维护 src/host/seed-starter-docs.ts / seed-menubar-theme.ts

# 随后 npm run build
```

**产物约定**：`lib/` 内**零** `@deepseek-ai` 运行时 import；client 必须 minify（否则 >1MB 被注册表校验拒绝）；`react`/`tiddlywiki` 不打包（运行时解析）。

### 路由参考（开发者）

| 路由 | 方法 | 用途 |
|---|---|---|
| `/dsh-tiddlywiki/status` | GET | 面板健康（service/url/git/tag/ui） |
| `/dsh-tiddlywiki/note` `/edit` `/tags` `/recent` `/get` `/search` | POST/GET | 快速笔记、打开编辑器、tag/最近/单个/搜索（列表路由都支持 `limit`；`/tags` 另支持 `sort=alpha\|count` 与 `total`/`truncated`，v0.19.4） |
| `/dsh-tiddlywiki/render` | POST | TW 片段渲染（host 净化后返回，回复流卡片/会话汇总用，v0.19.1） |
| `/dsh-tiddlywiki/sync` `/upload` `/restart` | POST | 一键同步、文件上传、重启 TW |
| `/dsh-tiddlywiki/session/summary` | POST | 会话「知识库」Tab 汇总 |
| `/dsh-tiddlywiki/agent/sessions` `/modes` `/send` `/create` | GET/POST | TW「发送给 Agent」：会话/模式/发送/新建 |
| `/dsh-tiddlywiki/api/*` | any | 透传 TW 服务（JSON） |
| `/dsh-tiddlywiki/tw/*` | any | 同源 TW 代理（远程访问核心） |
| `/dsh-tiddlywiki/admin/seeds` `/run` `/remove` | GET/POST | seed 状态（v0.22.0 起含内容哈希的「有更新 / 本地已修改」）/ 运行 / 反初始化 |
| `/dsh-tiddlywiki/admin/prompt` | GET/POST | 当前注入提示词全文（GET = 已保存的有效配置，v0.21.0）；POST 带 `{enabled,mode,extra,override}` 则按**草稿**渲染、写入零副作用，供设置页预览未保存的表单值（v0.22.7） |
| `/dsh-tiddlywiki/admin/wiki/location` | GET | 当前知识库位置 + 来源（指针/配置/默认）+ 指针文件路径 + 同目录候选 wiki（v0.22.0） |
| `/dsh-tiddlywiki/admin/wiki/switch` `/reset` | POST | 运行时切换知识库 / 恢复为配置默认（失败自动回滚并报告，v0.22.0） |

### 项目结构

```
src/
├── index.ts            # host 入口：装配 WikiServer/路由/工具/提示词/自动 commit
├── sdk.ts              # 自包含 defineTool + dshHomePath（零 @deepseek-ai 运行时依赖）
├── host/
│   ├── wiki.ts         # WikiServer：spawn/kill/自愈/端口探测/就绪轮询（策略见 ready-policy.ts）+ 迟到就绪复探；TW_PROXY_PATH 同源代理
│   ├── ready-policy.ts # TW 启动就绪策略（v0.22.5）：软窗口 60s（可配）/ 硬上限 3× / awaitReady 纯策略（注入时钟，可单测）
│   ├── tw-api.ts       # TiddlyWeb REST 客户端
│   ├── git.ts          # git init/commit/pull/push/sync/status + AutoCommitter
│   ├── routes.ts       # 全部 DSH 路由 + agent-send/create/modes + session/summary
│   ├── http.ts         # 共用 HTTP 助手（readBody/json）
│   ├── clip-bridge.ts  # 本地剪藏桥（v0.16.24）：127.0.0.1 监听 + POST /clip 写 wiki（Host 校验/token/CORS preflight）
│   ├── session-summary.ts # 会话「知识库」Tab 后端
│   ├── admin.ts        # 设置页后台：tiddlywiki.info 读写 + /admin/*
│   ├── config.ts       # ConfigStore：cordis config 基底 + 配置 tiddler 覆盖层
│   ├── seeds.ts        # 统一 seed 注册表（10 项，三层：核心/起步/可选）
│   ├── prompt.ts       # 系统提示词（v0.21.0）：slim/full 两种形态 + extra/override，full 的目录由工具注册表实时生成；v0.22.7 起草稿预览（normalizePromptPreview/describePrompt，与保存路径同一份拼装）
│   ├── seed-*.ts       # 各 seed 实现（bundle/首页/ui-styles 常量脚本生成；starter-docs/menubar/clip-bridge 手工维护）
│   └── tools.ts        # 15 个 tiddlywiki_* 工具（列表式注册）
└── client/             # 浏览器半部
    ├── index.ts        # client 入口（inject ['slots']，纯 DOM，永不 throw）
    ├── endpoints.ts    # 客户端同源端点常量 + describeSyncResult（同步回执唯一实现，v0.22.8）
    ├── status-cache.ts # 共享 /status 读取器（2s TTL + 在途合并）
    ├── ui-config.ts    # 共享 ui.* 投影 + invalidate/subscribeUiConfig（v0.22.8 扩到全部 FAB 开关）
    ├── render-fetch.ts # **唯一**的 POST /render 调用（v0.22.8）
    ├── knowledge-fab.ts / quick-note-dock.ts / note-widget.ts / editor-popup.ts
    │                   # 知识库 FAB / 快捷按钮 / 快速笔记 / 原生编辑弹窗
    ├── markdown-editor.ts  # CodeMirror 6 Markdown 编辑器
    ├── session-summary.ts  # 会话「知识库」Tab（conversation.view 槽位）
    ├── tool-views.ts       # 回复流工具卡片（tool.call.toolview）
    ├── theme-sync.ts / sidebar-entry.ts / sync-button.ts
    │                   # 主题同步 / 侧边栏入口 / 同步按钮
    ├── tw-frame.ts     # **TW frame 内核（v0.22.4 起唯一实现）**：createTwFrameSurface(skin) 管 lazy-load / status 轮询 /
    │                   # 错误与启动态 / 主题同步 / FAB 重载 / hash 导航 / dispose；中央面板与右侧栏共用同一份
    └── panel.ts / rightbar-tab.ts / settings-page.ts / state.ts / styles.ts / toast.ts

> ⚠️ v0.22.8 起 `endpoints.ts` 的 `describeSyncResult()`、`render-fetch.ts`、`ui-config.ts` 各是**唯一实现**：
> 同步回执、渲染调用、`ui.*` 投影都不要再在客户端面里各写一份（此前已因此漂移）。
scripts/                # 构建/校验/再生成脚本
docs/seed-initialization.md  # seed 机制详解（权威）
lib/                    # 预构建产物（发布含 lib/**，提交入库；零 @deepseek-ai 运行时 import）
```

---


```bash
npm publish    # 版本号在 package.json；文件白名单见 files 字段
```

`tiddlywiki` 依赖体较大（含全部语言包/插件）。

---


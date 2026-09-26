# dsh-tiddlywiki

> 把 **TiddlyWiki 5** 变成你和 Agent 之间的**文档中心**：一个嵌在 DSH 里、人手一个的私人知识库——Agent 用 `tiddlywiki_*` 工具读写，你在界面里用完整 TW 编辑器记录，一切通过 **git** 自动同步备份。

[![npm](https://img.shields.io/npm/v/dsh-tiddlywiki)](https://www.npmjs.com/package/dsh-tiddlywiki)
[![license](https://img.shields.io/npm/l/dsh-tiddlywiki)](https://github.com/bbqisbbq/dsh-tiddlywiki/blob/main/LICENSE)
[![GitHub](https://img.shields.io/github/stars/bbqisbbq/dsh-tiddlywiki)](https://github.com/bbqisbbq/dsh-tiddlywiki)

---

## 🗂 它是什么：你的「文档 × Agent」一站式文档中心

这个插件**首先不是一个"AI 记忆工具"**（虽然它顺带就是）。它把一件事做顺了——**文档和人、文档和 Agent 之间的协作**：

- **TiddlyWiki 天生适合当文档中心**：卡片化组织（标签 / 双向链接 / 一键成文 / 一个文件夹就是整个 wiki）、纯文本 git 仓库天然可迁移可备份。它能是你的**私人笔记本**、**GTD 工具**、**Agent 的记忆库**，甚至让 AI 帮你把电子书导入 TW 来阅读批注——**TW + DSH 能做到的唯一限制，只是人类的想象力**。
- **人会参与**：完整 TW 5 编辑器内嵌在 DSH 里，随时翻、随时改、随时批注。文档不是 Agent 写给你的黑盒，而是**方便人类参与的文档中心**。
- **Agent 也能进**：Agent 用 10 个 `tiddlywiki_*` 工具读写；TW 里「发送给 Agent」把笔记一键注入某个会话；每个会话顶部自动汇总它读写过的 wiki 笔记。**切换会话、方案终结、多轮合作，成果最终都回到文档里**——文档成为跨会话、跨 Agent 的公共底座。
- **AI 填平 TiddlyWiki 的门槛**：TW 功能强大但上手有门槛，这正是 AI 擅长的——让 Agent 按你的习惯定制首页、标签体系、样式与工作流。曾经要折腾 Obsidian / Logseq 插件体系才能搭出来的个人知识库，现在**一句话就能初始化一整套开箱即用的文档中心**。

> Obsidian、Logseq 也能做到其中一部分，但**从没有像这样一站式地顺畅**：编辑器、工具、会话、同步、主题全部在同一个界面里闭环。

## ✨ 特性一览

| 能力 | 说明 |
|---|---|
| 🏠 **文档中心起步包** | 首次安装自动 seed：插件说明 + 「示例与文档」（主题汇总模板 / 教程 / 三个示例主题页），首页「📚 插件文档」栏一键查阅；**同名 tiddler 已存在一律安全跳过，绝不覆盖你的数据**（v0.16.22）；插件说明里的**工具清单由工具注册表实时生成**，不会再写着「10 个工具」却已经 15 个（v0.22.0） |
| 📍 **知识库位置可切换** | 设置页「知识库位置」可把插件切换到**任意本地文件夹**（不用改 cordis 配置、不用重装）：就地停/起 TW 子进程，目标目录没有 `tiddlywiki.info` 时自动 `--init server` 建一个全新知识库；选择记在 `$DSH_HOME/dsh-tiddlywiki/location.json`——一个**在 wiki 之外**的指针文件（所以切到新 wiki 后仍记得「我用的是哪个」），「恢复为配置默认」一键清除；**切换失败自动回滚**到原知识库并如实告知（v0.22.0） |
| 🔄 **seed 更新检测** | seed 标记记录**内容哈希**：内置内容在本 wiki 预置之后更新过 → 设置页显示「⬆ 有更新」；被你改过 → 显示「✏️ 本地已修改」，且「重新初始化」前**二次确认**；两者都基于哈希判定，绝不猜（旧格式标记会明确显示「尚未启用更新检测」，不会误报为「你改过」，v0.22.0） |
| 🎨 **自定义样式** | 「自定义样式」seed：编辑器美化 / 窄屏侧栏隐藏 / menubar 加高 / 批注弹窗等 5 张通用样式表，新 wiki 也能一键初始化（可选，v0.16.22） |
| 📝 **可配置的注入提示词** | 插件注入每个会话的「TiddlyWiki 持久知识库」提示词可在设置页配置：**默认精简版**（v0.24.0 起 ~1.9KB，只保留工具 schema 表达不了的约定——同步纪律 / 工作区标记 / 先窄后宽检索 / 时效标注 / 链接格式），可选**完整版**（额外附一份**由工具注册表实时生成**的参数索引，不会再过期）；`extra` 追加自定义规范、`override` 整段接管、可整体停用；**保存后无需重启 dsh web**（section 即时重注册，当前会话下一步即生效），设置页可**按表单当前值预览**即将注入的全文（未保存的形态切换也立刻可见，v0.21.0 / v0.22.7） |
| 🤖 **Agent 工具** | 15 个 `tiddlywiki_*` 工具：检索（**相关度排序 + 命中处片段 + 字段过滤**）、读写、**增量追加**、批量、重命名、**软删除/回收站**、**反向链接**、**附件入库**、**知识库体检**、git 同步与冲突解决（v0.19.0；检索/最近仍在**服务端**排除二进制附件，大 wiki 上从 515MB/17s 降到 ~0.4s） |
| 🛡️ **不会被覆盖的写入** | 所有写入路径（agent 工具 **与** 快速笔记/编辑器路由）都**先读后写**：不传 tags 就保留原有标签、自定义字段与**内容类型**（`text/css`/wikitext 等不会被重置成 Markdown，v0.20.1）；`tiddlywiki_put(..., expectedModified/expectedRevision)` 与 `tiddlywiki_delete(..., expectedModified/expectedRevision)` 乐观并发——读取后若有人（在 TW 编辑器里）改过，写入/删除被拒绝（HTTP 409）而不是静默覆盖或丢进回收站；**给了哪个令牌就必须匹配哪个**（v0.23.5：两个令牌是 AND 不是 OR——`revision` 是 TW 的内存计数器、重启会复位，旧逻辑会因此静默放行跨重启的覆盖）；`tiddlywiki_attach` 的同名标题**默认拒绝**（要覆盖必须 `force: true`）；`tiddlywiki_delete` 默认**软删除进回收站**，`tiddlywiki_trash` 可恢复（v0.19.0 / v0.19.1 / v0.19.5 / v0.23.5）。**v0.25.0**：`tiddlywiki_append` / `tiddlywiki_rename` / `tiddlywiki_batch_put`（逐条目）也支持并发令牌——它们同样是「读全文 → 整篇回写」，此前**没有令牌可传**，而注入的提示词恰恰让模型回传 `expectedModified`；`tags: []` 现在表示**清空全部标签**（此前被当成「未传」而静默保留，模型按 lint 的 junk-tags 建议去清标签时什么都不会发生）；`tiddlywiki_rename` 更新引用时若某个引用者在遍历期间被改动过，**跳过它**并在回执里报出数量，而不是覆盖它 |
| 🏷 **工作区感知的读写** | **新建**笔记自动带 `ws/<项目名>` 标签 + `workspace` 字段（项目名取自会话工作目录，`note.workspaceMark` 可关）；`tiddlywiki_search` 因此默认**先在本项目里找、区内 0 条才自动扩大到全库**并在回执里写明实际范围，`query` 按空白切词、**全部词命中**才算（AND）。工作区只是**附加**标记，绝不改写笔记原有的标签/字段，也**只在新建时**打（v0.24.0） |
| 🕰 **时效性内容只提示不删** | 阶段性笔记（版本记录 / 部署步骤 / 排期 / 临时方案）可声明 `valid-until`（硬过期）或 `review-after`（该复查），被取代时写 `superseded-by` + `superseded` 标签并**保留旧笔记**；`tiddlywiki_lint` 的 `stale` 检查**只报告**（含「版本号或 done 标签 + 长期未改动」的**候选**，明确标注非判定）——**淘汰永远由人决定**，插件不会自动删除或归档任何笔记（v0.24.0） |
| 🚰 **重启不丢写入** | 停/重启 TW 只有一条路：`drainThenStop()`——**排干 syncer 队列之后才停子进程**，`/restart`、`/admin/restart`、插件/主题变更后的重启、知识库切换、`/sync`、seed 全部经它（此前其中三条直接杀进程，在一秒内点「重启 TW」会静默丢掉刚写的笔记）；排干不完整会在回包里如实报 `drained:false`，而不是假装没事（v0.24.1） |
| 🕒 **时间戳不再丢** | 插件写入的每条笔记都会带上 TW 的 `created`/`modified`（17 位紧凑 UTC，与 TW 编辑器逐字节一致）：新建 = 两者都取当前时刻，覆盖 = **保留原 `created`、刷新 `modified`**。此前这两个字段被当成「TW 服务端会补」而丢弃，而服务端**从不补**——缺 `modified` 的条目会被 TW 的 `sortTiddlers` 当空串，在 `+[!sort[modified]]` 页面上**直接沉到最后一名**（表现为「新日记没被收录」）。`TiddlyWebClient.put()` 还有一道兜底，任何写路径都不会写出无时间戳的条目（v0.22.5） |
| 🧼 **渲染片段净化** | 回复流卡片与会话汇总注入的 TW 片段先经 **host 白名单净化**（丢 `iframe`/`script`/`svg`/`on*`/`javascript:`/`data:text/html` 等）——TW 自己的解析器只剥 `on*`，`<iframe src="javascript:…">` 会原样通过并在 DSH 页面里执行（v0.19.1 修复的存储型 XSS） |
| 🔒 **写路由方法校验** | 每个写路由只接受自己的 HTTP 方法：跨站 `GET /sync`、`GET /restart`、`GET /upload` 一律 405 且无副作用（v0.19.0 修复了「任意网页一张 `<img>` 即可触发 pull/commit/push」的 CSRF 面） |
| 🔑 **密钥不外泄** | `bridge.token` / `ui.sendToAgent.token` / **`auth.password`**（v0.20.0）在 `/admin/state`、`/admin/config` 的回包里是 `********`（设置页原样保存 ≠ 覆盖，清空即删除），`git.remote` 里的 PAT 打码；**`/tw`、`/api` 与 `POST /render` 都拒绝 `$:/plugins/dsh-tiddlywiki/` 命名空间**——此前 `/render` 能把配置 tiddler 连 token 与 PAT 一起渲染出来（v0.19.3 / v0.20.0） |
| 🧯 **路由不会拖垮进程** | 所有路由经 `guardHandler` 包装：任何 rejection（含代理里 try 之外的 `new URL()`）都变成 413/500 响应，而不是宿主未处理的 promise rejection（那会**直接结束 dsh web 进程**并挂死请求）；剪藏桥 listen 后保留常驻 `error` 监听（v0.19.3） |
| 📊 **回复流卡片** | 工具结果显示原生 TW 卡片（**按笔记自己的内容类型渲染**：Markdown 笔记就是 Markdown，v0.18.0），检索/最近列表带**命中处摘要**（v0.22.8）；`[标题](/dsh-tiddlywiki/tw/#标题)` 点击直达 TW 面板 |
| 📤 **发送给 Agent** | TW 笔记工具栏一键把当前笔记注入所选 dsh 会话（可选工作模式/权限/附加说明）；成功/失败会弹出提示（v0.20.0 修复：此前提示把自由文本当 tiddler 标题传给 TW notifier，全部静默） |
| 📮 **发布到微信公众号**（**可选，默认关**） | 把笔记一键发到公众号**草稿箱**（可选点发表）：TW 渲染 → 补内联样式 → 浏览器自动化复用你已登录的后台会话。**绕开官方 API 权限封锁**（2025-07 起个人主体账号的发布接口被回收），个人号可用；发表需管理员扫一次码。**需额外安装**（opencli + 浏览器扩展），插件不替你装；**关闭时完全不打扰**（不注入提示词、不写文档）。**带发布元数据**（`pub-state`/`pub-platform`/`pub-wechat-*` + `no-publish` 标签）避免重发或误发。**v0.23.3 起 TW 工具栏有「发布到公众号」按钮**（预检 + 进度轮询，只到草稿箱），也可继续用 CLI。见 [docs/wechat-publish-setup.md](docs/wechat-publish-setup.md) |
| 🧭 **内嵌编辑器** | 中央列内嵌完整 TW 5 编辑器（同源代理，Tailscale/内网/域名/HTTPS 均可） |
| 🗂️ **右侧边栏 Tab** | DSH 新右侧栏（rightbar）：首页「TiddlyWiki 知识库」入口一键打开，与聊天并排；链接点击可直达（v0.16.21） |
| 🧪 **审计守门** | 第四轮审计（v0.20.0）把 CI 与 `npm run verify:*` 合成一份清单，并补上 `verify-constants`（filter 长度预算）、`/render` 403、auth 打码、notify 与草稿避让回归。**v0.25.0 再加两道**：`verify-config-patch`（设置页补丁必须过 `normalizeConfigPatch`：范围夹取 / 类型错误 400 / `__proto__` 等危险键拒绝 / 未知键透传）与 `verify-tool-views`（源码级断言**客户端 `TOOL_VIEW_KEYS` 与 host 注册的工具名完全一致**、`TOOL_LABELS` 全覆盖、工作区前缀与 host 常量相同——此前只靠 AGENTS.md 一句「记得同步」，新增工具时卡片会静默退化成纯文本） |
| 🧩 **Better Sidebar 共存** | 与 dsh-better-sidebar 侧边栏共存（其展开/收起按钮浮在 TW 面板之上）；**不再向该侧边栏注册 TW tab**（v0.17.0 移除了 tab 注册，避免 tab kind 冲突） |
| 📚 **会话知识库 Tab** | 每个会话顶部汇总本会话读写过的 wiki 笔记，TW 原生渲染（host `/render` 片段管线 + 白名单净化，v0.16.19 / v0.19.1）。**v0.25.0 补齐**：归类含 **`append`（增量写入）/ `attach`（附件）**（此前用 append 写的笔记在这个 Tab 里**完全不可见**，而注入提示词恰好推荐 append），并新增「🗑 删除 / 回收站」一节；事件日志读不出来的会话会**在页面上明说**（不再静默吞掉、把「读不出来」显示成「没碰过笔记」）；读取改为 4 路有界并发 + 12s 墙钟预算（最坏 375s → 有界，客户端 25s abort 后不再继续压着 TW 打）；生成有 3s 单飞/复用；`$:/temp` 条目被 TW 重启清掉时自愈（**三态探测**：在 / 被清 / 状态未知——未知不计失败也不清零），另按 3 分钟节拍静默刷新，长期开着也能跟上会话 |
| 📝 **快速笔记** | 输入框上方快捷按钮或右下角「知识库」FAB；原生编辑页或 Markdown 卡片两种模式；首页内置「快速记笔记（完整编辑器）」 |
| 📌 **本地剪藏桥** | 可选「剪藏桥 + 书签小工具」：DSH 监听 127.0.0.1 端口接收剪藏请求（Host 校验防 rebinding），点书签弹出浮层——可改标题/编辑选中文字/**勾选图片**，一键写入知识库；文字成笔记（默认 `clip` 标签），图片由桥下载存为**二进制附件**（`type: image/*` + base64，笔记内 `[img[标题]]` 内嵌），随 wiki 自动进 git；图片下载有 **SSRF 守卫**（仅公网 http(s)、逐跳校验重定向，v0.18.0） |
| 🔐 **写操作防跨站** | 所有写路由（笔记/上传/同步/后台/代理）拒绝跨站请求（403），仅同源的 GUI 与内嵌 TW 可写；跨站 GET 与浏览器地址栏直达不受影响（v0.18.0） |
| ✅ **待办四象限** | 首页看板：任务打 `todo` 标签即收录，拖动即可分类/完成（正文附 `q` 字段），逾期/今日到期自动统计 |
| 🌗 **跟随主题** | 内嵌 TW 自适应 DSH 深浅主题（纯内存切换，不进 git） |
| 🔄 **一键同步** | FAB「同步」一键 pull→commit→push，状态点实时反映 git 状态 |
| 💾 **数据即备份** | wiki 文件夹本身就是 git 仓库，自动 commit（60s 防抖） |
| ⚙️ **设置页不再「假装生效」** | **v0.25.0** 把一批「保存了却不变」的项收敛掉：`git.autoCommit`/`git.debounceMs`/`git.remote` 保存后**对运行中的插件立即生效**（重建防抖提交器 + 指向新 remote；`git.branch` 只对首次初始化的仓库有意义，标签里已写明，状态行显示的是真实分支）；数值项（端口 / 就绪窗口 / 分页条数 / 防抖毫秒）带 `min`/`max` 与字段旁红字，非法值**拒绝保存**而不是静默夹取；保存被拒（409，例如配置 tiddler 残留冲突标记）时错误**持久显示**而不是一闪而过的 toast；「没有改动」不再发请求、宿主也不重写配置 tiddler（每次空点保存都给 git 造 diff / 两台机器在 `.meta` 上冲突）；插件/主题/语言的未应用勾选能活过「同步 / 重启」触发的重刷；表单有未保存内容时若配置在别处被改过，**保留你的输入**并给出显式提示而不是重建表单；微信发布的 `command`/`adapter`/`token`/`dsn` 补齐 UI（token 是密码型 + 显隐切换，掩码回填照旧） |

| 🧾 **`fields` 是对象，不是字符串** | **v0.26.5**：三个写工具的 `fields` 参数 schema 从 `{type:'json'}`（在 DSH 的 schema 里是**纯注解**、编译后连 `type` 都没有，模型只能猜）改成真正的 `object`；工具层 `normalizeFieldsArg()` 还会把模型发来的 **JSON 字符串解析成对象**，数组 / 解析不出的字符串则**明确报错**——不再出现「传了 `fields` 却写出 `0={`、`1="`、`2=r`… 几十个单字符垃圾字段，真正的字段一个没落」（用户实测复现两次） |
| 🔍 **插件状态不说谎** | **v0.26.0**：设置页「插件管理」的勾选只代表 `tiddlywiki.info` 启动清单，而 TW 运行时集合还要并上**经 TW 原生插件库装进 wiki 的插件 tiddler**、减去**在 TW 面板里被禁用的**。两边不一致时（TW 里启用着、设置页没有——或反过来），行内会显示「**wiki 内已装**」「**TW 内已禁用**」徽标，并单列只读小节「**wiki 内插件（经 TW 原生安装）**」（名称/版本/描述），启停与卸载引导回 TW 控制面板。第三方插件的安装与管理仍然完全交给 TW 原生界面 |

---

## 📦 安装

```bash
# ① npm 发布包（推荐）
dsh plugin --profile web add dsh-tiddlywiki

# ② 直接从 GitHub 安装
dsh plugin --profile web add github:bbqisbbq/dsh-tiddlywiki

# ③ 本地开发（link 方式，改完 src 后 npm run build 即生效）
dsh plugin --profile web add link:/path/to/dsh-tiddlywiki
```

装完**重启 dsh web** 生效。首次启动自动完成：初始化 wiki 目录、`git init` 并提交基线、写入**功能必需的 seed**（发送给 Agent 按钮 + 原生渲染路由 + 同源代理基址）与**起步文档**（插件说明 + 示例与文档）；首页/所有文章/自定义样式等为可选项，需要时在设置页「初始化」手动写入。

---

## 🚀 快速开始

1. **安装并重启** dsh web。
2. 侧边栏「**TiddlyWiki**」→ 中央打开完整 TW 编辑器。
3. **随手记**：点输入框上方「📝」或右下角「知识库」→「快速笔记」；或在首页直接用「✍️ 快速记笔记」区块，写完保存即成为 tiddler 并自动进 git。
4. **看文档**：新 wiki 首页（初始化 home-index 后）有「**📚 插件文档**」栏——插件说明、汇总教程、模板都在里面，可自由删改。
5. **收工同步**：「知识库」→「🔁 同步」一键 push 备份。
6. **让 Agent 参与**：直接说「把刚才的会议纪要存进知识库」——Agent 用 `tiddlywiki_*` 工具读写。
7. **发笔记给 Agent**：TW 里打开笔记 → 工具栏「发送给 Agent」→ 选会话 → 作为消息注入。

---

## 📖 使用指南

### 🤖 Agent 工具（15 个）

| 工具 | 说明 |
|---|---|
| `tiddlywiki_search` | 检索（`query` + 可选 `tags[]/tag/since/type/field/value/limit`），**按相关度排序**（标题命中 > 标签 > 正文命中次数），摘要取自**命中处上下文**而不是正文开头。v0.24.0：`query` 按空白切词、**全部词命中**才算（AND）；默认**先在工作区内查、区内 0 条才自动扩大到全库**，回执里写明实际范围 |
| `tiddlywiki_recent` | 最近修改的笔记（倒序，支持 `limit`/`since`），开工快速了解动态 |
| `tiddlywiki_list_tags` | 现有非系统 tag 及计数（已排除只挂在二进制附件上的 tag）；默认列使用最多的 200 个（`limit` 可调、上限 1000），截断时返回 `total`/`truncated` |
| `tiddlywiki_get` | 读单个 tiddler 全文（`modified` 以 ISO 返回，可直接用作 `expectedModified`） |
| `tiddlywiki_put` | 写/覆盖；**新建**未指定类型时默认 `text/markdown`（`$:/` 系统条目除外），**覆盖既有条目时保留原 `type`/tags/自定义字段**（v0.20.1，改类型要显式 `fields.type`）；`expectedModified` + `force` 提供乐观并发保护 |
| `tiddlywiki_batch_put` | 批量写入（`overwrite=false` 跳过已存在；单条失败不影响其余、逐条报错；4 路并发但结果保持入参顺序） |
| `tiddlywiki_append` | **增量追加**：`mode=append\|prepend`、`heading=某标题` 定位写入（落点 = 该标题之后、**下一个任意级别标题之前**；CRLF 行尾的笔记同样有效），写日志/批注无需读全文；标题不存在时**不报错但也不再装成功**——追加到文末并返回 `headingMatched=false` + 回执明说；与 `put` 同一套写策略（保留原 `type`/tags/自定义字段，新条目才默认 markdown），支持 `fields` 显式覆盖 |
| `tiddlywiki_rename` | 重命名 + 尽量同步其他条目里的引用；旧标题删除失败时如实回报「两份副本都在」 |
| `tiddlywiki_delete` | 删除（幂等）。默认**软删除**进 `$:/dsh-tiddlywiki/trash/`，`permanent=true` 才真删；支持 `expectedModified`/`expectedRevision`/`force` 乐观并发（读后被改动则拒绝，不把人类的新改动丢进回收站） |
| `tiddlywiki_trash` | 回收站：`action=list\|restore\|empty`（索引读不到或损坏时显式报错，绝不把回收站当空的重建） |
| `tiddlywiki_backlinks` | 反向链接：谁用 `[[标题]]`/`{{标题}}` 引用了它、谁把它当标签 |
| `tiddlywiki_attach` | 把**本机文件或公网 http(s) 地址**存成二进制附件（图片/PDF/…），可嵌入某篇笔记；URL 走 SSRF 守卫；**同名 tiddler 已存在时默认拒绝**（避免静默覆盖笔记），确认覆盖要传 `force: true`（tags/自定义字段仍保留） |
| `tiddlywiki_lint` | 知识库体检（**只读**）：垃圾标签 / 死链 / 空笔记 / 缺内容类型的类 Markdown 笔记 / **时效性内容**（`valid-until`·`review-after` 过期，以及「版本号或 done 标签 + 长期未改动」的**候选**，`staleAfterDays` 可调） |
| `tiddlywiki_git_sync` | `action: pull\|push\|sync` |
| `tiddlywiki_git_resolve` | pull 冲突后按 tiddler 二选一（`keep-local\|keep-remote`） |

**知识库同步纪律**：
1. 开工先 `tiddlywiki_git_sync action=pull`（rebase + autostash，真冲突会 abort 并报文件）。
2. 冲突后用 `tiddlywiki_git_resolve` 二选一解决，再重新 sync（**绝不自动覆盖**）。
3. 收工 `tiddlywiki_git_sync action=sync`（pull → commit → push）。

> 🛡 **带着冲突绝不提交**（v0.23.4）：`commit` 之前会探测「进行中的 rebase / 未合并路径 / **工作树里残留的冲突标记**」，命中就**拒绝提交**（`/sync` 返回 409 + 文件名、自动提交只上报一次、`/status` 与设置页状态行显示「冲突未解决（N 个文件，已阻止提交）」）。这条守卫来自真实事故：autostash 重新应用冲突后 `rebase --abort` 已无事可 abort，冲突标记留在工作树里被自动提交**永久写进了 git 历史**（连带插件自己解析不了配置）。**删冲突标记的方式**：解决后 `tiddlywiki_git_resolve`（或手动编辑掉 `<<<<<<<`/`=======`/`>>>>>>>` 三行）再 sync。
>
> ⚙️ **配置文件坏了会拒绝保存**（v0.23.4）：若 `$:/plugins/dsh-tiddlywiki/config` 不是合法 JSON（最典型就是残留冲突标记），设置页保存会**被拒绝**并在页面顶部显示红色横幅——而不是像以前那样拿空配置合并、把你其余的设置（`prompt.extra`/`git.remote`/`ui.*`…）一次抹掉。修好该 tiddler（或删掉它回落 `config:` 块）后即可正常保存。

> 🔍 **检索/最近跳过二进制附件**（v0.16.20）：`search`/`recent` 在**服务端**只取文本 tiddler（无 `type` 字段或 `text/*`），图片/音频/视频/PDF/zip 等二进制 tiddler（base64 正文）不参与检索、不出现在结果里——大 wiki（如数千张书籍扫描页图）从此从 515MB/17s 降到 ~0.4s，也不会被同名书页图刷屏。`get` 对二进制 tiddler 只返回元数据（`binary=true` + 类型/大小 + 链接），不返回 base64 正文。

> ⚠️ `fields.type` 是 TW 的**内容类型保留字段**（`text/markdown` 等），业务分类请放 `tags`，别写进 `fields.type`。
>
> 🧾 **`fields` 必须是对象**（v0.26.5）：三个写工具的 `fields` 参数是 `object`（如 `{"review-after":"2026-12-22"}`），**不要传字符串**。工具层会宽容地把 JSON 字符串解析成对象（兼容旧行为），但数组 / 解析不出对象的字符串会**明确报错**——早期版本曾把字符串按字符拆成 `0={`、`1="`… 几十个垃圾字段写进条目，真正的字段反而没写进去；碰到这种历史条目只能重建（`fields` 只能覆盖、不能删除单个字段）。

> 🕰 **过期内容怎么淘汰**（v0.24.0）：很多笔记是**阶段性**的（版本记录、部署步骤、排期、临时方案、一次性口令），过一段时间就不适用了。策略是**声明时效 + 人工决定，插件绝不自动删**：写这类笔记时带 `valid-until: YYYY-MM-DD`（硬过期）或 `review-after: YYYY-MM-DD`（该复查）；被取代时写 `superseded-by: [[新笔记]]` 并打 `superseded` 标签，**旧笔记保留**（wiki 是 git 仓库，留着的成本几乎为零，删错的成本很高）。`tiddlywiki_lint` 的 `stale` 检查会**只报告**三类：`stale-expired`（`valid-until` 已过）、`stale-review`（`review-after` 已到）、`stale-candidates`（带版本号或 `done` 标签且长期未改动——**明确标注是候选，不是判定**）。要清理就自己用 `tiddlywiki_delete`（默认进回收站，可恢复）。

> 🏷 **新建笔记自动标工作区**（v0.24.0，可用 `note.workspaceMark: false` 关闭）：`put`/`batch_put`/`append` **新建**条目时会自动带上 **`ws/<项目名>` 标签 + `workspace` 字段**，项目名取自当前会话的工作目录（`C:\work\alpha` → `ws/alpha`）。于是 `tiddlywiki_search` 默认就能「先在本项目里找」，而 `field: workspace, value: <项目名>` 可以精确按项目过滤。**不需要也不应该手动加**这两个标记（会在 `agent-written` 之外重复）；内容明显属于**另一个**项目时，显式传 `fields: {"workspace": "那个项目"}` 即可（显式值优先，不会被自动值覆盖）。为什么标签要带 `ws/` 前缀：裸项目名会和真实业务标签撞车——作者库里 `dsh-tiddlywiki` 这个标签已挂着 2510 篇导入的书籍章节，去掉前缀会让「在工作区内搜索」返回那 2510 篇。

### 🧠 注入的系统提示词（可配置）

插件会往每个会话的系统提示词里注入一段「TiddlyWiki 持久知识库」约定（**设置页 → 系统提示词**）：

| 配置 | 作用 |
|---|---|
| `prompt.enabled` | 关掉后本插件不注入任何文本 |
| `prompt.mode` | `slim`（**默认**，v0.24.0 起约 1.9KB）：只保留工具 schema 表达不了的约定（写入/并发纪律、同步纪律、工作区标记、先窄后宽检索、时效标注、可点击链接格式）；`full`：额外附一份**参数索引**，由工具注册表在运行时生成，因此永远不会与真实工具脱节 |
| `prompt.extra` | 追加在末尾的自定义规范（团队 / 个人偏好），始终生效 |
| `prompt.override` | 非空时整段取代内置文本（`extra` 仍会追加）——想完全自写提示词时用 |

保存后**不用重启 dsh web**：host 会即时重新注册 prompt section，当前会话从**下一步**起就使用新文本（DSH 的 `system-prompt/change` 会更新历史里的系统消息）。设置页的「预览注入文本（按表单当前值）」按钮会把**表单里此刻的值**（含还没保存的形态切换 / extra / override / 停用开关）发给 host 实时拼成全文——所见即「保存后会注入的内容」，顶部还会标注「含未保存的修改」；预览是只读的，不会替你保存（v0.22.7 之前它只读**已保存**的配置，所以切换形态后不点保存直接预览会看到逐字节相同的旧文本，容易被读成「两种形态没差别」）。

> 为什么默认精简：v0.20.1 之前这段提示词里手抄了一份**工具参数清单**，最后一次同步停在 v0.19.0，而 v0.19.4 / v0.19.5 / v0.20.1 都改过工具参数——模型因此看到 6 处过期签名（`delete` 缺并发令牌、`append` 缺 `fields`、`attach` 缺覆盖保护、`batch_put` 缺 `overwrite`、`trash` 缺 `title`/`limit`、`list_tags` 缺 `limit`）。v0.21.0 起：默认形态不再复述参数（工具 description 才是唯一事实），`full` 形态的目录改为**运行时生成**，并新增 `scripts/verify-prompt.mjs` 守门（slim 不得出现参数清单 / full 的每个工具与每个参数都必须在场 / 两种形态都必须保留治理约定块）。

### 🧑‍💻 界面操作

- **📤 发送给 Agent**：TW 工具栏按钮（首次启动自动写入 wiki，ONE-SHOT）。弹层可选**附加说明**（位于消息末尾）、**工作模式**（Agent 预设）、**权限**（权限预设），按工作区分组选会话或新建。消息自带待办说明。
- **🧭 中央列编辑器**：侧边栏「TiddlyWiki」开关（显示名可改 `ui.sidebarLabel`，保存后即时生效，v0.22.8）。
- **🗂️ 右侧边栏 Tab**（v0.16.21）：DSH 新右侧栏展开后，首页会出现「**TiddlyWiki 知识库**」入口盒，点击即在右侧栏以 tab 形式打开完整 TW 编辑器——**与聊天并排**，适合边聊边查/边记。由 `ui.showRightbarTab` 控制（默认开）；老版本 DSH（无右侧栏）自动跳过。
- **🧩 Better Sidebar 共存**：装了 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 时，插件只做 UI 共存（中央 TW 面板的 z-index 自动压在其侧边栏展开/收起按钮之下，按钮始终可点）。**v0.17.0 起不再向 dsh-better-sidebar 注册「TiddlyWiki 知识库」tab**（旧版可用 `ui.showBetterSidebarTab` 关闭）——该 tab 的 kind 会与其它注册方冲突报 `tab kind "dsh-tiddlywiki" is already registered`。右侧边栏入口请用上面的 **右侧边栏 Tab**（DSH 原生 rightbar）。
- **📝 快速笔记**：输入框上方快捷按钮（`ui.showQuickNoteDock`）或 FAB；`ui.quickNoteMode` 选打开方式——**native**（默认，直达 TW 原生编辑页，草稿自动续写）或 **card**（CodeMirror 6 Markdown 高亮、文件上传、多选 tag、草稿自动保存、「🕘 最近」载入、Ctrl+Enter 保存）。**v0.22.6**：原生编辑弹窗里用 TW 的「🗑 删除」把笔记删掉后不会再变成打不开的白板——再点一次「快速笔记」就会重新载入编辑器；card 模式底部操作条改成「按钮文字永不折行、放不下时整组换行」，窄卡片里不再把「✏️ 在 TW 中编辑」压成两行。
- **📌 本地剪藏桥**（可选，v0.16.24+/v0.16.25 支持图片）：DSH 设置 → 常规配置 → 勾选「**启用本地剪藏桥**」（保存后立即生效）——DSH 即监听 `127.0.0.1:8618` 接收剪藏请求。浏览器书签栏新建书签，把知识库文档里的 JS 代码粘贴为地址，点一下弹出**浮层**：确认/修改标题与划线文字、勾选页面图片（封面自动标出）→「剪藏」即写入 wiki。文字成笔记（默认 `clip` 标签、正文含来源与选中文字、重名自动 `（2）` 去重）；**图片由 DSH 本机下载字节存为二进制附件**（`clip-url`/`clip-note` 溯源字段，笔记内 `[img[标题]]` 内嵌展示；某张下载失败自动降级为链接），全部随 wiki 自动 git commit。「📚 插件文档」栏的 `本地剪藏桥（书签小工具）` seed 文档含完整步骤、书签代码、安全说明与 curl 用法。安全：桥只监听 127.0.0.1 + Host 白名单防 DNS rebinding；**强烈建议设 `bridge.token`**（非空时校验书签的 `x-clip-token` 头，防止任意网页往 wiki 里塞内容）。图片附件按设计不参与 `search`/`recent`（避免刷屏），`get` 只回元数据。
- **🏠 首页（初始化 home-index 后）**：待办四象限（`todo` 标签 + `q` 字段拖放分类）+ 快速记笔记（完整编辑器，勾选「同时加入待办」即建任务）+「所有标签 / 所有文章」入口 +「📚 插件文档」栏（自动收录所有带 `dsh-docs` 标签的 seed 文档）。
- **📚 会话知识库 Tab**：会话顶部 Tab（`ui.tabLabel` 改名、`ui.showSessionTab` 关闭），自动汇总本会话读写过的 wiki 笔记（写入 volatile `$:/temp`，不落盘不进 git），**TW 原生渲染**（v0.16.19 起 `/tw/render` 片段管线，与回复流工具卡同链路），链接点击直达中央 TW 面板，不可编辑。
- **🌗 跟随 DSH 主题**：内嵌 TW 随 DSH 深浅切换 palette，纯内存不写回 wiki（`ui.followDshTheme`/`ui.darkPalette`）。
- **🔧 知识库 FAB**：统一入口（TW 面板开关/重载、快速笔记、同步、TW 服务状态悬停 tip）。同步拉取到新内容会自动重启 TW（同端口）。
- **⚙️ 设置页**：DSH 设置 →「TiddlyWiki 知识库」：状态/重启、**知识库位置（可切换）**、常规配置、插件/主题/语言管理（**自带官方插件**的离线启停；经 TW 面板装的第三方插件以只读小节列出，见 v0.26.0）、**初始化**（seed 状态与重新初始化）。配置写入 `$:/plugins/dsh-tiddlywiki/config` tiddler，覆盖 cordis `config:` 块（tiddler 优先）。

### 📍 知识库位置（可切换，v0.22.0）

设置页顶部「**知识库位置（可切换）**」区块显示当前实际服务的文件夹、这个位置**是怎么决定的**（指针文件 / cordis 配置 / 默认值）、指针文件路径，以及**同目录下其它看起来像 wiki 的文件夹**（含 `tiddlywiki.info`）的快捷填入按钮。

- **换一个位置**：填根目录（绝对路径，支持 `$DSH_HOME` / `${VAR}` / `%VAR%`）+ 文件夹名 → 「切换到这个位置」。host 会停掉 TW → 释放自动提交与监听 → 指向新目录 → 起 TW → 重载新 wiki 的配置 tiddler → 跑核心 seed（markdown 插件 / 发送给 Agent / 渲染路由 / 同源代理 / 语言）→ 重新武装自动提交；**选中即被记住**（写进 `$DSH_HOME/dsh-tiddlywiki/location.json`），重启 dsh web 后仍在新知识库。
- **新建一个知识库**：目标文件夹若还没有 `tiddlywiki.info`，插件会照常自动 `--init server` 建一个全新的（**别填已有的普通笔记目录**——它会被初始化）。
- **恢复为配置默认**：删除指针文件并（必要时）切回 `config.wikiRoot` / `config.wiki`。
- **安全语义**：指针文件在任何 wiki **之外**（若存在 wiki 自己的配置 tiddler 里，切到新 wiki 就会把这个选择一起丢掉——鸡生蛋）；指针文件损坏/非法时**明确报告并回退到配置默认**，不会静默乱跑；切换**失败会回滚**到原来的知识库，并告诉你是「已回滚」还是「回滚也失败了」；同刻只允许一个切换（并发请求直接拒绝）。
- **注意**：切换期间正在跑的 Agent 工具调用会失败（TW 在重启），界面上按钮会禁用并显示「切换中…（重启 TW）」。

`wikiRoot` / `wiki` 现在只是**默认值**——运行中的实际位置以指针文件优先。这也是为什么它能不改 cordis、不重装就切。

### 📮 发布到微信公众号（**可选功能，默认关闭**，2026-09-17）

> **这是可选功能**：需要额外安装 opencli + Browser Bridge 浏览器扩展，**插件不替你装**。
> 开关 `wechat.enabled` **默认 `false`**——关闭时不注入任何发布相关提示词、也不往 wiki 写
> 「发布元数据规范」。开启：DSH 设置 →「TiddlyWiki 知识库」→「可选功能：微信公众号发布」。
> 完整安装步骤与排错见 [docs/wechat-publish-setup.md](docs/wechat-publish-setup.md)。

把 wiki 里的任意笔记**一键发到微信公众号草稿箱**（可选直接发表）。整套能力放在 `tools/wechat/`，**不依赖公众号服务端 API**——因为 2025-07 起官方已回收个人主体账号的「发布能力」接口权限；本方案改用**浏览器自动化复用你已登录的后台会话**，所以个人号也能用。

**两条路，随便挑一条**：

- **点按钮（v0.23.3，日常推荐）**：开启可选功能后，笔记工具栏出现「**发布到公众号**」。点它 → 先**预检**（opencli 在不在、adapter 缺不缺）→ 弹确认框（自动列出 `no-publish` / `pub-state` 警告）→「开始存草稿」→ 覆盖层每 2 秒显示进度与日志。**只到草稿箱为止**，发表请到后台点（需扫码）。背后是宿主进程起一个单并发的后台任务（`POST /dsh-tiddlywiki/wechat/publish` + 轮询 `…/status`），标题经 **UTF-8 文件**（`--title-file`）传给 adapter——不进 argv，避免 Windows `cmd.exe` shim 把 `&` 当命令分隔符、把中文解成乱码。
- **敲命令**（等价，适合批量 / 脚本化）：

```bash
# ① 先按 docs/wechat-publish-setup.md 装好 opencli + 浏览器扩展，并登录公众号
# ② 一次性：装 adapter 到本机 opencli（幂等，会自检扩展/登录状态）
node tools/wechat/install-wechat-adapters.mjs

# ③ 发布（注意必须带 --trace retain-on-failure，原因见下）
opencli weixin publish-note "笔记标题" --trace retain-on-failure -f json
opencli weixin publish-note "笔记标题" --cover ./cover.png -f json   # 带封面
opencli weixin publish-note "笔记标题" --preview ./out -f json       # 先导出排版预览
opencli weixin publish-note "笔记标题" --publish -f json             # 直接发表（需管理员扫码）

# ④ 可选：回填存量「已发布」状态（默认 dry-run）
node tools/wechat/backfill-publish-state.mjs          # 看
node tools/wechat/backfill-publish-state.mjs --write  # 写
```

**流程**：笔记标题 → DSH 的 `/render`（TW 自己渲染成语义 HTML，含代码高亮）→ `wechat-html.js` 补**内联样式**（微信会剥 `<style>` 和 class，只认内联）→ opencli 驱动后台填表/写正文/传图/设封面/存草稿 →（可选）点发表。

**三个要点**：

1. **必须带 `--trace retain-on-failure`**——不带会对 `mp.weixin.qq.com` 稳定报 `Navigation rejected`（实测 trace 开 5/5 成功、关 8/8 失败；这是 opencli 1.8.7 的 bug，`--site-session ephemeral` 等绕法均无效）。
2. **发表必须管理员扫码**——后台点「发表」后微信要求管理员微信扫码确认，无法自动化。「一键」的真实含义是「脚本做到填表/排版/上传，你只需扫一次码」。默认走**发表**（不推送粉丝、不占群发额度），群发请自行在后台操作。
3. **图片上传用 DataTransfer 注入**，不用 `page.setFileInput`——后者依赖 CDP `Page.fileChooserOpened`，本机扩展版本组合下稳定失败；改用页面上下文直接塞 `input.files`，实测图片真进 `mmbiz.qpic.cn`。代价是单图 **8MB** 上限（字节要以 base64 穿过 evaluate）。

**换机器还原**见 [docs/wechat-publish-setup.md](docs/wechat-publish-setup.md)（含 opencli / Browser Bridge 扩展安装、扫码登录、排错表）。设计依据与全部实测细节见 [docs/plans/2026-09-17-wechat-publish-design.md](docs/plans/2026-09-17-wechat-publish-design.md)。

### 🧩 初始化（一次性预置 seed）：哪些「必备」，哪些「可有可无」

seed 是把「wiki 里预置内容」随插件分发的机制：**ONE-SHOT（只写缺失）+ 安全跳过（同名 tiddler 已存在绝不覆盖你的数据）**，需要时可「重新初始化」恢复、可「反初始化」移除。详细见 [docs/seed-initialization.md](docs/seed-initialization.md)。

| 层级 | seed | 说明 | 首次安装 |
|---|---|---|---|
| 🔒 **核心**（功能必需，不可移除） | `send-to-agent` | TW 工具栏「发送给 Agent」按钮插件 | 自动写 |
| | `render-route` | 原生渲染路由（回复流卡片 / 链接直达依赖） | 自动写 |
| | `tw-web-host` | TW 前端 API 基址 → 同源代理（内嵌编辑器前提） | 自动写 |
| 📖 **起步**（默认写、可移除，**想要完整体验建档案**） | `doc-note` | 「dsh-tiddlywiki 插件说明」笔记 | 自动写 |
| | `starter-docs` | 「示例与文档」：主题汇总页·模板 + 教程 + 三个示例主题页（日志/决策记录/排障） | 自动写 |
| | `publish-spec` / `wechat-setup` / `wechat-publish`（**带 gate**） | 只有开启「可选功能：微信公众号发布」才写：发布元数据规范 + 换机还原指南 + 「**发布到公众号**」工具栏按钮插件（v0.23.3） | 开启后自动写 |
| 🎀 **可选**（默认不写、设置页手动、可移除，**可有可无**） | `home-index` | 首页（四象限待办 + 快速记笔记 + 所有标签/所有文章 + 📚 文档栏）——文档中心的「门面」 | 手动 |
| | `all-articles` | 「所有文章」两列分页总览（🤖 Agent / 👤 人工） | 手动 |
| | `ui-styles` | 自定义样式 5 张（编辑器美化 / 窄屏侧栏 / menubar 加高 / 批注弹窗等） | 手动 |
| | `menubar-theme` | menubar 顶栏跟随 DSH 主题换色 | 手动 |
| | `clip-bridge` | 「本地剪藏桥（书签小工具）」使用说明——含书签代码 / 启用步骤 / 安全说明（真功能在插件运行时代码里，此 seed 只预置文档） | 手动 |

- **想获得完整插件体验**：核心 3 项首次安装就有；再补 `home-index`（首页）+ `starter-docs`（示例文档）即是一个开箱即用的文档中心。
- **一个可选项都不想要**：完全不影响功能——设置页「反初始化」即可，核心项受保护不可移除。
- **文档怎么扩散到更多**：以后插件新增的任何说明 / 教程 / 模板类内容都走 seed 并带 **`dsh-docs`** 标签——首页「📚 插件文档」栏自动收录，你无需任何配置。
- **内置内容更新了怎么办**（v0.22.0）：seed 标记里记着**内容哈希**，设置页据此显示两个提示 chip——「**⬆ 有更新**」（内置内容比你 wiki 里预置的更新，可点「更新到内置版本」取用）与「**✏️ 本地已修改**」（这篇是你的内容，重新初始化会覆盖它，会先二次确认）。升级插件后旧 wiki 的标记没有哈希，会显示「更新检测尚未启用（重新初始化一次即可）」，**不会**把老标记误判成「你改过」；重新初始化一次即升级标记。**绝不自动改写你的 wiki**——更新只在你点的时候发生。

---

## 🛠 配置

插件行默认配置（缺省即默认，无需手动配置）：

```yaml
- id: dsh-tiddlywiki
  config:
    wikiRoot: "$DSH_HOME/tiddlywiki"   # 默认位置；运行中可被设置页「知识库位置」覆盖（指针文件优先，v0.22.0）
    wiki: "main"                       # 文件夹名（"." = 直接用 wikiRoot 这个目录）
    port: 0                            # 0 = 自动探测空闲端口
    git:
      autoCommit: true
      debounceMs: 60000
      remote: ""                       # 空 = 仅本地 commit；填了才 push
      branch: "main"
    note:
      tag: "inbox"                     # 快速笔记默认 tag
      workspaceMark: true              # v0.24.0：新建笔记自动带 ws/<项目名> 标签 + workspace 字段（项目名取自会话工作目录）
    startup:
      readyTimeoutMs: 60000            # TW 启动就绪窗口（v0.22.5，5s–600s；超出只警告并继续等，硬上限 = 3×，仍未就绪才判失败）
    prompt:
      enabled: true                    # false = 本插件不注入任何提示词
      mode: "slim"                     # slim（默认：只留约定）/ full（+ 由工具注册表实时生成的参数索引）
      extra: ""                        # 追加在提示词末尾的自定义规范（团队/个人偏好）
      override: ""                     # 非空时整段取代内置文本（extra 仍会追加）
    bridge:
      enabled: false                   # 本地剪藏桥（书签小工具）；保存后立即生效
      port: 8618                       # 监听端口（127.0.0.1；改后需重启 dsh web 才绑定新端口）
      token: ""                        # 共享口令；非空时校验书签的 x-clip-token 头（强烈建议设置）
      tag: "clip"                      # 剪藏笔记默认 tag
    ui:
      showQuickNote: true              # FAB 里显示快速笔记入口
      showQuickNoteDock: true          # 输入框上方快捷按钮
      quickNoteMode: "native"          # native=TW 原生编辑页 / card=Markdown 卡片
      sidebarLabel: "TiddlyWiki"       # 侧边栏入口显示名
      showPanelStatus: true
      showSyncButton: true
      followDshTheme: true             # 跟随 DSH 深浅主题
      darkPalette: "$:/palettes/CupertinoDark"
      tabLabel: "知识库"               # 会话 Tab 名
      showSessionTab: true
      showRightbarTab: true            # DSH 右侧边栏提供 TiddlyWiki 入口/Tab
      sendToAgent: { enabled: true }
    wechat:                            # 可选功能：微信公众号发布（默认关；三条 /wechat/* 路由在关时一律 403）
      enabled: false                   # 开：注入发布约定 + 启动写 3 个 gated seed（元数据规范/换机指南/工具栏按钮）
      adapter: "publish-note"          # publish-note-imgs = 正文内嵌多图版（需该 adapter 已装）
      command: "opencli"               # CLI 路径（不在 PATH / 用了别名时填绝对路径）
      token: ""                        # 非空时 /wechat/* 要求请求头 x-wechat-publish-token（按钮自动带）
      dsn: ""                          # adapter 回连 DSH 的基址；空 = 按请求端口推导 loopback
    uiLanguage: ""                     # 留空不干预；"zh-Hans" 自动启用简体
    auth:
      username: ""                     # 默认 loopback 匿名；暴露到非回环才需要
      password: ""                     # 非空时插件内置客户端/就绪探测/浏览器代理都带 Basic 认证（v0.18.0 起真正可用）
```

> **运行时配置**：设置页写入的 `$:/plugins/dsh-tiddlywiki/config` tiddler 是 `config:` 块之上的覆盖层（tiddler 优先、随 wiki git 同步），改 note tag / git / ui 开关 / **注入提示词（`prompt.*`）** 都无需动 cordis；**提示词改动保存后立即生效**（section 即时重注册，当前会话下一步生效），剪藏桥端口改动仍需重启 dsh web 重新绑定监听；**`startup.readyTimeoutMs` 对下一次 TW 启动/重启生效**（v0.22.5）。
>
> **知识库位置是三层**（v0.22.0）：指针文件 `$DSH_HOME/dsh-tiddlywiki/location.json` > `config:` 块的 `wikiRoot`/`wiki` > 内置默认（`$DSH_HOME/tiddlywiki` + `main`）。`wikiRoot`/`wiki` 因此是「默认位置」而不是「唯一位置」——设置页切过的位置存在指针文件里（一个在 wiki 之外的文件），所以要换回配置值就点「恢复为配置默认」。

---

## 🌐 远程访问

TW 子进程只监听 **127.0.0.1 回环**；Agent 工具/快速笔记/同步都走 DSH 宿主进程→回环 TW，不受访问入口影响。浏览器里的 TW 编辑器 iframe 经**同源代理** `<DSH origin>/dsh-tiddlywiki/tw/` 访问（v0.6.0 起），所以通过 Tailscale / 内网 / 域名 / HTTPS 访问 DSH 时编辑器照常工作，且 TW 重启不打断编辑中的内容。

---

## 👨‍💻 开发

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

# 自定义样式（改 wiki 的样式 .css + .meta 后；tag 自动收窄为 $:/tags/Stylesheet）
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

## 🕘 版本记录

> 最近几个主要版本的一句话记录（完整变更见 [Releases](https://github.com/bbqisbbq/dsh-tiddlywiki/releases) / git log）。

- **v0.26.6**（2026-09-26）：**修 `tiddlywiki_append` 的 `heading` 在 CRLF 笔记上完全失效、且静默回退到文末**（作者本机知识库的一篇 25KB / 454 行长笔记上连续踩两次后定位到源码）。现象：对这篇笔记连做两次带 `heading` 的 append，内容**全部**落到了文末，而回执照样打印「段落「X」」——看起来完全成功。**根因**：`insertIntoSection` 用 `base.split('\n')`，而 CRLF 正文的**每一行结尾都留着 `\r`**；JS 里 `(.*)` **不匹配 `\r`**、`$` 也**不匹配 `\r` 之前的位置**，于是 `/^#{1,6}\s+(.*)$/` 对**每一个**标题都匹配失败 ⇒ `start < 0` ⇒ 走「追加到文末」的回退分支。**只在 CRLF 笔记上复现**（纯 LF 笔记一切正常），所以它看起来像偶发；落盘文件的「**376 个 CRLF + 78 个裸 LF**」混合行尾正是走过该分支的签名（`lines.join('\n')` 保留每行原有 `\r`、只把新块用 `\n` 接上）。**修复三处**：① 标题匹配前**只**剥掉行尾 `\r`（原文行尾一个字节都不动；**没有**改成 `split(/\r?\n/)`——那会让每次 append 都把整篇重写成 LF，炸出全文件 diff）；② 新块按**文档自己的行尾**写入（`base.includes('\r\n')` 判定），CRLF 笔记不再越写越乱；③ `insertIntoSection` 改为返回 `{ text, matched }`，`tiddlywiki_append` 把它作为 **`headingMatched`** 一并返回，未命中时回执改为「⚠️ 未找到标题「X」，已改为追加到文末」——**不再把「定位失败」伪装成「写进了那一节」**（Agent 因此完全无法自检，这是本 bug 最坑的一点）。顺带把 `heading` 的真实落点语义写进 schema：实为「该标题之后、**下一个任意级别标题之前**」，标题后紧跟子标题时落在两者之间（＝章节开头），并非 schema 原先暗示的「整节末尾」。守门：`verify-tools` +4 条 E2E（CRLF 正文的笔记必须 `headingMatched=true` 且标记落在目标段内、段内不得混入裸 LF；未命中必须 `headingMatched=false` 且回执含「未找到标题」、不得再宣称写进该段落；命中时的反向保护；wikitext `!` 标题同样可定位），**已反向验证**（撤掉 lib 里的行尾 CR 剥离即红 1 条）。
- **v0.26.5**（2026-09-23）：**修 P0：`fields` 参数被按字符拆成几十个垃圾字段**（用户实测复现两次后报障）。现象：`tiddlywiki_put` / `batch_put` / `append` 传 `fields: {"review-after":"2026-12-22"}` 后，条目上出现 `0={`、`1="`、`2=r`… 几十个**单字符字段**，真正的自定义字段**一个都没写进去**；又因为 `fields.type` 是**改内容类型的唯一入口**，这期间也无法把条目写成 wikitext / `text/css`。**根因两层**：① 参数 schema 声明为 `{type:'json'}`，而 DSH 的 schema 里 `type:'json'` 是**纯注解**——编译后连 `type` 都没有（`src/sdk.ts` 的 `compileValue`），模型收不到「这是个对象」的信息，于是把 JSON 当**字符串**发来；② 新建笔记 + 自动工作区标记走 `withWorkspaceMark()` 的 `{ ...(fields ?? {}) }`，而**展开字符串是按字符展开**的（`{...'{"r"'}` → `{0:'{',1:'"',2:'r'…}`），这些索引键随后被当成自定义字段写入；旧 `applyCustomFields()` 对非对象又是**静默 return**，所以全程没有任何报错。**修复（三处）**：① 三个写工具的 `fields` schema 改成真正的 `object` + `additionalProperties: true`（模型能直接看到类型）；② 新增 `normalizeFieldsArg()`（`write-policy.ts`）——对象原样返回、`undefined`/`null`/空串视同未给（保留基底）、**JSON 字符串解析成对象**（兼容仍按字符串发参的模型）、数组/数字/解析不出对象的字符串**明确抛错**；`defineTool` 相应新增 `normalizeArgs` 钩子，让归一化跑在 schema 预校验**之前**（放到之后会被「must be an object」先拦掉，兼容层就没机会生效）；③ `applyCustomFields()` 遇到非对象**抛错**而不是静默忽略，`withWorkspaceMark()` 只为已归一化的对象做展开。守门：`verify-write-policy` +5 条纯函数（字符串解析 / 对象原样 / 三种坏输入拒绝 / 字符串在 `buildWriteTiddler` 处被拦 / 归一化后无索引键），`verify-tools` +4 条 E2E（三个工具的 schema 必须 `type:object`、按字符串发参仍写对字段且不产生 `0=` 垃圾、坏输入明确报错且不留半成品条目、`append`/`batch_put` 走同一套归一化）。**注意**：本次修复只影响写入端；已被写进条目的垃圾字段需要重建该条目（`fields` 只能覆盖、不能删除单个字段），本机知识库已扫描确认无残留。
- **v0.26.4**（2026-09-23）：**修「发送给 Agent」因配置被浏览器自动填充而 404 + 设置页文本框防自动填充**。实测：设置页「TW 端请求基址」（`ui.sendToAgent.endpoint`）被浏览器自动完成当成 URL/账号字段填进 `/dsh-tiddlywiki/tw/root`，于是 send-to-agent 把请求拼成 `/dsh-tiddlywiki/tw/root/agent/sessions`，命中 TW 代理子路径 → 404「获取会话列表失败」。**两层加固**：① 设置页 `textField` 一律 `autocomplete=off`（`tokenField` 早已如此，URL 类文本框 `endpoint`/`git.remote`/`wechat.dsn` 等不再被自动填充污染）；② send-to-agent bundle `baseEndpoint()` 校验自定义 endpoint——一旦含 `/tw/`、`/api/`、`/recipes/`、`/files/` 等 TW 子路径或非 origin/根绝对路径（判为浏览器误填），**回退到 `location.origin + "/dsh-tiddlywiki"` 自动推导**，按钮不再因误配 endpoint 而 404。另修 `scripts/gen-seed-send-to-agent.mjs` 模板字符串里一处未转义反引号（`ok:false`）导致再生成 seed 必崩的 bug。bundle send-to-agent 0.3.5→0.3.6。
- **v0.26.3**（2026-09-23）：**修正 starter-docs 教程里一处技术性错误说法**：「方法一」原来写「点标签后 TW 会自动生成该标签的页面，列出所有带此标签的笔记」——这不准确。实测（TiddlyWiki 5.4.1 内核，已核对 `$:/config/ViewTemplateBodyFilters.multids` 与 `$:/core/ui/TagTemplate`）：内核**没有**"标签页"这种自动页面，点标签丸/侧边栏标签弹出的是**下拉列表**（`list-tagged-draggable`，全量不分页），直接打开以标签命名的条目只会看到条目本身（缺失则提示），不会自动列出成员笔记。教程现在如实描述弹层行为与它的局限（不分页、不可分享链接），并指出想要「一个页面 + 可翻页」的标签列表应自行写汇总页（笔记多时套分页）。纯 seed 文案修正，不影响任何运行时行为；新装 wiki 的「示例与文档」seed 应用新文案，已有 wiki 不受影响（seed 是 ONE-SHOT）。
- **v0.26.2**（2026-09-22）：**修「catalog 标题用目录名推导」——`codemirror-fullscreen-editing` 的真名其实叫 `$:/plugins/tiddlywiki/codemirror-fullscreen`**。`bundledCatalog()` 一直用 `$:/plugins/tiddlywiki/${目录名}` 拼标题，而 npm 包里这个插件目录名与 plugin.info 声明的 `title` 不一致（全包仅此一例，本机实测确认）。v0.26.0 引入的状态徽标按**完整 tiddler 标题**匹配，于是这个插件一旦在 TW 里被禁用，行内不会出现「TW 内已禁用」徽标（勾选不受影响——勾选按 `tiddlywiki.info` 的插件名）。**修复**：标题改为**优先取 plugin.info 的 `title`**，缺失/为空才回落目录名（plugin.info 才是 TW 真正加载的那个 tiddler，是权威来源）。守门：`scripts/verify-plugin-runtime.mjs` 新增 2 条——① 行为断言（fixture 里目录名与 `title` 不一致时必须采用 `title`，无 `title` 时回落目录名）；② **不变量断言**（遍历真实 npm 包的全部自带插件，catalog 标题必须逐条等于其 plugin.info 声明的 title，并单独锁定 codemirror-fullscreen 这一例），**已反向验证**（把优先逻辑去掉即红 2 条）。
- **v0.26.1**（2026-09-22）：**修 P0：设置页插件/主题/语言的勾选框全部显示为「未勾选」，且误点「应用」会把启动清单整个清空**。回归由 v0.25.0 的 `CatalogPending` 引入（commit 883196f）：契约是「`undefined` = 用户还没碰过、完全跟随服务器」，而挂载时把它初始化成了 `{ plugins: new Set(), themes: new Set(), languages: new Set() }`——`desiredPlugins()` 用 `??` 回退，而**空 Set 不是 `undefined`**，于是「没碰过」被读成「用户期望集合为空」：① 所有勾选框全空（用户看到「TW 里明明装着的插件，这里一个都没勾」——本次由作者实测报障）；② 更严重的是，什么都没改就点「应用插件」会 POST 一个**空数组**，把 `tiddlywiki.info` 的 `plugins` 清单**整个清空**（主题清单、语言同理：一次误点等于卸载 codemirror/menubar/全部主题/中文语言，TW 重启后只剩内核 + 自动补装的 markdown）。**修复**：初始化改为空对象 `{}`；并给三个「应用」按钮加闸门——`pending.* === undefined`（未碰过）时按钮禁用、点击直接返回，只有真正改过勾选才允许提交（「用户刻意取消全部勾选」仍是合法提交，host 的 no-op 守卫照旧兜底）。顺带把「wiki 内已装」徽标的判据从 `desiredPlugins()` 改为服务器集合 `serverPlugins`——徽标描述当前事实，不该随未应用的勾选抖动。守门：`scripts/verify-plugin-runtime.mjs` 新增 4 条（空对象初始化 + 三个闸门 + 三个 sync 函数必须在 change 回调里重算按钮 + 徽标判据），**已反向验证**（改回空 Set 即红）。
- **v0.26.0**（2026-09-22）：**修「设置页插件管理与 TW 实际状态对不上」——两套真相源不再互相说谎**。现象（作者本机实测）：TW 控制面板里明明启用着的插件（TiddlyFlex、mermaid、pinboard 等经 TW 原生插件库装的），设置页勾选清单里**根本不出现**；反过来 menubar / comments / help 在 tiddlywiki.info 里（勾选着），但用户早在 TW 面板里禁用了它们。根因：**设置页只读 `tiddlywiki.info` 的 `plugins` 数组（启动安装清单），而 TW 运行时集合 = tiddlywiki.info ∪ 以 tiddler 形式装进 wiki 的插件 − `$:/config/Plugins/Disabled/<title>`（正文为 `yes`，TW 核心自己的判定）**——两个面板读的不是同一份真相，谁也没错但谁也不全。**修复（方向「修真」）**：勾选语义保持「是否写入 tiddlywiki.info」不变（它只管引擎自带插件的离线启停，这是 TW 原生界面做不到的唯一能力），但把缺失的另一半真相显示出来——① 每个插件行加状态徽标：「TW 内已禁用」（勾选着但被 TW 禁用）/「wiki 内已装」（不在启动清单但 wiki 里有同名 tiddler 版本，TW 运行时已在用）；② 新增只读小节「**wiki 内插件（经 TW 原生安装）**」，列出第三方插件 tiddler（名称/版本/描述/禁用状态），启停/卸载引导去 TW 控制面板；③ 区块说明文字写明两边分工。**实现**：`GET /admin/state` 新增 `runtimePlugins` 字段，由 `scanWikiRuntimePlugins()`（`src/host/admin.ts`）扫 tiddlers 目录得出——插件库安装的插件是 `$__plugins_*.json` + `.json.meta`（只读几十字节的 meta，不碰几 MB 的插件 payload；无 meta 的裸 `.json` 还可能是拖拽导入的**多 tiddler 数组**，一并解析）；禁用标记 `$__config_Plugins_Disabled_*.tid` 按文件自身 `title:` 头还原插件标题（不做有损的文件名反解码）。扫描失败返回 `null`（读失败 ≠ 不存在），客户端隐藏徽标与小节而不是显示空的假象；`dsh/*`、`dsh-tiddlywiki/*` 命名空间（插件自己的种子 bundle）排除在外。产品哲学不变：插件对 wiki 的强制定制依旧只有 `--init server` 基线 + 自动补装 markdown + 3 个核心种子，官方自带插件之外的安装/管理全部留给 TW 原生界面。
- **v0.25.1**（2026-09-21）：**修「回复流里的 wiki 链接点了打不开」**——根因在 **DSH web 的 markdown 渲染器**把 `[标题](/dsh-tiddlywiki/tw/#标题)` 这类相对链接**解析成绝对 http(s) URL**，再按 protocol 判为「外链」（`target="_blank"` + 自己的 `openExternalLink` onClick）。旧 `installWikiLinkInterceptor` 只匹配相对路径正则 `^/dsh-tiddlywiki/tw/#(.+)$`，绝对 href 匹配不上 → 拦截器不接管 → 点击落入 DSH 外链逻辑，在新标签页打开 TW 编辑器而不是中央面板（用户感知「打不开」）。**修复**：拦截器改用 `new URL(href, window.location.origin)` 归一化后判**同源 + `pathname === TW_PROXY_BASE` + hash 非空**（相对/绝对两种形态都接），在 capture 阶段 `preventDefault + stopPropagation` 抢在 DSH 外链 onClick 之前打开中央 TW 面板；`scripts/verify-tool-views.mjs` 新增源码级断言（必须用 `new URL` + 同源校验 + 代理 pathname，且旧相对正则已移除）。headless Chrome 实测：TW 面板 hash 导航（含 TiddlyFlex 的 `$:/StoryList-1`）本身正常，问题确在拦截器漏匹配绝对 href。
- **v0.25.0**（2026-09-20）：**第五轮代码审计的修复版**（审计那天被用户判定为「本地单机可接受、不修」的只有一条：`POST /render` 的 **title 分支**可以经被渲染条目正文里的 `{{…}}` 转写把插件配置读出来——本机实测复现，`text` 分支早已 403；不修的理由是单机自用、且真正的边界本就不在这条路由（任何笔记正文的 `{{$:/plugins/dsh-tiddlywiki/config}}` 在嵌入式 TW 面板里同样会被转写渲染）。其余全部修掉，按性质分四组。**① 工具契约（数据安全）**：(a) **`tags: []` 现在真的清空标签**——此前 `normalizeTagArg()` 把空数组归一成 `undefined`（=「未传 = 保留原标签」），而 `tags` 又是 `RESERVED_TIDDLER_FIELDS` 成员（`fields.tags` 会被拒），于是**没有任何途径**把一篇笔记的标签改成空：模型照 `tiddlywiki_lint` 的 junk-tags 建议去清标签、传 `[]`，什么都不会发生，回执还把旧标签原样列出来（本机实测）。(b) `tiddlywiki_append` / `tiddlywiki_rename` / `tiddlywiki_batch_put`（逐条目 `expectedModified`）补上**乐观并发令牌**：这三条与 put/delete/attach 一样是「读全文 → 整篇回写」（append 读旧基底再加一段），而可传令牌的只有后三条 —— 注入提示词让模型回传 `expectedModified`，append 却**没有这个参数**，人类在 TW 编辑器里的并发修改会被旧基底静默回滚。(c) `tiddlywiki_rename` 更新引用时**逐个重读引用者**（列表只是快照），遍历期间被改动过的跳过并在回执里报出数量——跳过一条链接可以手工补，被覆盖掉的一段正文不可恢复。(d) `tiddlywiki_attach` 的 `noteTitle` 指向二进制附件时明确拒绝（会把 base64 写坏而回执看着正常）。(e) `tiddlywiki_lint` 的 `checks` **拼错不再谎报干净**：本机实测 `checks:["broken-link"]`（少了 s）在 2933 条笔记的知识库上**一个检查都没跑**，回执却是「扫描 2933 条文本笔记，发现 0 个问题 / 没有发现问题」；现在回执列出**实际运行**的检查、显式报出无法识别的名字，且「一个检查都没跑」不再等于「没问题」。(f) `valid-until` / `review-after` 的纯日期（`YYYY-MM-DD`）改按**当地日终**判过期，此前按 UTC 0 点算，东八区当天 08:00 就报「已过期」。**② 设置项（都是「保存了却不变」）**：`git.autoCommit`/`git.debounceMs`/`git.remote` 保存后**对运行中的插件立即生效**（`AutoCommitter` 在构造时把 enabled/debounceMs 快照进不可变 options，remote 只在启动 bootstrap 时应用——此前关掉自动提交仍会 commit、换远端仍推老地址，直到重启 dsh web）；「重启 TW」按钮的 15s 超时改为 120s（`/admin/restart` 要等 TW 就绪，软窗口默认 60s、大知识库自述 44s+，此前会弹「重启失败」而宿主其实成功）；数值项（`bridge.port` / `startup.readyTimeoutMs` / `ui.allArticles.pageSize` / `git.debounceMs`）加 `min`/`max` 与字段旁红字，非法值**拒绝保存**（宿主对越界值是静默夹取/回落，提交只会继续制造「回显 ≠ 生效」）；**空补丁不再发请求**、宿主在序列化文本逐字节相同时**跳过 PUT**（每次空点「保存配置」都会重写配置 tiddler 并刷新 `.meta` 的 `modified` → 白造 git diff、两台机器各点一次就冲突在 `.meta` 上，与 v0.24.2 刚修的 `$__language.txt.meta` 同类）；保存被拒（409，如配置 tiddler 残留冲突标记）时错误**持久显示**在配置区而不是一闪而过的 toast；微信发布的 `command`/`adapter`/`token`/`dsn` 补齐 UI（token 密码型 + 👁 显隐切换，掩码回填语义照旧）；插件/主题/语言的未应用勾选提升为页面级状态，能活过「同步 / 重启」触发的重刷；表单有未保存内容时若配置在**别处**被改过，保留你的输入并显式提示，而不是重建表单把输入清掉；首屏加「加载中…」、加载失败不再清空已填表单。宿主侧 `/admin/config` 的补丁现在必须过新的 `normalizeConfigPatch()`：**已知数值夹取到真实边界、已知布尔/字符串类型错误返回 400 并点名字段、`__proto__`/`constructor`/`prototype` 一律拒绝、未知键透传**（此前任意 JSON 都会落进配置 tiddler——数组体变成 `{"0":1,"1":2}` 这种永久垃圾键，`git.debounceMs: "abc"` 会经 `??` 进 `setTimeout` 被当 0 → 每次写入都 commit）。**③ 会话「知识库」Tab**：`NOTE_TOOL_NAMES` 补 `append`（「增量写入」）/`attach`（「附件」）/`delete`/`trash`（`restore` 计产生），新增「🗑 删除 / 回收站」一节——此前**用 append 写的笔记在这个 Tab 里完全不可见**，而注入提示词恰好推荐「纯增量内容优先用 append」，于是一整轮工作会被显示成「本会话暂时没有产生、读取或检索过任何知识库笔记」；事件日志读不出来的会话**在页面上明说**（不再静默吞掉、把「读不出来」显示成「没碰过笔记」），`counts.sessions` 只统计成功读取的会话；读日志从串行改 **4 路有界并发**、探测整段加 **12s 墙钟预算**（最坏 ~375s → 有界，客户端 25s abort 之后不再继续压着 TW 打），生成加 **3s 单飞复用**；客户端自愈改为**三态探测**（在 / 被清 / 状态未知——未知既不计失败也不清零，此前 `catch { return true }` 把「探测失败」当「一切正常」），自愈 interval 与 `phase` 解耦（进 error 态后不再永久失去重试），并新增**按 3 分钟节拍的静默刷新**（tab 长期开着也能跟上会话，不闪 loading 不砸内容）；`escapeInline()` 中和 `{}`（会话日志里出现的 `{{…}}` 会被 `/render` 转写展开）并改为**先截断再转义**（否则 `&amp;` 会被截成 `&am`）；`scanRefs` 不再把标题里的 `)`/`]` 一律截断；`TitleState.snippet` 从死字段改为真的渲染。**④ 其余**：检索卡片的范围与工具结果对齐（卡片把模型可见回执里读到的 `workspace` 回传 `/search`，v0.24.0 只改了工具侧——卡片会列出**更多**的结果且不显示范围）；`/status` 的 git 冲突内容扫描加上限（200 个文件 / 2MB，批量导入期间不再每 30s 同步读几千个文件阻塞事件循环）；`tiddlywiki_delete` 的描述写明 `$:/` 系统条目实为永久删除；`TiddlywikiConfig.note` 补上漏掉的 `workspaceMark`（三处形状 lockstep）；`tiddlywiki_attach` 有专属卡片。**守门**：新增 `scripts/verify-config-patch.mjs`（6 组纯函数断言：非对象拒绝 / 越界夹取 / 类型错误点名字段 / 危险键拒绝 / 未知键透传）与 `scripts/verify-tool-views.mjs`（5 条源码级断言：`TOOL_VIEW_KEYS` 与 host 工具名完全一致 / `TOOL_LABELS` 全覆盖 / 工作区前缀两处一致 / 搜索卡片仍回传 `workspace`），两者进 `verify:unit`；`verify-tools.mjs` +4 条真实 TW 断言（`tags:[]` 清空且「不传」仍保留 / append 令牌不匹配拒绝、匹配放行 / batch 逐条失败 / lint 未知检查名不得谎报）；`verify-write-policy.mjs` +1 条（空数组 vs 不传的语义边界）。**已反向验证的路径**：把 `normalizeTagArg` 还原成「空数组 → undefined」、把 lint 的 `checks` 还原成自由集合、把 append 的令牌检查删掉，对应断言分别变红。
- **v0.24.2**（2026-09-20）：**修「`$:/language` 每次 dsh web 启动都被无条件重写 → 两台机器每次 pull 都冲突」**。现象：`git pull` 稳定卡在 `tiddlers/$__language.txt.meta` 上，而**正文文件根本不冲突、diff 出来只有 `created`/`modified` 两行**；本仓库的 git 历史里甚至已有一条专门清理该冲突残留的提交，而 2026-09-20 一次会话内又撞了两次。根因定位到行：启动自举应用 `uiLanguage` 时、以及设置页改动语言时，两处都**无条件 PUT** `$:/language`（正文每次都一样，但 TW 会给 `.meta` 盖新时间戳）——两台机器各自启动过就都改了同几行。现在抽出 `pinLanguageTiddler()`（`src/host/admin.ts`）：**先读，内容一致就不写**，内容不同/条目不存在才写。⚠️ 关键边界：**读失败绝不等于「内容相同」**（铁律第三条）——`client.get()` 只有 404 返回 undefined、其余抛错，抛错时**照写并记一条日志**，否则用户的语言会永久卡在错的值上且重启也修不回来。**守门**：新增 `scripts/verify-language-pin.mjs`（进 `verify:unit`）——4 条桩 client 行为断言（一致不写 / 不存在要写 / 不同要写 / 读失败照写并报警）+ 源码级断言（`index.ts` 与 `admin.ts` 除原语自身外**一处裸 PUT 都不许有**，且两处都必须经 `pinLanguageTiddler`）。**已反向验证**：还原启动路径为无条件 PUT → 红 1 条；把读失败分支改成「直接 return false」→ 红 1 条。（附带一条方法论教训：第一次做这条反向验证时**构建因我的改写而失败**，而我把构建输出丢进了 `$null`，于是守门测的是旧 `lib/`、假绿了一轮；重做时把构建输出放回台面才抓到真红。反向验证必须确认「改动真的被编译进去了」。）
- **v0.24.1**（2026-09-20）：**修「重启/停止 TW 的四个路径里有三个没排干 syncer 队列」——一类静默丢写入的缺陷**。本仓库铁律第一条要求「重启 TW 前必须把 syncer 队列排干」，但那条规则**只写在文档里**：`POST /restart`、`POST /admin/restart`、`POST /admin/info`（改插件/主题后重启）与「知识库切换」的 `stopServer` 全都是**直接杀 TW 子进程**，而 TW 的 REST PUT 返回 204 时条目还在内存里、文件系统 syncer 要 ~250ms 后才落盘 —— 在那一秒内点「重启 TW」，刚写的笔记就随子进程一起消失（与 v0.19.0 丢 `tw-web-host`、v0.22.0 才发现 throttle 竞态同一类）。只有启动自举 / seed / `/sync` 三处走了 `flushPendingWrites`。**根因不是谁写错了某一行，而是「规则」和「代码」之间没有强制关系** —— 所以这一版不是补四个调用点，而是把不变量变成**原语**：新增 `drainThenStop()`（`src/host/seeds.ts`，**排干发生在它内部**，签名是 `{client, tiddlersDir, stop}`），四个路径全部改为经它停/重启，调用方**没法**绕过；`stop` 的返回类型放宽为 `Promise<unknown>`（`restart()` 回状态视图、`stop()` 回 void，排干都不关心）。`/restart` 与 `/admin/restart` 的回包新增 `drained`，排干不完整时如实上报而不是静默。**守门**：新增 `scripts/verify-restart-drain.mjs`（进 `verify:unit`）——① 顺序断言：`drainThenStop` 内部「排干的 await」必须早于「stop 的 await」，且排干失败必须走显式分支后**仍然 stop**（best-effort：不能因为排不干就把用户锁死在起不来的 TW 上）；② 源码级断言：`routes.ts`/`admin.ts` 里**每个** `deps.server.restart()` 都必须作为 `drainThenStop({stop: …})` 的参数出现（裸 restart 即红），`index.ts` 的 `stopServer` 必须包在它里面；③ 行为断言：用桩 client 真跑一遍，确认「写入真的落盘之后才 stop」「client 缺失（TW 没在跑）是安全 no-op」「排干失败也继续 stop 并把警告交出去」。**已反向验证**：分别把 `/sync` 路径、知识库切换还原成裸调用、并删掉 `drainThenStop` 里的 `stop`，三次都稳定变红。顺带把 `/sync` 与 seed 两条**本来就在 flush** 的路径也收敛到同一原语，从此「重启前排干」只有一个实现。
- **v0.24.0**（2026-09-20）：**三处「Agent 读写 wiki 的规矩」按用户要求改进 + 一个 lint 误报修复**。① **新建笔记自动标工作区**：`put`/`batch_put`/`append` 新建条目时自动带上 **`ws/<项目名>` 标签 + `workspace` 字段**，项目名取自调用会话的工作目录（新 `src/host/workspace.ts` 纯函数：Windows/Unix 路径、尾斜杠、CJK、非法字符规范化；`home`/`tmp`/`desktop` 这类通用目录与**驱动器根目录**一律拒绝——后者是写这个模块的守门脚本抓出来的真缺陷：`C:\` 会被算成 `C:`，在盘根开会话时全盘笔记都挂上 `ws/C:`）。标记是**附加式**（调用方标签在前）、**仅新建**（覆盖不追打，也不会改写已有 `workspace` 字段）、`$:/` 豁免、`note.workspaceMark: false` 可关、调用方显式 `fields.workspace` 优先；`exec` 缺失 / 会话无 `cwd` / 未知会话一律**安全降级为不标记**（不猜、不抛错）。为什么标签必须带 `ws/` 前缀：裸项目名与真实业务标签撞车——作者库里 `dsh-tiddlywiki` 已挂着 2510 篇导入的书籍章节。② **检索先窄后宽 + 多词 AND**：`tiddlywiki_search` 先在工作区内查、**区内 0 条才自动扩大到全库**，回执明确写出「已在工作区 ws/X 内缩小范围」或「工作区 ws/X 内 0 条，已扩大到全库」（**「工作区内 0 条」不等于库里没有**，这是把「搜不到」错判成「不存在」的主要来源）；`query` 从**整串子串匹配**改为按空白切词、**全部词命中**才算（旧行为连 `alphaprobe betaprobe` 这种自然的双词查询都永远匹配不到）；调用方显式传 `tag`/`field`/`value` 时**不自动收窄**（显式范围不被二次猜测）。③ **过期内容淘汰策略（只提示，绝不自动删）**：阶段性笔记写 `valid-until`（硬过期）/ `review-after`（该复查），被取代时写 `superseded-by` + `superseded` 标签、**保留旧笔记**；`tiddlywiki_lint` 新增 `stale` 检查（默认开启、`staleAfterDays` 默认 180），报 `stale-expired` / `stale-review` 两类**硬判定**加一类 `stale-candidates`（带版本号或 `done` 标签且长期未改动，**明确标注「候选，非判定」**）。**淘汰只由人决定**——报告全程只读，不删不改不归档。④ **修 lint 死链误报**（v0.23.6 的内容并入本版）：死链正则 `\{\{([^}]+)\}\}` 会把 `{{{ [tag[todo]count[]] }}}` 这类**三花括号过滤器表达式**从第 1 个 `{` 开始捕获成「转写目标」并报死链（实测线上 480 条死链报告里 8 条属此类），现在用前后瞻 + 捕获内容守卫排除。**明确不改的**：≈440 条真实死链**保留不修**——多数是用户手工删掉的笔记，属预期状态（只读报告是对的，自动「修复」是错的）。**守门**：新增 `scripts/verify-workspace.mjs`（进 `verify:unit`，9 组纯函数断言，含「任何 cwd 算出的标签都不得是垃圾标签 / 含空白 / 丢前缀」这条与 `isJunkTag()` 的跨模块一致性检查，以及 `ws/` 前缀不得被「简化」掉的回归），`verify-tools.mjs` +12 条真实 TW 断言（工作区标记六种形态 + 多词 AND + 先窄后宽 + `fellBack` + `stale` 三类），`verify-prompt.mjs` +1 条「三条新治理规则必须在场」并把 slim 长度预算从 1800 调至 2100（**预算上调与新增的逐条断言绑定**：删掉任何一条规则即红）。**所有新守门都做过反向验证**：分别还原旧行为（整串子串检索 / 关掉工作区收窄 / 关掉自动标记 / 关掉 stale 检查 / 去掉驱动器根目录判定 / 从规范化字符集里删掉 `|`）后，对应断言稳定变红。slim 正文实测 1918 字符（full 2722）。

- **v0.23.5**（2026-09-18）：**修 15 处审计缺陷**（第三轮全面审查列出的 18 条，逐条核实后修掉其中 15 条真缺陷；跳过 3 条纯理论性的信息泄露。完整审计报告见知识库笔记「dsh-tiddlywiki 第三轮代码审计」——审计报告是工作文档，不再进 git）。按性质分四组。**① 数据安全（最重）**：`tiddlywiki_delete` 原先**先删原条目、后读回收站索引**，于是「快照已写 → 原条目已删 → 索引读失败」时报"已中止"，但笔记其实已经没了、且没进索引——`trash list` 看不见、`restore` 找不到、`empty` 清不掉，成为永久孤儿（只能从 git 捞）；现在**读校验索引排在所有破坏性步骤之前**，中止即等于"没删"。同一处还有两个洞：`$:/` 系统条目会被**软删除**（删掉 `trash-index` 自己 → 下一次读 404 → 被当成"回收站为空" → 索引被重写成 1 条，丢掉全部记录），现在系统条目一律走永久删除分支，且**删回收站索引被显式拒绝**（要清空请用 `trash action=empty`）。`tiddlywiki_put` 不再把**二进制附件**写成文本（保留基底 `type: image/png` 会让 base64 解不出、图裂而回执说"类型没变"；要转换得显式 `fields.type`）。`git pull` 不再**无条件 `rebase --abort`**——此前只要 pull 失败（含没配 remote、离线等与被 rebase 无关的原因），用户在 wiki 仓库里正在做的 rebase 与冲突解决就被清掉；现在只 abort「我们自己发起」的那个。乐观并发的两个令牌从 **OR 改回 AND**：`revision` 是 TW 的内存计数器（重启/拉取后复位），旧逻辑「`modified` 命中就放行、否则看 `revision`」会让跨重启的写入被判"一致"而**静默覆盖**人类改动，同时传两个令牌也**并不更安全**。配置 tiddler 的 `modified` 不再被钉死成 `created`（`ensureTiddlerTimestamps` 只补缺的那一半，用 now）。**② 崩溃与资源泄漏**：`fs.watch` 补上常驻 `error` 监听（Node 在无监听器时把 `error` 抛成未捕获异常 → 整个 `dsh web` 进程退出；Windows EPERM / Linux ENOSPC 都能触发）；`WikiServer.startOnce()` 在 `spawn` 前**复查 `stopping`**（`stop()` 可在 `await findFreePort()` 期间跑完，此后 spawn 的子进程没人杀 = 孤儿 TW）；知识库切换**回滚失败也必须重装 extras**（此前从 catch 直接返回、跳过 `setupExtras()`，此后所有 wiki 写入都不再被提交，而"迟到就绪"复探让 `/status` 看着一切正常——静默停摆）；`runSwitch` 补 `disposed` 守卫（热重载/关闭期间的在途切换不再重新挂上 committer/watcher，也不在 teardown 之后再 spawn TW）。**③ 行为瑕疵**：`escapePromptBraces` 对**连续花括号**失效（`{{{name}}}` 会残留 `{{`，而 DSH 对未知变量直接抛错、能炸掉整个系统提示词装配正是该函数存在的理由）；`?limit=` 空值不再被夹成 1（`Number('' ?? fallback)` 是 0，`/recent?limit=` 曾只返回 1 条而不是默认 15）；`tiddlywiki_append` 在 `mode=prepend` 时不再回执谎报「写进了某段落」（`heading` 只对 append 生效）；`POST /render` 的超限 body 从 400 改为 **413**。**④ 两处零成本的安全收口**：代理路径判定不再只看字面量 `/tiddlers/`——TW core 的 `get-tiddler-html` 路由是**单段**（`/^\/([^\/]+)$/`），把 `/` 编码成 `%2F` 即可绕过旧守卫（本机实测：修复前 `/tw/...%2Fconfig` 与 `/api/...%2Fconfig` 都返回 **200 + 715 字节配置 JSON**）；`/render` 的 **`text` 分支**也不再是旁路（TW 会解析 `{{…}}` 转写，实测修复前 `{"text":"{{$:/plugins/dsh-tiddlywiki/config}}"}` 返回 200 + 3123 字节配置正文，净化器只管标签、管不住正文），`contextTitle` 一并校验。**守门**：`verify-write-policy` +6 条（令牌 AND 语义 +「证据不足判冲突」+ `onlyCreated` 不再钉死 modified）、`verify-prompt` +1 条连续花括号、`verify-frame-guards` +4 条源码级生命周期断言（`fs.watch` error 监听 / spawn 前复查 `stopping` / 回滚 finally / `runSwitch` disposed）、`verify-audit-fixes` +4 条 E2E（删除顺序：索引读失败后原条目必须仍在、`$:/` 与索引不得被软删、二进制附件拒写、`?limit=` 空值）、`verify-conflict-config-guards` +1 条**真 git E2E**（在真 rebase 中途 pull 失败，用户的 rebase 必须原样保留）、selftest +8 条（编码/双编码代理路径 403、`/render` 转写与 `contextTitle` 403、普通转写仍 200）。**全部 15 条修复都做过反向验证**：把修复还原后，新断言稳定变红。
- **v0.23.4**（2026-09-18）：**三处硬化，全部来自 v0.23.3 上线当天暴露的真实事故**。① **提交前拦冲突（数据安全）**：`git pull --rebase --autostash` 的 **autostash 重新应用**冲突后，`rebase --abort` 已无事可 abort，冲突标记留在工作树里，随后 60s 的 AutoCommitter 照常 `git add -A && commit` —— `<<<<<<< Updated upstream` 就这样被**永久提交并推送**进了 wiki 的配置 tiddler（`0b19ca6`，2026-09-17），插件随即解析不了自己的配置（微信发布一直是关的、`prompt.extra` 静默失效）。现在 `GitFace.conflictState()` 三重探测（进行中的 rebase / 未合并路径 / **工作树里残留的冲突块**），`commit()` 直接抛 `GitConflictStateError` 拒绝提交；`/sync` 回 409 + 文件名、agent 工具返回结构化失败、AutoCommitter 去重上报一次（不去刷屏）；`pull()` 在 abort 后**复检**（autostash 形态正是 abort 之后才暴露）；`/status` 与设置页状态行显示「冲突未解决（N 个文件，已阻止提交）」。⚠️ `MERGE_HEAD`/`CHERRY_PICK_HEAD` 故意**不**硬拒——`git commit` 正是收尾它们的动作（真 git E2E 抓出了这个设计错误）。② **配置解析失败拒绝写（数据丢失）**：`ConfigStore.set()` 在存量 tiddler 解析失败时，原先拿**空缓存**合并 → 一次设置页保存就把配置写成只剩表单里那几个字段的"残版"（18 日 13:38 实测：`prompt.extra`/`git.remote`/`ui.*` 全丢）。现在抛 `ConfigUnreadableError`、不 PUT，并把原因经 `/admin/state` 的 `configError` 渲染成设置页顶部红色横幅；瞬时**读**失败仍走"合并到缓存"（回归断言守住）。③ **adapter 版本校验**：`/wechat/ready` 原先只数文件在不在，旧版 adapter（不认识 `--title-file`、标题仍是必填位置参数）也会报"就绪"，点按钮才在 opencli 里报"缺少必填参数"。现在按**定义**判新旧（`weixin-flow.js` 必须 `export function resolveNoteTitle(`、两个入口必须声明 `name: 'titleFile'`——**不是**字符串出现，注释里提到不算），`missing`（不存在）与 `stale`（过旧）语义互斥；按钮预检与路由 503 分别说「版本过旧」和「缺少发布脚本」。bundle 升 `0.2.0`。守门：新增 `scripts/verify-conflict-config-guards.mjs`（23 条：伪 exec 纯逻辑 + **真起临时 git 仓库的冲突 E2E**（真 merge 冲突 / 真残留标记，且解决后必须能提交）+ ConfigStore 拒绝写/回归/接线断言；**已反向验证**：拆掉 `contentScan` 或配置拒绝各红 2 条），`verify-wechat-publish.mjs` 17→24 条（+注释里提及新符号必须判旧、真源码符号对齐），bundle 守门 +3 条。
- **v0.23.3**（2026-09-18）：**TW 笔记工具栏新增「发布到公众号」按钮**（可选功能，与既有 CLI 等价，只是不用敲命令）。链路：TW 按钮 → `POST /dsh-tiddlywiki/wechat/publish` → 宿主 spawn `opencli weixin publish-note` → `GET …/wechat/publish/status` 轮询 → 覆盖层显示进度与日志尾部。**只到草稿箱为止**，发表仍由人工扫码（沿用 v0.23.2 定的策略）。三处硬骨头：① **标题不进 argv**——Windows 上 `opencli` 是 `.cmd` shim，必须经 cmd.exe 启动，于是标题里的 `&`/`|`/`^`/引号成了命令注入面、中文标题还会被 cmd 的代码页解成乱码；改成宿主写 UTF-8 文件 + adapter 新增 **`--title-file`**（位置参数照旧可用，两者都给时位置参数优先）。② **任务化而非同步请求**——命令要跑几十秒到几分钟，`POST` 立即返回 `jobId`，单并发（第二次 409）、15 分钟上限，超时用 `taskkill /T` 杀**整棵进程树**（只杀 cmd.exe 会留下孤儿 node 抓着 job 目录，实测 `EBUSY`）。③ **可选功能默认不打扰**——`wechat.enabled` 关着时三条 `/wechat/*` 路由一律 403、按钮插件不写进 wiki（新增 gated 起步 seed `wechat-publish`，与 `publish-spec`/`wechat-setup` 同进同退）。新增 `src/host/wechat-publish.ts`（命令组装纯函数 + job registry + 就绪探测）、三条路由（方法/同源守卫 + 可选 `x-wechat-publish-token`；`wechat.token` 与其它密钥一样在 `/admin/state` 打码）、TW bundle `$:/plugins/dsh/wechat-publish`（`scripts/bundle/wechat-publish/` + build/gen/verify 流水线，`wechat-publish.bundle.json` 逐字节守门）。守门：`scripts/verify-wechat-publish.mjs`（17 条：纯函数 + **真跑 spawn 的「假 opencli」E2E**（含标题不进 argv 的逐字断言）+ 真实 HTTP 路由守卫；**已反向验证**：拆掉 `guardWechat` 即红）+ `scripts/verify-wechat-publish-bundle.mjs`（进 `verify:static`）+ `verify-wechat-adapters.mjs` 新增「两个 publish adapter 都必须走 `resolveNoteTitle`」。
- **v0.23.2**（2026-09-17）：**多图发布命令 `publish-note-imgs` + 发布策略定为「到草稿箱为止」**。TW 笔记内嵌 `[img[...]]` 经 `/render` 是 data URI，微信存草稿会过滤非 mmbiz 图——新命令先把正文全部图片经 DataTransfer 逐张上传 CDN（轮询计数到期望值），按 DOM 顺序重写正文 src 再 insertHTML，从正文第一张设封面；发布前同样读 `pub-state`/`no-publish`（只告警不阻断）。`selectCoverFromContent` 封面校验改轮询，修「实际成功却报失败」的假阴性（实测 `list_ex` 的 `cover` 已是 mmbiz 而流程报失败）。安装脚本 FILES 收编至 5 个 adapter，守门断言同步。**策略**：adapter 负责到草稿落盘为止，发表（含原创声明/作者/留言等确认弹窗 + 管理员扫码）由人工完成——`--publish` 保留但 best-effort，遇弹窗会等到超时。文档新增：发表确认弹窗说明、`stale page identity` 续作法、`list_ex`/`appmsgpublish` 核实命令、GitHub ext release 落后 Web Store 备注、npm allowScripts 拦 postinstall 无害备注、**eval 诊断后台必须过滤不可见 toast 残留**（踩过：把残留文案当实时状态误判账号被拦，实际账号正常）。

- **v0.23.1**（2026-09-17）：**新增 `wechat-setup` seed——「微信公众号发布指南」也随插件分发**（补齐 v0.23.0 的缺口：当时只有「发布元数据规范」进了 seed，387 行的安装/换机还原指南只存在于仓库与 npm 包的 `docs/` 里，wiki 里那篇「换机还原清单」是手写指针笔记）。与 `publish-spec` 完全同模式：起步层（`startup: true`）+ `gate: (ctx) => ctx.wechat === true`——**只在设置页开启「微信公众号发布」时**启动写入（笔记「微信公众号发布指南」，`dsh-docs` 标签自动进首页插件文档栏），不开该功能的用户 wiki 不出现、设置页手动「初始化」不受 gate 约束。**内容单一来源**：新 gen 脚本 `scripts/gen-seed-wechat-docs.mjs` 从 `docs/wechat-publish-setup.md` 生成 `src/host/seed-wechat-docs.ts`（照 send-to-agent 的 gen 流水线，勿手改常量），新守门 `scripts/verify-wechat-docs-seed.mjs`（进 `verify:unit`）断言 seed 常量与文档**逐字节一致** + 注册表 gate 接线（2 个 gated seed = gate 谓词恰好 2 处）。顺带：`verify-package-contents.mjs` 的 `npm pack` 从管道捕获改为**文件重定向 + 临时缓存目录**（DSH 沙箱禁止命名管道 stdio → 原 `exec` 实现 EPERM；npm 默认缓存在沙箱外也要绕开），本地终于能跑这条守门。selftest / verify-seed-error-policy 的 gate 断言改为**从注册表派生** gated 清单（新增 gated seed 不再漏改硬编码）；设置页与 config 注释同步「开启后写两篇文档」；docs/seed-initialization.md 补齐 publish-spec / wechat-setup 两行表格。

- **v0.23.0**（2026-09-17）：**新增「发布到微信公众号」+ 发布元数据**（`tools/wechat/`，**可选功能，默认关闭，需额外安装**，不动 host 代码）。把 wiki 笔记一键发到公众号**草稿箱**，可选点发表。

  **⚠️ 可选功能，默认关**：真正干活的是仓库 `tools/wechat/` 下的 opencli adapter + Browser Bridge 浏览器扩展——**插件本体不含它，也不会替你装**。开关 `wechat.enabled` 默认 `false`：**关闭时**不注入任何发布相关提示词、也不往 wiki 写「发布元数据规范」文档；**打开后**仅多这两项，不会安装任何东西、不启用任何后台服务。不装／不开它，插件其他功能完全不受影响。开启方式：设置 →「TiddlyWiki 知识库」→「可选功能：微信公众号发布」→ 勾选 → 保存配置。完整安装步骤（opencli、浏览器扩展、扫码登录）与排错见 [docs/wechat-publish-setup.md](docs/wechat-publish-setup.md)。

  **为什么不用官方 API**：2025-07 起官方回收了「发布能力」接口对个人主体/未认证账号的调用权限（`freepublish/submit` 不可用、`draft/add` 常回 48001）；即便可用还要配 API IP 白名单、封面永久素材、正文图片必须走 `media/uploadimg`。**本方案改走浏览器自动化**，复用你**已登录**的公众号后台会话（opencli + Browser Bridge 扩展），个人号可用、零凭据落盘。数据流：笔记标题 → DSH `POST /render`（TW 自己渲染成语义 HTML，**代码高亮白蹭**）→ `wechat-html.js` 补**内联样式**（实测微信会剥 `<style>` 并删 class，**只认内联 style**；而 TW 输出零内联样式，所以必须有这一步）→ `weixin-flow.js` 驱动后台填表/写正文/传图/设封面/存草稿。
  
  **发布元数据**（本轮追加，解决「哪些发过 / 哪些不能发」）：每篇笔记用自定义字段记录对外发布状态——`pub-state`（`draft`/`published`/`excluded`）、`pub-platform`、`pub-wechat-at` / `pub-wechat-title` / `pub-wechat-url`（**按平台分字段**，将来 `pub-zhihu-*` 直接平铺）、`pub-note`；标签 `no-publish` 作为给人看的镜像。**规范全文放进 seed**（「发布元数据规范」，`dsh-docs` 标签），因为注入提示词 slim 形态实测只剩几十字符余量，只在其中放**一句指针**；该 seed 带 `gate`——**只有开启可选功能才会写**。⚠️ 三个名字**已被占用**故特意避开：`publish`/`publishyear` 是 Obsidian 导入书籍的「出版社/出版年」，`发布记录` 是本插件自己的版本说明。存量来源可辨的公众号文章（`source-path` 含「公众号」，本 wiki 实测 18 篇）用 `tools/wechat/backfill-publish-state.mjs` 回填（**默认 dry-run**；先 GET 完整 tiddler 再只添加字段整体写回；已有 `pub-state` 跳过；正文为空跳过；发表时间无法考证就留空）。发布前检查**只告警不阻断**（读 `pub-state`/`no-publish` 命中就打印警告并继续，`--force` 仅改措辞），回执里附**建议回写值**供 agent 回写。
  
  **四个实测踩坑**：① **必须带 `--trace retain-on-failure`**——不带就对 `mp.weixin.qq.com` 稳定报 `Navigation rejected`（trace 开 5/5 成功、关 8/8 失败；`--site-session ephemeral` / `--keep-tab false` / 前后台窗口 / 重置标签页 / 重启 daemon 全部无效，是 opencli 1.8.7 的 bug）；② **轮询里绝不能读 `document.body.innerText`**——微信编辑器 DOM 极大，读一次强制整页 layout，**实测单次 ≈17 秒**，8 次轮询把命令拖过 210s 超时而**草稿其实已保存成功**（假阴性）；改成只查少量 toast 节点后 `saveDraft` 从 **137 秒降到 3.9 秒**；③ **图片上传必须用 DataTransfer 注入**，不能用 `page.setFileInput`（后者依赖 CDP `Page.fileChooserOpened`，本机扩展版本组合下稳定失败；DataTransfer 在页面上下文直接塞 `input.files`，实测图片真进 `mmbiz` CDN，代价是单图 8MB 上限）；④ **正文必须用 `execCommand('insertHTML')`**，`insertText` 会把 HTML 当字面文本（opencli 内置 `weixin create-draft` 就是这样，实测 Markdown 符号原样进库）。**发表需管理员扫码**——微信的账号安全机制，无法自动化，「一键」的真实含义是「脚本做完排版/上传/填表，你只扫一次码」；默认走**发表**（不推送粉丝、不占群发额度）而非群发。
  
  命令：`opencli weixin publish-note "标题" [--cover x.png] [--preview out] [--publish] [--force]`（另有 `create-article` 从本地 HTML 文件建草稿）。**换机器还原**：`node tools/wechat/install-wechat-adapters.mjs` 一条命令装好 adapter 并自检扩展/登录状态；完整步骤与排错见 `docs/wechat-publish-setup.md`。守门：`verify-package-contents.mjs` +5 断言（发布包必须含 publish-note / install / backfill / seed-now 与 setup 文档）、`package.json` 的 `files` 白名单补 `tools`，新增 **`scripts/verify-wechat-adapters.mjs`**（进 `verify:unit`，10 条源码级断言：文件齐全、**轮询不得出现 `body.innerText`**、**不得用 `setFileInput`**、装饰器注入内联样式、发布前检查存在且**只告警不抛错**、返回行 key 与 `columns` 一一对应、install 清单与磁盘一致、三个坑的注释在位；**已反向验证**：塞回 `body.innerText` 即红）。调研与本机实测全过程沉淀在 wiki 笔记「公众号发布插件调研」。

- **v0.22.10**（2026-09-17）：**修「写入丢失 `created`/`modified`，新笔记在按修改时间排序的页面上沉到最后一名」**（用户实测报障：日记在「主题页·日志」排 175/175，看着像没被收录）。根因：插件把这两个字段列进 `CLEAN_SKIP_FIELDS`（假设「TW 服务端会补」），但 TW 服务端的 PUT 路由**从不补**时间戳——`getCreationFields()`/`getModificationFields()` 只在 TW 自己的浏览器 UI 里调用，于是插件写的条目落盘只有 tags/title/type；而 TW 的 `sortTiddlers` 对缺失字段取 `fields[sortField] || ""`，`!sort[modified]` 降序时空串直接沉底。**修复**：`buildWriteTiddler()` 统一负责写这两个字段，语义与 TW 编辑器一致——新建 = 都取当前时刻，覆盖 = 保留原 `created`、只刷新 `modified`（基底无 `created` 的迁移存量则补当前时刻）；格式用新增 `formatTiddlerDate()`（TW 的 17 位紧凑 UTC，与 `$tw.utils.stringifyDate()` 逐字节一致，别用 ISO）。两者继续留在 `RESERVED_TIDDLER_FIELDS`（`fields` 不得覆盖），只是不再被 CLEAN_SKIP 丢弃。`TiddlyWebClient.put()` 另有 `ensureTiddlerTimestamps()` 兜底（**只补缺、绝不改写**已有值），覆盖剪藏桥 / seed / 配置 tiddler 等手拼 PUT 的路径。顺带统一：`rename`（含引用改写）与回收站恢复改走共享写策略（原先手拼 body 会把旧 `modified` 原样带过去）；回收站快照与恢复保留原时间戳（恢复 = 恢复原状，`trash-at` 单独记删除时刻）；`/edit` 生成的 TW 草稿携带原笔记的 `created`——TW 保存草稿时草稿字段会覆盖新生成的时间戳，草稿不带它就会把笔记的创建时刻重置成「刚才」。守门：`verify-write-policy` +7 条纯函数（格式往返 / 三种语义 / `$:/` / `fields` 不可覆盖 / 兜底只补不改写），`verify-tools` +5 条 E2E（含用 TW 真实 `!sort[modified]` 过滤器验证排序），selftest 增配置 `created` 保留断言。**存量数据不自动回填**：线上 wiki 1161 个 `.tid` 中 948 个缺 `modified`（多为历史迁移脚本所致），它们仍会在 `sort[modified]` 页面沉底，可用 wiki 根目录的 `backfill-timestamps.mjs` 一次性补齐（默认 dry-run，按 **git 历史**取首次出现/最后变更时间，`--write` 才落盘）。

- **v0.22.9**（2026-09-16）：**修「TiddlyWiki 编辑者署名被静默清空」**（用户实测报障：控制面板 →「信息」→「基础」里的「编辑者署名」填完保存不了、刷新就没了）。根因是 DSH 启动 TW 子进程时（匿名 loopback 分支）**没传 `anon-username`**：`get-status.js:21` 回落到 `""`，而 TiddlyWeb adaptor 判定登录用的是 `isLoggedIn = json.username !== "GUEST"`（`tiddlywebadaptor.js:93`）——`"" !== "GUEST"` 为真，于是**匿名读者被当成已登录用户**；`syncer.js:281-283` 随即在**每次页面加载**时把 `$:/status/UserName` 覆写成那个空串。名字在当次会话里看着还在，一刷新就没了；而一旦 `$:/config/SyncFilter` 放行了 `UserName`（本仓库 wiki 的现状，有一篇专门的踩坑笔记记录），这个空串还会**同步落盘并进 git**，从「内存里丢了」升级成**真实、可追溯的数据丢失**。现在匿名分支显式传 `anon-username=GUEST`（`wiki.ts` 的 `ANON_USERNAME` 常量）：`isLoggedIn` 变 false → syncer **根本不再写** `UserName` → 用户填的名字稳定保留。⚠️ `GUEST` 是**承重的魔法值**，不是随便取的名字：TW 判的就是 `!== "GUEST"` 这个哨兵，填任何人名（含你自己的名字）都仍然算「已登录」，只会把署名覆盖成人名而不是空串。**为什么拖到现在**：`src/host/wiki.ts` 从 v0.16 起就写着一句注释「Passing anon-username/readers/writers here was verified to 401 every request」——它把**两个独立参数**混为一谈，等于给后来每个维护者发了张「此路不通」的牌子。实测（TW 5.4.1）只有 `readers`/`writers` 会关掉匿名访问（`server.js:63-66` 里显式的 `readers` 会让 `(anon)` 不再是 principal，于是 `isAuthorized()` 为 false，`requestHandler` 用当时为 `undefined` 的 `authenticatedUsername` 拼出 `'undefined' is not authorized` 的 401）；`anon-username` **单独**传完全安全（`/status` 200、GET 200、PUT 204）。那句注释已改正并写明真实机制。**副作用（外观级）**：`$:/status/IsLoggedIn` 恒为 `no`，TW 的 SyncerDropdown 会多出一个用不上的 Login 按钮；`wiki.js:1690` 的 `generateDraftTitle` 会从 `Draft/Title` 形态切到 `Draft/Attribution` 形态（内核既有行为，与「快速笔记」的 `/edit` 草稿路由无关——后者按 `draft.of` 字段匹配，不依赖标题字面量）。**影响面**：默认 SyncFilter 的用户**不会**丢盘（`$:/status/` 被默认过滤器整个排除，空串走不到落盘），实际受数据丢失影响的只有**已经放行 `UserName` 的人**——所以这一版主要是消除一颗静默的数据丢失地雷 + 拔掉那句误导注释。守门：新增 `scripts/verify-anon-username.mjs`（进 `verify:e2e`，真实 TW 子进程）——`ANON_USERNAME` 必须字面量 `GUEST`、`/status` 必须回该哨兵、落盘署名不得被覆盖、匿名模式仍可正常写条目、auth 模式不受影响且对匿名请求仍 401，外加源码级断言（旧误导注释必须已删、鉴权分支不得顺手传 `anon-username`）；**已反向验证**：把 `anon-username` 那行去掉即红 3 条。

- **v0.22.8**（2026-09-15）：**第六轮代码审计修复**——host 与 client 各做一份只读审计，逐条核实后修 10 处真缺陷，并清掉一轮重复实现与死代码。① **数据丢失（P0）**：`/edit` 仍会把「调用方文本或笔记已保存正文」PUT 进**刚复用**的那个草稿，而那个草稿里装的是用户在 TW 原生编辑器里敲的**未保存内容**——触发路径极常见：打开快速笔记（标题精确到分钟）→ 写 → 关掉 → 同一分钟内再打开 → 草稿被覆盖。现在只有**我们创建的**草稿才由我们填充，复用的仅在调用方显式给了文本时才写。② **设置页超时（P0）**：`fetchJson` 展开 `init` 后又硬编码 `signal`，于是「知识库切换 / 恢复默认 / 重启 TW」的 120s 预算被 15s 掐断——宿主其实切成功了，用户却看到「切换失败」（大 wiki 冷启动实测 44s+），且重试会再走一遍停/启。③ **净化器崩服务**：`&#1114112;` 这类越界数字实体会让 `String.fromCodePoint()` 抛 `RangeError`，而净化器没有 try——一条笔记正文就能让 `POST /render` 502，打坏回复流工具卡与会话「知识库」Tab。④ **「幽灵草稿」**：保存/「丢弃」后重置编辑器会触发防抖，把「空正文 + 新时间戳标题」又写成草稿，下次打开误报「已恢复未保存草稿」并跳过默认 tag。⑤ `/recent` 一直丢掉 `since`（工具与卡片都发它），于是模型看到过滤结果、人看到未过滤列表——与 v0.20.0 修过的 `/search` 同类漂移。⑥ 隐藏的 TW 面板会因为一个在途 `/status` 响应重新起一轮 30×1.5s 轮询。⑦ `/tw` 代理补齐显式方法白名单。⑧ `/render` 的 404 改为结构化异常（原先按错误消息文本正则，改词即把「不存在」变 502）。⑨ `/get` 改用共享的 `isBlockedProxyTitle()`（原为硬编码字面量副本）。⑩ 侧边栏显示名改完设置即时生效（原只挂载时读一次）。**去重/死代码**：新增 `render-fetch.ts`（唯一渲染调用）、`describeSyncResult()`（同步回执）、`formatLocalMinute()`，`ui-config.ts` 承担全部 `ui.*` 投影；删除生产零调用的 `ensureTwWebHost()`（与 `tw-web-host` seed 重复）与 `listTags()`，多个仅供模块内部使用的 `export` 与「算了却从不显示」的字段一并清除。守门：`verify-render-sanitizer.mjs` +1、`verify-frame-guards.mjs` +3、`verify-audit-fixes.mjs` +3（草稿覆盖那条**已反向验证**：还原修复即红）。

- **v0.22.7**（2026-09-14）：**设置页「预览注入文本」改为按表单当前值渲染**（用户实测提问「两种内置文本形态差别是什么？为什么选了不同形态后查看当前注入文本显示的东西一样？」）。两种形态的差别其实只在 intro 一段：`slim`（默认）是一句能力概览（实测 1735 字符），`full` 换成由工具注册表实时生成的 15 行参数索引（2504 字符），三块治理约定（写入与并发 / 同步纪律 / 笔记约定）完全相同。但预览按钮此前只发 `GET /admin/prompt`，读的是 **host 已保存的有效配置**，而下拉框的值只活在浏览器 DOM 里——于是「切换形态 → 不点保存 → 点预览」看到的是逐字节相同的旧文本，用户自然以为两种形态没差别。现在：① `prompt.ts` 新增 `normalizePromptPreview()`（把不可信的 body 白名单化成 4 个字段，未知键/错类型丢弃并回落内置默认）+ `describePrompt()`（`applyPrompt()` 与预览**共用同一份拼装**，预览不可能与保存后的注入不一致）；② `POST /admin/prompt` 接收 `{enabled,mode,extra,override}` 草稿并渲染全文，**写入零副作用**（不落盘、不触发 `onConfigChanged`），同源守卫 + 畸形 JSON 400；GET 保留为「已保存/正在注入」的读取；③ 设置页按钮改名「预览注入文本（按表单当前值）」并 POST 草稿，标题栏在表单有未保存改动时标注「含未保存的修改，保存后才真正注入」。守门：`verify-prompt.mjs` 新增 3 条纯函数断言（白名单、`describePrompt` 与 `buildPromptText` 逐字节一致、两种形态在草稿里必须不同），`verify-seeds-admin.mjs` 第 8 段把「POST 必须 405」换成 7 条草稿断言（slim/full 草稿不同、extra 追加、`enabled:false` 为空、GET 仍是旧的已保存状态且 `onConfigChanged` 未触发、垃圾字段回落、畸形 JSON 400、跨站 403）。

- **v0.22.6**（2026-09-14）：**修「快速笔记」两处用户实测报障**。① **原生编辑弹窗里删掉笔记后，弹窗变永久白板、再点「快速笔记」也回不来**。`ui.quickNoteMode=native` 的编辑器是**同一个 iframe 复用**的，而 `openEditorPopup()` 只在 **URL 变了**才给 iframe 赋 `src`（刻意如此：赋 `src` 即整页重载，会丢掉 TW 里未保存的草稿 / 滚动位置 / 撤销栈）。可 TW 编辑器的「删除」是 `tm-delete-tiddler`：它把**原 tiddler 与草稿一起删掉**、并用 `removeTitleFromStory` 把 story 清空——于是弹窗里剩一块白板；而此时主机重建的草稿标题往往与删除前**完全相同**（默认标题是分钟级时间戳 + canonical `Draft of "…"` 复用），URL 不变 → 不重载 → 白板永远摆在那儿，再点按钮也只是「收起/重新打开」同一个空 iframe。现在三处一起兜住：新增 `isEditorPopupBlank()`（同源读 iframe 文档里的 `.tc-story-river`，**一条 `.tc-tiddler-frame` 都没有**即判空；跨源 = TW 里点了外链、文档仍在 loading、读不到文档时**一律不判空**，绝不擅自重载一个可能正在编辑的编辑器），空掉的弹窗在 `openEditorPopup()` 里**强制重载**；`closeEditorPopup()` 同时清掉 `frame.dataset.loaded`，所以「关闭再打开」也一定是新的编辑器载入（关闭意味着丢掉上一次的 view 状态）；输入框上方的按钮与 `openNative()` 的「已打开」幂等守卫都改成 `isEditorPopupOpen() && !isEditorPopupBlank()`，用户再点一次就能拿回编辑器。② **card 模式底部操作条把按钮文字压成两行**（用户截图反馈的美化问题）。340px 的卡片里 5 个控件本就放不下，旧 CSS 让 flex 默认收缩，于是「📎 上传」「🕘 最近」「✏️ 在 TW 中编辑」「保存」**每个按钮里的文字都折成了两行**（无头 Chrome 实测：每个按钮 `textRects=2`、高 46px）。现在按钮一律 `white-space: nowrap` + `flex: 0 0 auto`（文字永不折行、永不被压扁），装不下时**整个右组换行**并用 `margin-left: auto` 继续贴右缘，「Ctrl+Enter」提示允许收缩让位——实测全部按钮恢复单行（高 30px），左下是「上传 / 最近 / Ctrl+Enter」、右下是「在 TW 中编辑 / 保存」两行布局。守门：新增 **`scripts/verify-editor-popup.mjs`**（进 `verify:unit`，tsx 直跑源码 + 最小 DOM 打桩，11 条行为断言——同 URL 有内容不重载 / story 被删空必须重载 / 关闭清 `dataset.loaded` / 关闭后重开必重载 / 空白判据的四种保守边界；**反向验证过**：把两处修复改回去会红 3 条），`verify-frame-guards.mjs` 另加 2 条接线断言（空弹窗不得被当成「已打开」）。真机复核：无头 Chrome 里确认「同一个 URL 再赋一次 `src` 确实会重新加载」「清空 story 后重载能恢复内容」，并用真实 CSS + 真实卡片结构对比修复前后的按钮排版。

- **v0.22.5**（2026-09-14）：**修「大知识库冷启动被误判为启动失败」**（用户实测报障：dsh 启动时 `[dsh-tiddlywiki] startup issue (self-healing is armed): Error: wiki server did not become ready in time`）。根因不是 TW 没起来，而是**就绪判定太急 + 判失败后再也没人复探**。证据来自 `/status` 的环形日志：`01:43:51 spawn … tiddlywiki.js … --listen` → `01:44:11 wiki server did not become ready in time` → `01:44:35 [out] Processing background action …` + `[out] Serving on http://127.0.0.1:52323`。也就是说这个 5099 个 tiddler / 26MB 的知识库在**冷文件缓存**下真的需要约 44 秒才打印 `Serving on`，而旧代码只有**一个 20 秒硬超时**，于是：① 抛错中断整条启动管线——配置 tiddler 没加载、核心 seed（发送给 Agent / 渲染路由 / 同源代理 / markdown 插件）没写、剪藏桥没起，全都会拖到下一次重启；② 写死 `health='failed'` + 一条粘性 error，而**超时后没有任何东西会再探测**，所以 TW 明明在正常服务，`/status`（面板 / FAB / 悬浮提示）却一直报故障。现在把「就绪」变成一条明确的三段策略（新的 `src/host/ready-policy.ts`，纯函数 + 注入时钟，可单测）：**软窗口**（默认 60s，可用 `startup.readyTimeoutMs` 在设置页调，夹在 5s–600s）之内安静等待；超过它只写一条 `slow start: /status not ready after Ns — still loading` 并**继续等**（状态保持 `starting`，不再粘住 error）；**硬上限 = 3× 软窗口**仍无响应才判失败——并且失败时**不杀子进程**，而是挂一个**有界（10 分钟）、`unref` 的「迟到就绪」后台探测**，TW 真起来的那一刻立刻把状态改回 `running` 并清掉那条旧错误（`ready (late): /status 200`），`stop()` 与新一次 `start()` 都会取消它。`startup.readyTimeoutMs` 走「cordis 配置 < 配置 tiddler」双层，设置页保存后对**下一次启动/重启**生效，无需重启 dsh web。守门：新增 `scripts/verify-ready-policy.mjs`（进 `verify:unit`，tsx 直跑源码 + 虚拟时钟）——归一化/夹取、**44s 冷启动必须判成功**（本次事故形状的回归断言）、慢启动只警告一次、子进程退出 → 立即 `exited`、始终不就绪 → 到硬上限才 `timeout`、轮询节奏有界（慢窗口降到 2s，不空转），外加源码级接线断言（`wiki.ts` 不得再出现 20s 硬编码、必须有 `awaitReady` / `armLateReadyWatch` / `clearLateReadyWatch`，config/index/client 三处链路都在）；`verify-resilience.mjs` 增加一条真实 TW 的重启断言（窗口热改 + 夹取 + 仍判就绪）。

- **v0.22.4**（2026-09-13）：**重构：把 TW frame 的生命周期收敛成唯一一份实现**（无功能变更，纯去重）。v0.22.3 那个「空 `src` 把 DSH 载进 iframe」的 P0 之所以发生，根因不是谁写错了某个判断，而是 `panel.ts`（中央列面板）与 `tw-frame.ts`（右侧栏 tab）**各自抄了一份** `showError` / `showStarting` / `showFrame` / `applyPendingHash` / `fallbackLoad` / `doRefresh`——修 bug 时守卫只补到 panel，tw-frame 那份照旧，同一个坑于是踩了两次（`panel.ts` 靠「`!hidden` ⇒ 已载入真实 twProxy」这个不成文不变量侥幸安全，tw-frame 连这个都没有）。现在这六个函数只在 `tw-frame.ts` 新增的 **`createTwFrameSurface(skin)`** 里各有一份，`createTwFrameController()` 退化成它的 rightbar 薄包装；一个 surface 只提供三样东西：**皮肤**（类名 + 可选内联样式）、**惰性构建点**（`build()` 返回 view，由调用方决定挂到哪里）、**可见性**（`setVisible()`）。`panel.ts` 因此从 469 行降到 280 行，只剩 rect 钉住 / 惰性构建 / 共存 chrome / 面板互斥。顺带三处行为改进（都是去重后的自然结果）：① 面板打开链接改为**先 `state.openPanel()` 再 `surface.openTiddler()`**（内核以 `visible=false` 拒绝隐藏 surface，顺序反了链接会静默丢失，脚本里有守门断言）；② `setVisible(false)` 现在会**隐藏 frame 并停掉有界轮询**（下次显示重新给满预算）；FAB「重载面板」刻意**不受可见性限制**（唯一判据是 `dataset.loaded`）——显式重载请求要能覆盖**关掉的**面板，否则「关掉面板 → 点重载 → 再打开」会看到旧资源，而展示陈旧内容比多一次重载更糟；③ 内核的 `build()` 会记住「DOM 还没建就被要求显示」的情况并在建好后补一次 `/status` —— 此前中心列若在面板挂载之后才出现，面板会停在空壳上直到用户再切一次。守门：`verify-frame-guards.mjs` 加了**计数去重断言**（panel 里出现任何一个生命周期函数就直接判红，反向验证过：植入回来必失败），并新增 **`scripts/verify-frame-surface.mjs`** —— 用 tsx 直跑源码 + 最小 DOM 打桩，真正执行 `createTwFrameSurface()` 跑 16 条行为断言（空 `src` 的两条重载路径、只显示真的载入过 TW 的 frame、同一 URL 不重复赋 `src`、启动/错误/重试恢复、同源 hash 导航与跨源兜底、共享 chip 标签、dispose 摘监听且幂等），已进 `verify:unit`。测试环境提示：本机沙箱里 node 再 spawn 孙进程会崩，`npm run` 偶发段错误，`verify-package-contents` 与 `verify-git-resolve` 的失败属环境问题（手动复核过断言全过），与本版无关。

- **v0.22.3**（2026-09-12）：**第五轮代码审计的客户端修复版**（host 侧零缺陷：CSRF 门禁 / 片段净化 / SSRF 守卫 / 密钥打码 / 写策略 type 保留 / 乐观并发 / git 互斥 / seed 内容哈希 / 切换回滚逐条对照都成立；`tsc` 与 8 个 `verify-*` 全绿）。① **P0：iframe 空 `src` 被当成合法地址使用**。`tw-frame.ts` 的 FAB「重载面板」处理是 `frame.src = frame.src`、hash 兜底加载是 `frame.src.split('#')[0]` 拼 hash——而 `iframe` 从未赋过 `src` 时，**读 `iframe.src` 得到的是宿主 DSH 页面自己的 URL**。`setVisible(true)` 会在首个 `/status` 回来之前就取消 `hidden`（切走再切回即可命中），于是这两种写法会把 **DSH 页面载进 iframe**：iframe 里再起一份 DSH（重复 FAB、重复全局监听、白屏）。现在两处「整页重载」路径都只认 `dataset.loaded`（只有 `showFrame` 写它）并抽出共享的 `loadableFrameUrl()`，`panel.ts` 原本靠「`!hidden` ⇒ 已载入真实 twProxy」这个不成文不变量侥幸安全，现也改成显式判据。② **P1：主题「活动」单选预选错误，且会影响写入**。`/admin/state` 只回 `info.themes`（**已加载**集合），设置页就拿它的**最后一项**冒充「活动主题」；用户显式激活过非末位主题时，打开设置页显示错误选中项、**不动任何单选直接点「应用主题」也会静默把活动主题改回末位那个**。现在 host 读 `$:/theme` 并在 `/admin/state` 回 `info.themeActive`（去掉 `$:/themes/` 前缀归一），设置页优先用它、猜末位只作兜底，并且只在 catalog 里存在时才认。③ **P1：`applyToFrame` 缺 try/catch**。`setThemeSyncConfig()` 是**同步**遍历调用各 frame 的 applier 的（`doRefresh`/`load` 都在 await 链里），而 `frame.contentWindow.$tw` 这次属性访问在 iframe 导航到跨源页面（TW 里点外链）时**自身**就抛 `SecurityError`（内层各助手的 try/catch 还没轮到），异常直接变成未处理 rejection 并中断那次刷新；现在整段包住。④ **P2 清理**：会话汇总的挂载 effect 补 `mountedRef` 卸载守卫（`genRef` 只认「被更新取代」、覆盖不到卸载，在途请求 resolve 后仍会 setState 并递归再发一轮）、快速笔记按钮的 `fetchUiConfig().then(setMode)` 补 alive 守卫、`note-widget` 卸载不再删除**设置页也在用**的页面级 toast 单例（原来会掐掉别人正在显示的提示）；删掉三处无人消费的死标记/死字段（`view.dataset.visible`、`data-dsh-tw-rightbar`、`BuiltUi.recentBtn`、`ConfigField.input`），工具卡标签 key 补下标（同标签重复会撞 key），并把 `panel.ts` 里重复的 `requestRestart` 收敛为复用 `tw-frame.ts` 的那一份。守门：新增 `scripts/verify-frame-guards.mjs`（已进 `verify:unit`）——空 src 陷阱、活动主题优先级、跨源 try/catch、共享 toast、死标记共 13 条断言，其中 `readActiveThemeName()` 走真实函数（前缀 / 裸名 / 缺失 / 读失败），静态断言会剥掉注释行以免匹配到自己的说明文字。

- **v0.22.2**（2026-09-12）：**修「主题汇总页·模板」seed 内容被渲染成几千遍重复**（用户实测报障）。模板里留了两个「可选」大段落，其中一个标题里有一个**裸 `<$list>`**（没有 `filter` 属性）——TW 渲染时把它当成「列出**全部** tiddler 的列表」，于是整段「可选：把本页收进『一页多主题』tabs」说明被跟着重复渲染几千次（实测渲染出 1.1MB、约 2941 遍重复）。现在模板精简为**一个列表 + 一行指向教程的说明**：删掉两个「可选」段落（自定义 `<$list>` 样式版 / tabs 收录法），自定义需求统一见 [[教程：按主题/标签做汇总页]]；模板正文的提示也改为「把正文里的 `主题A` 全部替换」（原来写「两处」，实际有 3 处）。**已有 wiki 的模板不会自动更新**（seed 是 ONE-SHOT）：本机线上 wiki 已手工覆盖为新模板并同步 seed 标记哈希；其余 wiki 可在设置页「初始化」里对 `starter-docs` 点「重新初始化」（会覆盖你对模板的改动，改过请先备份）。顺带修好一个校验脚本的兼容问题：`scripts/verify-package-contents.mjs` 假定 `npm pack --json` 返回数组，但 npm 12 返回 `{name:{...}}` 对象，导致「发布包内容」检查假失败（与本次改动无关，但会卡住发布流程）。

- **v0.22.1**（2026-09-11）：**修首页「快速记笔记」创建出的条目日期时间错误**（用户实测报障）。首页快速笔记在标题留空时用 `<now "YYYY-MM-DD-HHmm">` 生成标题，而 TW 的日期格式 token **只有小写** `YYYY`/`0MM`/`0DD`/`0hh`/`0mm`—**`HH` 根本不是 token**，未知字符被**原样输出**，于是生成的是 `2026-9-11-HH20` 这种标题（还伴随月份/日不补零）。现在改为 `YYYY-0MM-0DD-0hh0mm`，并新增 `verify-constants.mjs` 守门（首页 seed 不得含 `HHmm`）。同一处还把一个反模式改成 TW 的正确命名空间：`$savetitle` 原本写 `$:/state/home-note/last-created`——`$:/state/*` 会被 syncer **落盘进 git**（设置页覆盖层之外的有一份状态污染），改用 **`$:/temp/*`**（tiddlyweb adaptor 显式排除，浏览器端临时状态不进 wiki）。顺带修好一个**一直跑不起来的构建脚本**：`scripts/gen-seed-home.mjs` 的生成模板里有两处反引号没转义（第 148/181 行的 `` `ok:false` ``），整个脚本**语法错误**——也就是说「改首页 → 重新生成 seed」这条路早就断了，本次同时修复。**已有 wiki 的首页不会自动更新**（seed 是 ONE-SHOT）：设置页「初始化」里对 `home-index` 点一次「重新初始化」即可拿到修好的首页（会覆盖你对首页的改动，若你改过请先备份；本次作者的线上 wiki 已手工打上同样的两处修改）。

- **v0.22.0**（2026-09-11）：**知识库位置可在设置页运行时切换 + seed 文档「过期」检测 + 一个隐藏很久的数据丢失竞态**。① **知识库位置可切换**：`wikiRoot`/`wiki` 之前只能写死在 cordis 配置里（改一次要动配置文件 + 重启），现在设置页顶部「知识库位置」显示当前实际目录、这个位置**怎么决定的**（指针文件 / cordis 配置 / 默认值）、指针文件路径与同目录的候选 wiki；填一个绝对路径即可**运行中切换**——停 TW → 释放自动提交与监听 → 改指 → 起 TW → 重载新 wiki 的配置 tiddler → 跑核心 seed（markdown 插件 / 发送给 Agent / 渲染路由 / 同源代理 / 语言）→ 重建 git → **最后**才写指针；目标目录没有 `tiddlywiki.info` 会自动 `--init server` 建一个全新知识库；**失败自动回滚**到原知识库并如实回报 `rolledBack`。选择存在 `$DSH_HOME/dsh-tiddlywiki/location.json`——一个**在 wiki 之外**的指针文件：设置页的覆盖层就存在 wiki 自己的配置 tiddler 里，若「用哪个 wiki」也存那里，切过去就会把这个选择一起丢掉（鸡生蛋）；指针损坏只会报告并回退配置默认，绝不乱跑。② **seed 更新检测**：seed 标记从一行 `seeded-once` 升级为 `{version,hashes,at}`——记下**我们写下的内置正文的哈希**，于是设置页能区分「⬆ 内置内容有更新」（可一键「更新到内置版本」）与「✏️ 本地已修改」（覆盖前二次确认）；旧标记（无哈希）会显示「更新检测尚未启用」并按文本比对判定归属，**不会**被误判成「用户改过」；`updateAvailable` 只是提示，**绝不自动改写你的 wiki**。③ **文档不再手抄易变事实**：插件说明笔记里的工具清单由**工具注册表生成**（`docNoteText(tools)`）——它此前写死「10 个 agent 工具」而实际已有 15 个。④ **修掉一个潜伏的数据丢失竞态（本次最重要的修复）**：`flushPendingWrites()`（「重启 TW 前把 syncer 队列排干」的哨兵）假设「哨兵落盘 ⇒ 队列已空」，但 TW 的 syncer 会**跳过最近 1 秒内保存过的标题**（`syncer.js` 的 `throttleInterval` / `chooseNextTask`）——哨兵是另一个标题、随时可写，于是它会**插队**先落盘，被 throttle 的写入仍留在队列里、随即被重启吞掉。这个竞态一直存在（AGENTS.md 记录过 v0.19.0「force-all 随机丢 `tw-web-host`」），v0.22.0 新增的 seed 标记写入改变了时序，使它变成**必现**（`verify-seeds-admin` 稳定复现）。现在改为**两段式**：写哨兵 A 等落盘 → 睡一个 throttle 窗口（从 `$:/config/SyncThrottleInterval` 读，默认 1s）→ 再写哨兵 B 等落盘；这期间所有被 throttle 的标题都会变可用并被写出，第二枚哨兵才是真正的队尾。守门：新增 `scripts/verify-wiki-switch.mjs`（真起两个 wiki：切换 / 回滚 / 指针文件 / 非法输入，已进 `verify:e2e`），`verify-seeds-admin.mjs` 增加 5 组内容哈希断言（新鲜 / 用户改过 / 内置更新 / 旧标记两种 / 重新初始化后刷新）。

- **v0.21.0**（2026-09-11）：**注入提示词改为「默认精简 + 可配置 + 不再过期」**。旧提示词手抄了一份工具参数清单，最后一次同步停在 v0.19.0，此后 v0.19.4（`list_tags limit`）、v0.19.5（`delete`/`attach`/`batch_put` 并发令牌与 `attach` 默认拒绝同名覆盖）、v0.20.1（`append` 的 `fields`）都改过工具层——模型实际看到 **6 处过期签名**。现在：① 新增 `prompt.{enabled,mode,extra,override}` 配置（设置页「系统提示词」区块）：默认 `slim`（~1.7KB，只保留工具 schema 表达不了的约定：写入/并发纪律、同步纪律、标签约定、可点击链接格式），`full` 形态额外附参数索引但**由 `tiddlywikiToolSummary()` 从注册表实时生成**，不可能再脱节；② **保存后无需重启 dsh web**——section 即时重新注册，当前会话从下一步起生效（DSH `system-prompt/change` 会更新历史里的系统消息），设置页还能一键**预览**即将注入的全文（`GET /admin/prompt`）；③ 用户文本里的 `{{…}}` 会被转义（DSH 对未知变量直接抛错，会炸掉整个系统提示词装配）；④ 守门：新增 `scripts/verify-prompt.mjs`（slim 不得出现参数清单 / full 的每个工具与每个参数都必须在场 / 两种形态都必须保留治理约定块 / 转义与 extra-override 语义），已进 `verify:unit`。

- **v0.20.1**（2026-09-11）：**修复「覆盖已有条目时内容类型被静默重置」**（数据正确性）。`tiddlywiki_put` / `tiddlywiki_append` / `tiddlywiki_batch_put` 覆盖既有条目时会丢掉它的 `type`：`cleanTiddler()` 把 `type` 当成「构造 PUT body 时跳过的字段」，于是 `finalTypeForWrite()` 再补默认值——`put` 把 `text/css` 的样式条目改成 `text/markdown`（整篇 CSS 被当 Markdown 渲染、样式静默失效）、把 wikitext 笔记改成 Markdown；`append` 更彻底：它自己手写 PUT body，连 `type` 都不写，TW 于是回落 `text/vnd.tiddlywiki`（磁盘上 `.md` + `.meta` 变成 `.tid`，`##`/`**粗体**`/表格全按 wikitext 解析）。现在：**覆盖路径一律保留原 `type`**，Markdown 默认值只给**新建**条目（`$:/` 系统条目除外）；`tiddlywiki_append` 与 `put` 共用同一套写策略（`buildWriteTiddler`），并补上了此前缺失的 `fields` 参数；`rename` 与回收站恢复同样不再丢类型。回执也补了诚实提示：新建默认时写「新建且未指定，已默认 markdown」，覆盖时若类型真的变了会写「⚠️ 内容类型已从 X 改为 Y」。守门：新增 `scripts/verify-write-policy.mjs`（7 条纯函数单测，已进 `verify:unit`）与 `verify-audit-fixes.mjs` 的 6 条 E2E（css 保持 css / wikitext 保持 wikitext / markdown 追加不变 / 新建仍默认 markdown / `fields.type` 是唯一改类型入口 / rename+回收站恢复保类型）。

- **v0.20.0**（2026-09-11）：**第四轮代码审计的修复版**（安全 / 用户可见缺陷 / 工程守门 / 死代码清理）。**安全**：① `POST /dsh-tiddlywiki/render` 没有像 `/get`、`/tw`、`/api` 那样拦插件命名空间——TW 的 `/render` 对**任意标题**都渲染，于是 `{"title":"$:/plugins/dsh-tiddlywiki/config"}` 能把配置 tiddler 连 `bridge.token` 与带 PAT 的 `git.remote` 一起渲染出来（本机临时 wiki 实测复现；片段净化器只管标签、管不住正文）。现在抽出一份 `isBlockedProxyTitle()` 并覆盖 `/render`（selftest 断言 403）。② `maskConfigSecrets()` 此前**只遮 token 与 git remote**，而文档一直声称 `auth.password` 也被遮——实测原样返回；现在 `auth.password` 一并打码并附 `passwordSet` 展示位，回填掩码同样被 `stripMaskedSecrets()` 丢弃。**用户可见缺陷**：③ TW 的 `$tw.notifier.display()` 只认**已存在的 tiddler 标题**、不存在时**什么都不做**，而「发送给 Agent」的 `notify()` 传的是自由文本——**所有成功/失败提示都是空操作**（用户点完按钮毫无反馈）；现在先写 `$:/temp/dsh/send-to-agent/notice` 再 display（bundle 0.3.4 → 0.3.5）。④ 快速笔记卡片丢掉了 `404 + {notFound:true}` 的响应体，`notFound` 分支永不成立，于是「条目不存在」被显示成「wiki 服务不可用」；`fetchJson` 现在保留 404 正文。⑤ `/edit` 的草稿查找在 v0.19.5 重构时把分支写反：规范草稿**已存在**时反而直接覆盖（丢用户未保存的编辑），扫描到的异构草稿被改名为新条目（留孤儿）；恢复 `free ? canonical : 复用既有草稿 ?? 时间戳` 的避让语义，并补 E2E 断言。⑥ 会话「知识库」Tab 的「修改」时间用 `Date.parse()` 解析 TW 紧凑格式（`20260101000000000` → NaN）后原样回显成 17 位数字；改用 `parseTiddlerDate()`。⑦ 设置页点「同步 / 重启 TW」会 `refresh()` 重建整块配置表单，**静默丢弃未保存的输入**；现在只有服务端配置真的变了才重建。⑧ `tiddlywiki_search` 的 `field`/`value` 只在工具层生效，客户端卡片不发送、host 路由也不读——卡片列出的是**未过滤**结果；两侧已打通。⑨ 草稿自动保存调用了带副作用的 `getTags()`，会把 tag 框里没回车的半截词提交成标签；新增纯读的 `peekTags()`。**工程守门**：⑩ CI 之前各自维护一份脚本清单，与 `package.json` 双向漂移——`verify-status-cache` 与 `verify-audit-fixes`（v0.19.5 全部数据安全修复的唯一回归）**从未在 CI 跑过**；现在 CI 只调 `npm run verify:static|verify:unit|verify:e2e|verify:large`。⑪ `verify-render-bundle` 的 `module-type` 断言查的是源码注释而不是 tiddler 字段（假断言，字段丢了照样绿）；`verify-package-contents` 不守 `src`/`docs` 也不禁 `scripts/`；均已修正。⑫ 三个浏览器脚本硬编码 `D:/npm-global/...puppeteer-core` 且 Chrome 候选表漂移（Linux 上恒 SKIP），抽出 `scripts/lib/browser-env.mjs`；`waitFor` 与迷你路由分发器各抽成 `scripts/lib/tw-harness.mjs`；`TEXT_LIST_FILTER` 长度预算移进新的 `verify-constants.mjs`（static 档，不再只在两个最重的 TW 套件里断言）。**死代码 / 重复**：⑬ 开启 `tsconfig.noUnusedLocals` 并清掉 16 处死 import/死类型；删 `FLUSH_PROBE_FILE`、`fetchUiConfig({force})`、`sidebar-entry` 的 `initialLabel`、`ToolCallOwnerProps` 未用字段、四个卡片的死 `text` prop、`headerTitle` 的 7 个空 case、`__twDebug`、`panel.ts` 的兼容 re-export、一行包装 `setSessionSummaryTabLabel`；`invalidateStatus()` 由 `invalidateUiConfig()` 一并调用（设置页保存后 FAB/侧栏立即读新值）；`GitStatusView` 三份合成一份，`snippetOf`/`safeEqual`/`assertPublicImageUrl` 各合成一份；客户端端点字面量统一收进 `endpoints.ts`；`defineTool` 从不被读取的 `output.schema` 参数移除。**文档**：修掉过期注释与文档（客户端仍写 `/tw/render`、`tool-views` 头部仍称「HTML 来自本地 wiki 所以安全」、`host/routes.ts` 文件头只列 6 条路由、生成的 seed docstring 仍写 `Never throws.`）。守门：`verify-send-to-agent-bundle` 补外层 version 断言与 notify 回归，`verify-secret-masking` 补 auth 用例，`verify-status-cache` 补 invalidate 联动，selftest 补 `/render` 403。

- **v0.19.5**（2026-09-11）：**第三轮代码审计的修复版**（数据安全 / 正确性 / 客户端网络卫生 / 工具性能）。**数据安全**：① `tiddlywiki_attach` 此前**完全不读旧条目**就 `PUT`——附件标题一旦撞上既有笔记（`会议纪要.png` 之类）会把那篇笔记连 tags/自定义字段/正文一起**静默替换成 base64**，是本轮最危险的一条。现在先读后写（004 = 新建，其余错误照常抛出），撞名时**默认拒绝**并要求 `force: true`（并发令牌只证明「读过」、不等于「同意覆盖」），覆盖时仍保留原 tags 与自定义字段，新建附件也会补 `agent-written`；嵌入笔记（`noteTitle`）同样走写策略。② `/edit`（快速笔记直达 TW 原生编辑器）此前把草稿写死 `text/markdown`，而 TW 保存草稿会把字段抄回原条目——**任何 wikitext 笔记被这样编辑一次就降级成 Markdown**，`!` 标题 / `<$list>` / `[[链接]]` 下次全渲染成源码。现在草稿类型跟随原条目，只有新笔记才回落 Markdown。③ 回收站索引读失败/JSON 损坏时，`delete` 此前把它当「空索引」再全量覆盖 → **之前所有回收站记录变成既查不到、也清不掉的孤儿**（体积还留在 git 里）。现在读失败即中止（新增 `TrashIndexUnavailableError`），损坏也不静默重建，`trash list/restore/empty` 一律显式报错。④ `rename` 先写新标题、再删旧标题，此前若删除失败会**抛裸错**让调用方以为整个重命名没发生；现在如实回报「两份副本都在，请手动删除旧标题」。⑤ `tiddlywiki_delete` 支持 `expectedModified`/`expectedRevision`/`force`——删除比覆盖更具破坏性，此前却没有任何乐观并发保护（`get` → 人类在 TW 里改动 → `delete` 会把新改动一起丢进回收站）。**正确性**：⑥ 会话汇总只探测前 300 篇，却把**所有**条目按探测结果渲染，超出上限的会被谎报成「⚠️ 已删除/不存在」；现在未探测的条目标「（未探测，超出单次查询上限）」。⑦ `/api` 透传补上方法白名单（宿主按 pathname 分发，此前 TRACE 之类的任意方法都会被转发给 TW）。⑧ `/tw` 代理遇到带 body 的 DELETE 不再把请求体留在 socket 上（此前会挂到 30s 超时）。⑨ `/admin/config` 不再把所有失败都当 400（服务不可用/超限走 413/500）；`/upload` 的「超限」判定与 `errorStatus` 统一。⑩ `WikiServer` 成功启动时清掉上一次失败的 `error`（自愈成功后 `/status` 与面板提示不再长期显示过期故障）。**工具性能**：⑪ `batch_put` 从「顺序 2N 次 REST」改为 **4 路有界并发**（结果按入参下标回填，顺序与逐条容错完全不变），`autoCommit` 移出循环。⑫ 快速笔记找草稿从「拉整份 listing」改为**先单条 GET 规范草稿名**，listing 只作兜底。**客户端网络卫生**：⑬ 新增共享的 `/status` 读取器（2s TTL + **在途合并**）——此前中央面板、侧栏框架、同步按钮、快速笔记配置**四处各有一份 `fetchStatus`**，页面加载时会同时发多次请求，而 host 每处理一次 `/status` 要起最多 5 个 git 进程；⑭ `ui-config` 的缓存同样改为 promise（并发调用共享一次请求），失败不缓存。**其它**：`ToolsDeps.noteTag` 死代码删除；`put`/`batch_put` 描述改为「防抖自动 commit（默认 60s）」以免模型误以为写完即提交。守门：新增 `scripts/verify-audit-fixes.mjs`（10 条 E2E，真实 TW + 真实路由，每条都能复现旧缺陷）与 `scripts/verify-status-cache.mjs`（5 条单测，`tsx` 直跑源码），均已并入 `verify:unit` / `verify:e2e`。

- **v0.19.4**（2026-09-11）：**标签列表全面「有界」——最后一个没有上限的列表接口**。`GET /dsh-tiddlywiki/tags` 此前会把**每一个**去重标签（大 wiki 上千个）连同计数全量回给浏览器，而回复流工具卡只是展示前 60 个；`tiddlywiki_list_tags` 更严重——同样全量灌进**模型上下文**。现在：① `/tags` 支持 `limit`（1–500，缺省仍是全量，快速笔记的标签自动补全保留完整词表）与 `sort=alpha|count`（默认 `alpha`，`count` 按使用次数降序），回包新增 `total`（去重后的真实总数）与 `truncated`；② 工具 `tiddlywiki_list_tags` 新增可选 `limit`（默认 200、上限 1000），截断时 render 明说「共 N 个，仅列出最多的 M 个」，不再让模型以为那就是全部；③ 客户端 `TagsCard` 改为直接请求 `?limit=60&sort=count`（不再下载上千条再丢掉），并用 `total` 显示「共 N 个 · …另有 M 个」；④ 顺手消掉重复实现：路由与工具现在共用 `TiddlyWebClient.tagStats()` 一份计数逻辑（此前路由自己遍历一遍，且不跳过 `$:/` 系统标题，两侧口径可能不一致），`/recent`、`/search`、`/tags` 的 limit 解析收进 `readLimit()`/`readOptionalLimit()` 两个助手。守门：selftest 增 6 条断言（截断/`total` 不丢分母/`tags` 与 `items` 同集同序/上限 500/`sort=count` 单调递减/无 limit 时 `truncated=false`），`verify-tools` 增 `list_tags` 的 limit 用例。

- **v0.19.3**（2026-09-11）：**清掉审计清单里剩下的中优先级项**（安全面 / 健壮性 / 正确性）。**密钥不再外泄**：`bridge.token` / `ui.sendToAgent.token` 会被 `GET /admin/state` 与 `POST /admin/config` 的回包替换成 `********`（并给 `tokenSet` 标记），设置页原样保存不会把真 token 覆盖成掩码、清空即删除；`git.remote` 里的 PAT 同时打码，回填同值也被丢弃。更要紧的是**代理旁路**：`/get` 早先禁止读插件配置 tiddler，但 `/tw` 与 `/api` 会把任意路径转发给 TW 子进程，而它的 TiddlyWeb REST 对 `$:/…` 标题照答不误——`GET /dsh-tiddlywiki/tw/recipes/default/tiddlers/%24%3A%2Fplugins%2Fdsh-tiddlywiki%2Fconfig` 实测能拿到配置正文。现在两个代理都拦截 `$:/plugins/dsh-tiddlywiki/` 命名空间（selftest 有回归断言）。**健壮性**：所有路由统一经 `guardHandler` 包装——此前每个注册都是 `void handleX(req,res)`，而宿主没有 `unhandledRejection` 处理器，任何一次 rejection（含代理里 try 之外的 `new URL()`）都会**直接结束 dsh web 进程**、请求挂死；剪藏桥 listen 之后补上**常驻 `error` 监听**（此前移除唯一监听后，运行期 server error 就是未处理事件 → 崩进程），`stop()` 用 `closeAllConnections()` + 1s 上限，keep-alive 不再是卸载时的死等；`/tw` 代理在客户端断连时**中止上游 fetch 并销毁流**（此前会一直拉到 30s 超时）。**正确性**：会话汇总不再把查询失败（超时/5xx）报成「已删除/不存在」（只有 404 才算不存在），来自请求体/会话日志的 sessionId、rename 旧标题、检索词一律 HTML 转义（TW 会原样透传 HTML，汇总片段又会被注入 DSH 页面），sessionId 还加了字符集白名单；`/upload` 改**原子写**（`wx` + 仅对 EEXIST 走后缀链，修掉 TOCTOU 与「任何 access 错误都当名字可用」）、文件名末尾点/空格先规范化（`evil.html.` 此前能绕过可执行扩展名黑名单）；SSRF 白名单补上多播 `224/4`、保留 `240/4`（含 `255.255.255.255`）、`192.0.2.0/24`、`198.51.100.0/24`、`203.0.113.0/24`、`192.88.99.0/24`；`readWikiInfo` 对顶层 `null`/数组给出可读错误而不是 `TypeError`；`/admin/info` 空操作不再重写 `tiddlywiki.info` + 重启 TW，校验失败 400 / 内部失败 500 分开；`/agent/create` 先校验工作模式再建目录（此前未知模式会留下孤儿目录）；body 超限统一 413。

- **v0.19.2**（2026-09-11）：**v0.19.1 的内容 + 让 flush 哨兵真正生效**。v0.19.1 在 npm 上只是被 **staged**（未确认），而那份 tarball 少了下面这个修复，所以补一个版本号（**请以 0.19.2 为准，0.19.1 可以取消掉**）。修复内容：`flushPendingWrites`（「重启 TW 前把 syncer 队列排干」的哨兵）**从来没成功过**——① 它写 `type: 'text/plain'` 却去等 `.tid` 文件，而 TW 的文件系统适配器按内容类型决定扩展名（`text/plain` 实际落 `.txt` + `.txt.meta`）；② 它用 `mtime >= startedAt` 判定，而哨兵是紧接在等待之前写的，Windows 上新文件的 mtime 可能落在同一/前一个时钟刻，条件永不成立。两者叠加 → 每次调用都超时返回 false，而**所有调用方只把它当 warning**：`/sync`、工具 `git_sync`、seed 重启与启动路径的「排干 syncer」全部静默失效（启动路径还白等 8 秒）。现在按「文件名含 `dsh-tiddlywiki_flush-probe` + 文件内容含本次随机戳」判定（与扩展名/时钟无关），实测 <1.2s 返回；selftest 加了断言，另修掉一处「轮询结果被忽略就重启」的测试竞态（首轮 GitHub CI selftest 抓到的 404）。**其余同 v0.19.1**：CI 复活（`.gitattributes` LF + sourcemap 可复现）、渲染片段净化（存储型 XSS）、`/note` `/edit` 共享写策略（不再清掉人类笔记的标签/自定义字段）、重启单飞与启动/teardown 握手、`tiddlywiki_get` 字段摊平、`lint` 两个坏检查、客户端泄漏与草稿回写等。
- **v0.19.1**（2026-09-11）：**第二轮代码审计的修复版 + 让 CI 重新变绿**。**顺带抓出一个"静默失效"的哨兵**：`flushPendingWrites` 一直用 `type: 'text/plain'` 写哨兵、却去等 `.tid` 文件（TW 的文件系统适配器按内容类型决定扩展名，`text/plain` 实际落 `.txt` + `.txt.meta`），叠加 `mtime >= startedAt` 的判定在新写入的同一时钟刻可能永不成立 → 每次调用都超时返回 false，而所有调用方只把它当 warning。也就是说 v0.19.0 声称的「重启前排干 syncer」**其实一直没生效**（`/sync`、工具 `git_sync`、seed 重启与启动路径全都受影响，启动路径还会白等 8 秒）。现在改成**按内容随机戳匹配**（不依赖扩展名、不依赖文件时间），实测 <1.2s 返回，并有 selftest 断言守门。**CI 其实是红的**：`lib/index.js.map` 内嵌源文件原文（sourcemap 的 `sourcesContent`），Windows 工作区是 CRLF、GitHub runner 检出是 LF，Linux 上重建出的 map 与提交版必然不同 → `static` 作业的 `git diff --exit-code -- lib/` 每次失败，而它一挂，另外三个 job（`needs: static`）**根本不会跑**（v0.19.0 声称的四档守门实际停摆）。修法：新增 **`.gitattributes`（`* text=auto eol=lf`）** 把工作区钉成 LF 并重建提交 lib/；顺带补上 **send-to-agent 的「bundle ↔ seed 逐字节」守门**（render 早就有，缺这条时「跑了 build 忘跑 gen」会 CI 全绿却发旧按钮）、`prepublishOnly` 预检、CI 失败时能看懂的错误提示。**安全（存储型 XSS）**：回复流卡片与会话汇总把 TW 片段 `dangerouslySetInnerHTML` 进 DSH 页面，而 TW 的解析器只剥 `on*`——实测 `<iframe src="javascript:…">`、`<a href="javascript:…">`、`<form action="javascript:…">` 全部原样通过（任何写进 wiki 的正文——agent 笔记、剪藏、导入——都能在 DSH 同源页面执行脚本并调用未鉴权的 `/dsh-tiddlywiki/*` 路由）。新增 **host 侧片段净化器**（`src/host/sanitize.ts`：丢 script/style/iframe/object/embed/form/svg/math…、丢 `on*`/`srcdoc`/`srcset`、URL 属性只放行 http(s)/mailto/tel/相对路径/栅格 `data:image/*`，并先做实体解码挡 `&#106;avascript:` 这类混淆），新增 **`POST /dsh-tiddlywiki/render`** 作为客户端唯一渲染入口（客户端不再直连 TW 的未净化 `/tw/render`，因此**老 wiki 也立刻受保护**）；配套 payload 回归 `scripts/verify-render-sanitizer.mjs`（已进 CI）。**数据安全**：`/note` 与 `/edit` 此前不读旧条目就整体 PUT，用同名标题保存会**清掉人类笔记的标签与自定义字段**——现在两条人类路径与 agent 工具共用新的 **`src/host/write-policy.ts`**（先读后写、保留字段、`agent-written` 只给 agent 新建的条目）；快速笔记卡片对「🕘 最近」载入的笔记回传 **`expectedRevision`**，人类在 TW 里的并发修改会让保存得到 **409** 而不是被覆盖；**重启 TW 前先排干 syncer**（`/sync` 与工具 `git_sync` 此前漏了 flush 哨兵——刚保存的笔记可能被重启吞掉）；`WikiServer.restart()` 改为**内部单飞**（admin 路由不受 routes 层互斥保护，并发重启会留下孤儿 TW 进程）；启动任务是 fire-and-forget，teardown 现在**先置 `disposed` 并等它收尾**（插件热更新/禁用时不再「disposer 先跑完、startup 后 spawn」留下孤儿进程与泄漏监听）。**工具层**：`tiddlywiki_get` 的自定义字段此前渲染成 `fields=[object Object]`（单条 GET 的 `fields` 嵌套没摊平）——`q`/`due`/`clip-url` 对模型完全不可见，已修；`tiddlywiki_lint` 的死链检查把**每一条指向图片/附件的链接**都误报成死链（标题集合取自排除二进制的列表），`missing-type` 则**永远不触发**（TW 服务端会给无 type 的条目补 `text/vnd.tiddlywiki`，改用 `[!has[type]]` 过滤器判定），描述与 `checks` 里的 `large-binary` 从未实现，已删除；`tw-api` 的瘦列表（`/tags`、lint 用）加短 TTL 缓存。**客户端**：TW 就绪重试的 40×150ms 定时器、`sync-button` 卸载后的迟到回调、`injectStyles` 的共享 `<style>` 被旧 disposer 删掉、渲染阶段改模块级缓存（改到 effect 阶段）、`tiddlywiki_list_tags` 卡片不截断（现最多 60 个 + 提示余量）；快速笔记「在 TW 中编辑」成功后不再把同一份内容重新写成「未保存草稿」。**工程**：工具层 E2E 从 10 个工具补齐到 **15 个**（并断言一个都不能少）、selftest 新增「人类写路径保留字段 / 409 冲突」与「host /render 净化」端到端断言、`package-lock.json` 版本与 npm 描述同步。

- **v0.19.0**（2026-09-11）：**按代码审计结论做的全量修复 + 一批新能力**（安全 / 数据安全 / 工具层 / 客户端 / 工程）。**安全**：① 每个路由现在**校验 HTTP 方法**（此前 `http.ts` 主动放行 GET、宿主按 pathname 分发，于是 `GET /dsh-tiddlywiki/sync` 会 pull+commit+**push**、`GET /restart` 重启 TW、`GET /upload` 落文件——任意网页一张 `<img>` 即可触发；实测复现，现已一律 405 且无副作用）；② 剪藏桥 SSRF 守卫的 IPv6 判定改为**按字节解析**（此前 `::ffff:7f00:1`、`0:0:0:0:0:0:0:1`、`::0:1` 等回环写法全部放行——实测复现）；图片下载改为**逐跳 pin 住已校验的 IP**（堵 DNS rebinding TOCTOU）、**流式限长**（不再先全量缓冲再判 15MB）、禁用透明解压；③ TW 子进程的 spawn 日志**不再写明文口令**（该日志经无需认证的 `GET /status` 返回），`/status` 还会脱敏 git remote 里的 token、剪藏桥健康接口不再回显 port/tag/tokenSet、`/get` 不再暴露插件配置 tiddler、`/agent/sessions` 补上 token 守卫、token 比较改常数时间、`/tw` 代理改为**流式转发**（大附件不再整包进内存）、上传拒绝 html/svg 等可在同源执行的文件、`/note`/`/edit` 拒绝 `$:/` 标题。**数据安全**：④ 新增 `tiddlywiki/markdown` **插件自举**——全新 wiki 是用 `--init server` 建的，不含 markdown 插件，而插件默认把每篇笔记写成 `text/markdown`，此前新用户开箱即见 Markdown 源码；⑤ `tiddlywiki_put` 覆盖已有笔记时**不再丢掉原有的标签与自定义字段**（PUT 是整体替换，旧实现只发 title+text；单条 GET 的自定义字段还嵌套在 `fields` 里，一并修掉）；⑥ 新增**乐观并发**：`expectedRevision`/`expectedModified` + `force`，人类在 TW 编辑器里的改动不再被静默覆盖；⑦ `tiddlywiki_delete` 默认**软删除进回收站**（`tiddlywiki_trash` 可 list/restore/empty）；⑧ `readWikiInfo` 只把 ENOENT 当「没有配置」（此前读失败=空配置，设置页保存会整文件覆盖 `tiddlywiki.info`），写入改为备份 + 原子替换；seed 的 `tw-web-host` check 不再吞错；重启 TW 前用**flush 哨兵**排出 syncer 队列（force 重新初始化曾随机丢掉 `tw-web-host`）。**工具层（10 → 15 个）**：新增 `tiddlywiki_append`（增量追加 / 段落定位）、`tiddlywiki_backlinks`、`tiddlywiki_attach`（本机文件或公网 URL → 二进制附件）、`tiddlywiki_lint`（垃圾标签 / 死链 / 空笔记 / 缺内容类型）、`tiddlywiki_trash`；`search` 改为**相关度排序 + 命中处上下文片段 + 字段过滤 + limit 上限 + TW 紧凑日期解析**（此前 `since` 过滤恒为空）、`list_tags` 不再统计只挂在二进制附件上的标签、`batch_put` 的单条失败不再被参数预校验整批打断、列表加短 TTL 缓存。**客户端**：草稿卸载/刷新前落盘、草稿按窗口分键（不再跨标签页互相覆盖）、`session-summary` 自愈循环与卸载后 setState 修复、中央面板 `hidden` 状态修正、三个常驻定时器加上停止条件、wiki 链接不再吞掉 Ctrl/中键、编辑器弹窗补 `role=dialog` 与焦点、列表项键盘可达、21 处 `:focus-visible`、移动端 `touch-action`、`numField` 的 `0` 不再被吞。**工程**：新增 **GitHub Actions CI**（静态检查 + 自测 + 单元 + E2E 四档，含 `git diff --exit-code -- lib/` 抓「改了 src 忘了 build」）、9 个新验收脚本（auth 模式此前零覆盖、工具层、seed 读失败反例、git 冲突、崩溃自愈、大 wiki、render bundle 逐字节、发布包内容、版本一致性）、`npm run verify:*` 方便本地一键跑、`lib/client.bundle.js` 不再入库、AGENTS 的 `grep @deepseek-ai` 检查修正为「真实 import」。**升级提示**：重启 dsh web 后新会话生效；客户端改动需刷新页面。
- **v0.18.0**（2026-09-10）：**一轮全量代码审计后的修复版**（数据安全 / 安全面 / 前端稳定性 / 工程卫生，共 40+ 项）。**数据不再静默丢失**：① seed 只在**真的 404** 时才认为条目缺失（此前任何读取错误都被当「不存在」，瞬时故障会让非 force 的启动 seed 覆盖你改过的同名笔记、`$:/DefaultTiddlers`、send-to-agent / render bundle）；② `wiki/.gitignore` 不再每次启动被整份重写（用户自定规则改前会被冲掉）；③ 配置 tiddler 读失败不再清空内存覆盖层（随后在设置页保存一项配置会丢掉其余全部覆盖）；④ 只有 **render-route 真的重写后**才重启 TW，且要等它落盘（否则重启会丢掉未 flush 的写入——这条是本版新引入又被测试抓出的回归）。**正确性**：`/render` 现在按 tiddler 自己的 `type` 渲染——**Markdown 笔记在回复流卡片/汇总里终于按 Markdown 渲染**（此前硬编码 wikitext，`## 现象` 会被当成 wikitext 列表，实测复现）。**安全**：所有写路由（`/admin/*`、`/note`、`/edit`、`/upload`、`/sync`、`/restart`、`/api`、`/tw` 的写方法）加**同源/CSRF 守卫**（跨站写请求 403，跨站 GET 不受影响）；剪藏桥图片下载加 **SSRF 守卫**（仅公网 http(s)，逐跳校验重定向，拒绝回环/内网/云元数据地址）；`bridge.port` 设置页改动现在**真的生效**（此前只读 cordis 基座）；`auth.username/password` 从此**可用**（内置 REST 客户端与就绪探测带 Basic 认证，代理转发 `WWW-Authenticate` 让浏览器弹登录框，此前配置了用户名会让插件 20s 后启动失败）。**前端**：编辑器弹窗不再因同草稿重开而整机重载、并纳入面板互斥；中央面板自愈列元素重建；右栏 Tab 重新可见会重新探测状态；侧边栏入口插入不再抛 `NotFoundError` 连带拖垮 FAB/面板；同步中不再被 30s 轮询覆盖状态；`injectStyles` 可卸载（热重载拿到新样式）；每处 mount 独立 try/catch；面板的 DOM 观察/滚动测量合并到 requestAnimationFrame（流式输出时不再每帧强制样式重算）。**工具与仓库**：`put`/`batch_put` 不再把读取失败当新条目而误打 `agent-written`，`fields` 不能覆盖 `title/text/tags`，`batch_put` 逐条报告失败；git 的 commit 与 pull 串行化（不再争 `.git/index.lock`）；`/status` 的 git 摘要加 2s 缓存（每次调用少跑 5 个 git 进程）；请求中途断开不再挂住路由；自动端口被占时会重新探测；`tiddlywiki.info` 损坏不再让后台 500；会话汇总对后代会话/条目数设上限。**工程卫生**：bundle 版本单一来源（`scripts/bundle/versions.mjs`，渲染路由 0.2.0）、生成器从 bundle 读版本（外层 0.3.2 漂移修正为 0.3.4）、发布包不再带 `client.bundle.js` 中间产物、`verify-*` 假阳性修复（未 await 的用例、被当成断言的 console.log）、selftest 失败也会回收 TW 子进程、`gen-seed-home` 默认剥离私有人口、`verify-menubar-theme` 不再默认打作者本机端口。
- **v0.17.0**（2026-09-10）：**移除：DSH Better Sidebar（dsh-better-sidebar）Tab 集成**。旧版通过 `ctx.betterSidebar.registerTab({id:'dsh-tiddlywiki'})` 注册的 tab kind 会与其它注册方冲突，浏览器控制台报 `sidebarRight: tab kind "dsh-tiddlywiki" is already registered (extension)`；本版**整体删除**该注册路径（删除 `better-sidebar-tab.ts`、client 入口的挂载块，以及 `ui.showBetterSidebarTab` 配置项/设置页开关），插件不再引用 `ctx.betterSidebar` 服务。与 dsh-better-sidebar 的**界面共存**（中央面板 z-index 让位于其侧边栏按钮）保留；右侧边栏入口请用 DSH 原生 rightbar（`ui.showRightbarTab`）。**更新后刷新页面**生效；旧版可临时用 `ui.showBetterSidebarTab=false` 规避冲突。
- **v0.16.28**（2026-09-10）：**修：拖拽版剪藏书签在知乎等真实页面报 `SyntaxError: Unexpected token ';'`**。根因（真实 Chrome 实验证实）：0.16.27 把书签 href 做 **HTML 实体转义**（`&quot;`/`&amp;`/`&lt;`），但浏览器的 `a.href` **不做实体还原**——拖拽成书签后存的就是实体文本，执行时即解析失败。修复：href 改为 **percent-encoding**（`CLIP_BRIDGE_DRAG_HREF`，属性里只剩 `%XX`，天然无需任何属性转义）；Chrome 执行 `javascript:` URL 前会 percent 解码（实测通过）。浏览器 E2E 升级为**直接以编码 href 走 `location.href` 执行**（完全等价拖拽书签的执行路径）并断言浮层弹出；静态验收改为 `decodeURIComponent(href) === 代码常量` 一致性校验。行为不变——**已拖过旧版书签的用户需重新初始化 seed 后重新拖一次**（旧书签仍然坏的，因为里面的代码是实体文本）。
- **v0.16.27**（2026-09-10）：**剪藏书签支持「拖拽安装」**。seed 文档新增一个**可拖拽按钮**（markdown 内嵌原始 HTML 锚点，href 即书签代码）——按住拖到浏览器书签栏/地址栏松手即装好，免去复制粘贴；代码 fence 保留作兜底。书签代码抽成单一常量 `CLIP_BRIDGE_BOOKMARKLET`（锚点 href 做 HTML 实体转义），并新增**同步一致性校验**（`verify-clip-bridge.mjs`：href 解码后与代码逐字相等）与**浏览器 E2E**（`verify-clip-bridge-browser.mjs`：真实 TW + 无头 Chrome 渲染真实 seed 文档，断言 javascript: href 原样保留 / draggable / 解码一致 / 真浏览器里执行书签弹出浮层 / 无 JS 异常）。
- **v0.16.26**（2026-09-10）：**修：剪藏书签在真实页面上崩溃**（`Cannot set properties of null (setting 'value')`）。根因：浮层字段在 `p` 尚未挂到 document 前就用 `document.getElementById` 取值（脱离文档树查不到 → null）；同时 `cb_*` id 可能与页面自身元素冲突。修复：所有浮层字段改为 `p.querySelector` 作用域内查找 + 字段赋值挪到 `appendChild` 之后；并把书签放进 **jsdom 真实 DOM 端到端跑通**（浮层/填充/选图/提交载荷/结果态 12 项全过）作为验证，`verify-clip-bridge.mjs` 新增静态回归断言（禁未限定 getElementById + 挂载时序）。行为无变化，仅书签代码（seed 文档）修复。
- **v0.16.25**（2026-09-10）：**剪藏桥支持图片剪藏（浮层选图）**。书签升级为**选择式浮层**：可改标题/编辑选中文字，浮层列出页面图片缩略图（自动跳过 <80px 小图标与 data:/blob: 占位、去重，`og:image` 标「封面」并默认勾选）勾选图片后一键剪藏。图片由桥（DSH 进程侧）**下载字节存为二进制附件 tiddler**（`type: image/*` + base64 正文，即 TW 原生附件形态；`clip-url`/`clip-note` 溯源），笔记改用 wikitext 用 `[img[标题]]` 内嵌展示；某张下载失败自动降级为链接、不阻塞整次剪藏；纯文字剪藏保持原 markdown 路径不变。安全不变（127.0.0.1 + Host 校验 + 可选 token；下载带 referer/UA 应对常见防盗链）。验收新增 image-flow 测试 + 书签语法检查（`verify-clip-bridge.mjs` 24 项全过）。

- **v0.16.24**（2026-09-09）：**新：本地剪藏桥 + 书签小工具**。DSH 进程内新增只监听 **127.0.0.1** 的 HTTP 桥（配置组 `bridge.*`：`enabled` 默认关、`port` 默认 8618、`token` 可选共享口令、`tag` 默认 `clip`）——浏览器书签（JS 小工具）把当前页标题/URL/选中文字 POST 给它，经唯一写入通道落进 wiki（markdown、重名自动 `（2）` 去重、默认 `clip` 标签、随 wiki 自动 git commit）。安全：Host 头白名单防 DNS rebinding、CORS/PNA 预检放行（https 页面书签可用）、`bridge.token` 强烈建议设置。附**可选 seed** `clip-bridge`：「本地剪藏桥（书签小工具）」说明文档（含书签代码/启用步骤/安全说明/curl 用法，打 `dsh-docs` 标签进「📚 插件文档」栏，可反初始化）；设置页新增 4 个配置字段。`enabled`/`token`/`tag` 设置页保存即生效，改端口需重启 dsh web。

- **v0.16.23**（2026-09-09）：**新：DSH Better Sidebar（dsh-better-sidebar）集成**。插件通过 `ctx.betterSidebar` 服务注册 TiddlyWiki 为 Better Sidebar 侧边栏的 tab 类型——+ 菜单点击即以 tab 打开完整 TW 编辑器（同源代理 iframe，与聊天并排）；TW iframe 机制抽成共享模块（rightbar/better-sidebar 复用：lazy-load / status 轮询 / 主题同步 / hash 导航 / 互斥协议），回复流 wiki 链接在同一处统一路由到任一可见的侧边 TW tab。配置 `ui.showBetterSidebarTab`（默认 true）可开关；未安装 Better Sidebar 自动跳过。**更新后刷新页面**即可看到入口。
- **v0.16.22**（2026-09-09）：**seed 体系三层化 + 文档中心起步包**。① 分层：**核心**（自动、不可移除：发送按钮/渲染路由/代理基址）+ **起步**（首次安装默认写、可移除：插件说明 + 新增「示例与文档」seed——主题汇总模板/教程/三个示例主题页）+ **可选**（手动：首页/所有文章/新增「自定义样式」seed/顶栏主题）；所有种子**安全跳过**（同名 tiddler 已存在绝不覆盖）。② 新增 **`dsh-docs`** 文档合集约定：所有 seed 文档打该标签，首页「📚 插件文档」tabs 栏自动收录。③ seed 版首页改为**通用版**（`gen-seed-home --strip-private`：剥离作者私有人口，注入文档栏）。④ **修**：首页快速记笔记的 tags 筛选器 bug（`then[[todo]]` 操作数双括号导致「筛选器错误」被拆成 6 个 tag → 改为 `then[todo]`）。
- **v0.16.21**（2026-09-09）：**新：DSH 右侧边栏（rightbar）集成**。注册 TiddlyWiki 为右侧栏 tab 类型——rightbar 首页出现「**TiddlyWiki 知识库**」入口盒，点击即在右侧栏以 tab 形式打开完整 TW 编辑器（同源代理 iframe，跟随 DSH 主题），**与聊天并排**；配置 `ui.showRightbarTab`（默认 true）可开关。**更新后刷新页面**即可看到入口。
- **v0.16.20**（2026-09-09）：**修：`search`/`recent` 在大 wiki 上超时**。根因：列表请求把全部 tiddler（含图片等二进制附件）的 base64 正文拉回来（2418 个 tiddler ≈ 515MB/17s）。修复：`search`/`recent`/`get` 在**服务端**只取文本 tiddler（无 `type` 或 `text/*`）；二进制 tiddler 完全排除，`get` 对二进制只回元数据。实测 515MB/17s → **6.24MB/0.3s**。
- **v0.16.19**（2026-09-07）：**修：会话「知识库」Tab 把汇总当源码显示**——TW 5.4.1 把 `$:/temp/` 条目一律按代码块渲染；改为 `/tw/render` 原生片段管线（与回复流工具卡同链路），不再用 iframe/story view。
- **v0.16.18**（2026-09-07）：README 全面精简重写；seed 优化——首页 seed 跟随 wiki 现状、修「所有文章」回主页死链、doc-note 文案修正。
- **v0.16.17**（2026-09-07）：点击快速笔记可选直达 TW 原生编辑页（`ui.quickNoteMode`）+ 修「在 TW 中编辑」弹窗 ✕ 关不掉。
- **v0.16.16**（2026-09-07）：修会话知识库 Tab 误入编辑草稿显示源码——三层防误编辑（清残留草稿/吞草稿创建/禁 ✏️）。
- **v0.16.15**（2026-09-07）：`put`/`batch_put` 未指定类型自动默认 `text/markdown`；警告 `fields.type` 是内容类型保留字段。
- **v0.16.14**（2026-09-07）：修知识库 Tab「佚失条目」根因——浏览器端 TW 天生排除 `$:/temp`，改为 iframe 就绪后注入 + 原生 hash 导航。
- **v0.16.11**（2026-09-06）：新增会话顶部「知识库」Tab（本会话相关 wiki 汇总，volatile `$:/temp`）。
- **v0.16.0**（2026-09-05）：回复流原生 TW 工具卡片 + 可点击 wiki 链接（新增 `render-route` seed）。
- **v0.15.0**（2026-09-05）：初始化不强制 + 可反初始化（seed 拆核心/可选两层）。
- **v0.14.0**（2026-09-05）：「发送给 Agent」按钮独立图标 + 附加说明 + 权限选择。
- **v0.13.0**（2026-09-04）：menubar 顶栏主题自适应。
- **v0.12.0**（2026-09-04）：新默认主页 + 「所有文章」两列分页页。
- **v0.11.0**（2026-09-04）：「发送给 Agent」支持选择工作模式（Agent 预设）。
- **v0.10.0**（2026-09-04）：统一 seed 注册表 + 设置页「初始化」。
- **v0.8.0**（2026-09-04）：嵌入式 TW 跟随 DSH 深浅主题。
- **v0.7.0**（2026-09-03）：TW 一键把当前笔记发送到 dsh 会话。
- **v0.6.0**（2026-09-03）：同源代理（远程访问核心）。
- **v0.5.0**（2026-09-03）：Agent 工具扩充 + 快速笔记草稿自动保存 + 统一知识库 FAB。

---

## 📦 发布

```bash
npm publish    # 版本号在 package.json；文件白名单见 files 字段
```

`tiddlywiki` 依赖体较大（含全部语言包/插件）。

---

## 🔗 仓库与发布元数据

- **GitHub**：https://github.com/bbqisbbq/dsh-tiddlywiki
- **npm**：`dsh-tiddlywiki`（https://www.npmjs.com/package/dsh-tiddlywiki）
- 说明笔记、首页、示例文档、样式等预置内容由 seed 机制写入 wiki（见 [🧩 初始化](#-初始化一次性预置-seed哪些必备哪些可有可无)）
- MIT；Node ≥ 22；GitHub topics：`dsh` `dsh-plugin` `tiddlywiki` `knowledge-base` `note-taking` `git-sync` `agent-tools` 等

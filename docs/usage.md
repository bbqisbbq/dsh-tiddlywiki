# dsh-tiddlywiki 使用指南

> 从 README 拆出：使用指南 / 配置 / 远程访问。

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

### 🗂 多知识库（同时在线，v0.28.0）

默认是**单库模式**：一个知识库、一个 TW 子进程，一切与以前完全一样。要同时用多个库：

1. **加第二个库**：设置页 →「TiddlyWiki 知识库」→ **知识库列表** → 填根目录 + 文件夹名（+ 显示名）→
   「添加知识库」。目录不存在会自动 `--init server` 建一个全新知识库；已存在的目录直接接管。
2. **切到多库模式**：同一区块的「运行模式」选 **多库**。此后清单里的库都可用；标了「开局自启」的
   随 DSH 一起启动，其余在你打开或选中它时启动（**每个库一个 TW 子进程，约 150 MB**）。
3. **在界面里用它**：右下角「知识库」按钮的菜单会列出所有库（● 当前），点一个就切过去并打开它的
   编辑器；每个库的编辑器走自己的同源地址 `/dsh-tiddlywiki/tw/<id>/`，**不会串台**。
4. **告诉 Agent 用哪个库**：输入框上方会出现「知识库」下拉（**只在可见库多于一个时出现**），选择是
   **按会话**的，存在 `$DSH_HOME/dsh-tiddlywiki/sessions.json`，跨 `dsh web` 重启仍在。选一个没在跑的
   库会自动把它启动（工具是同步解析作用域的，所以"选中"这一步必须顺手起它）。
5. **让某个库对 Agent 隐身**：知识库列表里点该行的「**对 Agent 隐身**」。隐身 = Agent 永远碰不到它：
   不进选择器、不进注入提示词、检索 / lint / 反向链接都不含它。人仍然照常用 —— 适合书籍语料、导入归档。
6. **想拆分现有的库**：见 [拆分知识库](./wiki-split.md)，那里有一段**可以直接复制给 Agent 的话**。

细节：

- **每个库有自己的一套设置**：笔记标签、语言、主题、`prompt.*` 都在该库自己的
  `$:/plugins/dsh-tiddlywiki/config` 里。设置页顶部会显示「**配置作用域**：…」，点某个库那一行的
  「配置」即可改它的设置 —— 作用域不说清就会出现"改了但不生效"。
- **git 按仓库生效**：多个库可以共用**一个**仓库（例如「工作」+「个人」放在 `D:/notes/` 下的两个子
  目录），也可以各自独立仓库。共用仓库时**只有一个自动提交者**（`git add -A` 会作用于整个工作树），
  `git.*` 以该仓库下**列表里第一个库**为准、配置不一致时打印警告；pull 之后**只重启内容真的变了的库**。
- **「移出列表」不删目录**：只是让插件不再管理它，内容原样保留。
- **清单文件**：`$DSH_HOME/dsh-tiddlywiki/wikis.json`（在每本 wiki 之外，所以它不会随某个库被搬走）。
  手写时注意：`id` 只能用小写字母/数字加 `._-`，且不能是 `status`/`files`/`recipes`/`render` 这类与 TW
  根路径撞名的保留字；两个库不能指向同一目录，**也不能互相嵌套**（外层库的 `git add -A` 会把内层内容
  一起提交，插件会直接拒绝这种登记）。

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
> 完整安装步骤与排错见 [docs/wechat-publish-setup.md](wechat-publish-setup.md)。

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

**换机器还原**见 [docs/wechat-publish-setup.md](wechat-publish-setup.md)（含 opencli / Browser Bridge 扩展安装、扫码登录、排错表）。设计依据与全部实测细节见 [docs/plans/2026-09-17-wechat-publish-design.md](plans/2026-09-17-wechat-publish-design.md)。

### 🧩 初始化（一次性预置 seed）：哪些「必备」，哪些「可有可无」

seed 是把「wiki 里预置内容」随插件分发的机制：**ONE-SHOT（只写缺失）+ 安全跳过（同名 tiddler 已存在绝不覆盖你的数据）**，需要时可「重新初始化」恢复、可「反初始化」移除。详细见 [docs/seed-initialization.md](seed-initialization.md)。

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


TW 子进程只监听 **127.0.0.1 回环**；Agent 工具/快速笔记/同步都走 DSH 宿主进程→回环 TW，不受访问入口影响。浏览器里的 TW 编辑器 iframe 经**同源代理** `<DSH origin>/dsh-tiddlywiki/tw/` 访问（v0.6.0 起），所以通过 Tailscale / 内网 / 域名 / HTTPS 访问 DSH 时编辑器照常工作，且 TW 重启不打断编辑中的内容。

---


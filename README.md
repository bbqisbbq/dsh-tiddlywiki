# dsh-tiddlywiki

> 给 DSH 装一个**你自己的**知识库：**你在界面里读、写、记日记，Agent 用同一批笔记干活。** 纯文本 + git，能读、能改、能带走。

[![npm](https://img.shields.io/npm/v/dsh-tiddlywiki)](https://www.npmjs.com/package/dsh-tiddlywiki)
[![license](https://img.shields.io/npm/l/dsh-tiddlywiki)](https://github.com/bbqisbbq/dsh-tiddlywiki/blob/main/LICENSE)
[![GitHub](https://img.shields.io/github/stars/bbqisbbq/dsh-tiddlywiki)](https://github.com/bbqisbbq/dsh-tiddlywiki)

**它不是自动记忆插件。** 不后台抓取、不向量召回、不在你不知道的情况下"记住"什么——每条笔记都是你能打开、能审、能 `git diff` 的文件。要不要让 Agent 看，由你决定。

---

## ⚡ 30 秒上手

```bash
dsh plugin --profile web add dsh-tiddlywiki
```

重启 dsh web。**首次启动自动完成**：建 wiki 目录、`git init` 提交基线、写入起步文档（插件说明 + 示例与文档）。**不需要先配任何东西。**

1. 侧边栏 **TiddlyWiki** → 中央列打开完整 TW 编辑器
2. 输入框上方 **📝** 或右下角 **知识库** → 快速记一条（写完即进 git）
3. 直接说「把这段存进知识库」→ Agent 用 `tiddlywiki_*` 工具读写
4. 收工点 **🔁 同步** → pull → commit → push

想用已有的文件夹当库？设置页「知识库位置」里切换，不用改配置、不用重装。

## 🎯 适合谁 / 不适合谁

**适合**：想要一个**本地、纯文本、能随时带走**的长期笔记库，并且愿意让 Agent 读写同一批文件的人；已经在用 Obsidian / Logseq、但缺"Agent 也能进"这一层的人。

**不适合**：想要"装完就自动记住我说过的一切"的人（那是另一类插件：自动抽取 + 向量召回 + 后台注入；本插件不做后台抓取）；完全不想碰 TiddlyWiki 心智模型的人——它需要一次五分钟的理解。

## ✨ 它好在哪

| | |
|---|---|
| 👥 **人和 Agent 同一份库** | 你在 TW 里读写的，就是 Agent 读写的；不是"我写给你看"，也不是"它记它的" |
| 🛡 **写入不会吃掉你的东西** | 所有写路径先读后写：不传 `tags` 就保留原标签/字段/内容类型；同名默认拒绝覆盖；删除进回收站可恢复；可选 `expectedModified` 乐观并发（读后被改过就拒绝写入，而不是静默覆盖） |
| 🚰 **重启不丢写入** | 停/重启 TW 只有一条路：先排干 syncer 队列再停，排不干净会如实报 `drained:false` |
| 🕰 **可审计、可回溯** | 库本身就是 git 仓库（自动 commit + 一键同步）；反向链接、标签、体检（`lint`）；阶段性内容可标 `valid-until` / `superseded-by`，**淘汰永远由人决定，插件不自动删** |
| 📦 **数据可带走** | 磁盘上就是 `.md` + `.meta` + `.tid` + `files/`，不需要这个插件也能读 |
| 📮 **可选发布** | 打开后能把笔记一键发到微信公众号草稿箱（默认关闭，不打扰） |

## 🤖 Agent 工具（15 个）

`search`（先在工作区内查、0 条才扩全库） · `get` · `put` · `batch_put` · `append`（增量追加，可指定标题段落） · `rename`（含引用改写） · `delete`（默认进回收站） · `trash` · `backlinks` · `attach`（图片/PDF 入库） · `lint`（死链/空笔记/时效） · `recent` · `list_tags` · `git_sync` · `git_resolve`

每个工具的**完整参数与语义**见 [docs/usage.md](docs/usage.md)。

## 🔧 配置

插件向每个会话注入一段可配置的提示词（默认精简版 ~1.9KB，可整体关掉或替换），其余配置在设置页：知识库位置、git（自动提交/远端/分支）、笔记标签与工作区标记、快速笔记、剪藏桥、公众号发布、界面语言、访问口令。

完整配置项与远程访问（Tailscale / 内网 / 域名）见 [docs/usage.md](docs/usage.md)。

## 📚 文档

| 想看什么 | 去哪 |
|---|---|
| 完整能力清单（每条的**为什么**） | [docs/features.md](docs/features.md) |
| 使用指南 / 工具参考 / 配置 / 远程访问 | [docs/usage.md](docs/usage.md) |
| 发布到微信公众号（可选，需额外安装） | [docs/wechat-publish-setup.md](docs/wechat-publish-setup.md) |
| 把知识库拆成几个独立的小库（含可复制给 Agent 的提示词） | [docs/wiki-split.md](docs/wiki-split.md) |
| 开发与发布流程（给维护者） | [docs/development.md](docs/development.md) |
| 完整版本变更历史 | [docs/CHANGELOG.md](docs/CHANGELOG.md) |

## 🕘 版本记录

- **v0.28.3**（2026-09-28）：**修三个真机报障 + 插件说明补「多库 / 升级」两节**（作者拆库实测中发现）。① 单库模式下快速笔记露出一个没有选项的下拉 —— 根因是 **CSS `hidden` 只是 `display:none`，被显式 `display` 盖掉**（修法：显式 `[hidden]{display:none}` + 组件兜底）。② 会话级选择器没和输入框对齐 —— **对齐规则原本只写在 quick-note 条目内部**，已抽成 `client/dock-align.ts` 两处共用。③ 左侧入口按库显示：多库时每个在运行的库一个入口行、用各自显示名，点该行先切焦点库再开面板。④ 插件说明新增「多知识库」与「从旧版本升级上来」两节：明确升级后**不会自动变成多库**、`wikis.json` 在哪、旧指针文件何时还权威。守门扩到 19 条（含反向验证）。
- **v0.28.2**（2026-09-28）：**设置页去掉重复的「知识库位置」**（作者反馈：多库配置做完后它重复且逻辑冲突）。这一块的语义是「把**唯一的那个库**换到别处」——写的是 wiki 之外的指针文件 `location.json`，措辞也是单库时代的（"切换到这个位置" / "恢复为配置默认"）。现在**按模式二选一**：**单库模式**保留它（那里它是唯一正确入口）；**多库模式整块不渲染**，某个库换目录收到「知识库列表」那一行的**「改目录」**（默认库经 `/admin/wiki/switch` → 改清单 + farm 收敛 + 校验；非默认库直接 `update`）。宿主接口**没有**冲突也**没有**改动：`/admin/wiki/switch|reset` 从 v0.28.0 起就按模式分派。守门：`verify-wiki-focus` 新增"多库模式下不得渲染该块"的断言；farm-boot 补上 location 面接线（22 条），保证藏了界面之后**接口仍按模式正确分派**。
- **v0.28.1**（2026-09-28）：**修「拆库 skill 在 wiki 启动慢 / 起不来时永远装不上」+ 快速笔记的目标库可切换（R7）**。① **真实事故**（作者升级 0.28.0 后重启宿主时发现，测试没拦住）：技能安装写在了 `farm.startAll()` **之后**，而那个 wiki 很大、启动要几十秒 —— 于是"技能装没装"取决于"wiki 起得快不快"；更糟的是 wiki 若因配置问题**永远起不来**，技能就永远不装，而它跟 wiki 毫无关系（只往 `$DSH_HOME/skills/` 写一个文件）。已挪到启动任务**最前面**并新增**顺序守门**（`verify-skill-install` 断言安装早于 `startAll()`，已反向验证）。② 快速笔记卡片新增「写入」目标库：**默认跟随你在 GUI 里看的那个库**（焦点库），卡片内可临时改、改过后不再被焦点带走。要点是**整张卡片一起换库**：标签建议 / 最近 / 草稿读取 / 附件上传 / 保存 / 随后弹出的 TW 编辑器必须落在同一个库 —— 只改保存那一处会产出"标签列表来自 A、笔记写进 B"，比不做还糟（弹窗那条另有一条守门：写入 A、编辑器打开 B（空白）是典型的"看起来成功了"的失败）。目标库没在运行时卡片**先讲清楚**，而不是让你写完一段再失败。单库安装不显示选择器、请求 URL 逐字不变。
- **v0.28.0**（2026-09-28）：**多知识库**——同一进程内可同时运行多个 TiddlyWiki，每个库独立配置、独立 git、按会话选择作用域，且可对 Agent **彻底隐身**。起因是作者自己的库：`书籍` 语料 2468 条与日常笔记挤在一个 800MB 仓库里，Agent 检索/lint/backlink 每天在约 30 倍于工作集的内容上跑。拆库需要**同时在线**——只切换位置的话，你切到语料库翻资料时 Agent 也跟着切过去了。要点：① 三个模块各司其职（`wiki-registry` 清单/模式/动作、`wiki-instance` 单库运行时、`wiki-farm` 谁该在跑 + 会话作用域）；② 模式开关 `wikis.json` 的 `mode`（缺省 `single`，升级用户逐字不变）；③ 路由按库定向 `/tw/<id>/…`（每个库 seed 自己的同源基址——不区分 id 就会「页面显示 A、读写落在 B」），裸 `/tw/` 仍是默认库别名，为此引入**保留 id 名单**；④ **git 按仓库重构**：多库可共用一个仓库，`git add -A` 只允许一个 committer，pull 后只重启受影响的库；⑤ Agent 侧：会话单选作用域 + `agentVisible`，工具回执在可见库多于一个时**标明库名**，注入提示词**按会话求值**并读作用域库的 `prompt.*`；两条刻意拒绝（隐身库→忽略；没在跑→报错而非静默换库）；⑥ GUI：输入框上方的会话选择器、FAB 的知识库分组、设置页「知识库列表」与**显式配置作用域**；⑦ **拆库引导** `docs/wiki-split.md` + 随包 skill（安装时只覆盖带标记的文件）。新增 6 个守门脚本（共约 96 条断言，含**真起两个 TW 子进程**与**真 git 仓库**两类集成验证），全部反向验证；4 个既有守门跟着间接层更新。**未做**：per-wiki 认证（`auth.*` 仍全局）、快速笔记目标切换策略。
- **v0.27.3**（2026-09-28）：**修 v0.27.1 拆文档时打断的 6 个相对链接**（`docs/` 内的链接仍按仓库根写成 `docs/xxx.md`，从 `docs/` 内部点击打不开）；新增守门 `scripts/verify-doc-links.mjs`（校验 README + `docs/**` 的全部相对链接，已挂进 `verify:static`，让这类错误下次发不出来）；**修 CI 偶发假红**：`verify-wiki-switch` 的回滚断言会抢在 TW 载入 store 之前读取，改为 15s 有界轮询后再断言。**无运行时行为改动。**
- **v0.27.2**（2026-09-28）：修本页一处**指向不存在内容的死链**（"不适合"那段曾让人去看 `docs/features.md` 末尾的说明，那里并没有）。纯文案，无代码改动。
- **v0.27.1**（2026-09-28）：**README 从 175KB 精简成本页**——原来 68% 的篇幅是变更历史。能力清单 / 使用指南 / 开发发布 / 完整变更历史拆到 `docs/`（内容未删），首页只留"是什么、怎么装、好在哪、适不适合你"。**无代码改动。**

更早版本 → [docs/CHANGELOG.md](docs/CHANGELOG.md)

## 🔗 仓库与发布元数据

- **GitHub**：https://github.com/bbqisbbq/dsh-tiddlywiki ｜ **npm**：`dsh-tiddlywiki`
- **用得不顺请来提 issue**：https://github.com/bbqisbbq/dsh-tiddlywiki/issues —— 这插件原本是作者给自己做的，现在有同道人用；**你不报，我就不知道哪里不对**。
- MIT；Node ≥ 22；GitHub topics：`dsh` `dsh-plugin` `tiddlywiki` `knowledge-base` `knowledge-management` `note-taking` `journal` `git-sync` `local-first` `agent-tools` `publishing` `wechat` 等

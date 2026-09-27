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

**不适合**：想要"装完就自动记住我说过的一切"的人（那是另一类插件，见 [docs/features.md](docs/features.md) 末尾的说明）；完全不想碰 TiddlyWiki 心智模型的人——它需要一次五分钟的理解。

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
| 开发与发布流程（给维护者） | [docs/development.md](docs/development.md) |
| 完整版本变更历史 | [docs/CHANGELOG.md](docs/CHANGELOG.md) |

## 🕘 版本记录

- **v0.27.1**（2026-09-28）：**README 从 175KB 精简成本页**——原来 68% 的篇幅是变更历史。能力清单 / 使用指南 / 开发发布 / 完整变更历史拆到 `docs/`（内容未删），首页只留"是什么、怎么装、好在哪、适不适合你"。**无代码改动。**

更早版本 → [docs/CHANGELOG.md](docs/CHANGELOG.md)

## 🔗 仓库与发布元数据

- **GitHub**：https://github.com/bbqisbbq/dsh-tiddlywiki ｜ **npm**：`dsh-tiddlywiki`
- **用得不顺请来提 issue**：https://github.com/bbqisbbq/dsh-tiddlywiki/issues —— 这插件原本是作者给自己做的，现在有同道人用；**你不报，我就不知道哪里不对**。
- MIT；Node ≥ 22；GitHub topics：`dsh` `dsh-plugin` `tiddlywiki` `knowledge-base` `knowledge-management` `note-taking` `journal` `git-sync` `local-first` `agent-tools` `publishing` `wechat` 等

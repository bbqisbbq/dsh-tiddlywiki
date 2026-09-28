---
name: dsh-tiddlywiki-wiki-split
description: 把已有的 dsh-tiddlywiki 知识库按用户意愿拆成几个独立的库（语料/归档与工作集分开），并登记进插件的多知识库清单。当用户说「知识库太大了 / 检索被语料淹没 / 想把书和笔记分开 / 拆库 / 帮我拆开这个 wiki」时使用。
whenToUse: 用户要求拆分、整理或隔离一个已有的 TiddlyWiki 知识库，通常是因为 Agent 检索被只读语料淹没，或想分别备份到不同的 git 远端。
metadata:
  dsh-tiddlywiki-skill: wiki-split
  requires: dsh-tiddlywiki >= 0.28.0
---

<!-- dsh-tiddlywiki-skill:wiki-split v1
     上面这行是"这份 SKILL.md 是插件写的"的标记：安装器只会覆盖带标记的文件，
     你自己改过的（去掉标记即可）永远不被覆盖。 -->

# 拆分知识库（把语料/归档从工作集里分出去）

目标：把用户现有的一坨内容按**用途**拆成几个独立的库，每个库有自己的目录、自己的 git
仓库（或共用仓库里的一个子目录）、自己的插件配置，以及**是否对 Agent 可见**。

## 铁律（违反任何一条都停下，问用户）

1. **确认前不动任何文件。** 先只读体检 + 出方案表格，等用户明确确认再执行。
2. **先备份**：给现有仓库打一个 tag（或 clone 一份）。没有备份不动手。
3. **旧库一个都不许删。** 拆分是"复制/移动 + 重新登记"，不是删除。搬完让用户自己确认后再清理。
4. **用 `git mv` 保住历史**，不要 `mv` + `git add`（那样历史会断）。
5. **分步可中断**：每一步都告诉用户做到哪了、下一步是什么。

## 步骤

### 1. 只读体检（不改任何东西）

- **tag 分布**：`tiddlywiki_list_tags`（limit 调大），找出体量大又"只读"的簇（语料、导入归档）。
- **规模与体积**（shell）：`tiddlers/` 下的文件数、`files/` 的体积、`git rev-parse --show-toplevel`
  （判断是"独立仓库"还是"共用仓库"）、`git count-objects -vH`（仓库体积）。
- **一句话结论**：向用户说明"多少条里有多少条是语料/归档，它们是不是只读"。

### 2. 一次问完这五个问题（每个都给建议默认值）

| 问题 | 你要的答案 | 建议默认 |
|---|---|---|
| 拆成几个库，各叫什么？ | 显示名 | 按体检发现的簇命名（书籍/工作/个人） |
| 每个库收什么？ | 按 tag / 关键词 / 目录 / 时间段 | 语料按 tag；工作与个人按项目/主题 |
| git 怎么分？ | 共用现有仓库（按文件夹物理划分）/ 各自独立仓库 | 只读语料独立仓库，其余共用 |
| 哪些库对 Agent 可见？ | 可见 = 能检索/写入；隐身 = 永不触及 | **语料/归档建议隐身**（这正是拆分的目的） |
| 现在就搬，还是先出报告？ | 先出报告 = 只读 dry-run | 先出报告 |

### 3. 出方案表格，等确认

每个库一行：**显示名 | 收纳规则 | 目标目录 | git 仓库 | agentVisible | autostart**，
附"预计搬多少条"，并明确指出**不可逆点**（哪些操作改历史、哪些不能自动回滚）。

### 4. 备份

`git tag pre-split-<日期>`（或 clone 到另一个目录）。告诉用户怎么回滚：
`git reset --hard pre-split-<日期>`。

### 5. 搬迁

- 建目标目录，必要时 `git init`（独立仓库）或直接作为现有仓库的子目录（共用仓库）。
- `git mv <旧路径> <新路径>` 逐批搬，**保持提交历史**。
- 每个库补一个 `tiddlywiki.info`（新库可以让插件首次启动时 `--init server` 自动生成）。
- 共用仓库的情况下：**不要**在两个子目录里各配一个远端（一个仓库只有一个 `origin`）。

### 6. 登记进插件

**优先用设置页**：`知识库列表` → 「添加知识库」（根目录 + 文件夹名 + 显示名），然后逐行设置
「设为默认 / 对 Agent 可见·隐身 / 开局自启」。运行模式选「多库」。

需要手写时，文件是 `$DSH_HOME/dsh-tiddlywiki/wikis.json`：

```json
{
  "version": 1,
  "mode": "multi",
  "defaultId": "work",
  "wikis": [
    { "id": "work",     "label": "工作", "root": "D:/notes", "name": "work",     "agentVisible": true,  "autostart": true },
    { "id": "personal", "label": "个人", "root": "D:/notes", "name": "personal", "agentVisible": true,  "autostart": true },
    { "id": "books",    "label": "书籍", "root": "D:/corpus", "name": "books",   "agentVisible": false, "autostart": false }
  ]
}
```

约束（写错会被插件拒绝并告诉你原因）：

- `id`：小写字母/数字开头，只含 `a-z0-9._-`，≤64 字符；**不能**是 `status` / `files` / `recipes`
  / `bags` / `render` / `login` / `logout` / `index.html` / `favicon.ico`（会和 TW 自己的根路径撞名）。
- **两个库不能指向同一个目录**，**也不能互相嵌套**（外层库的 `git add -A` 会把内层内容一起提交）。
- `mode` 缺省是 `single`（只跑 `defaultId` 那个库）。

### 7. 校验（逐条给用户看结果）

- 每个库的 tiddler 计数与方案里的预期一致。
- 工作库里 `tiddlywiki_search` **不再命中**语料（这是拆分的目的）。
- 每个库能独立打开编辑器、能提交（`tiddlywiki_git_sync action=status` 或看 git 状态）。
- Agent 侧：会话选择器里只出现 `agentVisible` 的库；选一个库后工具回执上会标着库名。

### 8. 收尾

- 把体检数字与最终布局记成一条笔记（方便几个月后回看为什么这么分）。
- 提示用户：旧库还在，确认无误后再自行清理。

## 旧版本（插件 < 0.28.0）

没有多库模式，只有「切换知识库位置」（同一时刻只有一个库是活的）。降级做法：建好目录 →
用 `git mv` 搬 → 在设置页「知识库位置」里指向它。**但它做不到同时在线**：用户切到语料库翻资料
时 Agent 也跟着切过去了。先建议升级。

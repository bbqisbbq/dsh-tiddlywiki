# 给「另一台旧机器」的整段指令（多知识库迁移）

> 用途：把这台机器上**已经落地的多库拆分方案**，同步到另一台仍跑旧版本、单库的机器。
> 用法：下面「=== 复制开始 ===」到「=== 复制结束 ===」之间的整段，**原样复制**丢给那台机器上的 Agent 会话。
> 依据：`docs/wiki-split.md`（人读的拆分页）+ `skills/dsh-tiddlywiki-wiki-split/SKILL.md`（Agent 的操作手册）+ 本机实测的 `wikis.json`。

---

=== 复制开始 ===

我的 dsh-tiddlywiki 知识库要升级成**多知识库（多实例）**方案，并且要**把笔记和插件一起同步过来**。
这台机器是旧版本、单库。请按下面做，**每一步先只读体检、报告给我，我确认再动手**。

## 0. 先把版本升到 ≥ 0.28.9（不然多库功能不存在）

1. 先报告当前版本：读 `C:\Users\bbq\.dsh\profiles\web\node_modules\dsh-tiddlywiki\package.json` 的 `version`，
   以及 `C:\Users\bbq\.dsh\profiles\web\package.json` 里 `dsh-tiddlywiki` 的声明版本。
2. 升级（**必须显式指定官方源**，本机默认 `registry.npmmirror.com` 是只读镜像，可能还没有新版本）：
   ```
   dsh plugin --profile web up dsh-tiddlywiki --registry=https://registry.npmjs.org
   ```
3. 注意：**开发仓库 ≠ 运行时加载的那份插件**。dsh web 实际加载的是 profile 里的副本，
   所以「改了仓库代码」不会生效，必须走上面的安装命令 + **重启 dsh web**。
4. 升完先**重启 dsh web**，再继续。多库功能需要 ≥ 0.28.0；本方案的界面细节需要 ≥ 0.28.9。

## 1. 先做只读体检，不要改任何文件

报告这些数字（命令都只读）：

- 当前是不是单库：`GET http://127.0.0.1:<DSH端口>/dsh-tiddlywiki/status`，看有没有 `mode` / `wikis[]`。
  （旧版本没有这两个字段 = 单库模式，只有「切换知识库位置」。）
- 当前 wiki 根目录在哪、指针文件 `C:\Users\bbq\.dsh\dsh-tiddlywiki\location.json` 有没有内容。
- tiddler 数量、tag 分布 Top-20、`files/` 附件体积与文件数。
- `git rev-parse --show-toplevel` 与各仓库体积、`git remote -v`。
- **`git status --porcelain` 必须是干净的**（不干净就先同步完再继续，否则后面搬迁会混在一起）。

## 2. 我这边已落地的目标方案（照这个来，除非我另行说明）

**三个库，两套 git 拓扑：**

| 显示名 | id | 收什么 | 目录 | git 仓库 | Agent 可见 | 开局自启 | 图标 |
|---|---|---|---|---|---|---|---|
| 工作 | `work` | 日常笔记、开发文档、会议/决策记录 | `C:\Users\bbq\.dsh\tiddlywiki\notes\work` | `dsh-tiddlywiki-data`（与个人库**共用**） | ✅ 是 | ✅ 是 | 默认 |
| 个人 | `personal` | 个人笔记、生活记录、归档的旧日志 | `C:\Users\bbq\.dsh\tiddlywiki\notes\personal` | 同上（共用） | ✅ 是 | ✅ 是 | `briefcase` |
| 书籍 | `books` | 书籍/语料/扫描件，基本只读 | `D:\corpus\books` | `dsh-tiddlywiki-books`（**独立仓库，且是 private**） | ❌ **隐身** | ❌ 否 | `book` |

**关键设计点（这些是有意为之，别"优化"掉）：**

- **工作 + 个人共用同一个 git 仓库**（`notes/` 是一个仓库，两个库是它下面的两个文件夹）。
  为什么：`git add -A` 从子目录执行会暂存**整个工作树**，所以**一个仓库只能有一个 committer**；
  两个库共用仓库 = 一次提交同时覆盖两者，不会互相踩。
- **书籍库独立仓库且在 D 盘**：语料约 740MB（其中 `files/` 附件 907 个文件 / 364MB），
  不能背在 60 秒一次的自动提交上。
  它同时是 **private** 仓库（`dsh-tiddlywiki-books`）。
- **书籍库 `agentVisible: false`**：Agent 永远碰不到它（检索 / lint / 反向链接 / 会话选择器都不出现）。
  这是"防检索被语料淹没"的正解。
- **书籍库 `autostart: false`**：不随 DSH 启动（每个库一个 TW 子进程，约 150MB），
  在你打开或选中它时才自动拉起来。
- **书籍的图片放在 wiki 自己的 `files/` 里**（907 个文件 / 364MB），**不要**改成外链或图床 ——
  必须保证书籍能独立打开、扫描件不裂图。
- **`wikis.json` 放在每本 wiki 之外**（`C:\Users\bbq\.dsh\dsh-tiddlywiki\wikis.json`），
  这样它不会随某个库被搬走。

**`wikis.json` 的目标内容（结构照抄，路径按那台机器实际情况改）：**

```json
{
  "version": 1,
  "mode": "multi",
  "defaultId": "work",
  "wikis": [
    { "id": "work", "label": "工作", "root": "C:\\Users\\bbq\\.dsh\\tiddlywiki\\notes", "name": "work",
      "agentVisible": true, "autostart": true },
    { "id": "personal", "label": "个人", "root": "C:\\Users\\bbq\\.dsh\\tiddlywiki\\notes", "name": "personal",
      "agentVisible": true, "autostart": true, "icon": "briefcase" },
    { "id": "books", "label": "书籍", "root": "D:\\corpus\\books", "name": ".",
      "agentVisible": false, "autostart": false, "icon": "book" }
  ]
}
```

手写注意：
- `id` 只能小写字母/数字加 `._-`，且不能是 `status`/`files`/`recipes`/`render` 这类与 TW 根路径撞名的保留字。
- 两个库不能指向同一目录，**也不能互相嵌套**（外层库的 `git add -A` 会把内层内容一起提交进去）。
- `name` 是**该 root 目录下的文件夹名**；`name: "."` 表示 root 本身就是库根（书籍库就是这样）。

## 3. 分步执行（每步做完停下来报告）

1. **备份**：给现有仓库打 tag（例如 `pre-split-<日期>`），保证能整体回滚。**旧库一个都不许删。**
2. **建目录 / 搬迁**：用 `git mv` 尽量保住历史。
   ⚠️ **`git mv` 不能跨仓库**（会 `fatal: ... is outside repository`）。
   跨仓库搬迁的正确姿势：先在**原仓库内** `git mv` 到暂存目录并提交（历史保住在原仓库），
   再物理移动到新位置、在新位置 `git init` 建新仓库。
3. **每个库补 `tiddlywiki.info`**（容器根的 `tiddlywiki.info` 要改名让位，例如
   `tiddlywiki.info.container-backup`，否则 TW 会把它当成一个库根）。
   容器根下原本的 tiddler 要归档挪走（本机挪到了 `notes\_container-root-tiddlers\`，446 个文件）。
4. **写 `wikis.json`**（内容见上），`mode: multi`。
5. **重启 dsh web**，然后设置页里确认「知识库列表」出现三行。
6. **恢复首页**：三库都要有首页 —— `$:/DefaultTiddlers` 指向 `[[🏠 主页]]`，
   每库各自设 `SiteTitle` / `SiteSubtitle`（工作 / 个人 / 书籍）。
   `🏠 主页` 是 `toc-tabbed-external-nav`，用 `索引` 标签收集索引页。
7. **第三方插件恢复**：把原来那批第三方插件**补回每个库**。本机确认要有的 11 个：
   `BTC_TiddlyFlex`、`BTC_resizer`、`dyp_LXGWNeoXiHeiScreenFull`、`Gk0Wk_CPL-Repo`、`kookma_narenj`、
   `kookma_pinboard`、`linonetwo_fira-code-font`、`linonetwo_gallery`、`linonetwo_simple-layout-launcher`、
   `nico_notebook-mobile`、`oeyoews_mermaid`
   （在每库的插件管理里勾选；这些是**经 TW 原生方式装进 wiki 的**，落盘为
   `tiddlers/$__plugins_<author>_<name>.json`，**不会**写进 `tiddlywiki.info`）。
8. **校验**：
   - 各库 tiddler 计数与预期一致；
   - 工作库检索**不再命中**书籍语料；
   - 每个库能独立打开、独立提交（`git status` 在各仓库里都干净）；
   - 书籍库在会话选择器里**不出现**（隐身生效）；
   - 书籍里的扫描图片能正常显示（不是裂图）。

## 4. 软性节点提醒（容易踩的）

- **`heading` 定位**：`tiddlywiki_append` 的 `heading` 落点是「该标题之后、下一个任意级别标题之前」，
  不是整节末尾；**未命中不会静默**，会返回 `headingMatched=false` 并说明已追加到文末。认这个字段。
- **一切内容改动走插件 API**（`put`/`append`/`batch_put`/`rename`/`delete`），
  **不要**直接用文件工具编辑 `tiddlers/` —— 运行中的插件有内存快照，看不见你的磁盘改动，
  而且下次写入会用内存版**覆盖**你的改动。
- **要整篇重写大 tiddler，别让模型复述全文**：用脚本在磁盘上做手术 → `POST /dsh-tiddlywiki/restart`
  （自带 `drainThenStop`，安全）让 TW 重新读盘 → 校验。**前提是先确认 `git status` 干净**，
  否则重启时的 flush 会把内存里的旧版本写回、覆盖你的手术。
- **`git pull` 冲突时不要无脑 `keep-local`**：它只改工作区、**那个领先的本地提交没变**，
  下一次 pull 会重放同一个提交 → 同一个冲突（原地打转）。时间戳-only 的冲突要丢弃本地那个提交。
- **wiki 指针文件在 wiki 之外**（`location.json`），权限优先级：指针文件 > cordis config > 默认值。

## 5. 我要你先回答我

1. 体检数字（第 1 步那些）。
2. 那台机器的实际路径跟我上表里的**哪些不一样**（D 盘存不存在？`notes/` 这个结构适不适合照搬？）。
3. 有没有第二块盘 / 书籍库放哪个盘。
4. 现有仓库的远端是什么、要不要也拆成两个远端。

**我确认之前，不要创建、移动、删除任何文件。**

=== 复制结束 ===

---

## 附：为什么这样拆（给人看的背景，不用发给那台机器）

- **检索被淹没**是本方案的直接动因：书库 4026 个 tiddler + 907 个扫描附件，
  和日常笔记混在一个库时，Agent 搜一个词前十条全是语料。
- **`agentVisible: false` 是"彻底隐身"**，不是"优先级低"——检索、lint、反向链接、会话选择器
  全都不会碰它。比"让 Agent 自己判断"可靠得多。
- **一个仓库一个 committer** 是硬约束（`git add -A` 的语义），所以「共用仓库」不是偷懒，
  而是这两个库必须共用才能各自独立提交而不互相踩。
- 每个库有**自己的一套配置**（各自的 `$:/plugins/dsh-tiddlywiki/config` tiddler），
  设置页顶部会显示「配置作用域」，不会出现"改了但不生效"。

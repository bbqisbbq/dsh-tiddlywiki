# 设计：TiddlyWiki 一键发布到微信公众号

- 日期：2026-09-17
- 状态：待评审
- 来源：会话调研（dsh-tiddlywiki 工作区）
- 用户选定：**唤醒 agent** + **草稿 + 自动点发表（完整发布）**

## 1. 问题与约束（调研结论）

### 1.1 为什么不能走官方 API

公众号发布的服务端链路是 `access_token → draft/add → freepublish/submit`。但：

- **2025 年 7 月起，官方回收「发布能力」接口对个人主体、企业未认证、不支持认证账号的调用权限**（[发布能力文档](https://developers.weixin.qq.com/doc/subscription/guide/product/publish.html) 原文注）。个人主体无法做微信认证，故 `freepublish/submit` 不可用。
- 草稿箱 `draft/add` 文档未列该限制，但 48001/`api unauthorized` 是常见返回，不能假定可用。
- 即便可用，还叠加：**必须把本机公网出口 IP 加入 API IP 白名单**（否则 61004/40164）、封面 `thumb_media_id` 必须是**永久素材**、正文图片必须是 `media/uploadimg` 产出的 mmbiz 地址（外链被过滤）。

**结论：纯 API 路线对个人号不可行。**

### 1.2 为什么浏览器路线可行

后台网页端（`mp.weixin.qq.com`）的**发表/群发从未受 API 回收影响**——这是所有个人号日常发文的方式。因此「驱动后台网页」= 完整发布能力。

### 1.3 硬约束：发表需要管理员扫码

多份实操文档一致表明：后台点「发表」后**需要公众号管理员微信扫码确认**（[135编辑器流程](https://www.135editor.com/books/chapter/1/797.html)：「点【发布】，扫码验证身份后文章即发布成功」）。

**这是本设计的中心约束**：不存在「完全无人值守的一键发布」。
「一键」的真实含义是——**agent 完成素材、排版、上传、填表、进草稿箱，直到人工只需扫一次码**。

另需区分两个操作（易混）：

| 操作 | 是否推送粉丝 | 是否占群发额度 | 扫码 |
|---|---|---|---|
| **发表** | 否（仅生成永久链接） | 否，不限次数 | 是 |
| **群发** | 是 | 个人订阅号 1 天 1 次 | 是 |

本设计默认走**发表**（不打扰粉丝、不吃每日额度），群发作为显式可选。

## 2. 现状与可复用资产（已实测）

- 本机 `opencli` 已升级 **1.7.4 → 1.8.7**，`D:\npm-global` 下有 `puppeteer-core@24.38.0`，Chrome 位于 `C:/Program Files/Google/Chrome/Application/chrome.exe`。
- **opencli 内置 `weixin` 适配器**（`clis/weixin/`）：

  | 命令 | 作用 | access |
  |---|---|---|
  | `weixin create-draft` | 建图文草稿 | write |
  | `weixin drafts` | 列草稿箱 | read |
  | `weixin download` / `search` | 下文章 / 搜狗微信搜索 | read |

  `create-draft` 走 `Strategy.COOKIE` + `mp.weixin.qq.com` 登录态：打开后台 → 从 URL 取 `token=(\d+)` → 进 `appmsg_edit_v2` → 填 `textarea#title`/`input#author`/`textarea#js_description` → 图片经 CDP `setFileInput` 上传 → 点「保存为草稿」。
- **三个缺口**（本次要补）：
  1. **无「发表」命令** —— 发布段需自建。
  2. **正文写的是纯文本**（`execCommand('insertText')`），HTML/排版会被当字面文字。
  3. 长正文走命令行位置参数，Windows 下有转义/长度风险。

### 阻塞前提

`opencli doctor` 实测：daemon 正常（19825），但 **`[MISSING] Extension: not connected`**，Chrome 未运行。**Browser Bridge 扩展不在 npm 包里**，须从 [Chrome Web Store](https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk) 安装，或 GitHub Releases 下载 zip 后 `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序。装好且 Chrome 登录 `mp.weixin.qq.com` 后方可用。

## 3. 架构

```
TW 笔记（Markdown，含附件图）
   │ ① 工具栏按钮「发布到公众号」
   ▼
发送给 Agent（复用既有链路：pick 会话 / 新建会话 → POST /agent/send）
   │ ② 消息体 = 发布任务指令 + 笔记正文 + 指向发布 SOP
   ▼
Agent 会话
   │ ③ 读 [[公众号发布流程]] SOP，排版 + 选配图 + 校验
   ▼
执行 opencli（复用 Chrome 登录态，无需二次扫码）
   │ ④ weixin create-draft（或自建富文本版）
   ▼
草稿箱 mp.weixin.qq.com
   │ ⑤ 自建 weixin/publish-draft：找到草稿 → 点「发表」
   ▼
⚠️ 管理员扫码确认（人工，预期内）→ 发布成功 → agent 回报链接
```

### 组件

| # | 组件 | 位置 | 说明 |
|---|---|---|---|
| 1 | 「发布到公众号」按钮 | `scripts/bundle/send-to-agent/button-publish.tid`（新） | toolbar 按钮，`message="dsh-publish-to-wechat"` |
| 2 | 事件处理 | `scripts/bundle/send-to-agent/startup.js` | 新增 `dsh-publish-to-wechat` 监听，构造发布任务消息，复用现有 picker |
| 3 | 发布 SOP | `src/host/seed-wechat-publish.ts`（新 seed，`dsh-docs` 标签） | 排版规范 + opencli 命令 + 扫码处理 + 失败回退；agent 读它执行 |
| 4 | 发布 adapter | `~/.opencli/clis/weixin/publish-draft.js`（用户机） | 草稿箱 → 发表 → 扫码等待 → 验证；**沉淀型资产**，不进本仓库 |
| 5 | 富文本正文（可选） | 自建 `weixin/create-article.js` | 用 `insertHTML` 写微信内联样式 HTML，替代纯文本 |

### 为什么按钮走「唤醒 agent」而不是主机直调 opencli

- 与你既有「发送给 Agent」链路同构，**复用 picker、会话创建、消息注入**全部现成代码。
- agent 能做确定性代码做不了的事：按公众号风格改写、挑配图、检查敏感词、按需调整排版。
- 代价：每次发布消耗一次会话（可接受，发布本就是低频重活）。

## 4. 富文本转换规范（首版即做，已确认）

### 4.0 已实测验证的结论（2026-09-17，链路已跑通）

自建 adapter `~/.opencli/clis/weixin/create-article.js` 已实跑成功，后台 `list_ex` 核对：

| 实现 | 封面 | digest |
|---|---|---|
| 内置 `weixin create-draft` | 无 | `# 一级标题这是一段**加粗**与*斜体*测试。` ← Markdown 原样（纯文本） |
| 自建 `create-article` | `mmbiz.qlogo.cn/...` | `富文本排版验证这是一段带内联样式的正文测试。…` ← **HTML 已解析** |

**三个关键技术事实**（推翻/修正了本节早先的假设）：

1. **正文写入用 `execCommand('insertHTML')`**——编辑器是 **ProseMirror**（非 UEditor iframe），实测内联样式完整保留。
2. **图片上传必须用 DataTransfer 注入，不能用 `page.setFileInput`**——后者依赖 CDP `Page.fileChooserOpened`，本机（CLI 1.8.7 + 扩展 v1.0.24 + Edge）稳定失败（[issue #1582](https://github.com/jackwener/OpenCLI/issues/1582) 佐证版本不匹配问题）。DataTransfer 在页面上下文直接塞 `input.files` 并派发 `change`，实测图片真进 `mmbiz.qpic.cn`。代价：字节以 base64 过 evaluate，**限 8MB**。
3. **所有 weixin 命令必须带 `--trace retain-on-failure`**——否则稳定报 `Navigation rejected`（trace 开 5/5 成功，关 8/8 失败）。

其余踩坑：图片下拉必须**按文案**点「本地上传」（`items[0]` 无效）；正文是最后一个 contenteditable；回读校验须**忽略所有空白**（innerText 会插空白/转 nbsp，否则假阴性）；保存按钮兜底文案**不含「发表」**以防误点。

### 4.1 微信编辑器的硬限制

| 限制 | 后果 | 对策 |
|---|---|---|
| `<style>` 标签被移除 | 外链/内嵌 CSS 全失效 | **所有样式必须内联** `style="..."` |
| `class` 属性被删除 | 类名选择器无用 | 不用 class，只用内联 style |
| 自定义字体不可引入 | `@font-face` 无效 | 只用系统字体（苹方/黑体等） |
| 复杂 `<table>` 样式受限 | 表格排版易崩 | 简单表格；必要时 `div`→`table` 包裹 |
| `<script>` 被剥离 | 不能靠 JS 修饰 | 纯静态 HTML |
| 代码块换行易被吞 | 代码糊成一行 | 预处理 `white-space: pre-wrap` + 处理 nbsp |
| 表格内字体不继承 | 表格字号与正文不一致 | 每个单元格**显式声明** font-size |

### 4.2 已确认可用的内联属性

`font-size` / `color` / `line-height` / `letter-spacing` / `margin` / `padding` / `text-align` / `background-color` / `border-radius` / `box-shadow` / `max-width`。

推荐基准：正文 `font-size:16px; line-height:1.75; letter-spacing:0.5px; margin:0 0 1em`。

### 4.3 参考实现（不要照抄，取规则）

| 项目 | 可借鉴之处 |
|---|---|
| [vigorX777/wechat-article-formatter](https://github.com/vigorX777/wechat-article-formatter) | **CSS 兼容性引擎**（div→table、white-space 预处理、字体显式声明）；图片用 `WECHATIMGPH_N` 占位符 + manifest 映射；保存草稿的 **verdict 校验**（titleOk/contentOk/imageCountOk/saveToastOk/blockingDialog）；保存按钮 fallback **特意不匹配「发表/发布」**避免误点 |
| [iamzifei/wechat-article-formatter-skill](https://github.com/iamzifei/wechat-article-formatter-skill) | 内联 CSS、免外部依赖的极简形态 |
| mdnice / TypeZen | 通用 Markdown→公众号内联样式思路 |

⚠️ vigorX777 项目标注为 **private skill「仅供个人使用」**，故只借鉴其**兼容性规则与校验思路**，不复制代码。

### 4.4 转换流水线

```
Markdown（笔记正文）
  → markdown-it 解析（复用 tiddlywiki/markdown 插件已带的 markdown-it.min.js）
  → 逐元素注入内联样式（主题表驱动）
  → CSS 兼容性后处理（div→table / 代码块 white-space / 表格字体）
  → 图片：本地附件 → 占位符 → 发布时 CDP 逐个替换上传
  → 输出 HTML 片段 → insertHTML 写入编辑器
```

### 4.5 发布 SOP 要点（组件 3 的内容大纲）

1. **标题 ≤64 字**（后台限制）、作者 ≤8 字、摘要 ≤120 字。
2. **封面**：`--cover-image <本地路径>`，adapter 会自动先传正文再「从正文选择」设为封面。建议 2.35:1。
4. **图片**：本机路径传入，由 CDP 真上传到微信 CDN；外链图会被过滤。
5. **命令**：
   ```bash
   opencli weixin create-draft "<正文>" --title "..." --author "..." --cover-image "..." --summary "..." -f json
   opencli weixin drafts -f json      # 确认草稿已建
   ```
6. **富文本正文**：内置 `create-draft` 只写纯文本；富文本走自建 adapter 的 `insertHTML`，或先复制 HTML 到剪贴板再粘贴。
7. **发表**：调自建 `weixin publish-draft`；检测到扫码页时**暂停并提示用户扫码**，轮询结果。
8. **成功校验（fail-closed）**：不得只看「没报错」就宣告成功——须回读校验标题已持久化、正文非空、图片数量正确、无阻塞弹窗、检测到保存/发表成功信号。参考 vigorX777 的 verdict 清单。
9. **失败回退**：若发表失败或账号受限，草稿仍在草稿箱 → 提示用户手动进入后台点发表（不丢工作成果）。

## 5. 风险与边界

| 风险 | 应对 |
|---|---|
| **发表需扫码**（不可避免） | 设计为「预期内的人工确认点」，不是失败；用 `--keep-tab`/`manual` 模式把标签页留下 |
| 后台 DOM 改版 | adapter 用多选择器降级 + typed error；失败落 trace + 截图 |
| 风控/封号 | 不做规避检测的行为伪装；低频使用；默认走「发表」而非「群发」；不碰验证码 |
| 每日额度 | 默认「发表」不占群发额度；群发需显式确认 |
| 扩展未装 | 前置自检：`opencli doctor` 不通则明确提示装扩展，不静默失败 |
| 长文本命令行传参 | 改为读文件传正文（避免 Windows 转义/长度限制） |
| 账号隐私 | 凭据是浏览器 cookie，**不落盘、不进 git**；不引入 AppSecret |

## 6. 实施步骤

1. **前置打通**（用户手动，一次性）：装 Browser Bridge 扩展 → 启动 Chrome → 登录 `mp.weixin.qq.com` → `opencli doctor` 全绿。
2. **验证内置能力**：用一篇测试笔记跑 `weixin create-draft`，确认草稿真的进了草稿箱。
3. **自建发表 adapter**：`~/.opencli/clis/weixin/publish-draft.js`，用 `opencli browser verify` 验证。
4. **写 SOP seed**：`seed-wechat-publish.ts` + 注册进 `SEED_DEFS`（可选层）。
5. **加按钮**：bundle 加 `button-publish.tid` + startup 事件，bump `SEND_TO_AGENT_BUNDLE_VERSION`（0.3.5 → 0.4.0），走 §4 流水线（build → gen → verify）。
6. **端到端**：TW 笔记 → 按钮 → agent → 草稿箱 → 扫码发表。
7. **收尾**：README/AGENTS.md 同步；bump 版本；wiki 记录。

## 7. 尚待确认

- **发表（点「发表」→ 管理员扫码）尚未实跑**。adapter 里 `--publish` 分支已写好（含扫码轮询、超时、成功检测），但会在你的公众号上真发一篇文章，需你确认后再验。
- 组件 5（富文本正文 adapter）**已完成并验证**（`create-article.js`）。
- 组件 3（SOP seed）、组件 1/2（按钮 + 事件）尚未开工。
- 是否需要「群发」支持，还是只做「发表」。
- SOP 放 wiki seed（随插件走）已定；是否另外生成 DSH 本地 skill。
- 测试期间在草稿箱留下 4 条测试草稿（`DSH链路测试`/`DSH富文本测试`/`DSH富文本adapter测试`/`DSH图文封面测试v2`），需要清理。

## 8. 参考

- [发布能力（2025-07 权限回收）](https://developers.weixin.qq.com/doc/subscription/guide/product/publish.html)
- [新增草稿 draft/add](https://developers.weixin.qq.com/doc/subscription/api/draftbox/draftmanage/api_draft_add.html)
- [服务端 API 调用说明（IP 白名单）](https://developers.weixin.qq.com/doc/subscription/guide/dev/api/)
- [135编辑器：草稿箱发表流程（含扫码）](https://www.135editor.com/books/chapter/1/797.html)
- [opencli](https://github.com/jackwener/opencli)

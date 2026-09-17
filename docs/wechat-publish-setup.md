# 微信公众号发布：换机器还原指南

> **这是可选功能，默认关闭，需要额外安装。** 插件本体**不含**它：真正干活的是仓库
> `tools/wechat/` 下的 opencli adapter + Browser Bridge 浏览器扩展。**不安装／不开启，
> 插件的其他功能完全不受影响**（不注入发布相关提示词、不往 wiki 写发布规范文档）。
>
> 目的：在**另一台机器**上无缝还原「TiddlyWiki 笔记 → 微信公众号」的发布能力。
> 本机（开发机）已验证全程可跑；本文按顺序照做即可复现。
>
> 关键结论先讲：**整套发布走浏览器自动化，不依赖公众号服务端 API**——因为
> 2025-07 起官方已回收个人主体账号的「发布能力」接口权限（详见 §5）。

---

## 0. 它是可选功能：需要什么、不影响什么

| | 说明 |
|---|---|
| **默认状态** | **关闭**（`wechat.enabled` 默认 `false`） |
| **开启方式** | DSH 设置 →「TiddlyWiki 知识库」→「可选功能：微信公众号发布」→ 勾选 → 保存配置 |
| **开启后有什么变化** | ① 注入提示词多一行「发布前先读发布元数据规范」；② 启动时把该规范文档写进 wiki（同名不覆盖）。**仅此两项**——不会安装任何东西、不会启用任何后台服务 |
| **不开启会怎样** | 提示词里没有发布相关文字；wiki 里不会出现「发布元数据规范」；其他功能一切照旧 |
| **插件会替你做安装吗** | **不会**。opencli 与浏览器扩展必须你手动装（见 §1–§2）——这属于插件外部的工具链 |
| **要额外装什么** | ① opencli（npm 包）② Browser Bridge 浏览器扩展 ③ 浏览器登录公众号 |
| **凭据如何保存** | 不保存任何凭据：复用浏览器已有登录态（cookie）。脚本不接触 AppSecret |

> 一句话：**开关只控制「插件要不要配合这个流程」，不负责装工具链。**

---

## 1. 一分钟总览

```
TiddlyWiki 笔记（tiddler）
   │  标题
   ▼
DSH 的 POST /dsh-tiddlywiki/render        ← TW 自己渲染成语义 HTML（含代码高亮）
   │  纯语义 HTML（无内联样式）
   ▼
wechat-html.js  decorate()                ← 补内联样式（微信唯一认的形式）
   │  带内联样式的 HTML
   ▼
opencli + Browser Bridge 扩展             ← 驱动你已登录的浏览器
   │  填标题/作者/摘要 + insertHTML 写正文 + 传图 + 设封面 + 存草稿
   ▼
公众号草稿箱（mp.weixin.qq.com）
   │  （可选 --publish）
   ▼
点「发表」→ ⚠️ 管理员扫码确认 → 发布成功
```

**一条命令**（在第二台机器上，装好后）：

```bash
opencli weixin publish-note "笔记标题" --trace retain-on-failure -f json
```

---

## 1. 需要安装/准备的东西

按顺序做；**最后一步才是打开插件里的开关**（开关只影响提示词与文档，装不上工具链）。

| # | 项目 | 怎么装 | 验证 |
|---|---|---|---|
| 1 | **Node.js ≥ 22** | 官网安装包 | `node -v` |
| 2 | **DSH** + **dsh-tiddlywiki 插件** | 本仓库的插件（含 wiki） | `curl http://127.0.0.1:3080/dsh-tiddlywiki/status` |
| 3 | **opencli** | `npm install -g @jackwener/opencli` | `opencli --version` |
| 4 | **Browser Bridge 扩展** | 见 §2（二选一） | `opencli doctor` 显示 `Extension: connected` |
| 5 | **Chrome/Edge + 公众号登录** | 浏览器登录 mp.weixin.qq.com | 能进后台首页 |
| 6 | **本仓库的 adapter** | `node tools/wechat/install-wechat-adapters.mjs` | 脚本自检输出 ✔ |
| 7 | **打开插件开关** | 设置 →「TiddlyWiki 知识库」→「可选功能：微信公众号发布」勾选 → 保存配置 | 提示词预览里出现「发布元数据规范」一行 |

> **opencli 版本建议 ≥ 1.8.7**（本方案在该版本实测通过；1.7.x 的 `browser`
> 子命令语法不同，且内置 weixin adapter 不完整）。
>
> 第 7 步之前，插件不会注入任何发布相关提示词、也不会往 wiki 写「发布元数据规范」。
> 也就是说：**没装好工具链时开关可以一直关着，不影响任何其他功能。**

---

## 2. 安装 Browser Bridge 扩展（关键前置）

扩展**不在 npm 包里**，必须单独装。二选一：

**方式 A — Chrome Web Store（推荐）**
1. 打开 https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk
2. 点「添加至 Chrome」

**方式 B — GitHub Releases（Web Store 打不开时）**
1. 到 https://github.com/jackwener/opencli/releases 下载 `opencli-extension-v*.zip`
2. 解压到某个固定目录
3. 浏览器打开 `chrome://extensions` → 开启右上角「开发者模式」
4. 点「加载已解压的扩展程序」→ 选择解压出的目录

**验证**：

```bash
opencli doctor
# 期望： [OK] Daemon: running ...
#        [OK] Extension: connected (vX.Y.Z)
#        [OK] Connectivity: connected
#        Everything looks good!
```

若报 `Extension: not connected`：确认浏览器在运行、扩展已启用；再 `opencli daemon stop` 后重跑 `opencli doctor`（daemon 会自动重启）。

---

## 3. 装 adapter 并试跑

```bash
cd <本仓库>
node tools/wechat/install-wechat-adapters.mjs
```

脚本会把 `tools/wechat/*.js` 复制到 `~/.opencli/clis/weixin/`（Windows：`C:\Users\<你>\.opencli\clis\weixin\`）。
这些是**私有 adapter**，放在该目录即可被 opencli 自动发现，**无需任何构建**。

然后：

```bash
# ① 先干跑：只做 TW 渲染 + 排版装饰，导出预览，不碰微信
opencli weixin publish-note "某篇笔记标题" --preview ./out --trace retain-on-failure

#    → 用浏览器打开 ./out.html 肉眼确认排版
#    （注意：--preview 仍会继续执行发布流程；只想预览时看文件即可，或 Ctrl-C）

# ② 真发到草稿箱
opencli weixin publish-note "某篇笔记标题" --trace retain-on-failure -f json

# ③ 带封面（公众号封面必填，否则草稿显示"内容不完整"）
opencli weixin publish-note "某篇笔记标题" --cover ./cover.png --trace retain-on-failure -f json

# ④ 直接发表（⚠️ 会真发文章，需管理员扫码）
opencli weixin publish-note "某篇笔记标题" --publish --trace retain-on-failure -f json
```

---

## 3.5 发布元数据（重要：避免重发/误发）

wiki 里既有**早已发布**的文章，也有**明确不能发**的内容。没有记录，agent 只能猜——
要么重复发已上线的，要么把不该发的推出去。

**规范全文在 wiki 里**：笔记「**发布元数据规范**」（随插件 seed 分发，`dsh-docs` 标签，
开机自动写入；也可手动跑 `npx tsx tools/wechat/seed-publish-spec-now.mts` 立即写入）。
注入给 agent 的系统提示词里只有一句指针（slim 预算只剩几十字符，放不下全文）。

### 字段（自定义字段，不是标签）

| 字段 | 含义 | 示例 |
|---|---|---|
| `pub-state` | 能不能发 | `draft` / `published` / `excluded` |
| `pub-platform` | 最近发布的平台（多平台逗号分隔） | `wechat` |
| `pub-wechat-at` | 公众号发表时间 | `2026-09-17 15:30` |
| `pub-wechat-title` | 发表时的标题（**仅当与 TW 标题不同才写**） | `中年失业自救指南` |
| `pub-wechat-url` | 发表后的链接 | `https://mp.weixin.qq.com/s/xxx` |
| `pub-note` | 备注 | `删改后重发过一版` |

**没有 `pub-state` = 未知状态**，应当当作「需要人确认」，而不是「可以随便发」。

标签 `no-publish` 是给人看的镜像（TW 界面一眼可见、可筛）；`pub-state: excluded` 给
agent 程序化判断。**两者应一致，冲突时以字段为准。**

### ⚠️ 命名冲突（别占用）

实测本 wiki 里这三个名字**已被占用**，方案特意避开：

- `publish` / `publishyear` 字段 → Obsidian 导入的**书籍**条目用作「出版社 / 出版年」
  （值形如「新世界出版社」「2011-09-01」）。
- `发布记录` 标签 → 本插件自己的**版本发布说明**。

### 发布前检查：只告警，不阻断

`publish-note` 会读 `pub-state` / `no-publish`，命中就打印醒目警告，**然后继续执行**
（2026-09-17 明确选定的策略）。`--force` 只改措辞，不改变行为：

```
⚠️ 「某篇」已发布过（平台 wechat）。这可能是重复发布——确认无误再继续；确实要重发请加 --force。
```

### 回写（agent 负责）

发布成功后，命令的 `detail` 里会带一句**建议回写值**，例如：

```
建议回写：pub-state=published, pub-platform=wechat, pub-wechat-at="2026-09-17 17:50"
```

agent 据此用 `tiddlywiki_put` 写回（**不传 `tags` 就保留原标签**，只补 `fields`）：

```
tiddlywiki_put(title="某篇", text=<原正文>, fields={"pub-state":"published", "pub-platform":"wechat", "pub-wechat-at":"..."})
```

> ⚠️ 用工具时 `text` 会被覆盖，**务必带上原正文**。别像我一样用裸 REST PUT 只发一段
> 文字——那会把笔记正文清空（真实踩过，靠 git 恢复）。

### 存量回填

早于本规范、来源可辨（`source-path` 含「公众号」）的文章，用脚本回填：

```bash
# 默认 dry-run，只打印将改什么
node tools/wechat/backfill-publish-state.mjs

# 确认后真写
node tools/wechat/backfill-publish-state.mjs --write

# 指定标题 / 平台 / 匹配子串
node tools/wechat/backfill-publish-state.mjs --title "打工记" --title "鱼" --write
node tools/wechat/backfill-publish-state.mjs --match 公众号 --platform wechat --write
```

脚本纪律（**请勿改成「只写字段」的裸 PUT**）：每条都先 GET **完整** tiddler（含
text/tags/type/created），**只添加** `pub-*` 字段后整体写回；已有 `pub-state` 的跳过
（幂等）；正文为空的跳过（宁可不动）；**发表时间无法考证就留空，不编造**。

---

## 4. ⚠️ 三个必须知道的坑

### 4.1 所有命令都要带 `--trace retain-on-failure`

不带会对 `mp.weixin.qq.com` 稳定报：

```
Navigation rejected
```

**实测**：trace 开 → 5/5 成功；trace 关 → 8/8 失败。这是 opencli 1.8.7 的 bug
（源码里 trace 只做录像，理论上不该影响导航）。已试过无效的绕法：
`--site-session ephemeral`、`--keep-tab false`、`--window foreground/background`、
重置标签页、重启 daemon。**唯一有效就是加 trace。**

### 4.2 发表必须管理员扫码（无法自动化）

后台点「发表」后，微信要求**管理员微信扫码确认**。这不是技术能绕开的账号安全机制。
所以「一键发布」的真实含义是：

> agent/脚本 完成素材、排版、上传、填表、进草稿箱 —— **你只需扫一次码**。

`--publish` 会自动点「发表」并在终端提示你扫码，然后轮询结果（默认等 180s，
可用 `--timeout` 调整）。

### 4.3 「发表」≠「群发」（别搞混）

| 操作 | 推送粉丝 | 占群发额度 | 需要扫码 |
|---|---|---|---|
| **发表**（本方案默认） | 否（仅生成永久链接） | 否，不限次数 | 是 |
| **群发** | 是 | 个人订阅号 1 天 1 次 | 是 |

两者都要扫码 → 默认选**不吃额度**的「发表」。

---

## 5. 为什么不用官方 API（背景，避免走回头路）

公众号发布的服务端链路是 `access_token → draft/add → freepublish/submit`。但：

- **2025 年 7 月起，官方回收「发布能力」接口对个人主体、企业未认证、不支持认证账号的调用权限**
  （[发布能力文档](https://developers.weixin.qq.com/doc/subscription/guide/product/publish.html) 原文注）。
  个人主体无法做微信认证 → `freepublish/submit` 不可用。
- 草稿箱 `draft/add` 文档未列该限制，但 48001 / `api unauthorized` 是常见返回。
- 即便可用，还叠加：**本机公网出口 IP 必须加入 API IP 白名单**（否则 61004/40164）、
  封面 `thumb_media_id` 必须是**永久素材**、正文图片必须是 `media/uploadimg` 产出的
  mmbiz 地址（外链图被过滤）。

**而后台网页端从未受影响**——这是所有个人号日常发文的方式。所以本方案驱动网页端。

---

## 6. 文件清单（本方案包含什么）

```
tools/wechat/
├── wechat-html.js      # 排版装饰器：语义 HTML → 内联样式 HTML（主题表在这里改）
├── weixin-flow.js      # 浏览器流程：登录检测/填表/写正文/传图/设封面/存草稿/发表
├── create-article.js   # 命令：从本地 HTML 文件建草稿（可选发表）
├── publish-note.js     # 命令：从 TW 笔记建草稿（主入口，含 --preview）
└── install-wechat-adapters.mjs  # 一键安装到 ~/.opencli/clis/weixin/
```

装到本机后对应 `~/.opencli/clis/weixin/` 下的同名文件。
改排版只需改 `tools/wechat/wechat-html.js` 里的 `ELEMENT_STYLES`，重跑安装脚本即可。

---

## 7. 技术实现要点（改代码前必读）

### 7.1 正文写入必须用 `insertHTML`，不能用 `insertText`

微信编辑器是 **ProseMirror**。`document.execCommand('insertHTML', …)` 保留内联样式；
`insertText` 会把 HTML/Markdown 当**字面文本**（opencli 内置的 `weixin create-draft`
就是这样——实测后台 digest 里 `# 一级标题` 和 `**加粗**` 的符号原样保留）。

### 7.2 图片上传必须用 DataTransfer，不能用 `page.setFileInput`

`page.setFileInput` 依赖 CDP 的 `Page.fileChooserOpened` 事件，本机（opencli 1.8.7 +
扩展 v1.0.24 + Edge）**稳定失败**：

```
Page.fileChooserOpened not received within 5s
```

（[issue #1582](https://github.com/jackwener/OpenCLI/issues/1582) 显示扩展/CLI 版本不匹配确有历史问题。）

**绕过办法**——在页面上下文用 DataTransfer 直接把 File 塞进 `input.files`：

```js
const bin = atob(base64)
const arr = new Uint8Array(bin.length)
for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
const file = new File([arr], 'cover.png', { type: 'image/png' })
const dt = new DataTransfer()
dt.items.add(file)
input.files = dt.files
input.dispatchEvent(new Event('change', { bubbles: true }))
```

实测图片真的上了 `mmbiz.qpic.cn`。**代价：字节要以 base64 穿过 evaluate → 单图限 8MB。**

### 7.3 微信编辑器会剥 `<style>` 和 class，只认内联 `style`

实测：注入 `<style>h1{color:red}</style>` → `hasStyleTag: false`；
注入 `style="font-size:20px"` → 原样保留。
而 **TiddlyWiki 的 `/render` 输出零内联样式**（纯语义 HTML + class）——
这正是需要 `wechat-html.js` 装饰器的原因。

### 7.4 轮询里绝不能读 `document.body.innerText`（v0.23.0 实测踩坑）

微信编辑器 DOM 极大，读一次 `body.innerText` **强制整页 layout，实测单次 evaluate
≈17 秒**。早期 `saveDraft` / `publishDraft` 的轮询用它找成功提示，8 次轮询把整个命令
拖过 210s 超时——**最坑的是草稿其实已经保存成功**，用户看到的是超时失败（假阴性）。

现在只查少量 toast 节点（`.weui-desktop-toast` / `.weui-desktop-msg` / `#js_save_success`）
和 URL，都是 O(1) 操作。修复后 `saveDraft` 从 **137 秒降到 3.9 秒**。

`scripts/verify-wechat-adapters.mjs` 有回归守门（已反向验证：塞回去即红）。

### 7.5 其他踩过的坑

- 图片下拉必须**按文案**点「本地上传」：用 `items[0]` 点完 file input 仍不可见。
- 正文是编辑器页**最后一个** `contenteditable`。
- 回读校验必须**忽略所有空白**：编辑器 innerText 会在块级元素间插空白、把空格转 nbsp，
  直接用原始字符串比对必假阴性。
- 保存按钮的文案兜底**特意不含「发表/发布」**，防止误点发布。
- 草稿列表显示「图文内容不完整」**只表示缺封面**，不代表写入失败。
- `<pre>` 内的 `<code>` 不能套用行内代码样式（粉底 + 内边距会很难看），
  `wechat-html.js` 里用 `preDepth` 特判。

---

## 8. 排错

| 现象 | 原因 / 处理 |
|---|---|
| `Navigation rejected` | 忘了 `--trace retain-on-failure` |
| `AUTH_REQUIRED` / 提示登录 | 浏览器里 `mp.weixin.qq.com` 登录态过期 → 重新扫码登录 |
| `Extension: not connected` | 扩展没装/没启用，或浏览器没运行 → 见 §2 |
| `Page.fileChooserOpened not received` | 不应再出现（已改用 DataTransfer）；若出现说明源码被改回 setFileInput |
| 找不到笔记 | tiddler 标题要**完全精确**（含空格/标点）；`opencli weixin publish-note "标题"` |
| `/render 返回 HTTP 404` | 标题不存在；先用 `tiddlywiki_search` 或 TW 面板确认 |
| 无法连接 DSH | `--dsn` 默认 `http://127.0.0.1:3080/dsh-tiddlywiki`；DSH 没跑或端口不同就改它 |
| 草稿显示「内容不完整」 | 缺封面 → 传 `--cover` |
| 图片没上传 | 单图 > 8MB（DataTransfer 限制）→ 先压缩 |
| 发表卡住超时 | 没扫码，或扫码没完成 → 调大 `--timeout`，或到后台手动点发表 |

---

## 9. 安全与隐私

- **不存任何公众号凭据**：全程复用浏览器已有登录态（cookie），脚本不接触 AppSecret。
- **不落盘密钥**：adapter 只读本地图片路径，不写任何 token。
- **低频使用**：不做规避风控的行为伪装；默认走「发表」（不推送粉丝、不占额度）。
- wiki 里的配置 tiddler 与本方案无关——本方案零配置。

---

## 10. 参考

- [opencli](https://github.com/jackwener/opencli) — 把网站变成 CLI，复用浏览器登录态
- [微信「发布能力」文档（2025-07 权限回收）](https://developers.weixin.qq.com/doc/subscription/guide/product/publish.html)
- [微信「新增草稿」draft/add](https://developers.weixin.qq.com/doc/subscription/api/draftbox/draftmanage/api_draft_add.html)
- [微信服务端 API 调用说明（IP 白名单）](https://developers.weixin.qq.com/doc/subscription/guide/dev/api/)
- 设计文档：`docs/plans/2026-09-17-wechat-publish-design.md`

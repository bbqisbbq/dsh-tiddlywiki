# 微信公众号发布：换机器还原指南

> 目的：在**另一台机器**上无缝还原「TiddlyWiki 笔记 → 微信公众号」的发布能力。
> 本机（开发机）已验证全程可跑；本文按顺序照做即可复现。
>
> 关键结论先讲：**整套发布走浏览器自动化，不依赖公众号服务端 API**——因为
> 2025-07 起官方已回收个人主体账号的「发布能力」接口权限（详见 §5）。

---

## 0. 一分钟总览

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

| # | 项目 | 怎么装 | 验证 |
|---|---|---|---|
| 1 | **Node.js ≥ 22** | 官网安装包 | `node -v` |
| 2 | **DSH** + **dsh-tiddlywiki 插件** | 本仓库的插件（含 wiki） | `curl http://127.0.0.1:3080/dsh-tiddlywiki/status` |
| 3 | **opencli** | `npm install -g @jackwener/opencli` | `opencli --version` |
| 4 | **Browser Bridge 扩展** | 见 §2（二选一） | `opencli doctor` 显示 `Extension: connected` |
| 5 | **Chrome/Edge + 公众号登录** | 浏览器登录 mp.weixin.qq.com | 能进后台首页 |
| 6 | **本仓库的 adapter** | `node tools/wechat/install-wechat-adapters.mjs` | 脚本自检输出 ✔ |

> **opencli 版本建议 ≥ 1.8.7**（本方案在该版本实测通过；1.7.x 的 `browser`
> 子命令语法不同，且内置 weixin adapter 不完整）。

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

### 7.4 其他踩过的坑

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

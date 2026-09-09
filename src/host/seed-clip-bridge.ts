/**
 * Optional seed: 「本地剪藏桥（书签小工具）」使用说明 tiddler (hand-maintained
 * doc constant, like seed-notes / seed-starter-docs — no generator script).
 *
 * The feature itself lives in src/host/clip-bridge.ts (loopback HTTP bridge
 * inside the DSH host process, config group `bridge.*`). This seed only ships
 * the user-facing instruction tiddler: what it is, how to enable it, the
 * bookmarklet JS to paste into the browser's bookmarks bar, security notes and
 * troubleshooting. Marked `dsh-docs` so the seeded home「📚 插件文档」tabs strip
 * picks it up automatically (v0.16.22 convention).
 *
 * ONE-SHOT + marker semantics identical to seed-notes: write only when the
 * marker is missing (non-force), force re-writes, remove deletes doc + marker.
 *
 * @module dsh-tiddlywiki/host/seed-clip-bridge
 */
import type { TiddlyWebClient } from './tw-api.ts'

/** The instruction tiddler's title (a normal, searchable note). */
export const CLIP_BRIDGE_DOC_TITLE = '本地剪藏桥（书签小工具）'

/** One-time marker: presence = "the doc was offered once — hands off". */
export const CLIP_BRIDGE_MARKER_TITLE = '$:/plugins/dsh-tiddlywiki/seed-clip-bridge'

/**
 * The instruction body, Markdown. The bookmarklet below mirrors the bridge's
 * defaults (port 8618, empty token) — users copy it and adjust the two
 * placeholders when they changed `bridge.port` / `bridge.token`.
 */
export const CLIP_BRIDGE_DOC_TEXT = `# 本地剪藏桥（书签小工具）

把任意网页**一键剪藏进 TiddlyWiki**：浏览器里点一下书签，当前页面的**标题 / URL / 选中文字**就会写入本插件的知识库，成为一篇普通笔记（默认打 \`clip\` 标签，随 wiki 自动 git commit），之后随时可在 TW 里整理、让 Agent 检索。

## 原理

DSH 进程里运行着一个只监听 **127.0.0.1**（本机回环）的 HTTP 小桥——端口默认 \`8618\`，可在设置页改。书签里的 JS 小工具把页面信息 POST 给它，小桥校验通过后经插件唯一的写入通道写进 TiddlyWiki（数据走同一套 REST 客户端，无第二条写入路径）。

## 启用（三步）

1. **开启**：DSH 设置 →「TiddlyWiki 知识库」→ 常规配置 → 勾选 **「启用本地剪藏桥」** → 保存。**立即生效，无需重启 dsh web**（未勾选时桥不会放行任何写入）。
2. **（可选）设置 token**：强烈建议在同一处填一个 **\`bridge.token\`** 共享口令——非空后，书签请求必须带上 \`x-clip-token\` 头才能写入，防止你在浏览器里访问的任意网页偷偷往 wiki 里塞内容。**改端口（\`bridge.port\`）则需要重启 dsh web 生效**。
3. **装书签**：浏览器书签栏新建书签，名称随意（如「剪藏」），**地址（URL）粘贴下面整段代码**。若设置了 token，把代码里 \`'x-clip-token': ''\` 的空字符串换成你的口令；若改了端口，把 \`127.0.0.1:8618\` 一起改掉：

\`\`\`javascript
javascript:(()=>{var t=(document.title||location.hostname).trim();var s=(window.getSelection()?window.getSelection().toString():'').trim();fetch('http://127.0.0.1:8618/clip',{method:'POST',headers:{'content-type':'application/json','x-clip-token':''},body:JSON.stringify({title:t,url:location.href,text:s})}).then(function(r){return r.json().then(function(j){if(r.ok){alert('已剪藏：'+j.title)}else{alert('剪藏失败：'+(j.error||('HTTP '+r.status)))}})}).catch(function(e){alert('剪藏桥不可达：'+(e&&e.message?e.message:e)+'。请确认：① dsh web 在运行；② 设置页已启用「本地剪藏桥」；③ 书签里的端口与设置一致；④ 设置了 token 的话书签已带上。')});})();
\`\`\`

> 部分浏览器禁止页面「拖链接到书签栏」，复制粘贴到书签的地址栏是最稳的方式。

## 使用

打开任意网页 → 选中想保留的文字（可选）→ 点书签 → 弹窗提示「已剪藏：〈标题〉」。笔记以**页面标题**命名（重名自动追加 \`（2）\`、\`（3）\`…，绝不覆盖已有笔记），正文包含来源链接与选中文字，可用「发送给 Agent」一键丢给会话整理。

## 安全说明

- 桥**只监听 127.0.0.1**，并校验请求的 \`Host\` 头（只放行 127.0.0.1 / localhost / ::1）——恶意网页即使把自己的域名解析到本机回环（DNS rebinding）也调不动它。
- **强烈建议设置 \`bridge.token\`**：不设 token 时，你在浏览器里访问的**任何网页**都能向本机桥提交内容（它们读不到回应，但能往 wiki 里写——只是污染笔记，不是执行代码）。token 只有你知道，网页拿不到。
- 剪藏只写入文本：title / url / 选中文字，不做任何代码执行。

## 配置项

| 项 | 默认 | 说明 |
|---|---|---|
| \`bridge.enabled\` | \`false\` | 是否启用剪藏桥（设置页保存后立即生效） |
| \`bridge.port\` | \`8618\` | 监听端口（改动需**重启 dsh web** 生效） |
| \`bridge.token\` | 空 | 共享口令；非空时校验 \`x-clip-token\` 请求头 |
| \`bridge.tag\` | \`clip\` | 剪藏笔记默认 tag |

## 命令行/脚本方式（可选）

不想用书签时，直接 POST 也行（适合脚本、API 调用）：

\`\`\`bash
curl -X POST http://127.0.0.1:8618/clip ^
  -H "content-type: application/json" ^
  -H "x-clip-token: 你的token（没设置就删掉这行）" ^
  -d "{\\"title\\":\\"测试\\",\\"url\\":\\"https://example.com\\",\\"text\\":\\"测试选中文字\\"}"
\`\`\`

成功返回 \`{"ok":true,"title":"测试",...}\`；未启用时返回 503。

## 常见问题

- 点书签提示「剪藏桥不可达」：① dsh web 没在运行；② 设置页没勾选启用；③ 书签里的端口和设置不一致；④ 设置了 token 但书签没带上。
- 端口被占用：换一个 \`bridge.port\` 后**重启 dsh web**。
- 想彻底关掉：设置页取消勾选保存即可（端口虽在监听但拒绝任何写入），或直接改插件行 config 的 \`bridge.enabled: false\`。
`

/**
 * Seed the instruction tiddler once per wiki (mirrors seed-notes one-shot
 * policy: marker = offered; from then on the doc is user-owned and never
 * re-created). force re-writes doc + marker (settings page「重新初始化」).
 * Never throws.
 */
export async function seedClipBridge(client: TiddlyWebClient, opts?: { force?: boolean }): Promise<boolean> {
  const force = opts?.force === true
  if (!force) {
    const marker = await client.get(CLIP_BRIDGE_MARKER_TITLE).catch(() => undefined)
    if (marker !== undefined) return false
  }
  const existing = await client.get(CLIP_BRIDGE_DOC_TITLE).catch(() => undefined)
  let wrote = false
  if (force || existing === undefined) {
    await client.put({
      title: CLIP_BRIDGE_DOC_TITLE,
      text: CLIP_BRIDGE_DOC_TEXT,
      type: 'text/markdown',
      tags: ['docs', 'dsh-docs'],
    })
    wrote = true
  }
  await client
    .put({ title: CLIP_BRIDGE_MARKER_TITLE, text: 'seeded-once', type: 'text/plain', tags: [] })
    .catch(() => undefined)
  return wrote
}

/** 反初始化: remove the doc tiddler + its one-shot marker (idempotent). */
export async function unseedClipBridge(client: TiddlyWebClient): Promise<{ removed: string[] }> {
  const removed: string[] = []
  for (const title of [CLIP_BRIDGE_DOC_TITLE, CLIP_BRIDGE_MARKER_TITLE]) {
    const t = await client.get(title).catch(() => undefined)
    if (t !== undefined) {
      await client.delete(title)
      removed.push(title)
    }
  }
  return { removed }
}
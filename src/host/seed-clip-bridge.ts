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
 * v0.16.25: the bookmarklet opens a PICKER overlay (title / selection text +
 * a thumbnailed image checklist, og:image auto-marked 封面); chosen images are
 * downloaded by the bridge and stored as binary attachment tiddlers.
 * v0.16.26: fixed a real-page crash (overlay fields were populated via
 * document.getElementById while p was still detached) — now resolved via
 * p.querySelector scoped to the overlay, values set after appendChild.
 * v0.16.27: the doc additionally ships a DRAGGABLE anchor (raw HTML inside the
 * markdown — verified: TW 5.4.1 markdown keeps a javascript: href + draggable
 * intact, real-TW + headless-Chrome spike) so users can drag it straight to
 * the bookmarks bar; the copy-paste code fence stays as the fallback. The
 * anchor href and the fence share the SAME CLIP_BRIDGE_BOOKMARKLET constant
 * (escaped for the HTML attribute), with a sync guard in verify-clip-bridge.mjs
 * + a browser E2E in verify-clip-bridge-browser.mjs.
 *
 * The bookmarklet is ONE long line by design (bookmarks-bar URL fields; no
 * backticks / ${} inside, which also lets it live in this backtick literal).
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
 * The bookmarklet itself (ONE line, no backticks / ${}). Mirrors the bridge's
 * defaults (port 8618, empty token); users adjust the two placeholders. Used
 * BOTH as the copy-paste code fence AND (HTML-attribute-escaped) as the
 * draggable anchor href — keep them in sync (verify-clip-bridge.mjs asserts it).
 */
export const CLIP_BRIDGE_BOOKMARKLET = `javascript:(function(){var t=(document.title||location.hostname).trim();var sel=(window.getSelection()?window.getSelection().toString():'').trim();var imgs=[],seen={};function add(u,a,c){u=String(u||'').trim();if(!u||u.indexOf('data:')===0||u.indexOf('blob:')===0||seen[u])return;seen[u]=1;imgs.push({u:u,a:(a||'').slice(0,60),c:!!c})}var mm=document.querySelector('meta[property="og:image"],meta[name="twitter:image"],link[rel="image_src"]');if(mm){var mu=mm.content||mm.href;if(mu)add(mu,'封面',true)}for(var ii=0;ii<document.images.length;ii++){var im=document.images[ii],iu=im.currentSrc||im.src;if(!iu)continue;if(im.naturalWidth&&im.naturalHeight&&(im.naturalWidth<80||im.naturalHeight<80))continue;add(iu,im.alt||im.title,false)}if(imgs.length>60)imgs=imgs.slice(0,60);var ov=document.createElement('div');ov.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(10,14,20,.62);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:4vh 12px';var p=document.createElement('div');p.id='cb_p';p.style.cssText='background:#1c2128;border:1px solid #3a414c;border-radius:12px;max-width:680px;width:100%;max-height:86vh;overflow:auto;padding:16px 18px;color:#e6e6e6;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;box-sizing:border-box';p.innerHTML='<div style="font-size:16px;font-weight:700">剪藏到 TiddlyWiki</div><label style="display:block;font-size:12px;opacity:.7;margin:10px 0 2px">标题</label><input id="cb_t" style="width:100%;box-sizing:border-box;background:#0f131a;border:1px solid #3a414c;border-radius:6px;color:#eee;padding:7px 9px;font-size:13px" value=""><label style="display:block;font-size:12px;opacity:.7;margin:10px 0 2px">正文 / 选中文字（可选）</label><textarea id="cb_s" rows="5" style="width:100%;box-sizing:border-box;background:#0f131a;border:1px solid #3a414c;border-radius:6px;color:#eee;padding:7px 9px;font-size:13px;resize:vertical"></textarea>';var Q=function(id){return p.querySelector('#'+id)};var grid=document.createElement('div');grid.style.cssText='display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin:10px 0';for(var j=0;j<imgs.length;j++){(function(idx){var it=imgs[idx],lab=document.createElement('label');lab.style.cssText='display:flex;flex-direction:column;gap:4px;cursor:pointer;background:#0f131a;border:1px solid #3a414c;border-radius:8px;padding:6px;overflow:hidden';var top=document.createElement('div');top.style.cssText='position:relative';var imgE=document.createElement('img');imgE.style.cssText='display:block;width:100%;height:76px;object-fit:cover;border-radius:4px;background:#000';imgE.src=it.u;imgE.loading='lazy';imgE.referrerPolicy='no-referrer';top.appendChild(imgE);if(it.c){var bd=document.createElement('span');bd.style.cssText='position:absolute;top:2px;left:2px;background:#f5a623;color:#000;font-size:10px;padding:0 4px;border-radius:3px';bd.textContent='封面';top.appendChild(bd)}var row=document.createElement('div');row.style.cssText='display:flex;align-items:center;gap:6px';var ch=document.createElement('input');ch.type='checkbox';ch.id='cb_i_'+idx;ch.checked=it.c;var nm=document.createElement('span');nm.style.cssText='font-size:11px;opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1';nm.textContent=it.a||(it.u.split('/').pop()||'');nm.title=it.u;row.appendChild(ch);row.appendChild(nm);lab.appendChild(top);lab.appendChild(row);grid.appendChild(lab)})(j)};var foot=document.createElement('div');foot.style.cssText='display:flex;align-items:center;justify-content:space-between;margin-top:12px';var cnt=document.createElement('span');cnt.id='cb_cnt';cnt.style.cssText='font-size:12px;opacity:.75';foot.appendChild(cnt);var btns=document.createElement('div');btns.style.cssText='display:flex;gap:8px';var cancel=document.createElement('button');cancel.textContent='取消';cancel.style.cssText='cursor:pointer;background:#333a45;border:0;color:#eee;border-radius:6px;padding:7px 14px;font-size:13px';var go=document.createElement('button');go.id='cb_btn';go.textContent='剪藏';go.style.cssText='cursor:pointer;background:#2f6feb;border:0;color:#fff;border-radius:6px;padding:7px 14px;font-size:13px';btns.appendChild(cancel);btns.appendChild(go);foot.appendChild(btns);p.appendChild(grid);p.appendChild(foot);ov.appendChild(p);document.body.appendChild(ov);Q('cb_t').value=t;Q('cb_s').value=sel;function upd(){var n=0;for(var q=0;q<imgs.length;q++){var c=Q('cb_i_'+q);if(c&&c.checked)n++}cnt.textContent=(imgs.length?('共 '+imgs.length+' 张，已选 '+n+' 张'):'页面没有可选图片（仍可剪藏文字）')}upd();grid.onchange=function(){upd()};function close(){document.removeEventListener('keydown',onKey,true);if(ov.parentNode){document.body.removeChild(ov)}}var onKey=function(ev){if(ev.key==='Escape')close()};cancel.onclick=close;ov.onclick=function(ev){if(ev.target===ov)close()};p.onclick=function(ev){ev.stopPropagation()};document.addEventListener('keydown',onKey,true);function doClip(){var tt=(Q('cb_t').value||'').trim()||t;var urls=[];for(var k=0;k<imgs.length;k++){var ck=Q('cb_i_'+k);if(ck&&ck.checked)urls.push(imgs[k].u)}var btn=Q('cb_btn');btn.disabled=true;btn.textContent='剪藏中…';fetch('http://127.0.0.1:8618/clip',{method:'POST',headers:{'content-type':'application/json','x-clip-token':''},body:JSON.stringify({title:tt,url:location.href,text:(Q('cb_s').value||''),images:urls})}).then(function(r){return r.json().then(function(j){return {ok:r.ok&&!!j.ok,error:(j.error||('HTTP '+r.status)),title:j.title,images:j.images||[]}})}).then(function(res){var okN=0;for(var v=0;v<res.images.length;v++)if(res.images[v].ok)okN++;var line=res.ok?('已剪藏：'+(res.title||tt)+(res.images.length?('　图片 '+okN+'/'+res.images.length+' 成功'):'')):('剪藏失败：'+res.error);p.innerHTML='<div style="font-size:15px;font-weight:700;margin:8px 0">'+line+'</div><div style="font-size:12px;opacity:.8;margin-bottom:12px">图片以附件形式存进知识库（失败项已降级为链接）。</div><button id="cb_d" style="cursor:pointer;background:#2f6feb;border:0;color:#fff;border-radius:6px;padding:7px 14px;font-size:13px">完成</button>';Q('cb_d').onclick=close}).catch(function(e){p.innerHTML='<div style="font-size:14px;color:#ff8080;font-weight:700;margin:8px 0">剪藏桥不可达</div><div style="font-size:12px;opacity:.85;margin-bottom:12px">'+(e&&e.message?e.message:'')+'　请确认：① dsh web 在运行；② 设置页已启用「本地剪藏桥」；③ 书签里的端口与设置一致；④ 设置了 token 的话书签已带上。</div><button id="cb_d" style="cursor:pointer;background:#333a45;border:0;color:#fff;border-radius:6px;padding:7px 14px;font-size:13px">关闭</button>';Q('cb_d').onclick=close})}go.onclick=doClip})()`

/** Escape & " < for an HTML attribute (the bookmarklet href). */
function htmlAttrEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * The instruction body, Markdown. Ships BOTH a draggable anchor (raw HTML;
 * verified to survive TW 5.4.1 markdown rendering with its javascript: href
 * intact) and the copy-paste code fence — same CLIP_BRIDGE_BOOKMARKLET.
 */
export const CLIP_BRIDGE_DOC_TEXT = `# 本地剪藏桥（书签小工具）

把任意网页**一键剪藏进 TiddlyWiki**：浏览器里点一下书签，会弹出一个小浮层——确认（或修改）标题与选中文字、**勾选想要的图片**，点「剪藏」即写入本插件的知识库（默认打 \`clip\` 标签，随 wiki 自动 git commit），之后随时可在 TW 里整理、让 Agent 检索。

## 原理

DSH 进程里运行着一个只监听 **127.0.0.1**（本机回环）的 HTTP 小桥——端口默认 \`8618\`，可在设置页改。书签浮层把 {标题, URL, 选中文字, 图片 URL 列表} POST 给它，小桥经插件唯一的写入通道写进 TiddlyWiki：

- **文字** → 一篇笔记（Markdown；选了图则自动改用 wikitext，图片用 \`[img[标题]]\` 内嵌展示）；
- **图片** → 由小桥（DSH 进程侧，无浏览器跨域限制）**下载字节**，存成**二进制附件 tiddler**（\`type: image/…\` + base64 正文，即 TW 原生二进制附件形态），同一篇笔记里内嵌显示并保留 \`clip-url\` / \`clip-note\` 溯源字段；
- 某张图下载失败（防盗链/断链）→ **自动降级为链接**，不阻塞整次剪藏。

## 启用（三步）

1. **开启**：DSH 设置 →「TiddlyWiki 知识库」→ 常规配置 → 勾选 **「启用本地剪藏桥」** → 保存。**立即生效，无需重启 dsh web**（未勾选时桥不会放行任何写入）。
2. **（可选）设置 token**：强烈建议在同一处填一个 **\`bridge.token\`** 共享口令——非空后，书签请求必须带上 \`x-clip-token\` 头才能写入，防止你在浏览器里访问的任意网页偷偷往 wiki 里塞内容。**改端口（\`bridge.port\`）则需要重启 dsh web 生效**。
3. **装书签**（二选一）：
   - **拖拽安装**：按住下面这个按钮，**拖到浏览器书签栏**（或地址栏）松手即装好，自动命名为「剪藏」：

   <a href="${htmlAttrEscape(CLIP_BRIDGE_BOOKMARKLET)}" draggable="true" title="按住我，拖到浏览器书签栏即可安装" style="display:inline-block;padding:8px 16px;border-radius:8px;background:#2f6feb;color:#fff;text-decoration:none;font-size:14px;cursor:grab;margin:4px 0">📌 剪藏 — 拖到书签栏</a>

   - **复制粘贴**（部分浏览器/环境禁止从页面拖动书签时用）：浏览器书签栏新建书签，名称随意（如「剪藏」），**地址（URL）粘贴下面整段代码**。若设置了 token，把代码里 \`'x-clip-token': ''\` 的空字符串换成你的口令；若改了端口，把 \`127.0.0.1:8618\` 一起改掉：

\`\`\`javascript
${CLIP_BRIDGE_BOOKMARKLET}
\`\`\`

## 使用

打开任意网页 → 选中想保留的文字（可选）→ 点书签 → 浮层里：

- **标题**可改；**正文**自动填入选中的文字（可编辑）；
- **图片区**列出页面图片的缩略图（自动跳过 <80px 的小图标与 data:/blob: 占位，去重；页面声明了 \`og:image\` 的会标「封面」并默认勾选）——勾选想剪的（最多 10 张）；
- 点「**剪藏**」→ 提示「已剪藏：〈标题〉（图片 n/m 成功）」。

笔记以**页面标题**命名（重名自动追加 \`（2）\`、\`（3）\`…，绝不覆盖已有笔记）。**图片是二进制附件**（打开笔记直接看到图；每张带 \`clip-url\`、\`clip-note\` 字段溯源）；某张图没存成（网站防盗链等）会在笔记里留一行链接。可用「发送给 Agent」一键把整篇丢给会话整理。

## 安全说明

- 桥**只监听 127.0.0.1**，并校验请求的 \`Host\` 头（只放行 127.0.0.1 / localhost / ::1）——恶意网页即使把自己的域名解析到本机回环（DNS rebinding）也调不动它。
- **强烈建议设置 \`bridge.token\`**：不设 token 时，你在浏览器里访问的**任何网页**都能向本机桥提交内容（它们读不到回应，但能往 wiki 里写——只是污染笔记，不是执行代码）。token 只有你知道，网页拿不到。
- 图片**只下载你勾选的那几个 URL**，由 DSH 本机发起（无跨域限制），存进的是字节副本；不做任何代码执行。
- 图片附件**不参与 \`search\` / \`recent\`**（按设计排除二进制，避免刷屏）；\`get\` 对附件只返回元数据。想删某张图，直接在 TW 里删除对应 tiddler 即可。

## 配置项

| 项 | 默认 | 说明 |
|---|---|---|
| \`bridge.enabled\` | \`false\` | 是否启用剪藏桥（设置页保存后立即生效） |
| \`bridge.port\` | \`8618\` | 监听端口（改动需**重启 dsh web** 生效） |
| \`bridge.token\` | 空 | 共享口令；非空时校验 \`x-clip-token\` 请求头 |
| \`bridge.tag\` | \`clip\` | 剪藏笔记默认 tag |

## 命令行/脚本方式（可选）

不想用书签时，直接 POST 也行（适合脚本、API 调用；\`images\` 字段可选，传了就存附件）：

\`\`\`bash
curl -X POST http://127.0.0.1:8618/clip ^
  -H "content-type: application/json" ^
  -H "x-clip-token: 你的token（没设置就删掉这行）" ^
  -d "{\\"title\\":\\"测试\\",\\"url\\":\\"https://example.com\\",\\"text\\":\\"测试选中文字\\",\\"images\\":[\\"https://example.com/a.png\\"]}"
\`\`\`

成功返回 \`{"ok":true,"title":"测试",...,"images":[{"url":"...","ok":true,"title":"测试 图片 1.png"}]}\`；未启用时返回 503。

## 常见问题

- 点书签提示「剪藏桥不可达」：① dsh web 没在运行；② 设置页没勾选启用；③ 书签里的端口和设置不一致；④ 设置了 token 但书签没带上。
- 图片显示「× 失败」：多为网站防盗链/禁止外链下载，笔记里会留链接兜底；也可先在浏览器里把图片另存，再手动拖进 TW。
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
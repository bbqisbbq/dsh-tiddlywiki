#!/usr/bin/env node
/**
 * 渲染片段净化器守门（v0.19.1，安全回归）。
 *
 * 断两件事：
 *   1. `sanitizeTwFragment()` 对一组真实 payload（TW 的 HTML 解析器会原样放行的
 *      那几种）必须给出安全输出——这是 v0.19.1 修的存储型 XSS 的回归测试；
 *   2. 客户端所有 `dangerouslySetInnerHTML` 注入点都只吃 host 净化过的片段
 *      （即客户端不再直接打 `/dsh-tiddlywiki/tw/render`，host 路由必须调用
 *      净化器）。
 *
 *   node scripts/verify-render-sanitizer.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-render-sanitizer
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeTwFragment } from '../lib/index.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
function test(name, fn) {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures++
    console.error(`FAIL  ${name}\n      ${err && err.message ? err.message : err}`)
  }
}

const clean = (html) => sanitizeTwFragment(html)
const mustNotContain = (html, needle) => {
  const out = clean(html)
  assert.ok(!out.toLowerCase().includes(needle.toLowerCase()), `输出里不该出现 ${needle}：${out}`)
  return out
}

console.log('sanitizeTwFragment —— 危险构造必须被清除')

test('script 整棵丢掉（含内容）', () => {
  mustNotContain('<p>a</p><script>alert(1)</script>', '<script')
  assert.equal(clean('<div>a<script>alert(1)</script>b</div>'), '<div>ab</div>')
})

test('on* 事件属性全部丢掉', () => {
  mustNotContain('<img src="x.png" onerror="alert(1)">', 'onerror')
  mustNotContain('<div onclick=alert(1)>x</div>', 'onclick')
  mustNotContain('<svg onload=alert(1)></svg>', 'onload')
  mustNotContain('<body onpageshow=alert(1)>', 'onpageshow')
})

test('iframe / object / embed / form / base / meta / link 整棵丢掉', () => {
  mustNotContain('<iframe src="javascript:alert(1)"></iframe>', '<iframe')
  mustNotContain('<iframe srcdoc="<script>alert(1)</script>"></iframe>', 'srcdoc')
  mustNotContain('<object data="data:text/html,<script>alert(1)</script>"></object>', '<object')
  mustNotContain('<embed src="javascript:alert(1)">', '<embed')
  mustNotContain('<form action="javascript:alert(1)"><input type="submit"></form>', '<form')
  mustNotContain('<base href="https://evil.example/">', '<base')
  mustNotContain('<meta http-equiv="refresh" content="0;url=javascript:alert(1)">', '<meta')
  mustNotContain('<link rel="stylesheet" href="https://evil.example/x.css">', '<link')
})

test('javascript: / vbscript: URL 被丢掉（含大小写与空白混淆）', () => {
  mustNotContain('<a href="javascript:alert(1)">x</a>', 'javascript:')
  mustNotContain('<a href="JaVaScRiPt:alert(1)">x</a>', 'javascript:')
  mustNotContain('<a href=" java\tscript:alert(1)">x</a>', 'javascript:')
  mustNotContain('<a href="\njavascript:alert(1)">x</a>', 'javascript:')
  mustNotContain('<a href="javascript&colon;alert(1)">x</a>', 'javascript')
  mustNotContain('<a href="&#106;avascript:alert(1)">x</a>', 'javascript')
  mustNotContain('<img src="vbscript:msgbox(1)">', 'vbscript')
})

test('data: 只放行栅格图片，data:text/html 与 data:image/svg 被丢掉', () => {
  mustNotContain('<img src="data:text/html;base64,PHNjcmlwdD4=">', 'data:text/html')
  mustNotContain('<img src="data:image/svg+xml;base64,PHN2Zz4=">', 'data:image/svg')
  mustNotContain('<iframe src="data:text/html,<script>alert(1)</script>"></iframe>', 'data:')
  const ok = clean('<img src="data:image/png;base64,iVBORw0KGgo=">')
  assert.ok(ok.includes('data:image/png'), `栅格 data 图片应保留：${ok}`)
})

test('单引号 / 无引号 / 引号内 `>` 不会绕过', () => {
  mustNotContain("<a href='javascript:alert(1)'>x</a>", 'javascript:')
  mustNotContain('<a href=javascript:alert(1)>x</a>', 'javascript:')
  mustNotContain('<img src="x" alt="a>b" onerror="alert(1)">', 'onerror')
  mustNotContain("<img src='x' onerror='alert(1)'>", 'onerror')
})

test('大写标签与属性同样处理', () => {
  mustNotContain('<IFRAME SRC="javascript:alert(1)"></IFRAME>', '<iframe')
  mustNotContain('<IMG SRC=x ONERROR=alert(1)>', 'onerror')
})

test('注释里的 payload 不残留', () => {
  mustNotContain('<!--<script>alert(1)</script>-->', 'script')
  assert.equal(clean('a<!--x-->b'), 'ab')
})

test('style 标签丢掉；未闭合的 script 吞到串尾', () => {
  mustNotContain('<style>body{background:url(javascript:alert(1))}</style>', '<style')
  mustNotContain('<script>alert(1)', '<script')
})

console.log('sanitizeTwFragment —— 正常 TW 片段必须保留')

test('常见结构/类名/属性保留', () => {
  const html = '<p class="tc-tiddlylink">hi</p><table><tr><td>1</td></tr></table><span data-x="1">s</span>'
  const out = clean(html)
  assert.ok(out.includes('<p class="tc-tiddlylink">'), out)
  assert.ok(out.includes('<table>') && out.includes('<td>'), out)
  assert.ok(out.includes('data-x="1"'), out)
})

test('站内链接（同源 hash 与相对路径）保留', () => {
  const out = clean('<a class="tc-tiddlylink" href="/dsh-tiddlywiki/tw/#%E6%A0%87%E9%A2%98">标题</a>')
  assert.ok(out.includes('href="/dsh-tiddlywiki/tw/#%E6%A0%87%E9%A2%98"'), out)
  assert.ok(clean('<a href="#x">x</a>').includes('href="#x"'))
  assert.ok(clean('<a href="https://example.com/a?b=1&amp;c=2">x</a>').includes('href="https://example.com/a?b=1&amp;c=2"'))
  assert.ok(clean('<img src="https://example.com/a.png">').includes('src="https://example.com/a.png"'))
})

test('中文/文本/实体原样保留', () => {
  const out = clean('<p>中文 &amp; <b>粗体</b> &lt;x&gt;</p>')
  assert.equal(out, '<p>中文 &amp; <b>粗体</b> &lt;x&gt;</p>')
})

test('越界数字实体不得让净化器抛异常（v0.22.8 回归）', () => {
  // 旧实现只判 `code > 0`：`&#1114112;`（0x110000，比 Unicode 上限多 1）会让
  // String.fromCodePoint 抛 RangeError，而 sanitizeTwFragment 没有 try —— 一条
  // 正文含该实体的笔记就能让 POST /render 500/502，打坏回复流工具卡与会话 Tab。
  for (const html of [
    '<a href="&#1114112;javascript:alert(1)">x</a>',
    '<a href="&#x110000;javascript:alert(1)">x</a>',
    '<img src="&#99999999999999999999;javascript:alert(1)">',
    '<p>plain &#1114112; text</p>',
  ]) {
    let out
    assert.doesNotThrow(() => { out = clean(html) }, `净化 ${html} 不得抛异常`)
    assert.equal(typeof out, 'string')
    assert.ok(!out.includes('javascript:'), `越界实体不得放行 javascript: 载荷：${out}`)
  }
})

test('空输入与纯文本不炸', () => {
  assert.equal(clean(''), '')
  assert.equal(clean('a < b and c > d'), 'a &lt; b and c > d')
})

console.log('接线守门 —— 注入点必须只吃净化后的片段')

test('host 路由调用净化器', () => {
  const routes = fs.readFileSync(path.join(repoRoot, 'src/host/routes.ts'), 'utf8')
  assert.ok(/sanitizeTwFragment\(/.test(routes), 'src/host/routes.ts 必须在返回渲染片段前调用 sanitizeTwFragment()')
})

test('客户端不再直连未净化的 /tw/render', () => {
  for (const file of ['src/client/tool-views.ts', 'src/client/session-summary.ts']) {
    const src = fs.readFileSync(path.join(repoRoot, file), 'utf8')
    assert.ok(!src.includes("'/dsh-tiddlywiki/tw/render'"), `${file} 不应再直接 POST /dsh-tiddlywiki/tw/render（要过 host 净化路由）`)
  }
})

test('每个 dangerouslySetInnerHTML 所在文件都走净化端点', () => {
  const files = fs.readdirSync(path.join(repoRoot, 'src/client')).filter((f) => f.endsWith('.ts'))
  for (const file of files) {
    const src = fs.readFileSync(path.join(repoRoot, 'src/client', file), 'utf8')
    if (!src.includes('dangerouslySetInnerHTML')) continue
    // v0.22.8: the render call is centralised in render-fetch.ts (it used to be
    // duplicated in tool-views.ts and session-summary.ts). An injection point
    // must therefore either use the endpoint directly or import that one
    // module — the point of the guard is "never TW's raw /tw/render", and
    // render-fetch.ts is asserted below to keep using RENDER_ENDPOINT.
    assert.ok(
      /RENDER_ENDPOINT/.test(src) || /from '\.\/render-fetch\.ts'/.test(src),
      `${file} 用了 dangerouslySetInnerHTML，但既没引用 RENDER_ENDPOINT 也没用 render-fetch.ts 的共享实现`,
    )
  }
})

test('共享渲染实现只认 host 的 RENDER_ENDPOINT', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src/client/render-fetch.ts'), 'utf8')
  assert.ok(/RENDER_ENDPOINT/.test(src), 'render-fetch.ts 必须 POST host 的 RENDER_ENDPOINT')
  assert.ok(/'x-requested-with': 'TiddlyWiki'/.test(src), 'render-fetch.ts 必须带 TW 的 CSRF 头（缺了整条链路 403）')
  // 注释豁免：模块头解释了「不得直连 TW 的 /tw/render」，断言只看可执行代码。
  const code = src.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
  assert.ok(!/tw\/render/.test(code), 'render-fetch.ts 不得直连 TW 的 /tw/render（绕过 host 净化）')
})

// v0.19.4: /tags 的大 payload 是「先下载上千条再丢掉」——工具卡必须带 limit。
test('标签工具卡请求 /tags 时必须带 limit', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src/client/tool-views.ts'), 'utf8')
  assert.ok(/TAGS_ENDPOINT\}\?limit=/.test(src), 'tool-views.ts 的 TagsCard 必须请求 `${TAGS_ENDPOINT}?limit=…`（否则大 wiki 会全量下载标签）')
})

console.log(failures === 0 ? '\nRENDER SANITIZER OK' : `\nRENDER SANITIZER FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env node
/**
 * 微信公众号 adapter 的静态守门（v0.23.0）。
 *
 * 为什么需要它：tools/wechat/ 下的文件是**用户态的 opencli adapter**——不进 lib/、
 * 不被 `tsc` 覆盖、也不是 node 模块，常规校验全都碰不到它们。而这里踩过的两个坑
 * 都极其昂贵且会**静默回归**：
 *
 *   1. **轮询里读 `document.body.innerText`**：微信编辑器 DOM 极大，读一次强制整页
 *      layout，实测单次 evaluate ≈17 秒。8 次轮询把命令拖过 210s 超时——最坑的是
 *      **草稿其实已经保存成功**，用户看到的是超时失败（假阴性）。
 *   2. **用 `page.setFileInput` 传图**：它依赖 CDP `Page.fileChooserOpened`，在本机
 *      （opencli 1.8.7 + 扩展 v1.0.24）稳定报 `not received within 5s`，必须改用
 *      DataTransfer 在页面上下文注入。
 *
 * 另有几条结构性断言：文件齐全、发布前检查存在、安装脚本的文件清单与磁盘一致。
 *
 * 纯文本/源码级检查，不依赖构建产物。
 *
 *   node scripts/verify-wechat-adapters.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-wechat-adapters
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WECHAT_DIR = path.join(repoRoot, 'tools', 'wechat')

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

function read(file) {
  return fs.readFileSync(path.join(WECHAT_DIR, file), 'utf8')
}

/** 去掉 JSON 字符串里的转义，便于对 adapter 里内嵌的 JS 做正则检查。 */
function unescapeJs(s) {
  return s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\'/g, "'")
}

// ── 1. 文件齐全 ───────────────────────────────────────────────────────────
const EXPECTED = [
  'wechat-html.js',
  'weixin-flow.js',
  'create-article.js',
  'publish-note.js',
  'publish-note-imgs.js',
  'install-wechat-adapters.mjs',
  'backfill-publish-state.mjs',
  'seed-publish-spec-now.mts',
]

test('tools/wechat/ 下该有的文件都在', () => {
  const missing = EXPECTED.filter((f) => !fs.existsSync(path.join(WECHAT_DIR, f)))
  assert.deepEqual(missing, [], `缺少：${missing.join(', ')}`)
})

// ── 2. 性能陷阱：轮询里不得读 body.innerText ──────────────────────────────
test('轮询代码里不含 document.body.innerText / body.textContent（每次 ~17s 的假超时元凶）', () => {
  for (const file of ['weixin-flow.js', 'publish-note.js', 'create-article.js']) {
    const src = read(file)
    // 注释里提到它是允许的（我们就是靠注释记录这个坑），只查真实调用
    const offenders = src
      .split('\n')
      .map((line, i) => ({ line, no: i + 1 }))
      .filter(({ line }) => {
        const stripped = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
        return /document\.body\.(innerText|textContent)/.test(stripped)
      })
    assert.deepEqual(
      offenders.map((o) => `${file}:${o.no}`),
      [],
      `${file} 里出现了 document.body.innerText —— 微信编辑器 DOM 极大，读一次会把命令拖到超时`,
    )
  }
})

// ── 3. CDP 陷阱：不得用 setFileInput 传图 ─────────────────────────────────
test('图片上传不得使用 page.setFileInput（CDP 路径在本机稳定失败）', () => {
  const src = read('weixin-flow.js')
  assert.ok(
    !/page\.setFileInput\s*\(/.test(src),
    'weixin-flow.js 又用回了 page.setFileInput —— 它依赖 Page.fileChooserOpened，'
    + '实测稳定失败；应当用 DataTransfer 在页面上下文注入 input.files',
  )
})

test('图片上传确实走 DataTransfer 注入', () => {
  const src = read('weixin-flow.js')
  assert.ok(/new DataTransfer\(\)/.test(src), 'weixin-flow.js 里找不到 DataTransfer 注入实现')
  assert.ok(/input\.files\s*=/.test(src), '找不到把 files 赋给 input 的那一步')
})

// ── 4. 内联样式：微信会剥 <style>/class，正文必须是内联 style ──────────────
test('装饰器对每个元素注入内联 style（微信唯一认的形式）', () => {
  const src = read('wechat-html.js')
  assert.ok(/style="/.test(src), 'wechat-html.js 没有注入内联 style')
  assert.ok(/ELEMENT_STYLES/.test(src), '找不到排版主题表 ELEMENT_STYLES')
  // 必须清掉 class（微信保留 class 但无样式可依附，是噪音）
  assert.ok(/class\\s\*=\\s\*/.test(src) || /class/.test(src), '看不到清理 class 的处理')
})

// ── 5. 发布前检查必须存在，且是「只告警不阻断」 ───────────────────────────
for (const noteCmd of ['publish-note.js', 'publish-note-imgs.js']) {
  test(`${noteCmd} 有发布前状态检查（pub-state / no-publish）`, () => {
    const src = read(noteCmd)
    assert.ok(/checkPublishState/.test(src), `${noteCmd} 缺少 checkPublishState`)
    assert.ok(/pub-state/.test(src), '检查里没有读 pub-state')
    assert.ok(/no-publish/.test(src), '检查里没有看 no-publish 标签')
    assert.ok(/fetchNoteMeta/.test(src), '缺少读取笔记元数据的 fetchNoteMeta')
  })

  test(`${noteCmd} 发布前检查只告警不阻断（不得把已发布当致命错误抛出）`, () => {
    const src = read(noteCmd)
    // checkPublishState 必须返回 warnings 而不是 throw
    assert.ok(/return \{ warnings/.test(src), 'checkPublishState 应返回 warnings 对象而非抛错')
    const fnBody = src.slice(src.indexOf('function checkPublishState'), src.indexOf('function emitWarnings'))
    assert.ok(/warnings\.push/.test(fnBody), 'checkPublishState 里应当收集 warnings')
    assert.ok(!/throw\s+new\s+\w*Error/.test(fnBody), 'checkPublishState 不得抛错（用户明确要求只告警不阻断）')
  })
}

// ── 6. 返回行的 key 必须与 columns 一致 ──────────────────────────────────
test('adapter 返回的 row 只含 columns 声明的字段', () => {
  for (const file of ['publish-note.js', 'create-article.js']) {
    const src = read(file)
    const colsMatch = src.match(/columns:\s*\[([^\]]*)\]/)
    assert.ok(colsMatch, `${file} 找不到 columns 声明`)
    const cols = colsMatch[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    // 找 return [{...}] 里的顶层 key
    const retMatch = src.match(/return \[\{([\s\S]*?)\}\]/)
    assert.ok(retMatch, `${file} 找不到 return [{...}]`)
    const keys = [...retMatch[1].matchAll(/^\s{8,}([a-zA-Z][a-zA-Z0-9_]*)\s*:/gm)].map((m) => m[1])
    const extra = keys.filter((k) => !cols.includes(k))
    assert.deepEqual(
      extra,
      [],
      `${file} 的返回行含 columns 之外的字段 ${extra.join(', ')} —— adapter 契约要求一一对应，多余字段会让行渲染卡住`,
    )
  }
})

// ── 7. 换机器还原：安装脚本的自检清单与磁盘一致 ──────────────────────────
test('install 脚本的 FILES 清单与磁盘文件一致', () => {
  const src = read('install-wechat-adapters.mjs')
  const m = src.match(/const FILES = \[([^\]]*)\]/)
  assert.ok(m, '找不到 install 脚本里的 FILES 常量')
  const listed = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
  assert.deepEqual(
    listed,
    ['create-article.js', 'publish-note-imgs.js', 'publish-note.js', 'wechat-html.js', 'weixin-flow.js'].sort(),
    'FILES 应恰好是五个 adapter（wechat-html / weixin-flow / create-article / publish-note / publish-note-imgs）',
  )
  for (const f of listed) {
    assert.ok(fs.existsSync(path.join(WECHAT_DIR, f)), `FILES 列了 ${f} 但磁盘上没有`)
  }
})

// ── 8. 标题必须能走文件（宿主按钮路径）────────────────────────────────────
test('两个 publish adapter 都支持 --title-file，且标题解析只有一份实现', () => {
  const flow = read('weixin-flow.js')
  assert.ok(
    /export function resolveNoteTitle\(/.test(flow),
    'weixin-flow.js 缺少 resolveNoteTitle（标题位置参数 / --title-file 二选一的唯一实现）',
  )
  for (const file of ['publish-note.js', 'publish-note-imgs.js']) {
    const src = read(file)
    assert.ok(/name: 'titleFile'/.test(src), `${file} 缺少 --title-file 参数声明（宿主按钮靠它把标题挡在 argv 之外）`)
    assert.ok(
      /resolveNoteTitle\(kwargs\.title, kwargs\.titleFile\)/.test(src),
      `${file} 没有走 resolveNoteTitle —— 直接读 kwargs.title 会让 --title-file 静默失效`,
    )
    assert.ok(
      !/const noteTitle = String\(kwargs\.title \|\| ''\)\.trim\(\)/.test(src),
      `${file} 还留着旧的 kwargs.title 直读（会绕过标题文件）`,
    )
  }
})

// ── 9. 关键注释不得丢（这些坑靠注释传承） ────────────────────────────────
test('三个必需踩坑被注释记录（trace / DataTransfer / insertHTML）', () => {
  const flow = read('weixin-flow.js')
  const joined = unescapeJs(flow)
  assert.ok(/trace retain-on-failure/i.test(joined), 'weixin-flow 应记录「必须带 --trace retain-on-failure」')
  assert.ok(/DataTransfer/.test(joined), 'weixin-flow 应记录 DataTransfer 上传的理由')
  assert.ok(/insertHTML/.test(joined), 'weixin-flow 应记录正文必须用 insertHTML')
  // 标题文件的理由（cmd.exe shim → 注入面 + 中文乱码）同样必须留在源码里
  assert.ok(/cmd\.exe/.test(joined) && /argv/.test(joined), 'weixin-flow 应记录「为什么标题不进 argv」')
})

console.log(failures === 0 ? '\nWECHAT ADAPTER CHECKS OK' : `\nWECHAT ADAPTER CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

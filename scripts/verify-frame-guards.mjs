#!/usr/bin/env node
/**
 * 客户端 TW iframe 生命周期守门（v0.22.3）。
 *
 * 断的是 v0.22.3 修掉的两类真实缺陷，防止它们以同样的形状回归：
 *
 *  1. **空 src 陷阱**（P0）：`iframe` 从未赋过 `src` 时，`iframe.src` 读出来是
 *     **宿主页面自己的 URL**，把它写回 `src`（`frame.src = frame.src`）或拼上
 *     `'' + '#标题'` 都会让 DSH 把自己载进 iframe（iframe 里再起一份 DSH：重复
 *     FAB、重复全局监听、白屏）。所以两处「整页重载」路径（FAB 重载事件、
 *     hash 兜底加载）都必须以 `dataset.loaded`（只有 showFrame 写）为准，
 *     并且不得再直接读 `iframe.src` 当基准。
 *  2. **活动主题靠猜**（P1）：`/admin/state` 必须回 `info.themeActive`（读
 *     `$:/theme`），设置页必须优先用它——旧代码用 `info.themes` 的最后一项冒充
 *     活动主题，用户显式激活过非末位主题时，点一次「应用主题」就会静默改回去。
 *
 * 另附两条同类回归（跨源 SecurityError、共享 toast 误删）与两个死标记检查；
 * `readActiveThemeName()` 走真实函数（host 侧纯逻辑，可直接从 lib 导入）。
 *
 *   node scripts/verify-frame-guards.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-frame-guards
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readActiveThemeName } from '../lib/index.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/**
 * Read a source file with COMMENT LINES removed. The regression guards below
 * assert on executable code only: these modules document the traps they avoid
 * (`frame.src = frame.src`, `data-dsh-tw-rightbar`, …), and matching our own
 * explanatory comments would report a fix as a failure.
 */
const read = (rel) =>
  fs
    .readFileSync(path.join(repoRoot, rel), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')

const twFrame = read('src/client/tw-frame.ts')
const panel = read('src/client/panel.ts')
const settings = read('src/client/settings-page.ts')
const admin = read('src/host/admin.ts')
const themeSync = read('src/client/theme-sync.ts')
const noteWidget = read('src/client/note-widget.ts')
const rightbar = read('src/client/rightbar-tab.ts')

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures++
    console.error(`FAIL  ${name}\n      ${err && err.message ? err.message : err}`)
  }
}

/** Index of the first `{` at/after `from`, ignoring comments/strings/regex-ish. */
function nextCodeBrace(source, from) {
  for (let i = from; i < source.length; i++) {
    const ch = source[i]
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      if (nl < 0) return -1
      i = nl
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end < 0) return -1
      i = end + 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++
        i++
      }
      continue
    }
    if (ch === '{') return i
    if (ch === ';') return -1
  }
  return -1
}

/** The function body (brace-balanced, comments skipped) so assertions cannot
 *  match a neighbour — or a `{` inside the function's own JSDoc. */
function bodyOf(source, signature) {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `找不到函数：${signature}`)
  const open = nextCodeBrace(source, start + signature.length)
  assert.ok(open >= 0, `找不到函数体起始花括号：${signature}`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const ch = source[i]
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      if (nl < 0) break
      i = nl
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end < 0) break
      i = end + 1
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  throw new Error(`函数体没有闭合：${signature}`)
}

/** Assert a snippet contains no match of `pattern`. */
const assertNo = (snippet, pattern, message) => {
  assert.ok(!pattern.test(snippet), `${message}\n      命中：${pattern}`)
}

console.log('空 src 守卫 —— dataset.loaded 是唯一判据')

await test('tw-frame：loadableFrameUrl 只认非空 dataset.loaded', () => {
  const body = bodyOf(twFrame, 'export function loadableFrameUrl(')
  assert.match(body, /loaded\s*=\s*dataset\.loaded/, 'loadableFrameUrl 必须读 dataset.loaded')
  assert.match(body, /undefined/, '必须把 undefined 判成「没有 URL」')
  assert.match(body, /length === 0/, '必须把空串判成「没有 URL」')
})

await test('tw-frame：onReloadRequest 不得再 `frame.src = frame.src`', () => {
  const body = bodyOf(twFrame, 'const onReloadRequest = ')
  assert.match(body, /loadableFrameUrl\(frame\.dataset\)/, '重载前必须取 dataset.loaded')
  assertNo(body, /frame\.src\s*=\s*frame\.src/, '`frame.src = frame.src` 在空 src 时会把 DSH 载进 iframe')
})

await test('tw-frame：fallbackLoad 不得以 frame.src 为基准', () => {
  const body = bodyOf(twFrame, 'const fallbackLoad = ')
  assert.match(body, /loadableFrameUrl\(frame\.dataset\)/, 'hash 兜底加载必须取 dataset.loaded 当基准')
  assertNo(body, /frame\.src\.split/, "`frame.src.split('#')[0]` 在空 src 时得到宿主 URL")
})

await test('panel：onReloadRequest / fallbackLoad 同样以 dataset.loaded 为准', () => {
  const reload = bodyOf(panel, 'const onReloadRequest = ')
  assert.match(reload, /loadableFrameUrl\(iframe\.dataset\)/, '面板重载前必须取 dataset.loaded')
  assertNo(reload, /iframe\.src\s*=\s*iframe\.src/, '`iframe.src = iframe.src` 在空 src 时会把 DSH 载进 iframe')
  const fallback = bodyOf(panel, 'const fallbackLoad = ')
  assert.match(fallback, /loadableFrameUrl\(iframe\.dataset\)/, '面板 hash 兜底加载必须取 dataset.loaded')
  assertNo(fallback, /iframe\.src\.split/, '不得用 iframe.src 当基准')
})

await test('panel：requestRestart 只此一份（从 tw-frame 复用）', () => {
  assert.match(panel, /import \{[^}]*requestRestart[^}]*\} from '\.\/tw-frame\.ts'/, 'panel 必须 import requestRestart')
  assertNo(panel, /async function requestRestart/, 'panel 不得再留第二份实现')
  const defs = twFrame.match(/export async function requestRestart\(/g) ?? []
  assert.equal(defs.length, 1, `requestRestart 定义数应为 1，实际 ${defs.length}`)
})

console.log('活动主题 —— $:/theme 优先，猜末位只作兜底')

await test('readActiveThemeName：$:/themes/ 前缀被去掉', async () => {
  const client = { get: async () => ({ text: '$:/themes/tiddlywiki/heavier' }) }
  assert.equal(await readActiveThemeName(client), 'tiddlywiki/heavier')
})

await test('readActiveThemeName：裸名 / 首尾空白都能归一', async () => {
  assert.equal(await readActiveThemeName({ get: async () => ({ text: '  tiddlywiki/snowwhite  ' }) }), 'tiddlywiki/snowwhite')
})

await test('readActiveThemeName：缺失 / 空文本 / 读失败 → undefined（不猜）', async () => {
  assert.equal(await readActiveThemeName(undefined), undefined)
  assert.equal(await readActiveThemeName({ get: async () => undefined }), undefined)
  assert.equal(await readActiveThemeName({ get: async () => ({ text: '   ' }) }), undefined)
  assert.equal(await readActiveThemeName({ get: async () => { throw new Error('wiki down') } }), undefined)
})

await test('/admin/state 回传 info.themeActive', () => {
  const state = bodyOf(admin, 'const handleState = ')
  assert.match(state, /readActiveThemeName\(deps\.getClient\(\)\)/, '/admin/state 必须读真实活动主题')
  assert.match(state, /themeActive\b/, 'info 里必须带上 themeActive')
})

await test('设置页优先用 themeActive，只在其不可用时猜末位', () => {
  const section = bodyOf(settings, 'function renderCatalogSection(')
  assert.match(section, /info\?\.themeActive/, '必须优先使用 host 回传的 themeActive')
  assert.match(section, /themes\.some\(/, 'themeActive 必须先在 catalog 里校验（否则单选一个都不选中）')
  const idxServer = section.indexOf('info?.themeActive')
  const idxGuess = section.indexOf('themeList[themeList.length - 1]')
  assert.ok(idxServer >= 0 && idxGuess > idxServer, 'themeActive 判断必须排在「猜末位」之前')
})

console.log('同类回归 —— 跨源异常 / 共享 toast / 死标记')

await test('applyToFrame 整体包 try/catch（跨源读 contentWindow 会抛 SecurityError）', () => {
  const body = bodyOf(themeSync, 'function applyToFrame(')
  assert.match(body.trimStart(), /^try\s*\{/, 'applyToFrame 的第一条语句必须是 try（contentWindow 访问本身就会抛）')
  assert.match(body, /catch\s*\{/, 'applyToFrame 必须有 catch')
})

await test('note-widget 卸载不得删除共享 .dsh-tw-toast', () => {
  const body = bodyOf(noteWidget, '    dispose() {')
  assertNo(body, /querySelector<HTMLElement>\('\.dsh-tw-toast'\)/, 'toast 是 toast.ts 的页面级单例，设置页也在用')
  assertNo(body, /toastEl\?\.remove\(\)/, '卸载本组件不得抹掉别人正在显示的提示')
})

await test('死标记不再出现：dataset.visible / data-dsh-tw-rightbar', () => {
  assertNo(twFrame, /dataset\.visible/, 'view.dataset.visible 没有任何消费者')
  assertNo(rightbar, /data-dsh-tw-rightbar/, 'data-dsh-tw-rightbar 没有任何消费者')
})

console.log('')
if (failures > 0) {
  console.error(`verify-frame-guards: ${failures} 项失败`)
  process.exit(1)
}
console.log('verify-frame-guards: 全部通过')

#!/usr/bin/env node
/**
 * 客户端 TW iframe 生命周期守门（v0.22.3；v0.22.4 扩到「单一实现」）。
 *
 * 断的是 v0.22.3 修掉的两类真实缺陷，防止它们以同样的形状回归：
 *
 *  1. **空 src 陷阱**（P0）：`iframe` 从未赋过 `src` 时，`iframe.src` 读出来是
 *     **宿主页面自己的 URL**，把它写回 `src`（`frame.src = frame.src`）或拼上
 *     `'' + '#标题'` 都会让 DSH 把自己载进 iframe（iframe 里再起一份 DSH：重复
 *     FAB、重复全局监听、白屏）。所以「整页重载」路径（FAB 重载事件、hash 兜底
 *     加载）都必须以 `dataset.loaded`（只有 showFrame 写）为准，并且不得再直接
 *     读 `iframe.src` 当基准。
 *  2. **活动主题靠猜**（P1）：`/admin/state` 必须回 `info.themeActive`（读
 *     `$:/theme`），设置页必须优先用它——旧代码用 `info.themes` 的最后一项冒充
 *     活动主题，用户显式激活过非末位主题时，点一次「应用主题」就会静默改回去。
 *
 * v0.22.4 增加第三类：**生命周期只有一份实现**。上面两个 bug 之所以出现，根因是
 * `panel.ts` 与 `tw-frame.ts` 各抄了一份 showError/showStarting/showFrame/
 * fallbackLoad/doRefresh——修 bug 时只改到其中一份（panel 拿到了空 src 守卫、
 * tw-frame 没拿到）。现在这些函数只在 tw-frame.ts 的 `createTwFrameSurface()`
 * 里各有一份，panel 只提供皮肤/构建点/可见性；本脚本会盯着「不许再抄第二份」。
 *
 * 另附同类回归（跨源 SecurityError、共享 toast 误删）与死标记检查；
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
const editorPopup = read('src/client/editor-popup.ts')
const quickNoteDock = read('src/client/quick-note-dock.ts')

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

console.log('空 src 守卫 —— dataset.loaded 是唯一判据（内核唯一实现）')

await test('frame 内核：loadableFrameUrl 只认非空 dataset.loaded', () => {
  const body = bodyOf(twFrame, 'export function loadableFrameUrl(')
  assert.match(body, /loaded\s*=\s*dataset\.loaded/, 'loadableFrameUrl 必须读 dataset.loaded')
  assert.match(body, /undefined/, '必须把 undefined 判成「没有 URL」')
  assert.match(body, /length === 0/, '必须把空串判成「没有 URL」')
})

await test('frame 内核：onReloadRequest 不得再 `frame.src = frame.src`', () => {
  const body = bodyOf(twFrame, 'const onReloadRequest = ')
  assert.match(body, /loadableFrameUrl\(frame\.dataset\)/, '重载前必须取 dataset.loaded')
  // 显式重载请求必须覆盖**关掉的** surface：加回 `frame.hidden` 判据会让「关掉
  // 面板 → FAB 重载 → 再打开」看到旧资源（v0.22.4 的取舍，测试里也断言了）。
  assertNo(body, /frame\.hidden/, '不得用可见性当重载门槛——判据只能是 dataset.loaded')
  assertNo(body, /frame\.src\s*=\s*frame\.src/, '`frame.src = frame.src` 在空 src 时会把 DSH 载进 iframe')
})

await test('frame 内核：fallbackLoad 不得以 frame.src 为基准', () => {
  const body = bodyOf(twFrame, 'const fallbackLoad = ')
  assert.match(body, /loadableFrameUrl\(frame\.dataset\)/, 'hash 兜底加载必须取 dataset.loaded 当基准')
  assertNo(body, /frame\.src\.split/, "`frame.src.split('#')[0]` 在空 src 时得到宿主 URL")
})

await test('frame 内核：setVisible 不得显示还没载入 TW 地址的 frame', () => {
  // 签名不带函数体的 `{`：bodyOf() 自己找第一个代码花括号。
  const body = bodyOf(twFrame, 'setVisible(next: boolean): void ')
  assert.match(body, /loadableFrameUrl\(frame\.dataset\)/, '显示前必须确认 frame 已有 TW 地址')
  assert.match(body, /frame\.hidden\s*=/, 'setVisible 必须同步 frame.hidden')
  assert.match(body, /clearRetry\(\)/, '隐藏时必须停掉有界轮询')
})

console.log('单一实现 —— 生命周期只在 tw-frame.ts 内核里各一份')

/** 生命周期函数签名；`read()` 已剥掉整行注释，计数即代码出现次数。 */
const LIFECYCLE = [
  'const showError = ',
  'const showStarting = ',
  'const showFrame = ',
  'const doRefresh = ',
  'const applyPendingHash = ',
  'const fallbackLoad = ',
  'const onReloadRequest = ',
]
const countOf = (source, needle) => source.split(needle).length - 1

await test('tw-frame：每个生命周期函数恰好一份', () => {
  for (const signature of LIFECYCLE) {
    assert.equal(countOf(twFrame, signature), 1, `tw-frame.ts 应有且仅有一份 \`${signature.trim()}\``)
  }
  assert.match(twFrame, /export function createTwFrameSurface\(skin: TwFrameSkin\)/, '内核必须是 createTwFrameSurface')
})

await test('panel：不得再自带第二份生命周期（v0.22.3 漂移的根因）', () => {
  for (const signature of LIFECYCLE) {
    assert.equal(countOf(panel, signature), 0, `panel.ts 不得定义 \`${signature.trim()}\`——用 tw-frame.ts 的内核`)
  }
  assert.match(panel, /createTwFrameSurface\(PANEL_SKIN\)/, 'panel 必须用共享内核建 surface')
  assert.match(panel, /surface\.setVisible\(/, 'panel 的可见性必须交给内核')
  assert.match(panel, /surface\.openTiddler\(/, 'panel 的 tiddler 导航必须交给内核')
})

await test('重试按钮：requestRestart 只有内核一份', () => {
  assertNo(panel, /requestRestart/, 'panel 不再直接调 requestRestart（由内核的错误态重试按钮负责）')
  const defs = twFrame.match(/export async function requestRestart\(/g) ?? []
  assert.equal(defs.length, 1, `requestRestart 定义数应为 1，实际 ${defs.length}`)
})

await test('panel：链接打开必须先 openPanel() 再 surface.openTiddler()', () => {
  const body = bodyOf(panel, 'const onOpenTiddler = ')
  const iOpen = body.indexOf('state.openPanel()')
  const iTiddler = body.indexOf('.openTiddler(')
  assert.ok(iOpen >= 0, 'onOpenTiddler 必须调用 state.openPanel()')
  assert.ok(iTiddler > iOpen, 'openPanel() 必须排在 openTiddler() 之前——内核以 visible=false 拒绝（链接会静默丢失）')
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

console.log('空掉的编辑器弹窗 —— 删除笔记后必须能重新打开（v0.22.6）')

await test('editor-popup：URL 相同但里面空了也必须重载；关闭要清掉已载入标记', () => {
  assert.match(
    editorPopup,
    /frame\.dataset\.loaded !== url \|\| isEditorPopupBlank\(\)/,
    'openEditorPopup 必须把「story 已经空了」也当成重载条件（否则删除笔记后永远白板）',
  )
  assert.match(editorPopup, /frame\.dataset\.loaded = ''/, 'closeEditorPopup 必须清掉已载入标记，关闭再打开 = 重新载入')
  const blank = bodyOf(editorPopup, 'export function isEditorPopupBlank(')
  assert.match(blank, /\.tc-story-river/, '空判据必须看 TW 的 story river')
  assert.match(blank, /\.tc-tiddler-frame/, '空判据 = 一条 tiddler frame 都没有')
  assert.match(blank, /readyState/, '文档仍在 loading 时不得判空')
  assert.match(blank, /doc === null/, '跨源（读不到文档）时不得判空')
})

await test('空弹窗不得被当成「已打开」而吞掉点击', () => {
  assert.match(
    quickNoteDock,
    /if \(isEditorPopupOpen\(\) && !isEditorPopupBlank\(\)\) closeEditorPopup\(\)/,
    'dock 只在弹窗里确实有内容时才收起；空掉的弹窗要高重新打开编辑器',
  )
  assert.match(
    noteWidget,
    /if \(isEditorPopupOpen\(\) && !isEditorPopupBlank\(\)\) return/,
    'openNative 的幂等守卫必须排除空弹窗（否则编辑器再也打不开）',
  )
})

console.log('')
if (failures > 0) {
  console.error(`verify-frame-guards: ${failures} 项失败`)
  process.exit(1)
}
console.log('verify-frame-guards: 全部通过')

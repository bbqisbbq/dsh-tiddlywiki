#!/usr/bin/env node
/**
 * 快速笔记「TW 原生编辑」弹窗的行为单测（v0.22.6）。
 *
 * 用户实测报障：在弹窗里用 TW 编辑器的「删除」把正在编辑的笔记删掉后，弹窗变白板；
 * 再点快速笔记，页面上还是什么都没有。根因有两层，这里都盯住：
 *
 *   1. `openEditorPopup()` 原先只在 **URL 变了**才给 iframe 赋 src（为了不整页重载、
 *      不丢 TW 里未保存的草稿状态）。但删除后主机重建的草稿标题常常和删除前一样
 *      （时间戳精确到分钟、canonical `Draft of "…"` 复用）→ URL 不变 → 不重载 →
 *      iframe 里永远是被清空的 story。现在 `isEditorPopupBlank()` 把「弹窗还开着、
 *      但里面一条 `.tc-tiddler-frame` 都没有」也判成「必须重载」。
 *   2. 弹窗曾被关闭（`closeEditorPopup()`）后重新打开，必须重新载入 —— 关闭意味着
 *      「下次打开是一个新的编辑器」，而不是把上一次的 view 状态（可能已经过期或
 *      被删空）原样摆回来。
 *
 * 另外守住保守判据：跨源（TW 里点了外链，读 contentDocument 得 null）与文档仍在
 * loading 时**不得**判定为「空」，否则会擅自重载用户可能正在编辑的编辑器。
 *
 *   npx tsx scripts/verify-editor-popup.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-editor-popup
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

/* ───────────────────────── 最小 DOM 打桩 ───────────────────────── */

class StubElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.dataset = {}
    this.hidden = false
    this.className = ''
    this.textContent = ''
    this.title = ''
    this.type = ''
    this.parent = null
    this.contentWindow = null
    this.contentDocument = null
    /** 每一次赋给 src 的值（重载判据就断在这里）。 */
    this.srcAssignments = []
    this._src = ''
    this._listeners = new Map()
    this.style = {
      cssText: '',
      setProperty(key, value) { this[key] = value },
      getPropertyValue(key) { return this[key] ?? '' },
    }
  }
  get src() { return this._src }
  set src(value) { this._src = value; this.srcAssignments.push(value) }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node) } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes) }
  remove() {
    if (this.parent !== null) this.parent.children = this.parent.children.filter((c) => c !== this)
    this.parent = null
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set())
    this._listeners.get(type).add(fn)
  }
  removeEventListener(type, fn) { this._listeners.get(type)?.delete(fn) }
  /** focusFirstInPopup() 只关心「有没有可聚焦元素」：一律返回 null（不聚焦）。 */
  querySelector() { return null }
  setAttribute() {}
  removeAttribute() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0 } }
}

const created = []
const documentListeners = new Map()
const documentStub = {
  createElement: (tag) => { const el = new StubElement(tag); created.push(el); return el },
  addEventListener(type, fn) {
    if (!documentListeners.has(type)) documentListeners.set(type, new Set())
    documentListeners.get(type).add(fn)
  },
  removeEventListener(type, fn) { documentListeners.get(type)?.delete(fn) },
  dispatchEvent() { return true },
  body: new StubElement('body'),
  documentElement: new StubElement('html'),
}

globalThis.document = documentStub
globalThis.window = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  location: { origin: 'http://127.0.0.1:3080' },
}
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
}

const mod = await import(pathToFileURL(path.join(repoRoot, 'src/client/editor-popup.ts')).href).catch((err) => {
  console.error('FAIL  无法导入 src/client/editor-popup.ts（需要 tsx：`npx tsx scripts/verify-editor-popup.mjs`）')
  console.error(`      ${err && err.message ? err.message : err}`)
  return null
})
if (mod === null) process.exit(1)
const { openEditorPopup, closeEditorPopup, isEditorPopupOpen, isEditorPopupBlank } = mod

/* ───────────────────────── TW 文档打桩 ───────────────────────── */

/** 一个「像 TW 一样」的 contentDocument：river 里有没有 tiddler frame 可控。 */
function twDoc({ frames = 1, river = true, readyState = 'complete' } = {}) {
  const tiddlerFrame = { tagName: 'DIV' }
  return {
    readyState,
    querySelector(selector) {
      if (!river || selector !== '.tc-story-river') return null
      return { querySelector: (inner) => (inner === '.tc-tiddler-frame' && frames > 0 ? tiddlerFrame : null) }
    },
  }
}

/** 当前弹窗的 iframe（ensurePopup 只造一个，document.createElement 已记录）。 */
const popupFrame = () => created.find((el) => el.tagName === 'IFRAME')
const popupRoot = () => created.find((el) => el.tagName === 'DIV' && el.className === 'dsh-tw-editor-popup')

const URL_A = 'http://127.0.0.1:3080/dsh-tiddlywiki/tw/#Draft%20of%20%22A%22'
const URL_B = 'http://127.0.0.1:3080/dsh-tiddlywiki/tw/#Draft%20of%20%22B%22'

/** 打开一次弹窗（并给出这一跳里 iframe 的文档形态）。 */
function open(url, doc) {
  const frame = popupFrame()
  if (frame !== undefined) {
    frame.contentDocument = doc
  } else {
    openEditorPopup(url, 'A')            // 首次：先建结构（此时 doc 还是 null）
    popupFrame().contentDocument = doc
    return popupFrame()
  }
  openEditorPopup(url, 'A')
  return frame
}

console.log('弹窗结构与首次载入')

await test('openEditorPopup 造出 popup + 载入地址，open/blank 判据自洽', () => {
  const frame = open(URL_A, twDoc())
  assert.ok(frame !== undefined, '必须造出 iframe')
  assert.ok(popupRoot() !== undefined, '必须造出 .dsh-tw-editor-popup')
  assert.equal(frame.srcAssignments.length, 1, '首次打开必须赋一次 src')
  assert.equal(frame.dataset.loaded, URL_A, 'dataset.loaded 必须记下已载入地址')
  assert.equal(isEditorPopupOpen(), true, '刚打开 = 可见')
  assert.equal(isEditorPopupBlank(), false, 'story 里有 tiddler frame → 不是空的')
})

console.log('同一个 URL：有内容不重载、空掉的必须重载（用户报障）')

await test('同 URL + 有内容：不得重复赋 src（否则丢 TW 里未保存的草稿状态）', () => {
  const frame = popupFrame()
  const before = frame.srcAssignments.length
  open(URL_A, twDoc({ frames: 1 }))
  assert.equal(frame.srcAssignments.length, before, '内容还在时重开同一草稿不得整页重载')
})

await test('同 URL + story 被删空：必须重载（修复前这里是永久白板）', () => {
  const frame = popupFrame()
  const before = frame.srcAssignments.length
  frame.contentDocument = twDoc({ frames: 0 })
  assert.equal(isEditorPopupBlank(), true, '一条 tiddler frame 都没有 = 空')
  openEditorPopup(URL_A, 'A')
  assert.equal(frame.srcAssignments.length, before + 1, '空掉的弹窗必须重新加载')
  assert.equal(frame.srcAssignments.at(-1), URL_A, '重载仍指向同一个草稿地址')
  assert.equal(frame.dataset.loaded, URL_A, 'dataset.loaded 保持该地址')
})

await test('URL 变了：照常重载', () => {
  const frame = popupFrame()
  frame.contentDocument = twDoc({ frames: 1 })
  const before = frame.srcAssignments.length
  openEditorPopup(URL_B, 'B')
  assert.equal(frame.srcAssignments.length, before + 1, '新草稿地址必须重新加载')
  assert.equal(frame.dataset.loaded, URL_B)
  openEditorPopup(URL_A, 'A') // 复原
})

console.log('关闭 → 再打开 = 重新载入')

await test('closeEditorPopup：隐藏并清掉 loaded 标记', () => {
  closeEditorPopup()
  const frame = popupFrame()
  assert.equal(isEditorPopupOpen(), false, '关闭后不可见')
  assert.equal(frame.dataset.loaded, '', '关闭必须清掉「已载入」标记')
})

await test('关闭后重开同一个 URL：必须重新载入', () => {
  const frame = popupFrame()
  frame.contentDocument = twDoc({ frames: 1 })
  const before = frame.srcAssignments.length
  openEditorPopup(URL_A, 'A')
  assert.equal(isEditorPopupOpen(), true, '重开必须可见')
  assert.equal(frame.srcAssignments.length, before + 1, '关闭再打开必须是新的编辑器载入')
})

console.log('空白判据的保守边界（不得误伤正在编辑的编辑器）')

await test('contentDocument 为 null（跨源）：不判空', () => {
  popupFrame().contentDocument = null
  assert.equal(isEditorPopupBlank(), false, '读不到文档时宁可不动')
})

await test('文档仍在 loading：不判空', () => {
  popupFrame().contentDocument = twDoc({ readyState: 'loading' })
  assert.equal(isEditorPopupBlank(), false, '载入中不得判定为空')
})

await test('不是 TW 页面（没有 story river）：判空', () => {
  popupFrame().contentDocument = twDoc({ river: false })
  assert.equal(isEditorPopupBlank(), true, '没有 .tc-story-river 说明 TW 没起来/被清空')
})

await test('river 存在但没有 tiddler frame：判空', () => {
  popupFrame().contentDocument = twDoc({ frames: 0 })
  assert.equal(isEditorPopupBlank(), true)
})

await test('river 里有 tiddler frame：不判空', () => {
  popupFrame().contentDocument = twDoc({ frames: 2 })
  assert.equal(isEditorPopupBlank(), false)
})

console.log('')
if (failures > 0) {
  console.error(`verify-editor-popup: ${failures} 项失败`)
  process.exit(1)
}
console.log('verify-editor-popup: 全部通过')
process.exit(0)

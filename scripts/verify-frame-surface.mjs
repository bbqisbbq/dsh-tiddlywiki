#!/usr/bin/env node
/**
 * 共享 TW frame 内核的行为单测（v0.22.4）。
 *
 * `src/client/tw-frame.ts` 的 `createTwFrameSurface()` 是 v0.22.4 收敛出来的
 * **唯一** frame 生命周期实现（panel 与 rightbar 共用），是纯 DOM 逻辑、只依赖
 * 全局 document/window/fetch，所以能在 Node 里打桩直跑，不需要浏览器。
 *
 * 断的是这套机制里最容易悄悄坏掉的行为：
 *   1. **空 src 陷阱**（v0.22.3 的 P0）：frame 没载过 TW 地址时，任何「重载」
 *      路径都不得写 `frame.src`（浏览器里 `''` 会按宿主页面 URL 解析，把 DSH
 *      自己载进 iframe）；
 *   2. 可见性 → 只显示真的载入过 TW 的 frame，隐藏即停轮询；
 *   3. 同一个 URL 不重复赋 src（否则编辑器丢未保存内容）；
 *   4. 错误/启动态、重试按钮的 POST /restart 后重刷；
 *   5. tiddler hash：优先同源 `location.hash`（不整页重载），跨源/未就绪才兜底
 *      整页加载，且空 src 时兜底必须放弃；
 *   6. dispose 摘监听/清定时器且幂等。
 *
 *   npx tsx scripts/verify-frame-surface.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-frame-surface
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
    this.disabled = false
    this.parent = null
    this.contentWindow = null
    this.contentDocument = null
    /** Every value ever assigned to `src` — the empty-src trap is judged here. */
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
  listenerCount(type) { return this._listeners.get(type)?.size ?? 0 }
  fire(type, event = {}) { for (const fn of [...(this._listeners.get(type) ?? [])]) fn(event) }
  hasAttribute() { return false }
  setAttribute() {}
  removeAttribute() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 } }
}

/** document-level listeners, so PANEL_RELOAD_EVENT can be fired on demand. */
const documentListeners = new Map()
const documentStub = {
  createElement: (tag) => new StubElement(tag),
  addEventListener(type, fn) {
    if (!documentListeners.has(type)) documentListeners.set(type, new Set())
    documentListeners.get(type).add(fn)
  },
  removeEventListener(type, fn) { documentListeners.get(type)?.delete(fn) },
  body: new StubElement('body'),
  documentElement: new StubElement('html'),
}
const documentListenerCount = (type) => documentListeners.get(type)?.size ?? 0
const fireDocument = (type) => { for (const fn of [...(documentListeners.get(type) ?? [])]) fn({ type }) }

globalThis.document = documentStub
globalThis.window = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  location: { origin: 'http://127.0.0.1:3080' },
}

/* ───────────────────────── /status 打桩 ───────────────────────── */

let statusPayload = { ok: true, status: 'running', twProxy: '/dsh-tiddlywiki/tw/' }
let statusMode = 'ok'
let requests = []
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), method: init?.method ?? 'GET' })
  await new Promise((r) => setTimeout(r, 0))
  if (statusMode === 'reject') throw new Error('network down')
  return { ok: true, status: 200, json: async () => statusPayload }
}

const tw = await import(pathToFileURL(path.join(repoRoot, 'src/client/tw-frame.ts')).href).catch((err) => {
  console.error('FAIL  无法导入 src/client/tw-frame.ts（需要 tsx：`npx tsx scripts/verify-frame-surface.mjs`）')
  console.error(`      ${err && err.message ? err.message : err}`)
  return null
})
if (tw === null) process.exit(1)
const { createTwFrameSurface, loadableFrameUrl, PANEL_RELOAD_EVENT, getTabLabel, setTabLabel } = tw
const { invalidateStatus } = await import(pathToFileURL(path.join(repoRoot, 'src/client/status-cache.ts')).href)

/** The panel's real skin (close enough for behaviour; classes are CSS-only). */
const SKIN = {
  view: 'dsh-tw-view',
  viewDataset: { dshTwView: '' },
  frameWrap: 'dsh-tw-panel-frame-wrap',
  frameWrapStyle: 'flex:1;min-height:0;display:flex;flex-direction:column',
  frame: 'dsh-tw-panel-frame',
  error: 'dsh-tw-panel-error',
}

/** Settle the async /status chain (fetch → json → show*). */
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)) }

function makeSurface() {
  const surface = createTwFrameSurface(SKIN)
  const view = surface.build()
  const wrap = view.children[0]
  const frame = wrap.children[0]
  const errorArea = view.children[1]
  return { surface, view, wrap, frame, errorArea }
}

/** Point the frame at a settled, TW-ready window (or a cross-origin one). */
const PROXY = 'http://127.0.0.1:3080/dsh-tiddlywiki/tw/'
async function readySurface({ contentWindow = { $tw: {}, location: { hash: '' } } } = {}) {
  invalidateStatus()
  requests = []
  statusMode = 'ok'
  statusPayload = { ok: true, status: 'running', twProxy: '/dsh-tiddlywiki/tw/' }
  const made = makeSurface()
  made.frame.contentWindow = contentWindow
  made.surface.setVisible(true)
  await settle()
  made.frame.fire('load')
  return made
}

console.log('DOM 形状与幂等')

await test('build() 造出 view/wrap/frame/error，初始全隐，且可重复调用', () => {
  invalidateStatus()
  const surface = createTwFrameSurface(SKIN)
  const view = surface.build()
  assert.equal(view.className, 'dsh-tw-view', 'view 必须带皮肤类名')
  assert.equal(view.dataset.dshTwView, '', 'view 必须带 data-dsh-tw-view（样式表靠它隐藏被覆盖的会话内容）')
  const frame = view.children[0].children[0]
  assert.equal(frame.className, 'dsh-tw-panel-frame')
  assert.equal(frame.title, 'TiddlyWiki')
  assert.equal(frame.hidden, true, '未载入前必须保持隐藏')
  assert.equal(view.children[1].className, 'dsh-tw-panel-error')
  assert.equal(view.children[1].hidden, true)
  assert.equal(surface.build(), view, 'build() 必须幂等（同一个 view）')
  surface.dispose()
})

console.log('空 src 陷阱 —— 未载入 TW 地址时任何重载路径都不得写 src')

await test('FAB 重载：dataset.loaded 为空时绝不写 src（哪怕 frame 是可见的）', () => {
  invalidateStatus()
  const { surface, frame } = makeSurface()
  // 复现 v0.22.3 的漂移状态：还没载入任何地址，但 frame 已经 hidden=false。
  frame.hidden = false
  fireDocument(PANEL_RELOAD_EVENT)
  assert.deepEqual(frame.srcAssignments, [], '`frame.src` 一旦被赋空串/相对 URL，浏览器会把 DSH 载进 iframe')
  assert.equal(frame.src, '', 'src 必须保持未赋值')
  surface.dispose()
})

await test('hash 兜底：frame 未载入时放弃整页加载（不得拼出 `#标题`）', async () => {
  invalidateStatus()
  statusMode = 'ok'
  statusPayload = { ok: true, status: 'starting' } // 服务没起 → 永远不会有 dataset.loaded
  const { surface, frame } = makeSurface()
  frame.contentWindow = null // 跨源/未就绪 → 走兜底路径
  surface.setVisible(true)
  await settle()
  frame.fire('load')
  assert.equal(surface.openTiddler('某条目'), true, '可见时内核应接受请求')
  assert.deepEqual(frame.srcAssignments, [], '兜底加载不得在空 src 上拼 hash')
  surface.dispose()
})

console.log('可见性 —— 只显示真的载入过 TW 的 frame')

await test('status=running：载入同源代理地址并显示 frame', async () => {
  const { surface, frame, errorArea } = await readySurface()
  assert.deepEqual(frame.srcAssignments, [PROXY], '应把相对 twProxy 按页面 origin 拼成绝对 URL')
  assert.equal(frame.dataset.loaded, PROXY, 'dataset.loaded 必须记录真实地址（唯一判据）')
  assert.equal(loadableFrameUrl(frame.dataset), PROXY)
  assert.equal(frame.hidden, false, '运行中必须显示 frame')
  assert.equal(errorArea.hidden, true, '运行中不得显示错误区')
  surface.dispose()
})

await test('setVisible(false)：隐藏 frame 并停掉有界轮询', async () => {
  const { surface, frame } = await readySurface()
  surface.setVisible(false)
  assert.equal(frame.hidden, true, '隐藏的 surface 必须把 frame 藏起来')
  const before = requests.length
  await new Promise((r) => setTimeout(r, 1600))
  assert.equal(requests.length, before, '隐藏后不得继续轮询 /status')
  surface.dispose()
})

await test('重复显示：URL 未变则不得重设 src（否则编辑器丢未保存内容）', async () => {
  const { surface, frame } = await readySurface()
  const before = frame.srcAssignments.length
  surface.setVisible(false)
  surface.setVisible(true)
  await settle()
  assert.equal(frame.srcAssignments.length, before, '同一 URL 不得重复赋 src')
  assert.equal(frame.hidden, false)
  surface.dispose()
})

await test('FAB 重载：已载入的 frame 重新赋同一个 URL（整页重载）', async () => {
  const { surface, frame } = await readySurface()
  const before = frame.srcAssignments.length
  fireDocument(PANEL_RELOAD_EVENT)
  assert.equal(frame.srcAssignments.length, before + 1, '已载入的可见 frame 必须被重载')
  assert.equal(frame.srcAssignments.at(-1), PROXY)
  surface.dispose()
})

await test('隐藏但已载入的 frame 仍应被 FAB 重载（显式重载要覆盖关掉的面板）', async () => {
  const { surface, frame } = await readySurface()
  surface.setVisible(false)
  const before = frame.srcAssignments.length
  fireDocument(PANEL_RELOAD_EVENT)
  assert.equal(
    frame.srcAssignments.length,
    before + 1,
    '显式重载请求必须覆盖隐藏的 surface——否则「关掉面板 → 重载 → 再打开」会看到旧资源',
  )
  assert.equal(frame.srcAssignments.at(-1), PROXY)
  surface.dispose()
})

console.log('启动 / 错误 / 重试')

await test('status=starting：显示启动提示并保持 frame 隐藏', async () => {
  invalidateStatus()
  requests = []
  statusPayload = { ok: true, status: 'starting' }
  const { surface, frame, errorArea } = makeSurface()
  surface.setVisible(true)
  await settle()
  assert.equal(errorArea.hidden, false, '启动中必须显示提示区')
  assert.match(errorArea.children[0].textContent, /正在启动/, '应显示「正在启动」文案')
  assert.equal(frame.hidden, true, '启动中不得显示空 frame')
  // 有界自动重探：1.5s 一次。注意 status-cache 有 2s TTL + 在途合并，所以
  // 1.5s 那一跳会被合并掉，要等过 TTL 才能看到第二次真实 HTTP。
  const before = requests.length
  await new Promise((r) => setTimeout(r, 3300))
  assert.ok(requests.length > before, '启动中必须有界自动重探')
  surface.dispose()
  const frozen = requests.length
  await new Promise((r) => setTimeout(r, 1600))
  assert.equal(requests.length, frozen, 'dispose 后必须停止轮询')
})

await test('错误态：显示原因 + 「重试」按钮；点击后 POST /restart 并恢复', async () => {
  invalidateStatus()
  requests = []
  statusPayload = { ok: true, status: 'stopped', error: 'TW 起不来' }
  const { surface, frame, errorArea } = makeSurface()
  surface.setVisible(true)
  await settle()
  assert.equal(errorArea.children[0].textContent, 'TiddlyWiki 服务不可用')
  assert.equal(errorArea.children[1].textContent, 'TW 起不来', '必须带上真实原因')
  const retry = errorArea.children[2]
  assert.equal(retry.textContent, '重试')
  const before = requests.length
  statusPayload = { ok: true, status: 'running', twProxy: '/dsh-tiddlywiki/tw/' }
  retry.fire('click')
  assert.equal(retry.disabled, true, '重试期间按钮必须禁用，避免叠加重启')
  assert.equal(retry.textContent, '重启中…')
  // /status 缓存 2s 会把重启后的重刷合并掉，这里手动失效以验证「重试真的恢复」
  invalidateStatus()
  await settle()
  const restart = requests.slice(before).find((r) => r.method === 'POST')
  assert.ok(restart, '点击重试必须 POST /restart')
  assert.equal(frame.dataset.loaded, PROXY, '重启成功后必须重新载入 TW 地址')
  assert.equal(errorArea.hidden, true, '恢复后必须收起错误区')
  surface.dispose()
})

await test('status=null（服务不可达）：走错误态', async () => {
  invalidateStatus()
  statusMode = 'reject'
  const { surface, errorArea } = makeSurface()
  surface.setVisible(true)
  await settle()
  assert.equal(errorArea.hidden, false)
  assert.match(errorArea.children[1].textContent, /无法访问/, '应显示无法访问 /status')
  statusMode = 'ok'
  surface.dispose()
})

console.log('tiddler hash 导航')

await test('同源就绪：走 location.hash（不整页重载）', async () => {
  const { surface, frame } = await readySurface()
  const before = frame.srcAssignments.length
  assert.equal(surface.openTiddler('中文 标题'), true, '可见时应接受请求')
  assert.equal(frame.contentWindow.location.hash, `#${encodeURIComponent('中文 标题')}`)
  assert.equal(frame.srcAssignments.length, before, '同源 hash 导航不得触发整页重载')
  surface.dispose()
})

await test('跨源/未就绪：兜底整页加载 = dataset.loaded 基准 + hash', async () => {
  const { surface, frame } = await readySurface({ contentWindow: null })
  const before = frame.srcAssignments.length
  surface.openTiddler('条目 B')
  assert.equal(frame.srcAssignments.length, before + 1, '兜底必须整页加载一次')
  assert.equal(
    frame.srcAssignments.at(-1),
    `${PROXY}#${encodeURIComponent('条目 B')}`,
    '兜底 URL 必须以 dataset.loaded 为基准并带上 hash',
  )
  surface.dispose()
})

await test('隐藏时 openTiddler 返回 false（链接要能落回中央面板）', async () => {
  const { surface } = await readySurface()
  surface.setVisible(false)
  assert.equal(surface.openTiddler('任何条目'), false)
  surface.dispose()
})

console.log('共享标签 / dispose')

await test('内核刷新共享 chip 标签（panel 也吃这份状态）', async () => {
  setTabLabel('旧名')
  const { surface } = await readySurface() // payload 不带 ui.tabLabel → 标签保持不动
  assert.equal(getTabLabel(), '旧名', '没有 ui 时不得改动共享标签')
  statusPayload = { ok: true, status: 'running', twProxy: '/dsh-tiddlywiki/tw/', ui: { tabLabel: '新名' } }
  invalidateStatus()
  surface.setVisible(false)
  surface.setVisible(true)
  await settle()
  assert.equal(getTabLabel(), '新名', '拿到 ui.tabLabel 时必须刷新共享标签')
  setTabLabel('知识库')
  surface.dispose()
})

await test('dispose：摘掉重载监听、可重复调用、之后不得再动 src', async () => {
  const before = documentListenerCount(PANEL_RELOAD_EVENT)
  const { surface, frame, view } = await readySurface()
  assert.equal(documentListenerCount(PANEL_RELOAD_EVENT), before + 1, 'surface 活着时应挂着重载监听')
  surface.dispose()
  assert.equal(documentListenerCount(PANEL_RELOAD_EVENT), before, 'dispose 必须摘掉重载监听')
  const assignments = frame.srcAssignments.length
  fireDocument(PANEL_RELOAD_EVENT)
  assert.equal(frame.srcAssignments.length, assignments, 'dispose 后不得再动 src')
  surface.dispose() // 幂等
  assert.equal(view.parent, null, 'view 必须已从 DOM 摘掉')
})

globalThis.fetch = undefined
console.log(failures === 0 ? '\nFRAME SURFACE CHECKS OK' : `\nFRAME SURFACE CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

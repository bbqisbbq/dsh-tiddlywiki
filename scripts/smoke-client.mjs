// Throwaway smoke test: load lib/client.js in Node with browser-global stubs
// to catch module-scope reference errors that would break the web UI on load.
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = await readFile(join(root, 'lib', 'client.js'), 'utf8')

global.window = globalThis
let captured = null
global.window.__ModuleLoader__ = { load: (mod) => { captured = mod } }

const noop = () => {}
const stubEl = () => ({
  style: {}, dataset: {}, className: '', innerHTML: '', textContent: '', value: '',
  setAttribute: noop, removeAttribute: noop, appendChild: noop, removeChild: noop,
  addEventListener: noop, removeEventListener: noop, focus: noop, click: noop,
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  getContext: () => null,
})
global.document = {
  createElement: stubEl, createElementNS: stubEl,
  body: { appendChild: noop, classList: { add: noop, remove: noop, contains: () => false } },
  head: { appendChild: noop },
  // CodeMirror 6 feature-detects the CSSOM on module scope ("X" in style).
  documentElement: { style: {}, classList: { add: noop } },
  querySelector: () => null, querySelectorAll: () => [],
  getElementById: () => null, addEventListener: noop, removeEventListener: noop,
}
global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' })
global.URL = URL
global.location = { origin: 'http://127.0.0.1:3080', pathname: '/', search: '', hash: '' }
if (!global.navigator) {
  Object.defineProperty(global, 'navigator', { value: { userAgent: 'node-smoke' }, configurable: true })
}
global.requestAnimationFrame = (cb) => setTimeout(cb, 0)
global.cancelAnimationFrame = (id) => clearTimeout(id)
global.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop })
global.localStorage = { getItem: () => null, setItem: noop, removeItem: noop }
global.sessionStorage = { getItem: () => null, setItem: noop, removeItem: noop }

eval(src)
if (!captured) throw new Error('__ModuleLoader__.load was not called')
console.log('load() called with id =', captured.id)

const module = { exports: {} }
const required = []
/**
 * React 的最小替身。**必须覆盖 bundle 在模块作用域真的用到的那些 API**：
 * `tool-views.ts` 在模块作用域 `React.createContext(...)`（v0.28.13 复核时发现），
 * 而这里少了它 → 这个「catch module-scope reference errors」的守门自那次改动起
 * 一直抛 `c.createContext is not a function`，等于长期空转（真红，没人看）。
 * 所以 stub 要跟着走：漏一个 API 具体来说就是漏一次检查。
 */
const reactStub = {
  createElement: () => ({}),
  createContext: () => ({ Provider: 'Provider', Consumer: 'Consumer' }),
  useContext: () => undefined,
  useState: () => [],
  useEffect: noop,
  useLayoutEffect: noop,
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: () => ({ current: null }),
  forwardRef: (fn) => fn,
  memo: (fn) => fn,
  Fragment: 'Fragment',
}
const require = (name) => {
  required.push(name)
  if (name === 'react') return reactStub
  throw new Error('unexpected require: ' + name)
}
const result = captured.factory(require)
console.log('factory required:', required.join(', ') || '(none)')
console.log('factory returned exports:', result === undefined ? '(undefined)' : typeof result)
console.log('CLIENT SMOKE OK')

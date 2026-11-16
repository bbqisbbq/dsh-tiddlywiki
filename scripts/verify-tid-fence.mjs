#!/usr/bin/env node
/**
 * 消息内代码块预览（`conversation.chat.markdown.fence`，v0.36.0）的接线守门。
 *
 * WHY THIS EXISTS
 * ---------------
 * 这个座位是 DSH **0.2.2-rc.3** 才有的（rc.1 的座位表里还没有），形状也和别的座位
 * 都不一样 —— 它是 `kind: hoc` 的**包裹层**：`id` 必填（层标识）、`key` 是**派发键**
 * （= 代码块语言）、`order` 决定嵌套次序。抄错任何一项都不会报错，只会**静默不渲染**
 * 或顶掉官方那一层（`diff`/`math`/`patch` 已被宿主占用）。
 *
 * 这里钉住四类"错了也不报错"的地方：
 *   1. **注册形状**：必须是 `slots.inject(FENCE_SLOT, () => slots.register({ name, id, key, order }))`
 *      —— 漏 `inject` 等于在座位还没声明时注册（静默失败）；漏 `key` 就变成通配层
 *      （包裹所有代码块，包括官方的 diff/math）；两个语言共用一个 `id` 会互相顶掉。
 *   2. **流式不下渲染**：消息还在流式输出时每个 token 都会重渲染这一层，必须直接还
 *      `children`，否则既是请求风暴又是闪烁。
 *   3. **hook 顺序**：`streaming` 会从 true 变 false —— 早退之后再挂 hook 会让 hook
 *      顺序在两次渲染间变化，React 直接抛错。所有 hook 必须在任何 `return` 之前。
 *   4. **绝不空白**：请求中 / 失败 / 空正文都要退回原始代码块（`children`），渲染还必须
 *      走宿主 `/render`（铁律 #7：TW 原文不许直接进 DSH 页面的 DOM）。
 *
 * 纯源码级、只读、零网络、零 DOM（客户端是 React + 浏览器服务，node 里跑不起来）。
 *
 *   node scripts/verify-tid-fence.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-tid-fence
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8')

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

/** 去掉注释 —— 断言要在剥注释的源码上跑（本模块的注释里写着座位名与坏写法）。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
}

/** 取 `name: <anchor>` 所在的那个对象字面量（注册选项）。 */
function objectAround(source, anchor) {
  const at = source.indexOf(anchor)
  assert.ok(at >= 0, `源码里找不到 ${anchor}`)
  const open = source.lastIndexOf('{', at)
  assert.ok(open >= 0, `${anchor} 外面没有对象字面量`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  throw new Error(`${anchor} 的对象字面量没有闭合`)
}

const fenceSrc = stripComments(read('src/client/tid-fence.ts'))
const indexSrc = stripComments(read('src/client/index.ts'))
const cssRaw = read('src/client/styles-css.ts')
const i18nFrame = read('src/client/i18n-frame.ts')

// ── 1. 座位名与注册形状 ───────────────────────────────────────────────────────

test('座位名是宿主的 conversation.chat.markdown.fence（常量只此一处）', () => {
  assert.match(
    fenceSrc,
    /const FENCE_SLOT = 'conversation\.chat\.markdown\.fence'/,
    'tid-fence.ts 必须把座位名写成常量 FENCE_SLOT（verify-dsh-contract 靠它采集）',
  )
  assert.ok(
    !/['"`]conversation\.chat\.markdown\.fence['"`]/.test(fenceSrc.replace(/const FENCE_SLOT = 'conversation\.chat\.markdown\.fence'/, '')),
    '座位名只许出现在 FENCE_SLOT 常量里，别处再写一遍字面量就会漂',
  )
})

test('注册在 slots.inject 的回调里（座位未声明时静默跳过，不是硬注册）', () => {
  assert.match(fenceSrc, /slots\.inject\(\s*FENCE_SLOT\s*,/, '必须 slots.inject(FENCE_SLOT, () => …)')
  assert.match(
    fenceSrc,
    /slots\.inject\(\s*FENCE_SLOT\s*,\s*\(\)\s*=>\s*slots\.register\(/,
    'register 必须在 inject 的回调内（老宿主没有该座位时 inject 返回 undefined，就不注册）',
  )
})

test('hoc 座位三件套齐全：id（每层唯一）+ key（语言）+ order', () => {
  const block = objectAround(fenceSrc, 'name: FENCE_SLOT')
  assert.match(block, /id:\s*`\$\{FENCE_LAYER_ID_PREFIX\}\$\{lang\}`/, 'id 必须是「前缀 + 语言」——两个语言共用一个 id 会互相顶掉')
  assert.match(block, /key:\s*lang/, 'key 是派发键（= 代码块语言）；漏了就成了通配层，连官方的 diff/math 也包进来')
  assert.match(block, /order:\s*FENCE_ORDER/, 'order 必须显式给出（升序嵌套，越小越靠外）')
})

test('语言表与非官方占用：tid / tiddlywiki，且不撞 diff / math / patch', () => {
  const langs = fenceSrc.match(/const FENCE_LANGUAGES = \[([^\]]*)\]/)
  assert.ok(langs !== null, '找不到 FENCE_LANGUAGES 数组字面量')
  const values = [...langs[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(values, ['tid', 'tiddlywiki'], `语言表被改成了 ${values.join('/')}（守门与文档都按这两个写）`)
  const taken = fenceSrc.match(/const FENCE_TAKEN_LANGUAGES = \[([^\]]*)\]/)
  assert.ok(taken !== null, '找不到 FENCE_TAKEN_LANGUAGES（宿主 keyDomain 已占用的 key）')
  const takenValues = [...taken[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(takenValues, ['diff', 'math', 'patch'], '宿主已占用的 key 变了？去座位目录核对 keyDomain')
  const clashes = values.filter((v) => takenValues.includes(v))
  assert.deepEqual(clashes, [], `这些语言已被官方占用，注册会顶掉内置渲染：${clashes.join(', ')}`)
})

// ── 2. streaming / hook 顺序 / 兜底 ──────────────────────────────────────────

test('所有 hook 都在任何 return 之前（streaming 变化不会打乱 hook 顺序）', () => {
  const firstReturn = fenceSrc.indexOf('if (streaming || doc.text.trim()')
  assert.ok(firstReturn > 0, '找不到「streaming 早退」那段——本守门的判据依赖它')
  const hookAt = ['React.useMemo(', 'React.useState(', 'React.useEffect('].map((needle) => {
    const at = fenceSrc.indexOf(needle)
    assert.ok(at >= 0, `找不到 ${needle}`)
    return at
  })
  for (const at of hookAt) {
    assert.ok(
      at < firstReturn,
      'hook 出现在 streaming 早退之后：消息流结束时 streaming 由 true 变 false，hook 顺序变化会让 React 直接抛错',
    )
  }
})

test('流式输出期间直接返回宿主的原始代码块（不发请求、不闪烁）', () => {
  assert.match(fenceSrc, /if \(streaming \|\| doc\.text\.trim\(\)\.length === 0\) return props\.children \?\? null/, '流式/空正文必须原样返回 children')
  // 第一个 `if (streaming` 就是 effect 里的短路（渲染函数里那个落在它之后）；直接比全局下标，
  // 不去切固定长度的窗口 —— 窗口一改长度就假红（v0.36.0 写这条时踩过）。
  const guardAt = fenceSrc.indexOf('if (streaming')
  const fetchAt = fenceSrc.indexOf('fetchRenderText(')
  assert.ok(guardAt >= 0, '必须有一条 streaming 短路')
  assert.ok(fetchAt >= 0, '必须调用 fetchRenderText()')
  assert.ok(guardAt < fetchAt, 'streaming 短路必须在发请求之前（否则流式期间每个 token 都发一次 /render）')
})

test('渲染只走宿主 /render（铁律 #7），不许直连 TW 的 /tw/render', () => {
  assert.match(
    fenceSrc,
    /import \{ fetchRenderText \} from '\.\/render-fetch\.ts'/,
    '必须复用 render-fetch.ts 的 fetchRenderText（POST /render 的唯一文本入口）',
  )
  assert.ok(!fenceSrc.includes('/tw/'), 'tid-fence.ts 里不得出现 TW 代理路径 /tw/')
  assert.ok(!/tw\/render/.test(fenceSrc), '不得直连 TW 的 /tw/render（未净化，注入点在同源页面里）')
})

test('绝不空白：失败分支把原始代码块还回去', () => {
  const failedAt = fenceSrc.indexOf('else if (failed)')
  assert.ok(failedAt >= 0, '找不到 failed 分支')
  const branch = fenceSrc.slice(failedAt, failedAt + 400)
  assert.match(branch, /source/, '失败分支必须渲染原始代码块（source / children），不能只写一句提示')
  assert.match(branch, /t\('frame\.tidPreviewFallback'\)/, '失败分支要给一句人话（复用 frame.tidPreviewFallback）')
})

test('请求在路上时也先给原文（不留空壳）', () => {
  const at = fenceSrc.indexOf('else if (html === null)')
  assert.ok(at >= 0, '找不到「首帧/请求中」分支')
  assert.match(fenceSrc.slice(at, at + 200), /source/, '请求中的分支必须给原始代码块，不能什么都不渲染')
})

// ── 3. 装配与样式 ────────────────────────────────────────────────────────────

test('index.ts 走 safeMount 接线并回收 disposer', () => {
  assert.match(indexSrc, /safeMount\('tid fence layers'/, 'index.ts 必须以 safeMount 挂载（一处失败不拖垮整半）')
  assert.match(indexSrc, /registerTidFences\(ctx\.slots/, 'index.ts 必须把 ctx.slots 传进 registerTidFences')
  assert.match(indexSrc, /disposers\.push\(\.\.\.registerTidFences/, '返回的 disposer 必须进 disposers（否则卸载后注册还在）')
})

test('外壳样式存在（没有 CSS 就等于把裸 HTML 塞进聊天流）', () => {
  for (const rule of ['.dsh-tw-fence {', '.dsh-tw-fence-head', '.dsh-tw-fence-body', '.dsh-tw-fence-toggle']) {
    assert.ok(cssRaw.includes(rule), `styles-css.ts 缺少 ${rule}`)
  }
  assert.ok(cssRaw.includes('.dsh-tw-fence-toggle:focus-visible'), '新按钮要补 :focus-visible（键盘用户）')
})

// ── 4. 文案走 t() ───────────────────────────────────────────────────────────

test('文案全部走 t()，且键都在 i18n-frame.ts 里（zh / en 各一份）', () => {
  const keys = [...fenceSrc.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1])
  assert.ok(keys.length >= 3, `只找到 ${keys.length} 个 t('…') 调用——文案必须走 t()`)
  const zhAt = i18nFrame.indexOf('zh: {')
  const enAt = i18nFrame.indexOf('en: {')
  const zhBlock = i18nFrame.slice(zhAt, enAt)
  const enBlock = i18nFrame.slice(enAt)
  for (const key of keys) {
    assert.ok(zhBlock.includes(`'${key}':`), `i18n-frame.ts 的 zh 缺 ${key}`)
    assert.ok(enBlock.includes(`'${key}':`), `i18n-frame.ts 的 en 缺 ${key}`)
  }
})

console.log(failures === 0 ? 'TID FENCE CHECKS OK（hoc 注册形状 · 流式短路 · 净渲染 · 不空白）' : `TID FENCE CHECK FAILED（${failures} 项）`)
process.exit(failures === 0 ? 0 : 1)

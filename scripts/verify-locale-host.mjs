#!/usr/bin/env node
/**
 * 宿主 locale 集成的守门（v0.33.0，⑥b）。
 *
 * 这一版**没有**把 470+ 条文案搬进宿主的类型化命名空间，而是「注册但不搬」：
 * 目录仍然是 `i18n-catalog.ts` 那一份，宿主有 locale 服务时 `t()` 先问它、否则回本地表。
 * 这条守门钉住这个形状 —— 因为坏掉的每一种方式都是**沉默**的：
 *   1. 注册的必须是**同一份** `MESSAGES`（另抄一份 ⇒ 两份说法慢慢分叉，而界面看起来正常）；
 *   2. 服务必须**可选**（`ctx.get('locale')`，没有就跳过 —— 老版本 DSH 不能崩）；
 *   3. `t()` 必须**回落到本地表**（宿主回空串 / 回键名 / 抛错时不能把界面变空）；
 *   4. 接线必须在 `safeMount` 里（注册失败不能拖垮整个客户端挂载）。
 *
 *   node scripts/verify-locale-host.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-locale-host
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOCALE_NAMESPACE, hasHostTranslator, registerLocaleWithHost, translate } from '../lib/index.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) =>
  fs.readFileSync(path.join(repoRoot, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '')

const hostSrc = read('src/client/locale-host.ts')
const i18nSrc = read('src/client/i18n.ts')
const indexSrc = read('src/client/index.ts')

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

test('命名空间常量稳定（宿主侧按它解析）', () => {
  assert.equal(LOCALE_NAMESPACE, 'dsh-tiddlywiki')
})

test('没有 locale 服务时什么都不做（老版本 DSH 不受影响）', () => {
  assert.deepEqual(registerLocaleWithHost(undefined), [])
  assert.deepEqual(registerLocaleWithHost(() => undefined), [])
  assert.equal(hasHostTranslator(), false, '没注册就绝不该有宿主解析器')
})

test('注册成功时用的是同一份 MESSAGES，并且会 bind 出解析器', () => {
  const registered = []
  const fake = {
    register(ns, catalogs) {
      registered.push({ ns, catalogs })
      return () => { registered.push('disposed') }
    },
    bind(ns) {
      return (key) => (ns === LOCALE_NAMESPACE ? `HOST:${key}` : key)
    },
  }
  const disposers = registerLocaleWithHost((name) => (name === 'locale' ? fake : undefined))
  assert.equal(registered.length, 1, 'register 必须调用一次')
  assert.equal(registered[0].ns, LOCALE_NAMESPACE)
  assert.ok(registered[0].catalogs.zh && registered[0].catalogs.en, 'zh/en 两套都必须给')
  assert.ok(Object.keys(registered[0].catalogs.zh).length > 400, '注册的必须是完整目录（不是空表）')
  assert.equal(typeof disposers[0], 'function', 'register 返回的 disposer 必须回收')
  assert.equal(hasHostTranslator(), true)
  assert.equal(translate('chrome.dockQuickNote', undefined, () => 'LOCAL'), 'HOST:chrome.dockQuickNote', '宿主有解析器时优先用它')
})

test('宿主抛错 / 回空串 / 回键名 → 一律回落本地表（界面不能变空）', () => {
  // 抛错
  registerLocaleWithHost(() => ({ register: () => { throw new Error('boom') } }))
  assert.equal(translate('k', undefined, () => 'LOCAL'), 'LOCAL')
  // 回空串 / 回键名 / 非字符串
  registerLocaleWithHost(() => ({
    register: () => () => {},
    bind: () => (key) => (key === 'empty' ? '' : key === 'echo' ? key : 42),
  }))
  assert.equal(translate('empty', undefined, () => 'LOCAL'), 'LOCAL', '空串必须回落')
  assert.equal(translate('echo', undefined, () => 'LOCAL'), 'LOCAL', '把键名原样回来说明"没有这条"，必须回落')
  assert.equal(translate('weird', undefined, () => 'LOCAL'), 'LOCAL', '非字符串必须回落')
})

test('t() 走 translate（宿主优先 + 本地兜底），本地表逻辑仍在', () => {
  assert.match(i18nSrc, /return translate\(key, vars, fromLocalTable\)/, 't() 必须委托给 translate')
  assert.match(i18nSrc, /function fromLocalTable\(/, '本地表解析必须保留')
  assert.match(i18nSrc, /fallback\?\.\[key\] \?\? key/, '未知键回落到默认语言、再回落到键名本身')
})

test('注册的目录只有一份：i18n-host 从 catalog 引，不自己抄表', () => {
  assert.match(hostSrc, /import \{ MESSAGES \} from '\.\/i18n-catalog\.ts'/, '必须复用 i18n-catalog.ts 的 MESSAGES')
  assert.ok(!/const MESSAGES\s*=/.test(hostSrc), '不得在 i18n-host.ts 里另建一份目录')
  assert.match(hostSrc, /get\('locale'\)/, '服务按名字可选读取')
})

test('接线在 safeMount 里（注册失败不拖垮挂载）', () => {
  assert.match(indexSrc, /safeMount\('locale registration', \(\) => disposers\.push\(\.\.\.registerLocaleWithHost\(ctx\.get\)\)\)/)
})

console.log(failures === 0 ? 'LOCALE HOST OK' : `LOCALE HOST FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

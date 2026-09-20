#!/usr/bin/env node
/**
 * 配置补丁校验守门（v0.25.0）——纯函数断言，不 spawn TW。
 *
 * 背景：`/admin/config` 以前把 `JSON.parse(body)` 直接交给 `config.set()`，于是
 * 任意 JSON 都会落进 wiki 的配置 tiddler：数组体会变成 `{"0":1,"1":2}` 这样的永久
 * 垃圾键，而 `{"git":{"debounceMs":"abc"}}` 这种类型错误会一路穿透到
 * `setTimeout(fn, "abc")`（被当作 0 → 每次写入都立刻 commit）。这里钉住
 * `normalizeConfigPatch()` 的三条契约：**范围夹取** / **类型错误拒绝** /
 * **危险键拒绝**，外加「未知键照常透传」（配置形状刻意可扩展）。
 *
 *   node scripts/verify-config-patch.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-config-patch
 */
import assert from 'node:assert/strict'
import { ConfigPatchError, normalizeConfigPatch } from '../lib/index.js'

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

test('非对象体一律拒绝（数组 / null / 字符串）', () => {
  for (const body of [[1, 2], null, 'nope', 42, undefined]) {
    assert.throws(() => normalizeConfigPatch(body), ConfigPatchError, `${JSON.stringify(body)} 应被拒绝`)
  }
})

test('越界数字被夹取到宿主真实边界（而不是静默回落默认值）', () => {
  assert.equal(normalizeConfigPatch({ bridge: { port: 70_000 } }).bridge.port, 65_535)
  assert.equal(normalizeConfigPatch({ bridge: { port: 0 } }).bridge.port, 1)
  assert.equal(normalizeConfigPatch({ startup: { readyTimeoutMs: 1_000 } }).startup.readyTimeoutMs, 5_000)
  assert.equal(normalizeConfigPatch({ startup: { readyTimeoutMs: 10_000_000 } }).startup.readyTimeoutMs, 600_000)
  assert.equal(normalizeConfigPatch({ ui: { allArticles: { pageSize: 0 } } }).ui.allArticles.pageSize, 1)
  assert.equal(normalizeConfigPatch({ git: { debounceMs: 60_000 } }).git.debounceMs, 60_000)
  // 小数被取整（端口/条数/毫秒都必须是整数）
  assert.equal(normalizeConfigPatch({ bridge: { port: 8618.6 } }).bridge.port, 8619)
})

test('类型错误拒绝并点名字段（不得穿透到 setTimeout / 模板）', () => {
  assert.throws(() => normalizeConfigPatch({ git: { debounceMs: 'abc' } }), /git\.debounceMs/, '字符串 debounceMs 必须被拒')
  assert.throws(() => normalizeConfigPatch({ git: { debounceMs: NaN } }), ConfigPatchError)
  assert.throws(() => normalizeConfigPatch({ bridge: { port: '8618' } }), /bridge\.port/, '字符串端口必须被拒')
  assert.throws(() => normalizeConfigPatch({ git: { autoCommit: 'yes' } }), /git\.autoCommit/, '非布尔开关必须被拒')
  assert.throws(() => normalizeConfigPatch({ note: { workspaceMark: 1 } }), /note\.workspaceMark/)
  assert.throws(() => normalizeConfigPatch({ ui: { sidebarLabel: 5 } }), /ui\.sidebarLabel/, '非字符串标签名必须被拒')
})

test('合法值原样通过（含字符串型 token / 未知扩展键）', () => {
  const patch = normalizeConfigPatch({
    note: { tag: 'inbox', workspaceMark: false },
    bridge: { enabled: true, port: 8618, token: 'secret' },
    ui: { sendToAgent: { enabled: false, token: 't' } },
    wechat: { enabled: true, adapter: 'publish-note-imgs' },
    futureThing: { anything: 1 },
  })
  assert.equal(patch.note.tag, 'inbox')
  assert.equal(patch.note.workspaceMark, false)
  assert.equal(patch.bridge.token, 'secret')
  assert.equal(patch.ui.sendToAgent.token, 't')
  assert.equal(patch.wechat.adapter, 'publish-note-imgs')
  assert.deepEqual(patch.futureThing, { anything: 1 }, '未知键（未来字段）必须透传')
})

test('危险键拒绝（原型污染 / 合并歧义）', () => {
  // 用 JSON.parse 构造 `__proto__`：对象字面量里的 __proto__ 设置的是原型，不是键。
  const polluted = JSON.parse('{"__proto__":{"x":1}}')
  assert.throws(() => normalizeConfigPatch(polluted), /__proto__/, '__proto__ 必须被拒')
  assert.throws(() => normalizeConfigPatch({ constructor: { prototype: 1 } }), /constructor/)
  assert.throws(() => normalizeConfigPatch({ ui: { prototype: 1 } }), /prototype/)
})

console.log(failures === 0 ? '\nCONFIG PATCH OK' : `\nCONFIG PATCH FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env node
/**
 * 客户端 `/status` 共享读取器的单测（v0.19.5）。
 *
 * `src/client/status-cache.ts` 是纯逻辑模块（只依赖全局 fetch），所以可以在
 * Node 里直接 import 并打桩，无需浏览器。守门三条：
 *   1. 并发调用合并成一次 HTTP（FAB / dock / rightbar / sidebar 在加载瞬间
 *      同时读配置时，此前每个调用者各发一次请求，而 host 每处理一次 /status
 *      要起最多 5 个 git 进程）；
 *   2. 失败（网络错误 / 非 2xx / 返回 null）不进缓存——下一次必须重试；
 *   3. `invalidateStatus()` 立即失效（设置页保存后马上读新值）。
 *
 *   node scripts/verify-status-cache.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-status-cache
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

const originalFetch = globalThis.fetch
let calls = 0
let mode = 'ok'
let payload = { ok: true, status: 'running', ui: { showQuickNoteDock: false, tabLabel: 'KB' } }

globalThis.fetch = async () => {
  calls++
  // Small delay so concurrent callers really do overlap.
  await new Promise((r) => setTimeout(r, 20))
  if (mode === 'reject') throw new Error('network down')
  if (mode === 'http500') return { ok: false, status: 500, json: async () => ({}) }
  return { ok: true, status: 200, json: async () => payload }
}

// Import the TypeScript SOURCE through the repo's tsx loader (already a
// devDependency; no build artifact is added to lib/ just for this test).
const mod = await import(pathToFileURL(path.join(repoRoot, 'src/client/status-cache.ts')).href).catch((err) => {
  console.error('FAIL  无法导入 src/client/status-cache.ts（需要 tsx：npm i，或 `npx tsx scripts/verify-status-cache.mjs`）')
  console.error(`      ${err && err.message ? err.message : err}`)
  return null
})
if (mod === null) process.exit(1)
const { fetchStatus, invalidateStatus } = mod

await test('并发调用合并成一次请求（in-flight coalescing）', async () => {
  calls = 0
  invalidateStatus()
  const [a, b, c] = await Promise.all([fetchStatus(), fetchStatus(), fetchStatus()])
  assert.equal(calls, 1, `三个并发调用应只发一次 HTTP，实际 ${calls} 次`)
  assert.equal(a?.status, 'running', '应返回解析后的 payload')
  assert.equal(b, a, '并发调用应共享同一个 promise 结果')
  assert.equal(c, a, '并发调用应共享同一个 promise 结果')
})

await test('TTL 内的后续调用复用缓存（不再发请求）', async () => {
  const before = calls
  const again = await fetchStatus()
  assert.equal(calls, before, `TTL 内不得再发请求，实际新增 ${calls - before} 次`)
  assert.equal(again?.status, 'running')
})

await test('失败（网络异常）不进缓存，下一次必须重试', async () => {
  invalidateStatus()
  mode = 'reject'
  calls = 0
  const first = await fetchStatus()
  assert.equal(first, null, '网络异常应解析为 null（调用方按离线处理）')
  assert.equal(calls, 1, '第一次应发请求')
  const second = await fetchStatus()
  assert.equal(second, null, '第二次也应为 null')
  assert.equal(calls, 2, `失败结果不得被缓存 2s：第二次必须重试（实际总计 ${calls} 次）`)
  mode = 'ok'
})

await test('非 2xx 同样不缓存', async () => {
  invalidateStatus()
  mode = 'http500'
  calls = 0
  assert.equal(await fetchStatus(), null, '5xx 应解析为 null')
  assert.equal(await fetchStatus(), null, '5xx 第二次也应为 null')
  assert.equal(calls, 2, `5xx 结果不得被缓存：实际总计 ${calls} 次`)
  mode = 'ok'
})

await test('invalidateStatus() 立即失效缓存', async () => {
  invalidateStatus()
  calls = 0
  payload = { ok: true, status: 'running', ui: { tabLabel: '旧' } }
  const first = await fetchStatus()
  assert.equal(first?.ui?.tabLabel, '旧', '首次读取旧值')
  payload = { ok: true, status: 'running', ui: { tabLabel: '新' } }
  invalidateStatus()
  const second = await fetchStatus()
  assert.equal(calls, 2, `失效后必须重新请求：实际 ${calls} 次`)
  assert.equal(second?.ui?.tabLabel, '新', '应读到新值')
})

globalThis.fetch = originalFetch
console.log(failures === 0 ? '\nSTATUS CACHE CHECKS OK' : `\nSTATUS CACHE CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

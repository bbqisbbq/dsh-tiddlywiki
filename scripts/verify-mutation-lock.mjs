#!/usr/bin/env node
/**
 * 「同一个变更锁」守门（v0.30.12）——不 spawn TW、不写文件，秒级。
 *
 * 背景（真实缺陷）：`/restart` 与 `/sync` 早就互相排斥，**但每一半各自持有自己的
 * 私有标志**：`routes.ts` 在 `registerRoutes()` 里放了 `mutationInFlight`，而
 * `admin-routes.ts` **一个都没有**。于是设置页可以在 `/sync` 正排干 syncer 队列时按
 * 「重启」（`/admin/restart`），或在与重启重叠时跑初始化（`/admin/seeds/run`）——
 * 两者都会停下 TW 子进程并抢同一个队列，正是这把锁当初要防的事。
 *
 * 规则：**一个插件实例只有一把锁**，`/restart`、`/sync`、`/admin/restart`、
 * `/admin/seeds/run`（会 drain + 重启的那一段）全部走它；拿不到就 429 并报出持有者。
 *
 *   node scripts/verify-mutation-lock.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-mutation-lock
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMutationLock } from '../lib/index.js'
import { readFamily } from './lib/source-family.mjs'

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

/* ────────────────── 1. 行为 ────────────────── */

test('createMutationLock：独占、可重入释放、idempotent', () => {
  const lock = createMutationLock()
  assert.equal(lock.current(), undefined, '初始没有持有者')
  assert.equal(lock.begin('sync'), true, '空锁必须能拿到')
  assert.equal(lock.current(), 'sync', 'current() 报出持有者（429 文案要用）')
  assert.equal(lock.begin('restart'), false, '已被持有 → 第二个必须失败（这是防叠加的关键）')
  assert.equal(lock.current(), 'sync', '失败的那次不得改写持有者')
  lock.end()
  assert.equal(lock.current(), undefined)
  lock.end() // finally 里可能再调一次
  assert.equal(lock.begin('restart'), true, '释放后必须能再次拿到')
})

test('createMutationLock：两个实例互不影响（提醒「必须共享同一个实例」）', () => {
  const a = createMutationLock()
  const b = createMutationLock()
  assert.equal(a.begin('x'), true)
  assert.equal(b.begin('y'), true, '各持一把时都能拿到 —— 这正是缺陷当年的形态')
})

/* ────────────────── 2. 接线（源码级）────────────────── */

const routes = readFamily(repoRoot, 'src/host/routes')
const admin = readFamily(repoRoot, 'src/host/admin')
/**
 * The `src/index` FAMILY, comment-stripped.
 *
 * ⚠️ The strip is load-bearing, not cosmetic (v0.30.48): the count below says
 * 「`createMutationLock()` exactly once」, and a module header that merely
 * EXPLAINS the rule ("the caller builds the one lock — `createMutationLock()`")
 * would otherwise be counted as a second call site. Same failure mode as the
 * v0.30.45 false green: text assertions over un-stripped source are satisfied
 * by documentation. Order matters — line comments first (v0.30.14).
 */
const stripComments = (src) =>
  src.replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '')
const index = stripComments(readFamily(repoRoot, 'src/index'))

test('routes 侧用注入的共享锁（并保留自己的兜底）', () => {
  assert.match(routes, /deps\.mutationLock \?\? createMutationLock\(\)/, 'routes 必须优先用注入的锁；缺省才自建（harness 兜底）')
  assert.match(routes, /mutationLock\.begin\(/, 'begin 必须走那把锁')
  assert.ok(!/let mutationInFlight/.test(routes), '不得再留私有标志（那正是两边各持一把的成因）')
})

test('admin 侧：/admin/restart 与 seeds-run 都拿锁并在 finally 释放', () => {
  assert.match(admin, /lock\.begin\('admin-restart'\)/, '/admin/restart 必须拿锁')
  assert.match(admin, /seedLock\.begin\('admin-seeds'\)/, 'seeds-run 的重启段必须拿锁')
  assert.match(admin, /429/, '拿不到要回 429（而不是排队硬上）')
  assert.match(admin, /lock\?\.end\(\)/, 'restart 必须在 finally 里释放')
  assert.match(admin, /seedLock\?\.end\(\)/, 'seeds-run 必须释放')
})

test('index.ts：整插件**只建一把**，两侧拿到的是同一个', () => {
  // v0.30.48: the two Deps objects moved into `index-routes.ts` (a pure
  // assembly-stage split), so the count must be taken over the whole FAMILY —
  // and it must still be exactly ONE, wherever it is built. That is the
  // invariant (one lock, shared); which file writes the line is layout.
  const created = index.match(/createMutationLock\(\)/g) ?? []
  assert.equal(created.length, 1, `createMutationLock() 必须只调用一次（实际 ${created.length} 次 —— 两次就是两把锁，共享失效）`)
  const passed = index.match(/^\s*mutationLock(?:,|:.*,)\s*$/gm) ?? []
  assert.ok(passed.length >= 3, `必须同时传给 routes 与 admin 两侧（并作为 entry → stage 的参数传下去）；实际 ${passed.length} 处`)
})

test('锁的实现只此一份（没有第二份手写的 begin/end 组合）', () => {
  const all = routes + admin + index
  const handWritten = all.match(/if \(inFlight !== undefined\) return false/g) ?? []
  assert.equal(handWritten.length, 0, '不得在别处手写同一套标志（要用 host/mutation-lock.ts）')
})

console.log(failures === 0 ? '\nMUTATION LOCK OK' : `\nMUTATION LOCK FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

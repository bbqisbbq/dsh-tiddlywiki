#!/usr/bin/env node
// v0.30.62 — guard「一次剪藏落到哪个库」(the clip-target resolution).
//
// WHY THIS GUARD EXISTS: `createClipSurface()` is the ONLY place that answers
// "which knowledge base does a clip land in" (the bridge runs its own loopback
// server, so the host's `?wiki=` resolver never sees the request). Nothing in
// `scripts/` referenced it, and the function had already shipped one real defect
// (v0.28.8–v0.30.0: `WikiInstance.bridgeConfig()` dropped the `wiki` key, so a
// multi-wiki install ALWAYS clipped into the default wiki and the setting was
// decoration). AGENTS §2 claims a guard for it; this is that guard.
//
// The rules pinned here:
//   1. `bridge.wiki` naming a RUNNING wiki → that wiki (and the id is reported);
//   2. naming a REGISTERED but stopped wiki → REFUSE, 503 naming it, never a
//      silent fallback into another library (the v0.29.0 rule every route uses);
//   3. naming an UNKNOWN id → the default wiki (an old bookmark must work);
//   4. nothing configured → the default wiki.
//
// Run under tsx (it imports the source, not the packaged bundle):
//
//   npx tsx scripts/verify-clip-target.mjs

import assert from 'node:assert/strict'
import { createClipSurface } from '../src/index-clip.ts'

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

const ENTRY = (id, label) => ({ id, label, root: '/w', name: id, agentVisible: true, autostart: true })

/** One fake runtime: records writes, and `client()` is only defined while running. */
function makeInstance(id, written) {
  return {
    entry: ENTRY(id, id),
    path: `/w/${id}`,
    client: () => ({ put: async (t) => { written.push(`${id}:${t.title}`) }, get: async () => undefined }),
  }
}

/**
 * Drive the real surface. `wikis` = registry entries, `running` = which of them
 * have a live runtime, `configured` = the `bridge.wiki` value.
 */
function surface({ wikis, running, configured }) {
  const written = []
  const runtimes = new Map(running.map((id) => [id, makeInstance(id, written)]))
  const farm = () => ({
    registry: { wikis },
    runtime: (id) => runtimes.get(id),
    defaultRuntime: () => runtimes.get('work'),
  })
  const deps = {
    farm,
    defaultInstance: () => runtimes.get('work'),
    effectiveBridge: () => ({ enabled: true, port: 0, token: '', tag: 'clip', ...(configured === undefined ? {} : { wiki: configured }) }),
    effect: () => {},
  }
  return { surface: createClipSurface(deps), written }
}

const ALL = [ENTRY('work', '工作'), ENTRY('books', '书籍')]

await test('bridge.wiki 指向**运行中**的库 ⇒ 就是它（顺带钉住 v0.30.0 那根接线没再被丢掉）', async () => {
  const { surface: s } = surface({ wikis: ALL, running: ['work', 'books'], configured: 'books' })
  assert.equal(s.clipTarget()?.id, 'books', 'bridge.wiki 必须真的被读到（v0.28.8–v0.30.0 曾整条丢掉）')
  assert.equal(s.targetProblem(), undefined)
  assert.equal(s.clipClient()?.wikiId, 'books')
})

await test('bridge.wiki 指向「已登记但没在跑」的库 ⇒ 拒绝（503 点名），绝不回落默认库', async () => {
  const { surface: s } = surface({ wikis: ALL, running: ['work'], configured: 'books' })
  assert.equal(s.clipTarget(), undefined, '没在跑的目标库不得被换成默认库')
  const problem = s.targetProblem()
  assert.ok(problem !== undefined && problem.includes('书籍'), `503 文案必须点名那个库：${problem}`)

  // 端到端：桥真的回 503 + 那句文案，而且**一个字节都没写进默认库**。
  await s.clipBridge.start(0)
  try {
    const res = await fetch(`http://127.0.0.1:${s.clipBridge.port}/clip`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '不该落库的剪藏', url: 'https://example.com' }),
    })
    assert.equal(res.status, 503)
    assert.equal((await res.json()).error, problem)
  } finally {
    await s.clipBridge.stop()
  }
})

await test('bridge.wiki 是**未知 id**（已移出清单 / 打错）⇒ 回落默认库（老书签不能失效）', async () => {
  const { surface: s } = surface({ wikis: ALL, running: ['work'], configured: 'nope' })
  assert.equal(s.clipTarget()?.id, 'work')
  assert.equal(s.targetProblem(), undefined, '未知 id 不是「未运行」，不该给 503')
})

await test('没配 bridge.wiki ⇒ 默认库（单库安装的既有行为）', async () => {
  const { surface: s } = surface({ wikis: ALL, running: ['work'], configured: undefined })
  assert.equal(s.clipTarget()?.id, 'work')
  assert.equal(s.targetProblem(), undefined)
})

await test('清单还没读到（farm 未就绪）⇒ 不崩、明确没有目标', async () => {
  const deps = {
    farm: () => undefined,
    defaultInstance: () => undefined,
    effectiveBridge: () => ({ enabled: true, port: 0, token: '', tag: 'clip', wiki: 'books' }),
    effect: () => {},
  }
  const s = createClipSurface(deps)
  assert.equal(s.clipTarget(), undefined)
  assert.equal(s.clipClient(), undefined)
  assert.equal(s.targetProblem(), undefined, '清单都没有时不说「未运行」——那是另一回事')
})

console.log(failures === 0 ? '\nCLIP TARGET CHECKS OK' : `\nCLIP TARGET CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

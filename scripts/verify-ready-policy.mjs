#!/usr/bin/env node
/**
 * TW 子进程「就绪策略」的守门（v0.22.5）。
 *
 * 事故：5000 条目 / 26MB 的知识库在冷文件缓存下，从 spawn 到 TW 打印
 * "Serving on …" 实测 ~44s（/status 环形日志：01:43:51 spawn → 01:44:35 首行
 * stdout）。旧代码只有一个 20s 硬超时，于是：
 *   ① 抛 `wiki server did not become ready in time`，把随后的配置加载 / 播种 /
 *      剪藏桥整体跳过（而 TW 其实马上就好了）；
 *   ② 写死 `health='failed'` + 粘性 error，**没有任何东西会再探测**——TW 正常
 *      服务时 /status（面板 / FAB / tooltip）永远显示故障。
 *
 * 本守门覆盖：
 *   A. 归一化 / 夹取（非法值回默认、5s–600s、硬上限 = 3× 软窗口）；
 *   B. 虚拟时钟驱动 awaitReady：44s 才就绪 → 'ready'（旧 20s 硬超时下这是
 *      「失败」，正是本次事故的形状）；软窗口只警告一次；子进程退出 → 'exited'；
 *      始终不就绪 → 到硬上限才 'timeout'；探测抛异常 = 尚未就绪；
 *   C. 源码级接线：wiki.ts 必须走 awaitReady + 迟到就绪探测，且不得再出现
 *      20s 硬编码；config/index/client 三处配置链路都在。
 *
 *   npx tsx scripts/verify-ready-policy.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-ready-policy
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8')

const policy = await import(pathToFileURL(path.join(repoRoot, 'src/host/ready-policy.ts')).href)
const {
  READY_TIMEOUT_DEFAULT_MS,
  READY_TIMEOUT_MIN_MS,
  READY_TIMEOUT_MAX_MS,
  READY_HARD_FACTOR,
  READY_POLL_MS,
  READY_SLOW_POLL_MS,
  awaitReady,
  normalizeReadyTimeoutMs,
  readyHardTimeoutMs,
} = policy

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

/** Virtual clock harness: `now()` returns fake ms, `sleep()` advances it. */
function harness({ readyAtMs = 0, exitAtMs = Infinity, throwUntilMs = -1 } = {}) {
  let now = 0
  let probes = 0
  const slowCalls = []
  const deps = {
    now: () => now,
    sleep: async (ms) => { now += ms },
    isAlive: () => now < exitAtMs,
    probe: async () => {
      probes++
      if (now < throwUntilMs) throw new Error('ECONNREFUSED (TW still loading)')
      return now >= readyAtMs
    },
    onSlow: (elapsed, hard) => slowCalls.push({ elapsed, hard }),
  }
  return { deps, slowCalls, probes: () => probes, elapsed: () => now }
}

console.log('ready-policy — normalization')

await test('默认 60s，且严格大于旧代码的 20s 硬超时（事故回归）', () => {
  assert.equal(READY_TIMEOUT_DEFAULT_MS, 60_000, `默认软窗口应为 60s，实际 ${READY_TIMEOUT_DEFAULT_MS}`)
  assert.ok(READY_TIMEOUT_DEFAULT_MS > 20_000, '默认软窗口必须大于旧 20s 硬超时，否则 44s 冷启动仍会失败')
  assert.equal(READY_HARD_FACTOR, 3, '硬上限必须是软窗口的 3 倍')
})

await test('非法输入回默认（undefined / NaN / 0 / 负数 / 字符串）', () => {
  for (const bad of [undefined, null, NaN, 0, -1, '30000', {}, []]) {
    assert.equal(normalizeReadyTimeoutMs(bad), READY_TIMEOUT_DEFAULT_MS, `输入 ${JSON.stringify(bad)} 应回默认`)
  }
})

await test('夹取到 [5s, 600s]', () => {
  assert.equal(normalizeReadyTimeoutMs(1), READY_TIMEOUT_MIN_MS)
  assert.equal(normalizeReadyTimeoutMs(4_999), READY_TIMEOUT_MIN_MS)
  assert.equal(normalizeReadyTimeoutMs(45_000), 45_000)
  assert.equal(normalizeReadyTimeoutMs(10_000_000), READY_TIMEOUT_MAX_MS)
  assert.equal(normalizeReadyTimeoutMs(60_000.7), 60_000, '应向下取整')
  assert.equal(readyHardTimeoutMs(45_000), 135_000)
})

console.log('ready-policy — awaitReady（虚拟时钟）')

await test('立即就绪 → ready，不触发 slow 警告', async () => {
  const h = harness({ readyAtMs: 0 })
  assert.equal(await awaitReady(h.deps), 'ready')
  assert.deepEqual(h.slowCalls, [], '正常启动不得产生 slow 警告')
})

await test('44s 冷启动（> 旧 20s 硬超时）→ ready，默认窗口内连警告都没有', async () => {
  const h = harness({ readyAtMs: 44_000 })
  assert.equal(await awaitReady(h.deps), 'ready', '44s 才就绪必须判成功——事故就是这么被误判成失败的')
  assert.deepEqual(h.slowCalls, [], '44s 在默认 60s 软窗口内，不该警告')
  assert.ok(h.elapsed() >= 44_000, '必须真的等到就绪')
})

await test('慢启动（超出软窗口但未到硬上限）→ 警告一次后仍然 ready', async () => {
  const h = harness({ readyAtMs: 90_000 })
  assert.equal(await awaitReady(h.deps), 'ready')
  assert.equal(h.slowCalls.length, 1, `慢启动只应警告一次，实际 ${h.slowCalls.length} 次`)
  assert.ok(h.slowCalls[0].elapsed >= READY_TIMEOUT_DEFAULT_MS, '警告必须在软窗口之后才出现')
  assert.equal(h.slowCalls[0].hard, READY_TIMEOUT_DEFAULT_MS * READY_HARD_FACTOR)
})

await test('探测抛异常 = 尚未就绪（TW 载入中会拒连）', async () => {
  const h = harness({ readyAtMs: 3_000, throwUntilMs: 3_000 })
  assert.equal(await awaitReady(h.deps), 'ready')
})

await test('自定义软窗口生效（45s 启动在 60s 窗口内、30s 窗口外只警告不失败）', async () => {
  const inside = harness({ readyAtMs: 45_000 })
  assert.equal(await awaitReady({ ...inside.deps, softTimeoutMs: 60_000 }), 'ready')
  assert.deepEqual(inside.slowCalls, [], '45s 启动在 60s 窗口内不该警告')
  const outside = harness({ readyAtMs: 45_000 })
  assert.equal(await awaitReady({ ...outside.deps, softTimeoutMs: 30_000 }), 'ready')
  assert.equal(outside.slowCalls.length, 1, '45s 启动在 30s 窗口外应警告但仍成功')
})

await test('子进程退出 → exited（立即返回，不等窗口）', async () => {
  const h = harness({ readyAtMs: Infinity, exitAtMs: 5_000 })
  assert.equal(await awaitReady(h.deps), 'exited')
  assert.ok(h.elapsed() < READY_TIMEOUT_DEFAULT_MS, '子进程已死就不该继续空等')
})

await test('始终不就绪 → 到硬上限才 timeout，且只警告一次', async () => {
  const h = harness({ readyAtMs: Infinity })
  assert.equal(await awaitReady(h.deps), 'timeout')
  const hard = READY_TIMEOUT_DEFAULT_MS * READY_HARD_FACTOR
  assert.ok(h.elapsed() >= hard, `必须等满硬上限 ${hard}ms，实际 ${h.elapsed()}ms`)
  assert.ok(h.elapsed() <= hard + READY_SLOW_POLL_MS, '超过硬上限后不应继续空转')
  assert.equal(h.slowCalls.length, 1)
})

await test('轮询节奏有界：慢窗口用 2s 间隔，不空转烧 CPU', async () => {
  const h = harness({ readyAtMs: Infinity })
  await awaitReady(h.deps)
  const soft = READY_TIMEOUT_DEFAULT_MS
  const hard = soft * READY_HARD_FACTOR
  const bound = Math.ceil(soft / READY_POLL_MS) + Math.ceil((hard - soft) / READY_SLOW_POLL_MS) + 2
  assert.ok(h.probes() <= bound, `探测次数 ${h.probes()} 应 <= ${bound}（软窗口 ${READY_POLL_MS}ms / 慢窗口 ${READY_SLOW_POLL_MS}ms）`)
})

console.log('ready-policy — 源码接线')

await test('wiki.ts：走 awaitReady + 归一化 + 迟到就绪探测，且无 20s 硬编码', () => {
  const wiki = read('src/host/wiki.ts')
  assert.ok(/awaitReady\(/.test(wiki), 'WikiServer.waitReady 必须调用 awaitReady()')
  assert.ok(/normalizeReadyTimeoutMs\(/.test(wiki), '构造/设置时必须归一化就绪窗口')
  assert.ok(/setReadyTimeout\(/.test(wiki), '必须暴露 setReadyTimeout() 供设置页热改')
  assert.ok(/armLateReadyWatch\(/.test(wiki), '硬超时后必须挂「迟到就绪」后台探测（否则状态永远骗人）')
  assert.ok(/clearLateReadyWatch\(/.test(wiki), 'stop()/新尝试必须取消迟到就绪探测')
  assert.ok(!/READY_TIMEOUT_MS = 20_000/.test(wiki), '不得再出现 20s 硬编码超时（本次事故的根因）')
  assert.ok(!/Date\.now\(\) \+ READY_TIMEOUT_MS/.test(wiki), '旧的单次 deadline 循环必须已被 awaitReady 取代')
})

await test('配置链路：config.ts / index.ts / settings-page.ts 三处都在', () => {
  const config = read('src/host/config.ts')
  const index = read('src/index.ts')
  const client = read('src/client/settings-page.ts')
  assert.ok(/startup\?:\s*\{\s*readyTimeoutMs\?: number\s*\}/.test(config), 'PluginConfigShape 必须声明 startup.readyTimeoutMs')
  assert.ok(/startup\?:\s*\{\s*readyTimeoutMs\?: number\s*\}/.test(index), 'TiddlywikiConfig 必须声明 startup.readyTimeoutMs')
  assert.ok(/startup:\s*\{\s*readyTimeoutMs: READY_TIMEOUT_DEFAULT_MS\s*\}/.test(index), 'DEFAULTS 必须带默认值')
  assert.ok(/readyTimeoutMs: config\.startup\.readyTimeoutMs/.test(index), 'WikiServer 必须接到该配置')
  assert.ok(/applyServerTuning\(\)/.test(index), '启动与设置页保存后必须重新应用（applyServerTuning）')
  assert.ok(/server\.setReadyTimeout\(eff\(\)\.startup\?\.readyTimeoutMs\)/.test(index), 'applyServerTuning 必须读 effective config')
  assert.ok(/startup\.readyTimeoutMs/.test(client), '设置页必须提供该字段（否则只能手改 cordis 配置）')
})

console.log(failures === 0 ? '\nREADY POLICY CHECKS OK' : `\nREADY POLICY CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

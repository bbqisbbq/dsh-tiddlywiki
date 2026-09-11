#!/usr/bin/env node
/**
 * seed 错误策略反例（v0.18.0「读取失败 ≠ 条目不存在」的数据安全守门）。
 *
 * selftest 只覆盖了**正向**语义（404 → 缺失 → 写；marker → 跳过）。本脚本用假
 * client 构造**反例**：
 *   - `client.get()` 抛错（TW 重启/超时/5xx/401 的等价物）；
 *   - `client.put()` / `delete()` 抛「MUST NOT WRITE / MUST NOT DELETE」并把调用记账。
 *
 * 断言：
 *   1. 五个「启动路径会跑」的 seed（doc-note / starter-docs / send-to-agent /
 *      render-route / tw-web-host）在读取失败时 run 返回 `ok:false && wrote:false`
 *      且**一次写都没发生**（非 force 与 force 两种都要安全）；
 *   2. `runAllSeeds` 遇到失败的 seed **不中止**其余的（5 个都返回结果、都失败、都零写）；
 *   3. `checkAllSeeds` 把读取失败报成「检查失败」，而不是「缺失/待写」；
 *      `tw-web-host` 的 check 自己吞了读取错误 → 会退化成「缺失」，正是本反例要抓的；
 *      同时用「真的空 wiki」做对照：那种情况才该报「缺失」，证明两者的区分是真实的；
 *      check 全程只读，不写。
 *
 * 纯假 client，不需要 build 之外的东西（只 import lib/index.js），也不 spawn TW。
 *
 *   node scripts/verify-seed-error-policy.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-seed-error-policy
 */
import assert from 'node:assert/strict'
import { runSeedById, runAllSeeds, checkAllSeeds, SEED_DEFS } from '../lib/index.js'

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

/** 启动路径会跑的 seed（core 3 + starter 2），与 runAllSeeds 的目标集合一致。 */
const STARTUP_SEED_IDS = ['doc-note', 'starter-docs', 'send-to-agent', 'render-route', 'tw-web-host']

/**
 * 假 TiddlyWebClient：
 *   - mode 'failing'：任何 get/list 都抛错（模拟 TW 不可达），put/delete 记账后抛错；
 *   - mode 'empty'  ：get 一律返回 undefined（模拟真的空 wiki），put/delete 同样记账后抛错。
 */
function makeClient(mode) {
  const calls = { get: [], put: [], delete: [], list: [] }
  return {
    calls,
    async get(title) {
      calls.get.push(title)
      if (mode === 'failing') throw new Error('boom: wiki 读取失败（等价于 TW 重启/超时/5xx/401）')
      return undefined
    },
    async list() {
      calls.list.push(true)
      if (mode === 'failing') throw new Error('boom: listing 失败')
      return []
    },
    async put(tiddler) {
      calls.put.push(tiddler && tiddler.title)
      throw new Error('MUST NOT WRITE')
    },
    async delete(title) {
      calls.delete.push(title)
      throw new Error('MUST NOT DELETE')
    },
    async search() { throw new Error('boom: search 失败') },
    async recent() { throw new Error('boom: recent 失败') },
    async listTags() { throw new Error('boom: listTags 失败') },
    async status() { throw new Error('boom: status 失败') },
  }
}

function assertNoWrite(calls, label) {
  assert.deepEqual(calls.put, [], `${label}：读取失败时**不得写入**任何 tiddler（写操作 = 覆盖用户数据的风险）`)
  assert.deepEqual(calls.delete, [], `${label}：读取失败时不得删除任何 tiddler`)
}

// ── 1. 单个 seed：读取失败 → ok:false / wrote:false / 零写 ────────────────────
for (const id of STARTUP_SEED_IDS) {
  await test(`runSeedById('${id}', force=false) 读取失败 → ok:false / wrote:false / 零写`, async () => {
    const client = makeClient('failing')
    const results = await runSeedById({ client }, id, false)
    assert.equal(results.length, 1, `应只返回 1 条结果，实际 ${results.length}`)
    const r = results[0]
    assert.equal(r.id, id, `结果 id 应为 ${id}，实际 ${r.id}`)
    assert.equal(r.ok, false, `读取失败必须报 ok:false（把瞬时故障当「条目不存在」会让非 force seed 覆盖用户数据）；实际 detail=${JSON.stringify(r.detail)}`)
    assert.equal(r.wrote, false, '读取失败时 wrote 必须为 false')
    assert.ok(typeof r.error === 'string' && r.error.length > 0, `读取失败必须携带可读的 error（实际 ${JSON.stringify(r.error)}）`)
    assertNoWrite(client.calls, `${id} (force=false)`)
  })

  await test(`runSeedById('${id}', force=true) 读取失败 → ok:false / wrote:false / 零写`, async () => {
    const client = makeClient('failing')
    const results = await runSeedById({ client }, id, true)
    const r = results[0]
    assert.equal(r.ok, false, `force 也必须先读后写：读取失败要报 ok:false（实际 ${JSON.stringify(r)}）`)
    assert.equal(r.wrote, false, '读取失败时 wrote 必须为 false（force 不允许盲写）')
    assertNoWrite(client.calls, `${id} (force=true)`)
  })
}

// ── 2. runAllSeeds：一个失败不拖累其余 ───────────────────────────────────────
await test('runAllSeeds 读取失败时逐个失败但**不中止**其余 seed，且零写', async () => {
  const client = makeClient('failing')
  const results = await runAllSeeds({ client })
  assert.equal(results.length, 5, `启动路径应覆盖 3 个 core + 2 个 starter seed，实际 ${results.length}`)
  assert.deepEqual(
    results.map((r) => r.id),
    STARTUP_SEED_IDS,
    `启动 seed 顺序/集合变了：${results.map((r) => r.id).join(', ')}`,
  )
  for (const r of results) {
    assert.equal(r.ok, false, `seed ${r.id} 读取失败时必须 ok:false（实际 ${JSON.stringify(r)}）`)
    assert.equal(r.wrote, false, `seed ${r.id} 读取失败时必须 wrote:false`)
  }
  assertNoWrite(client.calls, 'runAllSeeds')
})

// ── 3. checkAllSeeds：失败 ≠ 缺失 ────────────────────────────────────────────
await test('checkAllSeeds 读取失败 → 全部 present:false 且 detail 以「检查失败」开头', async () => {
  const client = makeClient('failing')
  const statuses = await checkAllSeeds({ client })
  assert.equal(statuses.length, SEED_DEFS.length, `应返回注册表全部 ${SEED_DEFS.length} 项状态，实际 ${statuses.length}`)
  for (const s of statuses) {
    assert.equal(s.present, false, `seed ${s.id} 在读取失败时 present 应为 false`)
    assert.ok(
      typeof s.detail === 'string' && s.detail.startsWith('检查失败'),
      `seed ${s.id} 读取失败必须报「检查失败」，而不是「缺失/待写」（实际 detail=${JSON.stringify(s.detail)}）——否则设置页会诱导用户「重新初始化」并覆盖数据`,
    )
  }
  assertNoWrite(client.calls, 'checkAllSeeds')
})

await test('checkAllSeeds 里 tw-web-host 读取失败必须体现为「检查失败」而非「缺失」', async () => {
  const client = makeClient('failing')
  const statuses = await checkAllSeeds({ client })
  const host = statuses.find((s) => s.id === 'tw-web-host')
  assert.ok(host !== undefined, 'checkAllSeeds 结果里没有 tw-web-host')
  assert.equal(host.present, false, 'tw-web-host 读取失败时 present 应为 false')
  assert.ok(!host.detail.includes('缺失'), `tw-web-host 读取失败时 detail 不得出现「缺失」（当前实现用 try/catch 把读取错误吞成 undefined → 报「缺失」）：${JSON.stringify(host.detail)}`)
  assert.ok(host.detail.startsWith('检查失败'), `tw-web-host 读取失败时 detail 应为「检查失败：…」：${JSON.stringify(host.detail)}`)
})

await test('对照：真的空 wiki（get → undefined）才报「缺失」，且 check 全程只读', async () => {
  const client = makeClient('empty')
  const statuses = await checkAllSeeds({ client })
  assert.equal(statuses.length, SEED_DEFS.length, '空 wiki 也应返回全部状态')
  for (const s of statuses) {
    assert.equal(s.present, false, `seed ${s.id} 在空 wiki 上 present 应为 false`)
    assert.ok(
      !s.detail.startsWith('检查失败'),
      `空 wiki 是「缺失」不是「检查失败」：seed ${s.id} 的 detail=${JSON.stringify(s.detail)}`,
    )
  }
  assert.ok(
    statuses.some((s) => s.detail.includes('缺失')),
    '空 wiki 的 check 应至少有一项报「缺失」（证明「缺失」与「检查失败」确实被区分开了）',
  )
  const host = statuses.find((s) => s.id === 'tw-web-host')
  assert.ok(host.detail.includes('应为'), `tw-web-host 缺失时应提示「应为 /dsh-tiddlywiki/tw/」：${JSON.stringify(host.detail)}`)
  assertNoWrite(client.calls, 'checkAllSeeds（空 wiki 对照）')
})

console.log(failures === 0 ? '\nSEED ERROR POLICY OK' : `\nSEED ERROR POLICY FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env node
/**
 * 「停/重启 TW 之前必须排干 syncer 队列」的守门（v0.24.1）。
 *
 * 背景：这条规则写在本仓库的铁律第一条里，但**四个调用点里只有三处遵守**——
 * `POST /restart`、`POST /admin/restart`、`POST /admin/info`（改插件/主题后重启）
 * 与「知识库切换」的 `stopServer` 全都是直接杀子进程，队列里没落盘的写入
 * **静默丢失**（与 v0.19.0 丢 `tw-web-host`、v0.22.0 才发现 throttle 竞态同类）。
 * 规则只写在文档里 = 下一个人加重启路由时必然再犯，所以：
 *
 *   1. **原语收敛**：`drainThenStop()`（src/host/seeds.ts）是唯一入口，排干在它
 *      内部发生，调用方**没法**绕过；
 *   2. **源码级断言**（本脚本）：routes.ts / admin.ts 里每个
 *      `deps.server.restart()` 都必须包在 `drainThenStop(` 里，且
 *      `drainThenStop` 自身必须「先 await 排干、后 await stop」（顺序断言）；
 *   3. **行为断言**：用桩 client 真跑 `drainThenStop()`，断言
 *      「stop 发生在排干之后」、「client 缺失时是安全 no-op」、
 *      「排干失败也必须继续 stop（best-effort，不能把用户锁死在起不来的 TW 上）」。
 *
 *   node scripts/verify-restart-drain.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-restart-drain
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drainThenStop } from '../lib/index.js'

/**
 * 探测 tiddler 落盘后的文件名片段（见 seeds.ts 的 `FLUSH_PROBE_FILE_HINT`）。
 * 这里写字面量是**刻意的耦合**：常量一旦改名，本脚本的桩就写不出能被
 * `flushPendingWrites` 认出的文件，行为断言会立刻变红 —— 比静默失效好。
 */
const PROBE_FILE_HINT = 'dsh-tiddlywiki_flush-probe'

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

const repoRoot = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/**
 * Read a source file with comment lines removed.
 * Without this, the assertions below match their own documentation (the v0.22.3
 * lesson: a static guard that greps for `server.restart()` finds it in the
 * comment that explains why it must not be there).
 */
function sourceWithoutComments(rel) {
  return readFileSync(join(repoRoot, rel), 'utf8')
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1
}

// ── 1. 原语本身：顺序必须是「先排干、后 stop」 ────────────────────────────────
await test('drainThenStop：排干的 await 必须出现在 stop 的 await 之前（顺序是语义）', () => {
  const src = sourceWithoutComments('src/host/seeds.ts')
  const start = src.indexOf('export async function drainThenStop(')
  assert.ok(start >= 0, 'src/host/seeds.ts 必须导出 drainThenStop（重启的唯一入口）')
  // 从函数签名的结尾开始取函数体（options 类型字面量自己以 `}` 结尾，不能只看 `\n}`）
  const bodyStart = src.indexOf('}): Promise<boolean> {', start)
  assert.ok(bodyStart > start, 'drainThenStop 的签名形状变了 —— 请同步本脚本的函数体提取')
  const body = src.slice(bodyStart, src.indexOf('\n}', bodyStart))
  const flushAt = body.indexOf('flushPendingWrites(options.client')
  const stopAt = body.indexOf('await options.stop()')
  assert.ok(flushAt >= 0, `drainThenStop 里找不到 flushPendingWrites 调用：\n${body}`)
  assert.ok(stopAt >= 0, 'drainThenStop 里找不到 await options.stop()')
  assert.ok(flushAt < stopAt, `排干必须在 stop 之前（flush@${flushAt} 应小于 stop@${stopAt}）`)
  // 「排干失败也继续 stop」——best-effort，不能把用户锁死在起不来的 TW 上
  assert.ok(/if \(!drained\)/.test(body), '排干失败必须有显式分支（记录警告后继续 stop）')
  assert.ok(/await options\.stop\(\)/.test(body), 'stop 调用必须存在（且不在排干失败分支内）')
})

// ── 2. 源码级：每个 restart 调用点都必须在 drainThenStop 里 ──────────────────
for (const rel of ['src/host/routes.ts', 'src/host/admin.ts']) {
  await test(`${rel}：每个 deps.server.restart() 都必须经由 drainThenStop`, () => {
    const src = sourceWithoutComments(rel)
    const restarts = count(src, 'deps.server.restart()')
    const drains = count(src, 'drainThenStop(')
    assert.ok(restarts > 0, `${rel} 里没有 restart 调用点？守门断言已失效，请检查`)
    assert.equal(
      drains >= restarts,
      true,
      `${rel}: ${restarts} 处 restart，但只有 ${drains} 处 drainThenStop —— 裸 restart 会静默丢掉队列里的写入`,
    )
    // 更强的形状断言：restart 必须作为 drainThenStop 的参数出现
    assert.ok(
      /drainThenStop\(\{[\s\S]{0,400}?stop: \(\) => deps\.server\.restart\(\)/.test(src),
      `${rel}: restart 必须作为 drainThenStop({ stop: () => deps.server.restart() }) 的参数`,
    )
  })
}

await test('src/index.ts：知识库切换的 stopServer 必须先排干（铁律第一条点名了它）', () => {
  const src = sourceWithoutComments('src/index.ts')
  assert.ok(
    /stopServer: async \(\) => \{[\s\S]{0,400}?drainThenStop\(\{[\s\S]{0,400}?stop: \(\) => server\.stop\(\)/.test(src),
    'runSwitch 的 stopServer 必须包在 drainThenStop 里（旧实现直接 server.stop()，队列里的写入随子进程一起没了）',
  )
  // 启动自举路径：排干必须真的存在，且在它自己的 restart 之前
  const flushAt = src.indexOf('flushPendingWrites(seedClient')
  const restartAt = src.indexOf('if (!disposed) await server.restart()')
  assert.ok(flushAt >= 0, '启动自举路径必须调用 flushPendingWrites(seedClient, …)')
  assert.ok(restartAt >= 0, '启动自举路径找不到 server.restart()（断言失效）')
  assert.ok(flushAt < restartAt, '自举路径的排干必须出现在 restart 之前')
})

// ── 3. 行为级：桩 client 真跑一遍 ────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'dsh-tw-restart-drain-'))
try {
  /** 假 client：把探测 tiddler 的正文同步写进临时 tiddlers 目录（模拟已落盘）。 */
  const makeStubClient = (events, { failPut = false, throttle = '0' } = {}) => ({
    async get() {
      return { title: '$:/config/SyncThrottleInterval', text: throttle, type: 'text/plain', tags: [] }
    },
    async put(tiddler) {
      if (failPut) {
        events.push('put:fail')
        throw new Error('stub put failed')
      }
      events.push('put')
      writeFileSync(join(dir, `${PROBE_FILE_HINT}.tid`), tiddler.text ?? '', 'utf8')
    },
  })

  await test('行为：client 存在时，stop 必须发生在写入真的落盘之后', async () => {
    const events = []
    const drained = await drainThenStop({
      client: makeStubClient(events),
      tiddlersDir: dir,
      stop: async () => { events.push('stop') },
    })
    assert.equal(drained, true, `排干应成功：${JSON.stringify(events)}`)
    assert.ok(events.includes('put'), `排干必须真的写过探测 tiddler：${JSON.stringify(events)}`)
    assert.equal(events[events.length - 1], 'stop', `stop 必须是最后一步：${JSON.stringify(events)}`)
    assert.ok(events.indexOf('put') < events.indexOf('stop'), `put 必须在 stop 之前：${JSON.stringify(events)}`)
  })

  await test('行为：client 缺失（TW 没在跑）时是安全 no-op —— 不排干、但仍要 stop', async () => {
    const events = []
    const drained = await drainThenStop({
      client: undefined,
      tiddlersDir: dir,
      stop: async () => { events.push('stop') },
    })
    assert.equal(drained, true, '没有 TW 就没有队列可丢，应视为「已排干」')
    assert.deepEqual(events, ['stop'], `只应调用 stop：${JSON.stringify(events)}`)
  })

  await test('行为：排干失败也必须继续 stop，且把警告交出去（不能把用户锁死在坏 TW 上）', async () => {
    const events = []
    const logs = []
    const drained = await drainThenStop({
      client: makeStubClient(events, { failPut: true }),
      tiddlersDir: dir,
      stop: async () => { events.push('stop') },
      log: (message) => logs.push(message),
    })
    assert.equal(drained, false, '排干失败必须如实返回 false（调用方要在回包里说出来）')
    assert.ok(events.includes('stop'), `排干失败必须仍然 stop：${JSON.stringify(events)}`)
    assert.equal(logs.length, 1, `必须恰好记一条警告：${JSON.stringify(logs)}`)
    assert.ok(/drain|排干|queue/i.test(logs[0]), `警告要说清是排干问题：${logs[0]}`)
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nRESTART DRAIN CHECKS OK' : `\nRESTART DRAIN CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

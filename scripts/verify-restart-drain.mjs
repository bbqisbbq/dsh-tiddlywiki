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
 *      v0.28.0 起 per-wiki 的启停搬进了 `src/host/wiki-instance.ts`，所以断言
 *      跟着搬家：实例的 `drainStop()`/`restart()` 必须走 `drainThenStop`，而
 *      `src/index.ts` 的「知识库切换」只能**委托**它、不得直接 `server.stop()`；
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
import { readFamily } from './lib/source-family.mjs' // v0.28.8：按「模块族」读源码，拆分不断言路径

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
  return readFamily(repoRoot, rel.replace(/\.ts$/, ''))
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
// v0.30.8：改成按**模块族**遍历（routes.ts + routes-*.ts、admin.ts + admin-*.ts）。
// 规则是「这一整片区域里没有任何裸 restart」；钉死单个文件的话，把 /sync 或
// /restart 的 handler 搬进更细的模块就会**静默丢掉覆盖**（restarts 变成 0 时旧写法
// 才报错——而它搬到别的文件里时连那声错都没有）。
for (const rel of ['src/host/routes', 'src/host/admin']) {
  await test(`${rel}：每个 deps.server(req)?.restart() 都必须经由 drainThenStop`, () => {
    const src = sourceWithoutComments(rel)
    const restarts = count(src, 'deps.server(req)?.restart()')
    const drains = count(src, 'drainThenStop(')
    assert.ok(restarts > 0, `${rel} 里没有 restart 调用点？守门断言已失效，请检查`)
    assert.equal(
      drains >= restarts,
      true,
      `${rel}: ${restarts} 处 restart，但只有 ${drains} 处 drainThenStop —— 裸 restart 会静默丢掉队列里的写入`,
    )
    // 更强的形状断言：restart 必须作为 drainThenStop 的 stop 回调出现。
    // v0.28.0：per-wiki deps 改成按请求解析（`deps.server(req)`，可能为 undefined），
    // 所以回调整体包了一层 async/await。
    assert.ok(
      /drainThenStop\(\{[\s\S]{0,400}?stop: async \(\) => \{ await deps\.server\(req\)\?\.restart\(\) \}/.test(src),
      `${rel}: restart 必须作为 drainThenStop({ stop: async () => { await deps.server(req)?.restart() } }) 的参数`,
    )
  })
}

await test('src/index.ts：知识库切换的 stopServer 必须委托会排干的 drainStop（铁律第一条点名了它）', () => {
  const src = sourceWithoutComments('src/index.ts')
  // v0.28.0：排干搬进了 host/wiki-instance.ts，切换点改为委托 `instance.drainStop()`。
  // 断言因此变成「必须委托，且不得直接 server.stop()」——直接调用仍然会丢队列，
  // 而这正是本脚本第 5 行的由来。
  assert.ok(
    /stopServer: async \(\) => \{[\s\S]{0,200}?await \w+\.drainStop\(\)/.test(src),
    'runSwitch 的 stopServer 必须委托 <runtime>.drainStop()（旧实现直接 server.stop()，队列里的写入随子进程一起没了）',
  )
  const stopServerAt = src.indexOf('stopServer: async () => {')
  assert.ok(stopServerAt >= 0, '找不到 runSwitch 的 stopServer 定义 —— 断言失效')
  const stopServerBody = src.slice(stopServerAt, src.indexOf('\n      },', stopServerAt))
  assert.ok(
    !/server\.stop\(\)/.test(stopServerBody),
    'stopServer 里不得直接 server.stop()：必须走会先排干的 instance.drainStop()',
  )
})

await test('src/host/wiki-instance.ts：drainStop / restart 必须经由 drainThenStop', () => {
  const src = sourceWithoutComments('src/host/wiki-instance.ts')
  assert.ok(
    /async drainStop\(\): Promise<boolean> \{[\s\S]{0,400}?drainThenStop\(\{[\s\S]{0,400}?stop: \(\) => this\.server\.stop\(\)/.test(src),
    'drainStop 必须把 this.server.stop() 交给 drainThenStop（否则队列里的写入随子进程消失）',
  )
  assert.ok(
    /async restart\(\): Promise<boolean> \{[\s\S]{0,400}?drainThenStop\(\{[\s\S]{0,400}?stop: \(\) => this\.server\.restart\(\)/.test(src),
    'restart 必须把 this.server.restart() 交给 drainThenStop',
  )
  // 启动自举路径：排干必须真的存在，且在它自己的 restart 之前。
  // （v0.29.0：自举改走 this.restart()，它内部就是 drainThenStop；断言跟着改。）
  const flushAt = src.indexOf('flushPendingWrites(seedClient')
  const restartAt = src.indexOf('if (!this.disposed) await this.restart()')
  assert.ok(flushAt >= 0, '启动自举路径必须调用 flushPendingWrites(seedClient, …)')
  assert.ok(restartAt >= 0, '启动自举路径找不到 this.restart()（断言失效）')
  assert.ok(flushAt < restartAt, '自举路径的排干必须出现在 restart 之前')
})

/**
 * v0.29.0 — THE ABOVE WAS A BLIND SPOT, and this is the fix.
 *
 * The old check used `indexOf(...)`, i.e. it only ever looked at the FIRST
 * `this.server.restart()` in the file. Two more sites existed on the bootstrap
 * path (`pluginAdded` and the uiLanguage branch) and both were bare calls, so a
 * restart could kill TW with the seed writes still queued — the exact loss rule
 * #1 exists to prevent — while this script stayed green.
 *
 * The rule is now stated the only way it cannot drift: EVERY call site is
 * enumerated, and each must sit inside a `drainThenStop({ … stop: () => … })`
 * callback. `dispose()` is the one documented exception (it must not drain).
 */
await test('src/host/wiki-instance.ts：数**全部**调用点，不许再有一处裸 restart/stop', () => {
  const src = sourceWithoutComments('src/host/wiki-instance.ts')
  const restartCalls = [...src.matchAll(/this\.server\.restart\(\)/g)]
  // v0.29.0 起只应剩 drainThenStop 里那**一处**（自举路径全部改走 this.restart()）。
  assert.ok(restartCalls.length >= 1, '一处 server.restart() 都没有，断言可能失效')
  for (const call of restartCalls) {
    const before = src.slice(Math.max(0, call.index - 32), call.index)
    assert.ok(
      /stop: \(\) =>\s*$/.test(before),
      `第 ${call.index} 字符处的 this.server.restart() 不在 drainThenStop 的 stop 回调里（裸重启会丢队列里的写入）`,
    )
  }
  const disposeAt = src.indexOf('async dispose(): Promise<void> {')
  assert.ok(disposeAt >= 0, '找不到 dispose()（断言失效）')
  for (const call of [...src.matchAll(/this\.server\.stop\(\)/g)]) {
    const before = src.slice(Math.max(0, call.index - 32), call.index)
    const drained = /stop: \(\) =>\s*$/.test(before)
    assert.ok(
      drained || call.index > disposeAt,
      `第 ${call.index} 字符处的 this.server.stop() 既不在 drainThenStop 里、也不在 dispose() 里`,
    )
  }
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

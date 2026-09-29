#!/usr/bin/env node
/**
 * 多知识库「运行集」编排的守门（v0.28.0）——零 TW、零文件系统、毫秒级。
 *
 * 为什么单独一个脚本：`src/host/wiki-farm.ts` 里最容易出错的不是"起一个子进程"，
 * 而是 **diff**——该起谁、该停谁、谁原地更新、谁必须回收重建。写错的后果两种都很贵：
 *   · 漏停 → 孤儿 TW 进程继续占着端口与文件夹；
 *   · 错停 → 用户正开着的库被静默关掉。
 * 所以 farm 把 `createRuntime` 做成注入的，这里用**只记录调用的假实例**把整套规则钉死，
 * 不必等真 TW 冷启动（那是 `verify-wiki-switch.mjs` 的活）。
 *
 *   node scripts/verify-wiki-farm.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-wiki-farm
 */
import assert from 'node:assert/strict'
import { WikiFarm, entryPath } from '../lib/index.js'

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

const ROOT = process.platform === 'win32' ? 'C:\\notes' : '/notes'

/** 造一个合法条目（farm 只用 id/path/flags，不做 normalizeEntry）。 */
function mk(id, name = id, extra = {}) {
  return { id, label: name, root: ROOT, name, agentVisible: true, autostart: false, ...extra }
}

/** 造一份清单。 */
function registry(mode, wikis, defaultId = wikis[0]?.id) {
  return { version: 1, mode, defaultId, wikis }
}

/**
 * 假实例工厂：把收到的每个调用按顺序记进 `log`，并可指定哪些 id 的 start 抛错。
 * `path` 在创建时固化（与真实现一致：目录变更靠"回收重建"，不是靠改 path）。
 */
function factory(log, { failOn = new Set() } = {}) {
  return (entry) => {
    const runtime = {
      entry,
      path: entryPath(entry),
      isDisposed: false,
      async start() {
        log.push(`start:${entry.id}`)
        if (failOn.has(entry.id)) throw new Error(`boom:${entry.id}`)
      },
      async stop() { log.push(`stop:${entry.id}`) },
      async dispose() { log.push(`dispose:${entry.id}`); runtime.isDisposed = true },
      updateEntry(next) { log.push(`update:${next.id}`); runtime.entry = next },
    }
    return runtime
  }
}

const eventOf = (log, prefix) => log.filter((l) => l.startsWith(`${prefix}:`))

await test('single 模式：只起 defaultId 那一个（清单里有多条也不许全起）', async () => {
  const log = []
  const farm = new WikiFarm(registry('single', [mk('main'), mk('books'), mk('work')]), { createRuntime: factory(log) })
  const change = await farm.startAll()
  assert.deepEqual(change.started, ['main'])
  assert.deepEqual(change.running, ['main'])
  assert.deepEqual(farm.runningIds(), ['main'])
  assert.deepEqual(farm.autoStartIds(), ['main'])
  assert.equal(farm.runtime('books'), undefined, 'single 模式下 books 不该被实例化')
  assert.equal(farm.defaultRuntime().entry.id, 'main')
})

await test('multi 模式：只起 autostart 的，其余按需（不进 running）', async () => {
  const log = []
  const farm = new WikiFarm(registry('multi', [
    mk('main', 'main', { autostart: true }),
    mk('books', '书籍'),
    mk('work', '工作', { autostart: true }),
  ]), { createRuntime: factory(log) })
  const change = await farm.startAll()
  assert.deepEqual(change.started, ['main', 'work'])
  assert.deepEqual(farm.autoStartIds(), ['main', 'work'])
  assert.equal(farm.runtime('books'), undefined)
  // 按需启动：人类打开它的面板 / 会话被圈定到它时。
  await farm.startEntry(mk('books', '书籍'))
  assert.deepEqual(farm.runningIds(), ['main', 'work', 'books'])
  // 重复按需启动是 no-op（不能每点一次就多一个子进程）。
  const before = log.length
  await farm.startEntry(mk('books', '书籍'))
  assert.equal(log.length, before, '已在运行的库再次 startEntry 不得再 spawn')
})

await test('标志变更（label/agentVisible/autostart 不改目录）→ 原地 update，不重启', async () => {
  const log = []
  const farm = new WikiFarm(registry('multi', [mk('main', 'main', { autostart: true })]), { createRuntime: factory(log) })
  await farm.startAll()
  log.length = 0
  // ⚠️ 只改 label/flags —— 目录名（name）绝不能跟着变，否则农场判成"换目录"并正确
  // 地回收重建（这正是它该做的事，第一版测试就是在这里自己写错、被农场纠出来的）。
  const renamed = { ...mk('main', 'main', { autostart: true }), label: '新名字', agentVisible: false }
  const change = await farm.apply(registry('multi', [renamed]))
  assert.deepEqual(change.updated, ['main'])
  assert.deepEqual(change.started, [])
  assert.deepEqual(change.stopped, [])
  assert.deepEqual(log, ['update:main'], '原地更新不得 stop/start（否则每次改个名字都断一次 TW）')
  assert.equal(farm.runtime('main').entry.label, '新名字')
})

await test('autostart 关掉**不会**杀掉正在跑的库（autostart 只管「开局」）', async () => {
  // 这条规则是 verify-wiki-farm-boot 的集成测试逼出来的："我手动起了 C，然后加了个
  // 库，C 却被停了" —— 配置编辑不是开机，不该顺手关掉用户开着的库。
  const log = []
  const farm = new WikiFarm(registry('multi', [mk('main', 'main', { autostart: true })]), { createRuntime: factory(log) })
  await farm.startAll()
  log.length = 0
  const change = await farm.apply(registry('multi', [mk('main', 'main', { autostart: false })]))
  assert.deepEqual(change.stopped, [], '改配置不该把用户开着的库关掉')
  assert.deepEqual(change.started, [])
  assert.deepEqual(change.updated, ['main'])
  assert.deepEqual(log, ['update:main'], '只允许原地更新')
  assert.deepEqual(farm.runningIds(), ['main'])

  // 新的值在下一次「开局」生效。
  const nextLog = []
  const next = new WikiFarm(registry('multi', [mk('main', 'main', { autostart: false })]), { createRuntime: factory(nextLog) })
  assert.deepEqual((await next.startAll()).started, [], 'autostart=false 的库开局不起')
  // 显式启动仍然可以（按需）。
  await next.startEntry(mk('main', 'main', { autostart: false }))
  assert.deepEqual(next.runningIds(), ['main'])
})

await test('模式翻回 single → 非默认库必须停（mode 是硬约束，不是 autostart）', async () => {
  const log = []
  const two = [mk('a', 'a', { autostart: true }), mk('b', 'b', { autostart: true })]
  const farm = new WikiFarm(registry('multi', two, 'a'), { createRuntime: factory(log) })
  await farm.startAll()
  assert.deepEqual(farm.runningIds(), ['a', 'b'])
  const change = await farm.apply(registry('single', two, 'a'))
  assert.deepEqual(change.stopped, ['b'], 'single 模式只能跑默认库')
  assert.deepEqual(farm.runningIds(), ['a'])
})

await test('目录变更 → 必须先停再回收重建（setLocation 拒绝在运行中改指）', async () => {
  const log = []
  const farm = new WikiFarm(registry('multi', [mk('main', 'main', { autostart: true })]), { createRuntime: factory(log) })
  await farm.startAll()
  log.length = 0
  const moved = mk('main', 'main', { autostart: true })
  moved.name = 'moved'
  const change = await farm.apply(registry('multi', [moved]))
  assert.deepEqual(change.stopped, ['main'])
  assert.deepEqual(change.started, ['main'])
  assert.deepEqual(log, ['stop:main', 'dispose:main', 'start:main'], '顺序必须是 停→释放→用新目录重建')
  assert.equal(farm.runtime('main').path, entryPath(moved))
})

await test('条目被移除 → 停下并释放；新增且 autostart → 起', async () => {
  const log = []
  const farm = new WikiFarm(registry('multi', [mk('a', 'a', { autostart: true }), mk('b', 'b', { autostart: true })]), { createRuntime: factory(log) })
  await farm.startAll()
  log.length = 0
  const change = await farm.apply(registry('multi', [mk('b', 'b', { autostart: true }), mk('c', 'c', { autostart: true })]))
  assert.deepEqual(change.stopped, ['a'])
  assert.deepEqual(change.started, ['c'])
  assert.deepEqual(farm.runningIds(), ['b', 'c'])
  // 顺序是安全属性：所有 stop/dispose 都必须发生在任何 start 之前。
  const lastRelease = Math.max(log.lastIndexOf('stop:a'), log.lastIndexOf('dispose:a'))
  const firstStart = log.indexOf('start:c')
  assert.ok(lastRelease < firstStart, `释放必须先于启动：${JSON.stringify(log)}`)
})

await test('幂等：同一份清单 apply 两次，不得有多余的 stop/start', async () => {
  const log = []
  const reg = registry('multi', [mk('a', 'a', { autostart: true }), mk('b', 'b')])
  const farm = new WikiFarm(reg, { createRuntime: factory(log) })
  await farm.startAll()
  log.length = 0
  const change = await farm.apply(reg)
  assert.deepEqual(change.started, [])
  assert.deepEqual(change.stopped, [])
  assert.deepEqual(eventOf(log, 'start'), [])
  assert.deepEqual(eventOf(log, 'stop'), [])
  // 只有**在跑**的库才有 runtime 可原地刷新；b 没在跑，它的 flags 由清单按需读取。
  assert.deepEqual(change.updated, ['a'])
})

await test('一个库起不来，不许拖垮其他库；失败必须被报出来且实例仍可停', async () => {
  const log = []
  const failOn = new Set(['bad'])
  const farm = new WikiFarm(registry('multi', [
    mk('good', 'good', { autostart: true }),
    mk('bad', 'bad', { autostart: true }),
    mk('good2', 'good2', { autostart: true }),
  ]), { createRuntime: factory(log, { failOn }) })
  const change = await farm.startAll()
  assert.deepEqual(change.started, ['good', 'bad', 'good2'])
  assert.deepEqual(farm.runningIds(), ['good', 'bad', 'good2'])
  assert.equal(change.errors.length, 1)
  assert.equal(change.errors[0].id, 'bad')
  assert.match(change.errors[0].message, /boom:bad/)
  // 失败的实例留在 running 里（子进程可能"迟到就绪"，必须还能被停掉）。
  assert.ok(farm.runtime('bad') !== undefined)
  await farm.stopEntry('bad')
  assert.deepEqual(log.slice(-2), ['stop:bad', 'dispose:bad'])
})

await test('createRuntime 自身抛错也要被记下，不能把 apply 带崩', async () => {
  const log = []
  const farm = new WikiFarm(registry('multi', [mk('x', 'x', { autostart: true }), mk('y', 'y', { autostart: true })]), {
    createRuntime: (entry) => {
      if (entry.id === 'x') throw new Error('cannot build')
      return factory(log)(entry)
    },
  })
  const change = await farm.startAll()
  assert.equal(change.errors.length, 1)
  assert.match(change.errors[0].message, /cannot build/)
  assert.deepEqual(farm.runningIds(), ['y'])
})

await test('disposeAll：全部释放、可重复调用、一个失败不挡住其余', async () => {
  const log = []
  const farm = new WikiFarm(registry('multi', [mk('a', 'a', { autostart: true }), mk('b', 'b', { autostart: true })]), {
    createRuntime: (entry) => {
      const rt = factory(log)(entry)
      if (entry.id === 'a') rt.stop = async () => { log.push('stop:a'); throw new Error('stop failed') }
      return rt
    },
  })
  await farm.startAll()
  await farm.disposeAll()
  assert.deepEqual(farm.runningIds(), [], '即使 stop 抛错，也必须把 runtime 从运行集里摘掉')
  assert.ok(log.includes('dispose:a'), 'stop 失败后仍必须 dispose（否则监听/计时器泄漏）')
  assert.ok(log.includes('dispose:b'))
  await farm.disposeAll()
  assert.deepEqual(farm.runningIds(), [])
})

await test('defaultRuntime：defaultId 没在跑就回落第一个在跑的；一个都没跑则 undefined', async () => {
  const log = []
  const farm = new WikiFarm(registry('multi', [mk('a', 'a', { autostart: true }), mk('b', 'b', { autostart: true })], 'b'), { createRuntime: factory(log) })
  await farm.startAll()
  assert.equal(farm.defaultRuntime().entry.id, 'b')
  await farm.stopEntry('b')
  assert.equal(farm.defaultRuntime().entry.id, 'a', '默认库没在跑时必须回落，不能让所有旧路由 503')
  await farm.stopEntry('a')
  assert.equal(farm.defaultRuntime(), undefined)
})

await test('affectedBy：只报内容真的变了的库（共享仓库下"该重启谁"的判据）', async () => {
  const log = []
  const farm = new WikiFarm(registry('multi', [
    mk('work', 'work', { autostart: true }),
    mk('personal', 'personal', { autostart: true }),
  ]), { createRuntime: factory(log) })
  await farm.startAll()
  const repoRoot = ROOT
  const ids = (files) => farm.affectedBy(repoRoot, files).map((rt) => rt.entry.id)

  assert.deepEqual(ids(['work/tiddlers/a.tid']), ['work'], '只有 work 变了 → 只该重启 work')
  assert.deepEqual(ids(['personal/tiddlers/b.tid']), ['personal'])
  assert.deepEqual(ids(['work/tiddlers/a.tid', 'personal/tiddlers/b.tid']), ['work', 'personal'], '两个都变了就都重启')
  assert.deepEqual(ids(['README.md']), [], '仓库根的改动不属于任何库 → 谁都不重启')
  assert.deepEqual(ids(['workbench/notes.tid']), [], '前缀相同的兄弟目录不算（不是 work 的内容）')
  assert.deepEqual(ids([]), [], '没有改动就没有重启')
  // v0.30.37：**未知**（diff 算不出来）必须与「没有改动」严格区分 —— 保守重启该仓库下的全部库。
  // 动机：HEAD 动了但 diff 失败时，若按 [] 处理就是一个库都不重启 ⇒ TW 一直显示旧内容，而回执说同步成功。
  assert.deepEqual(ids(undefined), ['work', 'personal'], '不知道哪些文件变了 ⇒ 该仓库下全部库都重启（保守）；与"没有改动"必须可区分')
})

console.log(failures === 0 ? '\nWIKI FARM CHECKS OK' : `\nWIKI FARM CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

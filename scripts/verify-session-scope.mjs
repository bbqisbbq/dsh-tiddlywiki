#!/usr/bin/env node
/**
 * 「会话作用域」的守门（v0.28.0）：存储 + 解析规则。零 TW、毫秒级。
 *
 * 为什么值得单独一个脚本：这一层决定 **Agent 会往哪个库里写**。写错库是这个功能
 * 唯一真正危险的失败方式，而它的两条规则恰恰反直觉：
 *   · 作用域指向一个对 Agent **隐身**的库 → 必须忽略（隐身是硬边界）；
 *   · 作用域指向一个可见但**没在跑**的库 → 必须**报错**，绝不能"顺手"落到默认库。
 * 后者尤其重要：静默换库 = 笔记进了用户没指定的知识库，而且看起来一切正常。
 *
 *   node scripts/verify-session-scope.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-session-scope
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SESSION_SCOPE_MAX_AGE_MS,
  WikiFarm,
  isSafeSessionId,
  pruneScopes,
  readSessionScopes,
  registerTiddlywikiTools,
  resolveAgentScope,
  setSessionScope,
  writeSessionScopes,
} from '../lib/index.js'

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
const scratch = await mkdtemp(join(tmpdir(), 'dsh-tw-scope-'))
const scopeFile = join(scratch, 'sessions.json')

/** A registry entry (ids/paths only matter here). */
function mk(id, extra = {}) {
  return { id, label: `${id}-label`, root: ROOT, name: id, agentVisible: true, autostart: true, ...extra }
}
function registry(wikis, defaultId = wikis[0].id) {
  return { version: 1, mode: 'multi', defaultId, wikis }
}
/** A do-nothing runtime (this file is about WHICH one is chosen, not about TW). */
function fakeRuntime(entry) {
  return {
    entry,
    path: join(ROOT, entry.name),
    isDisposed: false,
    async start() {},
    async stop() {},
    async dispose() { this.isDisposed = true },
    updateEntry(next) { this.entry = next },
  }
}
const quietFactory = () => (entry) => fakeRuntime(entry)

try {
  await test('isSafeSessionId：会话 id 来自 HTTP，必须按字符集校验而不是信任', () => {
    for (const ok of ['abc', 'session-1', 'a:b.c_d-e', 'x'.repeat(120)]) assert.equal(isSafeSessionId(ok), true, `${ok} 应合法`)
    for (const bad of ['', 'a/b', 'a b', 'x'.repeat(121), 'a\\b', 42, null, undefined, {}]) assert.equal(isSafeSessionId(bad), false, `${JSON.stringify(bad)} 不该合法`)
  })

  await test('读：文件不存在 = 没有作用域（不是错误）', async () => {
    const read = await readSessionScopes(join(scratch, 'nope.json'))
    assert.deepEqual(read.scopes, {})
    assert.equal(read.error, undefined, '缺失是正常状态，不该报错')
  })

  await test('读：坏 JSON / 坏条目 → 软失败（偏好而已，不该拦任何东西）', async () => {
    const bad = join(scratch, 'bad.json')
    await writeFile(bad, '{ not json', 'utf8')
    const read = await readSessionScopes(bad)
    assert.deepEqual(read.scopes, {})
    assert.match(read.error, /不是合法 JSON/)

    await writeFile(bad, JSON.stringify({ version: 1, sessions: { good: { wikiId: 'work', at: new Date().toISOString() }, 'bad/id': { wikiId: 'x', at: 'now' }, other: { wikiId: 'X!', at: 'x' } } }), 'utf8')
    const mixed = await readSessionScopes(bad)
    assert.deepEqual(mixed.scopes, { good: 'work' }, '只保留合法条目')
    assert.match(mixed.error, /无效记录/)
  })

  await test('写：往返一致、原子写不留 .tmp', async () => {
    await setSessionScope('s1', 'work', scopeFile)
    assert.ok(existsSync(scopeFile))
    assert.ok(!existsSync(`${scopeFile}.tmp`), '临时文件必须被 rename 掉')
    assert.deepEqual((await readSessionScopes(scopeFile)).scopes, { s1: 'work' })
    await setSessionScope('s2', 'personal', scopeFile)
    assert.deepEqual((await readSessionScopes(scopeFile)).scopes, { s1: 'work', s2: 'personal' })
  })

  await test('写：wikiId=undefined 表示清除该会话的作用域', async () => {
    await setSessionScope('s1', undefined, scopeFile)
    assert.deepEqual((await readSessionScopes(scopeFile)).scopes, { s2: 'personal' })
  })

  await test('写：非法 id 直接拒绝（不静默写坏文件）', async () => {
    await assert.rejects(() => setSessionScope('bad/id', 'work', scopeFile), /会话 id 非法/)
    await assert.rejects(() => setSessionScope('s3', 'BAD ID', scopeFile), /知识库 id 非法/)
  })

  await test('pruneScopes：过期条目在写入时被清理（这个文件没有别的上界）', async () => {
    const now = Date.now()
    const state = {
      version: 1,
      sessions: {
        fresh: { wikiId: 'a', at: new Date(now - 1_000).toISOString() },
        stale: { wikiId: 'b', at: new Date(now - SESSION_SCOPE_MAX_AGE_MS - 1_000).toISOString() },
        broken: { wikiId: 'c', at: 'not a date' },
      },
    }
    const pruned = pruneScopes(state, now)
    assert.deepEqual(Object.keys(pruned.sessions), ['fresh'])
    // 落盘后再读，过期条目确实不见了。
    await writeSessionScopes(pruned, scopeFile)
    assert.deepEqual((await readSessionScopes(scopeFile)).scopes, { fresh: 'a' })
    // 写入前会 prune：一个过期条目不会因为 set 另一个会话而复活。
    await setSessionScope('another', 'work', scopeFile)
    const after = JSON.parse(await readFile(scopeFile, 'utf8'))
    assert.deepEqual(Object.keys(after.sessions).sort(), ['another', 'fresh'])
  })

  // ── 解析规则（决定"Agent 往哪个库写"）────────────────────────────────────
  await test('scope：显式作用域生效（可见 + 在跑）', async () => {
    const farm = new WikiFarm(registry([mk('work'), mk('personal')]), { createRuntime: quietFactory() })
    await farm.startAll()
    const scope = resolveAgentScope(farm, { s1: 'personal' }, 's1')
    assert.equal(scope.runtime?.entry.id, 'personal')
    assert.equal(scope.entry.id, 'personal')
    assert.equal(scope.reason, undefined)
    await farm.disposeAll()
  })

  await test('scope：隐身库必须被忽略（隐身是硬边界，不能被过期选择绕过）', async () => {
    const farm = new WikiFarm(registry([mk('work'), mk('secret', { agentVisible: false })]), { createRuntime: quietFactory() })
    await farm.startAll()
    const scope = resolveAgentScope(farm, { s1: 'secret' }, 's1')
    assert.equal(scope.runtime?.entry.id, 'work', '指向隐身库的作用域必须回落到默认库')
    await farm.disposeAll()
  })

  await test('scope：可见但**没在跑** → 报错，绝不静默换库（本脚本存在的理由）', async () => {
    const log = []
    const farm = new WikiFarm(registry([mk('work'), mk('personal', { autostart: false })]), { createRuntime: quietFactory(log) })
    await farm.startAll() // personal 没在跑
    const scope = resolveAgentScope(farm, { s1: 'personal' }, 's1')
    assert.equal(scope.runtime, undefined, '不能落到别的库上去写')
    assert.equal(scope.entry.id, 'personal', '仍要说出是哪个库没在跑')
    assert.match(scope.reason, /没有运行/)
    assert.match(scope.reason, /personal-label/, '错误信息要带上库名，用户才知道该起哪个')
    await farm.disposeAll()
  })

  await test('scope：没有显式作用域 → 默认库；默认库没在跑则用第一个在跑的可见库', async () => {
    const farm = new WikiFarm(registry([mk('a', { autostart: false }), mk('b')], 'a'), { createRuntime: quietFactory() })
    await farm.startAll() // a 没在跑，b 在跑
    assert.equal(resolveAgentScope(farm, {}, 's1').runtime?.entry.id, 'b', 'defaultId 没在跑时要回落到在跑的可见库')
    await farm.startEntry(registry([mk('a', { autostart: false })]).wikis[0])
    assert.equal(resolveAgentScope(farm, {}, 's1').runtime?.entry.id, 'a', '默认库在跑时优先默认库')
    await farm.disposeAll()
  })

  await test('scope：全部隐身 → 说清原因；一个都没跑 → 说清该起哪个', async () => {
    const hidden = new WikiFarm(registry([mk('x', { agentVisible: false })]), { createRuntime: quietFactory() })
    await hidden.startAll()
    const none = resolveAgentScope(hidden, {}, 's1')
    assert.equal(none.runtime, undefined)
    assert.match(none.reason, /可见/)
    await hidden.disposeAll()

    const stopped = new WikiFarm(registry([mk('y', { autostart: false })]), { createRuntime: quietFactory() })
    const idle = resolveAgentScope(stopped, {}, 's1')
    assert.equal(idle.runtime, undefined)
    assert.equal(idle.entry.id, 'y')
    assert.match(idle.reason, /没有运行/)
  })

  await test('scope：插件还没就绪（farm 未建）时给一句人话，而不是抛错', () => {
    const scope = resolveAgentScope(undefined, {}, 's1')
    assert.equal(scope.runtime, undefined)
    assert.match(scope.reason, /尚未就绪/)
  })

  // ── 工具回执：多库时每个结果都必须标明用的哪个库 ──────────────────────────
  /** A client good enough for tiddlywiki_get. */
  const stubClient = { get: async (title) => ({ title, text: 'hello', tags: [] }) }
  const registeredTools = []
  const register = (deps) => {
    registeredTools.length = 0
    registerTiddlywikiTools(
      { tools: { register: (tool) => { registeredTools.push(tool); return () => {} } } },
      { scope: () => deps, git: {}, wikiPath: () => ROOT, autoCommit: () => {} },
    )
    return registeredTools.find((tool) => tool.name === 'tiddlywiki_get')
  }
  const runGet = async (tool) => {
    const args = { title: 'Note' }
    const value = await tool.execute(args, { agent: { id: 's1' } })
    return tool.output.render(args, value).map((line) => line.text).join('\n')
  }

  await test('工具回执：单库（ambiguous=false）不加头 —— 现有用户逐字节不变', async () => {
    const tool = register({ client: stubClient, ambiguous: false })
    const text = await runGet(tool)
    assert.ok(!text.startsWith('【知识库'), `单库不得加头：\n${text}`)
  })

  await test('工具回执：多库（ambiguous=true）每个结果都带【知识库：名字（id）】', async () => {
    const tool = register({ client: stubClient, id: 'work', label: '工作', ambiguous: true })
    const text = await runGet(tool)
    assert.match(text, /^【知识库：工作（work）】/, `多库必须标明用的是哪个库：\n${text}`)
  })

  await test('工具回执：无 client 时用 reason 报错，而不是含糊的"服务未运行"', async () => {
    const tool = register({ ambiguous: false, reason: '知识库「书籍」当前没有运行，请先在界面上启动它再试' })
    await assert.rejects(() => tool.execute({ title: 'Note' }, { agent: { id: 's1' } }), /书籍.*没有运行/)
  })
  await test('写：读不出来（非 ENOENT）必须中止，不许当成"没有文件"整份重写', async () => {
    // v0.29.0：以前 `.catch(() => '')` 把 EACCES/EBUSY/并发 tmp+rename 竞态全都
    // 收敛成空串，接着这份"读-改-写"会重写整个 sessions.json —— 其它会话的作用域
    // 一起没了。用一个**目录**冒充文件即可稳定触发非 ENOENT 的读失败。
    const dirAsFile = join(scratch, 'scope-is-a-directory')
    await mkdir(dirAsFile, { recursive: true })
    await assert.rejects(
      () => setSessionScope('s-loss', 'books', dirAsFile),
      (err) => err !== null && typeof err === 'object' && err.code !== 'ENOENT',
    )
    const stats = await stat(dirAsFile)
    assert.equal(stats.isDirectory(), true, '拒绝写入后必须原样保留那个路径（没被改成文件）')
  })
} finally {
  await rm(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nSESSION SCOPE CHECKS OK' : `\nSESSION SCOPE CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

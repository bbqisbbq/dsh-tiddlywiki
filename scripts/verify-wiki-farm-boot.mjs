#!/usr/bin/env node
/**
 * 多知识库「真起两个 TW 子进程」的验收（v0.28.0）——真 WikiServer、真 REST、真 seed。
 *
 * 与 `verify-wiki-farm.mjs` 的分工：那边用**假实例**把 reconcile 规则钉死（毫秒级），
 * 这边用**真的**跑一遍，只为回答几个只有真进程才能回答的问题：
 *   · 两个库能不能各占一个回环端口同时服务（端口不撞、互不干扰）？
 *   · 每个库的第一次启动（--init server → markdown 插件 → seed → 可能重启）会不会
 *     互相踩（seed 写串、文件等待串）？
 *   · 配置真的独立吗（往 A 写 config tiddler，B 必须看不见）？
 *   · 停掉一个，另一个是否照常服务？按需启动第三个呢？
 *
 * 这三个问题都是"多库"的承重墙，靠单测的假实例答不出来。
 *
 *   node scripts/verify-wiki-farm-boot.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-wiki-farm-boot
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitFace, TiddlyWebClient, WikiFarm, WikiInstance, resolveTwRoot } from '../lib/index.js'

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

/** The cordis base layer every instance starts from (auto-commit OFF: no git noise). */
const base = {
  git: { autoCommit: false, debounceMs: 60_000, remote: '', branch: 'main' },
  note: { tag: 'inbox', workspaceMark: true },
  bridge: { enabled: false, port: 8618, token: '', tag: 'clip' },
  startup: { readyTimeoutMs: 90_000 },
  wechat: { enabled: false, command: 'opencli', token: '', adapter: 'publish-note', dsn: '' },
  ui: {
    showQuickNote: true, showQuickNoteDock: true, quickNoteMode: 'native', sidebarLabel: 'TW',
    showPanelStatus: true, showSyncButton: true, followDshTheme: true,
    darkPalette: '$:/palettes/CupertinoDark', tabLabel: '知识库', showSessionTab: true,
    showRightbarTab: true, sendToAgent: { enabled: true }, allArticles: { pageSize: 10 },
  },
  uiLanguage: '',
  auth: { username: '', password: '' },
}

const root = await mkdtemp(join(tmpdir(), 'dsh-tw-farm-'))
console.log('temp root:', root)

const registry = {
  version: 1,
  mode: 'multi',
  defaultId: 'a',
  wikis: [
    { id: 'a', label: '甲', root, name: 'wikiA', agentVisible: true, autostart: true },
    { id: 'b', label: '乙', root, name: 'wikiB', agentVisible: false, autostart: true },
    { id: 'c', label: '丙', root, name: 'wikiC', agentVisible: true, autostart: false },
  ],
}

const log = []
const farm = new WikiFarm(registry, {
  createRuntime: (entry) => new WikiInstance({ entry, base, git: new GitFace(), twRoot: resolveTwRoot }),
  log: (message) => { log.push(message); console.log('  [farm]', message) },
})

/** 真链路的客户端（instance.client() 就是它）。 */
const clientOf = (id) => {
  const runtime = farm.runtime(id)
  assert.ok(runtime !== undefined, `知识库 ${id} 必须在运行`)
  const client = runtime.client()
  assert.ok(client !== undefined, `知识库 ${id} 必须已经绑定端口`)
  return client
}

try {
  const change = await farm.startAll()

  await test('multi 模式：只起 autostart 的两个，第三个按需', () => {
    assert.deepEqual(change.started, ['a', 'b'], `实际启动：${JSON.stringify(change.started)}`)
    assert.deepEqual(farm.runningIds(), ['a', 'b'])
    assert.equal(farm.runtime('c'), undefined, 'autostart=false 的库不该被实例化')
    assert.deepEqual(change.errors, [], '两个库都不该有启动错误')
  })

  await test('两个库各占一个端口、各自 ready、互不干扰', () => {
    const a = farm.runtime('a').server
    const b = farm.runtime('b').server
    assert.equal(a.status().status, 'running')
    assert.equal(b.status().status, 'running')
    assert.ok((a.currentPort ?? 0) > 0 && (b.currentPort ?? 0) > 0)
    assert.notEqual(a.currentPort, b.currentPort, '两个子进程不得共用端口')
    assert.notEqual(a.status().pid, b.status().pid, '必须是两个进程')
  })

  await test('每个库都被单独播种（markdown 插件 + tw-web-host 代理基址）', async () => {
    for (const id of ['a', 'b']) {
      const tiddler = await clientOf(id).get('$:/config/tiddlyweb/host')
      assert.ok(tiddler !== undefined, `知识库 ${id} 必须被 seed 上同源代理基址`)
      assert.match(tiddler.text, /^\/dsh-tiddlywiki\/tw\//, `知识库 ${id} 的代理基址不对：${tiddler.text}`)
    }
  })

  await test('写入互不串台：A 的笔记在 B 里不存在', async () => {
    await clientOf('a').put({ title: 'OnlyInA', text: '甲库的内容', tags: [] })
    assert.ok((await clientOf('a').get('OnlyInA')) !== undefined)
    assert.equal(await clientOf('b').get('OnlyInA'), undefined, 'A 的写入不得出现在 B')
  })

  await test('配置真的独立：A 的 config tiddler 只影响 A', async () => {
    await clientOf('a').put({
      title: '$:/plugins/dsh-tiddlywiki/config',
      text: JSON.stringify({ note: { tag: 'only-a' } }),
      type: 'application/json',
      tags: [],
    })
    const runtimeA = farm.runtime('a')
    await runtimeA.config.load(runtimeA.client())
    assert.equal(runtimeA.noteTag(), 'only-a', 'A 必须读到自己那份覆盖')
    assert.equal(farm.runtime('b').noteTag(), 'inbox', 'B 不得被 A 的配置影响')
  })

  await test('停掉一个，另一个照常服务（默认库也跟着回落）', async () => {
    await farm.stopEntry('a')
    assert.deepEqual(farm.runningIds(), ['b'])
    assert.equal(farm.runtime('b').server.status().status, 'running', 'B 必须继续服务')
    assert.equal(farm.runtime('a'), undefined, 'A 的 runtime 必须被释放')
    assert.equal(farm.defaultRuntime().entry.id, 'b', 'defaultId 没在跑时必须回落')
    assert.ok((await clientOf('b').get('OnlyInA')) === undefined, 'B 仍然读不到 A 的内容')
  })

  await test('按需启动第三个（不进 autostart）', async () => {
    await farm.startEntry(registry.wikis[2])
    assert.equal(farm.runtime('c').server.status().status, 'running')
    assert.deepEqual(farm.runningIds(), ['b', 'c'])
    const c = clientOf('c')
    assert.ok(c instanceof TiddlyWebClient)
    await c.put({ title: 'OnlyInC', text: '丙库', tags: [] })
    assert.ok((await c.get('OnlyInC')) !== undefined)
  })
} finally {
  await test('disposeAll：全部停下、无孤儿、可重复调用', async () => {
    const before = farm.runningIds()
    await farm.disposeAll()
    assert.deepEqual(farm.runningIds(), [])
    assert.deepEqual(farm.allRuntimes(), [])
    await farm.disposeAll()
    assert.deepEqual(farm.runningIds(), [])
    console.log(`  已释放：${before.join(', ') || '（无）'}`)
  })
  await rm(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nWIKI FARM BOOT OK' : `\nWIKI FARM BOOT FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

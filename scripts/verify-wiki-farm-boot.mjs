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
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore, GitFace, TW_PROXY_PREFIX, TiddlyWebClient, WikiFarm, WikiInstance, applyWikiAction, entryPath, registerAdminRoutes, registerRoutes, resolveTwRoot, targetRuntimeFor, writeRegistry } from '../lib/index.js'
import { createRouteServer } from './lib/tw-harness.mjs'

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

  // ── 路由层：把真实路由挂到已启动的农场上（真 HTTP，不是直接调 handler）──────
  const registered = []
  const disposeRoutes = registerRoutes(
    { webServer: { register: (route) => { registered.push(route); return () => {} } } },
    {
      // 与 index.ts 用**同一个** selector 实现（targetRuntimeFor）：测试里再写一份
      // "怎么解析 ?wiki=" 就正好是这份仓库最贵的那种漂移（第一版就是栽在这里）。
      server: (req) => targetRuntimeFor(farm, req)?.server,
      wikiSummaries: () => ({
        mode: farm.registry.mode,
        defaultId: farm.registry.defaultId,
        items: farm.registry.wikis.map((entry) => {
          const runtime = farm.runtime(entry.id)
          return {
            id: entry.id, label: entry.label,
            status: runtime?.server.status().status ?? 'stopped',
            agentVisible: entry.agentVisible, autostart: entry.autostart,
            running: runtime !== undefined, path: entryPath(entry),
          }
        }),
      }),
      serverById: (id) => farm.runtime(id)?.server,
      wikiIds: () => farm.registry.wikis.map((e) => e.id),
      getClient: (req) => targetRuntimeFor(farm, req)?.client(),
      git: new GitFace(),
      autoCommit: () => {},
      noteDefaults: () => ({ tag: 'inbox' }),
      uiDefaults: () => WikiInstance.uiDefaultsFrom(base),
      getWikiPath: (req) => targetRuntimeFor(farm, req)?.path ?? '',
    },
  )
  const harness = createRouteServer(registered)
  const baseUrl = await harness.listen()

  await test('/tw/<id>/ 命名代理：各打各的子进程，绝不串台', async () => {
    await clientOf('b').put({ title: 'OnlyInB', text: '乙库', tags: [] })
    // TW 的服务器首页会把 store 内联进 HTML，所以"谁的内容"一目了然。
    const htmlB = await (await fetch(`${baseUrl}${TW_PROXY_PREFIX}/b/`)).text()
    assert.ok(htmlB.includes('OnlyInB'), '命名代理 /tw/b/ 必须打到 B 的 store')
    assert.ok(!htmlB.includes('OnlyInC'), '命名代理 /tw/b/ 不得串到 C')
    const htmlC = await (await fetch(`${baseUrl}${TW_PROXY_PREFIX}/c/`)).text()
    assert.ok(htmlC.includes('OnlyInC'), '命名代理 /tw/c/ 必须打到 C 的 store')
    assert.ok(!htmlC.includes('OnlyInB'), '命名代理 /tw/c/ 不得串到 B')
  })

  await test('/tw/ 裸形式：仍是「默认库」的别名（旧链接、书签不能失效）', async () => {
    const html = await (await fetch(`${baseUrl}${TW_PROXY_PREFIX}`)).text()
    assert.ok(html.includes('OnlyInB'), '裸 /tw/ 必须打到默认库（B，defaultId 失守后回落）')
    assert.ok(!html.includes('OnlyInC'), '裸 /tw/ 不得串到 C')
  })

  await test('未注册的 id 被当作 TW 自己的路径（不会被误当库名）', async () => {
    const res = await fetch(`${baseUrl}${TW_PROXY_PREFIX}/nope/status`)
    assert.equal(res.status, 404, 'nope 不是知识库 id，应原样交给 TW 而由 TW 回 404')
    await res.arrayBuffer()
  })

  await test('受保护的命名空间在命名形式下同样被挡（两个形式都过守卫）', async () => {
    const res = await fetch(`${baseUrl}${TW_PROXY_PREFIX}/b/${encodeURIComponent('$:/plugins/dsh-tiddlywiki/config')}`)
    assert.equal(res.status, 403, '命名代理不得成为绕过 $:/plugins/dsh-tiddlywiki/ 封锁的新入口')
    await res.arrayBuffer()
  })

  await test('?wiki=<id> 让非代理路由也能定向（设置页/工具卡走这条）', async () => {
    const res = await fetch(`${baseUrl}/dsh-tiddlywiki/status?wiki=c`)
    assert.equal(res.status, 200)
    const payload = await res.json()
    assert.equal(payload.wikiPath, farm.runtime('c').path, '?wiki=c 必须把请求指向 C')
    const fallback = await (await fetch(`${baseUrl}/dsh-tiddlywiki/status?wiki=nope`)).json()
    assert.equal(fallback.wikiPath, farm.runtime('b').path, '未知 id 必须回落默认库，而不是 404')
  })

  await test('/status 回传知识库名册（GUI 选择器与设置页靠它）', async () => {
    const payload = await (await fetch(`${baseUrl}/dsh-tiddlywiki/status`)).json()
    assert.equal(payload.mode, 'multi')
    assert.equal(payload.defaultId, 'a')
    assert.deepEqual(payload.wikis.map((w) => w.id), ['a', 'b', 'c'])
    const b = payload.wikis.find((w) => w.id === 'b')
    assert.equal(b.running, true)
    assert.equal(b.status, 'running')
    assert.equal(b.agentVisible, false, '乙库对 agent 隐身这条必须传到前端')
    const a = payload.wikis.find((w) => w.id === 'a')
    assert.equal(a.running, false, '已停的库必须如实报告 running=false（而不是消失）')
    assert.equal(a.path, join(root, 'wikiA'), '停着的库也要带回路径，设置页才能显示它在哪')
  })

  // ── 设置页的「知识库列表」写路径（/admin/wikis）────────────────────────────
  // 动作规则由纯函数 applyWikiAction 提供（与宿主同一份实现），这里验的是**接线**：
  // 同一条路径上 GET/POST 的分发、落盘、以及农场是否真的把新库起起来。
  const controlFile = join(root, 'wikis.json')
  let control = { ...registry }
  const idleStore = new ConfigStore({})
  const wikisFace = {
    info: async () => ({
      mode: control.mode,
      defaultId: control.defaultId,
      source: 'file',
      registryFile: controlFile,
      warnings: [],
      wikis: control.wikis.map((e) => ({
        id: e.id, label: e.label, root: e.root, name: e.name, path: entryPath(e),
        agentVisible: e.agentVisible, autostart: e.autostart,
        running: farm.runtime(e.id) !== undefined,
        status: farm.runtime(e.id)?.server.status().status ?? 'stopped',
      })),
    }),
    apply: async (body) => {
      const action = applyWikiAction(control, body)
      if (action.registry === undefined) return { ok: false, error: action.error }
      control = action.registry
      await writeRegistry(control, controlFile)
      const change = await farm.apply(control)
      return { ok: true, info: await wikisFace.info(), change }
    },
  }
  const disposeAdmin = registerAdminRoutes(
    { webServer: { register: (route) => { registered.push(route); return () => {} } } },
    {
      server: (req) => targetRuntimeFor(farm, req)?.server,
      getClient: (req) => targetRuntimeFor(farm, req)?.client(),
      getWikiPath: (req) => targetRuntimeFor(farm, req)?.path ?? '',
      twRoot: resolveTwRoot,
      config: () => idleStore,
      wikis: wikisFace,
      seeds: { checkAll: async () => [], run: async () => [], remove: async () => [] },
    },
  )

  await test('/admin/wikis：GET 把控制文件里的清单整份吐出来', async () => {
    const res = await fetch(`${baseUrl}/dsh-tiddlywiki/admin/wikis`)
    assert.equal(res.status, 200)
    const payload = await res.json()
    assert.equal(payload.mode, 'multi')
    assert.equal(payload.defaultId, 'a')
    assert.deepEqual(payload.wikis.map((w) => w.id), ['a', 'b', 'c'])
  })

  await test('/admin/wikis：非法动作 → 400 + 原因，且不落盘、不起进程', async () => {
    const res = await fetch(`${baseUrl}/dsh-tiddlywiki/admin/wikis`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'add', wiki: { id: 'b', root, name: 'wikiB2' } }),
    })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /已存在/)
    assert.equal(farm.runtime('b2'), undefined, '被拒的动作不得产生任何进程')
  })

  await test('/admin/wikis：add 落盘 + 农场真的把新库起起来（autostart）', async () => {
    const res = await fetch(`${baseUrl}/dsh-tiddlywiki/admin/wikis`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'add', wiki: { id: 'd', label: '丁', root, name: 'wikiD', agentVisible: true, autostart: true } }),
    })
    assert.equal(res.status, 200)
    const payload = await res.json()
    assert.deepEqual(payload.change.started, ['d'], `新增的自启库必须真的起来：${JSON.stringify(payload.change)}`)
    assert.equal(farm.runtime('d').server.status().status, 'running')
    const onDisk = JSON.parse(await readFile(controlFile, 'utf8'))
    assert.deepEqual(onDisk.wikis.map((w) => w.id), ['a', 'b', 'c', 'd'], '清单必须落盘')
  })

  await test('/admin/wikis：remove 停掉并释放（文件与运行集一起收敛）', async () => {
    const res = await fetch(`${baseUrl}/dsh-tiddlywiki/admin/wikis`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'remove', id: 'd' }),
    })
    assert.equal(res.status, 200)
    const payload = await res.json()
    assert.deepEqual(payload.change.stopped, ['d'])
    assert.equal(farm.runtime('d'), undefined, '删掉的库必须被停掉并释放')
    const onDisk = JSON.parse(await readFile(controlFile, 'utf8'))
    assert.deepEqual(onDisk.wikis.map((w) => w.id), ['a', 'b', 'c'])
  })

  disposeAdmin()
  disposeRoutes()
  await harness.close()
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

#!/usr/bin/env node
/**
 * 「发布到公众号」按钮的守门脚本（v0.23.3）。
 *
 * 这个功能有三处**只能靠测试钉住**的危险面，本脚本按这三块组织：
 *
 *   1. **命令行组装**（纯函数）：Windows 上 opencli 是 `.cmd` shim，必须经
 *      cmd.exe；用户标题里的 `&`/`"`/`%`/`^` 于是成了命令注入面 —— 所以标题
 *      走 UTF-8 文件、不进 argv。这里断言「标题绝不出现在 argv 里」，并用一个
 *      **假的 opencli**（.cmd/.sh → node 桩）真跑一遍完整 spawn 路径，桩会把
 *      拿到的 argv 写进 capture 文件，供逐字断言。
 *   2. **任务状态机**：单并发 busy、成功/失败回执、超时终止。
 *   3. **路由守卫**：方法校验（GET 405）、同源（cross-site 403）、可选 token
 *      （401）、未启用（403）、标题不存在（400）、未知 job（404），全部走真实
 *      HTTP（createRouteServer）而不是直接调 handler。
 *
 * 不依赖真 opencli、不碰微信、不发任何外部请求；`npx tsx` 不需要，直接 node 跑
 * （只 import lib/）。
 *
 *   node scripts/verify-wechat-publish.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-wechat-publish
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createRouteServer } from './lib/tw-harness.mjs'
import {
  WechatPublishRunner,
  buildPublishInvocation,
  buildVersionInvocation,
  interpretPublishOutcome,
  normalizeWechatConfig,
  scanAdapterDir,
  checkWechatReady,
  isSafeCliValue,
  isSafeDsn,
  capOutput,
  tailOf,
  WECHAT_ADAPTER_FILES,
  registerRoutes,
} from '../lib/index.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROUTE_PREFIX = '/dsh-tiddlywiki'

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

// ── 1. 命令行组装：纯函数 ─────────────────────────────────────────────────
const TITLE_FILE = process.platform === 'win32' ? 'C:\\tmp\\job.title' : '/tmp/job.title'
const DSN = 'http://127.0.0.1:3080/dsh-tiddlywiki'

await test('Windows：命令经 cmd.exe + windowsVerbatimArguments（.cmd shim 才跑得起来）', () => {
  const inv = buildPublishInvocation({ platform: 'win32', command: 'opencli', adapter: 'publish-note', titleFile: TITLE_FILE, dsn: DSN })
  assert.match(inv.file, /cmd\.exe$/i, `win32 必须用 cmd.exe 启动 shim，实际 ${inv.file}`)
  assert.deepEqual(inv.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.equal(inv.windowsVerbatimArguments, true, '必须让命令行原样送达，否则 Node 会二次转义我们的引号')
  const line = inv.args[3]
  assert.ok(line.includes('weixin publish-note'), `命令行缺少子命令：${line}`)
  assert.ok(line.includes('--title-file'), '命令行必须带 --title-file')
  assert.ok(line.includes('--trace retain-on-failure'), '必须写死 --trace retain-on-failure（不带就 Navigation rejected）')
  assert.ok(line.includes('-f json'), '回执必须走 JSON，宿主才能解析')
})

await test('POSIX：直接 exec，不经 shell', () => {
  const inv = buildPublishInvocation({ platform: 'linux', command: 'opencli', adapter: 'publish-note-imgs', titleFile: TITLE_FILE, dsn: DSN })
  assert.equal(inv.file, 'opencli')
  assert.equal(inv.windowsVerbatimArguments, false)
  assert.deepEqual(inv.args, ['weixin', 'publish-note-imgs', '--title-file', TITLE_FILE, '--dsn', DSN, '--trace', 'retain-on-failure', '-f', 'json'])
})

await test('标题绝不进 argv：带 cmd 元字符的标题只出现在参数值里（--title-file 路径）', () => {
  const title = 'A & B "quoted" %PATH% ^ | < > 中文'
  const inv = buildPublishInvocation({ platform: 'win32', command: 'opencli', adapter: 'publish-note', titleFile: TITLE_FILE, dsn: DSN })
  const joined = [inv.file, ...inv.args].join(' ')
  assert.ok(!joined.includes(title), '标题不得出现在命令行里')
  assert.ok(!joined.includes('&'), '命令行里不得出现 cmd 元字符 &（标题已挡在文件里）')
  assert.ok(!joined.includes('%'), '不得出现 % （cmd 变量展开）')
})

await test('组装器拒绝不安全输入（adapter 白名单 / command 与 dsn 校验）', () => {
  assert.throws(() => buildPublishInvocation({ platform: 'win32', command: 'opencli', adapter: 'evil-adapter', titleFile: TITLE_FILE, dsn: DSN }), /unsupported wechat adapter/)
  assert.throws(() => buildPublishInvocation({ platform: 'win32', command: 'opencli & calc', adapter: 'publish-note', titleFile: TITLE_FILE, dsn: DSN }), /cannot be passed to the CLI/)
  assert.throws(() => buildPublishInvocation({ platform: 'linux', command: 'opencli', adapter: 'publish-note', titleFile: TITLE_FILE, dsn: 'http://x/$(id)' }), /invalid wechat dsn/)
  assert.equal(isSafeCliValue('opencli'), true)
  assert.equal(isSafeCliValue('a"b'), false)
  assert.equal(isSafeCliValue('a\nb'), false)
  assert.equal(isSafeDsn('http://127.0.0.1:3080/dsh-tiddlywiki'), true)
  assert.equal(isSafeDsn('http://user:pw@host/x'), false)
  assert.equal(isSafeDsn('http://127.0.0.1:3080/dsh-tiddlywiki?x=1'), false)
})

await test('版本探测同样走 shim 路径', () => {
  const inv = buildVersionInvocation({ platform: 'win32', command: 'opencli' })
  assert.match(inv.file, /cmd\.exe$/i)
  assert.deepEqual(inv.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.ok(inv.args[3].includes('--version'))
})

// ── 2. 回执解析 / 有界输出 / 配置归一化 ───────────────────────────────────
await test('interpretPublishOutcome：JSON 回执、退出码、stderr 末行', () => {
  const ok = interpretPublishOutcome({ code: 0, stdout: 'noise\n[{"status":"草稿已保存","title":"t","detail":"正文 12 字"}]\n', stderr: '' })
  assert.equal(ok.state, 'ok')
  assert.ok(ok.message.includes('草稿已保存') && ok.message.includes('正文 12 字'), `回执应带上状态与细节，实际 ${ok.message}`)
  const noJson = interpretPublishOutcome({ code: 0, stdout: 'done', stderr: '' })
  assert.equal(noJson.state, 'ok')
  assert.ok(noJson.message.length > 0)
  const bad = interpretPublishOutcome({ code: 1, stdout: '', stderr: 'Error: Navigation rejected\n' })
  assert.equal(bad.state, 'error')
  assert.ok(bad.message.includes('Navigation rejected'), `失败必须带上 stderr 末行，实际 ${bad.message}`)
  const killed = interpretPublishOutcome({ code: null, stdout: '', stderr: '' })
  assert.equal(killed.state, 'error')
})

await test('输出有界：capOutput 截断、tailOf 取尾', () => {
  const long = 'x'.repeat(100)
  assert.equal(capOutput(long, 10).length, 10)
  assert.equal(capOutput('abc', 10), 'abc')
  assert.equal(tailOf(`head${'y'.repeat(50)}TAIL`, 4), 'TAIL')
  assert.equal(tailOf('  ok  ', 10), 'ok')
})

await test('normalizeWechatConfig：垃圾值回落默认（不落到命令行上）', () => {
  const bad = normalizeWechatConfig({ enabled: 'yes', command: '   ', adapter: 'rm -rf /', token: 42, dsn: 7 })
  assert.equal(bad.enabled, false, 'enabled 只认真正的 true')
  assert.equal(bad.command, 'opencli')
  assert.equal(bad.adapter, 'publish-note')
  assert.equal(bad.token, '')
  assert.equal(bad.dsn, '')
  const good = normalizeWechatConfig({ enabled: true, command: ' /opt/opencli ', adapter: 'publish-note-imgs', token: ' sek ', dsn: DSN })
  assert.deepEqual(good, { enabled: true, command: '/opt/opencli', adapter: 'publish-note-imgs', token: 'sek', dsn: DSN })
})

await test('scanAdapterDir：缺目录 = 全缺，半装状态如实报告', () => {
  const none = scanAdapterDir('/definitely/missing', () => { throw new Error('ENOENT') })
  assert.equal(none.publishNote, false)
  assert.equal(none.publishNoteImgs, false)
  assert.deepEqual(none.missing.sort(), [...new Set([...WECHAT_ADAPTER_FILES['publish-note'], ...WECHAT_ADAPTER_FILES['publish-note-imgs']])].sort())
  const partial = scanAdapterDir('x', () => ['publish-note.js', 'wechat-html.js', 'weixin-flow.js'])
  assert.equal(partial.publishNote, true)
  assert.equal(partial.publishNoteImgs, false)
  assert.deepEqual(partial.missing, ['publish-note-imgs.js'])
  const full = scanAdapterDir('x', () => ['publish-note.js', 'publish-note-imgs.js', 'wechat-html.js', 'weixin-flow.js'])
  assert.equal(full.publishNote && full.publishNoteImgs, true)
  assert.deepEqual(full.missing, [])
})

// ── 3. 真跑 spawn：假 opencli（.cmd/.sh → node 桩）────────────────────────
const tmp = await mkdtemp(path.join(tmpdir(), 'dsh-tw-wechat-'))

/** 假 opencli：实现 --version 与 publish 两种调用，并把 argv 写进 capture。 */
function writeStub(dir) {
  const stubJs = path.join(dir, 'stub.mjs')
  fs.writeFileSync(stubJs, `import fs from 'node:fs'
const argv = process.argv.slice(2)
if (process.env.STUB_CAPTURE) fs.writeFileSync(process.env.STUB_CAPTURE, JSON.stringify(argv))
if (argv.includes('--version')) { process.stdout.write((process.env.STUB_VERSION || '9.9.9') + '\\n'); process.exit(0) }
const at = argv.indexOf('--title-file')
const title = at >= 0 ? fs.readFileSync(argv[at + 1], 'utf8') : ''
const sleep = Number(process.env.STUB_SLEEP_MS || 0)
if (sleep > 0) await new Promise((r) => setTimeout(r, sleep))
if ((process.env.STUB_MODE || 'ok') === 'error') { process.stderr.write('模拟失败：Navigation rejected\\n'); process.exit(1) }
process.stdout.write(JSON.stringify([{ status: '草稿已保存', title, detail: '正文 12 字 · ' + title }]) + '\\n')
`, 'utf8')
  if (process.platform === 'win32') {
    const cmd = path.join(dir, 'fake-opencli.cmd')
    fs.writeFileSync(cmd, `@echo off\r\nnode "%~dp0stub.mjs" %*\r\n`, 'utf8')
    return cmd
  }
  const sh = path.join(dir, 'fake-opencli.sh')
  fs.writeFileSync(sh, `#!/bin/sh\nexec node "$(dirname "$0")/stub.mjs" "$@"\n`, 'utf8')
  fs.chmodSync(sh, 0o755)
  return sh
}

const stub = writeStub(tmp)
const capture = path.join(tmp, 'argv.json')
const jobDir = path.join(tmp, 'jobs')
process.env.STUB_CAPTURE = capture

const makeRunner = (extra = {}) => new WechatPublishRunner({
  command: () => stub,
  jobDir,
  now: () => Date.now(),
  timeoutMs: 20_000,
  ...extra,
})

const METACHAR_TITLE = 'A & B "quoted" %PATH% ^ 中文标题'

await test('E2E：起任务 → 桩收到 --title-file → 标题以 UTF-8 原样到达 → 回执 ok', async () => {
  const runner = makeRunner()
  const result = runner.start({ title: METACHAR_TITLE, adapter: 'publish-note', dsn: DSN })
  assert.equal(result.ok, true, `起任务失败：${result.ok ? '' : result.error}`)
  const job = await waitJob(runner, result.job.id, 15_000)
  assert.equal(job.state, 'ok', `任务应成功，实际 ${job.state} / ${job.message}`)
  assert.ok(job.message.includes('草稿已保存'), `回执应带上 adapter 的 status，实际 ${job.message}`)
  assert.ok(job.message.includes(METACHAR_TITLE), '桩回显的标题必须与写入的标题逐字一致（证明 UTF-8 文件通路可用）')
  const argv = JSON.parse(fs.readFileSync(capture, 'utf8'))
  assert.ok(argv.includes('--title-file'), 'argv 里必须有 --title-file')
  assert.ok(!argv.some((a) => a.includes('A & B')), `标题不得出现在 argv 里，实际 ${JSON.stringify(argv)}`)
  assert.ok(!argv.some((a) => a.includes('中文')), '标题（含中文）不得出现在 argv 里')
  assert.ok(fs.readFileSync(path.join(jobDir, `${result.job.id}.title`), 'utf8') === METACHAR_TITLE, '标题文件必须是精确的 UTF-8 标题')
  runner.dispose()
})

await test('E2E：单并发 —— 第二个任务拿到 busy，而不是叠一个 opencli', async () => {
  const runner = makeRunner()
  process.env.STUB_SLEEP_MS = '1500'
  const first = runner.start({ title: '第一篇', adapter: 'publish-note', dsn: DSN })
  assert.equal(first.ok, true)
  const second = runner.start({ title: '第二篇', adapter: 'publish-note', dsn: DSN })
  assert.equal(second.ok, false)
  assert.equal(second.busy, true, '并发起任务必须被拦下')
  assert.equal(second.job.id, first.job.id, 'busy 回执要带上正在跑的 jobId')
  assert.equal(runner.status(second.job.id).title, '第一篇')
  delete process.env.STUB_SLEEP_MS
  const done = await waitJob(runner, first.job.id, 15_000)
  assert.equal(done.state, 'ok')
  runner.dispose()
})

await test('E2E：桩失败 → 任务 error 且带上 stderr 末行', async () => {
  const runner = makeRunner()
  process.env.STUB_MODE = 'error'
  const result = runner.start({ title: '会失败的笔记', adapter: 'publish-note', dsn: DSN })
  const job = await waitJob(runner, result.job.id, 15_000)
  assert.equal(job.state, 'error')
  assert.ok(job.message.includes('Navigation rejected'), `失败回执应带上 stderr，实际 ${job.message}`)
  assert.ok(job.log.includes('模拟失败'), 'log 尾部要留下过程输出')
  delete process.env.STUB_MODE
  runner.dispose()
})

await test('E2E：超时终止（不留下永不结束的任务）', async () => {
  const runner = makeRunner({ timeoutMs: 400 })
  process.env.STUB_SLEEP_MS = '8000'
  const result = runner.start({ title: '慢任务', adapter: 'publish-note', dsn: DSN })
  const job = await waitJob(runner, result.job.id, 15_000)
  assert.equal(job.state, 'error')
  assert.ok(job.message.includes('超时'), `超时必须如实报告，实际 ${job.message}`)
  delete process.env.STUB_SLEEP_MS
  runner.dispose()
})

await test('就绪探测：真跑一次 --version；adapter 目录按缺文件如实报告', async () => {
  const adaptersDir = path.join(tmp, 'adapters')
  fs.mkdirSync(adaptersDir, { recursive: true })
  const missing = await checkWechatReady({ enabled: true, command: stub, adaptersDir })
  assert.equal(missing.opencli.ok, true, `opencli 探测应成功，实际 ${JSON.stringify(missing.opencli)}`)
  assert.equal(missing.opencli.version, '9.9.9')
  assert.equal(missing.adapters.publishNote, false)
  assert.ok(missing.adapters.missing.includes('publish-note.js'))
  assert.equal(missing.ok, false, '缺 adapter 时 ok 必须为 false')
  for (const f of ['publish-note.js', 'publish-note-imgs.js', 'wechat-html.js', 'weixin-flow.js']) {
    fs.writeFileSync(path.join(adaptersDir, f), '// stub\n', 'utf8')
  }
  const ready = await checkWechatReady({ enabled: true, command: stub, adaptersDir })
  assert.equal(ready.ok, true)
  assert.equal(ready.adapters.publishNote && ready.adapters.publishNoteImgs, true)
  const disabled = await checkWechatReady({ enabled: false, command: stub, adaptersDir })
  assert.equal(disabled.ok, false, '功能未启用时 ok 必须是 false')
  const noCli = await checkWechatReady({ enabled: true, command: path.join(tmp, 'nope-does-not-exist'), adaptersDir, probeTimeoutMs: 2_000 })
  assert.equal(noCli.opencli.ok, false, 'CLI 不存在时必须报 ok:false 而不是抛错')
})

async function waitJob(runner, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = runner.status(id)
    if (job !== undefined && job.state !== 'running') return job
    if (Date.now() >= deadline) throw new Error(`任务 ${id} 在 ${timeoutMs}ms 内没有结束（${JSON.stringify(job)}）`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

// ── 4. 路由守卫（真实 HTTP）──────────────────────────────────────────────
await test('路由：未启用 403 / 方法校验 405 / 同源 403 / token 401 / 正常起任务', async () => {
  const routes = []
  const webServer = {
    register: (entry) => {
      routes.push(entry)
      return () => {
        const i = routes.indexOf(entry)
        if (i >= 0) routes.splice(i, 1)
      }
    },
  }
  let config = { enabled: false, command: stub, token: '', adapter: 'publish-note', dsn: '' }
  const runner = makeRunner()
  const dispose = registerRoutes({ webServer }, {
    server: {},
    getClient: () => ({ get: async (title) => (title === 'known' ? { title, text: 'x' } : undefined) }),
    git: {},
    autoCommit: () => {},
    noteDefaults: () => ({ tag: 'inbox' }),
    uiDefaults: () => ({}),
    getWikiPath: () => tmp,
    getSessionController: () => undefined,
    getWorkspaceRegistry: () => undefined,
    getAgentPresets: () => undefined,
    getSessionPersistence: () => undefined,
    getPermissionPresets: () => undefined,
    getSessions: () => undefined,
    getSessionQuery: () => undefined,
    sendToAgentEnabled: () => true,
    sendToAgentToken: () => '',
    wechatConfig: () => config,
    wechatRunner: () => runner,
    wechatReady: async () => ({
      ok: true,
      enabled: config.enabled,
      command: stub,
      opencli: { ok: true, version: '9.9.9' },
      adapters: { dir: 'x', publishNote: true, publishNoteImgs: true, missing: [] },
    }),
  })
  const srv = createRouteServer(routes)
  const base = await srv.listen()
  const url = (p) => `${base}${ROUTE_PREFIX}${p}`
  const post = (p, body, headers = {}) => fetch(url(p), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

  try {
    // 未启用：三条路由都必须 403（可选功能默认关）
    assert.equal((await fetch(url('/wechat/ready'))).status, 403)
    assert.equal((await post('/wechat/publish', { title: 'known' })).status, 403)
    assert.equal((await fetch(url('/wechat/publish/status'))).status, 403)

    config = { ...config, enabled: true }
    // 方法校验：GET 打写路由必须 405（宿主只按 pathname 分发）
    assert.equal((await fetch(url('/wechat/publish'))).status, 405, 'GET /wechat/publish 必须 405')
    // 同源守卫
    assert.equal((await post('/wechat/publish', { title: 'known' }, { origin: 'http://evil.example' })).status, 403)
    assert.equal((await post('/wechat/publish', { title: 'known' }, { 'sec-fetch-site': 'cross-site' })).status, 403)
    // 标题校验
    assert.equal((await post('/wechat/publish', {})).status, 400)
    assert.equal((await post('/wechat/publish', { title: 'missing-note' })).status, 400, '不存在的笔记必须在起任务前被挡下')
    assert.equal((await post('/wechat/publish', { title: 'known', adapter: 'evil' })).status, 400)
    assert.equal((await post('/wechat/publish', { title: '$:/plugins/dsh-tiddlywiki/config' })).status, 400, '插件密钥命名空间不得发布')
    // token：配置后无头 401、带头通过
    config = { ...config, token: 'sekret' }
    assert.equal((await post('/wechat/publish', { title: 'known' })).status, 401)
    assert.equal((await fetch(url('/wechat/ready'))).status, 401)
    config = { ...config, token: '' }
    // 正常路径：起任务 → 状态可查；未知 id → 404；无 id → 当前/最新
    const started = await post('/wechat/publish', { title: 'known' })
    // Read the body ONCE — an `await resp.text()` inside the assertion message
    // would consume it before `resp.json()` (v0.23.3 test bug).
    const startedRaw = await started.text()
    assert.equal(started.status, 200, `起任务应 200，实际 ${started.status} ${startedRaw}`)
    const body = JSON.parse(startedRaw)
    assert.equal(body.ok, true)
    assert.ok(typeof body.jobId === 'string' && body.jobId.length > 0)
    assert.equal((await fetch(url('/wechat/publish/status?id=nope'))).status, 404)
    const status = await (await fetch(url('/wechat/publish/status?id=' + body.jobId))).json()
    assert.equal(status.ok, true)
    assert.equal(status.job.id, body.jobId)
    const job = await waitJob(runner, body.jobId, 15_000)
    assert.equal(job.state, 'ok', '桩命令应把任务跑到 ok')
    const current = await (await fetch(url('/wechat/publish/status'))).json()
    assert.equal(current.job.id, body.jobId, '不带 id 时返回最新任务')
    // ready 回执形状（TW 按钮按这些字段做预检）
    const ready = await (await fetch(url('/wechat/ready'))).json()
    assert.equal(ready.ok, true)
    assert.equal(ready.enabled, true)
    assert.equal(ready.opencli.ok, true)
    assert.ok(ready.adapters && typeof ready.adapters.publishNote === 'boolean')
  } finally {
    dispose()
    runner.dispose()
    await srv.close()
    delete process.env.STUB_CAPTURE
    // Windows: a just-killed cmd.exe tree can hold the job dir for a moment —
    // temp cleanup must not turn a green run red.
    try {
      await rm(tmp, { recursive: true, force: true })
    } catch { /* best-effort temp cleanup */ }
  }
})

// ── 5. 源码级接线断言（防「路由改了但没注册 / 没打码」）─────────────────
await test('routes.ts：三条路由都过 guardHandler，写路由声明 POST，读路由声明非读', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'host', 'routes.ts'), 'utf8').replace(/\r\n/g, '\n')
  for (const p of ['/wechat/ready', '/wechat/publish', '/wechat/publish/status']) {
    assert.ok(src.includes(`\${ROUTE_PREFIX}${p}\`, handler: guardHandler(`), `${p} 必须经 guardHandler 注册`)
  }
  assert.ok(src.includes("if (rejectCrossSiteWrite(req, res, ['POST'])) return\n      if (!guardWechat(req, res)) return"), '/wechat/publish 必须先判方法+同源，再判功能开关/token')
  assert.ok(src.includes("const got = req.headers['x-wechat-publish-token']"), 'token 头名必须与 TW 按钮一致')
  assert.ok(src.includes('req.socket.localPort'), 'dsn 必须由请求端口推导（opencli 从本机回连）')
})

await test('index.ts / admin.ts：runner 接线、teardown 释放、wechat.token 打码', () => {
  const idx = fs.readFileSync(path.join(repoRoot, 'src', 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
  assert.ok(idx.includes('new WechatPublishRunner('), 'index.ts 必须创建 runner')
  assert.ok(idx.includes('disposers.push(() => wechatRunner.dispose())'), 'runner 必须随插件销毁（否则留下孤儿浏览器标签）')
  assert.ok(idx.includes('wechatReady: () => checkWechatReady('), 'wechatReady 必须接到就绪探测')
  const admin = fs.readFileSync(path.join(repoRoot, 'src', 'host', 'admin.ts'), 'utf8').replace(/\r\n/g, '\n')
  assert.ok(admin.includes('token: maskToken(wechat.token)'), '/admin/state 必须把 wechat.token 打码（新增密钥字段的既有约定）')
  assert.ok(admin.includes('if (copy.wechat !== undefined) copy.wechat = cleanToken(copy.wechat)'), '回存的 ******** 必须被丢弃，不能覆盖真 token')
})

console.log(failures === 0 ? '\nWECHAT PUBLISH OK' : `\nWECHAT PUBLISH FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

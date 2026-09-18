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

// ── 2. 回执解析 / 有界输出 / 配置归一化 / adapter 版本校验 ────────────────
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

// ── 2b. adapter 版本校验（缺陷 C：文件都在但版本过旧）────────────────────
// 注入式假 adapter 目录。这几个字面量是**故意手写的**（不从 lib 读常量）：
// 脚本必须能构造「旧版文件」——按定义它就不含那个符号。判据本身是正则
// （`export function resolveNoteTitle(` / `name: 'titleFile'`），所以旧版夹具
// 即使在注释里**提到**这些名字也必须判旧（见下面「只在注释里提到」那条断言，
// 收紧 includes 判据就是为了这个）。真源码的符号由本文件末尾的源码级断言独立
// 钉住，两边漂移就会变红。
const FRESH_FLOW = 'export function resolveNoteTitle(title, titleFile) { /* v0.23.3+ */ }\n'
const STALE_FLOW = 'export function runFlow(kwargs) { /* v0.23.2：flow 里没有标题文件解析器 */ }\n'
const FRESH_ENTRY = "// v0.23.3+ 入口\n{ name: 'title', positional: true }\n{ name: 'titleFile' }\n"
const STALE_ENTRY = "// v0.23.2 入口：标题是必填位置参数，不认 --title-file\n{ name: 'title', required: true, positional: true }\n"
/**
 * 「旧文件但在注释里提到过新符号」——`includes()` 判据会把它误判为新版，
 * 正则是唯一能挡住它的形状（也是子代理第一版夹具骗过自己的原因）。
 */
const COMMENT_ONLY_FLOW = 'export function runFlow(kwargs) { /* TODO: 将来像 resolveNoteTitle 那样支持 --title-file */ }\n'
const FRESH_ADAPTER_FILE_TEXT = {
  'publish-note.js': FRESH_ENTRY,
  'publish-note-imgs.js': FRESH_ENTRY,
  'wechat-html.js': '// 语义 HTML → 内联样式装饰器（无版本专属符号，永不判旧）\n',
  'weixin-flow.js': FRESH_FLOW,
  // install-wechat-adapters.mjs 的 FILES 里第 5 个：它不是 publish adapter，
  // scanAdapterDir 不管它（既不算 missing 也不参与版本校验）。
  'create-article.js': '// 从本地 HTML 建草稿的一次性入口\n',
}
const ALL_ADAPTER_FILES = Object.keys(FRESH_ADAPTER_FILE_TEXT)

/**
 * 注入式 readFile：按文件名返回内容，overrides 可给某个文件换成旧内容（字符串）
 * 或改成抛错（函数）。默认的四个文件全都是「新版」。
 */
function fakeReadFile(overrides = {}) {
  return (p) => {
    const name = path.basename(p)
    if (Object.prototype.hasOwnProperty.call(overrides, name)) {
      const value = overrides[name]
      if (typeof value === 'function') return value(p)
      return value
    }
    const text = FRESH_ADAPTER_FILE_TEXT[name]
    if (text === undefined) throw new Error(`ENOENT: ${p}`)
    return text
  }
}

await test('scanAdapterDir：缺目录 = 全缺，半装状态如实报告（missing 不掺旧文件）', () => {
  const none = scanAdapterDir('/definitely/missing', () => { throw new Error('ENOENT') })
  assert.equal(none.publishNote, false)
  assert.equal(none.publishNoteImgs, false)
  assert.deepEqual(none.missing.sort(), [...new Set([...WECHAT_ADAPTER_FILES['publish-note'], ...WECHAT_ADAPTER_FILES['publish-note-imgs']])].sort())
  assert.deepEqual(none.stale, [], '目录都没有，谈不上「文件过旧」')
  const partial = scanAdapterDir('x', () => ['publish-note.js', 'wechat-html.js', 'weixin-flow.js'], fakeReadFile())
  assert.equal(partial.publishNote, true)
  assert.equal(partial.publishNoteImgs, false)
  assert.deepEqual(partial.missing, ['publish-note-imgs.js'])
  assert.deepEqual(partial.stale, [])
  const full = scanAdapterDir('x', () => ALL_ADAPTER_FILES, fakeReadFile())
  assert.equal(full.publishNote && full.publishNoteImgs, true)
  assert.deepEqual(full.missing, [])
  assert.deepEqual(full.stale, [])
})

await test('版本校验：五个文件都在（真实安装形状）且都是新版 → 两个 adapter 都可用、stale 为空', () => {
  const scan = scanAdapterDir('x', () => ALL_ADAPTER_FILES, fakeReadFile())
  assert.equal(scan.publishNote, true, '新版五件套必须判可用')
  assert.equal(scan.publishNoteImgs, true)
  assert.equal(scan.stale.length, 0, `全都新鲜时 stale 必须为空，实际 ${JSON.stringify(scan.stale)}`)
  assert.deepEqual(scan.missing, [])
})

await test('版本校验：weixin-flow.js 过旧（无 resolveNoteTitle）→ 两个 adapter 一起作废', () => {
  const scan = scanAdapterDir('x', () => ALL_ADAPTER_FILES, fakeReadFile({ 'weixin-flow.js': STALE_FLOW }))
  assert.ok(scan.stale.includes('weixin-flow.js'), `旧 flow 必须进 stale，实际 ${JSON.stringify(scan.stale)}`)
  assert.equal(scan.publishNote, false, '入口 import 不到 resolveNoteTitle，publish-note 必须判不可用')
  assert.equal(scan.publishNoteImgs, false, '两个入口共用同一个 flow，必须一起作废')
  assert.deepEqual(scan.missing, [], '文件都在，绝不能塞进 missing（否则用户会去重装一遍同样的旧文件）')
})

await test('版本校验：只有 publish-note.js 过旧（无 titleFile）→ 另一个 adapter 仍可用', () => {
  const scan = scanAdapterDir('x', () => ALL_ADAPTER_FILES, fakeReadFile({ 'publish-note.js': STALE_ENTRY }))
  assert.deepEqual(scan.stale, ['publish-note.js'], `stale 必须精确到那一份，实际 ${JSON.stringify(scan.stale)}`)
  assert.equal(scan.publishNote, false, '旧入口不认 --title-file（宿主只会发它）→ 必须判不可用，这正是 v0.23.3 的事故')
  assert.equal(scan.publishNoteImgs, true, '另一个入口与共享 flow 都是新的，必须仍可用')
})

await test('版本校验：旧文件只在注释里提到新符号 → 仍必须判旧（判据是定义，不是字符串出现）', () => {
  const scan = scanAdapterDir('x', () => ALL_ADAPTER_FILES, fakeReadFile({ 'weixin-flow.js': COMMENT_ONLY_FLOW }))
  assert.ok(scan.stale.includes('weixin-flow.js'), `注释里的提及不算新版，实际 ${JSON.stringify(scan.stale)}`)
  assert.equal(scan.publishNote, false, 'includes() 判据会误判为可用 —— 正则收紧就是为了挡住它')
})

await test('版本校验：文件不存在只进 missing，不进 stale（两种语义不混）', () => {
  const scan = scanAdapterDir('x', () => ['weixin-flow.js', 'wechat-html.js'], fakeReadFile())
  assert.deepEqual(scan.missing.sort(), ['publish-note-imgs.js', 'publish-note.js'])
  assert.deepEqual(scan.stale, [], '不存在的文件没有「过旧」可言')
  assert.equal(scan.publishNote, false)
  assert.equal(scan.publishNoteImgs, false)
  const mixed = scanAdapterDir('x', () => ['publish-note.js', 'wechat-html.js', 'weixin-flow.js'], fakeReadFile({ 'publish-note.js': STALE_ENTRY }))
  assert.deepEqual(mixed.missing, ['publish-note-imgs.js'], '旧的 publish-note.js 存在 → 不能算 missing')
  assert.deepEqual(mixed.stale, ['publish-note.js'])
})

await test('版本校验：读文件失败（EACCES / 目录被删）一律判过旧，绝不抛错', () => {
  const unreadable = scanAdapterDir('x', () => ALL_ADAPTER_FILES, fakeReadFile({ 'weixin-flow.js': () => { throw new Error('EACCES: permission denied') } }))
  assert.ok(unreadable.stale.includes('weixin-flow.js'), '读不到就无法证明是新版 → 保守判旧')
  assert.equal(unreadable.publishNote, false)
  assert.equal(unreadable.publishNoteImgs, false)
  const allFail = scanAdapterDir('x', () => ALL_ADAPTER_FILES, () => { throw new Error('EPERM: operation not permitted') })
  assert.deepEqual(allFail.stale.sort(), ['publish-note-imgs.js', 'publish-note.js', 'weixin-flow.js'])
  assert.deepEqual(allFail.missing, [], '读失败 ≠ 文件不存在')
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

await test('就绪探测：真跑一次 --version；adapter 目录按缺文件 / 版本过旧如实报告', async () => {
  const adaptersDir = path.join(tmp, 'adapters')
  fs.mkdirSync(adaptersDir, { recursive: true })
  const missing = await checkWechatReady({ enabled: true, command: stub, adaptersDir })
  assert.equal(missing.opencli.ok, true, `opencli 探测应成功，实际 ${JSON.stringify(missing.opencli)}`)
  assert.equal(missing.opencli.version, '9.9.9')
  assert.equal(missing.adapters.publishNote, false)
  assert.ok(missing.adapters.missing.includes('publish-note.js'))
  assert.equal(missing.ok, false, '缺 adapter 时 ok 必须为 false')
  // 写真正「新版」的文件内容：走默认 readFileSync，顺带证明真 fs 通路可用。
  for (const [name, text] of Object.entries(FRESH_ADAPTER_FILE_TEXT)) {
    fs.writeFileSync(path.join(adaptersDir, name), text, 'utf8')
  }
  const ready = await checkWechatReady({ enabled: true, command: stub, adaptersDir })
  assert.equal(ready.ok, true)
  assert.equal(ready.adapters.publishNote && ready.adapters.publishNoteImgs, true)
  assert.deepEqual(ready.adapters.stale, [], '真 fs 通路也必须判定为新鲜')
  // 回归（缺陷 C）：文件一个不少、但 flow 是老版本 → 预检必须报 stale 且 ok=false，
  // 而不是「就绪」让用户点了按钮才失败。
  fs.writeFileSync(path.join(adaptersDir, 'weixin-flow.js'), STALE_FLOW, 'utf8')
  const aged = await checkWechatReady({ enabled: true, command: stub, adaptersDir })
  assert.equal(aged.ok, false, '旧版 adapter 绝不能被预检判「就绪」（v0.23.3 的真实事故）')
  assert.ok(aged.adapters.stale.includes('weixin-flow.js'), `stale 必须透传到 ready.adapters，实际 ${JSON.stringify(aged.adapters)}`)
  assert.deepEqual(aged.adapters.missing, [], '文件都在 → missing 必须是空的，503 文案才能说清是「版本旧」')
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
      adapters: { dir: 'x', publishNote: true, publishNoteImgs: true, missing: [], stale: [] },
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
    assert.ok(Array.isArray(ready.adapters.stale), 'ready 回执必须原样带出 adapters.stale（routes.ts 的 503 文案要用它区分「缺文件」与「版本旧」）')
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

await test('源码：真 adapter 与宿主版本常量都带那两个符号（防我们自己的 adapter 将来退化）', () => {
  const readSrc = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8')
  const flow = readSrc(path.join('tools', 'wechat', 'weixin-flow.js'))
  assert.ok(flow.includes('resolveNoteTitle'), 'tools/wechat/weixin-flow.js 必须导出 resolveNoteTitle（宿主按它判版本）')
  for (const entry of ['publish-note.js', 'publish-note-imgs.js']) {
    assert.ok(readSrc(path.join('tools', 'wechat', entry)).includes('titleFile'), `tools/wechat/${entry} 必须声明 titleFile（--title-file 是宿主唯一的标题通路）`)
  }
  // 宿主常量与上面的字面量是**同一份契约**：脚本按字面量构造夹具、宿主按常量判定，
  // 两边漂移 = 版本校验静默失效（夹具永远绿，生产却判不出旧版）。
  const host = readSrc(path.join('src', 'host', 'wechat-publish.ts')).replace(/\r\n/g, '\n')
  assert.ok(host.includes("export const WECHAT_ADAPTER_MARKER = 'resolveNoteTitle'"), 'WECHAT_ADAPTER_MARKER 必须仍是 resolveNoteTitle（与真 flow 的符号对齐）')
  assert.ok(host.includes("const WECHAT_TITLE_FILE_ARG = 'titleFile'"), '入口版本哨兵必须仍是 titleFile（与真入口声明的参数名对齐）')
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

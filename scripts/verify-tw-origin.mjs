#!/usr/bin/env node
/**
 * 「TW 前端 API 基址」在非 http(s) 文档里也要能同步（v0.26.7，桌面版缺陷）。
 *
 * 事故：TiddlyWiki 自己的 TiddlyWeb sync adaptor 只在文档协议以 `http` 开头时
 * 才会导出（`plugins/tiddlywiki/tiddlyweb/tiddlywebadaptor.js`：
 * `if($tw.browser && document.location.protocol.substr(0,4) === "http")`）。DSH
 * **桌面版**用自定义 scheme `dsh-app:` 渲染界面，于是 iframe 里的 TW 没有
 * syncadaptor → `$:/status/IsReadOnly` 永远没人写 → TW 的只读样式表（`default="yes"`，
 * 未知即当只读）把 添加条目 / 添加日志 / 导入 / 条目管理器 / 编辑 / 删除 全藏起来，
 * 而且保存走 `dirtyTracking`（本地脏标记，永不落盘）。实测复现：同一份 wiki 页
 * 用 `file://`（同样非 http）打开，页面控件里 ＋ 就消失。
 *
 * 修法：**让嵌入式 TW 跑在真正的 http origin 上**——宿主把「本机回环绝对基址」
 * （`twProxyAbsolute` / `twUrlAbsolute`）一并回来，客户端只在自己不是 http(s)
 * 时才用它（`resolveTwUrl`）。http(s) 页面继续用相对路径，所以 loopback / 局域网 /
 * Tailscale / 域名 / HTTPS 部署的行为一字不变。
 *
 * 断的是三件最容易悄悄坏掉的事：
 *   1. 宿主侧的绝对基址推导（含 Host 头校验，脏头必须拒绝）；
 *   2. 客户端解析器：http(s) 忽略绝对值（绝不把 https 页面降级到别处）；
 *      非 http(s) 且给了绝对基址时才改用；
 *   3. 接线：/status、/edit、/session/summary 都带上绝对孪生字段，frame 与
 *      快速笔记弹窗都走解析器，跨源 frame 的 hash 导航不再抛 SecurityError。
 *
 *   npx tsx scripts/verify-tw-origin.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-tw-origin
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFamily } from './lib/source-family.mjs' // v0.28.8：按「模块族」读源码，拆分不断言路径

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

/** Exact-file read (this guard also reads plain `.mjs` scripts and pins two specific modules). */
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8')
/** Module-family read: `<relBase>` + `<relBase>-*` — a pure split must not turn these red. */
const readSrc = (relBase) => readFamily(repoRoot, relBase)
const mod = async (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href)

/* ────────────────── 1. 宿主侧：绝对基址推导 ────────────────── */

const { absoluteHostBase } = await mod('src/host/http.ts')

await test('absoluteHostBase：正常 Host 头 → http://<host><proxyPath>', () => {
  assert.equal(absoluteHostBase('127.0.0.1:19387', '/dsh-tiddlywiki/tw/'), 'http://127.0.0.1:19387/dsh-tiddlywiki/tw/')
  assert.equal(absoluteHostBase('127.0.0.1', '/x/'), 'http://127.0.0.1/x/')
  assert.equal(absoluteHostBase('  localhost:3080  ', '/dsh-tiddlywiki/tw/'), 'http://localhost:3080/dsh-tiddlywiki/tw/')
  assert.equal(absoluteHostBase('[::1]:3080', '/tw/'), 'http://[::1]:3080/tw/')
})

await test('absoluteHostBase：脏/缺失 Host 头一律拒绝（不拼进 URL）', () => {
  for (const bad of [undefined, '', '   ', 'evil.example/../../x', 'user:pw@host', 'host with space', 'host?x=1', 'host#f']) {
    assert.equal(absoluteHostBase(bad, '/dsh-tiddlywiki/tw/'), undefined, `应拒绝 ${JSON.stringify(bad)}`)
  }
  // 重复头（数组）只取第一个，且同样要过校验。
  assert.equal(absoluteHostBase(['127.0.0.1:3080', 'evil'], '/tw/'), 'http://127.0.0.1:3080/tw/')
  assert.equal(absoluteHostBase(['evil/path'], '/tw/'), undefined)
})

await test('宿主接线：/status 与两个 twUrl 载荷都带上绝对孪生字段', () => {
  // v0.28.8：`/session/summary` 的 handler 搬进了 routes-session.ts，所以这条断言
  // 必须跨**两个**文件数「两处 twUrlAbsolute」—— 规则没变（桌面壳需要一个绝对
  // 基址），变的只是它们所在的文件。钉死单文件会在纯搬迁后假红。
  //
  // v0.30.2：会话路由这一侧改成按**模块族**读（`routes-session.ts` +
  // `routes-session-*.ts`）。下一步要拆的正是那个 432 行的 createSessionRoutes()
  // （汇总 handler 会搬去 routes-session-summary.ts）—— 族读让「规则」继续成立，
  // 而**计数**仍是 2，所以这条断言不会退化成「数了几个文件」。
  const routes = read('src/host/routes.ts')
  const sessionFamily = readSrc('src/host/routes-session')
  assert.ok(sessionFamily.includes('createSessionRoutes'), 'routes-session 族里找不到 createSessionRoutes（基名写错了？）')
  const all = `${routes}\n${sessionFamily}`
  assert.match(routes, /twProxyAbsolute: twProxyAbsoluteBase\(req\)/, '/status 必须回 twProxyAbsolute')
  const twins = all.match(/twUrlAbsolute: (?:deps\.)?twProxyAbsoluteBase\(req\)/g) ?? []
  assert.equal(twins.length, 2, `/edit 与 /session/summary 都要回 twUrlAbsolute（实际 ${twins.length} 处）`)
  assert.match(routes, /const twProxyAbsoluteBase = \(req: IncomingMessage\): string \| undefined => absoluteHostBase\(req\.headers\.host, TW_PROXY_PATH\)/)
  // 搬家后 base 函数经 SessionRouteDeps 注入，所以要确认它真的被传了进去
  // （注入了却没传 = 汇总回执丢掉绝对地址，桌面壳点开会走错 origin）。
  assert.match(routes, /twProxyAbsoluteBase,/, 'twProxyAbsoluteBase 必须注入会话路由')
})

/* ────────────────── 2. 客户端：解析器 ────────────────── */

const { resolveTwUrl } = await mod('src/client/endpoints.ts')

/** Run `fn` with a stubbed page `location` (the resolver reads it at call time). */
function withLocation(protocol, origin, fn) {
  const real = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', { value: { protocol, origin }, configurable: true, writable: true })
  try {
    return fn()
  } finally {
    if (real === undefined) delete globalThis.location
    else Object.defineProperty(globalThis, 'location', real)
  }
}

await test('resolveTwUrl：http(s) 页面继续用自身 origin 的相对路径', () => {
  withLocation('http:', 'http://127.0.0.1:19387', () => {
    assert.equal(resolveTwUrl('/dsh-tiddlywiki/tw/', 'http://127.0.0.1:9999/dsh-tiddlywiki/tw/'), 'http://127.0.0.1:19387/dsh-tiddlywiki/tw/')
  })
  withLocation('https:', 'https://wiki.example.com', () => {
    // 关键：https 页面绝不因为宿主多回一个绝对地址就被降级到 http 别处。
    assert.equal(resolveTwUrl('/dsh-tiddlywiki/tw/', 'http://127.0.0.1:19387/dsh-tiddlywiki/tw/'), 'https://wiki.example.com/dsh-tiddlywiki/tw/')
  })
})

await test('resolveTwUrl：非 http(s) 文档（桌面版 dsh-app:）改用宿主的绝对基址', () => {
  withLocation('dsh-app:', 'dsh-app://app', () => {
    assert.equal(resolveTwUrl('/dsh-tiddlywiki/tw/', 'http://127.0.0.1:19387/dsh-tiddlywiki/tw/'), 'http://127.0.0.1:19387/dsh-tiddlywiki/tw/')
    // 老服务端不回绝对字段时不回归：仍按自身 origin 解析（与修复前一致）。
    assert.equal(resolveTwUrl('/dsh-tiddlywiki/tw/'), 'dsh-app://app/dsh-tiddlywiki/tw/')
    assert.equal(resolveTwUrl('/dsh-tiddlywiki/tw/', ''), 'dsh-app://app/dsh-tiddlywiki/tw/')
  })
  withLocation('file:', 'file://', () => {
    assert.equal(resolveTwUrl('/dsh-tiddlywiki/tw/', 'http://127.0.0.1:19387/dsh-tiddlywiki/tw/'), 'http://127.0.0.1:19387/dsh-tiddlywiki/tw/')
  })
})

await test('客户端接线：frame 与快速笔记弹窗都走 resolveTwUrl', () => {
  const frame = readSrc('src/client/tw-frame')
  // v0.28.0：先经 twProxyFor(mode, wikiId, …) 得到**本库**的基址（相对与绝对都带 id），
  // 再交给 resolveTwUrl 决定用相对还是宿主的绝对基址。两步都不能少：
  // v0.28.14：换库快路径（switchFrameNow）也要用同一套 —— 焦点一变就同步换文档，
  // 而**不是**等 /status 往返，于是 tw-frame 里现在有**两处** showFrame 调用点，
  // 两处都必须走 resolveTwUrl。所以判据从"钉死某一行"改成"数调用点"：
  //   ① 每次 twProxyFor 都要拿到相对与绝对两个基址；
  //   ② 每个 showFrame 的地址参数都必须是 resolveTwUrl(bases.relative, bases.absolute)，
  //      不许出现拿裸基址直接 showFrame 的写法。
  assert.match(frame, /const bases = twProxyFor\(payload\.mode, wiki, payload\.twProxy, payload\.twProxyAbsolute\)/)
  const proxies = frame.match(/const bases = twProxyFor\(payload\.mode, wiki, payload\.twProxy, payload\.twProxyAbsolute\)/g) ?? []
  assert.ok(
    proxies.length >= 2,
    `doRefresh 与换库快路径都要先经 twProxyFor 拿到本库的两个基址（实际 ${proxies.length} 处）`,
  )
  const resolved = frame.match(/showFrame\(resolveTwUrl\(bases\.relative, bases\.absolute\), wiki/g) ?? []
  assert.ok(
    resolved.length >= 2,
    `doRefresh 与换库快路径都必须经 resolveTwUrl 交地址（实际 ${resolved.length} 处）`,
  )
  assert.ok(
    !/showFrame\((?:bases\.(?:relative|absolute)|payload\.twProxy)/.test(frame),
    'showFrame 不得直接吃裸基址：非 http(s) 文档（桌面版 dsh-app:）必须换成宿主的绝对 http 基址，否则 TW 没有同步器',
  )
  assert.match(frame, /import \{ RESTART_ENDPOINT, resolveTwUrl, twProxyFor \} from '\.\/endpoints\.ts'/)
  const note = readSrc('src/client/note-widget')
  // v0.28.0：快速笔记弹窗同样先经 twProxyFor 得到**本卡片目标库**的基址（写入与随后打开的
  // 编辑器必须落在同一个库，否则是"写进 A、编辑器打开 B（空的）"），再交给 resolveTwUrl
  // 决定相对还是宿主绝对基址。
  assert.match(note, /const bases = twProxyFor\(rosterMode, targetWiki, payload\.twUrl, payload\.twUrlAbsolute\)/)
  assert.match(note, /resolveTwUrl\(bases\.relative, bases\.absolute\)/)
  const cache = readSrc('src/client/status-cache')
  assert.match(cache, /twProxyAbsolute\?: string/)
})

/* ────────────────── 3. 跨源 frame 的 hash 导航 ────────────────── */

await test('applyPendingHash：跨源读 $tw 必须被 try/catch 包住并兜底整页加载', () => {
  const source = readSrc('src/client/tw-frame')
  const start = source.indexOf('const tryOnce = (attempt: number): void => {')
  assert.ok(start > 0, '找不到 tryOnce')
  const body = source.slice(start, source.indexOf('tryOnce(0)', start))
  assert.match(body, /try \{[\s\S]*?frameTw\.\$tw[\s\S]*?\} catch \{[\s\S]*?fallbackLoad\(hash\)/, '跨源读取必须被 try/catch 包住并兜底')
  // 行为级验证在 verify-frame-surface.mjs（那里有完整的 DOM 打桩）。
  assert.ok(
    read('scripts/verify-frame-surface.mjs').includes('跨源 frame：读 $tw 抛 SecurityError 时兜底整页加载'),
    'verify-frame-surface.mjs 必须保留跨源兜底的行为单测',
  )
})

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')

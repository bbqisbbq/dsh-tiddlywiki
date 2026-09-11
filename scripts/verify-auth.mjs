#!/usr/bin/env node
/**
 * auth 模式端到端守门（`auth.username` / `auth.password` 非空 = TW 子进程带
 * `readers`/`writers` 启动，全站 401 + Basic 挑战）。
 *
 * 这是此前**零覆盖**、也是最高风险的一条路径：任何一处漏带 preemptive Basic 头
 * （WikiServer.waitReady / TiddlyWebClient）都会让插件 20s 后 failed；两处 base64
 * 编码只要有一处漂移，非 ASCII 口令就会静默 401。
 *
 * 断言：
 *   1. 全新临时 wiki 用 username/password 启动能 `running`（不是超时 failed）；
 *   2. 匿名 `GET /status` → 401 且带 `WWW-Authenticate: Basic …`；
 *      带正确的（UTF-8）Basic 头 → 200；
 *   3. 口令用**非 ASCII**（`s3cr3t-🔑`）：wiki.ts 与 tw-api.ts 各自实现的 base64
 *      编码必须一致（客户端内部凭据头 === 直接请求用的头；latin1 变体必须被 401
 *      拒绝，证明本用例真的能抓到编码漂移）；
 *   4. `TiddlyWebClient` 带凭据可写可读；不带凭据 get/put/list 一律 401；
 *   5. `/tw` 同源代理转发 `WWW-Authenticate`（匿名 401 → 浏览器弹登录框；带凭据 200）；
 *   6. **安全**：`WikiServer.status().logs` 里不得出现明文口令。
 *
 * 需要先 `npm run build`（import lib/index.js），会 spawn 真实 TW。
 *
 *   node scripts/verify-auth.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-auth
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WikiServer, TiddlyWebClient, GitFace, registerRoutes, TW_PROXY_PREFIX } from '../lib/index.js'

const USER = 'alice'
/** 故意用非 ASCII：base64(UTF-8) 与 base64(latin1) 不同，能抓编码漂移。 */
const PASS = 's3cr3t-🔑'

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

const root = await mkdtemp(join(tmpdir(), 'dsh-tw-verify-auth-'))
const wikiDir = join(root, 'main')
console.log(`temp wiki root: ${root} (auth: ${USER} / ${PASS})`)

const server = new WikiServer({ wikiRoot: root, wiki: 'main', port: 0, username: USER, password: PASS })
const utf8Header = `Basic ${Buffer.from(`${USER}:${PASS}`, 'utf8').toString('base64')}`
const latin1Header = `Basic ${Buffer.from(`${USER}:${PASS}`, 'latin1').toString('base64')}`

let mini
let disposeRoutes
let view
let startError
try {
  try {
    view = await server.start()
  } catch (err) {
    startError = err
  }

  await test('auth 模式启动：能 ready（不是 20s 超时 failed）', () => {
    assert.equal(startError, undefined, `WikiServer.start() 抛错：${startError && startError.message}（auth 模式下 /status 匿名 401，waitReady 必须带 preemptive Basic 头）`)
    assert.equal(view?.status, 'running', `WikiServer 状态应为 running，实际 ${JSON.stringify(view?.status)}，error=${JSON.stringify(view?.error)}`)
    assert.ok(String(view?.url).startsWith('http://127.0.0.1:'), `url 应为回环地址：${view?.url}`)
    assert.ok(typeof view?.pid === 'number' && view.pid > 0, `应记录子进程 pid：${view?.pid}`)
  })

  if (view !== undefined) {
    // ── 2. 匿名 401 + 挑战头；正确 Basic → 200 ──────────────────────────────
    await test('匿名 GET /status → 401 且带 WWW-Authenticate: Basic', async () => {
      const res = await fetch(`${view.url}/status`)
      assert.equal(res.status, 401, `匿名 /status 应为 401，实际 ${res.status}`)
      const challenge = res.headers.get('www-authenticate')
      assert.ok(challenge !== null && /^Basic\b/i.test(challenge), `401 必须带 Basic 挑战头（浏览器才会弹登录框），实际 ${JSON.stringify(challenge)}`)
    })

    await test('带正确（UTF-8）Basic 头 → 200，且 username 就是配置的用户', async () => {
      const res = await fetch(`${view.url}/status`, { headers: { authorization: utf8Header } })
      assert.equal(res.status, 200, `带正确凭据的 /status 应为 200，实际 ${res.status}`)
      const body = await res.json()
      assert.equal(body.anonymous, false, `应识别为已认证：${JSON.stringify(body)}`)
      assert.equal(body.username, USER, `认证用户名应为 ${USER}，实际 ${JSON.stringify(body.username)}`)
    })

    // ── 3. base64 编码一致性（非 ASCII 口令） ───────────────────────────────
    await test('非 ASCII 口令：wiki.ts / tw-api.ts 两处 base64 编码一致（latin1 变体被拒）', async () => {
      // 先证明本用例有区分力：utf8 与 latin1 的 base64 必须不同。
      assert.notEqual(latin1Header, utf8Header, `测试前提不成立：口令 ${PASS} 的 utf8/latin1 base64 相同，本用例抓不到编码漂移`)
      const client = new TiddlyWebClient(view.url, { username: USER, password: PASS })
      if (typeof client.authHeader === 'string') {
        assert.equal(client.authHeader, utf8Header, 'TiddlyWebClient 的 Basic 头必须是 UTF-8 base64（与 wiki.ts 的 waitReady 探测、与直接请求一致）')
      } else {
        // 实现若不再把凭据头缓存在 authHeader 上，编码一致性仍由「带非 ASCII
        // 凭据可写」的行为断言覆盖（latin1 编码会 401）——所以这里只是跳过加码。
        console.log('      （跳过直接比对 authHeader：实现不再暴露该字段，改由行为断言覆盖）')
      }
      // WikiServer 侧：start() 用非 ASCII 口令成功 ready，本身就证明 wiki.ts 的
      // base64 与 TW 的 UTF-8 解码一致；再补一条「漂移真的会被拒」的反证。
      const wrong = await fetch(`${view.url}/status`, { headers: { authorization: latin1Header } })
      assert.equal(wrong.status, 401, '用 latin1 编码的 Basic 头必须被 401 拒绝（TW 按 UTF-8 解码）——否则本用例没有区分力')
    })

    // ── 4. 客户端凭据语义 ──────────────────────────────────────────────────
    await test('TiddlyWebClient：带凭据可写可读；不带凭据 get/put/list 一律 401', async () => {
      const auth = new TiddlyWebClient(view.url, { username: USER, password: PASS })
      await auth.put({ title: 'AuthNote', text: 'auth write ok', tags: ['auth-probe'] })
      const got = await auth.get('AuthNote')
      assert.equal(got?.text, 'auth write ok', '带凭据写入后应能读回')
      const anon = new TiddlyWebClient(view.url)
      await assert.rejects(() => anon.get('AuthNote'), /401/, '匿名读必须 401 报错（不能静默返回 undefined）')
      await assert.rejects(() => anon.put({ title: 'AuthAnonWrite', text: 'nope' }), /401/, '匿名写必须 401 报错')
      await assert.rejects(() => anon.list(undefined, true), /401/, '匿名列表必须 401 报错')
      assert.equal(await auth.get('AuthAnonWrite'), undefined, '匿名写必须真的没写进 wiki')
    })

    // ── 5. /tw 代理转发挑战头 ──────────────────────────────────────────────
    const registered = []
    disposeRoutes = registerRoutes(
      { webServer: { register: (route) => { registered.push(route); return () => {} } } },
      {
        server,
        getClient: () => new TiddlyWebClient(view.url, { username: USER, password: PASS }),
        git: new GitFace(),
        autoCommit: () => {},
        noteDefaults: () => ({ tag: 'inbox' }),
        uiDefaults: () => ({
          showQuickNote: true, showQuickNoteDock: true, quickNoteMode: 'native', sidebarLabel: 'TiddlyWiki',
          showPanelStatus: true, showSyncButton: true, followDshTheme: true, darkPalette: '$:/palettes/CupertinoDark',
          tabLabel: '知识库', showSessionTab: true, showRightbarTab: true,
        }),
        getWikiPath: () => wikiDir,
      },
    )
    // 迷你 HTTP 调度器：exact → 最长前缀（与 dsh-host-webserver 的匹配一致），
    // 走真实 socket 而不是直接调 handler —— 才能看到状态码与响应头。
    mini = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      let handler
      const exact = registered.find((r) => r.kind === 'exact' && r.path === pathname)
      if (exact !== undefined) handler = exact.handler
      else {
        let best
        for (const r of registered) {
          if (r.kind !== 'prefix') continue
          if (pathname !== r.path && !pathname.startsWith(`${r.path}/`)) continue
          if (best === undefined || r.path.length > best.path.length) best = r
        }
        handler = best?.handler
      }
      if (handler === undefined) { res.writeHead(404); res.end(); return }
      Promise.resolve(handler(req, res)).catch((err) => {
        if (!res.headersSent) { res.writeHead(400); res.end(String(err)) }
        else res.destroy()
      })
    })
    const miniPort = await new Promise((resolveP) => mini.listen(0, '127.0.0.1', () => resolveP(mini.address().port)))
    const miniBase = `http://127.0.0.1:${miniPort}`

    await test('/tw 代理：匿名 401 并转发 WWW-Authenticate；带凭据 200', async () => {
      const anonRes = await fetch(`${miniBase}${TW_PROXY_PREFIX}/status`)
      const challenge = anonRes.headers.get('www-authenticate')
      assert.equal(anonRes.status, 401, `匿名访问 /tw/status 应透传 TW 的 401，实际 ${anonRes.status}`)
      assert.ok(challenge !== null && /^Basic\b/i.test(challenge), `/tw 代理必须转发 WWW-Authenticate（否则内嵌编辑器只显示裸 401、不弹登录框），实际 ${JSON.stringify(challenge)}`)
      await anonRes.arrayBuffer()
      const okRes = await fetch(`${miniBase}${TW_PROXY_PREFIX}/status`, { headers: { authorization: utf8Header } })
      assert.equal(okRes.status, 200, `带凭据经代理访问应为 200，实际 ${okRes.status}`)
      const body = await okRes.json()
      assert.equal(body.anonymous, false, '代理应把凭据透传给 TW')
    })
  }

  // ── 6. 日志不得泄漏明文口令 ──────────────────────────────────────────────
  await test('安全：WikiServer 日志不得出现明文口令', () => {
    const logs = server.status().logs.join('\n')
    assert.ok(!logs.includes(PASS), `WikiServer 日志泄漏了明文口令（当前实现会打印 spawn: … password=${PASS}）——口令不得进日志/错误上报`)
    assert.ok(!logs.includes(Buffer.from(`${USER}:${PASS}`, 'utf8').toString('base64')), '日志同样不得出现口令的 base64 编码')
    assert.ok(logs.includes('spawn'), '修复方式应是脱敏（如 password=***），而不是整行删掉 spawn 日志（否则排障信息丢失）')
  })
} catch (err) {
  failures++
  console.error('FAIL  auth 验收框架异常')
  console.error(err)
} finally {
  if (mini !== undefined) await new Promise((r) => mini.close(r)).catch(() => {})
  try { disposeRoutes?.() } catch { /* 已释放 */ }
  await server.stop().catch(() => {})
  await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(failures === 0 ? '\nAUTH CHECKS OK' : `\nAUTH CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

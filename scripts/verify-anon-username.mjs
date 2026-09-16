#!/usr/bin/env node
/**
 * `anon-username=GUEST` 的回归守门（v0.22.9）。
 *
 * 事故：DSH 启动 TW 子进程时（匿名 loopback 分支）没传 `anon-username`，于是
 * `get-status.js:21` 的回退值 `""` 被 TiddlyWeb adaptor 的
 * `isLoggedIn = json.username !== "GUEST"`（tiddlywebadaptor.js:93）判成
 * **已登录**，`syncer.js:281-283` 便在**每次页面加载**时往
 * `$:/status/UserName` 写空串 —— 用户填的「编辑者署名」静默消失；一旦
 * `$:/config/SyncFilter` 放行了 UserName（本仓库 wiki 的现状），这个空串还会
 * 落盘进 git，变成真实的、可追溯的数据丢失。
 *
 * 本守门断言的是**契约**（/status 必须回 GUEST 这个哨兵），而不是「某行代码
 * 长什么样」，所以改实现不会假红；但把 GUEST 换成任何人名都会红。
 *
 * 需要先 `npm run build`（import lib/index.js），会 spawn 真实 TW。
 *
 *   node scripts/verify-anon-username.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-anon-username
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ANON_USERNAME, TiddlyWebClient, WikiServer } from '../lib/index.js'

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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8')

const USER_NAME_TITLE = '$:/status/UserName'
const NAME = '\u674e\u56db'

// ---------------------------------------------------------------- 纯断言（无需 TW）
// TW 的哨兵值。任何人名都会让 isLoggedIn 仍为 true，从而继续覆盖署名。
assert.equal(ANON_USERNAME, 'GUEST', `ANON_USERNAME 必须字面量 GUEST，实际 ${JSON.stringify(ANON_USERNAME)}`)

await test('wiki.ts：匿名分支传 anon-username=GUEST，且误导性注释已清除', () => {
  const wiki = read('src/host/wiki.ts')
  assert.ok(/anon-username=\$\{ANON_USERNAME\}/.test(wiki), '匿名 spawn 分支必须 push anon-username')
  assert.ok(
    !/anon-username\/readers\/writers here was verified to 401 every request/.test(wiki),
    '那句把 anon-username 与 readers/writers 混为一谈的旧注释必须已删除（它正是本 bug 活到今天的原因）',
  )
  // 鉴权分支不得被顺手**传**上 anon-username（authenticatedUsername 已优先，加了是噪音）。
  // 只看实际的 push 语句：分支内的解释性注释会提到这个词，按子串判会假红。
  const authBranch = wiki.slice(wiki.indexOf('if (this.options.username)'), wiki.indexOf('} else {'))
  assert.ok(
    !/args\.push\([^)]*anon-username/.test(authBranch),
    'auth 模式分支不得实际传 anon-username（只允许在注释里说明为什么不传）',
  )
})

console.log('anon-username — 真实 TW 子进程')

const root = await mkdtemp(path.join(tmpdir(), 'dsh-tw-verify-anon-'))
const wikiDir = path.join(root, 'main')
console.log(`temp wiki root: ${root}`)

let server
let authed
try {
  // 匿名 loopback 模式（插件默认）：本 bug 的发生地。
  server = new WikiServer({ wikiRoot: root, wiki: 'main', port: 0 })
  const view = await server.start()
  const api = new TiddlyWebClient(view.url)

  await test('/status 必须回 username="GUEST"（否则 syncer 会清空署名）', async () => {
    const status = await api.status()
    assert.equal(
      status.username,
      'GUEST',
      `匿名模式的 /status.username 必须是 GUEST 哨兵（实际 ${JSON.stringify(status.username)}）；` +
        '空串会让 tiddlywebadaptor 的 `username !== "GUEST"` 判成已登录，从而覆盖 $:/status/UserName',
    )
    assert.equal(status.anonymous, true, '匿名模式 anonymous 应为 true')
    assert.equal(status.read_only, false, '匿名 loopback 必须可写（否则编辑功能被破坏）')
    // 与 TW 的判定逻辑同构：GUEST → 不写 UserName。这里把该逻辑显式钉住。
    assert.equal(status.username !== 'GUEST', false, 'isLoggedIn 必须等价于 false')
  })

  await test('落盘的署名不被哨兵覆盖，且匿名模式仍能正常写条目', async () => {
    await api.put({ title: USER_NAME_TITLE, text: NAME, type: 'text/vnd.tiddlywiki' })
    const wrote = await api.get('AnonWriteNote')
    assert.equal(wrote, undefined, '前置：目标条目尚不存在')

    await api.put({ title: 'AnonWriteNote', text: 'created anonymously', tags: ['anon-username'] })
    const note = await api.get('AnonWriteNote')
    assert.equal(note?.text, 'created anonymously', '匿名模式必须能正常新建条目（编辑功能不受影响）')

    // 重新读 status（等价于页面再次加载时 syncer.getStatus()），署名必须原样。
    const status = await api.status()
    assert.equal(status.username, 'GUEST', '重读 /status 仍是 GUEST')
    const name = await api.get(USER_NAME_TITLE)
    assert.equal(name?.text, NAME, `署名必须仍是 ${NAME}（未被空串覆盖）`)
  })

  // 鉴权模式：确认加 anon-username 不影响它（authenticatedUsername 优先）。
  authed = new WikiServer({ wikiRoot: root, wiki: 'main-auth', port: 0, username: 'u', password: 'p' })
  const authView = await authed.start()
  const authApi = new TiddlyWebClient(authView.url, { username: 'u', password: 'p' })

  await test('auth 模式（readers/writers）加不加 anon-username 都不受影响', async () => {
    const status = await authApi.status()
    assert.equal(status.username, 'u', `鉴权模式下 /status.username 应是被认证用户，实际 ${JSON.stringify(status.username)}`)
    await authApi.put({ title: 'AuthedNote', text: 'ok' })
    assert.equal((await authApi.get('AuthedNote'))?.text, 'ok', '鉴权模式仍可写')
  })

  await test('auth 模式对匿名请求仍是 401（没有被 anon-username 意外放开）', async () => {
    const anon = new TiddlyWebClient(authView.url)
    await assert.rejects(
      () => anon.status(),
      /401/,
      'auth 模式下匿名 /status 必须 401（readers/writers 仍然关闭匿名访问）',
    )
  })
} catch (err) {
  failures++
  console.error('FAIL  anon-username 验收框架异常')
  console.error(err)
} finally {
  await server?.stop().catch(() => {})
  await authed?.stop().catch(() => {})
  await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(failures === 0 ? '\nANON-USERNAME CHECKS OK' : `\nANON-USERNAME CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env node
/**
 * 崩溃自愈 + 并发写入的耐久性守门。
 *
 * 1. **SIGKILL 自愈**：真实 TW 子进程被 SIGKILL 后，WikiServer 必须自动重启
 *    （指数退避，1s 起）、**复用同一端口**（`url` 不变 → 已缓存的 TiddlyWebClient /
 *    iframe src 仍然有效），且 wiki 数据（已落盘文件）仍在。
 * 2. **并发 50 次 put + 立即 AutoCommitter.touch()**：零丢失（50 条全部可读回）、
 *    最终 `git status` 干净（防抖提交真的把并发写入全部吃下）。
 *
 * 需要先 `npm run build`（import lib/index.js），会 spawn 真实 TW。
 *
 *   node scripts/verify-resilience.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-resilience
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WikiServer, TiddlyWebClient, GitFace, AutoCommitter } from '../lib/index.js'

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

/** 轮询直到条件成立（有上限），避免用固定 sleep 赌时序。 */
async function waitFor(cond, timeoutMs = 15_000, stepMs = 150) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let hit = false
    try { hit = await cond() } catch { hit = false }
    if (hit) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

const root = await mkdtemp(join(tmpdir(), 'dsh-tw-verify-resilience-'))
const wikiDir = join(root, 'main')
const tiddlersDir = join(wikiDir, 'tiddlers')
console.log(`temp wiki root: ${root}`)

let server
let committer
try {
  server = new WikiServer({ wikiRoot: root, wiki: 'main', port: 0 })
  const view = await server.start()
  const api = new TiddlyWebClient(view.url)
  const git = new GitFace()
  await mkdir(tiddlersDir, { recursive: true })
  await git.init(wikiDir, 'main')
  await git.initialCommit(wikiDir)

  const urlBefore = server.url
  const pidBefore = server.status().pid
  assert.ok(typeof pidBefore === 'number' && pidBefore > 0, `应拿到 TW 子进程 pid，实际 ${pidBefore}`)

  await api.put({ title: 'ResilienceNote', text: 'survives SIGKILL', tags: ['resilience'] })
  const flushedBeforeKill = await waitFor(
    async () => (await readdir(tiddlersDir)).some((f) => f.includes('ResilienceNote')),
    15_000,
  )
  assert.ok(flushedBeforeKill, '测试前提：ResilienceNote 应已落盘（TW 异步 flush）')

  await test('SIGKILL 子进程 → 自动重启、端口复用（url 不变）、数据仍在', async () => {
    process.kill(pidBefore, 'SIGKILL')
    const restarted = await waitFor(() => {
      const s = server.status()
      return s.status === 'running' && typeof s.pid === 'number' && s.pid !== pidBefore
    }, 30_000, 200)
    const after = server.status()
    assert.ok(
      restarted,
      `SIGKILL 后应在退避窗口内自动重启并回到 running（status=${after.status} pid=${after.pid} 原 pid=${pidBefore}；日志尾部：${JSON.stringify(after.logs.slice(-4))}）`,
    )
    assert.equal(server.url, urlBefore, '重启必须复用同一端口（url 不变，客户端与 iframe src 不会失效）')
    assert.equal(api.baseUrl, urlBefore, '已缓存的 TiddlyWebClient 仍指向同一 baseUrl（端口复用）')
    const got = await api.get('ResilienceNote')
    assert.equal(got?.text, 'survives SIGKILL', 'SIGKILL 重启后数据必须仍在（文件系统持久化）')
    assert.ok((got?.tags ?? []).includes('resilience'), `标签也应保留：${JSON.stringify(got?.tags)}`)
  })

  await test('并发 50 次 put + 立即 touch()：零丢失且最终 git 干净', async () => {
    committer = new AutoCommitter({
      git,
      dir: wikiDir,
      enabled: true,
      debounceMs: 60_000,
      message: () => `resilience autocommit ${Date.now()}`,
      onError: (err) => console.error('      autocommit error:', err instanceof Error ? err.message : err),
    })
    const titles = Array.from({ length: 50 }, (_, i) => `Concurrent-${String(i).padStart(2, '0')}`)
    const written = await Promise.all(titles.map((title, i) => api.put({ title, text: `payload ${i}`, tags: ['concurrency'] })))
    assert.equal(written.length, 50, '50 次并发 put 应全部 resolve（没有请求失败）')
    committer.touch() // 立即触发防抖提交（debounce 很长，靠 flush 收口）

    const countProbes = async () => (await readdir(tiddlersDir)).filter((f) => f.startsWith('Concurrent-')).length
    const flushed = await waitFor(async () => (await countProbes()) === 50, 30_000, 200)
    assert.ok(flushed, `50 条并发写入应全部落盘，实际 ${await countProbes()} 条`)

    const missing = []
    for (const title of titles) {
      if ((await api.get(title)) === undefined) missing.push(title)
    }
    assert.deepEqual(missing, [], `并发写入不得丢失，缺少：${missing.join(', ')}`)

    // 自动提交是异步的：反复 flush + 观察 status，直到工作树干净（有上限）。
    let clean = false
    for (let i = 0; i < 20 && !clean; i++) {
      await committer.flush()
      clean = !(await git.status(wikiDir)).dirty
      if (!clean) await new Promise((r) => setTimeout(r, 500))
    }
    const st = await git.status(wikiDir)
    assert.ok(clean, `自动提交后工作树最终应干净，实际未提交：${JSON.stringify(st.dirtyFiles.slice(0, 10))}`)
    assert.ok(typeof st.lastCommit === 'string' && st.lastCommit.length > 0, '应存在最近的自动提交记录')
  })
} catch (err) {
  failures++
  console.error('FAIL  自愈/并发验收框架异常')
  console.error(err)
} finally {
  try { committer?.dispose() } catch { /* ignore */ }
  await server?.stop().catch(() => {})
  await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(failures === 0 ? '\nRESILIENCE CHECKS OK' : `\nRESILIENCE CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

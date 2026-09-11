#!/usr/bin/env node
/**
 * 大 wiki 守门（默认 3 分钟预算，超时即失败）。
 *
 * 场景：一次性写入 ~3000 条文本 tiddler + ~100 条 base64 二进制附件，然后验证
 * 大 wiki 上的关键不变量：
 *   1. `TEXT_LIST_FILTER` 字符串长度 ≤ 100 字符（Windows MAX_PATH 回归：外部 filter
 *      白名单 tiddler 的文件名 = 整个 filter 串，过长会让 `git add` 报
 *      "Filename too long"、自动 commit 静默失效）；
 *   2. `search` / `recent` 在阈值内返回（服务端只取文本 tiddler，不拉 base64 正文）；
 *   3. 二进制条目在 search / recent 里**零出现**（含标题命中）；
 *   4. 真跑一次 `git commit`，把全部文件吃下去（大 wiki 下 git 不炸、树干净）。
 *
 * 需要先 `npm run build`（import lib/index.js），会 spawn 真实 TW + 写 3000+ 文件。
 *
 *   node scripts/verify-large-wiki.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-large-wiki
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WikiServer, TiddlyWebClient, GitFace, TEXT_LIST_FILTER } from '../lib/index.js'

const BUDGET_MS = 180_000
const TEXT_COUNT = 3000
const BINARY_COUNT = 100
const WRITE_CONCURRENCY = 25
/** search/recent 单次调用的时间上限（大 wiki 上应远低于这个值）。 */
const QUERY_BUDGET_MS = 30_000
/** 落盘等待上限。 */
const FLUSH_BUDGET_MS = 90_000

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

async function waitFor(cond, timeoutMs, stepMs = 250) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let hit = false
    try { hit = await cond() } catch { hit = false }
    if (hit) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

/** 有限并发的 pool：任何单条失败都被收集，不中断其余写入。 */
async function runPool(items, limit, fn) {
  const queue = [...items]
  const errors = []
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift()
      if (item === undefined) return
      try { await fn(item) } catch (err) { errors.push(err) }
    }
  })
  await Promise.all(workers)
  return errors
}

const started = Date.now()
const root = await mkdtemp(join(tmpdir(), 'dsh-tw-verify-large-wiki-'))
const wikiDir = join(root, 'main')
const tiddlersDir = join(wikiDir, 'tiddlers')
console.log(`temp wiki root: ${root}`)

let server
// 硬预算：到点就失败退出（并尽力停掉 TW 子进程，别留孤儿）。
const budgetTimer = setTimeout(() => {
  console.error(`FAIL  超过 ${BUDGET_MS / 1000}s 预算，强制失败退出`)
  void Promise.resolve(server?.stop()).catch(() => {}).finally(() => process.exit(1))
}, BUDGET_MS)

try {
  server = new WikiServer({ wikiRoot: root, wiki: 'main', port: 0 })
  const view = await server.start()
  const api = new TiddlyWebClient(view.url)
  const git = new GitFace()
  await mkdir(tiddlersDir, { recursive: true })
  await git.init(wikiDir, 'main')
  await git.initialCommit(wikiDir)

  await test('TEXT_LIST_FILTER 长度 ≤ 100 字符（Windows MAX_PATH 回归守门）', () => {
    assert.ok(
      TEXT_LIST_FILTER.length <= 100,
      `TEXT_LIST_FILTER 长度 ${TEXT_LIST_FILTER.length} > 100：白名单 tiddler 文件名 = 整个 filter 串，在 Windows 上会撞 MAX_PATH 让 git add 失败`,
    )
  })

  // ── 写入 3000 条文本 tiddler ──────────────────────────────────────────────
  const textTitles = Array.from({ length: TEXT_COUNT }, (_, i) => `Large-${String(i + 1).padStart(4, '0')}`)
  console.log(`写入 ${TEXT_COUNT} 条文本 tiddler（并发 ${WRITE_CONCURRENCY}）…`)
  const textErrors = await runPool(textTitles, WRITE_CONCURRENCY, (title) =>
    api.put({ title, text: `大规模探针第 ${title} 条 large-wiki-payload`, tags: ['large-wiki'] }))
  await test(`批量写入 ${TEXT_COUNT} 条文本 tiddler 全部成功`, () => {
    assert.equal(textErrors.length, 0, `失败 ${textErrors.length} 条，首条：${textErrors[0] && textErrors[0].message}`)
  })

  // ── 写入 100 条 base64 二进制附件 ─────────────────────────────────────────
  const binaryTitles = Array.from({ length: BINARY_COUNT }, (_, i) => `LargeBinary-${String(i + 1).padStart(3, '0')}.png`)
  const binaryB64 = Buffer.from('iVBORw0KGgoAAAANSUhEUg' + 'A'.repeat(2048)).toString('base64')
  console.log(`写入 ${BINARY_COUNT} 条 base64 二进制附件…`)
  const binaryErrors = await runPool(binaryTitles, WRITE_CONCURRENCY, (title) =>
    api.put({ title, text: binaryB64, type: 'image/png', tags: ['large-binary'] }))
  await test(`批量写入 ${BINARY_COUNT} 条二进制附件全部成功`, () => {
    assert.equal(binaryErrors.length, 0, `失败 ${binaryErrors.length} 条，首条：${binaryErrors[0] && binaryErrors[0].message}`)
  })

  // ── 等落盘 ────────────────────────────────────────────────────────────────
  const expectedFiles = TEXT_COUNT + BINARY_COUNT
  const countTiddlerFiles = async () =>
    (await readdir(tiddlersDir, { withFileTypes: true })).filter((e) => e.isFile()).length
  console.log(`等待 TW 异步落盘（目标 ≥ ${expectedFiles} 个文件）…`)
  const flushed = await waitFor(async () => (await countTiddlerFiles()) >= expectedFiles, FLUSH_BUDGET_MS)
  await test('全部 tiddler 落盘（TW 同步队列吃下 3100 条）', async () => {
    const n = await countTiddlerFiles()
    assert.ok(flushed, `落盘超时：期望 ≥ ${expectedFiles}，实际 ${n}`)
  })

  // ── search / recent 阈值 + 二进制零出现 ───────────────────────────────────
  await test(`search 在 ${QUERY_BUDGET_MS / 1000}s 内返回，且二进制零出现`, async () => {
    const t0 = Date.now()
    const r = await api.search('large-wiki-payload', { limit: 200 })
    const ms = Date.now() - t0
    assert.ok(ms < QUERY_BUDGET_MS, `search 耗时 ${ms}ms，超过阈值 ${QUERY_BUDGET_MS}ms`)
    assert.ok(r.total >= TEXT_COUNT, `应命中全部文本探针，实际 total=${r.total}`)
    assert.equal(r.items.length, 200, `limit=200 应返回 200 条，实际 ${r.items.length}`)
    assert.ok(!r.items.some((t) => t.title.startsWith('LargeBinary-')), '二进制附件不得出现在 search 结果里')
    const byTitle = await api.search('LargeBinary', { limit: 10 })
    assert.equal(byTitle.total, 0, `二进制标题命中也必须为 0，实际 ${byTitle.total}`)
    console.log(`        search(3000+100 条) 命中 ${r.total} 条，耗时 ${ms}ms`)
  })

  await test(`recent 在 ${QUERY_BUDGET_MS / 1000}s 内返回，且二进制零出现`, async () => {
    const t0 = Date.now()
    const items = await api.recent(200)
    const ms = Date.now() - t0
    assert.ok(ms < QUERY_BUDGET_MS, `recent 耗时 ${ms}ms，超过阈值 ${QUERY_BUDGET_MS}ms`)
    assert.equal(items.length, 200, `limit=200 应返回 200 条，实际 ${items.length}`)
    assert.ok(!items.some((t) => t.title.startsWith('LargeBinary-')), '二进制附件不得出现在 recent 列表里')
    console.log(`        recent 返回 ${items.length} 条，耗时 ${ms}ms`)
  })

  // ── 真跑一次 git commit ──────────────────────────────────────────────────
  await test(`git commit 能吃下全部 ${expectedFiles}+ 个文件，且工作树干净`, async () => {
    // TW 的 filesystem adaptor 对二进制 tiddler 会写 `<title>.png` + `<title>.png.meta`
    // 两个文件，且异步 flush 可能持续数秒 —— 提交前必须等文件数**静止**，否则 git
    // 会在 flush 中途打快照，提交后还剩一堆未跟踪文件。
    const settle = async () => {
      let last = -1
      let stable = 0
      for (let i = 0; i < 160; i++) {
        const n = await countTiddlerFiles()
        if (n === last) {
          stable++
          if (stable >= 3) return n
        } else {
          stable = 0
          last = n
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      return last
    }
    const totalFiles = await settle()
    console.log(`        落盘静止：${totalFiles} 个文件`)

    const t0 = Date.now()
    const committed = await git.commit(wikiDir, 'large wiki baseline')
    assert.equal(committed.committed, true, `git commit 必须成功，实际：${committed.message}`)
    let st = await git.status(wikiDir)
    let rounds = 1
    // 有界兜底：万一 flush 又追了一个文件进来，再等静止 + 补一次提交。
    while (st.dirty && rounds < 4) {
      await settle()
      await git.commit(wikiDir, `large wiki baseline (drain ${rounds})`)
      st = await git.status(wikiDir)
      rounds++
    }
    assert.equal(st.dirty, false, `提交后工作树应干净，实际未提交 ${st.dirtyFiles.length} 个：${JSON.stringify(st.dirtyFiles.slice(0, 10))}`)
    console.log(`        git commit ${expectedFiles}+ 个文件耗时 ${Date.now() - t0}ms（提交轮次 ${rounds}）`)
  })

  await test(`总耗时在 ${BUDGET_MS / 1000}s 预算内`, () => {
    const elapsed = Date.now() - started
    assert.ok(elapsed < BUDGET_MS, `总耗时 ${elapsed}ms 超过预算 ${BUDGET_MS}ms`)
    console.log(`        总耗时 ${elapsed}ms`)
  })
} catch (err) {
  failures++
  console.error('FAIL  大 wiki 验收框架异常')
  console.error(err)
} finally {
  clearTimeout(budgetTimer)
  await server?.stop().catch(() => {})
  await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(failures === 0 ? '\nLARGE WIKI CHECKS OK' : `\nLARGE WIKI CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env node
/**
 * `tiddlywiki_git_sync` 的多仓库行为守门（v0.30.5，作者 2026-09-29 裁定）。
 *
 * 规则（每一条都对应一个真实失败形态）：
 *   1. 同步**所有**配了 `git.remote` 的库 —— 不再只动会话作用域那一个；
 *   2. **一个仓库只同步一次**：多库共用一个工作树时，pull/commit/push 都只跑一遍
 *      （跑 N 遍会互踩同一个 index）；
 *   3. **逐仓库独立成败**：一个仓库冲突/失败，不许吞掉其余仓库的结果；
 *   4. 没配 `git.remote` 的库要被**列出来**（"同步完成"不能读成"全都同步了"）；
 *   5. 一个可同步的库都没有时 `ok:false`（README 与 verify-tools 都承诺
 *      "push 没有 remote = 失败"）；
 *   6. 排干失败、以及每个仓库的冲突文件，都要出现在回执里（模型据此决定下一步）。
 *
 * 不 spawn TW、不碰真 git：用假 deps 直接驱动 `registerTiddlywikiTools()` 注册出来的
 * 那个工具（顺便证明注册路径本身能被这样驱动）。
 *
 *   node scripts/verify-git-multi-sync.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-git-multi-sync
 */
import assert from 'node:assert/strict'
import { GitConflictStateError, registerTiddlywikiTools } from '../lib/index.js'

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

/** Capture the tools one registration pass produced. */
function toolsFrom(deps) {
  const registered = []
  registerTiddlywikiTools({ tools: { register: (tool) => { registered.push(tool); return () => {} } } }, deps)
  const byName = (name) => {
    const tool = registered.find((t) => t.name === name)
    assert.ok(tool !== undefined, `工具 ${name} 没有被注册`)
    return tool
  }
  return { sync: byName('tiddlywiki_git_sync'), resolve: byName('tiddlywiki_git_resolve'), count: registered.length }
}

/**
 * A fake host: spies on every git call, plus a target list.
 * `requireWiki` THROWS by default → the tool's pre-restart drain fails → the
 * receipt must say so (and the test stays fast: no 12s flush timeout).
 */
function makeDeps({ targets, pullResult = () => ({ ok: true, message: 'up to date' }), commitThrows = false, drainOk = false }) {
  const calls = { pull: [], push: [], commit: [], status: [] }
  const deps = {
    scope: () => ({ ambiguous: false }),
    git: {
      pull: async (dir) => { calls.pull.push(dir); return pullResult(dir) },
      push: async (dir) => { calls.push.push(dir); return { ok: true, message: 'pushed' } },
      commit: async (dir, message) => {
        calls.commit.push(dir)
        if (commitThrows) throw new GitConflictStateError('rebase 冲突未解决', 'rebase', ['tiddlers/x.tid'])
        return { committed: true, message: message ?? 'ok' }
      },
      status: async (dir) => { calls.status.push(dir); return { branch: 'main', dirty: false, dirtyFiles: [], ahead: 0, behind: 0 } },
    },
    gitTargets: async () => targets,
    wikiPath: () => '/fake/default',
    autoCommit: () => {},
    restartAffected: async () => ({ restarted: [], failed: [] }),
  }
  const env = {
    register: () => {},
    deps,
    requireWiki: () => {
      if (drainOk) return { put: async () => undefined, get: async () => undefined }
      throw new Error('知识库服务未运行')
    },
  }
  return { env, deps, calls }
}

const T = (id, label, dir, repoRoot, remote) => ({ id, label, dir, repoRoot, remote, branch: 'main', running: true })

await test('一个仓库只同步一次；多库共用仓库时逐库标注；没配 remote 的库被列出来', async () => {
  const { env, calls } = makeDeps({
    targets: [
      T('work', '工作', '/w/work', '/repo/shared', 'https://example.invalid/shared.git'),
      T('personal', '个人', '/w/personal', '/repo/shared', 'https://example.invalid/shared.git'),
      T('books', '书籍', '/w/books', '/repo/books', 'https://example.invalid/books.git'),
      T('scratch', '草稿', '/w/scratch', '/repo/scratch', ''),
    ],
  })
  const { sync } = toolsFrom(env.deps)
  const result = await sync.execute({ action: 'sync' }, {})

  assert.equal(calls.pull.length, 2, `pull 必须按仓库去重（实际 ${calls.pull.length} 次：${calls.pull.join(', ')}）`)
  assert.equal(calls.commit.length, 2, 'commit 必须按仓库去重')
  assert.equal(calls.push.length, 2, 'push 必须按仓库去重')
  assert.deepEqual(calls.pull.slice().sort(), ['/w/books', '/w/work'].sort(), '两个仓库各 pull 一次（参数是各仓库里第一个库的目录：GitFace 自己解析仓库根）')
  assert.equal(result.ok, true, `全部成功时 ok 应为 true：${result.message}`)
  assert.equal(result.repos?.length, 2)
  const shared = result.repos.find((r) => r.root === '/repo/shared')
  assert.deepEqual(shared.wikis, ['工作', '个人'], '共用一个仓库的两个库都要出现在该仓库名下')
  assert.deepEqual(shared.wikiIds, ['work', 'personal'], '回执要给出库 id（git_resolve 的 wiki 参数要用）')
  assert.equal(result.skipped?.length, 1, '没配 git.remote 的库必须被列出，而不是静默略过')
  assert.match(result.skipped[0], /草稿.*git\.remote/)
  const text = sync.output.render({ action: 'sync' }, result)[0].text
  assert.match(text, /库 工作、个人 @ \/repo\/shared/, `回执要逐仓库标注库名与仓库：\n${text}`)
})

await test('一个仓库失败不影响其余仓库（且总 ok=false、点名是哪个仓库）', async () => {
  const { env, calls } = makeDeps({
    targets: [
      T('work', '工作', '/w/work', '/repo/shared', 'https://example.invalid/shared.git'),
      T('books', '书籍', '/w/books', '/repo/books', 'https://example.invalid/books.git'),
    ],
    pullResult: (dir) => (dir === '/w/books'
      ? { ok: false, message: 'fatal: could not read from remote' }
      : { ok: true, message: 'ok' }),
  })
  const { sync } = toolsFrom(env.deps)
  const result = await sync.execute({ action: 'sync' }, {})

  assert.equal(result.ok, false, '有仓库失败时总 ok 必须是 false')
  assert.equal(calls.commit.length, 1, '失败的那个仓库不提交，另一个照常提交')
  assert.equal(calls.commit[0], '/w/work', '失败仓库不提交，另一个照常提交（参数是库目录）')
  assert.match(result.message, /1\/2/, `总回执要写清失败比例：${result.message}`)
  assert.match(result.message, /书籍/, '总回执要点名失败的是哪个库')
  const books = result.repos.find((r) => r.root === '/repo/books')
  assert.equal(books.ok, false)
  assert.match(books.message, /could not read from remote/, '失败原因要原样带出来')
})

await test('冲突：该仓库 ok=false 且带 conflictFiles，回执给出带 wiki= 的解决指引', async () => {
  const { env } = makeDeps({
    targets: [T('books', '书籍', '/w/books', '/repo/books', 'https://example.invalid/books.git')],
    commitThrows: true,
  })
  const { sync } = toolsFrom(env.deps)
  const result = await sync.execute({ action: 'sync' }, {})
  assert.equal(result.ok, false)
  assert.deepEqual(result.repos[0].conflictFiles, ['tiddlers/x.tid'])
  // 单仓库时保留扁平别名（pre-v0.30.5 的形状），老调用方不受影响
  assert.deepEqual(result.conflictFiles, ['tiddlers/x.tid'], '单仓库时扁平别名也要填')
  const text = sync.output.render({ action: 'sync' }, result)[0].text
  assert.match(text, /tiddlywiki_git_resolve/, '回执要告诉模型用哪个工具解决')
  assert.match(text, /wiki=/, `解决指引必须带 wiki=<库 id>（否则多库下会改错仓库）：\n${text}`)
})

await test('排干失败必须显形（drainFailed + 回执警告），而不是静默重启', async () => {
  const { env } = makeDeps({
    targets: [T('work', '工作', '/w/work', '/repo/shared', 'https://example.invalid/shared.git')],
  })
  const { sync } = toolsFrom(env.deps)
  const result = await sync.execute({ action: 'sync' }, {})
  assert.equal(result.repos[0].drainFailed, true, 'requireWiki 抛错 ⇒ 排干未确认，必须记下来')
  const text = sync.output.render({ action: 'sync' }, result)[0].text
  assert.match(text, /syncer 队列/, `回执必须警告排干未确认：\n${text}`)
})

await test('没有任何可同步的库 → ok:false 并说明原因（不假装成功）', async () => {
  const { env } = makeDeps({ targets: [T('scratch', '草稿', '/w/scratch', '/repo/scratch', '')] })
  const { sync } = toolsFrom(env.deps)
  const result = await sync.execute({ action: 'push' }, {})
  assert.equal(result.ok, false, 'unconfigured remote 必须失败（verify-tools 的 e2e 也这样要求）')
  assert.match(result.message, /git\.remote/)
  assert.equal(result.repos.length, 0)

  const empty = makeDeps({ targets: [] })
  const second = toolsFrom(empty.env.deps)
  const none = await second.sync.execute({ action: 'push' }, {})
  assert.equal(none.ok, false)
  assert.match(none.message, /没有已登记的知识库/)
})

await test('git_resolve：多库各有仓库时必须能按 wiki id 指定（并拒绝未知 id）', async () => {
  const { env, calls } = makeDeps({
    targets: [
      T('work', '工作', '/w/work', '/repo/shared', 'https://example.invalid/shared.git'),
      T('books', '书籍', '/w/books', '/repo/books', 'https://example.invalid/books.git'),
    ],
  })
  const { resolve } = toolsFrom(env.deps)
  const listed = await resolve.execute({ strategy: 'list', wiki: 'books' }, {})
  assert.equal(listed.ok, true)
  assert.deepEqual(calls.status, ['/w/books'], '必须落在 books 那个仓库，而不是会话作用域的库')
  assert.equal(listed.repo, '/repo/books')
  await assert.rejects(() => resolve.execute({ strategy: 'list', wiki: 'nope' }, {}), /未知的知识库/)
})

console.log(failures === 0 ? '\nGIT MULTI-SYNC CHECKS OK' : `\nGIT MULTI-SYNC CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

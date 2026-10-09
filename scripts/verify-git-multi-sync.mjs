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
 *   6. 排干失败、以及每个仓库的冲突文件，都要出现在回执里（模型据此决定下一步）；
 *   7. 「有 remote」= **`git.remote` 或该库所在仓库自己的 `origin`**（v0.30.58，
 *      作者 2026-10-09 裁定）：设置页「同步」按钮一直按仓库 origin 走，工具却要求显式配置
 *      —— 同一个问题两个答案，用户看到的却是「没有任何知识库配置了 git.remote」。回落只在
 *      「没配 **且** 真的在 git 仓库里」时发生（不在仓库里就不该白跑一次 `git`）；
 *   8. 回执要写出**用的是哪个远端、以及它从哪来**（config / origin），且 URL 里的凭据
 *      必须先剥掉 —— `git.remote` 可能带 PAT，`/admin/state` 对同一个值打码。
 *
 * 不 spawn TW、不碰真 git：① 用假 deps 驱动 `registerTiddlywikiTools()` 注册出来的那个工具
 * （顺便证明注册路径本身能被这样驱动）；② 用假 farm + 假 GitFace 驱动 `createGitLayer()`
 * 的 `gitTargets()` —— 第 7 条只活在那里，工具层的假 targets 绕不过它。
 *
 *   node scripts/verify-git-multi-sync.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-git-multi-sync
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path, { resolve } from 'node:path'
import { GitConflictStateError, createGitLayer, registerTiddlywikiTools } from '../lib/index.js'
import { FLUSH_PROBE_FILE_HINT } from '../src/host/seeds-flush.ts'

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
 *
 * `sessionScope` is exactly what the tools see for THIS session (v0.30.62): the
 * git tools take BOTH the drain folder and the default `git_resolve` target from
 * it. Left unset = no client and no folder, so the pre-restart drain cannot be
 * proven and the receipt must say so (the test stays fast: no 12s timeout).
 */
function makeDeps({ targets, sessionScope, pullResult = () => ({ ok: true, message: 'up to date' }), commitThrows = false }) {
  const calls = { pull: [], push: [], commit: [], status: [] }
  const deps = {
    scope: () => sessionScope ?? { ambiguous: false },
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
    autoCommit: () => {},
    restartAffected: async () => ({ restarted: [], failed: [] }),
  }
  const env = {
    register: () => {},
    deps,
    // The git tools no longer call this (they read `scope` instead); kept because
    // ToolEnv requires it and a future tool may.
    requireWiki: () => { throw new Error('知识库服务未运行') },
  }
  return { env, deps, calls }
}

const T = (id, label, dir, repoRoot, remote, remoteSource = remote.length > 0 ? 'config' : 'none') =>
  ({ id, label, dir, repoRoot, remote, remoteSource, branch: 'main', running: true })

await test('一个仓库只同步一次；多库共用仓库时逐库标注；没配 remote 的库被列出来', async () => {
  const { env, calls } = makeDeps({
    targets: [
      T('work', '工作', '/w/work', '/repo/shared', 'https://example.invalid/shared.git'),
      T('personal', '个人', '/w/personal', '/repo/shared', 'https://example.invalid/shared.git'),
      // v0.30.58：这个库没配 git.remote，remote 来自仓库自己的 origin
      T('books', '书籍', '/w/books', '/repo/books', 'https://example.invalid/books.git', 'origin'),
      T('scratch', '草稿', '/w/scratch', '/repo/scratch', ''),
      T('loose', '裸目录', '/w/loose', undefined, ''),
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
  assert.equal(result.skipped?.length, 2, '同步不了的库必须被列出，而不是静默略过')
  assert.match(result.skipped[0], /草稿.*git\.remote/)
  assert.match(result.skipped[1], /裸目录.*不在 git 仓库里/, '两种跳过原因要分得清：有仓库但没远端 ≠ 根本不在仓库里')
  const text = sync.output.render({ action: 'sync' }, result)[0].text
  assert.match(text, /库 工作、个人 @ \/repo\/shared/, `回执要逐仓库标注库名与仓库：\n${text}`)
  assert.match(text, /远端 https:\/\/example\.invalid\/shared\.git，来自 git\.remote 配置/, `配了 remote 要说清来源：\n${text}`)
  assert.match(text, /远端 https:\/\/example\.invalid\/books\.git，自动识别自仓库 origin/, `自动识别的 remote 必须显形（否则"推到了我没填过的远端"是静默的）：\n${text}`)
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
  assert.equal(result.repos[0].drainFailed, true, '会话作用域没有可用的 client/目录 ⇒ 排干未确认，必须记下来')
  const text = sync.output.render({ action: 'sync' }, result)[0].text
  assert.match(text, /syncer 队列/, `回执必须警告排干未确认：\n${text}`)
})

await test('git_sync：排干哨兵写进**会话作用域那个库**的 tiddlers/（旧代码看的是默认库目录 ⇒ 必然超时）', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-tw-drain-'))
  mkdirSync(path.join(dir, 'tiddlers'), { recursive: true })
  try {
    const client = {
      // 哨兵的真实行为：PUT 一段唯一文本，随后由 syncer 落盘到 <dir>/tiddlers/。
      put: async (t) => { writeFileSync(path.join(dir, 'tiddlers', `x-${FLUSH_PROBE_FILE_HINT}.tid`), t.text ?? '') },
      get: async () => undefined,
    }
    const { env } = makeDeps({
      targets: [T('books', '书籍', '/w/books', '/repo/books', 'https://example.invalid/books.git')],
      sessionScope: { ambiguous: true, id: 'books', label: '书籍', dir, client },
    })
    const { sync } = toolsFrom(env.deps)
    const result = await sync.execute({ action: 'sync' }, {})
    assert.notEqual(result.repos[0].drainFailed, true, '探针落在会话作用域那个库里 ⇒ 必须判定排干成功')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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

await test('git_resolve：不传 wiki ⇒ 落在**本会话作用域**那个库，而不是插件默认库（v0.30.62）', async () => {
  const { env, calls } = makeDeps({
    targets: [
      T('work', '工作', '/w/work', '/repo/shared', 'https://example.invalid/shared.git'),
      T('books', '书籍', '/w/books', '/repo/books', 'https://example.invalid/books.git'),
    ],
    sessionScope: { ambiguous: true, id: 'books', label: '书籍', dir: '/w/books' },
  })
  const { resolve } = toolsFrom(env.deps)
  const listed = await resolve.execute({ strategy: 'list' }, {})
  assert.equal(listed.ok, true)
  assert.deepEqual(calls.status, ['/w/books'], '缺省目标必须是会话作用域那个库（旧代码会落到 deps.wikiPath() = 默认库）')
})

await test('git_resolve：会话作用域无从得知时明确报错（绝不改去动别的仓库）', async () => {
  const { env, calls } = makeDeps({
    targets: [T('work', '工作', '/w/work', '/repo/shared', 'https://example.invalid/shared.git')],
  })
  const { resolve } = toolsFrom(env.deps)
  await assert.rejects(() => resolve.execute({ strategy: 'list' }, {}), /无法确定本会话的知识库目录/)
  assert.deepEqual(calls.status, [], '报错前不得触碰任何仓库')
})

await test('跳过原因分得清：有仓库但没远端 ≠ 根本不在 git 仓库里', async () => {
  const { env } = makeDeps({
    targets: [
      T('scratch', '草稿', '/w/scratch', '/repo/scratch', ''),
      T('loose', '裸目录', '/w/loose', undefined, ''),
    ],
  })
  const { sync } = toolsFrom(env.deps)
  const result = await sync.execute({ action: 'push' }, {})
  assert.equal(result.ok, false)
  assert.match(result.skipped[0], /草稿（未配 git\.remote，仓库也没有 origin）/)
  assert.match(result.skipped[1], /裸目录（不在 git 仓库里）/)
  assert.match(result.message, /git\.remote/, `空目标时要告诉用户两条出路（填 remote / 给仓库加 origin）：${result.message}`)
})

await test('回执里的远端必须剥掉凭据（git.remote 可能带 PAT，/admin/state 对同一个值打码）', async () => {
  const { env } = makeDeps({
    targets: [T('work', '工作', '/w/work', '/repo/shared', 'https://user:tok3n@example.invalid/shared.git')],
  })
  const { sync } = toolsFrom(env.deps)
  const result = await sync.execute({ action: 'sync' }, {})
  const text = sync.output.render({ action: 'sync' }, result)[0].text
  assert.doesNotMatch(text, /tok3n/, `回执不许把远端里的凭据带进模型上下文：\n${text}`)
  assert.match(text, /https:\/\/example\.invalid\/shared\.git/)
})

// ── gitTargets()：v0.30.58 的回落规则（假 farm + 假 GitFace，不 spawn 任何东西）──
/**
 * `gitTargets()` 只活在 `createGitLayer()` 里，工具层的假 targets 绕不过它，
 * 所以这里直接驱动工厂：`roots[dir]` 决定该文件夹在不在仓库里，`origins[dir]`
 * 是 `git remote get-url origin` 会答的东西。
 */
function gitLayer({ wikis, configFor = () => ({}), roots = {}, origins = {}, baseRemote = '' }) {
  const calls = { originOf: [] }
  /**
   * `entryPath()` resolves through `node:path`, so the folders it hands out are
   * PLATFORM-native (`C:\w\work` on Windows, `/w/work` on Linux) — key the fake
   * maps the same way instead of assuming forward slashes. Otherwise this gate
   * passes on Linux and fails on Windows for a reason unrelated to the rule.
   */
  const rmap = new Map(Object.entries(roots).map(([k, v]) => [resolve(k), v]))
  const omap = new Map(Object.entries(origins).map(([k, v]) => [resolve(k), v]))
  const base = { note: { tag: 'note', workspaceMark: true }, git: { autoCommit: true, debounceMs: 60000, remote: baseRemote, branch: 'main' } }
  const git = {
    repoRoot: async (dir) => rmap.get(dir),
    originOf: async (dir) => { calls.originOf.push(dir); return omap.get(dir) ?? '' },
  }
  const farm = {
    registry: { wikis: wikis.map((w) => ({ id: w.id, label: w.label, root: w.dir, name: '.', agentVisible: true, autostart: false })) },
    runtime: (id) => {
      const cfg = configFor(id)
      return cfg === undefined ? undefined : { eff: () => cfg }
    },
  }
  const layer = createGitLayer({
    git,
    farm: () => farm,
    defaultInstance: () => undefined,
    baseShape: () => base,
    gitConfig: () => base.git,
    noteConfig: () => base.note,
    defaultPath: () => '/w/work',
    registryFile: () => '/w/wikis.json',
  })
  return { layer, calls }
}

await test('gitTargets：没配 git.remote 就回落到仓库自己的 origin（且只在"真在仓库里"时才去问）', async () => {
  const { layer, calls } = gitLayer({
    wikis: [
      { id: 'work', label: '工作', dir: '/w/work' },
      { id: 'personal', label: '个人', dir: '/w/personal' },
      { id: 'books', label: '书籍', dir: '/w/books' },
      { id: 'loose', label: '裸目录', dir: '/w/loose' },
    ],
    configFor: (id) => (id === 'work' ? { git: { remote: 'https://example.invalid/typed.git' } } : {}),
    roots: { '/w/work': '/repo/shared', '/w/personal': '/repo/shared', '/w/books': '/repo/books' },
    origins: {
      '/w/work': 'https://example.invalid/repo-origin.git',
      '/w/personal': 'https://example.invalid/repo-origin.git',
      '/w/books': 'https://example.invalid/books.git',
    },
  })
  const targets = await layer.gitTargets()
  const by = (id) => {
    const hit = targets.find((t) => t.id === id)
    assert.ok(hit !== undefined, `gitTargets 少了 ${id}`)
    return hit
  }
  assert.equal(by('work').remote, 'https://example.invalid/typed.git', '配了 git.remote 就以它为准（覆盖）')
  assert.equal(by('work').remoteSource, 'config')
  assert.equal(by('personal').remote, 'https://example.invalid/repo-origin.git', '没配就回落到仓库 origin —— 这正是"界面能同步、Agent 说没远端"的那一半')
  assert.equal(by('personal').remoteSource, 'origin')
  assert.equal(by('books').remoteSource, 'origin')
  assert.equal(by('loose').remote, '', '不在 git 仓库里 ⇒ 没有可回落的东西')
  assert.equal(by('loose').remoteSource, 'none')
  assert.deepEqual(calls.originOf, [resolve('/w/personal'), resolve('/w/books')], '只在「没配 **且** 在仓库里」时才探 origin：work 有配置、loose 不在仓库')
})

await test('gitTargets：cordis base 的 git.remote 仍对所有库生效（来源算 config）', async () => {
  const { layer, calls } = gitLayer({
    wikis: [{ id: 'work', label: '工作', dir: '/w/work' }],
    roots: { '/w/work': '/repo/shared' },
    origins: { '/w/work': 'https://example.invalid/repo-origin.git' },
    baseRemote: 'https://example.invalid/base.git',
  })
  const [target] = await layer.gitTargets()
  assert.equal(target.remote, 'https://example.invalid/base.git', 'base 的非空 remote 仍然优先于仓库 origin')
  assert.equal(target.remoteSource, 'config')
  assert.deepEqual(calls.originOf, [], 'base 已经给了 remote ⇒ 不必再探仓库（零额外 git 调用）')
})

console.log(failures === 0 ? '\nGIT MULTI-SYNC CHECKS OK' : `\nGIT MULTI-SYNC CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

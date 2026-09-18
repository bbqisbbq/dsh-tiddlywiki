#!/usr/bin/env node
/**
 * 冲突/配置守卫守门（v0.23.4）。
 *
 * 2026-09-17 的真实事故催生了这组守卫：`git pull --rebase --autostash` 的
 * **autostash 重新应用**冲突后，`rebase --abort` 已经无事可 abort，冲突标记留在
 * 工作树里；随后 60s 的 AutoCommitter 照常 `git add -A && commit`，把
 * `<<<<<<< Updated upstream` **永久提交**进了 wiki 的配置 tiddler。后果：
 * ConfigStore 解析不了自己的配置（wechat 一直是关的、prompt.extra 静默失效），
 * 而一次设置页保存又把整份配置写成了"残版"（只剩表单里那几个字段）。
 *
 * 因此本脚本分三段钉死：
 *   A. `GitFace.commit()` 遇到冲突态必须**拒绝**（未完成 merge/rebase、未合并
 *      路径、或工作树里残留冲突块），并带出文件名；
 *   B. `ConfigStore` 在存量配置 tiddler 解析失败时必须**拒绝写入**（而不是拿空
 *      缓存合并、把用户其它设置抹掉），且把原因暴露出来；
 *   C. 接线断言：/sync 409、/admin/config 409、/admin/state 的 configError、
 *      自动提交的去重上报、agent 工具的结构化失败。
 *
 * A 部分既有注入伪 exec 的纯逻辑用例，也有**真起一个临时 git 仓库**的 E2E
 * （真 merge 冲突 + 真残留标记），所以不需要网络、不碰线上 wiki。
 *
 *   node scripts/verify-conflict-config-guards.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-conflict-config-guards
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  AutoCommitter,
  ConfigStore,
  ConfigUnreadableError,
  GitFace,
  GitConflictStateError,
  describeConflict,
  describeUnreadableConfig,
} from '../lib/index.js'

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

// ── A. 注入式伪 exec：三条冲突来源都必须拦下 ────────────────────────────────
/** 造一个按命令行答复的伪 exec；未列出的命令返回「成功但无输出」。 */
function fakeExec(table) {
  return async (args) => {
    const key = args.join(' ')
    for (const [pattern, result] of table) {
      if (key === pattern || key.startsWith(pattern)) {
        return typeof result === 'function' ? result(args) : result
      }
    }
    return { ok: true, stdout: '', stderr: '' }
  }
}

await test('describeConflict：措辞点名文件与原因，并给出下一步', () => {
  const text = describeConflict({ conflicted: true, reason: 'unmerged paths', files: ['a.tid', 'b.tid'] })
  assert.ok(text.includes('拒绝提交'), text)
  assert.ok(text.includes('a.tid') && text.includes('b.tid'), '必须点名文件')
  assert.ok(text.includes('tiddlywiki_git_resolve'), '必须给出可执行的下一步')
  const many = describeConflict({ conflicted: true, reason: 'x', files: ['1', '2', '3', '4', '5', '6'] })
  assert.ok(many.includes('等 6 个文件'), `文件多时应折叠，实际 ${many}`)
})

await test('commit 拒绝：未解决的 merge（MERGE_HEAD 在 + 未合并路径）', async () => {
  const git = new GitFace(fakeExec([
    ['rev-parse -q --verify MERGE_HEAD', { ok: true, stdout: 'abc123\n', stderr: '' }],
    ['diff --name-only --diff-filter=U', { ok: true, stdout: 'tiddlers/a.tid\n', stderr: '' }],
  ]), () => '')
  await assert.rejects(
    () => git.commit('/tmp/x', 'msg'),
    (err) => err instanceof GitConflictStateError && err.files.includes('tiddlers/a.tid') && err.reason === 'unmerged paths',
  )
})

await test('commit 放行：merge 已解决（MERGE_HEAD 仍在，但没有未合并路径/冲突块）', async () => {
  // `git commit` IS the way to conclude a merge: the guard must not make a
  // resolved merge permanently uncommittable (v0.23.4 real-git E2E caught this).
  const git = new GitFace(fakeExec([
    ['rev-parse -q --verify MERGE_HEAD', { ok: true, stdout: 'abc123\n', stderr: '' }],
    ['diff --cached --quiet', { ok: true, stdout: '', stderr: '' }],
  ]), () => 'resolved content, no markers\n')
  const result = await git.commit('/tmp/x', 'msg')
  assert.equal(result.committed, false)
  assert.equal(result.message, 'nothing to commit', '不该抛 GitConflictStateError')
})

await test('commit 拒绝：rebase 进行中（rebase 期间禁止普通 commit）', async () => {
  const git = new GitFace(fakeExec([
    ['rev-parse -q --verify REBASE_HEAD', { ok: true, stdout: 'abc123\n', stderr: '' }],
    ['diff --name-only --diff-filter=U', { ok: true, stdout: 'tiddlers/c.tid\n', stderr: '' }],
  ]), () => '')
  await assert.rejects(
    () => git.commit('/tmp/x', 'msg'),
    (err) => err instanceof GitConflictStateError && /rebase in progress/.test(err.message),
  )
})

await test('commit 拒绝：未合并路径（diff --diff-filter=U 非空）', async () => {
  const git = new GitFace(fakeExec([
    ['diff --name-only --diff-filter=U', { ok: true, stdout: 'tiddlers/b.tid\n', stderr: '' }],
  ]), () => '')
  await assert.rejects(() => git.commit('/tmp/x', 'msg'), (err) => err instanceof GitConflictStateError && err.reason === 'unmerged paths')
})

await test('commit 拒绝：工作树里残留冲突块（事故形态，git 已不在操作中）', async () => {
  const git = new GitFace(fakeExec([
    ['diff --name-only HEAD', { ok: true, stdout: 'tiddlers/config.json\n', stderr: '' }],
  ]), () => '{\n  "a": 1,\n<<<<<<< Updated upstream\n  "b": 2\n=======\n  "c": 3\n>>>>>>> Stashed changes\n}\n')
  await assert.rejects(
    () => git.commit('/tmp/x', 'msg'),
    (err) => err instanceof GitConflictStateError
      && err.reason === 'conflict markers in working tree'
      && err.files.includes('tiddlers/config.json'),
  )
})

await test('commit 放行：普通内容（Markdown 分隔线与 setext 标题不算冲突）', async () => {
  const git = new GitFace(fakeExec([
    ['diff --name-only HEAD', { ok: true, stdout: 'note.md\n', stderr: '' }],
    ['diff --cached --quiet', { ok: true, stdout: '', stderr: '' }],
  ]), () => '# 标题\n=======\n\n正文 ======= 分隔线\n')
  const result = await git.commit('/tmp/x', 'msg')
  assert.equal(result.committed, false)
  assert.equal(result.message, 'nothing to commit')
})

await test('commit 放行：二进制文件里的字节不参与扫描（含 \\0 直接跳过）', async () => {
  const git = new GitFace(fakeExec([
    ['diff --name-only HEAD', { ok: true, stdout: 'img.png\n', stderr: '' }],
  ]), () => '\u0000\u0001<<<<<<< not a real marker\u0000')
  const result = await git.commit('/tmp/x', 'msg')
  assert.equal(result.committed, false, '不该抛错')
})

await test('status：冲突时带出 conflict{reason,files}，干净时没有该字段', async () => {
  const dirty = new GitFace(fakeExec([
    ['status --porcelain -b', { ok: true, stdout: '## main...origin/main\n M tiddlers/a.tid\n', stderr: '' }],
    ['diff --name-only HEAD', { ok: true, stdout: 'tiddlers/a.tid\n', stderr: '' }],
  ]), () => 'x\n<<<<<<< HEAD\ny\n')
  const dirtyView = await dirty.status('/tmp/x')
  assert.equal(dirtyView.conflict?.reason, 'conflict markers in working tree')
  const clean = new GitFace(fakeExec([
    ['status --porcelain -b', { ok: true, stdout: '## main...origin/main\n', stderr: '' }],
  ]), () => '')
  const cleanView = await clean.status('/tmp/x')
  assert.equal(cleanView.conflict, undefined)
})

await test('AutoCommitter：同一冲突只上报一次，冲突变化才再报；恢复后不再报', async () => {
  const reported = []
  let mode = 'conflict-a'
  const git = {
    commit: async () => {
      if (mode === 'ok') return { committed: true, message: 'ok' }
      const files = mode === 'conflict-a' ? ['a.tid'] : ['b.tid']
      throw new GitConflictStateError(`拒绝提交（${mode}）`, 'unmerged paths', files)
    },
  }
  const committer = new AutoCommitter({
    git, dir: '/tmp/x', enabled: true, debounceMs: 5,
    message: () => 'auto', onError: (err) => reported.push(String(err.message)),
  })
  await committer.flush()
  await committer.flush()
  assert.equal(reported.length, 1, `同一冲突只报一次，实际 ${reported.length}`)
  mode = 'conflict-b'
  await committer.flush()
  assert.equal(reported.length, 2, '冲突文件变化必须再报一次')
  mode = 'ok'
  await committer.flush()
  mode = 'conflict-a'
  await committer.flush()
  assert.equal(reported.length, 3, '成功提交后去重状态必须重置')
  committer.dispose()
})

// ── A. 真 git E2E：真冲突 + 真残留标记 ──────────────────────────────────────
function gitIn(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

const tmp = mkdtempSync(path.join(tmpdir(), 'dsh-tw-guards-'))

await test('E2E：真 merge 冲突 → commit 抛错并点名文件；解决后正常提交', async () => {
  const dir = path.join(tmp, 'repo')
  fs.mkdirSync(dir)
  assert.ok(gitIn(dir, ['init', '-b', 'main']).ok, 'git init 失败')
  gitIn(dir, ['config', 'user.email', 't@local'])
  gitIn(dir, ['config', 'user.name', 't'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n')
  gitIn(dir, ['add', '-A'])
  gitIn(dir, ['commit', '-m', 'base'])

  gitIn(dir, ['checkout', '-b', 'other'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'other\n')
  gitIn(dir, ['commit', '-am', 'other'])
  gitIn(dir, ['checkout', 'main'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'main\n')
  gitIn(dir, ['commit', '-am', 'main'])
  const merged = gitIn(dir, ['merge', 'other'])
  assert.equal(merged.ok, false, '这次 merge 必须冲突')

  const git = new GitFace()
  await assert.rejects(
    () => git.commit(dir, 'should not happen'),
    (err) => err instanceof GitConflictStateError && err.files.includes('a.txt'),
  )
  const view = await git.status(dir)
  assert.equal(view.conflict?.files.includes('a.txt'), true, 'status 也要报冲突')

  // 解决后必须放行（守卫不能变成永久锁）。
  fs.writeFileSync(path.join(dir, 'a.txt'), 'resolved\n')
  gitIn(dir, ['add', '-A'])
  const ok = await git.commit(dir, 'resolved')
  assert.equal(ok.committed, true)
})

await test('E2E：无 git 操作、但文件里留了冲突块（autostash 形态）→ commit 拒绝', async () => {
  const dir = path.join(tmp, 'repo2')
  fs.mkdirSync(dir)
  gitIn(dir, ['init', '-b', 'main'])
  gitIn(dir, ['config', 'user.email', 't@local'])
  gitIn(dir, ['config', 'user.name', 't'])
  fs.writeFileSync(path.join(dir, 'c.json'), '{"a":1}\n')
  gitIn(dir, ['add', '-A'])
  gitIn(dir, ['commit', '-m', 'base'])
  // 模拟 autostash 重新应用冲突后的工作树：git 完全不在操作中。
  fs.writeFileSync(path.join(dir, 'c.json'), '{\n<<<<<<< Updated upstream\n  "a": 1\n=======\n  "b": 2\n>>>>>>> Stashed changes\n}\n')
  const git = new GitFace()
  await assert.rejects(
    () => git.commit(dir, 'must not commit'),
    (err) => err instanceof GitConflictStateError && err.files.includes('c.json'),
  )
  const log = gitIn(dir, ['log', '--oneline'])
  assert.equal(log.stdout.trim().split('\n').length, 1, '绝不能产生第二个提交')
})

// ── B. ConfigStore：解析失败拒绝写 ─────────────────────────────────────────
const CONFLICTED_CONFIG = '{\n  "wechat": { "enabled": true },\n<<<<<<< Updated upstream\n  "prompt": { "extra": "keep me" }\n=======\n  "ui": { "showQuickNote": true }\n>>>>>>> Stashed changes\n}\n'

function makeClient(behaviour) {
  const puts = []
  return {
    puts,
    async get() {
      if (behaviour === 'throw') throw new Error('wiki unavailable')
      if (behaviour === 'missing') return undefined
      if (behaviour === 'conflicted') return { title: '$:/plugins/dsh-tiddlywiki/config', text: CONFLICTED_CONFIG, created: '20200101000000000' }
      if (behaviour === 'array') return { title: '$:/plugins/dsh-tiddlywiki/config', text: '[]', created: '20200101000000000' }
      return { title: '$:/plugins/dsh-tiddlywiki/config', text: '{"note":{"tag":"kept"}}', created: '20200101000000000' }
    },
    async put(tiddler) { puts.push(tiddler) },
  }
}

await test('ConfigStore.load：冲突标记残留 → 记下 parseError，且不把缓存清空', async () => {
  const store = new ConfigStore({ bridge: { enabled: true } })
  await store.load(makeClient('conflicted'))
  assert.ok(typeof store.parseError() === 'string' && store.parseError().length > 0, '必须记录原因')
  assert.equal(store.get().bridge?.enabled, true, 'base 仍然生效（只是覆盖层被忽略）')
})

await test('ConfigStore.set：解析失败必须拒绝写入（绝不能用空缓存合并）', async () => {
  const client = makeClient('conflicted')
  const store = new ConfigStore({})
  await store.load(client)
  await assert.rejects(
    () => store.set(client, { wechat: { enabled: true } }),
    (err) => err instanceof ConfigUnreadableError && err.raw === CONFLICTED_CONFIG,
  )
  assert.equal(client.puts.length, 0, '被拒绝时绝不能 PUT（那正是把配置写成残版的路径）')
  assert.ok(store.parseError().includes('$:/plugins/dsh-tiddlywiki/config'), '错误信息要点名 tiddler')
})

await test('ConfigStore.set：JSON 合法但不是对象（数组）同样拒绝', async () => {
  const client = makeClient('array')
  const store = new ConfigStore({})
  await assert.rejects(() => store.set(client, { note: { tag: 'x' } }), (err) => err instanceof ConfigUnreadableError)
  assert.equal(client.puts.length, 0)
})

await test('ConfigStore.set：瞬时读失败仍走「合并到缓存」（回归，别把这条也拒了）', async () => {
  const client = makeClient('throw')
  const store = new ConfigStore({})
  await store.set(client, { note: { tag: 'x' } })
  assert.equal(client.puts.length, 1, '读失败不该阻止写入')
  assert.equal(store.get().note?.tag, 'x')
})

await test('ConfigStore.set：正常配置合并写入，且保留 created', async () => {
  const client = makeClient('ok')
  const store = new ConfigStore({ uiLanguage: 'zh-Hans' })
  await store.load(client)
  await store.set(client, { wechat: { enabled: true } })
  assert.equal(client.puts.length, 1)
  assert.equal(client.puts[0].created, '20200101000000000', 'created 必须沿用（v0.22.10）')
  const stored = JSON.parse(client.puts[0].text)
  assert.equal(stored.note.tag, 'kept', '未在 patch 里的键必须保留')
  assert.equal(stored.wechat.enabled, true)
  assert.equal(store.parseError(), undefined, '写成功后必须清掉错误态')
})

await test('describeUnreadableConfig：说清原因与「保存已被拒绝」', () => {
  const text = describeUnreadableConfig()
  assert.ok(text.includes('<<<<<<<'), '要点出冲突标记这个最常见原因')
  assert.ok(text.includes('保存已被拒绝'), text)
})

// ── C. 接线断言（防「守卫写了但没人用」）────────────────────────────────────
await test('接线：/sync 与 agent 工具把冲突转成结构化失败，而不是裸抛', () => {
  const routes = fs.readFileSync(path.join(repoRoot, 'src', 'host', 'routes.ts'), 'utf8').replace(/\r\n/g, '\n')
  assert.ok(routes.includes('if (err instanceof GitConflictStateError)'), '/sync 必须接住 GitConflictStateError')
  assert.ok(routes.includes('conflictFiles: err.files'), '/sync 的 409 要带出冲突文件')
  const tools = fs.readFileSync(path.join(repoRoot, 'src', 'host', 'tools.ts'), 'utf8').replace(/\r\n/g, '\n')
  const hits = tools.split('if (err instanceof GitConflictStateError)').length - 1
  assert.ok(hits >= 2, `git_sync 与 git_resolve 都要接住（实际 ${hits} 处）`)
  assert.ok(tools.includes('conflictFiles: err.files'), 'git_sync 失败回执要带 conflictFiles')
})

await test('接线：/admin/state 暴露 configError，/admin/config 把它映射成 409', () => {
  const admin = fs.readFileSync(path.join(repoRoot, 'src', 'host', 'admin.ts'), 'utf8').replace(/\r\n/g, '\n')
  assert.ok(admin.includes('configError: deps.config.parseError() ?? null'), '/admin/state 必须暴露解析失败原因')
  assert.ok(admin.includes('err instanceof ConfigUnreadableError'), '/admin/config 必须特判该错误')
  assert.ok(/ConfigUnreadableError\)\s*\{\s*json\(res, \{ ok: false, error: err\.message \}, 409\)/.test(admin), '拒绝保存应是 409 + 可执行文案')
})

await test('接线：设置页横幅渲染 configError（用户必须看得见）', () => {
  const page = fs.readFileSync(path.join(repoRoot, 'src', 'client', 'settings-page.ts'), 'utf8').replace(/\r\n/g, '\n')
  assert.ok(page.includes('configError?: string | null'), 'AdminState 要有 configError')
  assert.ok(page.includes('⚠️ 配置未生效'), '要渲染可见横幅')
})

await test('接线：客户端 status 行显示未解决冲突', () => {
  const page = fs.readFileSync(path.join(repoRoot, 'src', 'client', 'settings-page.ts'), 'utf8').replace(/\r\n/g, '\n')
  assert.ok(page.includes('冲突未解决'), '状态行要提示冲突已阻止提交')
})

try {
  rmSync(tmp, { recursive: true, force: true })
} catch { /* temp cleanup is best-effort */ }

console.log(failures === 0 ? '\nCONFLICT / CONFIG GUARDS OK' : `\nCONFLICT / CONFIG GUARDS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

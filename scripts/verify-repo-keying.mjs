#!/usr/bin/env node
/**
 * 「git 按仓库，而不是按知识库」的守门（v0.28.0）——真 git，不起 TW。
 *
 * 为什么必须单独验：用户的两种拓扑都要支持——
 *   ① 多个知识库共用**一个**仓库（按文件夹物理划分：工作 / 个人）；
 *   ② 每个知识库各自独立仓库（例如书籍语料）。
 * 拓扑①下 git 只有**一个 index**，而 `git add -A` 在子目录里执行也会作用于整个工作树
 * —— 所以自动提交必须按**仓库**去重（两个 per-folder committer 会互相把对方的改动
 * 提交掉，其中一个永远报 "nothing to commit"）。这一切的前提是能可靠地回答
 * 「这个文件夹属于哪个仓库」，以及「这次 pull 到底改了哪些路径」。
 *
 *   node scripts/verify-repo-keying.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-repo-keying
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { GitFace, RepoCommitters, isInsidePath, pathComparisonKey } from '../lib/index.js'

const execFileP = promisify(execFile)
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

/** Run git in `cwd`, with an inline identity so the test never depends on the machine. */
async function git(cwd, args) {
  const { stdout } = await execFileP('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, windowsHide: true, encoding: 'utf8' })
  return stdout.trim()
}

const repo = new GitFace()
const scratch = await mkdtemp(join(tmpdir(), 'dsh-tw-repoking-'))
console.log('temp root:', scratch)

// ── 拓扑①：一个仓库，两个知识库文件夹（工作 / 个人）─────────────────────────
const shared = join(scratch, 'shared')
const work = join(shared, 'work')
const personal = join(shared, 'personal')
// ── 拓扑②：独立仓库（书籍语料）──────────────────────────────────────────────
const books = join(scratch, 'books')
// ── 没有仓库的裸目录 ────────────────────────────────────────────────────────
const loose = join(scratch, 'loose')

for (const dir of [shared, books, loose]) await mkdir(dir, { recursive: true })
for (const dir of [work, personal]) await mkdir(dir, { recursive: true })
await git(shared, ['init', '-b', 'main'])
await git(books, ['init', '-b', 'main'])

try {
  await test('pathComparisonKey：大小写/分隔符/尾斜杠都归一（三处共用同一份规则）', () => {
    assert.equal(pathComparisonKey('D:\\Notes\\Work\\'), 'd:/notes/work')
    assert.equal(pathComparisonKey('/home/me/notes/'), '/home/me/notes')
    assert.equal(pathComparisonKey('D:/Notes') === pathComparisonKey('d:\\notes'), true, '大小写差异必须是同一个键')
  })

  await test('isInsidePath：严格包含（兄弟目录不算，同路径不算）', () => {
    assert.equal(isInsidePath('/notes', '/notes/work'), true)
    assert.equal(isInsidePath('/notes', '/notes'), false, '同路径是"重复"，不是"嵌套"')
    assert.equal(isInsidePath('/notes', '/notes2'), false, '前缀相同的兄弟目录不是嵌套')
    assert.equal(isInsidePath('/notes', '/other/work'), false)
    assert.equal(isInsidePath('C:\\notes', 'c:/NOTES/work'), true, '大小写不敏感')
  })

  await test('repoRoot：子文件夹返回**共同**的仓库根（拓扑①的关键）', async () => {
    assert.equal(await repo.repoRoot(work), resolve(shared))
    assert.equal(await repo.repoRoot(personal), resolve(shared))
    assert.equal(await repo.repoRoot(shared), resolve(shared))
    // 两个库必须得到**同一个** key，否则自动提交会重复（这正是 M2 的失分点）。
    assert.equal(await repo.repoRoot(work), await repo.repoRoot(personal))
  })

  await test('repoRoot：独立仓库各回各的根（拓扑②）', async () => {
    assert.equal(await repo.repoRoot(books), resolve(books))
    assert.notEqual(await repo.repoRoot(books), await repo.repoRoot(work))
  })

  await test('repoRoot：不在任何工作树里 → undefined（不是抛错、不是瞎猜）', async () => {
    assert.equal(await repo.repoRoot(loose), undefined)
  })

  await test('isRepo 与 repoRoot 对同一个目录的判断必须一致', async () => {
    for (const dir of [work, personal, books, loose]) {
      const isRepo = await repo.isRepo(dir)
      const root = await repo.repoRoot(dir)
      assert.equal(isRepo, root !== undefined, `${dir}: isRepo=${isRepo} 但 repoRoot=${root}`)
    }
  })

  await test('originOf：读得出仓库的 origin；没有 origin / 不在仓库里都答空串（只读，不建远端）', async () => {
    // v0.30.58：`gitTargets()` 在没配 git.remote 时回落到这个值，所以它必须
    // 把「没有 origin」和「不在仓库里」都答成 ''（而不是抛错/瞎猜），并且**只读**
    // —— 写的那一半是 ensureRemote，别把两件事混在一个方法里。
    assert.equal(await repo.originOf(books), '', '仓库没有 origin ⇒ 空串')
    assert.equal(await repo.originOf(loose), '', '不在仓库里 ⇒ 空串，而不是抛错')
    await git(shared, ['remote', 'add', 'origin', 'https://example.invalid/shared.git'])
    assert.equal(await repo.originOf(work), 'https://example.invalid/shared.git', '子目录要问出它所属仓库的 origin')
    assert.equal(await repo.originOf(personal), 'https://example.invalid/shared.git', '同一个仓库的两个库得到同一个答案')
    assert.equal(await repo.originOf(books), '', '别的仓库加了 origin，不影响这个仓库')
    assert.equal(await git(books, ['remote']), '', 'originOf 是只读的：不许顺手给没有 origin 的仓库加一个')
  })

  await test('filesChangedBetween：说出"这次改动动了哪些路径"（决定重启哪个库）', async () => {
    await writeFile(join(shared, 'README.md'), 'x\n', 'utf8')
    await writeFile(join(work, 'only-work.txt'), 'w\n', 'utf8')
    await mkdir(join(personal, 'tiddlers'), { recursive: true })
    await git(shared, ['add', '-A'])
    await git(shared, ['commit', '-m', 'first'])
    const first = await git(shared, ['rev-parse', 'HEAD'])

    await writeFile(join(personal, 'tiddlers', 'personal-note.tid'), 'title: n\n\nhi\n', 'utf8')
    await git(shared, ['add', '-A'])
    await git(shared, ['commit', '-m', 'second'])
    const second = await git(shared, ['rev-parse', 'HEAD'])

    const files = await repo.filesChangedBetween(shared, first, second)
    assert.deepEqual(files, ['personal/tiddlers/personal-note.tid'],
      `只有 personal 变了，就必须只报它：${JSON.stringify(files)}`)

    // 这一段正是「pull 之后该重启哪个库」的判据：把仓库相对的改动路径还原成绝对路径，
    // 再看它落在哪个知识库的目录里。**受影响的才重启**，没变的库不该被打断。
    const affected = [work, personal]
      .filter((dir) => files.some((f) => isInsidePath(dir, join(shared, f))))
      .map((dir) => dir.split(/[\\/]/).pop())
    assert.deepEqual(affected, ['personal'], 'personal 变了 → 只该重启 personal')

    // **三态**（v0.30.35）：`[]` = 问了、答案是「没有变化」；`undefined` = 问了、但**答不出来**。     // 两者绝不能合并 —— 下游拿 `[]` 去 affectedBy() 会得出「一个库都不受影响」，     // 于是「HEAD 动了但 diff 失败」被当成「没变化」⇒ 不重启任何库 ⇒ TW 里还是旧内容，     // 而回执说同步成功。这几行断言就是那个语义边界的守门。
    assert.deepEqual(await repo.filesChangedBetween(shared, '', second), [])
    assert.deepEqual(await repo.filesChangedBetween(shared, first, first), [])
    assert.equal(await repo.filesChangedBetween(shared, 'deadbeef', second), undefined, '无法解析的 ref ⇒ undefined（问了，但答不出来）——不许退化成空数组')
    assert.notDeepEqual(await repo.filesChangedBetween(shared, 'deadbeef', second), [], '⇒ 与「没有变化」必须可区分')
  })

  // ── RepoCommitters：一个仓库一个 committer ──────────────────────────────────
  // 用大 debounce + 显式 flush，让时序确定（debounce=0 会让两次 touch 各自触发一次
  // 提交，恰好把"应该合成一个提交"这件事测不出来）。
  const settings = { autoCommit: true, debounceMs: 60_000 }

  await test('RepoCommitters：共享仓库只产生一个 committer；独立仓库各一个；裸目录没有', async () => {
    const rc = new RepoCommitters({ git: repo, settings: () => settings, message: () => 'shared-repo commit', log: () => {} })
    await rc.touch(work)
    await rc.touch(personal)
    assert.equal(rc.repoRoots().length, 1, '同一个仓库只许有一个 committer（两个 per-folder committer 会互相抢占 index）')
    assert.equal(rc.repoRoots()[0], resolve(shared), 'committer 必须挂在仓库根上，而不是某个库目录')
    await rc.touch(books)
    assert.equal(rc.repoRoots().length, 2, '独立仓库各有一个')
    await rc.touch(loose)
    assert.equal(rc.repoRoots().length, 2, '不是仓库的目录不产生 committer')
    rc.dispose()
    assert.deepEqual(rc.repoRoots(), [], 'dispose 必须释放全部')
  })

  await test('RepoCommitters：共享仓库里两个库的改动合成**一个**提交（本步存在的理由）', async () => {
    const rc = new RepoCommitters({ git: repo, settings: () => settings, message: () => 'shared-repo commit', log: () => {} })
    await writeFile(join(work, 'from-work.txt'), 'w\n', 'utf8')
    await mkdir(join(personal, 'tiddlers'), { recursive: true })
    await writeFile(join(personal, 'tiddlers', 'from-personal.tid'), 'x\n', 'utf8')
    await rc.touch(work)
    await rc.touch(personal)
    await rc.flush()

    const subjects = (await git(shared, ['log', '--format=%s'])).split('\n').filter((l) => l === 'shared-repo commit')
    assert.equal(subjects.length, 1, `两个库的改动必须是同一个提交，实际 ${subjects.length} 个`)
    const changed = await git(shared, ['show', '--name-only', '--format=', 'HEAD'])
    assert.ok(changed.includes('from-work.txt'), `提交必须包含工作库的改动：\n${changed}`)
    assert.ok(changed.includes('personal/tiddlers/from-personal.tid'), `提交必须包含个人库的改动：\n${changed}`)
    rc.dispose()
  })

  await test('RepoCommitters：git 设置按**仓库**被问（不是按知识库）', async () => {
    // 共享一个仓库的两个库若各读各的 git.*，"书籍库"就可能用上"工作库"的自启与防抖设置。
    const asked = []
    const rc = new RepoCommitters({
      git: repo,
      settings: (root) => { asked.push(root); return { autoCommit: false, debounceMs: 60_000 } },
      message: () => 'x',
      log: () => {},
    })
    await rc.touch(work)
    await rc.touch(personal)
    assert.deepEqual(asked, [resolve(shared)], '同一个仓库只问一次，问的是仓库根')
    await rc.touch(books)
    assert.deepEqual(asked, [resolve(shared), resolve(books)], '独立仓库各自被问一次')
    rc.dispose()
  })

  await test('RepoCommitters：独立仓库互不牵连（书籍库的提交里不得有别的库）', async () => {
    const rc = new RepoCommitters({ git: repo, settings: () => settings, message: () => 'books commit', log: () => {} })
    await writeFile(join(books, 'corpus.txt'), 'c\n', 'utf8')
    await rc.touch(books)
    await rc.flush(books)
    const changed = await git(books, ['show', '--name-only', '--format=', 'HEAD'])
    assert.deepEqual(changed.split('\n').filter(Boolean), ['corpus.txt'])
    rc.dispose()
  })
} finally {
  await rm(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nREPO KEYING CHECKS OK' : `\nREPO KEYING CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

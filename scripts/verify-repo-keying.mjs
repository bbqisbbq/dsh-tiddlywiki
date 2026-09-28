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
import { GitFace, isInsidePath, pathComparisonKey } from '../lib/index.js'

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

    // 用不上的 range 一律空数组，而不是抛错。
    assert.deepEqual(await repo.filesChangedBetween(shared, '', second), [])
    assert.deepEqual(await repo.filesChangedBetween(shared, first, first), [])
    assert.deepEqual(await repo.filesChangedBetween(shared, 'deadbeef', second), [])
  })
} finally {
  await rm(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nREPO KEYING CHECKS OK' : `\nREPO KEYING CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

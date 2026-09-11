#!/usr/bin/env node
/**
 * git 冲突解决端到端（真分叉 / 真冲突 / 真 abort / 真 fetch+checkout）。
 *
 * 覆盖「pull 冲突 → 绝不自动覆盖」这条数据安全承诺的完整闭环：
 *   1. 造本地/远端分叉（同一个 tiddler 文件两边各改一次）；
 *   2. `git.pull()` 报冲突并 `rebase --abort`：
 *      - 冲突文件被列出；
 *      - **工作树干净**、`.git/rebase-merge` / `rebase-apply` 无残留；
 *      - 本地内容原样保留（keep-local 语义 = abort 后工作区即本地版本）；
 *   3. 走 `tiddlywiki_git_resolve strategy=keep-local`（只读报告，内容不变）；
 *   4. 再走 `tiddlywiki_git_resolve strategy=keep-remote`（= `git fetch` +
 *      `checkoutFetchHead` + commit）：内容变为远端版本、树干净、产生了提交。
 *
 * 纯 git + lib 的 GitFace / 工具层，不 spawn TW。
 *
 *   node scripts/verify-git-resolve.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-git-resolve
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitFace, registerTiddlywikiTools } from '../lib/index.js'

const CONFLICT_FILE = 'tiddlers/Conflict.tid'
const LOCAL_TEXT = 'local version —— 本地字节保留 ✅\n'
const REMOTE_TEXT = 'remote version —— 远端版本 ✅\n'

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

/** 读冲突文件并归一化行尾（Windows 上 git 的 LF→CRLF 检出属正常）。 */
const readConflict = (dir) =>
  readFile(join(dir, CONFLICT_FILE), 'utf8').then((s) => s.replace(/\r\n/g, '\n'))

/** 是否残留 rebase 元数据（`.git/rebase-merge` / `.git/rebase-apply`）。 */
const hasRebaseLeftover = (dir) =>
  existsSync(join(dir, '.git', 'rebase-merge')) || existsSync(join(dir, '.git', 'rebase-apply'))

const root = await mkdtemp(join(tmpdir(), 'dsh-tw-verify-git-resolve-'))
const originPath = join(root, 'origin.git')
const wikiPath = join(root, 'wiki')
const clonePath = join(root, 'clone')
console.log(`temp git root: ${root}`)

const git = new GitFace()
const gclone = new GitFace()
let pullResult
try {
  // ── 1. 造分叉 ────────────────────────────────────────────────────────────
  const bare = await git.exec(['init', '--bare', '-b', 'main', originPath], { cwd: root, timeout: 15_000 })
  assert.ok(bare.ok, `bare origin 初始化失败：${bare.stderr}`)

  await mkdir(join(wikiPath, 'tiddlers'), { recursive: true })
  await writeFile(join(wikiPath, CONFLICT_FILE), 'base version\n')
  assert.ok(await git.init(wikiPath, 'main'), 'git init 失败')
  assert.ok(await git.initialCommit(wikiPath), 'initial commit 失败')
  assert.ok((await git.ensureRemote(wikiPath, originPath)).ok, 'ensureRemote 失败')
  assert.ok((await git.firstPush(wikiPath)).ok, 'firstPush 失败')

  const clone = await git.exec(['clone', originPath, clonePath], { cwd: root, timeout: 30_000 })
  assert.ok(clone.ok, `clone 失败：${clone.stderr}`)

  // 本地先提交一版
  await writeFile(join(wikiPath, CONFLICT_FILE), LOCAL_TEXT)
  const localCommit = await git.commit(wikiPath, 'local side')
  assert.ok(localCommit.committed, `本地提交失败：${localCommit.message}`)
  // 克隆端基于同一个 base 再提交另一版并推回 origin（真分叉）
  await writeFile(join(clonePath, CONFLICT_FILE), REMOTE_TEXT)
  const remoteCommit = await gclone.commit(clonePath, 'remote side')
  assert.ok(remoteCommit.committed, `远端提交失败：${remoteCommit.message}`)
  const pushRemote = await gclone.push(clonePath)
  assert.ok(pushRemote.ok, `远端推送失败：${pushRemote.message}`)

  // ── 2. pull 冲突 → abort，本地内容保留 ───────────────────────────────────
  pullResult = await git.pull(wikiPath)

  await test('pull 真冲突：报失败并列出冲突文件', () => {
    assert.equal(pullResult.ok, false, `分叉同文件的 pull 必须失败，实际 ${JSON.stringify(pullResult)}`)
    assert.ok(Array.isArray(pullResult.conflictFiles) && pullResult.conflictFiles.includes(CONFLICT_FILE), `冲突文件应包含 ${CONFLICT_FILE}，实际 ${JSON.stringify(pullResult.conflictFiles)}`)
  })

  await test('冲突后工作树干净、无 rebase 残留（rebase --abort 真的执行了）', async () => {
    const st = await git.status(wikiPath)
    assert.equal(st.dirty, false, `abort 后工作树必须干净，实际 dirty 文件：${JSON.stringify(st.dirtyFiles)}`)
    assert.equal(hasRebaseLeftover(wikiPath), false, 'abort 后不得残留 .git/rebase-merge / .git/rebase-apply')
    assert.equal(await readConflict(wikiPath), LOCAL_TEXT, 'abort 后工作区内容必须是本地版本（绝不自动覆盖）')
  })

  await test('keep-local：只读报告，内容仍然是本地版本', async () => {
    const tools = new Map()
    registerTiddlywikiTools(
      { tools: { register: (tool) => { tools.set(tool.name, tool); return () => {} } } },
      { wiki: () => undefined, git, wikiPath: () => wikiPath, noteTag: () => 'inbox', autoCommit: () => {} },
    )
    const resolve = tools.get('tiddlywiki_git_resolve')
    assert.ok(resolve !== undefined, 'tiddlywiki_git_resolve 未注册')
    const r = await resolve.execute({ strategy: 'keep-local', files: [CONFLICT_FILE] }, undefined)
    assert.equal(r.ok, true, `keep-local 应成功：${JSON.stringify(r)}`)
    assert.deepEqual(r.files, [CONFLICT_FILE], `应回显涉及文件：${JSON.stringify(r.files)}`)
    assert.equal(await readConflict(wikiPath), LOCAL_TEXT, 'keep-local 不得改动工作区内容')
    assert.equal((await git.status(wikiPath)).dirty, false, 'keep-local 后工作树应保持干净')
  })

  // ── 3. keep-remote = fetch + checkoutFetchHead + commit ──────────────────
  await test('keep-remote：fetch + checkout FETCH_HEAD 取远端版本并提交，树干净', async () => {
    const fetched = await git.fetch(wikiPath)
    assert.ok(fetched.ok, `git fetch 失败：${fetched.message}`)
    const tools = new Map()
    registerTiddlywikiTools(
      { tools: { register: (tool) => { tools.set(tool.name, tool); return () => {} } } },
      { wiki: () => undefined, git, wikiPath: () => wikiPath, noteTag: () => 'inbox', autoCommit: () => {} },
    )
    const resolve = tools.get('tiddlywiki_git_resolve')
    const r = await resolve.execute({ strategy: 'keep-remote', files: [CONFLICT_FILE] }, undefined)
    assert.equal(r.ok, true, `keep-remote 应成功：${JSON.stringify(r)}`)
    assert.equal(await readConflict(wikiPath), REMOTE_TEXT, 'keep-remote 后工作区内容必须是远端版本')
    assert.equal(hasRebaseLeftover(wikiPath), false, 'keep-remote 后不得残留 rebase 元数据')
    assert.ok(typeof r.commit === 'string' && r.commit.includes('resolve conflict'), `应产生一个解决冲突的提交，实际 ${JSON.stringify(r.commit)}`)
    const st = await git.status(wikiPath)
    assert.equal(st.dirty, false, `keep-remote 提交后工作树必须干净，实际 dirty 文件：${JSON.stringify(st.dirtyFiles)}`)
    assert.equal(st.branch, 'main', `分支应为 main，实际 ${st.branch}`)
    const log = await git.exec(['log', '-1', '--format=%s'], { cwd: wikiPath, timeout: 5_000 })
    assert.ok(log.ok && log.stdout.includes('resolve conflict'), `最近提交应是我们刚创建的解决提交，实际 ${JSON.stringify(log.stdout.trim())}`)
  })
} catch (err) {
  failures++
  console.error('FAIL  git 冲突解决验收框架异常')
  console.error(err)
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(failures === 0 ? '\nGIT RESOLVE CHECKS OK' : `\nGIT RESOLVE CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

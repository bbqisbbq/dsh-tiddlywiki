#!/usr/bin/env node
/**
 * 宿主契约守门：我们注册的**每一个客户端座位**，都必须真的存在于当前 DSH 里（v0.30.66）。
 *
 * WHY THIS EXISTS
 * ---------------
 * v0.28.8 给「新会话选库」挂的座位叫 `conversation.input.selector.context`，抄自
 * 当时的一个第三方参考实现。它**在 DSH 0.2.1 里根本不存在** —— 宿主座位表里没有，
 * 随包 client bundle 里连这个字符串都搜不到。于是那次改动一直是死代码：注册永远
 * 等不到声明，用户看不到任何报错，代码却安静地躺在仓库里跑了十几个版本。
 *
 * 这类事故的共性是：**宿主的座位表是外部契约，而我们的守门全是「读自己的源码」**。
 * 自己跟自己比永远绿。所以这里把宿主当成被测对象：读出宿主**自己**的座位目录，
 * 再反过来断言我们注册的每个 name 都在里面、kind 也对得上。
 *
 * 数据来源（宿主自带的座位契约目录，不是我们猜的）
 * ----------------------------------------------
 * `@deepseek-ai/dsh-cordis-client-runner/lib/client.js` 里内嵌了一张
 * `{ key, kind, scope, summary, doc, registerOptions, occupants, replaceRisk }`
 * 的座位表（DSH 自己用它做插件开发时的 Slots 内省）。`kind` 有
 * `single | list | keyed | chain | (原样)`，`scope` 有 `root | session | session-maybe`。
 * 同一个文件里 `tool.call.toolview` 的 `keyDomain` 还列出了**已被官方占用**的
 * 工具名 —— 我们那 16 个 `tool.call.toolview` key 一个都不能撞。
 *
 * 宿主在哪
 * --------
 * 1. `DSH_CONTRACT_SOURCE` 环境变量（asar 路径或 client.js 路径），调试用；
 * 2. 桌面版：`process.execPath` 旁边的 `resources/app.asar`（Win/Linux）或
 *    `../Resources/app.asar`（macOS）；
 * 3. 装了 profile 的 CLI：`$DSH_HOME/profiles/<name>/node_modules/@deepseek-ai/…`。
 *
 * 找不到宿主 ⇒ **打印 SKIPPED 并退出 0**。这条守门只在「本机装了 DSH」时才有意义，
 * 不能因为 npm 用户在别的机器上 clone 就跑红。
 *
 *   node scripts/verify-dsh-contract.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-dsh-contract
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNNER_SUFFIX = 'dsh-cordis-client-runner/lib/client.js'
/** 座位表至少这么多条 —— 少于它就是解析失败，宁可红也不要"看起来一切正常"。 */
const MIN_CATALOGUE_ENTRIES = 80

let failures = 0
function test(name, fn) {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures++
    console.error(`FAIL  ${name}\n      ${err && err.message ? err.message : err}`)
  }
}

// ── 1. 找宿主（asar 或散装 client.js）─────────────────────────────────────────

/** Read one file out of an asar archive by its archive-relative path. */
function readAsarEntry(asarPath, relPath) {
  const fd = fs.openSync(asarPath, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(12)
    const headerBuf = Buffer.alloc(headerSize)
    fs.readSync(fd, headerBuf, 0, headerSize, 16)
    const header = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/, ''))
    const base = 16 + headerSize
    let node = header
    for (const segment of relPath.split('/').filter(Boolean)) {
      node = node.files?.[segment]
      if (node === undefined) return undefined
    }
    if (node.files !== undefined || node.unpacked === true) return undefined
    const offset = Number(node.offset)
    if (!Number.isFinite(offset)) return undefined
    const buf = Buffer.alloc(node.size)
    fs.readSync(fd, buf, 0, node.size, base + offset)
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/** Find the runner bundle inside an asar (its prefix differs between builds). */
function findInAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  let header
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(12)
    const headerBuf = Buffer.alloc(headerSize)
    fs.readSync(fd, headerBuf, 0, headerSize, 16)
    header = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/, ''))
  } finally {
    fs.closeSync(fd)
  }
  const found = []
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const next = `${prefix}/${name}`
      if (child.files !== undefined) walk(child, next)
      else if (next.endsWith(`/${RUNNER_SUFFIX}`)) found.push(next.replace(/^\//, ''))
    }
  }
  walk(header, '')
  return found
}

function locateHost() {
  const override = process.env.DSH_CONTRACT_SOURCE
  if (typeof override === 'string' && override.length > 0) {
    if (!fs.existsSync(override)) return { skip: `DSH_CONTRACT_SOURCE 指向的路径不存在：${override}` }
    if (override.endsWith('.asar')) {
      const rels = findInAsar(override)
      if (rels.length === 0) return { skip: `${override} 里找不到 ${RUNNER_SUFFIX}` }
      return { source: `${override} → ${rels[0]}`, text: readAsarEntry(override, rels[0]) }
    }
    return { source: override, text: fs.readFileSync(override, 'utf8') }
  }
  const exeDir = path.dirname(process.execPath)
  const asarCandidates = [
    // Running INSIDE the desktop host (Electron sets resourcesPath).
    path.join(process.resourcesPath ?? '', 'app.asar'),
    path.join(exeDir, '..', 'Resources', 'app.asar'), // macOS desktop
    path.join(exeDir, 'resources', 'app.asar'), // Windows / Linux desktop
    // Running from a plain node shell next to an installed desktop app.
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
    path.join(process.env.PROGRAMFILES ?? '', 'DeepSeek Harness', 'resources', 'app.asar'),
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
    '/opt/DeepSeek Harness/resources/app.asar',
  ]
  for (const asarPath of asarCandidates) {
    if (!fs.existsSync(asarPath)) continue
    const rels = findInAsar(asarPath)
    if (rels.length === 0) continue
    const text = readAsarEntry(asarPath, rels[0])
    if (text !== undefined) return { source: `${asarPath} → ${rels[0]}`, text }
  }
  // A profile-installed CLI keeps the packages on disk.
  const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const profilesDir = path.join(dshHome, 'profiles')
  if (fs.existsSync(profilesDir)) {
    for (const profile of fs.readdirSync(profilesDir)) {
      const p = path.join(profilesDir, profile, 'node_modules', '@deepseek-ai', RUNNER_SUFFIX)
      if (fs.existsSync(p)) return { source: p, text: fs.readFileSync(p, 'utf8') }
    }
  }
  return { skip: '本机找不到 DSH 安装（桌面版 app.asar 与 profile node_modules 都没有）' }
}

const host = locateHost()
if (host.skip !== undefined) {
  console.log(`SKIPPED  ${host.skip}`)
  console.log('         （契约守门只在装了 DSH 的机器上有意义；其他平台 clone 后不影响发布）')
  process.exit(0)
}
console.log(`DSH 座位目录来源：${host.source}`)

// ── 2. 解析宿主的座位表 ───────────────────────────────────────────────────────

/** `{ key, kind, scope }` for every entry in the host's own slot catalogue. */
function parseCatalogue(text) {
  const entries = new Map()
  const re = /key:\s*"([A-Za-z][\w.\-/]*)",\s*kind:\s*"([a-z]+)",\s*scope:\s*"([\w-]+)"/g
  let match
  while ((match = re.exec(text)) !== null) entries.set(match[1], { kind: match[2], scope: match[3] })
  return entries
}

/**
 * Tool names already claimed by a shipped `tool.call.toolview` renderer.
 *
 * Anchored on the `tool.call.toolview` entry itself: "already taken:" also
 * appears in the keyDomain of other keyed seats (`conversation.chat.node` lists
 * turn kinds there), and reading the first occurrence yields a plausible-looking
 * but wrong list — a check that can never fail.
 */
function parseTakenToolKeys(text) {
  const entryAt = text.indexOf('key: "tool.call.toolview"')
  if (entryAt < 0) return new Set()
  const nextEntryAt = text.indexOf('key: "', entryAt + 10)
  const block = text.slice(entryAt, nextEntryAt < 0 ? text.length : nextEntryAt)
  const domainAt = block.indexOf('keyDomain:')
  if (domainAt < 0) return new Set()
  const at = block.indexOf('already taken:', domainAt)
  if (at < 0) return new Set()
  const tail = block.slice(at + 'already taken:'.length)
  const end = tail.search(/"/)
  return new Set(tail.slice(0, end < 0 ? tail.length : end).split(',').map((s) => s.trim()).filter(Boolean))
}

const catalogue = parseCatalogue(host.text)
const takenToolKeys = parseTakenToolKeys(host.text)

// ── 3. 我们注册了哪些座位 ─────────────────────────────────────────────────────
//
// 直接扫 client 源码里的 `name: '<slot>'` / `slots.inject('<slot>'`，所以新增
// 座位时**不用改这个脚本**：忘了同步就会在下一次跑守门时红（而不是上线后静默）。

function collectClientSlots() {
  const dir = path.join(repoRoot, 'src', 'client')
  const found = new Map() // slot -> Set(file)
  const re = /(?:name:\s*'([a-z][\w.\-]*)'|\b(?:inject|register)\(\s*'([a-z][\w.\-]*)')/g
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.ts')) continue
    const source = fs.readFileSync(path.join(dir, entry), 'utf8')
    // 注释里会写历史座位名（正是本模块头讲的那件事），断言只看代码。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '')
    let match
    while ((match = re.exec(code)) !== null) {
      const slot = match[1] ?? match[2]
      // 只收「像座位名的」（带点的）：`name:` 在别处也有（React key、事件名）。
      if (!slot.includes('.')) continue
      if (!found.has(slot)) found.set(slot, new Set())
      found.get(slot).add(entry)
    }
  }
  return found
}

const ourSlots = collectClientSlots()

// ── 4. 断言 ──────────────────────────────────────────────────────────────────

test('宿主的座位目录解析成功（条目数下限，防止解析器悄悄失效）', () => {
  assert.ok(
    catalogue.size >= MIN_CATALOGUE_ENTRIES,
    `只解析出 ${catalogue.size} 条座位（下限 ${MIN_CATALOGUE_ENTRIES}）—— 宿主的契约目录格式变了，请更新本脚本的解析正则`,
  )
})

test('我们注册的每个座位都存在于宿主座位表里', () => {
  const missing = [...ourSlots.keys()].filter((slot) => !catalogue.has(slot))
  assert.deepEqual(
    missing,
    [],
    `这些座位在 DSH 里不存在（注册了也永远不会渲染）：${missing.map((s) => `${s}（${[...ourSlots.get(s)].join(',')}）`).join('；')}`,
  )
})

test('座位 kind 对得上：列表/单值座位按 id 注册，键控座位按 key 注册', () => {
  const expectKeyed = new Set(['tool.call.toolview', 'sidebar.right.pane.tab'])
  for (const [slot, files] of ourSlots) {
    const entry = catalogue.get(slot)
    if (entry === undefined) continue // 上一条已经报过
    if (expectKeyed.has(slot)) {
      assert.equal(entry.kind, 'keyed', `${slot} 在宿主里是 ${entry.kind}，我们按 key 注册（${[...files].join(',')}）`)
    } else if (entry.kind === 'keyed') {
      assert.fail(`${slot} 在宿主里是 keyed，但我们是按 id 注册的 —— 需要改成 register({ name, key })`)
    }
  }
})

test('16 个 tiddlywiki_* 工具视图没有撞上官方已占用的 key', () => {
  const dir = path.join(repoRoot, 'src', 'client')
  const source = fs.readFileSync(path.join(dir, 'tool-views.ts'), 'utf8')
  const block = source.slice(source.indexOf('const TOOL_VIEW_KEYS'), source.indexOf('] as const', source.indexOf('const TOOL_VIEW_KEYS')))
  const keys = [...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])
  assert.ok(keys.length >= 16, `工具视图 key 只解析出 ${keys.length} 个（应 ≥16）`)
  const clashes = keys.filter((key) => takenToolKeys.has(key))
  assert.deepEqual(clashes, [], `这些 key 已被官方 toolview 占用，注册会顶掉内置卡片：${clashes.join(', ')}`)
})

test('engines.dsh 已声明（让「宿主太旧/太新」变成安装期可见的事实）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const range = pkg.engines?.dsh
  assert.equal(typeof range, 'string', 'package.json 的 engines.dsh 必须声明一个 semver 范围')
  assert.ok(range.length > 0, 'engines.dsh 不得为空串')
})

console.log(
  failures === 0
    ? `DSH CONTRACT OK（宿主座位 ${catalogue.size} 条 · 我们注册 ${ourSlots.size} 个 · 官方已占 toolview key ${takenToolKeys.size} 个）`
    : `DSH CONTRACT FAILED（${failures} 项）`,
)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env node
/**
 * 多知识库清单的守门（v0.28.0）——纯逻辑 + 临时文件，不 spawn TW、不碰真实配置。
 *
 * 为什么单独一个脚本：`src/host/wiki-registry.ts` 决定「哪些知识库存在、哪一个是
 * 默认、哪些对 agent 隐身」。它的错误分两种，**都不会报错，只会静默走错**：
 *   · 两个条目指向同一目录 / 一个条目嵌在另一个里面 → git 归属错乱，
 *     外层库的 `git add -A` 会把内层库的内容一起提交；
 *   · 清单坏掉时"顺手"当成空清单 → 整座 wiki 农场退化成别的位置。
 * 所以这里把「该拒绝的拒绝、该回退的回退、该报告的写清楚」全部变成可失败断言。
 *
 * 与 `scripts/verify-wiki-switch.mjs` 的分工：那边验「运行中切换 + 回滚」（真 TW），
 * 这边验「清单怎么读、怎么判、坏成什么样还不算崩」（零依赖，毫秒级）。
 *
 *   node scripts/verify-wiki-registry.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-wiki-registry
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_WIKI_ID,
  DEFAULT_WIKI_MODE,
  RESERVED_WIKI_IDS,
  WIKI_MODES,
  WIKI_REGISTRY_VERSION,
  applyWikiAction,
  defaultEntry,
  deriveWikiId,
  entryPath,
  findEntry,
  findPathConflicts,
  normalizeEntry,
  normalizeWikiId,
  readRegistry,
  removeWiki,
  singleEntryRegistry,
  upsertWiki,
  validateRegistry,
  writeRegistry,
} from '../lib/index.js'

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

/**
 * 造一个合法条目（root 用真实绝对路径，normalizeLocation 拒绝相对路径）。
 * 刻意**不带 label**：label 缺省时取目录名这条派生规则本身就是要守的行为。
 */
function entry(id, root, name = '.', extra = {}) {
  return { id, root, name, ...extra }
}

const scratch = await mkdtemp(join(tmpdir(), 'dsh-tw-registry-'))
const ROOT = scratch
const FALLBACK = join(scratch, 'fallback-wiki')

await test('normalizeWikiId：合法 id 小写化保留，其余一律 undefined', () => {
  assert.equal(normalizeWikiId('main'), 'main')
  assert.equal(normalizeWikiId('  Work-2  '), 'work-2')
  assert.equal(normalizeWikiId('books.v2'), 'books.v2')
  for (const bad of ['', '   ', '_x', 'a/b', 'a\\b', '..', '.', 'a b', '中文', 'x'.repeat(65), 42, null, undefined, {}, []]) {
    assert.equal(normalizeWikiId(bad), undefined, `${JSON.stringify(bad)} 不该是合法 id`)
  }
  // id 是 URL 路径段（/tw/<id>/）：斜杠与中文必须被挡住，而不是编码后放行。
  assert.equal(normalizeWikiId('书籍'), undefined)
})

await test('deriveWikiId：从目录名派生、冲突加后缀、中文/垃圾回落 wiki', () => {
  assert.equal(deriveWikiId('My Notes'), 'my-notes')
  assert.equal(deriveWikiId('dsh-tiddlywiki'), 'dsh-tiddlywiki')
  assert.equal(deriveWikiId('books'), 'books')
  assert.equal(deriveWikiId('books', ['books']), 'books-2')
  assert.equal(deriveWikiId('books', ['books', 'books-2']), 'books-3')
  // 中文文件夹名派生不出 ASCII id —— 这是刻意的：id 进 URL，label 保留中文名。
  assert.equal(deriveWikiId('书籍'), 'wiki')
  assert.equal(deriveWikiId('书籍', ['wiki']), 'wiki-2')
  assert.equal(deriveWikiId(''), 'wiki')
  // 派生结果必须永远能通过校验（否则"加一个知识库"会生成读不回来的清单）。
  for (const source of ['', '...', '中文', 'A B C', 'x'.repeat(200), null]) {
    assert.notEqual(normalizeWikiId(deriveWikiId(source)), undefined, `${JSON.stringify(source)} 派生出了非法 id`)
  }
})

await test('normalizeEntry：默认值 / label 派生 / 位置与 id 校验', () => {
  const ok = normalizeEntry(entry('work', ROOT, 'notes'))
  assert.equal(ok.error, undefined)
  assert.deepEqual(ok.entry, { id: 'work', label: 'notes', root: ROOT, name: 'notes', agentVisible: true, autostart: false })

  // name='.' = 根目录自身：label 取目录名而不是字面的「.」。
  assert.equal(normalizeEntry(entry('root', ROOT)).entry.label, ROOT.split(/[\\/]/).pop())
  // 显式 flag 才为真；`agentVisible: false` 是唯一能关掉可见性的写法。
  assert.equal(normalizeEntry(entry('a', ROOT, 'a', { agentVisible: false })).entry.agentVisible, false)
  assert.equal(normalizeEntry(entry('a', ROOT, 'a', { autostart: true })).entry.autostart, true)
  assert.equal(normalizeEntry(entry('a', ROOT, 'a', { label: '  工作  ' })).entry.label, '工作')

  assert.match(normalizeEntry({ id: 'a', root: 'relative/path' }).error, /绝对路径/)
  assert.match(normalizeEntry(entry('A B', ROOT)).error, /id 非法/)
  assert.ok(normalizeEntry('nope').error)
  assert.ok(normalizeEntry(null).error)
})

await test('findPathConflicts：同目录拒绝、嵌套（两向）拒绝、兄弟放行、大小写视为同目录', () => {
  assert.deepEqual(findPathConflicts([entry('a', ROOT, 'one'), entry('b', ROOT, 'two')]), [])

  const dup = findPathConflicts([entry('a', ROOT, 'one'), entry('b', ROOT, 'one')])
  assert.equal(dup.length, 1)
  assert.match(dup[0], /同一个目录/)

  // 大小写变体在大小写不敏感的文件系统上是同一个目录；我们全线都当同一个（反坑）。
  assert.equal(findPathConflicts([entry('a', ROOT, 'One'), entry('b', ROOT, 'one')]).length, 1)

  const nested = findPathConflicts([entry('outer', ROOT, '.'), entry('inner', ROOT, 'inner')])
  assert.equal(nested.length, 1)
  assert.match(nested[0], /位于/)
  // 反向也要报（条目顺序不该影响判定）。
  assert.equal(findPathConflicts([entry('inner', ROOT, 'inner'), entry('outer', ROOT, '.')]).length, 1)

  // 只有前缀相同的兄弟目录不是嵌套（notes / notes2 这类最常见）。
  assert.deepEqual(findPathConflicts([entry('a', ROOT, 'notes'), entry('b', ROOT, 'notes2')]), [])
})

await test('validateRegistry：结构性问题一律致命（绝不给一个能用的假清单）', () => {
  for (const bad of [null, 42, 'x', [], {}]) {
    const v = validateRegistry(bad)
    assert.equal(v.registry, undefined, `${JSON.stringify(bad)} 不该产出 registry`)
    assert.ok(v.fatal.length > 0)
  }
  assert.ok(validateRegistry({ version: 1, defaultId: 'a', wikis: [] }).fatal.length > 0)
  // 未来版本：宁可回退已知good，也不猜新格式。
  assert.match(validateRegistry({ version: WIKI_REGISTRY_VERSION + 1, defaultId: 'a', wikis: [entry('a', ROOT, 'a')] }).fatal[0], /更新版本/)
  // 重复 id 是致命（路由与作用域都以 id 为键）。
  assert.match(validateRegistry({ version: 1, defaultId: 'a', wikis: [entry('a', ROOT, 'a'), entry('a', ROOT, 'b')] }).fatal[0], /id 重复/)
  // 嵌套是致命 —— 这正是本模块存在的理由之一。
  assert.match(validateRegistry({ version: 1, defaultId: 'outer', wikis: [entry('outer', ROOT, '.'), entry('inner', ROOT, 'inner')] }).fatal[0], /位于/)
  // 一条都解析不出来 = 空清单，同样致命。
  assert.ok(validateRegistry({ version: 1, wikis: [{ id: 'BAD ID', root: 'rel' }] }).fatal.length > 0)
})

await test('validateRegistry：可修复问题只警告（丢一条不该让整个农场塌掉）', () => {
  const two = validateRegistry({
    version: 1,
    defaultId: 'good',
    wikis: [entry('good', ROOT, 'good'), { id: 'BAD ID', root: 'rel' }],
  })
  assert.equal(two.fatal.length, 0)
  assert.equal(two.registry.wikis.length, 1)
  assert.equal(two.warnings.length, 1)
  assert.match(two.warnings[0], /跳过第 2 个条目/)

  const dangling = validateRegistry({ version: 1, defaultId: 'gone', wikis: [entry('a', ROOT, 'a')] })
  assert.equal(dangling.fatal.length, 0)
  assert.equal(dangling.registry.defaultId, 'a')
  assert.match(dangling.warnings[0], /不在清单里/)

  // 缺 defaultId 不是问题：取第一条，且不该产生噪音。
  const noDefault = validateRegistry({ version: 1, wikis: [entry('a', ROOT, 'a')] })
  assert.equal(noDefault.registry.defaultId, 'a')
  assert.deepEqual(noDefault.warnings, [])
})

await test('singleEntryRegistry：迁移形态 = 可见 + 自启 + 单库模式（等于升级前的行为）', () => {
  const reg = singleEntryRegistry({ root: ROOT, name: 'notes' })
  assert.equal(reg.version, WIKI_REGISTRY_VERSION)
  // 模式默认必须是 single：升级用户的观感与行为一个字都不该变。
  assert.equal(reg.mode, DEFAULT_WIKI_MODE)
  assert.equal(reg.mode, 'single')
  assert.equal(reg.defaultId, DEFAULT_WIKI_ID)
  assert.equal(reg.wikis.length, 1)
  assert.deepEqual(reg.wikis[0], { id: DEFAULT_WIKI_ID, label: 'notes', root: ROOT, name: 'notes', agentVisible: true, autostart: true })
  assert.equal(entryPath(reg.wikis[0]), join(ROOT, 'notes'))
})

await test('mode：缺省=single、显式 multi 保留、未知值治愈为 single（不致命）', () => {
  assert.deepEqual(WIKI_MODES, ['single', 'multi'], '模式清单就是设置页的单选顺序')
  const base = { version: 1, defaultId: 'a', wikis: [entry('a', ROOT, 'a')] }

  // 缺字段 = 老清单 = 升级用户：必须是 single，而不是抛错、也不许猜 multi。
  const missing = validateRegistry(base)
  assert.equal(missing.fatal.length, 0)
  assert.equal(missing.registry.mode, 'single')
  assert.deepEqual(missing.warnings, [])

  const multi = validateRegistry({ ...base, mode: 'multi' })
  assert.equal(multi.registry.mode, 'multi')
  assert.deepEqual(multi.warnings, [])

  // 打错一个字不该让整座农场"什么都不跑"，也不该静默按 multi 跑起来。
  const typo = validateRegistry({ ...base, mode: 'Multi' })
  assert.equal(typo.fatal.length, 0)
  assert.equal(typo.registry.mode, 'single')
  assert.match(typo.warnings[0], /未知的 mode/)
})

await test('mode：增删条目不得改变模式（模式是插件级开关，不是条目属性）', () => {
  const multi = singleEntryRegistry({ root: ROOT, name: 'main' }, DEFAULT_WIKI_ID, 'multi')
  const added = upsertWiki(multi, { id: 'books', label: '书籍', root: ROOT, name: 'books', agentVisible: false, autostart: false })
  assert.equal(added.mode, 'multi')
  assert.equal(removeWiki(added, 'main').registry.mode, 'multi')
})

await test('保留 id：与 TW 根路径撞名的 id 必须被拒绝（否则 /tw/status 无法区分）', () => {
  // id 是同源代理的一个路径段（/dsh-tiddlywiki/tw/<id>/…），而 TW 子进程在自己的
  // 根上就有 /status、/files、/recipes…… 同名时请求无法区分"默认库的 TW 路径"与
  // "名为 status 的库"。所以保留而不是"小心处理"。
  for (const reserved of ['status', 'files', 'recipes', 'render', 'index.html']) {
    assert.match(normalizeEntry(entry(reserved, ROOT, 'x')).error ?? '', /保留/, `${reserved} 必须被拒绝`)
  }
  // 派生也要绕开：目录叫 status 时不能派生出保留 id。
  assert.notEqual(deriveWikiId('status'), 'status')
  assert.equal(RESERVED_WIKI_IDS.includes(deriveWikiId('status')), false)
  // 只是前缀相同不算撞名。
  assert.equal(normalizeEntry(entry('status-page', ROOT, 'x')).error, undefined)
})

await test('applyWikiAction：add 可派生 id、拒绝重复 id / 保留 id / 嵌套目录', () => {
  const base = singleEntryRegistry({ root: ROOT, name: 'main' })
  const added = applyWikiAction(base, { action: 'add', wiki: entry('books', ROOT, 'books') })
  assert.equal(added.registry.wikis.length, 2)
  assert.equal(added.registry.defaultId, 'main', '加一个库不得改变默认库')

  // 不带 id 时从 label/目录名派生 —— 设置页才能只填"这个文件夹"。
  const derived = applyWikiAction(base, { action: 'add', wiki: { label: '书籍', root: ROOT, name: 'books2', agentVisible: false, autostart: false } })
  assert.equal(derived.registry.wikis.length, 2)
  assert.equal(derived.registry.wikis[1].agentVisible, false)

  assert.match(applyWikiAction(base, { action: 'add', wiki: entry('main', ROOT, 'other') }).error, /已存在/)
  assert.match(applyWikiAction(base, { action: 'add', wiki: entry('files', ROOT, 'f') }).error, /保留/)
  // 嵌套：把新库放进已有库的目录里 —— 这正是 registry 存在的理由。
  const nested = applyWikiAction(base, { action: 'add', wiki: { id: 'inner', root: entryPath(base.wikis[0]), name: 'inner' } })
  assert.match(nested.error ?? '', /内部/)
  // 同目录也不行。
  assert.match(applyWikiAction(base, { action: 'add', wiki: entry('twin', ROOT, 'main') }).error, /同一个目录/)
})

await test('applyWikiAction：update 必须已存在且带 id；挪目录撞到邻居同样被拒', () => {
  const base = applyWikiAction(singleEntryRegistry({ root: ROOT, name: 'main' }), { action: 'add', wiki: entry('books', ROOT, 'books') }).registry
  const renamed = applyWikiAction(base, { action: 'update', wiki: { id: 'books', label: '语料', root: ROOT, name: 'books', agentVisible: false } })
  assert.equal(findEntry(renamed.registry, 'books').label, '语料')
  assert.equal(findEntry(renamed.registry, 'books').agentVisible, false)
  assert.match(applyWikiAction(base, { action: 'update', wiki: entry('nope', ROOT, 'x') }).error, /不在清单里/)
  assert.match(applyWikiAction(base, { action: 'update', wiki: { label: 'x', root: ROOT, name: 'x' } }).error, /必须带一个合法的 id/)
  // 把 books 挪进 main 的目录里 → 嵌套，必须拒绝（"改个路径"最容易撞这条）。
  assert.match(applyWikiAction(base, { action: 'update', wiki: { id: 'books', root: entryPath(base.wikis[0]), name: 'books' } }).error ?? '', /内部/)
})

await test('applyWikiAction：remove 不许清空；set-default 必须指向存在的库', () => {
  const two = applyWikiAction(singleEntryRegistry({ root: ROOT, name: 'main' }), { action: 'add', wiki: entry('books', ROOT, 'books') }).registry
  const removed = applyWikiAction(two, { action: 'remove', id: 'books' })
  assert.equal(removed.registry.wikis.length, 1)
  assert.match(applyWikiAction(removed.registry, { action: 'remove', id: 'main' }).error, /至少要保留一个/)
  assert.match(applyWikiAction(two, { action: 'remove', id: 'nope' }).error, /不在清单里/)

  assert.equal(applyWikiAction(two, { action: 'set-default', id: 'books' }).registry.defaultId, 'books')
  // 悬空的 default 会被 validateRegistry"治愈"，所以这里必须显式拒绝（说一套做一套最坑）。
  assert.match(applyWikiAction(two, { action: 'set-default', id: 'gone' }).error, /无法设为默认/)
})

await test('applyWikiAction：set-mode 只认 single/multi；未知动作要说清可用动作', () => {
  const base = singleEntryRegistry({ root: ROOT, name: 'main' })
  assert.equal(applyWikiAction(base, { action: 'set-mode', mode: 'multi' }).registry.mode, 'multi')
  assert.match(applyWikiAction(base, { action: 'set-mode', mode: 'Multi' }).error, /single 或 multi/)
  assert.match(applyWikiAction(base, { action: 'destroy' }).error, /未知动作/)
  assert.match(applyWikiAction(base, { action: 'add' }).error, /wiki 字段/)
  assert.match(applyWikiAction(base, 'nope').error, /带 action 字段/)
})

await test('findEntry/defaultEntry/upsertWiki/removeWiki', () => {
  const base = singleEntryRegistry({ root: ROOT, name: 'main' })
  assert.equal(findEntry(base, 'MAIN').id, 'main', '查找要大小写不敏感（id 已小写化）')
  assert.equal(findEntry(base, 'nope'), undefined)
  assert.equal(defaultEntry(base).id, 'main')

  const added = upsertWiki(base, { id: 'books', label: '书籍', root: ROOT, name: 'books', agentVisible: false, autostart: false })
  assert.equal(added.wikis.length, 2)
  assert.equal(findEntry(added, 'books').label, '书籍')
  assert.equal(added.defaultId, 'main')

  // 同 id 覆盖而不是追加。
  const renamed = upsertWiki(added, { id: 'books', label: '语料', root: ROOT, name: 'books', agentVisible: true, autostart: true })
  assert.equal(renamed.wikis.length, 2)
  assert.equal(findEntry(renamed, 'books').label, '语料')

  // 删掉默认库必须把 defaultId 指到还活着的那个。
  const removed = removeWiki(renamed, 'main')
  assert.equal(removed.registry.wikis.length, 1)
  assert.equal(removed.registry.defaultId, 'books')
  // 最后一个不许删。
  assert.match(removeWiki(removed.registry, 'books').error, /至少/)
  assert.match(removeWiki(base, 'nope').error, /不在清单里/)
})

await test('readRegistry：清单合法 → source=file，无噪音，且 mode 原样往返', async () => {
  const file = join(scratch, 'ok', 'wikis.json')
  const registry = { ...upsertWiki(singleEntryRegistry({ root: ROOT, name: 'main' }), { id: 'books', label: '书籍', root: ROOT, name: 'books', agentVisible: false, autostart: false }), mode: 'multi' }
  await writeRegistry(registry, file)
  const read = await readRegistry({ file, legacyFile: join(scratch, 'ok', 'absent-location.json'), fallback: { root: ROOT, name: 'main' } })
  assert.equal(read.source, 'file')
  assert.equal(read.error, undefined)
  assert.deepEqual(read.warnings, [])
  assert.equal(read.registry.wikis.length, 2)
  assert.equal(read.registry.mode, 'multi', 'multi 必须能从磁盘原样读回（否则一重启就退回单库）')
})

await test('readRegistry：没有清单但有旧指针 → legacy（迁移是正常路径，不是错误）', async () => {
  const dir = join(scratch, 'legacy')
  const legacyFile = join(dir, 'location.json')
  await mkdir(dir, { recursive: true })
  await writeFile(legacyFile, JSON.stringify({ version: 1, active: { root: ROOT, name: 'old-main' } }), 'utf8')
  const read = await readRegistry({ file: join(dir, 'wikis.json'), legacyFile, fallback: { root: ROOT, name: 'never' } })
  assert.equal(read.source, 'legacy')
  assert.equal(read.error, undefined, '迁移不该弹红字')
  assert.deepEqual(read.registry.wikis.map((w) => w.name), ['old-main'])
  assert.equal(read.registry.wikis[0].autostart, true)
})

await test('readRegistry：全新安装（两者都没有）→ default，且绝不报错', async () => {
  const dir = join(scratch, 'fresh')
  const read = await readRegistry({ file: join(dir, 'wikis.json'), legacyFile: join(dir, 'location.json'), fallback: { root: FALLBACK, name: 'main' } })
  assert.equal(read.source, 'default')
  assert.equal(read.error, undefined)
  assert.equal(entryPath(read.registry.wikis[0]), join(FALLBACK, 'main'))
})

await test('readRegistry：坏 JSON / 致命的清单 → 回退 + 说明原因（绝不静默乱跑）', async () => {
  const dir = join(scratch, 'broken')
  const file = join(dir, 'wikis.json')
  await mkdir(dir, { recursive: true })
  await writeFile(file, '{ this is not json', 'utf8')
  const bad = await readRegistry({ file, legacyFile: join(dir, 'location.json'), fallback: { root: FALLBACK, name: 'main' } })
  assert.equal(bad.source, 'default')
  assert.match(bad.error, /不是合法 JSON/)

  // 致命语义也走同一条回退路径，且错误文本要带上真正的原因。
  await writeFile(file, JSON.stringify({ version: 1, defaultId: 'outer', wikis: [entry('outer', ROOT, '.'), entry('inner', ROOT, 'inner')] }), 'utf8')
  const nested = await readRegistry({ file, legacyFile: join(dir, 'location.json'), fallback: { root: FALLBACK, name: 'main' } })
  assert.equal(nested.source, 'default')
  assert.match(nested.error, /位于/)
  assert.equal(nested.registry.wikis.length, 1, '回退到一个干净的单库，而不是半坏的清单')

  // 有旧指针时，回退优先落到旧指针（升级用户的真实位置优先于 cordis 默认）。
  await writeFile(join(dir, 'location.json'), JSON.stringify({ version: 1, active: { root: ROOT, name: 'real' } }), 'utf8')
  const fellBack = await readRegistry({ file, legacyFile: join(dir, 'location.json'), fallback: { root: FALLBACK, name: 'main' } })
  assert.equal(fellBack.source, 'legacy')
  assert.equal(fellBack.registry.wikis[0].name, 'real')
})

await test('readRegistry：只有警告的清单仍可用，但警告要传出去', async () => {
  const dir = join(scratch, 'warn')
  const file = join(dir, 'wikis.json')
  await mkdir(dir, { recursive: true })
  await writeFile(file, JSON.stringify({ version: 1, defaultId: 'gone', wikis: [entry('a', ROOT, 'a'), { id: 'BAD ID', root: 'rel' }] }), 'utf8')
  const read = await readRegistry({ file, legacyFile: join(dir, 'location.json'), fallback: { root: FALLBACK, name: 'main' } })
  assert.equal(read.source, 'file', '能用的清单不该被回退')
  assert.equal(read.registry.wikis.length, 1)
  assert.equal(read.registry.defaultId, 'a')
  assert.equal(read.warnings.length, 2)
  assert.match(read.error, /跳过第 2 个条目/)
})

await test('writeRegistry：原子写、往返一致、不留 .tmp', async () => {
  const dir = join(scratch, 'write')
  const file = join(dir, 'nested', 'wikis.json')
  const registry = singleEntryRegistry({ root: ROOT, name: 'main' })
  await writeRegistry(registry, file)
  assert.ok(existsSync(file), '写入必须自动建目录')
  assert.ok(!existsSync(`${file}.tmp`), '临时文件必须被 rename 掉，不能留在 wiki 目录里被 git 提交')
  const parsed = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(parsed.version, WIKI_REGISTRY_VERSION)
  assert.deepEqual(parsed.wikis, registry.wikis)
  assert.ok(typeof parsed.updatedAt === 'string', '写入要带 updatedAt，便于人排查')
  // 写出去的东西必须能原样读回来（round trip 是清单格式的真契约）。
  const read = await readRegistry({ file, legacyFile: join(dir, 'location.json'), fallback: { root: FALLBACK, name: 'main' } })
  assert.equal(read.source, 'file')
  assert.deepEqual(read.registry.wikis, registry.wikis)
})

await rm(scratch, { recursive: true, force: true })

console.log(failures === 0 ? '\nWIKI REGISTRY CHECKS OK' : `\nWIKI REGISTRY CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

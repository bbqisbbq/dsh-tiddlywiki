#!/usr/bin/env node
// v0.30.62 — guard the trashbin enumeration probe: SHAPE *and* BEHAVIOUR.
//
// `listTrashbin()` renders a `<$list>` through the TW /render route and parses
// the HTML fragment. Four separate defects have now made it lie instead of fail,
// and every one of them is invisible to the eye:
//
//   1. `variable="ignore"` — that name RESERVES `currentTiddler`, so every
//      `<$view>`/`<$text>` in the loop bound to nothing: 126 separators, ZERO
//      titles (v0.30.59, measured).
//   2. splitting on a newline — the fragment is HTML, so the whole list arrived
//      as one line that failed the `$:/trashbin/` prefix test (v0.30.60).
//   3. TW wraps the FIRST element in `<p>…</p>`, so a bare `startsWith` dropped
//      exactly one entry: `list` said 125 for a 126-item trash (v0.30.61).
//   4. the `|` separator: TW escapes `& < > "` inside a title but NOT `|`, so a
//      copy titled `a|b` came out as `a` — listed wrong and un-restorable
//      (v0.30.62; `parseTrashbinFragment` + our own `<li>` markup fix it).
//
// The parser is a PURE function, so most of these are real behaviour tests
// rather than source-text greps. Run under tsx:
//
//   npx tsx scripts/verify-trashbin-probe.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  TRASHBIN_AT_FIELD,
  TRASHBIN_ITEM_TAG,
  TRASHBIN_PREFIX,
  TRASH_INDEX_TITLE,
  TRASH_PREFIX,
  listTrashbin,
  parseTrashbinFragment,
  trashbinProbeWikitext,
} from '../src/host/tools-support.ts'
import { registerTiddlywikiTools } from '../src/host/tools.ts'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'src', 'host', 'tools-support.ts'), 'utf8')

let failures = 0
let checks = 0
async function test(name, fn) {
  try {
    checks++
    await fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures++
    console.error(`FAIL  ${name}\n      ${err && err.message ? err.message : err}`)
  }
}

const probe = trashbinProbeWikitext()

// ── the probe template must NOT reserve currentTiddler ─────────────────────
await test('探针不得用 variable=（variable="ignore" 会占用 currentTiddler，循环体渲染出空）', () => {
  assert.ok(!probe.includes('variable='), `探针带了 variable=：${probe}`)
})

await test('探针必须输出 currentTiddler（列表项的标题本身）', () => {
  assert.ok(probe.includes('<<currentTiddler>>'), `探针没有输出标题：${probe}`)
})

// ── the delimiter must be OUR markup, not a character a title can contain ──
await test('分隔符是自有标记而不是裸 `|`（TW 不转义 `|`，含 `|` 的标题会被截断）', () => {
  assert.ok(probe.includes(`${TRASHBIN_ITEM_TAG}<$text`), `条目没有被 ${TRASHBIN_ITEM_TAG} 包起来：${probe}`)
  assert.ok(!probe.includes('/>|'), `探针仍用裸 | 当分隔符：${probe}`)
})

// ── behaviour: a `<p>`-wrapped first item, a `|` in a title, escaping ──────
await test('解析：<p> 包裹的首条、含 `|` 的标题都要原样取出（v0.30.61/62）', () => {
  const html = `<p>${TRASHBIN_ITEM_TAG}${TRASHBIN_PREFIX}a|b</li>${TRASHBIN_ITEM_TAG}${TRASHBIN_PREFIX}plain</li></p>`
  assert.deepEqual(parseTrashbinFragment(html), [`${TRASHBIN_PREFIX}a|b`, `${TRASHBIN_PREFIX}plain`])
})

await test('解析：标题里的 `& < > "` 被 TW 转义过，必须还原成真标题', () => {
  // TW's htmlEncode escapes & < > " — and ONLY those (verified live:
  // `<$text text="a|b<c>d&amp;e"/>` renders `a|b&lt;c&gt;d&amp;amp;e`).
  const html = `<p>${TRASHBIN_ITEM_TAG}${TRASHBIN_PREFIX}a&lt;li&gt;b&amp;c&quot;d</li></p>`
  assert.deepEqual(parseTrashbinFragment(html), [`${TRASHBIN_PREFIX}a<li>b&c"d`])
  // …and a title holding the literal text `&lt;` round-trips (the `&` is encoded
  // first, so decoding `&amp;` LAST is what keeps it lossless).
  const literal = `<p>${TRASHBIN_ITEM_TAG}${TRASHBIN_PREFIX}x&amp;lt;y</li></p>`
  assert.deepEqual(parseTrashbinFragment(literal), [`${TRASHBIN_PREFIX}x&lt;y`])
})

await test('解析：空片段 / 没有条目 / 只有包装标记 ⇒ 空数组（不是抛错）', () => {
  assert.deepEqual(parseTrashbinFragment(''), [])
  assert.deepEqual(parseTrashbinFragment('<p></p>'), [])
  assert.deepEqual(parseTrashbinFragment(`<p>${TRASHBIN_ITEM_TAG}</li></p>`), [])
  // 非 trashbin 前缀的条目（万一 filter 变了）不得混进来
  assert.deepEqual(parseTrashbinFragment(`<p>${TRASHBIN_ITEM_TAG}other</li></p>`), [])
})

// ── behaviour: listTrashbin end to end, with a fake wiki ──────────────────
const fakeWiki = (fields) => ({ get: async (title) => fields[title] })

await test('listTrashbin：渲染出条目却没有标题 ⇒ 必须抛错（不得谎报「回收站是空的」）', async () => {
  await assert.rejects(
    () => listTrashbin(fakeWiki({}), async () => `<p>${TRASHBIN_ITEM_TAG}</li></p>`),
    /渲染结果异常/,
  )
})

await test('listTrashbin：读 trash-of / trash-iso，旧数据回落 trash-at，再回落 modified', async () => {
  const html = `<p>${TRASHBIN_ITEM_TAG}${TRASHBIN_PREFIX}a</li>${TRASHBIN_ITEM_TAG}${TRASHBIN_PREFIX}b</li>${TRASHBIN_ITEM_TAG}${TRASHBIN_PREFIX}c</li></p>`
  const wiki = fakeWiki({
    [`${TRASHBIN_PREFIX}a`]: { fields: { 'trash-of': '原标题', [TRASHBIN_AT_FIELD]: '2026-01-02T03:04:05Z' } },
    [`${TRASHBIN_PREFIX}b`]: { fields: { 'trash-at': '10/09/2026 05:11:54' } },
    [`${TRASHBIN_PREFIX}c`]: { modified: '20260101000000000' },
  })
  assert.deepEqual(await listTrashbin(wiki, async () => html), [
    { trash: `${TRASHBIN_PREFIX}a`, of: '原标题', at: '2026-01-02T03:04:05Z' },
    { trash: `${TRASHBIN_PREFIX}b`, of: 'b', at: '10/09/2026 05:11:54' },
    { trash: `${TRASHBIN_PREFIX}c`, of: 'c', at: '20260101000000000' },
  ])
})

await test('listTrashbin：条目多于并发批大小(8) 时顺序不乱、一条不少', async () => {
  const titles = Array.from({ length: 19 }, (_, i) => `${TRASHBIN_PREFIX}n${i}`)
  const html = `<p>${titles.map((t) => `${TRASHBIN_ITEM_TAG}${t}</li>`).join('')}</p>`
  const wiki = { get: async (title) => ({ fields: { 'trash-of': title } }) }
  const entries = await listTrashbin(wiki, async () => html)
  assert.equal(entries.length, 19)
  assert.deepEqual(entries.map((e) => e.trash), titles)
})

await test('listTrashbin：渲染路由不可用（抛错 / 非字符串）⇒ undefined（回落内置索引）', async () => {
  assert.equal(await listTrashbin(fakeWiki({}), async () => { throw new Error('render down') }), undefined)
  assert.equal(await listTrashbin(fakeWiki({}), async () => undefined), undefined)
})

// ── shape: the field names + bounded concurrency stay as designed ─────────
await test('溯源时间字段不叫 trash-at（TW 会把 *-at 当日期改写成本地格式，ISO 值会丢）', () => {
  assert.ok(src.includes("TRASHBIN_AT_FIELD = 'trash-iso'"))
  // 旧名字保留成具名常量：列的时候要读它，恢复的时候要删它（散写字面量就会漏一处）。
  assert.ok(src.includes("TRASHBIN_LEGACY_AT_FIELD = 'trash-at'"))
})

await test('逐条读取必须有界并发（125 条串行 REST 是 125 次往返）', () => {
  assert.ok(src.includes('CONCURRENCY') && src.includes('Promise.all'))
})

// ── behaviour: the two trash FORMATS are merged (v0.30.62) ────────────────
/**
 * Drive the real `tiddlywiki_trash` tool against an in-memory wiki.
 *
 * This is the regression that was live on the work wiki: with trashbin installed
 * and its bin empty, `listTrashbin()` returned `[]`, that was treated as「索引不
 * 用读」and every LEGACY entry became invisible (`list` answered 共 0 条 while the
 * index still held one). The tool's contract is「两种回收站格式都认」.
 */
const trashToolFrom = (client) => {
  const tools = []
  registerTiddlywikiTools(
    { tools: { register: (tool) => { tools.push(tool); return () => {} } } },
    { scope: () => ({ client, ambiguous: false }), git: {}, autoCommit: () => {} },
  )
  const tool = tools.find((t) => t.name === 'tiddlywiki_trash')
  assert.ok(tool !== undefined, 'tiddlywiki_trash 没有被注册')
  return tool
}

const LEGACY = { trash: `${TRASH_PREFIX}2026-01-01/legacy`, of: 'legacy note', at: '2026-01-01T00:00:00Z' }

function wikiHarness(files) {
  const store = new Map(Object.entries(files))
  return {
    store,
    client: {
      render: async () => `<p>${TRASHBIN_ITEM_TAG}${TRASHBIN_PREFIX}copy-a</li></p>`,
      get: async (title) => store.get(title),
      put: async (t) => { store.set(t.title, t) },
      delete: async (title) => { store.delete(title) },
    },
  }
}

await test('list：装了 trashbin 的库必须同时列出**内置索引**里的条目（旧代码整段藏起来）', async () => {
  const { store, client } = wikiHarness({
    [TRASH_INDEX_TITLE]: { text: JSON.stringify([LEGACY]) },
    [`${TRASHBIN_PREFIX}copy-a`]: { fields: { 'trash-of': 'copy note' } },
  })
  const result = await trashToolFrom(client).execute({ action: 'list' }, {})
  assert.equal(result.items.length, 2, `两种格式都要列出（实际 ${JSON.stringify(result.items)}）`)
  assert.match(result.message, /共 2 条/)
  assert.ok(store.get(TRASH_INDEX_TITLE) !== undefined, 'list 必须是只读的')
})

await test('restore：从内置索引恢复的条目要把该条从索引里摘掉（fromIndex 记账）', async () => {
  const { store, client } = wikiHarness({
    [TRASH_INDEX_TITLE]: { text: JSON.stringify([LEGACY]) },
    [LEGACY.trash]: { text: 'legacy body', fields: { 'trash-of': LEGACY.of } },
    [`${TRASHBIN_PREFIX}copy-a`]: { fields: { 'trash-of': 'copy note' } },
  })
  const result = await trashToolFrom(client).execute({ action: 'restore', title: LEGACY.of }, {})
  assert.equal(result.action, 'restore')
  assert.match(result.message, /已恢复/, `回执要说清恢复了什么：${result.message}`)
  assert.equal(store.get(LEGACY.of)?.text, 'legacy body', '恢复的笔记要写回原标题、带回正文')
  assert.equal(JSON.parse(store.get(TRASH_INDEX_TITLE).text).length, 0, '索引里那条必须被摘掉')
})

await test('restore：旧副本的 `trash-at` 不得留在恢复后的笔记上（v0.30.62 的残留字段）', async () => {
  const copyTitle = `${TRASHBIN_PREFIX}legacy-copy`
  const { store, client } = wikiHarness({
    [copyTitle]: { text: 'body', fields: { 'trash-of': 'note x', 'trash-at': '10/09/2026 05:11:54' } },
  })
  client.render = async () => `<p>${TRASHBIN_ITEM_TAG}${copyTitle}</li></p>`
  const result = await trashToolFrom(client).execute({ action: 'restore', title: 'note x' }, {})
  assert.match(result.message, /已恢复/)
  const restored = store.get('note x')
  assert.ok(restored !== undefined, '笔记必须回到原标题')
  for (const key of ['trash-of', 'trash-iso', 'trash-at']) {
    assert.equal(restored[key], undefined, `恢复出来的笔记不得带 ${key}（那是副本的溯源字段，不是笔记的）`)
  }
})

console.log(failures === 0 ? `\nTRASHBIN PROBE CHECKS OK（${checks} 条）` : `\nTRASHBIN PROBE CHECKS FAILED（${failures}/${checks} 条）`)
process.exit(failures === 0 ? 0 : 1)

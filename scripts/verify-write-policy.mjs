#!/usr/bin/env node
/**
 * 写策略纯函数守门（v0.20.1）——不 spawn TW、不写文件，秒级：
 *
 * 断「覆盖既有条目时保留内容类型」这条铁律的核心：
 *   - `buildWriteTiddler(existing)` 必须原样保留既有条目的 `type`（CSS/JS/wikitext
 *     不会被改成 Markdown），并保留 tags 与自定义字段；
 *   - Markdown 默认值**只给新建条目**（`$:/` 系统条目除外）；
 *   - `fields.type` 是唯一的显式改类型入口。
 *
 * v0.22.10 追加「时间戳」一节：TW 的服务端写路径**不补** `created`/`modified`，
 * 缺 `modified` 的条目会被 `sortTiddlers` 的 `fields[sortField] || ""` 当空串，
 * `!sort[modified]` 降序时沉到最后一名（用户实测：新日记在「主题页·日志」排
 * 175/175，看起来像没被收录）。这组断言同时钉住「TW 紧凑格式」与
 * 「覆盖保 created、刷新 modified」两条语义。
 *
 * 背景（v0.20.1 修复）：`cleanTiddler()` 曾把 `type` 列为「构造 PUT body 时跳过的
 * 字段」，于是覆盖路径丢掉原类型、再被默认值顶上；`tiddlywiki_append` 更彻底，
 * 手写 PUT body 导致 TW 把条目回落成 `text/vnd.tiddlywiki`（磁盘上 `.md + .meta`
 * 变 `.tid`，Markdown 全按 wikitext 解析）。E2E 回归在 verify-audit-fixes.mjs。
 *
 *   node scripts/verify-write-policy.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-write-policy
 */
import assert from 'node:assert/strict'
import {
  assertNoConflict,
  buildWriteTiddler,
  cleanTiddler,
  DEFAULT_NOTE_TYPE,
  ensureTiddlerTimestamps,
  formatTiddlerDate,
  parseTiddlerDate,
} from '../lib/index.js'

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

/** TW 紧凑格式（17 位 UTC），与 $tw.utils.stringifyDate 一致。 */
const COMPACT = /^\d{17}$/

const css = { title: 'MyStyles.css', text: '.a{}', type: 'text/css', tags: ['$:/tags/Stylesheet'], fields: { q: 'keep-me' } }

test('cleanTiddler 保留 type（不再作为跳过字段）', () => {
  const out = cleanTiddler(css)
  assert.equal(out.type, 'text/css', `cleanTiddler 丢掉了 type：${JSON.stringify(out.type)}`)
  assert.deepEqual(out.tags, ['$:/tags/Stylesheet'])
  assert.equal(out.q, 'keep-me', '嵌套 fields 里的自定义字段必须摊平')
})

test('buildWriteTiddler：覆盖既有 text/css 条目仍写 text/css', () => {
  const { tiddler, typeDefaulted } = buildWriteTiddler('MyStyles.css', '.b{}', { existing: css })
  assert.equal(tiddler.type, 'text/css', `覆盖后类型必须保持 text/css，实际 ${tiddler.type}`)
  assert.equal(typeDefaulted, false, '覆盖既有条目不产生默认类型')
  assert.deepEqual(tiddler.tags, ['$:/tags/Stylesheet'], '不传 tags 时保留原 tags')
  assert.equal(tiddler.q, 'keep-me', '不传 fields 时保留原自定义字段')
})

test('buildWriteTiddler：覆盖既有 wikitext 笔记仍写 wikitext', () => {
  const existing = { title: 'WikiNote', text: 'old', type: 'text/vnd.tiddlywiki', tags: [] }
  const { tiddler } = buildWriteTiddler('WikiNote', 'new', { existing })
  assert.equal(tiddler.type, 'text/vnd.tiddlywiki', `wikitext 笔记不得被默认成 markdown，实际 ${tiddler.type}`)
})

test('buildWriteTiddler：新建条目才默认 Markdown 并补 agent-written', () => {
  const { tiddler, typeDefaulted } = buildWriteTiddler('FreshNote', 'body')
  assert.equal(tiddler.type, DEFAULT_NOTE_TYPE, `新建应默认 markdown，实际 ${tiddler.type}`)
  assert.equal(typeDefaulted, true, '新建应标记 typeDefaulted')
  assert.deepEqual(tiddler.tags, ['agent-written'], `新建应补 agent-written：${JSON.stringify(tiddler.tags)}`)
})

test('buildWriteTiddler：$:/ 系统条目不默认 Markdown、不带 agent 标签', () => {
  const { tiddler, typeDefaulted } = buildWriteTiddler('$:/temp/x', 'body')
  assert.equal(tiddler.type, undefined, `$:/ 条目不应被补 type：${tiddler.type}`)
  assert.equal(typeDefaulted, false)
  assert.equal(tiddler.tags, undefined, `$:/ 条目不应补 agent-written：${JSON.stringify(tiddler.tags)}`)
})

test('buildWriteTiddler：fields.type 是显式改类型的正规入口', () => {
  const { tiddler } = buildWriteTiddler('Switched', 'body', { existing: css, fields: { type: 'text/markdown' } })
  assert.equal(tiddler.type, 'text/markdown', `fields.type 必须能改类型，实际 ${tiddler.type}`)
  assert.equal(tiddler.q, 'keep-me', '显式 fields 不应抹掉其它自定义字段')
})

test('buildWriteTiddler：human 路径（agentTag:false）新建不补 agent-written', () => {
  const { tiddler } = buildWriteTiddler('HumanNote', 'body', { agentTag: false, defaultTags: ['inbox'] })
  assert.deepEqual(tiddler.tags, ['inbox'], `人类路径不该出现 agent-written：${JSON.stringify(tiddler.tags)}`)
  assert.equal(tiddler.type, DEFAULT_NOTE_TYPE)
})

// ── 时间戳（v0.22.10）────────────────────────────────────────────────────────
// 旧实现把 created/modified 放进 CLEAN_SKIP_FIELDS 并假设「服务端会补」，
// 但 TW 的服务端 PUT 路由只 addTiddler，从不补这两个字段。

test('formatTiddlerDate：输出 TW 的 17 位紧凑 UTC 格式且可往返', () => {
  const at = Date.UTC(2026, 8, 16, 15, 20, 42, 0)
  const s = formatTiddlerDate(at)
  assert.match(s, COMPACT, `必须是 17 位紧凑格式，实际 ${JSON.stringify(s)}`)
  assert.equal(s, '20260916152042000', `与 $tw.utils.stringifyDate 一致，实际 ${s}`)
  assert.equal(parseTiddlerDate(s), at, 'formatTiddlerDate ↔ parseTiddlerDate 必须往返一致')
  // 补零边界：单数字月/日/时/分/秒与毫秒都要补齐。
  assert.equal(formatTiddlerDate(Date.UTC(2026, 0, 2, 3, 4, 5, 6)), '20260102030405006', '各位数必须补零')
})

test('buildWriteTiddler：新建条目写入 created = modified = 当前时刻', () => {
  const now = Date.UTC(2026, 8, 16, 23, 30, 37, 0)
  const { tiddler } = buildWriteTiddler('FreshStamped', 'body', { now })
  assert.match(String(tiddler.created), COMPACT, `新建必须写 created，实际 ${JSON.stringify(tiddler.created)}`)
  assert.equal(tiddler.created, '20260916233037000', `created 应为注入时刻，实际 ${tiddler.created}`)
  assert.equal(tiddler.modified, tiddler.created, '新建时 modified 必须等于 created')
  assert.ok(parseTiddlerDate(tiddler.modified) !== undefined, 'TW 必须能解析这个值（否则页面看不了日期）')
})

test('buildWriteTiddler：覆盖既有条目保留原 created、刷新 modified', () => {
  const existing = { title: 'KeepTimes', text: 'old', created: '20250101000000000', modified: '20250101000000000' }
  const now = Date.UTC(2026, 8, 16, 23, 30, 37, 123)
  const { tiddler } = buildWriteTiddler('KeepTimes', 'new', { existing, now })
  assert.equal(tiddler.created, '20250101000000000', `覆盖必须保留原 created，实际 ${tiddler.created}`)
  assert.equal(tiddler.modified, '20260916233037123', `覆盖必须刷新 modified，实际 ${tiddler.modified}`)
  assert.notEqual(tiddler.created, tiddler.modified, 'created 与 modified 不得被一起冲掉')
})

test('buildWriteTiddler：覆盖缺 created 的存量条目时补上 created', () => {
  // 迁移来的存量条目没有 created——覆盖后不得留空（否则新页面还是缺字段）。
  const existing = { title: 'LegacyNoTimes', text: 'legacy' }
  const now = Date.UTC(2026, 8, 16, 23, 30, 37, 0)
  const { tiddler } = buildWriteTiddler('LegacyNoTimes', 'updated', { existing, now })
  assert.match(String(tiddler.created), COMPACT, `缺 created 时必须补，实际 ${JSON.stringify(tiddler.created)}`)
  assert.equal(tiddler.created, '20260916233037000')
  assert.equal(tiddler.modified, tiddler.created)
})

test('buildWriteTiddler：$:/ 系统条目同样补时间戳', () => {
  // 系统条目也会出现在按 modified 排序的列表里（回收站索引、flush 哨兵…），
  // 且「缺字段就沉底」的规则一视同仁；补上不改变 TW 的语义。
  const now = Date.UTC(2026, 8, 16, 23, 30, 37, 0)
  const { tiddler } = buildWriteTiddler('$:/temp/stamp-probe', 'x', { now })
  assert.equal(tiddler.created, '20260916233037000', '$:/ 条目也应补 created')
  assert.equal(tiddler.modified, '20260916233037000', '$:/ 条目也应补 modified')
})

test('buildWriteTiddler：fields.created/modified 仍不得覆盖时间戳', () => {
  const now = Date.UTC(2026, 8, 16, 23, 30, 37, 0)
  const { tiddler } = buildWriteTiddler('FieldStampGuard', 'body', {
    fields: { created: '19990101000000000', modified: '19990101000000000' },
    now,
  })
  assert.equal(tiddler.created, '20260916233037000', 'fields.created 是保留字段，不得覆盖')
  assert.equal(tiddler.modified, '20260916233037000', 'fields.modified 是保留字段，不得覆盖')
})

test('ensureTiddlerTimestamps：只补缺、绝不改写已有值（安全网）', () => {
  const now = Date.UTC(2026, 8, 16, 23, 30, 37, 0)
  const both = { title: 'A', created: '20200101000000000', modified: '20210101000000000' }
  ensureTiddlerTimestamps(both, now)
  assert.equal(both.created, '20200101000000000', '已有 created 不得被改写')
  assert.equal(both.modified, '20210101000000000', '已有 modified 不得被改写')

  const none = { title: 'B' }
  ensureTiddlerTimestamps(none, now)
  assert.equal(none.created, '20260916233037000', '两者都缺时补当前时刻')
  assert.equal(none.modified, '20260916233037000')

  // 只有 modified（迁移常见）：created 跟随它，而不是被改成 now。
  const onlyModified = { title: 'C', modified: '20200101000000000' }
  ensureTiddlerTimestamps(onlyModified, now)
  assert.equal(onlyModified.created, '20200101000000000', 'created 应跟随已有的 modified')
  assert.equal(onlyModified.modified, '20200101000000000')

  // v0.23.5：只有 created 时，modified 必须是 NOW，不能复制 created。
  // 复制会把 modified 永远钉在首次写入时刻——真实受害者是配置 tiddler
  // （ConfigStore.set() 每次保存都只带 created），本机磁盘实测 created===modified。
  const onlyCreated = { title: 'D', created: '20200101000000000' }
  ensureTiddlerTimestamps(onlyCreated, now)
  assert.equal(onlyCreated.created, '20200101000000000', '已有 created 不得被改写')
  assert.equal(onlyCreated.modified, '20260916233037000', 'modified 应补当前时刻，不得钉死成 created')
})

// ── 乐观并发：两个令牌是 AND（v0.23.5） ──────────────────────────────────────
// 旧实现「modified 命中就放行，否则看 revision」，两个真实缺陷：
//   1. revision 是 TW 内存计数器（不持久化，重启回到 1），跨重启的写入会被误判一致；
//   2. 同时传两个令牌并不更安全——modified 不匹配仍会落到 revision 分支继续写。

test('assertNoConflict：expectedModified 不匹配 → 拒绝（即便 revision 相同）', () => {
  const existing = { title: 'X', modified: '20260101000000000', revision: 7 }
  assert.throws(
    () => assertNoConflict('X', existing, { expectedModified: '20250101000000000', expectedRevision: 7 }),
    /写入冲突/,
    '两个令牌都在场时，modified 不匹配必须拒绝（不能靠 revision 放行）',
  )
})

test('assertNoConflict：expectedRevision 不匹配 → 拒绝（即便 modified 相同）', () => {
  const existing = { title: 'X', modified: '20260101000000000', revision: 7 }
  assert.throws(
    () => assertNoConflict('X', existing, { expectedModified: '20260101000000000', expectedRevision: 1 }),
    /写入冲突/,
    '两个令牌都在场时，revision 不匹配必须拒绝',
  )
})

test('assertNoConflict：两个令牌都匹配 → 放行', () => {
  const existing = { title: 'X', modified: '20260101000000000', revision: 7 }
  assert.doesNotThrow(() => assertNoConflict('X', existing, { expectedModified: '20260101000000000', expectedRevision: 7 }))
})

test('assertNoConflict：单令牌语义不变（只给哪个就只校验哪个）', () => {
  const existing = { title: 'X', modified: '20260101000000000', revision: 7 }
  assert.doesNotThrow(() => assertNoConflict('X', existing, { expectedModified: '20260101000000000' }))
  assert.doesNotThrow(() => assertNoConflict('X', existing, { expectedRevision: 7 }))
  assert.throws(() => assertNoConflict('X', existing, { expectedModified: '20250101000000000' }), /写入冲突/)
  assert.throws(() => assertNoConflict('X', existing, { expectedRevision: 3 }), /写入冲突/)
})

test('assertNoConflict：令牌解析不出的「证据不足」判为冲突（宁可让调用方重读）', () => {
  const existing = { title: 'X', modified: '20260101000000000', revision: 7 }
  assert.throws(
    () => assertNoConflict('X', existing, { expectedModified: 'not-a-date' }),
    /写入冲突/,
    '无法比较时不得放行覆盖',
  )
})

test('assertNoConflict：force / 不存在 / 不给令牌 → 放行', () => {
  const existing = { title: 'X', modified: '20260101000000000', revision: 7 }
  assert.doesNotThrow(() => assertNoConflict('X', existing, { expectedModified: 'x', force: true }))
  assert.doesNotThrow(() => assertNoConflict('X', undefined, { expectedModified: 'x' }))
  assert.doesNotThrow(() => assertNoConflict('X', existing, {}))
})

console.log(failures === 0 ? '\nWRITE POLICY OK' : `\nWRITE POLICY FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

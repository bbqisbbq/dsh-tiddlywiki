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
import { buildWriteTiddler, cleanTiddler, DEFAULT_NOTE_TYPE } from '../lib/index.js'

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

console.log(failures === 0 ? '\nWRITE POLICY OK' : `\nWRITE POLICY FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

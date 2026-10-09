#!/usr/bin/env node
// v0.30.59 — guard the trashbin enumeration probe.
//
// The bug this exists for: `listTrashbin()` renders a `<$list>` through the
// TW /render route and splits the fragment. Two separate defects made it
// answer「回收站是空的」instead of failing, and BOTH are invisible to the eye:
//
//   1. `variable="ignore"` — that name RESERVES `currentTiddler`, so every
//      `<$view>`/`<$text>` in the loop bound to nothing. The fragment came back
//      as 126 separators and ZERO titles. Measured, not guessed.
//   2. splitting on `\n` — the fragment is HTML, where newlines collapse to
//      spaces, so the whole list arrived as one line that then failed the
//      `$:/trashbin/` prefix test.
//
// Either one yields `[]`, and an empty trash is a perfectly normal answer, so
// the tool reported success while lying. These assertions pin the shapes that
// distinguish them: separators WITHOUT titles must be rejected, never listed.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'src', 'host', 'tools-support.ts'), 'utf8')

const failures = []
const ok = []
const check = (name, condition) => (condition ? ok.push(name) : failures.push(name))

// ── the probe template must NOT reserve currentTiddler ─────────────────────
const listLine = src.split('\n').find((line) => line.includes('<$list filter="[tag[') && line.includes('sort[title]'))
check('枚举探针存在（<$list> + sort[title]）', listLine !== undefined)
check('枚举探针不得用 variable="ignore"（那会占用 currentTiddler，循环体内渲染出空）',
  listLine !== undefined && !listLine.includes('variable="ignore"'))
check('枚举探针必须输出 currentTiddler（列表项的标题本身）',
  listLine !== undefined && listLine.includes('<<currentTiddler>>'))

// ── the split must use a delimiter that survives HTML ─────────────────────
check('分隔符用 `|`（HTML 会把换行折成空格，按 \\n 拆会把整个列表当一行）',
  src.includes("html.split('|')"))
check('不得再按换行拆分片段', !src.includes("html.split('\\n')"))

// ── the self-check: separators present but no titles must THROW ───────────
check('有分隔符却零标题时必须显式报错（否则谎报「回收站是空的」）',
  /titles\.length === 0 && html\.includes\('\|'\)/.test(src) &&
  /throw new Error/.test(src.split('titles.length === 0 && html.includes')[1]?.slice(0, 400) ?? ''))

// ── per-item reads must be bounded-concurrency, not serial ────────────────
check('逐条读取必须有界并发（125 条串行 REST 是 125 次往返）',
  src.includes('CONCURRENCY') && src.includes('Promise.all'))

// ── the timestamp field must not be one TW re-formats as a date ───────────
check('溯源时间字段不叫 trash-at（TW 会把 *-at 当日期改写成本地格式，ISO 值会丢）',
  src.includes("TRASHBIN_AT_FIELD = 'trash-iso'"))

for (const name of ok) console.log(`  ok  ${name}`)
for (const name of failures) console.error(`  FAIL  ${name}`)

if (failures.length > 0) {
  console.error(`\nTRASHBIN PROBE CHECKS FAILED（${failures.length} 条）`)
  process.exit(1)
}
console.log(`\nTRASHBIN PROBE CHECKS OK（${ok.length} 条）`)
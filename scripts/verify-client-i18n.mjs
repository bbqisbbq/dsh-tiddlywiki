#!/usr/bin/env node
/**
 * 客户端 i18n 守门（v0.30.6）。
 *
 * 三条规则，各自对应一种真实失效：
 *   1. **目录完整性**：每个分片（`i18n-<area>.ts`）的 `zh` 与 `en` 必须**键集合完全一致**
 *      （少一条 = 某种语言下露出 key 本身或掉进兜底）；
 *   2. **无悬空键**：客户端代码里 `t('a.b')` 用的每个键都必须在目录里存在
 *      （拼错一个字母 = 界面上直接显示 `a.b`）；
 *   3. **用户可见文案必须走 `t()`**：客户端 .ts 里的**字符串字面量**不得含中文，
 *      除非它是 `t(...)` 的第一个参数，或被下面的 ALLOWLIST 明确豁免（每条都写清
 *      为什么：多为与 **host 中文回执**匹配的协议串、`data-*` 值、CSS/标题等）。
 *      注释不算（先剥掉），`styles-css.ts` 整份是 CSS，跳过。
 *
 * 为什么规则 3 重要：没有它，"补齐 i18n" 会永远停在"改了大部分"——下一个新按钮
 * 又会直接写中文，而没有任何东西拦它。ALLOWLIST 必须**只增不减地有理由**：往里加
 * 一条 = 承认这里的中文是协议而不是文案。
 *
 *   node scripts/verify-client-i18n.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-client-i18n
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_DIR = path.join(repoRoot, 'src', 'client')

/** Files that are NOT user-visible text (skip the CJK scan entirely). */
const SKIP_CJK_SCAN = new Set(['styles-css.ts', 'i18n-catalog.ts', 'i18n.ts'])

/**
 * Chinese string literals that are PROTOCOL, not copy — each with the reason.
 * Keep this list as small as possible; every entry is a promise that the string
 * is compared against host output or is a DOM/protocol value, never rendered.
 */
const ALLOWLIST = [
  // ── 与 host 中文回执/字段匹配（解析回执、不能翻译）──────────────────────
  ['tool-views.ts', '工作区'],
  ['tool-views.ts', '缩小范围'],
  // ── TW/协议取值（不是文案）────────────────────────────────────────────
  ['session-summary.ts', '知识库'],
]

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

const clientFiles = fs.readdirSync(CLIENT_DIR).filter((f) => f.endsWith('.ts'))
const chunkFiles = clientFiles.filter((f) => f.startsWith('i18n-') && f !== 'i18n-catalog.ts')

/** Keys of the `zh:` / `en:` object inside one chunk (one entry per line). */
function chunkKeys(source, lang) {
  const start = source.indexOf(`${lang}: {`)
  assert.ok(start >= 0, `分片里找不到 \`${lang}: {\``)
  // The object ends at the first line that is exactly `},` (or `}` at file end).
  const rest = source.slice(start)
  const end = rest.search(/\n\s*\},\s*(\n|$)/)
  const body = end >= 0 ? rest.slice(0, end) : rest
  return [...body.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1])
}

const zhKeys = new Set()
const enKeys = new Set()
const perChunk = []

for (const file of chunkFiles) {
  const source = fs.readFileSync(path.join(CLIENT_DIR, file), 'utf8')
  const zh = chunkKeys(source, 'zh')
  const en = chunkKeys(source, 'en')
  const area = file.replace(/^i18n-/, '').replace(/\.ts$/, '')
  perChunk.push({ file, area, zh, en })
  for (const k of zh) zhKeys.add(k)
  for (const k of en) enKeys.add(k)
}

test('每个分片的 zh / en 键集合完全一致', () => {
  for (const chunk of perChunk) {
    const zh = new Set(chunk.zh)
    const en = new Set(chunk.en)
    const missingEn = [...zh].filter((k) => !en.has(k))
    const missingZh = [...en].filter((k) => !zh.has(k))
    assert.deepEqual(missingEn, [], `${chunk.file}: en 缺 ${missingEn.join(', ')}`)
    assert.deepEqual(missingZh, [], `${chunk.file}: zh 缺 ${missingZh.join(', ')}`)
    assert.equal(new Set(chunk.zh).size, chunk.zh.length, `${chunk.file}: zh 有重复键`)
  }
})

test('全局 zh / en 键集合一致，且键名带各自分片前缀', () => {
  const missingEn = [...zhKeys].filter((k) => !enKeys.has(k))
  const missingZh = [...enKeys].filter((k) => !zhKeys.has(k))
  assert.deepEqual(missingEn, [], `合并后 en 缺 ${missingEn.join(', ')}`)
  assert.deepEqual(missingZh, [], `合并后 zh 缺 ${missingZh.join(', ')}`)
  for (const chunk of perChunk) {
    const bad = chunk.zh.filter((k) => !k.startsWith(`${chunk.area}.`))
    assert.deepEqual(bad, [], `${chunk.file}: 这些键没有 \`${chunk.area}.\` 前缀：${bad.join(', ')}`)
  }
})

test('客户端里每个 t(\'…\') 的键都在目录里（无悬空键）', () => {
  const missing = []
  for (const file of clientFiles) {
    if (file.startsWith('i18n')) continue
    const code = stripComments(fs.readFileSync(path.join(CLIENT_DIR, file), 'utf8'))
    for (const m of code.matchAll(/\bt\(\s*'([^']+)'/g)) {
      if (!zhKeys.has(m[1])) missing.push(`${file}: ${m[1]}`)
    }
  }
  assert.deepEqual(missing, [], `目录里没有这些键：\n      ${missing.join('\n      ')}`)
})

test('目录里没有从未使用的键（死条目）', () => {
  const used = new Set()
  for (const file of clientFiles) {
    if (file.startsWith('i18n')) continue
    const code = stripComments(fs.readFileSync(path.join(CLIENT_DIR, file), 'utf8'))
    for (const m of code.matchAll(/\bt\(\s*'([^']+)'/g)) used.add(m[1])
  }
  const dead = [...zhKeys].filter((k) => !used.has(k))
  assert.deepEqual(dead, [], `这些键没有任何调用点：${dead.join(', ')}`)
})

/**
 * Files whose conversion has NOT been done yet (v0.30.6 lands the LAYER + the
 * gate; the per-file conversion is tracked here and must only ever SHRINK).
 *
 * Why a list instead of "just leave the rule failing": a permanently red gate is
 * a gate nobody reads (v0.28.13's lesson). Instead the rule below is enforced
 * everywhere EXCEPT these files, and two extra assertions make the list
 * self-cleaning: every listed file must still HAVE unconverted Chinese, and the
 * moment a file is converted it must be REMOVED from the list (the run goes red
 * with the file's name, so the list cannot rot silently).
 */
const PENDING_CONVERSION = [
  'editor-popup.ts',
  'endpoints.ts',
  'index.ts',
  'knowledge-fab.ts',
  'note-widget-draft.ts',
  'note-widget-tags.ts',
  'note-widget-upload.ts',
  'note-widget.ts',
  'quick-note-dock.ts',
  'rightbar-tab.ts',
  'scope-seat.ts',
  'session-summary.ts',
  'settings-page-catalog.ts',
  'settings-page-config.ts',
  'sidebar-entry.ts',
  'sync-button.ts',
  'tool-views.ts',
  'tw-frame.ts',
  'ui-config.ts',
  'wiki-scope-dock.ts',
]

/** CJK literals in `file` that are NOT inside a `t(...)` call. */
function unconvertedLiterals(file) {
  const code = stripComments(fs.readFileSync(path.join(CLIENT_DIR, file), 'utf8'))
  return cjkLiterals(code).filter((literal) => !literal.insideTCall)
}

test('用户可见文案必须走 t()：已转换的文件里不得残留中文（ALLOWLIST / PENDING 除外）', () => {
  const offenders = []
  for (const file of clientFiles) {
    if (file.startsWith('i18n') || SKIP_CJK_SCAN.has(file) || PENDING_CONVERSION.includes(file)) continue
    for (const literal of unconvertedLiterals(file)) {
      const allowed = ALLOWLIST.some(([allowFile, needle]) => allowFile === file && literal.text.includes(needle))
      if (!allowed) offenders.push(`${file}: ${literal.text.slice(0, 60)}`)
    }
  }
  assert.deepEqual(offenders, [], `这些中文串既没走 t()、也不在白名单里（是文案就改成 t('area.key')，是协议就往 ALLOWLIST 加一条并写明理由）：\n      ${offenders.join('\n      ')}`)
})

test('PENDING 清单是自清洁的：已转换完的文件必须从清单里删掉', () => {
  const done = PENDING_CONVERSION.filter((file) => unconvertedLiterals(file).length === 0)
  assert.deepEqual(done, [], `这些文件已经没有未转换的中文文案了，请把它们从 PENDING_CONVERSION 里删掉（清单必须只减不增、且反映现实）：${done.join(', ')}`)
})

test('PENDING 清单不得包含不存在的文件（改名/删除时要同步）', () => {
  const ghost = PENDING_CONVERSION.filter((file) => !clientFiles.includes(file))
  assert.deepEqual(ghost, [], `PENDING_CONVERSION 里有仓库里不存在的文件：${ghost.join(', ')}`)
})

/** Remove comments so their Chinese prose does not count as user-visible copy. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
}

/**
 * Every string/template literal containing CJK, with a flag saying whether it is
 * the first argument of a `t(...)` call (the one position where Chinese is OK).
 */
function cjkLiterals(code) {
  const out = []
  const re = /(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g
  for (const m of code.matchAll(re)) {
    const text = m[2]
    if (!/[\u4e00-\u9fff]/.test(text)) continue
    const before = code.slice(Math.max(0, m.index - 24), m.index)
    out.push({ text, insideTCall: /\bt\(\s*$/.test(before) })
  }
  return out
}

console.log(failures === 0 ? `\nCLIENT I18N CHECKS OK（${zhKeys.size} 个键 / ${chunkFiles.length} 个分片）` : `\nCLIENT I18N CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

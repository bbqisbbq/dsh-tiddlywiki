#!/usr/bin/env node
/**
 * `.tid` 侧栏预览守门（v0.32.0）。
 *
 * 这条守门钉四件事 —— 每一件都是"坏了会沉默"的那种：
 *   1. **解析**：`.tid` 的「字段行 → 空行 → 正文」必须被正确切开（含 CRLF、含没有空行、
 *      含格式怪到不像字段的情形 —— 后者必须整份当正文，绝不丢内容）。
 *   2. **成对注册**：宿主按 `id` 配对「元数据」和「正文」，两边必须用**同一个常量**
 *      （写死两份字面量就会一边注册成功、另一边找不到 → 面板空白）。
 *   3. **绝不白屏**：正文必须有 `<pre>` 原文兜底分支，且渲染失败时用 t() 说一句。
 *   4. **可选依赖**：宿主没有 `documentPreviews` 服务时必须什么都不做（老版本 DSH）。
 *
 *   node scripts/verify-tid-preview.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-tid-preview
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TID_EXTENSIONS, TID_PREVIEW_ID, TID_PREVIEW_SLOT, formatTidStamp, parseTidText, summarizeTid } from '../lib/index.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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

const source = fs.readFileSync(path.join(repoRoot, 'src/client/tid-preview.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/.*$/gm, '')

test('常量：id / 后缀 / 槽位名都是对外契约', () => {
  assert.equal(TID_PREVIEW_ID, 'dsh-tiddlywiki-tid')
  assert.deepEqual([...TID_EXTENSIONS], ['tid', 'tiddler'], '`.tiddler` 与 `.tid` 格式相同，必须一起认')
  assert.equal(TID_PREVIEW_SLOT, 'sidebar.right.tab.document')
})

test('解析：字段行 + 空行 + 正文', () => {
  const parsed = parseTidText('title: 我的笔记\ntags: demo 索引\ncreated: 20261026120000000\n\n正文第一段\n正文第二段')
  assert.equal(parsed.title, '我的笔记')
  assert.deepEqual(parsed.fields, [['tags', 'demo 索引'], ['created', '20261026120000000']])
  assert.equal(parsed.text, '正文第一段\n正文第二段', '空行之后必须整体当正文（不得丢掉第二个换行）')
})

test('解析：CRLF 归一化', () => {
  const parsed = parseTidText('title: A\r\ntype: text/markdown\r\n\r\n# 标题')
  assert.equal(parsed.title, 'A')
  assert.deepEqual(parsed.fields, [['type', 'text/markdown']])
  assert.equal(parsed.text, '# 标题')
})

test('解析：没有字段 → 整份当正文（绝不吞内容）', () => {
  const raw = '这一行没有冒号\n[[链接]] 也是正文'
  const parsed = parseTidText(raw)
  assert.equal(parsed.title, undefined)
  assert.deepEqual(parsed.fields, [])
  assert.equal(parsed.text, raw, '不像字段的整份内容必须原样保留')
})

test('解析：只有字段、没有正文', () => {
  const parsed = parseTidText('title: 空壳\ntags: x')
  assert.equal(parsed.title, '空壳')
  assert.deepEqual(parsed.fields, [['tags', 'x']])
  assert.equal(parsed.text, '', '没有空行 ⇒ 正文为空（正文组件会提示"只有字段没有正文"）')
})

test('解析：空文本不炸', () => {
  assert.deepEqual(parseTidText(''), { fields: [], text: '' })
  assert.deepEqual(parseTidText(undefined), { fields: [], text: '' })
})

test('时间戳：17 位 UTC → 人类可读；别的形态原样返回', () => {
  assert.equal(formatTidStamp('20260920070533227'), '2026-09-20 07:05')
  assert.equal(formatTidStamp('2026-09-20'), '2026-09-20', '不是 17 位就原样，别装作看懂了')
})

test('摘要：只单列 title/tags/时间，机械字段折进 other', () => {
  const parsed = parseTidText('title: 任务\ncreated: 20260920070533227\nmodified: 20261026143200000\nmodifier: 王二\ntags: 索引 工具 ws/ai-project agent-written\nrevision: 7\n\n正文')
  const sum = summarizeTid(parsed)
  assert.equal(sum.title, '任务')
  assert.deepEqual(sum.tags, ['索引', '工具'], 'ws/* 与 agent-written 不该占标签位')
  assert.equal(sum.time, '2026-10-26 14:32', '时间优先取 modified，且格式化')
  assert.deepEqual(sum.known, [['modifier', '王二']], 'created/modified 已进 time，不再重复列')
  const keys = sum.other.map(([k]) => k)
  assert.ok(keys.includes('revision'), '机械字段进 other')
  assert.ok(keys.includes('tags(hidden)'), '被隐藏的标签要留个影子（可追溯，不静默丢）')
})

test('摘要：没有 title/时间时不硬造', () => {
  const sum = summarizeTid(parseTidText('tags: a\n\n正文'))
  assert.equal(sum.title, undefined)
  assert.equal(sum.time, undefined)
  assert.deepEqual(sum.tags, ['a'])
})

test('注册成对：元数据与正文必须用同一个 id 常量', () => {
  const registers = source.match(/previews\.register\(\{[\s\S]*?\}\)/g) ?? []
  assert.equal(registers.length, 1, `元数据只应注册一次，实际 ${registers.length}`)
  assert.match(registers[0], /id:\s*TID_PREVIEW_ID/, '元数据的 id 必须用常量，不能写字面量')
  // 宿主写的是 register({ name, key: BODY_ID }, C)：keyed 子槽按 **key** 配对。
  // 用 `id` 会静默退化成内置纯文本（v0.32.0 的真实事故），所以这里正反都钉。
  assert.match(source, /slots\.register\(\{\s*name:\s*TID_PREVIEW_SLOT,\s*key:\s*TID_PREVIEW_ID\s*\}/, '正文必须以 key（不是 id）注册到 TID_PREVIEW_SLOT')
  assert.ok(!/slots\.register\(\{[^}]*\bid:\s*TID_PREVIEW_ID/.test(source), '正文注册不许用 id —— 宿主不认，会静默退回纯文本')
  assert.match(source, /slots\.inject\(\s*TID_PREVIEW_SLOT/, 'keyed 子槽必须先 inject 再 register（宿主约定）')
})

test('元数据形状照抄宿主：priority 是字符串、title 是函数、wrap=false', () => {
  assert.match(source, /priority:\s*'external'/, "priority 必须是字符串 'external'（宿主只判 === 'builtin'）")
  assert.ok(!/priority:\s*\d/.test(source), 'priority 不能是数字')
  assert.match(source, /title:\s*\(\)\s*=>\s*t\(/, 'title 要像宿主一样传函数，语言切换才能重取')
  assert.match(source, /wrap:\s*false/, 'wrap=false：我们渲染的是 HTML，不是纯文本行')
  assert.match(source, /loading:\s*'text-pages'/, 'loading 必须是 text-pages（正文拿 content.pages）')
})

test('正文从 content.pages 取文本（不是只认 content.text）', () => {
  assert.match(source, /bag\.pages/, '必须读 content.pages')
  assert.match(source, /offset/, '多页要按 offset 排序拼接')
})

test('绝不白屏：有 <pre> 原文兜底 + 失败时给一句人话', () => {
  assert.match(source, /createElement\('pre'/, '必须有 <pre> 原文分支')
  assert.match(source, /frame\.tidPreviewFallback/, '渲染失败必须用 t() 说明"下面是原文"')
  assert.match(source, /frame\.tidPreviewWaiting/, '还没拿到内容时必须说"等待文件内容"，不能空白')
  // 三态都要有分支：等待 / 只有字段 / 渲染或兜底
  assert.match(source, /frame\.tidPreviewNoBody/, '只有字段没有正文时也要说明')
})

test('渲染走宿主净化管道（铁律 #7），且失败只是回 null 不抛', () => {
  assert.match(source, /RENDER_ENDPOINT/, '必须走 /dsh-tiddlywiki/render，不得自建渲染')
  assert.match(source, /catch\s*\{[\s\S]{0,80}return null/, 'renderTidHtml 失败必须回 null（调用方退回原文），不能抛')
  assert.match(source, /dangerouslySetInnerHTML/, '净化后的 HTML 才允许注入')
})

test('可选依赖：documentPreviews 由别的插件提供，等不到时优雅跳过', () => {
  assert.match(source, /typeof ctx\.get === 'function'/, '服务读取器要按可选能力检测（老版本 DSH 没有就不碰）')
  // 服务由**另一个插件** reflect.provide 提供，可能在本插件之后才出现 ⇒ 必须等，不能查一次就放弃。
  assert.match(source, /getter\('documentPreviews'\)/, '服务要按名字读')
  assert.match(source, /setTimeout\(attempt, 250\)/, '服务还没出现时必须短轮询等待，不能静默放弃')
  assert.match(source, /documentPreviews never appeared after /, '始终没出现要留一条可诊断的 warn（英文，客户端守门不许中文字面量）')
  // 只有元数据、没有正文的一半注册必须整体撤回
  assert.match(source, /for \(const dispose of disposers\.splice\(0\)\) dispose\(\)/, '拿不到 slots 时必须回滚元数据，避免单边注册')
})

console.log(failures === 0 ? 'TID PREVIEW OK' : `TID PREVIEW FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env node
/**
 * 系统提示词守门（v0.21.0）——不 spawn TW、不写文件，秒级：
 *
 * 背景：注入提示词曾手抄一份**工具参数清单**，最后一次更新停在 v0.19.0，
 * 而 v0.19.4 / v0.19.5 / v0.20.1 都改过工具层 —— 于是模型看到 6 处过期签名
 * （delete 缺并发令牌、append 缺 fields、attach 缺覆盖保护、batch_put 缺
 * overwrite、trash 缺 title/limit、list_tags 缺 limit）。本脚本守住新契约：
 *
 *   1. `slim`（默认）**不得**再出现参数清单（没有任何可漂移的副本）；
 *   2. `full` 的签名索引由工具注册表实时生成 —— 每个工具名与它的每个参数名
 *      都必须出现在文本里（新增工具/参数而忘了提示词 → 立即红）；
 *   3. 三种形态都必须保留治理约定块（同步纪律 / 标签 / 链接格式）—— rewrite
 *      时不许悄悄丢掉用户依赖的规则；
 *   4. 用户文本里的 `{{…}}` 必须被转义（DSH 对未知变量直接抛错，会让整个
 *      系统提示词装配失败）；
 *   5. `describePrompt()`（草稿预览，v0.22.7）必须与 `buildPromptText()` 逐字节
 *      一致 —— 设置页「按表单当前值预览」与保存后的真实注入不能是两套拼装。
 *
 *   node scripts/verify-prompt.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-prompt
 */
import assert from 'node:assert/strict'
import {
  buildPromptText,
  describePrompt,
  escapePromptBraces,
  normalizePromptMode,
  normalizePromptPreview,
  registerTiddlywikiTools,
  tiddlywikiToolSummary,
  PROMPT_GOVERNANCE_BLOCKS,
  DEFAULT_PROMPT_MODE,
  PROMPT_SECTION_NAME,
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

// Register the real toolset against a stub registry: this is the same call the
// plugin makes at startup, so the summaries are the model-facing truth.
const tools = (() => {
  const ctx = { tools: { register: () => () => {} } }
  const deps = { wiki: () => undefined, git: {}, wikiPath: () => '', autoCommit: () => {} }
  registerTiddlywikiTools(ctx, deps)
  return tiddlywikiToolSummary()
})()

const slim = buildPromptText({ mode: 'slim', tools })
const full = buildPromptText({ mode: 'full', tools })

test('默认形态是 slim 且与 section 名一致', () => {
  assert.equal(DEFAULT_PROMPT_MODE, 'slim', 'v0.21.0 起默认应为 slim')
  assert.equal(PROMPT_SECTION_NAME, 'dsh-tiddlywiki')
  assert.equal(buildPromptText({ tools }), slim, '不传 mode 时必须等同 slim')
  assert.equal(normalizePromptMode(undefined), 'slim')
  assert.equal(normalizePromptMode('nonsense'), 'slim', '未知形态回落 slim')
  assert.equal(normalizePromptMode('full'), 'full')
})

test('工具注册表被真实填充（15 个 tiddlywiki_* 工具）', () => {
  assert.equal(tools.length, 15, `工具数应为 15，实际 ${tools.length}`)
  for (const t of tools) {
    assert.ok(t.name.startsWith('tiddlywiki_'), `工具名异常：${t.name}`)
    assert.ok(t.params.length > 0, `${t.name} 未采集到参数`)
  }
})

test('slim 不含参数清单（无第二份可漂移的 schema 副本）', () => {
  const sig = slim.match(/tiddlywiki_[a-z_]+`?（/gu)
  assert.equal(sig, null, `slim 出现了工具签名：${sig && sig.join(' / ')}`)
  // 形状名称可以提及，但不能出现参数列表的形态
  assert.ok(!/`tiddlywiki_[a-z_]+`（[a-z?]/u.test(slim), 'slim 不应出现 `tool`（参数…）')
  for (const t of tools) {
    for (const p of t.params) {
      assert.ok(!new RegExp(`\`${t.name}\`（[^）]*\\b${p.name}\\b`, 'u').test(slim), `slim 疑似残留 ${t.name} 的参数 ${p.name}`)
    }
  }
})

test('slim 有长度预算（防止再次膨胀成工具手册）', () => {
  const limit = 1800
  assert.ok(slim.length <= limit, `slim 已 ${slim.length} 字符，超出预算 ${limit}`)
  assert.ok(slim.length < full.length, 'full 必须比 slim 长（否则说明模式没生效）')
})

test('可选功能默认不打扰：不进提示词（v0.23.0）', () => {
  // 微信发布是可选 + 需额外安装的：默认必须完全不出现发布相关文字。
  assert.ok(!slim.includes('发布元数据规范'), '默认 slim 不得出现发布约定（微信发布默认关闭）')
  assert.ok(!slim.includes('pub-state'), '默认 slim 不得出现 pub-state')
  // 显式开启后才出现，且只多一行（~61 字符），仍在预算内。
  const on = buildPromptText({ mode: 'slim', tools, wechat: true })
  assert.ok(on.includes('发布元数据规范'), 'wechat:true 时必须带发布约定')
  assert.ok(on.length <= 1800, `开启后 slim 已 ${on.length} 字符，超出预算 1800`)
  const added = on.split('\n').filter((l) => !slim.split('\n').includes(l))
  assert.equal(added.length, 1, `开关应当只增加 1 行，实际 ${added.length}`)
  // 两种形态都受开关控制
  assert.ok(!full.includes('发布元数据规范'), '默认 full 也不得出现发布约定')
  assert.ok(buildPromptText({ mode: 'full', tools, wechat: true }).includes('发布元数据规范'))
})

test('草稿预览把 wechat 开关也算进去（否则勾选后预览是旧文本）', () => {
  assert.deepEqual(normalizePromptPreview({ wechat: true }), { wechat: true })
  assert.deepEqual(normalizePromptPreview({ wechat: 'yes' }), {}, '非布尔必须丢弃')
  const dOff = describePrompt(normalizePromptPreview({ mode: 'slim' }), tools)
  const dOn = describePrompt(normalizePromptPreview({ mode: 'slim', wechat: true }), tools)
  assert.notEqual(dOff.text, dOn.text, '预览必须能区分可选功能开关')
})

test('full 的每个工具与每个参数都出现在文本里（自动生成、不会过期）', () => {
  for (const t of tools) {
    assert.ok(full.includes(`\`${t.name}\``), `full 缺少工具 ${t.name}`)
    // 同一行内的参数必须属于该工具：逐行比对参数出现位置
    const line = full.split('\n').find((l) => l.includes(`\`${t.name}\``))
    assert.ok(line !== undefined, `full 未给 ${t.name} 单列一行`)
    for (const p of t.params) {
      assert.ok(line.includes(p.name), `full 的 ${t.name} 行缺少参数 ${p.name}：${line}`)
    }
    assert.ok(line.includes(`（${t.params.map((p) => (p.required ? p.name : `${p.name}?`)).join(', ')}）`), `${t.name} 的签名与注册表不一致：${line}`)
  }
})

test('full 的目录行数 = 工具数（没有多余/重复条目）', () => {
  const listed = full.split('\n').filter((l) => /^- `tiddlywiki_/u.test(l))
  assert.equal(listed.length, tools.length, `目录 ${listed.length} 行，工具 ${tools.length} 个`)
})

test('两种形态都保留治理约定块', () => {
  for (const block of PROMPT_GOVERNANCE_BLOCKS) {
    assert.ok(slim.includes(block), `slim 丢了治理约定块：${block.slice(0, 24)}…`)
    assert.ok(full.includes(block), `full 丢了治理约定块：${block.slice(0, 24)}…`)
  }
  for (const needle of ['tiddlywiki_git_sync action=pull', 'tiddlywiki_git_resolve', '[标题](/dsh-tiddlywiki/tw/#标题)', 'human-edited', 'agent-written', 'expectedModified']) {
    assert.ok(slim.includes(needle), `slim 缺少关键约定：${needle}`)
  }
})

test('enabled=false → 不产生任何文本（不注册空 section）', () => {
  assert.equal(buildPromptText({ enabled: false, tools }), '')
  assert.equal(buildPromptText({ enabled: false, override: 'x', extra: 'y', tools }), '')
})

test('extra 永远追加、override 取代内置正文但保留 extra', () => {
  const withExtra = buildPromptText({ mode: 'slim', extra: '团队规范：先看 wiki。', tools })
  assert.ok(withExtra.startsWith(slim), 'extra 必须追加在正文之后')
  assert.ok(withExtra.endsWith('团队规范：先看 wiki。'))
  const overridden = buildPromptText({ mode: 'slim', override: '只注入这一句。', tools })
  assert.equal(overridden, '只注入这一句。', 'override 必须整段取代内置文本')
  const both = buildPromptText({ mode: 'full', override: '只注入这一句。', extra: '附加。', tools })
  assert.equal(both, '只注入这一句。\n\n附加。')
  assert.ok(!both.includes('tiddlywiki_search'), 'override 生效后不应再出现内置目录')
})

test('用户文本里的 {{…}} 被转义（DSH 未知变量会抛错并炸掉整个装配）', () => {
  assert.equal(escapePromptBraces('a {{cwd}} b'), 'a {\u200B{cwd}} b')
  const text = buildPromptText({ mode: 'slim', extra: '示例：{{tiddler}} 与 {{a b}}', tools })
  assert.ok(!text.includes('{{'), '注入文本不得残留 {{（会让 DSH 装配失败）')
  assert.ok(text.includes('cwd') === false && text.includes('tiddler'), '转义不得吃掉用户文本')
})

// v0.23.5 — 连续花括号：`replace(/\{\{/g)` 只替换不重叠匹配，3 个及以上的 `{`
// 会残留 `{{`（实测 `{{{name}}}` → `{<ZWSP>{{name}}}`），而 DSH 对未知变量
// **直接抛错**——正是这个函数存在的理由，等于修了单层却漏了多层。
test('连续花括号（{{{…}}}）也必须被转义干净', () => {
  for (const sample of ['{{{name}}}', '{{{{x}}}}', 'a {{{b}} c', '{{{{{{deep}}}}}}']) {
    const escaped = escapePromptBraces(sample)
    assert.ok(!escaped.includes('{{'), `「${sample}」转义后仍残留 {{：${JSON.stringify(escaped)}`)
    assert.ok(!escaped.includes('{ {'), `不得改变可读性以外的字符：${JSON.stringify(escaped)}`)
  }
  const text = buildPromptText({ mode: 'slim', extra: '三段：{{{cwd}}} 与 {{{{deep}}}}', tools })
  assert.ok(!text.includes('{{'), '整段装配后仍不得残留 {{')
  assert.ok(text.includes('cwd') && text.includes('deep'), '转义不得吃掉用户文本')
})

// v0.22.7 — 草稿预览（设置页 POST /admin/prompt）的两个纯函数。
test('normalizePromptPreview 只放行 5 个字段，未知键/错类型被丢弃', () => {
  assert.deepEqual(normalizePromptPreview({ enabled: false, mode: 'full', extra: 'e', override: 'o', wechat: true }), { enabled: false, mode: 'full', extra: 'e', override: 'o', wechat: true })
  assert.deepEqual(normalizePromptPreview({ mode: 'nonsense', extra: 42, enabled: 'yes', wechat: 'yes', nope: 'x' }), {}, '未知形态/错类型必须被丢弃（回落内置默认）')
  assert.deepEqual(normalizePromptPreview(undefined), {})
  assert.deepEqual(normalizePromptPreview('not-an-object'), {})
  assert.deepEqual(normalizePromptPreview(null), {})
})

test('describePrompt 与 buildPromptText 同一份实现（预览 = 将来保存后的注入）', () => {
  for (const mode of ['slim', 'full']) {
    const d = describePrompt({ mode }, tools)
    assert.equal(d.mode, mode)
    assert.equal(d.enabled, true)
    assert.equal(d.text, buildPromptText({ mode, tools }), 'describePrompt 必须与保存路径逐字节一致')
  }
  assert.equal(describePrompt({ mode: 'full', extra: '附加。' }, tools).text, buildPromptText({ mode: 'full', extra: '附加。', tools }))
})

test('草稿预览：形态差别可见、enabled=false 为空、未知形态回落 slim', () => {
  const draftSlim = describePrompt(normalizePromptPreview({ enabled: true, mode: 'slim' }), tools)
  const draftFull = describePrompt(normalizePromptPreview({ enabled: true, mode: 'full' }), tools)
  assert.notEqual(draftSlim.text, draftFull.text, '切换形态后草稿预览必须不同（这是被修掉的 bug）')
  assert.ok(draftFull.text.includes('tiddlywiki_search'))
  assert.equal(describePrompt(normalizePromptPreview({ enabled: false, mode: 'full' }), tools).text, '')
  assert.equal(describePrompt(normalizePromptPreview({ enabled: false, mode: 'full' }), tools).enabled, false)
  assert.equal(describePrompt(normalizePromptPreview({ mode: 'nonsense' }), tools).mode, 'slim')
  assert.equal(describePrompt(normalizePromptPreview({ mode: 'nonsense' }), tools).text, draftSlim.text)
})

if (failures > 0) {
  console.error(`\nverify-prompt: ${failures} 项失败`)
  process.exit(1)
}
console.log(`\nverify-prompt: 全部通过（slim ${slim.length} 字符 / full ${full.length} 字符 · ${tools.length} 个工具）`)

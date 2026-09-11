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
 *      系统提示词装配失败）。
 *
 *   node scripts/verify-prompt.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-prompt
 */
import assert from 'node:assert/strict'
import {
  buildPromptText,
  escapePromptBraces,
  normalizePromptMode,
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

if (failures > 0) {
  console.error(`\nverify-prompt: ${failures} 项失败`)
  process.exit(1)
}
console.log(`\nverify-prompt: 全部通过（slim ${slim.length} 字符 / full ${full.length} 字符 · ${tools.length} 个工具）`)

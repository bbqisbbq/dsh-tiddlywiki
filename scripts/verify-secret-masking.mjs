#!/usr/bin/env node
/**
 * 配置密钥遮掩 / 注入文本转义守门（v0.19.3，安全回归）。
 *
 * 断两件事：
 *   1. `maskConfigSecrets()` / `stripMaskedSecrets()`——`/admin/state` 与
 *      `/admin/config` 回给浏览器的配置里，共享 token 必须是掩码；设置页把掩码
 *      原样提交回去时**不能**把真 token 覆盖成 `********`；
 *   2. `escapeInline()`——会话汇总里来自请求体/会话日志的字符串（sessionId、
 *      rename 旧标题、检索词）必须先转义 HTML 元字符，因为这些 wikitext 会被
 *      TW 渲染成片段再注入 DSH 页面。
 *
 *   node scripts/verify-secret-masking.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-secret-masking
 */
import assert from 'node:assert/strict'
import {
  MASKED_SECRET,
  escapeInline,
  maskConfigSecrets,
  stripMaskedSecrets,
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

const SECRET = 'super-secret-token'
const PAT_REMOTE = 'https://user:ghp_abcdef@github.com/bbqisbbq/wiki.git'

const stored = {
  bridge: { enabled: true, port: 8618, token: SECRET, tag: 'clip' },
  ui: { sendToAgent: { enabled: true, token: 'agent-token' }, tabLabel: '知识库' },
  git: { remote: PAT_REMOTE, branch: 'main' },
  note: { tag: 'inbox' },
}

console.log('maskConfigSecrets —— 无凭据调用者拿不到 secret')

test('token 被替换成掩码且带 tokenSet 标记', () => {
  const masked = maskConfigSecrets(stored)
  assert.equal(masked.bridge.token, MASKED_SECRET)
  assert.equal(masked.bridge.tokenSet, true)
  assert.equal(masked.ui.sendToAgent.token, MASKED_SECRET)
  assert.equal(masked.ui.sendToAgent.tokenSet, true)
  assert.ok(!JSON.stringify(masked).includes(SECRET), '掩码后的配置里不得出现原文')
  assert.ok(!JSON.stringify(masked).includes('ghp_abcdef'), 'git remote 里的 PAT 必须打码')
  assert.ok(masked.git.remote.includes('***@github.com'), `remote 应保留主机名：${masked.git.remote}`)
})

test('空 token → 空串 + tokenSet:false（不再伪装成已设置）', () => {
  const masked = maskConfigSecrets({ bridge: { token: '' }, ui: { sendToAgent: {} } })
  assert.equal(masked.bridge.token, '')
  assert.equal(masked.bridge.tokenSet, false)
  assert.equal(masked.ui.sendToAgent.tokenSet, false)
})

test('非密钥字段原样透传，且不修改传入对象', () => {
  const before = JSON.stringify(stored)
  const masked = maskConfigSecrets(stored)
  assert.equal(masked.note.tag, 'inbox')
  assert.equal(masked.bridge.port, 8618)
  assert.equal(JSON.stringify(stored), before, 'maskConfigSecrets 不得就地修改 ConfigStore 的对象')
})

console.log('stripMaskedSecrets —— 保存设置页不会用掩码覆盖真值')

test('掩码原样提交 → 该字段被丢弃（保留库里的真值）', () => {
  const patch = stripMaskedSecrets(
    { bridge: { token: MASKED_SECRET }, ui: { sendToAgent: { token: MASKED_SECRET, enabled: false } } },
    stored,
  )
  assert.deepEqual(patch.bridge, {}, `bridge.token 应被丢弃：${JSON.stringify(patch.bridge)}`)
  assert.deepEqual(patch.ui.sendToAgent, { enabled: false }, `只保留真实改动：${JSON.stringify(patch.ui)}`)
})

test('新 token 正常写入；空串表示清除', () => {
  const set = stripMaskedSecrets({ bridge: { token: 'new-token' } }, stored)
  assert.equal(set.bridge.token, 'new-token')
  const cleared = stripMaskedSecrets({ bridge: { token: '' } }, stored)
  assert.equal(cleared.bridge.token, '')
})

test('tokenSet 之类的展示字段不会被持久化', () => {
  const patch = stripMaskedSecrets({ bridge: { token: MASKED_SECRET, tokenSet: true } }, stored)
  assert.equal('tokenSet' in patch.bridge, false)
})

test('与掩码相同的 git remote 被丢弃；真正的新 remote 保留', () => {
  const redacted = maskConfigSecrets(stored).git.remote
  const dropped = stripMaskedSecrets({ git: { remote: redacted } }, stored)
  assert.equal('remote' in dropped.git, false, '回填的打码 remote 不该覆盖真值')
  const replaced = stripMaskedSecrets({ git: { remote: 'https://github.com/other/x.git' } }, stored)
  assert.equal(replaced.git.remote, 'https://github.com/other/x.git')
})

console.log('escapeInline —— 注入汇总 wikitext 的字符串必须转义')

test('HTML 元字符被转义（TW 原样透传 HTML）', () => {
  const out = escapeInline('<iframe src="javascript:alert(1)"></iframe>')
  assert.ok(!out.includes('<') && !out.includes('>'), `不得残留标签：${out}`)
  assert.ok(out.includes('&lt;iframe'), out)
})

test('控制字符/换行被清掉，链接语法字符被中和', () => {
  const out = escapeInline('a\nb\u0000c [[x]] |y|')
  assert.ok(!/[\u0000-\u001f]/.test(out), `不得残留控制字符：${JSON.stringify(out)}`)
  assert.ok(!out.includes('[[') && !out.includes(']]'), `不得留下链接语法：${out}`)
})

test('长度上限生效', () => {
  assert.equal(escapeInline('x'.repeat(500), 40).length, 40)
  assert.equal(escapeInline('短', 40), '短')
})

console.log(failures === 0 ? '\nSECRET MASKING OK' : `\nSECRET MASKING FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

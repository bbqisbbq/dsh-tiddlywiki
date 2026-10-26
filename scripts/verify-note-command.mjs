#!/usr/bin/env node
/**
 * `/note` 斜杠命令守门（v0.30.66）。
 *
 * 断的是这个命令最容易退化的三件事：
 *   1. **输入切分**：第一行当标题、其余当正文；只有一行时不能产生空正文。
 *   2. **拒绝覆盖同名笔记**：作者 2026-10-26 的核心抱怨之一就是"同一件事写了多份
 *      内容有差异的东西" —— 命令第二次写同名必须**报错**，不能静默盖掉第一版。
 *   3. **不冒充 Agent**：命令是人发起的，写出来的笔记不得带 `agent-written`
 *      （那个标签的含义是"Agent 写的，人可以放心改"）。
 *
 *   node scripts/verify-note-command.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-note-command
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NOTE_COMMAND_NAME, parseNoteInput, registerNoteCommand } from '../lib/index.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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

/** Register the command against a fake registry and hand back its definition. */
function capture(deps) {
  let definition
  const dispose = () => {}
  registerNoteCommand({ register: (d) => { definition = d; return dispose } }, deps)
  assert.ok(definition !== undefined, '命令没有注册到注册表')
  return { definition, dispose }
}

/** A fake TiddlyWebClient that records writes and can pretend a title exists. */
function fakeWiki(options = {}) {
  const writes = []
  const existing = options.existing ?? new Set()
  return {
    writes,
    client: {
      async get(title) {
        return existing.has(title) ? { title, text: 'old' } : undefined
      },
      async put(tiddler) {
        writes.push(tiddler)
        return tiddler
      },
    },
  }
}

await test('命令身份与发现文案', () => {
  const { definition } = capture({ scope: () => ({}), autoCommit: () => {} })
  assert.equal(definition.name, NOTE_COMMAND_NAME)
  assert.equal(definition.name, 'note', '名字必须是小写 kebab/单词（命令语法只收小写）')
  assert.ok(definition.description.length > 0, '必须有一句发现界面用的说明')
  assert.equal(definition.definitionId, 'dsh-tiddlywiki/note', '稳定定义标识必须带插件命名空间')
  assert.match(definition.input.hint, /标题/, 'hint 必须告诉用户第一行是标题')
})

await test('输入切分：多行 → 第一行标题、其余正文；单行 → 标题截断但正文不丢', () => {
  assert.deepEqual(parseNoteInput('标题\n正文第一行\n正文第二行'), { title: '标题', body: '正文第一行\n正文第二行' })
  assert.deepEqual(parseNoteInput('  只有一句话  '), { title: '只有一句话', body: '只有一句话' })
  const long = 'x'.repeat(60)
  assert.equal(parseNoteInput(long).title.length, 31, '单行标题必须截到 30 字符 + 省略号')
  assert.equal(parseNoteInput(long).body, long, '截断标题不得截断正文')
  assert.equal(parseNoteInput('   \n  \n'), undefined, '纯空白 → 没有可写内容')
  assert.deepEqual(parseNoteInput('标题\r\n正文'), { title: '标题', body: '正文' }, 'CRLF 必须归一化')
})

await test('写入：inbox 标签、无 agent-written、带工作站标记', async () => {
  const wiki = fakeWiki()
  const { definition } = capture({
    scope: () => ({ client: wiki.client, label: '工作' }),
    workspaceName: () => 'C:\\work\\demo',
    workspaceMarkEnabled: () => true,
    autoCommit: () => {},
  })
  const result = await definition.handler({ agent: { id: 's1' }, rawInput: '随手记\n今天发现 A 方案不再适用。' })
  assert.equal(result.kind, 'success', `应成功：${JSON.stringify(result)}`)
  assert.match(result.text, /工作/, '多库时必须说明写进了哪个库')
  assert.equal(wiki.writes.length, 1, '必须恰好写一条')
  const written = wiki.writes[0]
  assert.equal(written.title, '随手记')
  assert.equal(written.text, '今天发现 A 方案不再适用。')
  assert.ok(written.tags.includes('inbox'), `必须打 inbox 标签，实际 ${JSON.stringify(written.tags)}`)
  assert.ok(!written.tags.includes('agent-written'), '人写的笔记不得冒充 agent-written')
  assert.ok(written.tags.some((t) => t.startsWith('ws/')), `必须带工作站标签，实际 ${JSON.stringify(written.tags)}`)
  // 自定义字段在 TW REST 里是 tiddler 的**顶层**键（不是嵌套的 `fields`）。
  assert.match(String(written.workspace ?? written.fields?.workspace ?? ''), /demo/, 'workspace 字段必须是项目名')
})

await test('同名笔记已存在 → 报错并指路（绝不静默覆盖）', async () => {
  const wiki = fakeWiki({ existing: new Set(['随手记']) })
  let committed = 0
  const { definition } = capture({ scope: () => ({ client: wiki.client }), autoCommit: () => { committed++ } })
  const result = await definition.handler({ agent: { id: 's1' }, rawInput: '随手记\n第二版内容' })
  assert.equal(result.kind, 'error', '同名必须报错')
  assert.match(result.text, /已经存在/, '必须说明已存在')
  assert.match(result.text, /tiddlywiki_(get|put)/, '必须指路到正确做法（按并发令牌更新）')
  assert.equal(wiki.writes.length, 0, '被拒绝时一条都不许写')
  assert.equal(committed, 0, '被拒绝时不得触发自动提交')
})

await test('空输入 / 无可用知识库 → 都是 error（不写、不抛）', async () => {
  const wiki = fakeWiki()
  const { definition } = capture({ scope: () => ({ client: wiki.client }), autoCommit: () => {} })
  const empty = await definition.handler({ agent: { id: 's1' }, rawInput: '   ' })
  assert.equal(empty.kind, 'error', '空输入必须报错')
  assert.match(empty.text, /用法/, '必须给出用法')

  const stopped = capture({ scope: () => ({ reason: '库「书籍」未运行' }), autoCommit: () => {} })
  const refused = await stopped.definition.handler({ agent: { id: 's1' }, rawInput: '标题\n正文' })
  assert.equal(refused.kind, 'error', '没有可用客户端必须报错（不能假装成功）')
  assert.match(refused.text, /未运行/, '必须把宿主给的原因原样带出来')
  assert.equal(wiki.writes.length, 0)
})

await test('接线：只有宿主提供 commands 服务时才注册（老版本 DSH 不受影响）', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src/index.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '')
  assert.match(source, /ctx\.get\('commands'\)/, '必须从 ctx 取 commands 服务')
  assert.match(source, /if \(commands !== undefined\)/, '没有 commands 时必须跳过（不能直接调用）')
  assert.match(source, /disposers\.push\(registerNoteCommand\(/, '注册必须挂进 disposers（卸载时回收）')
  assert.match(source, /catch[\s\S]{0,120}note 命令注册失败/, '注册失败必须只记日志，不能拖垮 apply')
})

console.log(failures === 0 ? 'NOTE COMMAND OK' : `NOTE COMMAND FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

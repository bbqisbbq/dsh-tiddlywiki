#!/usr/bin/env node
/**
 * 工作区标记的纯函数守门（v0.24.0）——不 spawn TW、不写文件，毫秒级。
 *
 * 为什么单独一个脚本：`src/host/workspace.ts` 是**纯函数**，它决定「哪些会话
 * 目录能变成标签」。这段逻辑一旦放宽，后果不是报错而是**静默污染**：
 *   · 产出空格 / `[ ] { } | < > "` → TW 标签按空白切分、过滤器语法被破坏；
 *   · 产出空串或 `home`/`tmp` 这类通用目录 → 全库被一个毫无信息量的标签糊满；
 *   · 丢掉 `ws/` 前缀 → 与真实业务标签相撞（作者库里 `dsh-tiddlywiki` 这个标签
 *     已挂着 2510 篇导入的书籍章节，「在工作区内搜索」会返回那 2510 篇）。
 *
 * 本脚本把这些都变成可失败断言。与 `scripts/verify-tools.mjs` 的分工：
 * 那边验「标记真的落库了吗」（真实 TW），这边验「名字算得对吗」（纯逻辑）。
 *
 *   node scripts/verify-workspace.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-workspace
 */
import assert from 'node:assert/strict'
import {
  WORKSPACE_FIELD,
  WORKSPACE_TAG_PREFIX,
  isJunkTag,
  normalizeWorkspaceName,
  workspaceMarkFromCwd,
  workspaceNameFromCwd,
  workspaceTagName,
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

test('常量本身是契约：前缀非空、字段名是 workspace', () => {
  assert.equal(WORKSPACE_TAG_PREFIX, 'ws/')
  assert.equal(WORKSPACE_FIELD, 'workspace')
  // 前缀是**载荷**不是装饰：删掉它会让工作区标签与业务标签同名（见文件头）。
  assert.ok(WORKSPACE_TAG_PREFIX.length > 0, 'ws/ 前缀不得为空')
  assert.ok(!WORKSPACE_TAG_PREFIX.startsWith('$:/'), '工作区标签不得落进 TW 系统命名空间')
})

test('workspaceNameFromCwd：取路径最后一段，Windows / Unix / 尾斜杠都认', () => {
  assert.equal(workspaceNameFromCwd('C:\\work\\alpha-project'), 'alpha-project')
  assert.equal(workspaceNameFromCwd('C:\\work\\alpha-project\\'), 'alpha-project', '尾反斜杠不得变成空名字')
  assert.equal(workspaceNameFromCwd('/home/me/beta'), 'beta')
  assert.equal(workspaceNameFromCwd('/home/me/beta///'), 'beta', '多个尾斜杠同样要清掉')
  assert.equal(workspaceNameFromCwd('relative-dir'), 'relative-dir', '相对路径也要能用')
})

test('workspaceNameFromCwd：拿不到项目名的输入一律 undefined（不许猜）', () => {
  for (const bad of [undefined, null, '', '   ', '/', '\\', 'C:\\', 'C:/', 'D:\\', 'd:/', 123, {}, []]) {
    assert.equal(workspaceNameFromCwd(bad), undefined, `${JSON.stringify(bad)} 不该算出名字`)
  }
  // 驱动器根目录是真出现过的输入（在盘根开会话）：早期实现会算出 `C:`，
  // 于是全盘笔记都被打上 `ws/C:` —— 这条断言就是那次修复的守门。
  assert.equal(workspaceMarkFromCwd('C:\\'), undefined, 'C:\\ 不得产出 ws/C:')
})

test('normalizeWorkspaceName：非法字符变 -、折叠连续 -、去掉首尾 -', () => {
  assert.equal(normalizeWorkspaceName('my project'), 'my-project', '空格必须消掉（TW 标签按空白切分）')
  assert.equal(normalizeWorkspaceName('a[1]{2}|3<4>5"6'), 'a-1-2-3-4-5-6')
  assert.equal(normalizeWorkspaceName('a   b'), 'a-b', '连续空白折叠成一个 -')
  assert.equal(normalizeWorkspaceName('--a--'), 'a', '首尾的 - 要清掉（否则标签看起来是空的）')
  assert.equal(normalizeWorkspaceName('  spaced  '), 'spaced')
  assert.equal(normalizeWorkspaceName('中文项目名'), '中文项目名', 'CJK 必须原样保留（否则标签不可读）')
  assert.equal(normalizeWorkspaceName('dsh-tiddlywiki'), 'dsh-tiddlywiki', '普通名字不得被改写')
})

test('normalizeWorkspaceName：通用目录/空值一律拒绝（否则全库被无信息标签糊满）', () => {
  for (const generic of ['', '   ', 'home', 'HOME', 'users', 'tmp', 'TEMP', 'root', 'desktop', 'documents', 'downloads', 'desktop']) {
    assert.equal(normalizeWorkspaceName(generic), undefined, `「${generic}」不是项目名`)
  }
  for (const bad of [undefined, null, 42, {}, []]) {
    assert.equal(normalizeWorkspaceName(bad), undefined, `${JSON.stringify(bad)} 不该算出 id`)
  }
  // 只有全是非法字符时才退化 — 例如全空格/全括号
  assert.equal(normalizeWorkspaceName('[]{}'), undefined, '清完只剩空串 → undefined')
})

test('workspaceTagName：只做「前缀 + id」，id 已规范化', () => {
  assert.equal(workspaceTagName('alpha'), 'ws/alpha')
  assert.equal(workspaceTagName('中文'), 'ws/中文')
  assert.equal(workspaceTagName(''), 'ws/', '空 id 是明显的调用方错误 —— 保持直白，不静默兜底')
})

test('workspaceMarkFromCwd：完整链路 —— 真实 cwd 得到可用标记', () => {
  assert.deepEqual(workspaceMarkFromCwd('C:\\Users\\bbq\\.dsh\\plugins\\dsh-tiddlywiki'), {
    id: 'dsh-tiddlywiki',
    tag: 'ws/dsh-tiddlywiki',
  })
  assert.deepEqual(workspaceMarkFromCwd('/srv/apps/my-app'), { id: 'my-app', tag: 'ws/my-app' })
  // 已记录的局限（不是 bug）：cwd 正好是家目录时拿到的是登录名，桶很粗但真实。
  // 钉住它，免得以后有人「顺手」把它当成回归改掉却说不清为什么。
  assert.deepEqual(workspaceMarkFromCwd('C:\\Users\\bbq'), { id: 'bbq', tag: 'ws/bbq' }, '家目录 = 登录名（见 workspace.ts GENERIC_DIRS 的 KNOWN LIMITATION）')
  // 通用目录 / 拿不到 cwd → 没有标记（调用方据此降级为「不标记」）
  for (const bad of [undefined, null, '', 'C:\\Users', 'C:\\Users\\bbq\\Desktop', 'C:\\tmp', '/root', '/']) {
    assert.equal(workspaceMarkFromCwd(bad), undefined, `${JSON.stringify(bad)} 不该产生标记`)
  }
})

test('标签安全：任何 cwd 算出的 ws 标签都不是「垃圾标签」、不含空白与过滤器字符', () => {
  // 与 isJunkTag 的字符集必须一致 —— 两处各改一半是这类功能最典型的回归。
  const samples = [
    'C:\\work\\alpha-project', 'C:\\Users\\bbq\\.dsh\\plugins\\dsh-tiddlywiki',
    '/home/me/beta', 'my project with spaces', 'a[b]c{d}e|f<g>h"i',
    '--weird--name--', '中文项目', 'a   b', 'x'.repeat(200),
    'C:\\work\\tab\there', 'C:\\work\\new\nline',
  ]
  for (const cwd of samples) {
    const mark = workspaceMarkFromCwd(cwd)
    if (mark === undefined) continue
    assert.ok(!mark.tag.includes(' '), `${cwd} → 标签含空格：${mark.tag}`)
    assert.equal(mark.tag.trim(), mark.tag, `${cwd} → 标签首尾有空白：${JSON.stringify(mark.tag)}`)
    assert.ok(!/[[\]{}|<>]/.test(mark.tag), `${cwd} → 标签含过滤器字符：${mark.tag}`)
    assert.ok(!/\s/.test(mark.tag), `${cwd} → 标签含任何空白：${JSON.stringify(mark.tag)}`)
    assert.equal(isJunkTag(mark.tag), false, `${cwd} → 产出了垃圾标签：${mark.tag}`)
    assert.ok(mark.tag.startsWith(WORKSPACE_TAG_PREFIX), `${cwd} → 标签丢了前缀：${mark.tag}`)
    assert.equal(mark.tag, workspaceTagName(mark.id), 'tag 必须恒等于 前缀+id')
  }
})

test('回归：ws/ 前缀不得被「简化」掉（与真实业务标签撞名）', () => {
  // 作者库实测：标签 `dsh-tiddlywiki` 挂着 2510 篇导入的书籍章节。若工作区标签
  // 退化成裸名字，「在工作区内搜索」会返回那 2510 篇 —— 比没有这个功能更糟。
  const mark = workspaceMarkFromCwd('C:\\Users\\bbq\\.dsh\\plugins\\dsh-tiddlywiki')
  assert.ok(mark !== undefined)
  assert.notEqual(mark.tag, mark.id, '工作区标签不得等于裸项目名（必须带前缀）')
  assert.equal(mark.tag, `ws/${mark.id}`)
})

console.log(failures === 0 ? '\nWORKSPACE CHECKS OK' : `\nWORKSPACE CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

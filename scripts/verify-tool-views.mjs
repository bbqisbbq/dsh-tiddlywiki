#!/usr/bin/env node
/**
 * 客户端工具卡守门（v0.25.0）——**源码级**、不 spawn TW、秒级完成。
 *
 * 为什么需要它：`src/client/tool-views.ts` 里的 `TOOL_VIEW_KEYS` / `TOOL_LABELS`
 * 是 host 侧工具名的**手工副本**（客户端 bundle 不能 import host 模块），此前只靠
 * AGENTS.md 的一句「记得同步」提醒，没有任何脚本兜底 —— 新增工具时卡片会静默退化
 * 成通用文本卡，而「搜索卡片的范围与工具不一致」这类问题正是同一条裂缝的产物。
 *
 * 断言：
 *   1. TOOL_VIEW_KEYS 与 `src/host/tools.ts` 注册的 `tiddlywiki_*` 工具名**完全一致**
 *      （不多不少）；
 *   2. TOOL_LABELS 覆盖每个 key；
 *   3. `tool-views.ts` 的 `WORKSPACE_TAG_PREFIX` 字面量与 `src/host/workspace.ts`
 *      的常量一致（否则卡片回传的工作区 id 会对不上）；
 *   4. SearchCard 仍然把 `workspace` 回传给 `/search`，且「工作区/缩小范围」这两个
 *      回执措辞在两侧都还在（改了文案就要同步改解析，这条断言负责当场报错）。
 *
 *   node scripts/verify-tool-views.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-tool-views
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

const toolsSrc = read('src/host/tools.ts')
const viewsSrc = read('src/client/tool-views.ts')
const workspaceSrc = read('src/host/workspace.ts')

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

/** Every `tiddlywiki_*` name registered by host/tools.ts (defineTool literal). */
const registered = [...toolsSrc.matchAll(/name: '(tiddlywiki_[a-z_]+)'/g)].map((m) => m[1])
const registeredUnique = [...new Set(registered)].sort()

/** Parse one `const NAME … = <open> … <close>` block body (brackets given by the caller). */
function blockBody(source, declaration, open, close) {
  const start = source.indexOf(declaration)
  assert.ok(start >= 0, `源码里找不到 ${declaration}`)
  const from = source.indexOf(`= ${open}`, start)
  const to = source.indexOf(close, from)
  assert.ok(from > start && to > from, `${declaration} 的 ${open}…${close} 块解析失败`)
  return source.slice(from + 1, to)
}

const viewKeys = [...blockBody(viewsSrc, 'const TOOL_VIEW_KEYS', '[', ']').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
const labelKeys = [...blockBody(viewsSrc, 'const TOOL_LABELS', '{', '}').matchAll(/^\s*(tiddlywiki_[A-Za-z_]+):/gm)].map((m) => m[1]).sort()

test(`host 注册了 ${registeredUnique.length} 个工具（期望 15 个）`, () => {
  assert.equal(registeredUnique.length, 15, `工具数变了（${registeredUnique.join(', ')}）——同步检查客户端 TOOL_VIEW_KEYS 与 AGENTS.md §2`)
})

test('客户端 TOOL_VIEW_KEYS 与 host 工具名完全一致', () => {
  assert.deepEqual(viewKeys, registeredUnique, `客户端 key 与 host 工具名不一致：多=${viewKeys.filter((k) => !registeredUnique.includes(k)).join(',') || '无'} 少=${registeredUnique.filter((k) => !viewKeys.includes(k)).join(',') || '无'}`)
})

test('TOOL_LABELS 覆盖每个 TOOL_VIEW_KEYS', () => {
  const missing = viewKeys.filter((k) => !labelKeys.includes(k))
  assert.deepEqual(missing, [], `缺少中文标签的工具卡：${missing.join(', ')}`)
})

test('客户端 WORKSPACE_TAG_PREFIX 与 host/workspace.ts 一致', () => {
  const hostPrefix = /export const WORKSPACE_TAG_PREFIX = '([^']+)'/.exec(workspaceSrc)
  const viewPrefix = /const WORKSPACE_TAG_PREFIX = '([^']+)'/.exec(viewsSrc)
  assert.ok(hostPrefix !== null, 'host/workspace.ts 里找不到 WORKSPACE_TAG_PREFIX')
  assert.ok(viewPrefix !== null, 'tool-views.ts 里找不到 WORKSPACE_TAG_PREFIX 字面量')
  assert.equal(viewPrefix[1], hostPrefix[1], `两处前缀必须一致（host=${hostPrefix[1]} view=${viewPrefix[1]}）`)
})

test('SearchCard 会把工作区范围回传给 /search（卡片与工具结果一致）', () => {
  assert.ok(/params\.set\('workspace', workspace\)/.test(viewsSrc), 'SearchCard 必须把 workspace 参数发给 /search')
  assert.ok(/receiptWorkspace\(props\.text\)/.test(viewsSrc), 'SearchCard 必须从模型可见回执里解析工作区名')
  assert.ok(viewsSrc.includes('工作区') && viewsSrc.includes('缩小范围'), '解析依赖的「工作区…缩小范围」措辞不见了：改了 host 文案就要同步改这里')
  assert.ok(toolsSrc.includes('已在工作区 ${WORKSPACE_TAG_PREFIX}'), 'host 侧的工作区回执措辞变了，客户端解析会失效')
})

test('wiki 链接拦截器同时匹配相对与绝对同源 /dsh-tiddlywiki/tw/#标题（DSH 会把 markdown 链接渲染成绝对 http(s) URL → 当作外链）', () => {
  // 旧实现只匹配相对路径 /^\/dsh-tiddlywiki\/tw\/#(.+)$/；DSH 的 markdown 渲染器
  // 会把 `/dsh-tiddlywiki/tw/#标题` 解析成绝对 URL，于是旧拦截器漏掉、点击落入
  // DSH 的「外链」处理（target=_blank + openExternalLink）→ 笔记在新标签页打开而
  // 不是 TW 面板。修复必须用 new URL(...) 归一化后再判同源 + 代理 pathname。
  assert.ok(/new URL\(href, window\.location\.origin\)/.test(viewsSrc), '拦截器必须用 new URL(href, location.origin) 解析相对与绝对 href')
  assert.ok(/url\.origin === window\.location\.origin/.test(viewsSrc), '拦截器必须校验同源（跨源外链放行给 DSH）')
  assert.ok(/url\.pathname === TW_PROXY_BASE/.test(viewsSrc), '拦截器必须校验 pathname 命中 TW 代理基址（/dsh-tiddlywiki/tw/）')
  assert.ok(!/^\/dsh-tiddlywiki\\\/tw\\\/#/.test(viewsSrc.replace(/\n/g, ' ')) || !/new RegExp\(`\^\$\{TW_PROXY_BASE/.test(viewsSrc), '旧的「仅相对路径」正则拦截器已移除')
})

console.log(failures === 0 ? '\nTOOL VIEWS OK' : `\nTOOL VIEWS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

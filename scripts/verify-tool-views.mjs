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
 *   4. SearchCard 仍然把 `workspace` 回传给 `/search`，且 host 的中文回执措辞
 *      「已在工作区 …」还在（改了文案就要同步改解析，这条断言负责当场报错）。
 *      v0.30.14：卡片自己显示的那句话搬进了 i18n 目录（按语言取值），所以断言
 *      分开管两件事 —— 解析盯源码，措辞盯 `i18n-card.ts` 的 zh 分片。
 *
 *   node scripts/verify-tool-views.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-tool-views
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFamily } from './lib/source-family.mjs' // v0.28.8：按「模块族」读源码，拆分不断言路径

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFamily(root, rel.replace(/\.ts$/, ''))

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
  // v0.30.14：卡片把「已在工作区 … 内缩小范围」这句话交给了 i18n 目录（按语言取值），
  // 所以这条断言拆成两半 —— **解析**只依赖 host 回执里的「工作区」二字（留在源码里），
  // **措辞**则必须能在 zh 分片里找到（不然英文界面下会把 host 的中文抄一遍，
  // 或者中文界面下悄悄换了说法而 host 回执没跟着改）。
  assert.ok(viewsSrc.includes('工作区'), '解析依赖的「工作区 ws/<id>」措辞不见了：改了 host 文案就要同步改解析')
  const cardCatalog = fs.readFileSync(path.join(root, 'src/client/i18n-card.ts'), 'utf8')
  assert.ok(
    cardCatalog.includes('已在工作区 {prefix}{id} 内缩小范围') && cardCatalog.includes('工作区 {prefix}{id} 内 0 条，已扩大到全库'),
    '检索卡片的两条作用域说明必须留在 src/client/i18n-card.ts 的 zh 分片里（它们与 host 回执是同一套说法）',
  )
  assert.ok(toolsSrc.includes('已在工作区 ${WORKSPACE_TAG_PREFIX}'), 'host 侧的工作区回执措辞变了，客户端解析会失效')
})

test('wiki 链接拦截器同时匹配相对与绝对同源 /dsh-tiddlywiki/tw/#标题（DSH 会把 markdown 链接渲染成绝对 http(s) URL → 当作外链）', () => {
  // 旧实现只匹配相对路径 /^\/dsh-tiddlywiki\/tw\/#(.+)$/；DSH 的 markdown 渲染器
  // 会把 `/dsh-tiddlywiki/tw/#标题` 解析成绝对 URL，于是旧拦截器漏掉、点击落入
  // DSH 的「外链」处理（target=_blank + openExternalLink）→ 笔记在新标签页打开而
  // 不是 TW 面板。修复必须用 new URL(...) 归一化后再判同源 + 代理 pathname。
  assert.ok(/new URL\(href, window\.location\.origin\)/.test(viewsSrc), '拦截器必须用 new URL(href, location.origin) 解析相对与绝对 href')
  assert.ok(/url\.origin === window\.location\.origin/.test(viewsSrc), '拦截器必须校验同源（跨源外链放行给 DSH）')
  // v0.28.8：pathname 判定抽成 matchTwProxyPath —— 它必须同时认
  //   裸 `/dsh-tiddlywiki/tw/`（默认库别名，agent 链接用的形态）
  //   和 `/dsh-tiddlywiki/tw/<id>/`（多库卡片链接的形态）
  // 只认裸路径的话，多库下点卡片行会落入 DSH 外链处理（新标签页）。
  assert.ok(/matchTwProxyPath\(url\.pathname\)/.test(viewsSrc), '拦截器必须走 matchTwProxyPath 判定 pathname（同时支持裸路径与 /tw/<id>/）')
  assert.ok(/function matchTwProxyPath\(/.test(viewsSrc), 'matchTwProxyPath 必须存在')
  assert.ok(/pathname === TW_PROXY_BASE/.test(viewsSrc), 'matchTwProxyPath 必须认裸 TW 代理基址')
  // 反向：旧的「只认相对路径」正则拦截器不得回来。判据是**那条正则本身**
  // （`/^\/dsh-tiddlywiki\/tw\/#(.+)$/`）。旧写法 `!/^\/dsh-tiddlywiki\\\/tw\\\/#/`
  // 有两个坑：`^` 没有 m 标志、又作用在折行后的整份文本上 ⇒ 只有文件开头正好是
  // 它才为假 ⇒ `!A` 恒真，断言永不失败（v0.29.0 审计实测）。现在直接查那条正则在
  // 源码里还在不在 —— 它一旦被改写回「相对路径 only」，这里立刻红。
  assert.ok(
    !viewsSrc.includes('\\/dsh-tiddlywiki\\/tw\\/#'),
    '旧的「仅相对路径」正则拦截器又回来了（链接判定必须走 matchTwProxyPath，否则多库/绝对 href 会漏）',
  )
  assert.ok(
    !/new RegExp\(`\^\$\{TW_PROXY_BASE/.test(viewsSrc),
    '不允许再按「以 TW_PROXY_BASE 开头」手拼正则（裸 /tw/ 与 /tw/<id>/ 要分别判定）',
  )
})

test('多库：卡片取数/链接/缓存都必须带上会话作用域的知识库（v0.28.8，反馈 10）', () => {
  // 症状：会话 scope 是库 B 时，模型文本说「【知识库：B】」而卡片渲染的是库 A 的
  // 同名条目 —— 卡片侧完全没有「库」这个概念，取数一律落到宿主的默认库回落。
  assert.ok(/WikiScopeContext/.test(viewsSrc), '卡片树必须有知识库作用域 context')
  assert.ok(/resolveSessionWikiId/.test(viewsSrc), '作用域必须来自 /session/wiki（wiki-scope.ts）')
  assert.ok(/withWikiQuery\(/.test(viewsSrc), '所有卡片取数必须经 withWikiQuery 带上 ?wiki=')
  assert.ok(/twProxyFor\(/.test(viewsSrc), '行链接必须经 twProxyFor 指向 /tw/<id>/（裸路径是默认库别名）')
  // bodyCache 的键必须含库：两个库有同名条目时，旧实现（只按 title）会互相串味。
  assert.ok(/function bodyCacheKey\(wikiId/.test(viewsSrc), 'bodyCache 键必须含 wikiId')
  assert.ok(/dsh-tw-toolcard-wiki/.test(viewsSrc), '卡片头必须显示知识库徽标')
  // 两条取数路径都要能用上作用域。
  assert.ok(/fetchRender\(title, wikiId\)/.test(viewsSrc), '卡片正文渲染必须带 wikiId')
  const summarySrc = read('src/client/session-summary.ts')
  assert.ok(/withWikiQuery\(SUMMARY_ENDPOINT, scoped\)/.test(summarySrc), '会话汇总生成必须带 ?wiki=')
  assert.ok(/fetchRenderFragment\(data\.title, 15_000, scoped\)/.test(summarySrc), '会话汇总渲染必须带 wikiId')
  assert.ok(/tiddlerExists\([^)]*wikiId/.test(summarySrc) || /tiddlerExists\(data\.title, scoped\)/.test(summarySrc), '会话汇总的条目探测必须带 wikiId（否则自愈会一直误判「条目不存在」）')
})

console.log(failures === 0 ? '\nTOOL VIEWS OK' : `\nTOOL VIEWS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env node
/**
 * 「面板加载哪个知识库」的守门（v0.28.0）——真读 src/client/*.ts，零浏览器。
 *
 * 为什么值得单独一个脚本：这条规则错了**不会报错**，只会静默串台——面板显示 A 的
 * 界面、每次读写都落在 B（TW 用 `$:/config/tiddlyweb/host` 拼**所有** API URL，而
 * "无 id 的裸路径"就等于默认库）。另一条同样静默：记住的 wiki id 在清单里消失了
 * （改名/删除）却不做校验，面板就会一直加载 404。
 *
 *   npx tsx scripts/verify-wiki-focus.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-wiki-focus
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Minimal localStorage so the focus store can be imported in Node. */
const store = new Map()
globalThis.window = {
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: (key) => { store.delete(key) },
  },
}
/** `resolveTwUrl` branches on THIS page's protocol (desktop = dsh-app:). */
globalThis.location = { protocol: 'http:', origin: 'http://localhost' }

const { twProxyFor, resolveTwUrl, withWikiQuery } = await import(pathToFileURL(path.join(repoRoot, 'src/client/endpoints.ts')).href)
const { getFocusWiki, resolveFocusWiki, setFocusWiki, subscribeFocusWiki } = await import(pathToFileURL(path.join(repoRoot, 'src/client/wiki-focus.ts')).href)

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

const REL = '/dsh-tiddlywiki/tw/'
const ABS = 'http://127.0.0.1:19387/dsh-tiddlywiki/tw/'

test('twProxyFor：single 模式忽略 id —— 现有安装逐字不变', () => {
  assert.deepEqual(twProxyFor('single', 'work', REL, ABS), { relative: REL, absolute: ABS })
  assert.deepEqual(twProxyFor(undefined, 'work', REL), { relative: REL })
})

test('twProxyFor：multi 模式给出该库自己的路径（相对与绝对都带）', () => {
  assert.deepEqual(twProxyFor('multi', 'work', REL, ABS), {
    relative: '/dsh-tiddlywiki/tw/work/',
    absolute: 'http://127.0.0.1:19387/dsh-tiddlywiki/tw/work/',
  })
  // 绝对基址是桌面端（dsh-app: 渲染器）唯一能加载同步适配器的形式，同样必须带 id。
  assert.equal(twProxyFor('multi', 'work', REL, ABS).absolute.endsWith('/tw/work/'), true)
})

test('twProxyFor：multi 但没有焦点库 → 仍是裸路径（= 默认库）', () => {
  assert.deepEqual(twProxyFor('multi', undefined, REL), { relative: REL })
  assert.deepEqual(twProxyFor('multi', '', REL), { relative: REL })
})

test('twProxyFor：id 进 URL 前必须编码（不然后半段会变成新路径）', () => {
  assert.equal(twProxyFor('multi', 'a/b', REL).relative, '/dsh-tiddlywiki/tw/a%2Fb/')
})

test('resolveTwUrl：per-wiki 之后仍按宿主 origin 解析（同源不变）', () => {
  const bases = twProxyFor('multi', 'work', REL)
  assert.equal(resolveTwUrl(bases.relative, bases.absolute), 'http://localhost/dsh-tiddlywiki/tw/work/')
})

test('resolveFocusWiki：记住的库还在就用它', () => {
  setFocusWiki('b')
  assert.equal(resolveFocusWiki([{ id: 'a' }, { id: 'b' }], 'a'), 'b')
  assert.equal(getFocusWiki(), 'b')
})

test('resolveFocusWiki：记住的库没了 → 回落默认库（否则面板会一直 404）', () => {
  setFocusWiki('gone')
  assert.equal(resolveFocusWiki([{ id: 'a' }, { id: 'b' }], 'b'), 'b')
  // 默认库也没了 → 第一个可用库
  assert.equal(resolveFocusWiki([{ id: 'c' }], 'gone'), 'c')
  // 名册为空 → 不改写记忆值（宿主不可达时不要把它抹掉）
  assert.equal(resolveFocusWiki([], 'a'), 'gone')
})

test('setFocusWiki：写入即持久化，且只在真的变化时通知', () => {
  setFocusWiki('a')
  assert.equal(store.get('dsh-tiddlywiki.focusWiki'), 'a')
  let notified = 0
  const off = subscribeFocusWiki(() => { notified += 1 })
  setFocusWiki('a')
  assert.equal(notified, 0, '同一个值不该触发刷新（每次点都重载编辑器很烦）')
  setFocusWiki('b')
  assert.equal(notified, 1)
  setFocusWiki(undefined)
  assert.equal(store.has('dsh-tiddlywiki.focusWiki'), false, 'undefined 必须清掉记忆值')
  assert.equal(notified, 2)
  off()
  setFocusWiki('c')
  assert.equal(notified, 2, '退订后不得再收到通知')
})

// ── 会话选择器的接线（源码级：组件是 React，零 DOM 环境下只能这样断）──────────
const { readFileSync } = await import('node:fs')
const dockSrc = readFileSync(path.join(repoRoot, 'src/client/wiki-scope-dock.ts'), 'utf8')
const indexSrc = readFileSync(path.join(repoRoot, 'src/client/index.ts'), 'utf8')

test('会话选择器：只列 agentVisible 的库，且单库时整块不渲染', () => {
  assert.match(dockSrc, /filter\(\(wiki\) => wiki\.agentVisible\)/, '名册必须先按 agentVisible 过滤（宿主也会拒绝隐身库）')
  assert.match(dockSrc, /if \(sessionId === undefined \|\| wikis\.length <= 1\) return null/, '单库安装不得出现这个控件')
})

test('会话选择器：走 /session/wiki，清空选择发 null 而不是空字符串', () => {
  // 路径字面量只允许有一份（endpoints.ts）；组件引用那个常量。
  assert.match(dockSrc, /SESSION_WIKI_ENDPOINT/, '组件必须用共享端点常量，而不是自己拼路径')
  const endpointsSrc = readFileSync(path.join(repoRoot, 'src/client/endpoints.ts'), 'utf8')
  assert.match(endpointsSrc, /SESSION_WIKI_ENDPOINT = `\$\{ROUTE_PREFIX\}\/session\/wiki`/, '端点定义必须是 /session/wiki')
  assert.match(dockSrc, /wiki: next\.length > 0 \? next : null/, '清除选择必须发 null')
  // 选中一个没在跑的库会在宿主侧把它起起来，冷启动可能几十秒——预算必须够。
  assert.match(dockSrc, /AbortSignal\.timeout\(120_000\)/, '启动一个库可能要几十秒，超时不能太短')
})

test('设置页：多库模式下**不再渲染**「知识库位置」（与列表重复，作者 2026-09-28 反馈）', () => {
  const settings = readFileSync(path.join(repoRoot, 'src/client/settings-page.ts'), 'utf8')
  // 单库模式保留它（那里它写的是 wiki 之外的指针文件，是唯一正确入口）；
  // 多库模式整块不渲染，目录改动收到「知识库列表」里。
  assert.match(settings, /function renderWikiLocationSection\(/, '入口函数必须还在（单库模式要用）')
  assert.match(settings, /if \(view\.mode === 'multi'\) return/, '多库模式必须直接跳过这一块')
  assert.match(settings, /view\.mode === 'multi'[\s\S]{0,220}const move = make\(/, '多库模式下目录改动必须落在列表那一行的「改目录」上')
  // 宿主侧接口仍按模式分派（不能因为界面藏了就没人能用）——接口断言在 farm-boot 里。
  assert.match(settings, /WIKI_SWITCH_ENDPOINT/, '默认库改目录仍走 /admin/wiki/switch')
})

test('会话选择器：挂在 conversation.input.dock（scope=session，组件能拿到 sessionId）', () => {
  assert.match(indexSrc, /id: 'wiki-scope'/)
  assert.match(indexSrc, /name: 'conversation\.input\.dock'/)
  assert.match(dockSrc, /interface DockProps \{ sessionId\?: string \}/, '组件的 props 必须含 sessionId（该槽位 scope=session）')
})

test('设置页：知识库列表是第一块，且能改模式/启停/默认/可见性/移出', () => {
  const settings = readFileSync(path.join(repoRoot, 'src/client/settings-page.ts'), 'utf8')
  assert.match(settings, /renderWikiListSection\(body, isDisposed, refresh\)/, '设置页必须渲染知识库列表')
  // 列表必须排在位置区**之前**：多库的其余一切都要先有第二个库才能用。
  const listAt = settings.indexOf('renderWikiListSection(body, isDisposed, refresh)')
  const locationAt = settings.indexOf('renderWikiLocationSection(body, isDisposed, refresh)')
  assert.ok(listAt >= 0 && locationAt > listAt, '知识库列表必须排在位置区之前')
  for (const action of ['set-mode', 'set-default', 'start', 'stop', 'remove']) {
    assert.ok(settings.includes(`action: '${action}'`) || settings.includes(`action: wiki.running ? 'stop' : 'start'`) || settings.includes('action: \'set-mode\''), `设置页必须能发出 ${action}`)
  }
  assert.match(settings, /agentVisible: !wiki\.agentVisible/, '必须能切换对 Agent 的可见性')
  assert.match(settings, /\*\*目录与内容不会被删除\*\*/, '移出列表必须说清"不删目录"（否则没人敢点）')
})

test('设置页：配置作用域必须显式（per-wiki 请求都要带 ?wiki=）', () => {
  const settings = readFileSync(path.join(repoRoot, 'src/client/settings-page.ts'), 'utf8')
  // 每个库的配置存在它自己的 config tiddler 里：三处 per-wiki 管理请求都必须带作用域，
  // 否则给"书籍库"配 git.remote 会静默改到默认库上——存了、但永不生效。
  assert.match(settings, /withWiki\(STATE_ENDPOINT\)/)
  assert.match(settings, /withWiki\(CONFIG_ENDPOINT\)/)
  assert.match(settings, /withWiki\(PROMPT_ENDPOINT\)/)
  assert.match(settings, /配置作用域/, '页面必须说清这一块在编辑哪个库')
})

test('withWikiQuery：指向某个库时拼 ?wiki=，没有目标时逐字不变', () => {
  assert.equal(withWikiQuery('/x/note', undefined), '/x/note', '无目标 = 默认库，URL 不许变')
  assert.equal(withWikiQuery('/x/note', ''), '/x/note')
  assert.equal(withWikiQuery('/x/note', 'books'), '/x/note?wiki=books')
  // 已经有 query 的必须用 & 接（上传路由本来就带 ?name=）
  assert.equal(withWikiQuery('/x/upload?name=a.png', 'books'), '/x/upload?name=a.png&wiki=books')
  assert.equal(withWikiQuery('/x/note', 'a/b'), '/x/note?wiki=a%2Fb', 'id 必须编码')
})

test('快速笔记：整张卡片（标签/最近/草稿/附件/保存/弹窗）必须同库', () => {
  const note = readFileSync(path.join(repoRoot, 'src/client/note-widget.ts'), 'utf8')
  // 每个 per-wiki 调用都要经 wikiQuery —— 只改保存那一处就会出现"标签来自 A、笔记写进 B"。
  for (const endpoint of ['NOTE_ENDPOINT', 'EDIT_ENDPOINT', 'UPLOAD_ENDPOINT', 'GET_ENDPOINT', 'RECENT_ENDPOINT']) {
    assert.match(note, new RegExp(`wikiQuery\\((?:\\\`\\$\\{)?${endpoint}`), `${endpoint} 必须经 wikiQuery 定向`)
  }
  // 标签建议走 buildTagEditor 的 wikiQuery 回调（按 URL 记忆，换库自动重读）
  assert.match(note, /wikiQuery\?\.\(TAGS_ENDPOINT\)/)
  assert.match(note, /tagsPromiseKey !== url/, '标签列表的记忆必须以 URL 为键，否则换库后还在用旧库的标签')
  // 弹窗编辑器必须落在同一个库（写入 A、编辑器打开 B 是"看起来成功了"的失败）
  assert.match(note, /twProxyFor\(rosterMode, targetWiki, payload\.twUrl, payload\.twUrlAbsolute\)/)
  // 单库安装：名册 ≤1 时连选择器都不显示，targetWiki 保持 undefined
  assert.match(note, /if \(roster\.length <= 1\) return/)
  assert.match(note, /targetPicked/, '卡片里显式选过之后不得再被焦点库带走')
})

console.log(failures === 0 ? '\nWIKI FOCUS CHECKS OK' : `\nWIKI FOCUS CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

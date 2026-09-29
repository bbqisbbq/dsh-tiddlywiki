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
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFamily } from './lib/source-family.mjs' // v0.28.8：按「模块族」读源码，拆分不断言路径

/**
 * The i18n catalog text (v0.30.6): user-visible copy MOVED out of the client
 * modules into `i18n-*.ts`. Assertions about "what the user is told" therefore
 * check the CATALOG for the sentence plus the module for a `t('…')` CALL SITE —
 * matching the Chinese literal inside settings-page-wikis.ts would now be a
 * false red, which is the whole point of the layer.
 */
const catalogText = () => fs.readdirSync(path.join(repoRoot, 'src/client'))
  .filter((n) => n.startsWith('i18n-') && n.endsWith('.ts'))
  .map((n) => fs.readFileSync(path.join(repoRoot, 'src/client', n), 'utf8'))
  .join('\n')
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
// 侧边栏入口行的点击判定与副作用（纯函数 + 真 PanelState，v0.28.13）——真源码，不是正则猜。
const { resolveEntryClick, applyEntryClick } = await import(pathToFileURL(path.join(repoRoot, 'src/client/sidebar-entry.ts')).href)
const { PanelState } = await import(pathToFileURL(path.join(repoRoot, 'src/client/state.ts')).href)

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
  // v0.28.12：选中「默认库那一项」= 清空显式作用域 → 发 null（不再是 value='' 的占位选项，
  // 但"清空"的语义与对应的报文完全没变）。
  assert.match(dockSrc, /wiki: wanted\.length > 0 \? wanted : null/, '清除选择（选中默认库那一项）必须发 null')
  // 选中一个没在跑的库会在宿主侧把它起起来，冷启动可能几十秒——预算必须够。
  assert.match(dockSrc, /AbortSignal\.timeout\(120_000\)/, '启动一个库可能要几十秒，超时不能太短')
})

test('设置页：多库模式下**不再渲染**「知识库位置」（与列表重复，作者 2026-09-28 反馈）', () => {
  const settings = readFamily(repoRoot, 'src/client/settings-page')
  // 单库模式保留它（那里它写的是 wiki 之外的指针文件，是唯一正确入口）；
  // 多库模式整块不渲染，目录改动收到「知识库列表」里。
  assert.match(settings, /function renderWikiLocationSection\(/, '入口函数必须还在（单库模式要用）')
  assert.match(settings, /if \(view\.mode === 'multi'\) return/, '多库模式必须直接跳过这一块')
  assert.match(settings, /view\.mode === 'multi'[\s\S]{0,220}const move = make\(/, '多库模式下目录改动必须落在列表那一行的「改目录」上')
  // 宿主侧接口仍按模式分派（不能因为界面藏了就没人能用）——接口断言在 farm-boot 里。
  assert.match(settings, /WIKI_SWITCH_ENDPOINT/, '默认库改目录仍走 /admin/wiki/switch')
})

test('会话选择器：与快速笔记**同一行**（v0.28.7 合并；作者报障"没和对话框对齐"）', () => {
  // 演进：v0.28.0 起选择器是**独立的** conversation.input.dock 条目（id: wiki-scope）。
  // 但该槽位是竖向 flex 列，**每个条目独占一整行** —— 两个条目永远是上下两行，
  // 无论怎么调 padding 都不可能"并排"。所以 v0.28.7 把选择器改成由 quick-note 条目
  // 通过 `scope` 参数渲染在自己那一行里（按钮前面）。
  // 判据（新）：注册表里**只能有一个** input.dock 条目，且选择器由它带出来。
  const dockRegs = indexSrc.match(/name: 'conversation\.input\.dock'/g) ?? []
  assert.equal(dockRegs.length, 1, `input.dock 只能注册一个条目（实际 ${dockRegs.length}）——多条目=多行，永远对不齐`)
  assert.match(indexSrc, /createQuickNoteDock\(widget, createWikiScopeDock\(\)\)/, '选择器必须作为 scope 传进快速笔记条目')
  // 组件仍要能拿到 sessionId：scope=session 的 props 是发给**条目组件**的，靠 scope 透传。
  // （v0.28.8 起 DockProps 多了可选的 useSessions 用来识别空白会话，所以这里只断言
  //  sessionId 这个字段存在，不再钉死整个 interface 的字面写法。）
  assert.match(dockSrc, /sessionId\?: string/, '选择器组件的 props 必须含 sessionId（该槽位 scope=session）')
  const quick = readFileSync(path.join(repoRoot, 'src/client/quick-note-dock.ts'), 'utf8')
  assert.match(quick, /scope\?: \(props: \{ sessionId\?: string; useSessions\?: SessionStoreReader \}\)/, '快速笔记条目必须接受 scope（同一行渲染），并透传 useSessions（v0.28.11：选择器靠它认出空白会话）')
  assert.match(quick, /sessionId: props\.sessionId/, '条目必须把 sessionId 透传给 scope（否则选择器拿不到会话）')
  assert.match(quick, /useSessions: props\.useSessions/, '条目必须把 useSessions 透传给 scope（否则 dock 里的选择器认不出空白会话，让位不了 → 一屏两个）')
})

test('新会话（空白会话）的知识库选择器：走 selector.context，且**不许**再往 dock 挂第二个（v0.28.11，作者报障「有两个」）', () => {
  // 需求原文：「新会话时像 dsh-client-ui-git-graph 这个插件在模式选择后面增加个知识库选择」。
  // 参考实现用的是 `conversation.input.selector.context`（模式/预设选择器旁边那一格），
  // 并且**声明感知**——因为不是每个 shell 都声明这个洞，裸 register 会抛。
  //
  // v0.28.8 的回落是「往 dock 再注册一个 blank-only 条目」，而 dock 里**本来就有**
  // 同一个选择器（快速笔记那一行的 scope 子元素，v0.28.7）。本机 shell 恰好不声明
  // selector.context（app.asar 里连这个字符串都没有 → 回落是常态），于是新会话里
  // 两个选择器同时渲染：一个和快速笔记同一行、一个独占一行（作者 2026-09-29 报障）。
  // 正确做法：dock 那个就是**唯一**的家，context 那一格是空白会话的升级位；谁在
  // 用由 scope-seat 的 blankSeat 标记协调。
  const seat = readFileSync(path.join(repoRoot, 'src/client/scope-seat.ts'), 'utf8')
  const indexSrc = readFileSync(path.join(repoRoot, 'src/client/index.ts'), 'utf8')
  const dockSrc = readFileSync(path.join(repoRoot, 'src/client/wiki-scope-dock.ts'), 'utf8')

  assert.match(seat, /conversation\.input\.selector\.context/, '必须优先用 selector.context —— 那才是「模式选择后面」')
  // 声明感知：裸 register 到未声明的槽位会抛。
  assert.match(seat, /slots\.inject\(SELECTOR_CONTEXT_SLOT/, 'selector.context 必须经 inject 注册（声明感知）')
  // 反向：**不许**再出现「回落注册 dock 条目」这条路（它就是重复的来源）。
  // 判据只在代码上，不在注释上 —— 这个模块的说明必须能解释这段历史。
  const seatCode = seat.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '')
  assert.ok(!/conversation\.input\.dock|INPUT_DOCK_SLOT/.test(seatCode), '不得再回落注册 dock 条目 —— dock 里已经有同一个选择器，两个同时渲染就是「新会话两个知识库选择」')
  assert.ok(!/fallbackToDock|CONTEXT_FALLBACK_MS/.test(seatCode), '回落计时器必须一起删掉（留着它迟早又会挂出第二个条目）')
  assert.match(indexSrc, /createWikiScopeDock\(\{ blankOnly: true \}\)/, 'context 那一格的组件必须 blankOnly（否则活动会话里会多出第二个选择器）')
  assert.match(indexSrc, /mountScopeSeat\(/, 'index.ts 必须真的挂上这个座位')

  // 让位协议：context 那一格挂上了 → dock 里的选择器在空白会话必须返回 null。
  assert.match(seat, /setBlankSeatMounted\(true\)/, 'context 那一格挂上时必须发布 blankSeat 标记')
  assert.match(seat, /setBlankSeatMounted\(false\)/, '注册失败 / dispose 时必须把标记交还（否则空白会话会一个选择器都没有）')
  assert.match(dockSrc, /isBlankSeatMounted/, 'dock 里的选择器必须查这个标记')
  assert.match(dockSrc, /if \(!blankOnly && blank && blankSeat\) return null/, '空白会话里让位的判据必须同时含「非 blankOnly」「会话是空白」「那一格在挂着」三个条件')
  // 空白会话判定：从 session store 读 blank，且拿不到时保守当作「非空白」。
  assert.match(dockSrc, /useSessions/, '必须能从 session store 读 blank 标记')
  assert.match(dockSrc, /isBlankSession/, '空白会话判定必须收敛到一个函数里')
})

test('快速笔记：单库模式不得露出「写入」选择器（作者 2026-09-28 报障）', () => {
  const note = readFamily(repoRoot, 'src/client/note-widget')
  const styles = readFamily(repoRoot, 'src/client/styles')
  // 症状：单库模式下界面出现一个「写入」下拉、点开没有选项。
  // 根因：`hidden` 属性在 CSS 里只是 display:none，而 .dsh-tw-note-wiki 有显式
  // display:inline-flex —— **显式 display 会盖掉 hidden**，元素照样渲染。
  // 修法已升级为**一条全局兜底**（v0.28.5）：见下面那条「hidden 必须真的隐藏」。
  // 这里只保留「组件侧也要兜一层」这一半（不依赖 CSS 是否正确加载）。
  // 组件侧兜底：单库时除了 hidden 还要禁用并直接 display:none
  // （v0.29.0：目标库解析搬出了 build()，于是文件里有两处 `roster.length <= 1`
  //  —— 带花括号的那一处才是画 DOM 的分支，`return` 那一处是解析时的提前退出）
  const guardAt = note.indexOf('if (roster.length <= 1) {')
  assert.ok(guardAt > 0, '组件必须有单库分支（画 DOM 的那个）')
  const guardBlock = note.slice(guardAt, guardAt + 400)
  assert.ok(guardBlock.includes("wikiField.style.display = 'none'"), '单库时组件也要直接隐藏（不只靠 hidden 属性）')
  assert.ok(guardBlock.includes('wikiSelect.disabled = true'), '单库时选择器必须被禁用')
})

test('dock 条目必须与 composer 输入框对齐，且选择器与按钮**并排**（作者 2026-09-28 报障）', () => {
  const align = readFileSync(path.join(repoRoot, 'src/client/dock-align.ts'), 'utf8')
  const quick = readFileSync(path.join(repoRoot, 'src/client/quick-note-dock.ts'), 'utf8')
  const scope = readFileSync(path.join(repoRoot, 'src/client/wiki-scope-dock.ts'), 'utf8')
  const styles = readFamily(repoRoot, 'src/client/styles')

  // 规则只有一份：dock 槽位是 composer 的**兄弟节点**，必须测出输入框卡片再补 padding。
  assert.match(align, /export function alignDockEntry\(/, '对齐逻辑必须收在 dock-align.ts 一份')
  assert.match(align, /paddingRight/, '对齐靠给条目补右内边距')
  assert.match(align, /ResizeObserver/, '侧栏开合会移动输入框卡片 → 必须观察祖先链重测')

  // 对齐只由**那个唯一的行**负责（v0.28.7：选择器已并入这一行，不再自己对齐，
  // 否则同一行会被测两次、右内边距翻倍）。
  assert.match(quick, /alignDockEntry\(/, '快速笔记条目必须用共享对齐')
  assert.ok(!/alignDockEntry\(/.test(scope), '选择器并入同一行后不该再自己测一次（会与整行重复补 padding）')
  assert.match(quick, /const wrap = wrapRef\.current[\s\S]{0,80}return alignDockEntry\(wrap\)/, '对齐必须挂在这一行的根元素上')
  // 两处都必须挂 ref（没有元素可测就没法对齐）
  assert.match(scope, /ref: wrapRef/, '选择器必须把 ref 挂到自己的根元素上')
  // 选择器在**同一行内**：inline-flex（占满宽就又把按钮挤到下一行了）+ 该行仍是右对齐。
  assert.match(styles, /\.dsh-tw-scope-dock\s*\{[^}]*display:\s*inline-flex/, '选择器必须是 inline-flex（并排，不能整行宽）')
  assert.match(styles, /\.dsh-tw-dock-note\s*\{[^}]*justify-content:\s*flex-end/, '该行必须右对齐到输入框边缘')
  // 顺序要求（作者原话"并排放在快速笔记的前面或者后面"）：选择器渲染在按钮**之前**。
  const scopeRenderAt = quick.indexOf('scope?.(')
  const btnRenderAt = quick.indexOf("className: open ? 'dsh-tw-dock-note-btn")
  assert.ok(scopeRenderAt > 0 && btnRenderAt > scopeRenderAt, '选择器必须在按钮之前渲染（同一行、并排）')
  assert.ok(!/BoundingClientRect/.test(scope), '条目里不得再自带一份测量实现')
  assert.ok(!/BoundingClientRect/.test(quick), '快速笔记的测量也必须只剩共享那一份')
})

test('设置页：知识库列表是第一块，且能改模式/启停/默认/可见性/移出', () => {
  const settings = readFamily(repoRoot, 'src/client/settings-page')
  assert.match(settings, /renderWikiListSection\(body, isDisposed, refresh\)/, '设置页必须渲染知识库列表')
  // 列表必须排在位置区**之前**：多库的其余一切都要先有第二个库才能用。
  const listAt = settings.indexOf('renderWikiListSection(body, isDisposed, refresh)')
  const locationAt = settings.indexOf('renderWikiLocationSection(body, isDisposed, refresh)')
  assert.ok(listAt >= 0 && locationAt > listAt, '知识库列表必须排在位置区之前')
  for (const action of ['set-mode', 'set-default', 'start', 'stop', 'remove']) {
    assert.ok(settings.includes(`action: '${action}'`) || settings.includes(`action: wiki.running ? 'stop' : 'start'`) || settings.includes('action: \'set-mode\''), `设置页必须能发出 ${action}`)
  }
  assert.match(settings, /agentVisible: !wiki\.agentVisible/, '必须能切换对 Agent 的可见性')
  assert.ok(catalogText().includes('目录与内容不会被删除'), '移出列表必须说清「不删目录」否则没人敢点（文案在 i18n 目录里）')
  assert.match(settings, /t\('settings\./, '设置页文案必须走 t()（调用点在代码里、文案在 i18n 目录里）')
})

test('设置页：配置作用域必须显式（per-wiki 请求都要带 ?wiki=）', () => {
  const settings = readFamily(repoRoot, 'src/client/settings-page')
  // 每个库的配置存在它自己的 config tiddler 里：三处 per-wiki 管理请求都必须带作用域，
  // 否则给"书籍库"配 git.remote 会静默改到默认库上——存了、但永不生效。
  assert.match(settings, /withWiki\(STATE_ENDPOINT\)/)
  assert.match(settings, /withWiki\(CONFIG_ENDPOINT\)/)
  assert.match(settings, /withWiki\(PROMPT_ENDPOINT\)/)
  assert.match(settings, /配置作用域/, '页面必须说清这一块在编辑哪个库')
  // v0.29.0：状态行那两个按钮此前**漏了**作用域 —— 同一行显示的是正在配置的那个库的
  // git/TW 状态，点下去 pull/commit/push（或重启）的却是默认库，而且看起来一切正常。
  // 修复前这里也全绿（清单里没有 SYNC/RESTART），所以这两条是补上的真判据。
  assert.match(settings, /fetch\(withWiki\(SYNC_ENDPOINT\)/, '「同步」按钮必须带 ?wiki=（否则同步的是默认库的仓库）')
  assert.match(settings, /fetchJson\(withWiki\(RESTART_ENDPOINT\)/, '「重启 TW」按钮必须带 ?wiki=（否则重启的是默认库）')
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
  const note = readFamily(repoRoot, 'src/client/note-widget')
  // 每个 per-wiki 调用都要经 wikiQuery —— 只改保存那一处就会出现"标签来自 A、笔记写进 B"。
  for (const endpoint of ['NOTE_ENDPOINT', 'EDIT_ENDPOINT', 'UPLOAD_ENDPOINT', 'GET_ENDPOINT', 'RECENT_ENDPOINT']) {
    assert.match(note, new RegExp(`wikiQuery\\((?:\\\`\\$\\{)?${endpoint}`), `${endpoint} 必须经 wikiQuery 定向`)
  }
  // 标签建议走 buildTagEditor 的 wikiQuery 回调（按 URL 记忆，换库自动重读）
  assert.match(note, /wikiQuery\?\.\(TAGS_ENDPOINT\)/)
  assert.match(note, /tagsPromiseKey !== url/, '标签列表的记忆必须以 URL 为键，否则换库后还在用旧库的标签')
  // ⚠️ v0.29.0：上面那句曾经是**假绿** —— 它匹配的是 helper 里的实现，而唯一的调用点
  // 根本没传 `wikiQuery`，于是多库下标签建议一直来自默认库。判据必须落在**调用点**上。
  const tagCallAt = note.indexOf('buildTagEditor({')
  assert.ok(tagCallAt > 0, '找不到 buildTagEditor 的调用点')
  assert.match(note.slice(tagCallAt, tagCallAt + 160), /wikiQuery/, '调用点必须把 wikiQuery 交给标签编辑器（漏传 = 建议列表来自默认库）')
  // 弹窗编辑器必须落在同一个库（写入 A、编辑器打开 B 是"看起来成功了"的失败）
  assert.match(note, /twProxyFor\(rosterMode, targetWiki, payload\.twUrl, payload\.twUrlAbsolute\)/)
  // 单库安装：名册 ≤1 时连选择器都不显示，targetWiki 保持 undefined
  assert.match(note, /if \(roster\.length <= 1\)/, '必须有单库分支（不显示选择器、targetWiki 保持 undefined）')
  assert.match(note, /targetPicked/, '卡片里显式选过之后不得再被焦点库带走')
})

/**
 * v0.29.0 — the DEFAULT click path never built the card.
 *
 * `openNative()` (ui.quickNoteMode = native, which IS the default) posts /edit and
 * opens the TW popup without ever calling `build()`, and the whole roster/target
 * resolution used to live inside `build()` — so `targetWiki` stayed undefined and
 * `rosterMode` stayed 'single': every quick note went into the DEFAULT wiki with
 * the default wiki's editor, while the user was reading another one. Silent.
 *
 * These assertions pin the ORDER (resolve → refuse-if-stopped → write) on both
 * entry paths, which is the part a future refactor can undo without any other
 * guard noticing.
 */
test('快速笔记 native 路径：必须先解析目标库，再写（v0.29.0）', () => {
  const note = readFamily(repoRoot, 'src/client/note-widget')
  // 解析必须是**独立函数**（老代码整段塞在 build() 里，native 路径永远拿不到）
  assert.match(note, /const ensureTarget = \(\): Promise<void> => \{/, '目标库解析必须是独立函数（build 之外）')
  assert.ok(
    !/const build = [\s\S]{0,4000}?fetchStatus\(\)\.then\([\s\S]{0,400}?rosterMode = /.test(note.slice(note.indexOf('const build ='), note.indexOf('const build =') + 5000)),
    '名册解析不得再埋在 build() 里（那正是 native 路径写错库的成因）',
  )
  const nativeAt = note.indexOf('async openNative() {')
  assert.ok(nativeAt > 0, '找不到 openNative')
  const nativeBody = note.slice(nativeAt, note.indexOf('isOpen()', nativeAt))
  const ensureAt = nativeBody.indexOf('await ensureTarget()')
  const postAt = nativeBody.indexOf('await postEditAndOpen(')
  assert.ok(ensureAt > 0, 'native 路径必须先 await ensureTarget()')
  assert.ok(postAt > ensureAt, '解析必须发生在写入/打开编辑器之前')
  assert.match(nativeBody, /stoppedTarget\(\)/, 'native 路径必须拒绝「目标库没在运行」（而不是写进默认库）')
  // 卡片保存路径同样：host 现在会 503，客户端也别等用户写完才说。
  const saveAt = note.indexOf('doSave = async (): Promise<void> => {')
  assert.ok(saveAt > 0, '找不到 doSave')
  assert.match(note.slice(saveAt, saveAt + 900), /stoppedTarget\(\)/, '卡片保存同样要拒绝未运行的目标库')
})

test('侧边栏入口：每个在运行的库一个入口，用自己的显示名（作者 2026-09-28 要求）', () => {
  const sidebar = readFileSync(path.join(repoRoot, 'src/client/sidebar-entry.ts'), 'utf8')
  const styles = readFamily(repoRoot, 'src/client/styles')

  // 多库：按名册逐库建行，标签取该库的 display label
  assert.match(sidebar, /const running = list\.filter\(\(w\) => w\.running\)/, '只列在运行的库（点了就该能打开）')
  assert.match(sidebar, /row\.labelEl\.textContent = w\.label/, '每行必须用该库自己的显示名')
  // 点行 = 先切焦点库再开面板（否则点 A 打开 B）
  assert.match(sidebar, /if \(wikiId !== undefined\) setFocusWiki\(wikiId\)/, '点击入口行必须先切焦点库')
  // 单库：仍走 ui.sidebarLabel 那一个行，行为逐字不变
  assert.match(sidebar, /if \(running\.length <= 1\) \{[\s\S]{0,200}entry\.hidden = false/, '单库必须保留原来那一个行')
  assert.match(sidebar, /entry\.hidden = true/, '多库时默认行让位给每库自己的行')
  // 焦点库高亮 + 停用的行要清掉
  assert.match(sidebar, /row\.entry\.dataset\.focus = 'true'/, '当前焦点库要标出来')
  assert.match(styles, /\.dsh-tw-entry\[data-focus="true"\]/, '焦点库标记要有样式')
})

test('文档：插件说明必须讲清多库与"从旧版本升级"（作者 2026-09-28 要求）', () => {
  const notes = readFileSync(path.join(repoRoot, 'src/host/seed-notes.ts'), 'utf8')
  // 升级用户最大的困惑：装完了不知道有个多库模式、也不知道旧指针文件还在起作用。
  assert.match(notes, /!! 多知识库（v0\.28\.0 起）/, '插件说明里必须有「多知识库」一节')
  assert.match(notes, /!! 从旧版本升级上来/, '必须有「从旧版本升级上来」一节')
  assert.match(notes, /升级后不会自动变成多库/, '必须说明升级后仍是单库、行为不变')
  assert.match(notes, /wikis\.json/, '必须点出控制文件在哪')
  assert.match(notes, /location\.json|指针文件/, '必须说清单库模式下旧指针文件不再参与')
  assert.match(notes, /对 Agent 隐身/, '必须解释 agentVisible 的实际含义')
})

test('FAB 菜单：切库后选中项必须即时更新（作者 2026-09-28 报障）', () => {
  const fab = readFileSync(path.join(repoRoot, 'src/client/knowledge-fab.ts'), 'utf8')
  // 症状：在菜单里选了另一个库，库切了但选中标记还停在旧的。
  // 根因：选中标记只在菜单**构建时**算了一次，之后从不重画。
  assert.match(fab, /const paint = \(\): void =>/, '必须有可重复调用的重画函数')
  assert.match(fab, /subscribeFocusWiki\(/, '必须订阅焦点变化才能即时重画')
  assert.match(fab, /repaintWikiMenu\?\.\(\)/, '每次打开菜单前也要重画（切库可能发生在菜单关着的时候）')
  assert.match(fab, /focusOff\?\.\(\)/, 'dispose 必须回收订阅')
})

test('每库图标：host 校验 + 客户端渲染都不得成为注入点（v0.28.4）', () => {
  const registry = readFileSync(path.join(repoRoot, 'src/host/wiki-registry.ts'), 'utf8')
  const icon = readFileSync(path.join(repoRoot, 'src/client/wiki-icon.ts'), 'utf8')
  // 选择器自 v0.28.8 起独立成模块（settings-page.ts 已够大）；读取时做兜底，
  // 免得将来再搬家时这条守门默默读空文件、断言全过。
  const pickerPath = path.join(repoRoot, 'src/client/settings-icon-picker.ts')
  const settings = fs.existsSync(pickerPath)
    ? readFileSync(pickerPath, 'utf8')
    : readFamily(repoRoot, 'src/client/settings-page')
  // host：名字或短串，超长/控制字符拒绝；空值 = 清除
  assert.match(registry, /export function normalizeWikiIcon\(/, 'host 必须有校验入口')
  assert.match(registry, /trimmed\.length > 8/, '必须限制长度（这个值会变成侧边栏文本）')
  assert.match(registry, /WIKI_ICON_NAMES/, '内置图标名集合必须在 host 侧定义')
  // 客户端：emoji 走 textContent，绝不 innerHTML —— 值来自用户可编辑的文件
  assert.match(icon, /el\.textContent = icon\.trim\(\)/, 'emoji 必须用 textContent 渲染（不是 innerHTML）')
  assert.match(icon, /isIconName\(icon\)[\s\S]{0,80}innerHTML = ICON_SVG/, '只有内置名才允许 innerHTML，且用的是我们自己的 SVG')
  // 设置页：弹出式网格选择器（v0.28.8 起不再是 <select>）；当前值不在候选里要保留
  assert.match(settings, /dsh-tw-iconpicker/, '设置页必须有图标选择器（弹出网格）')
  assert.match(settings, /function openIconPicker\(/, '选择器必须走 openIconPicker')
  assert.match(settings, /!choices\.some\(\(c\) => c\.value === current\)/, '自定义 emoji 不能被候选列表抹掉')
})

test('图标弹层必须有 CSS —— 只有 DOM 没有样式，视觉上就是「点了没反应」（v0.28.8 回归）', () => {
  // ── 这条守门的由来（真实缺陷，2026-09-28）────────────────────────────────
  // 上面那条断言只检查「TS 源码里出现过 dsh-tw-iconpicker 这个字符串」——
  // 而弹层的 class 名当然会出现在 TS 里（它是 make() 的参数）。于是：
  // 组件 (markup) 写了、接线写了、守门也绿了，**唯独 styles.ts 里一条 CSS 都没有**。
  // 弹层仍然会被 append 到 document.body，但它是个无宽高约束的裸块，
  // 用户看到的就是「点击图标没有正常弹出」。
  //
  // 教训：断言「某个类名存在」不等于断言「这个组件可用」。渲染型组件的守门
  // 至少要跨两个文件——一个说"我生成了这个 DOM"，一个说"这个 DOM 有样式"。
  const styles = readFamily(repoRoot, 'src/client/styles')
  const pickerPath = path.join(repoRoot, 'src/client/settings-icon-picker.ts')
  const picker = readFileSync(pickerPath, 'utf8')

  // 弹层本体、网格、格子、分页器：四个都必须真有规则（少一个就退回裸块）。
  for (const cls of ['dsh-tw-iconpicker', 'dsh-tw-iconpicker-grid', 'dsh-tw-iconpicker-cell', 'dsh-tw-iconpicker-pager']) {
    assert.ok(
      styles.includes(`.${cls} {`) || styles.includes(`.${cls}{`) || styles.includes(`.${cls},`),
      `styles.ts 里没有 .${cls} 的规则 —— 弹层会以无样式块出现（"点了没反应"）`,
    )
  }
  // 弹层挂在 document.body 上，所以定位必须是 fixed：absolute 会被页面滚动带走。
  // ⚠️ 取「规则体」而不是「往后切 N 字符」：规则里可能带注释，而注释里会提到
  // 别的 z-index（本规则就解释了 DSH Modal 的 1000），按字符切会解析到注释里的数字。
  const ruleStart = styles.indexOf('.dsh-tw-iconpicker {')
  const ruleEnd = styles.indexOf('}', ruleStart)
  assert.ok(ruleEnd > ruleStart, '找不到 .dsh-tw-iconpicker 的规则体 —— 请同步本脚本')
  const rule = styles.slice(ruleStart, ruleEnd)
  // 注释剥掉再解析，避免注释里的数字被当成声明值。
  const declares = rule.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.match(declares, /position:\s*fixed/, '弹层 append 到 body，必须 position:fixed')
  // ── 层级必须真的高过设置弹窗（v0.28.9 真机报障：弹层在设置弹窗「后面」）──
  // 设置页是 DSH 的 Modal，渲染进 portal 且根层 `position:fixed; z-index:1000`
  //（dsh-client-ui-primitives/Modal.module.css）。z-index 只在同一个层叠上下文里
  // 比较，所以"写个 60"看着有值、实际整层被 Modal 盖住。
  // 1100 是 DSH 给「锚点在对话框内部的浮层」定的值（Menu.module.css 的 .portal）。
  const zMatch = /z-index:\s*(\d+)/.exec(declares)
  assert.ok(zMatch !== null, '弹层必须有 z-index（缺了会被设置页内容盖住）')
  const z = Number(zMatch[1])
  assert.ok(
    z >= 1100,
    `图标弹层的 z-index 是 ${z}，不高于 DSH 设置弹窗的 1000 —— 弹层会出现在设置弹窗「后面」（v0.28.9 真机报障，请用 ≥1100）`,
  )

  // 反向：picker 里 make() 出来的每个 dsh-tw-* 类都要在 styles.ts 里有下落。
  // 这是防「下次再加一个子元素、又忘了写 CSS」的通用网。
  const emitted = [...picker.matchAll(/make\('[a-z]+',\s*'([^']+)'/g)]
    .flatMap((m) => m[1].split(/\s+/))
    .filter((c) => c.startsWith('dsh-tw-'))
  const unique = [...new Set(emitted)]
  assert.ok(unique.length >= 6, `从 picker 里解析出的类名太少（${unique.length}）—— 解析方式可能失效了，请同步本脚本`)
  for (const cls of unique) {
    assert.ok(
      styles.includes(`.${cls} `) || styles.includes(`.${cls}{`) || styles.includes(`.${cls} {`)
        || styles.includes(`.${cls},`) || styles.includes(`.${cls}:`) || styles.includes(`.${cls}[`)
        || styles.includes(`.${cls}.`) || styles.includes(`.${cls} >`),
      `picker 生成的 .${cls} 在 styles.ts 里找不到规则（漏写 CSS）`,
    )
  }
})

test('styles.ts 的 CSS_TEXT 必须是一整块、且正文里没有反引号 / ${（本仓库踩过两次）', () => {
  // 为什么值得一条守门：styles.ts 把整份 CSS 放在一个 JS 模板串里，所以
  // CSS 注释里写一个反引号（哪怕只是想给标识符加点行内代码样式）就会让模板串
  // 提前结束、文件后半段变成 JS 源码 → rolldown 报 PARSE_ERROR、typecheck 报
  // TS1005，而 lib/ 此时已被 clean-lib 删掉（构建到一半失败）。
  // 本仓库历史上踩过两次（v0.25.0 注释里引了 .dsh-tw-settings 类名；v0.28.9
  // 我在解释 z-index 层级时又写了一次）。typecheck 当然能抓到，但那是"构建已经
  // 开始"之后；这条守门让它在 verify:unit 阶段、以一句人能看懂的话报出来。
  //
  // ⚠️ 判据必须是「模板串有没有被提前截断」，**不是**「第一个闭引号之前有没有反引号」。
  // 第一版就是这么写的，结果是**结构上不可能抓到目标 bug**：一旦注释里多了一个
  // 反引号，那个反引号本身就变成了 close 的位置，body 在它之前就结束了 ——
  // 于是「body 里没有反引号」永远成立，注入反引号反而让断言更容易通过。
  //（这类"用出错的输入去验证出错的解析器"的假绿，是本仓库最该警惕的一种守门。）
  const raw = readFileSync(path.join(repoRoot, 'src/client/styles-css.ts'), 'utf8')
  const start = raw.indexOf('const CSS_TEXT')
  assert.ok(start > 0, 'styles-css.ts 里找不到 CSS_TEXT —— 请同步本脚本（CSS 正文已从 styles.ts 移到这里）')
  const open = raw.indexOf('`', start)
  assert.ok(open > start, 'CSS_TEXT 的模板串开引号找不到 —— 请同步本脚本')
  const close = raw.indexOf('`', open + 1)
  assert.ok(close > open, 'CSS_TEXT 的模板串闭引号找不到 —— 模板串已经断了')
  const body = raw.slice(open + 1, close)

  // ① 正文必须真的是一整块 CSS：以 CSS 注释开头、以 } 结尾（模板串被提前截断时
  //    这里必然不成立，因为截断点在文件中部、后面还跟着 JS 源码）。
  assert.match(body.trimStart().slice(0, 4), /\/\*/, 'CSS_TEXT 开头不像 CSS 注释 —— 模板串可能被提前截断')
  assert.match(body.trimEnd().slice(-1), /\}/, 'CSS_TEXT 结尾不是 } —— 模板串可能被提前截断（多半是正文里混进了反引号）')

  // ② 闭引号之后紧跟的必须是模块的后续代码，而不是散落的 CSS。
  //    提前截断的签名：闭引号后面很快又出现一段含 `{` 的"裸 CSS"，或 TS1005 那种
  //    形状（`:` / `;` 落在字符串外）。
  const after = raw.slice(close + 1)
  assert.ok(
    /^\s*(\n|\/\*\*|import |export |const |type |interface )/.test(after),
    'CSS_TEXT 闭引号之后不是正常的模块代码 —— 模板串很可能被正文里的反引号提前截断了',
  )

  // ③ 最直接的一条：整个文件里，CSS 正文不该出现 ${（会被当插值）。
  assert.ok(!body.includes('${'), 'CSS_TEXT 正文里有 ${ —— 会被当成插值，请改写措辞（如 $ + {）')
})

test('图标集：host 名单与客户端可渲染集合必须完全一致，且真的用上官方 DSH 图标（v0.28.8，反馈 1）', () => {
  // 需求原文：「配置界面里面给每个 wiki 设置图标时能否使用 dsh 系统中的图标系统…
  // 一个弹出框可以弹出展示系统中所有的图标，太多的话可以考虑分页展示」。
  const registry = readFileSync(path.join(repoRoot, 'src/host/wiki-registry.ts'), 'utf8')
  const generated = readFileSync(path.join(repoRoot, 'src/client/wiki-icon.generated.ts'), 'utf8')
  const icon = readFileSync(path.join(repoRoot, 'src/client/wiki-icon.ts'), 'utf8')
  // 选择器模块（v0.28.8 从 settings-page.ts 拆出）：断言要跟着走，否则读一个
  // 不再含选择器的文件会「断言全过」——正是这条守门要防的静默失效。
  const settings = readFamily(repoRoot, 'src/client/settings-icon-picker')

  // host 是权威名单（值会存进 wikis.json）。
  const namesBlock = registry.slice(registry.indexOf('export const WIKI_ICON_NAMES = ['))
  const hostNames = [...namesBlock.slice(0, namesBlock.indexOf('] as const')).matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.ok(hostNames.length >= 40, `图标名单应有 40+ 项（实际 ${hostNames.length}）`)

  // 客户端可渲染集合 = 生成的官方图形 + 自绘。
  const generatedKeys = [...generated.matchAll(/^\s*"([^"]+)":\s*"/gm)].map((m) => m[1])
  const handDrawn = [...(icon.match(/const HAND_DRAWN: Record<string, string> = \{[\s\S]*?\n\}/)?.[0] ?? '').matchAll(/^\s*(\w+):/gm)].map((m) => m[1])
  const clientNames = new Set([...generatedKeys, ...handDrawn])

  // 双向：host 认的每个名字客户端都得能画（否则静默变默认图标）；客户端有的名字
  // host 也得认（否则用户在网格里点得到、保存时被拒 = 「选了不生效」）。
  const hostOnly = hostNames.filter((n) => !clientNames.has(n))
  const clientOnly = [...clientNames].filter((n) => !hostNames.includes(n))
  assert.deepEqual(hostOnly, [], `host 接受但客户端画不出来的图标：${hostOnly.join(', ')}`)
  assert.deepEqual(clientOnly, [], `客户端能画但 host 不接受的图标：${clientOnly.join(', ')}`)

  // 官方集合必须是**上游真数据**（由生成脚本产出），不是手画的替代品：
  // 判据是生成文件里有明显来自 DSH 的长路径 + 生成器存在 + 出处注释在。
  assert.ok(generatedKeys.length >= 30, `内联的官方图标应 ≥30 个（实际 ${generatedKeys.length}）`)
  assert.match(generated, /GENERATED FILE/, '生成文件必须标明是生成的')
  assert.match(generated, /gen-wiki-icons\.mjs/, '生成文件必须写明再生成命令')
  assert.ok(fs.existsSync(path.join(repoRoot, 'scripts/gen-wiki-icons.mjs')), '生成脚本必须在仓库里（否则数据无法复现）')

  // 分页：作者明确要求「太多的话可以考虑分页展示」。
  assert.match(settings, /ICON_PAGE_SIZE/, '选择器必须有分页常量')
  assert.ok(catalogText().includes('上一页') && catalogText().includes('下一页'), '选择器必须有上一页/下一页（文案在 i18n 目录里）')
  assert.match(settings, /t\('settings\./, '图标选择器的文案必须走 t()')
  // 单页时不显示分页控件（少量图标别多出没用的按钮）。
  assert.match(settings, /if \(pages > 1\)/, '只有超过一页才显示分页控件')
})

test('每库图标：/admin/wikis 的 GET 必须回传 icon（v0.28.8 修「选完立刻变回默认」）', () => {
  // 症状（作者 2026-09-28 报障）：设置页选好图标、服务端也保存了，但界面立刻变回默认。
  // 根因：设置页发的是 `{ action:'update', wiki:{ ...wiki, icon: next } }`，那份 `wiki`
  // 来自 `buildWikisView()`（GET /admin/wikis 的输出）；该函数当初**没有输出 icon**
  // （只有 /status 的 wikiSummaries 有）。于是 `wiki.icon` 恒为 undefined，
  // `normalizeEntry` 见 undefined 就不写该键 → 存成"没设过"，UI 自然回到默认。
  //
  // 这条守门必须是**源码级**的：registry 那层的往返测试全绿也照样漏（icon 本来就
  // 能从文件读回，问题只在 HTTP 视图这一层丢了字段）。
  const index = readFamily(repoRoot, 'src/index')
  const view = index.slice(index.indexOf('const buildWikisView'), index.indexOf('const buildWikisView') + 1600)
  assert.ok(view.length > 200, '找不到 buildWikisView（函数被改名了？请同步这条守门）')
  assert.match(view, /icon: entry\.icon/, 'buildWikisView 必须输出 icon —— 少这一个字段，设置页的图标选择器就永远存不进去')
})

test('hidden 必须真的隐藏：全局兜底一条，不许再逐元素补（踩过 12 次）', () => {
  const styles = readFamily(repoRoot, 'src/client/styles')
  const sidebar = readFileSync(path.join(repoRoot, 'src/client/sidebar-entry.ts'), 'utf8')
  // 根因：hidden 属性在 CSS 里只是 display:none，任何显式 display 都能盖掉它。
  // 本仓库为此在不同元素上各补过一条规则（面板 iframe/错误块、快速笔记、FAB 菜单与
  // 提示、右侧栏、目标库下拉、草稿栏、最近列表…），结果侧边栏入口又栽了一次：
  // 多库模式下默认那行 hidde=true 却照样渲染（作者 2026-09-28 报障）。
  // 必须是一条**独立的元素选择器**（行首直接就是 [hidden]），不是又挂在某个类后面
  assert.match(styles, /(?:^|\n)\s*\[hidden\]\s*\{\s*display:\s*none\s*!important/, '必须有一条全局 [hidden] 兜底（带 !important，否则盖不过组件的 display）')
  // 逐元素版本应当在全局规则之后被清掉，避免下次又有人去补第 13 条
  const perElement = (styles.match(/\.dsh-tw-[a-z-]+\[hidden\]/g) ?? [])
  assert.equal(perElement.length, 0, `不该再有逐元素 [hidden] 规则（发现 ${perElement.join(', ')}）—— 全局那条已经覆盖`)
  // 多库时默认行必须靠 hidden 让位
  assert.match(sidebar, /entry\.hidden = true/, '多库模式下默认行必须隐藏（否则侧边栏多一个没有库名的 TiddlyWiki）')
})

test('设置页每个 per-wiki 面板都必须带作用域（作者 2026-09-28 报障：混在一起管理）', () => {
  const settings = readFamily(repoRoot, 'src/client/settings-page')
  // 症状：多库下「插件管理 / 主题管理 / 语言包 / 初始化」看起来是混在一起管理的。
  // 根因：这些面板各自打一个 admin 端点，但**只有部分调用带了 ?wiki=** —— 没带的
  // 永远落在默认库上，于是"切了库，面板内容却没变"。宿主侧一直是 per-request 的
  // （deps.server(req)/config(req)/getClient(req)），缺的只是客户端这一半。
  for (const ep of ['STATE_ENDPOINT', 'CONFIG_ENDPOINT', 'PROMPT_ENDPOINT', 'INFO_ENDPOINT', 'SEEDS_ENDPOINT', 'SEEDS_RUN_ENDPOINT', 'SEEDS_REMOVE_ENDPOINT']) {
    assert.ok(
      settings.includes(`withWiki(${ep})`),
      `${ep} 必须经 withWiki 带上 ?wiki=<编辑中的库>（否则该面板永远作用于默认库）`,
    )
  }
  // withWiki 本身：单库（editingWiki===undefined）时不得改动 URL —— 现有用户逐字不变
  assert.match(settings, /editingWiki === undefined \? url : `\$\{url\}\?wiki=/, 'withWiki 在未选库时必须原样返回')
})

test('侧边栏入口：只有当前焦点那一行高亮（作者 2026-09-28 报障：点一个三个都选中）', () => {
  const sidebar = readFileSync(path.join(repoRoot, 'src/client/sidebar-entry.ts'), 'utf8')
  const at = sidebar.indexOf('const syncActive = ')
  assert.ok(at > 0, '找不到 syncActive')
  const block = sidebar.slice(at, at + 900)
  // 面板虽然共享，但一次只显示一个库 —— 高亮全部行会让用户以为三个都打开了。
  // 判据：高亮语句必须**被 `mine` 条件包着**；无条件写 dataset.active 就是那个 bug。
  const activeWrites = block.match(/el\.dataset\.active = 'true'/g) ?? []
  assert.ok(activeWrites.length === 1, `高亮语句应恰好一条（实际 ${activeWrites.length}）`)
  assert.ok(/if \(state\.isOpen\(\) && mine\)\s*el\.dataset\.active = 'true'/.test(block),
    '高亮必须同时满足"面板开着"与"这一行是当前焦点库"（无条件高亮正是本次 bug）')
  assert.match(block, /const id = el\.dataset\.wiki/, '高亮必须按该行的 wiki id 判定')
  assert.match(block, /mine/, '必须区分"这一行是不是当前焦点库"')
  assert.match(sidebar, /subscribeFocusWiki\(syncActive\)/, '焦点变化后高亮要重算')
})

test('「侧边栏 TW 入口显示名称」只在单库模式出现（作者 2026-09-28 报障：多库时不该有这个配置）', () => {
  const settings = readFamily(repoRoot, 'src/client/settings-page')
  // 事实依据：多库时侧边栏每个库各占一行、各用自己 wikis.json 的 label，ui.sidebarLabel
  // 只喂单库那一行（sidebar-entry.ts 的 applyLabel，多库时 entry.hidden = true）。
  // 所以多库下露出这个字段 = 一个改了不生效的假配置项。
  const at = settings.indexOf("'ui.sidebarLabel'")
  assert.ok(at > 0, '找不到 ui.sidebarLabel 字段')
  const block = settings.slice(Math.max(0, at - 900), at + 200)
  // 必须在多库分支里被跳过：判据是这段代码里出现了 multi 判定。
  assert.match(block, /rosterMode === 'multi'/, '文本字段必须按模式分支渲染')
  // 精确取 `if (rosterMode === 'multi') { … }` 的花括号体：multi 分支内**不得**出现
  // textField 调用（出现即说明字段又被无条件渲染回去了）。
  const open = settings.indexOf('if (rosterMode === \'multi\') {', at - 900)
  assert.ok(open > 0, '找不到 rosterMode === multi 的分支')
  const bodyStart = settings.indexOf('{', open) + 1
  let depth = 1, i = bodyStart
  while (i < settings.length && depth > 0) {
    const c = settings[i]
    if (c === '{') depth += 1
    else if (c === '}') depth -= 1
    i += 1
  }
  const multiBranch = settings.slice(bodyStart, i - 1)
  assert.ok(!/textField\(/.test(multiBranch), 'multi 分支里不得渲染该文本字段（那样多库仍会看到假配置项）')
  assert.match(multiBranch, /知识库列表/, 'multi 分支要说明去哪儿改显示名，而不是留空')
  // else 分支必须真的渲染字段（别把两边都写成跳过）
  const afterBranch = settings.slice(i, i + 400)
  assert.match(afterBranch, /textField\('ui\.sidebarLabel'/, '单库分支必须仍然渲染该字段')
  // 反向：探模式失败时必须回落成**单库**（`'multi'` 才是显式多库），否则探测一超时
  // 单库用户就找不到设置项。
  assert.match(settings, /let rosterMode: string \| undefined/, '模式变量必须允许 undefined（= 未知）')
  const probe = settings.slice(settings.indexOf('const modePromise'), settings.indexOf('const state = await fetchJson<AdminState>'))
  assert.match(probe, /\.catch\(\(\) => \{ rosterMode = undefined \}\)/, '探测失败必须回落 undefined（按单库），不能按多库')
  // 反向：如果谁把判定改成 `!== 'single'`，未知模式就会被当成多库藏掉字段 —— 抓这个。
  assert.ok(!/rosterMode !== 'single'/.test(settings), '不能用 !== single 判定（未知模式会被误判成多库）')
})

test('设置页分页：多库时按「总览/本库配置/全局」分开，且能退出配置（v0.28.8，反馈 3/4/11）', () => {
  const settings = readFamily(repoRoot, 'src/client/settings-page')

  // ── 反馈 4：改完配置后既看不到「在改哪个库」也退不出去 ──
  // 根因两层：作用域只有一行灰字（列表在页面下方，得往回滚）；且 editingWiki 是
  // 模块级变量，从前**没有任何路径**把它清回默认库 —— 连关掉设置页再打开都还在。
  assert.match(settings, /function renderScopeBar\(/, '必须有常驻的作用域条')
  assert.match(settings, /dsh-tw-settings-scopebar/, '作用域条要有自己的类名（sticky 靠 CSS）')
  assert.ok(catalogText().includes('退出配置'), '必须提供「退出配置」按钮（这是反馈里找不到的出口）——文案现在住在 i18n 目录里')
  assert.match(settings, /editingWiki = undefined/, '退出配置必须把 editingWiki 清回默认库')
  // 「配置」按钮不能再是单程票：从前它 disable 成「正在配置」就再也点不回去了。
  // 开关语义不变，只是两种文案都从目录里取：`configuring ? t('…') : t('…')`。
  assert.match(settings, /configuring[\s\S]{0,240}?t\('settings\.[\s\S]{0,240}?t\('settings\./, '「配置」必须是个开关（可再次点击退出），两种文案都要走 t()')
  assert.ok(
    !/configure\.disabled = configuring/.test(settings),
    '「配置」按钮不得在配置中禁用（禁用 = 没有出口，正是本次反馈）',
  )

  // ── 反馈 3：按库生效的面板在多库时必须先选库才显示 ──
  // 受众是 catalog（插件/主题/语言）+ seeds（初始化）两块：它们已经按库作用域
  // （withWiki 带 ?wiki=），但从前多库下**一直显示**，看着像在改全局。
  assert.match(settings, /renderPickLibraryHint/, '多库未选库时必须给「先去总览选一个」的提示')
  assert.match(settings, /const libraryPicked = !multi \|\| editingWiki !== undefined/, '必须按「多库且已选库」判定是否渲染这些面板')
  const mainAt = settings.indexOf('function renderMain(')
  // 取到下一个顶层函数声明为止（renderMain 后面是 SettingsSection），而不是靠固定
  // 字符数截断 —— 函数体会长，切短了会误报「没被包着」。
  const mainEnd = settings.indexOf('/** React wrapper consumed by the shell', mainAt)
  const main = settings.slice(mainAt, mainEnd > mainAt ? mainEnd : mainAt + 6000)
  assert.match(main, /if \(showLibrary && libraryPicked\)\s*\{[\s\S]*?renderCatalogSection/, 'catalog（插件/主题/语言）必须被这个判定包着')
  assert.match(main, /if \(showLibrary && libraryPicked\)\s*\{[\s\S]*?renderSeedsSection/, 'seeds（初始化）必须被这个判定包着')

  // ── 反馈 11：分类靠 Tab，且单库完全不受影响 ──
  assert.match(settings, /type SettingsTab = 'overview' \| 'library' \| 'global'/, '三个 Tab 的联合类型必须存在')
  assert.match(settings, /function renderTabBar\(/, '必须有 Tab 栏渲染函数')
  // 单库不显示 Tab 栏：`if (mode !== 'multi') return` 是这条的判据（DOM 逐字不变）。
  const tabFn = settings.slice(settings.indexOf('function renderTabBar('), settings.indexOf('function renderTabBar(') + 600)
  assert.match(tabFn, /if \(mode !== 'multi'\) return/, '单库模式不得渲染 Tab 栏（保持平铺、DOM 逐字不变）')
  const scopeFn = settings.slice(settings.indexOf('function renderScopeBar('), settings.indexOf('function renderScopeBar(') + 400)
  assert.match(scopeFn, /if \(mode !== 'multi'\) return/, '单库模式不得渲染作用域条（没有"作用域"可言）')
  // 单库时三块都要渲染（showX 两个条件里的 !multi 分支）。
  assert.match(settings, /const showOverview = !multi \|\| activeTab === 'overview'/, '单库必须始终渲染总览')
  assert.match(settings, /const showGlobal = !multi \|\| activeTab === 'global'/, '单库必须始终渲染全局配置')
  // 点「配置」要跳到「本库配置」，否则那次点击看起来没反应。
  assert.match(settings, /if \(!configuring\) activeTab = 'library'/, '点「配置」应切到「本库配置」页')
})

test('回复流卡片「在 TW 打开」必须带上是哪个库（作者 2026-09-29 报障：跳到最后打开的库）', () => {
  // 症状：多库下点卡片上的「在 TW 打开」（或卡片正文 / 列表行里的链接），面板打开的
  // 是**最后一次看过的那个库**。
  // 根因：卡片把会话作用域（wikiId）塞进了 openTiddler 的事件 detail，但 panel 的
  // 事件处理只读了 title —— 面板与右栏都按**焦点库**加载 `/tw/<id>/`，链接的库被整个
  // 丢掉。附带问题：`undefined` 当时既是"默认库"又是"未指定"，根本区分不开。
  const panel = readFileSync(path.join(repoRoot, 'src/client/panel.ts'), 'utf8')
  const views = readFileSync(path.join(repoRoot, 'src/client/tool-views.ts'), 'utf8')
  const summary = readFileSync(path.join(repoRoot, 'src/client/session-summary.ts'), 'utf8')
  const frame = readFileSync(path.join(repoRoot, 'src/client/tw-frame.ts'), 'utf8')

  // ① 卡片必须说得出"我来自哪个库"：undefined（默认库）要显式传 null，不能省略。
  assert.match(views, /openTiddler\(title, wikiId === undefined \? null : wikiId\)/, '卡片/列表行必须把「默认库」显式传成 null（省略 = 未指定 → 面板留在焦点库上）')
  // ② panel 必须真的读出来，并把焦点库切过去（两个 TW 界面都按焦点库加载）。
  assert.match(panel, /detail\?\.wiki === null/, '必须区分「明确默认库」（null）与「未指定」')
  assert.match(panel, /if \(target !== getFocusWiki\(\)\) setFocusWiki\(target\)/, '链接自带库时必须先把焦点库切过去')
  assert.match(panel, /openTiddlerInLiveTab\(title, wiki\)/, '右栏 TW tab 也要拿到目标库')
  assert.match(panel, /surface\.openTiddler\(title, wiki\)/, '中央面板也要拿到目标库（否则又回落到焦点库）')
  // ③ 内核：换库要先换、再跳 hash —— 否则 hash 落进旧文档，随后整页重载把它吞掉。
  assert.match(frame, /wikiSwitchPending/, '内核必须有「换库进行中」的状态')
  assert.match(frame, /if \(wikiSwitchPending\) return/, '换库未完成时 applyPendingHash 必须等待（不然导航会静默丢失）')
  // ④ 裸 `/tw/#标题` 的链接（Agent 正文、渲染片段）跟随所在卡片 / 汇总面板的库。
  assert.match(views, /closest\('\[data-dsh-tw-wiki\]'\)/, '拦截器必须从所在卡片取库（裸路径 = 默认库别名，照它走会开错库）')
  assert.match(views, /'data-dsh-tw-wiki': wikiId/, '工具卡根节点必须带上本会话的库')
  assert.match(summary, /'data-dsh-tw-wiki': wikiId/, '会话汇总面板同样要带（它的片段里也是裸链接）')
  // ⑤ v0.29.0：**没有显式作用域**时也要能说出那个库 —— 多库下 host 是按"默认库"服务该
  // 会话的，卡片显示的就是它的内容，片段里的裸链接必须开它，而不是跟着 GUI 焦点跑。
  // 判据必须落在 resolveSessionWikiId 的解析上（此前只读 payload.scope，于是这种情况
  // 等于"未指定"，v0.28.11 那类报障只修了一半）。
  const scope = readFileSync(path.join(repoRoot, 'src/client/wiki-scope.ts'), 'utf8')
  assert.match(scope, /payload\?\.mode === 'multi'/, '多库时"没有显式作用域"必须解析成 host 实际服务的那个库')
  assert.match(scope, /payload\?\.resolved\?\.id/, '必须用 host 回传的 resolved.id（而不是自己猜）')
  // ⑥ v0.29.0：切库要立刻重生成会话汇总（它缓存了成品 + 3 分钟节拍，只清 scope 缓存不够）。
  assert.match(summary, /subscribeSessionWikiId\(/, '会话汇总必须订阅作用域变化')
  assert.match(scope, /export function subscribeSessionWikiId/, '作用域模块必须提供订阅出口')
})

test('「默认库」不得作为选项名出现：默认的那个库要用它自己的显示名（作者 2026-09-29）', () => {
  // 需求原文：「设置了默认库之后，在其他所有的地方不出现默认库的字样，而是取而代之的是
  // 被设置成默认库的真实库名，比如开启会话时默认选中的就是被设置成默认库的库，而不是
  // 显示默认库这个选项，这个选项都不该在下拉列表中出现」。
  //
  // 判据只看**代码里的字符串**（注释当然可以、也必须讲这段历史），所以先把注释剥掉：
  // 这些模块的说明里到处都有「默认库」这个词。
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '')
  const files = {
    wikiScopeDock: readFileSync(path.join(repoRoot, 'src/client/wiki-scope-dock.ts'), 'utf8'),
    noteWidget: readFileSync(path.join(repoRoot, 'src/client/note-widget.ts'), 'utf8'),
    settingsConfig: readFileSync(path.join(repoRoot, 'src/client/settings-page-config.ts'), 'utf8'),
    settingsWikis: readFileSync(path.join(repoRoot, 'src/client/settings-page-wikis.ts'), 'utf8'),
  }
  for (const [name, src] of Object.entries(files)) {
    assert.ok(
      !/默认库/.test(strip(src)),
      `${name} 的界面文案里仍然出现「默认库」这个字样 —— 应当直接给出被设为默认的那个库的真实显示名（可加「（默认）」身份标记）`,
    )
  }

  // 会话选择器三条落地判据（它是最要命的一处：新会话默认选中的就是那个库）。
  const dock = files.wikiScopeDock
  assert.match(dock, /readResolvedWiki/, '必须读 /session/wiki 的 resolved（默认库的真实 id 与 label）')
  assert.ok(catalogText().includes('（默认）'), '默认库那一项必须带「（默认）」身份标记（否则用户不知道哪个是默认）')
  assert.match(dock, /t\('chrome\.|（默认）/, '选择器文案必须走 t()（或仍处于待转换状态，见 verify-client-i18n.mjs 的 PENDING_CONVERSION）')
  assert.match(dock, /const selected = scope\.length > 0 && listed\(scope\) \? scope : defaultId/, '没显式选过时必须显示默认库（而不是空白/无名占位）')
  assert.match(dock, /const wanted = next === defaultId \? '' : next/, '选中默认那一项 = 清空显式作用域（仍然跟随默认，默认改了也跟着走）')

  // 快速笔记卡片：那个 value='' 的占位选项必须已经删掉；默认库只标身份，不改名。
  assert.ok(!/fallback\.textContent = '默认库'/.test(files.noteWidget), '快速笔记卡片不得再有名为「默认库」的选项')
  assert.match(files.noteWidget, /const mark = item\.id === default(Wiki)?Id \? [^\n]*(t\('note\.|'（默认）')/, '卡片里的默认库同样只加身份标记（文案来自目录）')

  // 设置页剪藏目标：空值那一项改名成默认库的显示名，且默认库不得在同一个下拉里出现两次。
  assert.match(files.settingsConfig, /placeholder\.textContent = [^\n]*(t\('config\.|（默认）)/, '剪藏目标下拉里空值那一项必须改名成默认库的显示名（后缀文案来自目录）')
  assert.match(files.settingsConfig, /if \(wiki\.id === view\.defaultId\) continue/, '默认库由空值那一项代表，不得再单独列一遍（否则同一个库出现两次）')
  // 单库模式那个单选与确认框同样直呼其名。
  // 规则不变（必须写出默认库的名字），但文案来自目录 ⇒ 断言「目录里有带 {name} 的模板」+「调用点传了 name」。
  assert.ok(catalogText().includes('单库（只跑 {name}）'), '「单库」模式文案必须带 {name} 占位符（文案在 i18n 目录里）')
  assert.ok(catalogText().includes('除 {name} 外'), '切单库的确认文案必须带 {name} 占位符')
  assert.match(files.settingsWikis, /t\('settings\.wikis\.(modeSingle|switchToSingle)',\s*\{\s*name/, '切单库/单库文案必须把默认库的名字传进 t()')
})

test('侧边栏多库入口：点另一个库 = 切换，不是关面板（作者 2026-09-29 报障「要点击两次才能切库」）', () => {
  // 症状原文：「左侧多 wiki 入口，有时候感觉要点击两次才能切换到对应的库」。
  // 根因：入口行的点击**一律**走 `state.toggle()` —— 面板开着 A 时点 B，`setFocusWiki(B)`
  // 确实把焦点换过去了（内核也开始换库），但**同一击**里的 toggle 又把面板关掉：用户看到的
  // 只是"面板没了"，得再点一次才看到 B。开着面板时点另一个库，用户要的是切换，不是关面板。
  //
  // 判定表直接跑真源码（纯函数，Node 里能验 —— 比"源码里有某个字符串"强得多）：
  assert.equal(resolveEntryClick({ open: false, wikiId: 'b', shown: 'a' }), 'open', '面板关着时点哪个库就开哪个库')
  assert.equal(
    resolveEntryClick({ open: true, wikiId: 'b', shown: 'a' }),
    'switch',
    '面板开着 A 时点 B 必须是「切换」（面板保持打开）—— 判成 close 就是本次报障',
  )
  assert.equal(resolveEntryClick({ open: true, wikiId: 'a', shown: 'a' }), 'close', '点当前显示的那个库 = 收起（入口同时也是开关）')
  // 焦点还没显式设过时 shown 解析成**默认库**（不是"第一行"）：点默认库那行同样收起。
  assert.equal(resolveEntryClick({ open: true, wikiId: 'work', shown: 'work' }), 'close')
  // 名册还没到 / 解析不出时：只有"就是同一个 id"才算收起，别的一律切换（保守但不会误关面板）。
  assert.equal(resolveEntryClick({ open: true, wikiId: 'a', shown: undefined }), 'switch')
  // 单库那一行没有 wikiId：逐字保留原来的 toggle 语义 —— 单库安装行为不变。
  assert.equal(resolveEntryClick({ open: true, wikiId: undefined, shown: undefined }), 'close', '单库：开着再点 = 收起')
  assert.equal(resolveEntryClick({ open: false, wikiId: undefined, shown: undefined }), 'open', '单库：关着点 = 打开')

  const sidebar = readFileSync(path.join(repoRoot, 'src/client/sidebar-entry.ts'), 'utf8')
  // 点击处理必须走这个判定（三处入参都要在）。
  assert.match(
    sidebar,
    /resolveEntryClick\(\{ open: hooks\.state\.isOpen\(\), wikiId, shown: hooks\.shownWiki\(\) \}\)/,
    '点击入口行必须走共享判定 resolveEntryClick',
  )
  // 顺序：判定必须在 setFocusWiki **之前**。反过来的话，刚切过去的库会被当成"面板此刻
  // 显示的就是它" → 判成 close → 又回到"点两次才能切库"（纯文本断言抓不到，靠行为断言）。
  const sideCode = sidebar.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '')
  const decideAt = sideCode.indexOf('resolveEntryClick({ open: hooks.state.isOpen()')
  const focusAt = sideCode.indexOf('setFocusWiki(wikiId)')
  assert.ok(decideAt > 0 && focusAt > decideAt, '判定必须在 setFocusWiki 之前求值（顺序反了就永远判成 close）')
  // 反向断言：入口行不得再无条件 toggle —— 那正是「点两次才能切库」的成因。
  // ⚠️ 必须**先剥掉注释**再断言：这段历史的说明本来就该提到 `state.toggle()`
  //（本仓库最该警惕的假绿就是"用注释里的词去判断代码行为"，反之亦然）。
  assert.ok(
    !/\.toggle\(\)/.test(sideCode),
    '入口行不得再无条件 toggle()（面板开着时点另一个库会先把它关掉 = 要点两次才能切库）',
  )
  // 高亮与点击判定必须**同源**：都是 shownWiki()。两处各算一套就会出现
  // 「高亮的那一行点一下反而把面板关掉 / 没高亮的那行点一下变成关闭」。
  assert.match(sidebar, /const focus = shownWiki\(\)/, '高亮必须用同一个解析（shownWiki）')
  assert.match(
    sidebar,
    /const shownWiki = \(\): string \| undefined => resolveFocusWiki\(rosterAll, defaultWikiId\)/,
    'shownWiki 必须把默认库一起交给 resolveFocusWiki —— 旧实现传 undefined，焦点未设时会高亮第一行而不是默认库',
  )
  assert.match(sidebar, /defaultWikiId = payload\?\.defaultId/, '名册里的默认库必须存下来供点击判定用')
  // v0.29.0：解析必须用**完整名册**（含未运行的库），与面板/内核同源。用"在运行的那些"
  // 时，焦点库只是没在跑（还没起来 / 刚被停）就会回落到默认库 —— 高亮行 ≠ 面板显示的库，
  // 点那一行还会被判成"切换"而不是收起（v0.28.13 修的是同一判定链上的另一个来源）。
  assert.match(sidebar, /rosterAll = list/, 'shownWiki 必须按完整名册解析（不只是"在运行的"）')
  assert.ok(
    !/resolveFocusWiki\(runningWikis/.test(sidebar),
    'shownWiki 不得再用"在运行的名册"解析（焦点库没在跑时会高亮错行）',
  )
})

test('侧边栏多库入口（行为级）：面板开着时点另一个库，面板必须保持打开且焦点已切过去', () => {
  // 上面那条断的是"判定表"，这条断的是**真副作用**：用真的 PanelState + 真的焦点存储
  // （setFocusWiki 会写 localStorage），走的是线上同一个 applyEntryClick。
  setFocusWiki('a')
  const roster = [{ id: 'a' }, { id: 'b' }]
  const state = new PanelState()
  const shown = () => resolveFocusWiki(roster, 'a')
  state.openPanel()

  // ① 本次报障的场景：面板开着 A，点 B —— 面板必须还是开着的（旧实现这里变成 false）。
  assert.equal(applyEntryClick({ state, shownWiki: shown }, 'b'), 'switch')
  assert.equal(state.isOpen(), true, '点另一个库把面板关掉了 = 「要点击两次才能切库」')
  assert.equal(getFocusWiki(), 'b', '焦点必须已经切到 B（内核据此重载 /tw/b/）')

  // ② 再点一次"当前显示的那个库" = 收起（入口也是开关）。
  assert.equal(applyEntryClick({ state, shownWiki: shown }, 'b'), 'close')
  assert.equal(state.isOpen(), false)
  assert.equal(getFocusWiki(), 'b', '收起面板不该改焦点')

  // ③ 关着的时候点任意库 = 打开它。
  assert.equal(applyEntryClick({ state, shownWiki: shown }, 'a'), 'open')
  assert.equal(state.isOpen(), true)
  assert.equal(getFocusWiki(), 'a')

  // ④ 单库那一行（没有 wikiId）：焦点不动，纯粹开关（单库安装行为逐字不变）。
  const before = getFocusWiki()
  assert.equal(applyEntryClick({ state, shownWiki: shown }, undefined), 'close')
  assert.equal(state.isOpen(), false)
  assert.equal(applyEntryClick({ state, shownWiki: shown }, undefined), 'open')
  assert.equal(state.isOpen(), true)
  assert.equal(getFocusWiki(), before, '单库那一行不得碰焦点库')

  // ⑤ 面板开着、焦点库就是默认库（记忆值已被清空）时点默认库那一行 = 收起，
  //    不能因为"焦点没显式设过"就误判成切换（那会让用户按不上面板）。
  setFocusWiki(undefined)
  const state2 = new PanelState()
  const shown2 = () => resolveFocusWiki(roster, 'a')
  state2.openPanel()
  assert.equal(applyEntryClick({ state: state2, shownWiki: shown2 }, 'a'), 'close', '焦点未设过时，默认库那一行就是"当前显示的那个库"')
  assert.equal(state2.isOpen(), false)
  // 反过来：真正的另一个库仍然要判成切换。
  assert.equal(applyEntryClick({ state: state2, shownWiki: shown2 }, 'b'), 'open', '面板已关，点 B = 打开 B')
  assert.equal(state2.isOpen(), true)
})

test('切库不再"卡一下"：立即换文档 + 焦点只重画高亮 + 换库提示必须有 CSS（v0.28.14）', () => {
  // 症状（作者报障）：「点击切换感觉会卡那么一下」。两段来源：
  // ① 旧实现只调 doRefresh()，而它**先等一次 /status 往返** —— host 处理一次 /status 要跑
  //    最多 5 个 git 进程（本机实测 300–400ms），于是"点下去"到"真的开始换"之间是空的；
  // ② 换文档 = 重新下载整份 wiki（本机实测 9.9MB / 29.9MB / 28MB，TW 自己回 no-store、
  //    没有 ETag，缓存不了也预取不了）。② 是固有的，① 可以去掉；同时 ② 必须给可见说明。
  const sidebar = readFileSync(path.join(repoRoot, 'src/client/sidebar-entry.ts'), 'utf8')
  const frame = readFileSync(path.join(repoRoot, 'src/client/tw-frame.ts'), 'utf8')
  const panel = readFileSync(path.join(repoRoot, 'src/client/panel.ts'), 'utf8')
  const styles = readFamily(repoRoot, 'src/client/styles')

  // ① 内核：焦点一变必须**立即**换（复用上一次 /status 的 payload），再后台复探。
  //    判据是顺序 —— switchFrameNow() 必须在同一个订阅里、且早于 doRefresh()。
  const at = frame.indexOf('const unsubscribeFocus = subscribeFocusWiki(')
  assert.ok(at > 0, '找不到内核的焦点订阅 —— 请同步这条守门')
  const sub = frame.slice(at, frame.indexOf('\n  })', at))
  assert.match(sub, /switchFrameNow\(\)/, '焦点变化必须走 switchFrameNow（不再等 /status 往返）')
  assert.ok(
    sub.indexOf('switchFrameNow()') < sub.indexOf('doRefresh()'),
    '先立即换、再后台复探；顺序反了就又回到"点下去先空 0.3–0.4 秒"',
  )
  assert.ok(!/await/.test(sub), '这个订阅里不许出现 await（同步就该把 iframe 指过去）')
  assert.match(frame, /const switchFrameNow = \(\): void =>/, '立即换库必须收成一个同步函数')
  assert.match(frame, /lastStatus = payload/, '要留住最近一次 /status 的 payload（换库靠它算地址，不再打一次）')

  // ② 侧边栏：焦点变化只重画高亮。旧实现是再跑一遍 applyRoster()，那会**再打一次 /status**
  //    并把所有行重建一遍 —— 名册没变，变的只是哪一行亮着。
  //    ⚠️ 反断言必须跑在**剥掉注释**的代码上：上面那段历史的说明里就写着旧写法（本仓库的
  //    老教训：拿注释里的词判断代码行为，必假绿）。
  const sidebarCode = sidebar.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '')
  assert.match(sidebar, /subscribeFocusWiki\(paintFocus\)/, '焦点变化只重画高亮（paintFocus）')
  assert.ok(
    !/subscribeFocusWiki\(\(\) => \{ void applyRoster\(\) \}\)/.test(sidebarCode),
    '不许在焦点变化时重跑名册：那会再打一次 /status（host 每次要跑最多 5 个 git 进程）',
  )
  assert.match(sidebar, /const paintFocus = \(\): void =>/, '高亮重画要收在一个函数里，供 applyRoster 与焦点订阅共用同一条真相')

  // ③ 换库提示：DOM 与 CSS 两边都必须在场。
  //    本仓库的血债（v0.28.9）：只有 DOM 没有 CSS = 用户看到的是"点了没反应"。
  assert.match(frame, /loading: string/, '皮肤必须声明换库提示的类名')
  assert.match(frame, /正在载入知识库「\$\{label\}」…/, '提示必须写清正在载入的是哪个库（id 对用户没有意义）')
  assert.match(panel, /loading: 'dsh-tw-loading'/, '中央面板的皮肤必须带上提示类名')
  assert.match(frame, /loading: 'dsh-tw-loading'/, '右侧栏的皮肤同样（两个 TW 界面共用这一条提示）')
  assert.match(
    styles,
    /\.dsh-tw-loading \{/,
    'styles.ts 里必须有 .dsh-tw-loading 的规则 —— 只有 DOM 没有 CSS 就是看不见（v0.28.9 的教训）',
  )
  // 兜底：load 一直不来时提示要能自己收起（否则永久挂着"正在载入"）。
  assert.match(frame, /switchTimer = window\.setTimeout\([\s\S]{0,80}hideSwitching\(\)/, '提示必须有超时兜底')
  assert.match(frame, /clearSwitchTimer\(\)/, 'dispose 要回收那个计时器')
})

console.log(failures === 0 ? '\nWIKI FOCUS CHECKS OK' : `\nWIKI FOCUS CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

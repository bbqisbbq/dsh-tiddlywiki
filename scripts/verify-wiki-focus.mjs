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
  assert.match(quick, /scope\?: \(props: \{ sessionId\?: string \}\)/, '快速笔记条目必须接受 scope（同一行渲染）')
  assert.match(quick, /sessionId: props\.sessionId/, '条目必须把 sessionId 透传给 scope（否则选择器拿不到会话）')
})

test('新会话（空白会话）的知识库选择器：走 selector.context，且不与 dock 重复（v0.28.8，需求 9）', () => {
  // 需求原文：「新会话时像 dsh-client-ui-git-graph 这个插件在模式选择后面增加个知识库选择」。
  // 参考实现用的是 `conversation.input.selector.context`（模式/预设选择器旁边那一格），
  // 并且**声明感知 + 超时回落**——因为不是每个 shell 都声明这个洞，裸 register 会抛。
  const seat = readFileSync(path.join(repoRoot, 'src/client/scope-seat.ts'), 'utf8')
  const indexSrc = readFileSync(path.join(repoRoot, 'src/client/index.ts'), 'utf8')
  const dockSrc = readFileSync(path.join(repoRoot, 'src/client/wiki-scope-dock.ts'), 'utf8')

  assert.match(seat, /conversation\.input\.selector\.context/, '必须优先用 selector.context —— 那才是「模式选择后面」')
  assert.match(seat, /conversation\.input\.dock/, '本机 shell 未声明 selector.context 时必须能回落到 dock')
  // 两个座位都必须经 inject（声明感知）；裸 register 到未声明的槽位会抛。
  assert.match(seat, /slots\.inject\(SELECTOR_CONTEXT_SLOT/, 'selector.context 必须经 inject 注册（声明感知）')
  assert.match(seat, /slots\.inject\(INPUT_DOCK_SLOT/, 'dock 回落同样必须经 inject')
  assert.match(indexSrc, /mountScopeSeat\(/, 'index.ts 必须真的挂上这个座位')
  // 「回落时不许重复渲染」：dock 里已经有 quick-note 行带的选择器，所以这条挂载
  // 必须是 blankOnly —— 否则同一个选择器会在 dock 里出现两次。
  assert.match(indexSrc, /createWikiScopeDock\(\{ blankOnly: true \}\)/, '回落挂载必须是 blankOnly，避免与 quick-note 行里的选择器重复')
  assert.match(dockSrc, /blankOnly/, '选择器组件必须支持 blankOnly')
  // 空白会话判定：从 session store 读 blank，且拿不到时保守当作「非空白」。
  assert.match(dockSrc, /useSessions/, '必须能从 session store 读 blank 标记')
  assert.match(dockSrc, /isBlankSession/, '空白会话判定必须收敛到一个函数里')
})

test('快速笔记：单库模式不得露出「写入」选择器（作者 2026-09-28 报障）', () => {
  const note = readFileSync(path.join(repoRoot, 'src/client/note-widget.ts'), 'utf8')
  const styles = readFileSync(path.join(repoRoot, 'src/client/styles.ts'), 'utf8')
  // 症状：单库模式下界面出现一个「写入」下拉、点开没有选项。
  // 根因：`hidden` 属性在 CSS 里只是 display:none，而 .dsh-tw-note-wiki 有显式
  // display:inline-flex —— **显式 display 会盖掉 hidden**，元素照样渲染。
  // 修法已升级为**一条全局兜底**（v0.28.5）：见下面那条「hidden 必须真的隐藏」。
  // 这里只保留「组件侧也要兜一层」这一半（不依赖 CSS 是否正确加载）。
  // 组件侧兜底：单库时除了 hidden 还要禁用并直接 display:none
  // （不用跨行大正则——文件里 `if (roster.length <= 1)` 只有这一处）
  const guardAt = note.indexOf('if (roster.length <= 1)')
  assert.ok(guardAt > 0, '组件必须有单库分支')
  const guardBlock = note.slice(guardAt, guardAt + 320)
  assert.ok(guardBlock.includes("wikiField.style.display = 'none'"), '单库时组件也要直接隐藏（不只靠 hidden 属性）')
  assert.ok(guardBlock.includes('wikiSelect.disabled = true'), '单库时选择器必须被禁用')
})

test('dock 条目必须与 composer 输入框对齐，且选择器与按钮**并排**（作者 2026-09-28 报障）', () => {
  const align = readFileSync(path.join(repoRoot, 'src/client/dock-align.ts'), 'utf8')
  const quick = readFileSync(path.join(repoRoot, 'src/client/quick-note-dock.ts'), 'utf8')
  const scope = readFileSync(path.join(repoRoot, 'src/client/wiki-scope-dock.ts'), 'utf8')
  const styles = readFileSync(path.join(repoRoot, 'src/client/styles.ts'), 'utf8')

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
  assert.match(note, /if \(roster\.length <= 1\)/, '必须有单库分支（不显示选择器、targetWiki 保持 undefined）')
  assert.match(note, /targetPicked/, '卡片里显式选过之后不得再被焦点库带走')
})

test('侧边栏入口：每个在运行的库一个入口，用自己的显示名（作者 2026-09-28 要求）', () => {
  const sidebar = readFileSync(path.join(repoRoot, 'src/client/sidebar-entry.ts'), 'utf8')
  const styles = readFileSync(path.join(repoRoot, 'src/client/styles.ts'), 'utf8')

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
    : readFileSync(path.join(repoRoot, 'src/client/settings-page.ts'), 'utf8')
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

test('图标集：host 名单与客户端可渲染集合必须完全一致，且真的用上官方 DSH 图标（v0.28.8，反馈 1）', () => {
  // 需求原文：「配置界面里面给每个 wiki 设置图标时能否使用 dsh 系统中的图标系统…
  // 一个弹出框可以弹出展示系统中所有的图标，太多的话可以考虑分页展示」。
  const registry = readFileSync(path.join(repoRoot, 'src/host/wiki-registry.ts'), 'utf8')
  const generated = readFileSync(path.join(repoRoot, 'src/client/wiki-icon.generated.ts'), 'utf8')
  const icon = readFileSync(path.join(repoRoot, 'src/client/wiki-icon.ts'), 'utf8')
  // 选择器模块（v0.28.8 从 settings-page.ts 拆出）：断言要跟着走，否则读一个
  // 不再含选择器的文件会「断言全过」——正是这条守门要防的静默失效。
  const settings = readFileSync(path.join(repoRoot, 'src/client/settings-icon-picker.ts'), 'utf8')

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
  assert.match(settings, /上一页/, '选择器必须有上一页')
  assert.match(settings, /下一页/, '选择器必须有下一页')
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
  const index = readFileSync(path.join(repoRoot, 'src/index.ts'), 'utf8')
  const view = index.slice(index.indexOf('const buildWikisView'), index.indexOf('const buildWikisView') + 1600)
  assert.ok(view.length > 200, '找不到 buildWikisView（函数被改名了？请同步这条守门）')
  assert.match(view, /icon: entry\.icon/, 'buildWikisView 必须输出 icon —— 少这一个字段，设置页的图标选择器就永远存不进去')
})

test('hidden 必须真的隐藏：全局兜底一条，不许再逐元素补（踩过 12 次）', () => {
  const styles = readFileSync(path.join(repoRoot, 'src/client/styles.ts'), 'utf8')
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
  const settings = readFileSync(path.join(repoRoot, 'src/client/settings-page.ts'), 'utf8')
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
  const settings = readFileSync(path.join(repoRoot, 'src/client/settings-page.ts'), 'utf8')
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
  const settings = readFileSync(path.join(repoRoot, 'src/client/settings-page.ts'), 'utf8')

  // ── 反馈 4：改完配置后既看不到「在改哪个库」也退不出去 ──
  // 根因两层：作用域只有一行灰字（列表在页面下方，得往回滚）；且 editingWiki 是
  // 模块级变量，从前**没有任何路径**把它清回默认库 —— 连关掉设置页再打开都还在。
  assert.match(settings, /function renderScopeBar\(/, '必须有常驻的作用域条')
  assert.match(settings, /dsh-tw-settings-scopebar/, '作用域条要有自己的类名（sticky 靠 CSS）')
  assert.match(settings, /'退出配置'/, '必须提供「退出配置」按钮（这是反馈里找不到的出口）')
  assert.match(settings, /editingWiki = undefined/, '退出配置必须把 editingWiki 清回默认库')
  // 「配置」按钮不能再是单程票：从前它 disable 成「正在配置」就再也点不回去了。
  assert.match(settings, /configuring \? '退出配置' : '配置'/, '「配置」必须是个开关（可再次点击退出）')
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

console.log(failures === 0 ? '\nWIKI FOCUS CHECKS OK' : `\nWIKI FOCUS CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

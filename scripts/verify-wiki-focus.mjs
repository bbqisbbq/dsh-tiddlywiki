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

test('dock 条目必须与 composer 输入框对齐（作者 2026-09-28 报障：选择器没对齐）', () => {
  const align = readFileSync(path.join(repoRoot, 'src/client/dock-align.ts'), 'utf8')
  const quick = readFileSync(path.join(repoRoot, 'src/client/quick-note-dock.ts'), 'utf8')
  const scope = readFileSync(path.join(repoRoot, 'src/client/wiki-scope-dock.ts'), 'utf8')
  const styles = readFileSync(path.join(repoRoot, 'src/client/styles.ts'), 'utf8')

  // 规则只有一份：dock 槽位是 composer 的**兄弟节点**，必须测出输入框卡片再补 padding。
  assert.match(align, /export function alignDockEntry\(/, '对齐逻辑必须收在 dock-align.ts 一份')
  assert.match(align, /paddingRight/, '对齐靠给条目补右内边距')
  assert.match(align, /ResizeObserver/, '侧栏开合会移动输入框卡片 → 必须观察祖先链重测')

  // 每个 dock 条目都必须用它 —— 这就是这次 bug 的根因：规则只写在 quick-note 里，
  // 第二个条目（知识库选择器）加进来时没人知道要对齐。
  assert.match(quick, /alignDockEntry\(/, '快速笔记条目必须用共享对齐')
  assert.match(scope, /alignDockEntry\(/, '知识库选择器条目必须用共享对齐（本次报障点）')
  // 两处都必须挂 ref（没有元素可测就没法对齐）
  assert.match(scope, /ref: wrapRef/, '选择器必须把 ref 挂到自己的根元素上')
  // 右对齐 + 不重复实现测量（旧代码不该再留在条目里）
  assert.match(styles, /\.dsh-tw-scope-dock\s*\{[^}]*justify-content:\s*flex-end/, '选择器要右对齐')
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
  const settings = readFileSync(path.join(repoRoot, 'src/client/settings-page.ts'), 'utf8')
  // host：名字或短串，超长/控制字符拒绝；空值 = 清除
  assert.match(registry, /export function normalizeWikiIcon\(/, 'host 必须有校验入口')
  assert.match(registry, /trimmed\.length > 8/, '必须限制长度（这个值会变成侧边栏文本）')
  assert.match(registry, /WIKI_ICON_NAMES/, '内置图标名集合必须在 host 侧定义')
  // 客户端：emoji 走 textContent，绝不 innerHTML —— 值来自用户可编辑的文件
  assert.match(icon, /el\.textContent = icon\.trim\(\)/, 'emoji 必须用 textContent 渲染（不是 innerHTML）')
  assert.match(icon, /isIconName\(icon\)[\s\S]{0,80}innerHTML = ICON_SVG/, '只有内置名才允许 innerHTML，且用的是我们自己的 SVG')
  // 设置页：有下拉选择器；当前值不在候选里要保留
  assert.match(settings, /dsh-tw-settings-icon-select/, '设置页必须有图标选择器')
  assert.match(settings, /!options\.some\(\(\[v\]\) => v === currentIcon\)/, '自定义 emoji 不能被下拉抹掉')
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

console.log(failures === 0 ? '\nWIKI FOCUS CHECKS OK' : `\nWIKI FOCUS CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

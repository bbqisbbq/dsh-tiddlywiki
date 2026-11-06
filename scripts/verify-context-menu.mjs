#!/usr/bin/env node
/**
 * 「会话右键菜单」与「设置分区图标」这两条**宿主新座位/新服务**的接线守门
 * （v0.35.0，DSH 0.2.2）。
 *
 * WHY THIS EXISTS
 * ---------------
 * 这两条都用的是 DSH 0.2.2 才有的东西：
 *   · `contextMenus` 服务（`client-ui-context-menu` 用 `ctx.provide('contextMenus', …)` 提供）
 *   · `settings.section.icon` 座位（`list`，宿主按 `id` 精确匹配导航行）
 * 它们**都不能进 `dsh.client.inject`**（那是静态数组，写进去就成了"没有该服务/座位
 * 就整个插件不加载"），所以只能靠 `ctx.get()` 的可选读法 + 有限重试。这条「必须可选」
 * 的规则没有任何类型能表达 —— 只有这里能钉住。
 *
 * 第二个真正会咬人的地方是**同步预算**：宿主的 provider `resolve()` 可以返回 Promise，
 * 但那被 `resolutionTimeoutMs`（默认 1000ms）竞速，超时后宿主会自己弹「操作失败」。
 * 所以我们的 resolver 一旦 `await` 一次网络（`/status` 或 `/session/wiki`），用户看到的
 * 就是一条毫无头绪的失败提示。这个文件把「resolver 里不许 await、不许 fetch」变成断言。
 *
 * 第三个是**成对注册的 id**：`settings.section` 与 `settings.section.icon` 是两条独立
 * 注册，宿主用 `only: row.id` 精确过滤。两处各写一遍字面量 ⇒ 改一个忘一个 ⇒ 分区
 * 静默变成宿主的默认齿轮，没有任何报错。现在两处共用 `SETTINGS_SECTION_ID`，本守门
 * 断言"两处都用常量、且代码里不再出现 `id: 'dsh-tiddlywiki'` 字面量"。
 *
 * 纯源码级、只读、零网络、零 DOM：客户端是 React + 浏览器服务，node 里跑不起来，
 * 所以这里断的是**形状**（谁在读服务、resolver 里有没有 await、阈值写成什么）。
 *
 *   node scripts/verify-context-menu.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-context-menu
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8')

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

/** 去掉注释 —— 「定位函数体 + 取窗口」的断言必须在剥注释的源码上跑。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
}

/**
 * 取 `export function <name>(` 的**函数体**（不含签名）。
 *
 * 先按括号配对越过参数表，再从紧随其后的第一个 `{` 开始按花括号配对 —— 签名里
 * 可能有对象类型（`{ ... }`），从签名里找第一个 `{` 会落在参数内部，取出一段假的
 * 函数体（这个坑仓库里踩过：断言被自己的签名满足）。
 */
function functionBody(source, name) {
  const at = source.indexOf(`function ${name}(`)
  assert.ok(at >= 0, `源码里找不到 function ${name}(`)
  let i = source.indexOf('(', at)
  let depth = 0
  for (; i < source.length; i++) {
    const c = source[i]
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) { i++; break } }
  }
  let start = source.indexOf('{', i)
  assert.ok(start >= 0, `${name} 没有函数体`)
  depth = 0
  for (let j = start; j < source.length; j++) {
    const c = source[j]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return source.slice(start + 1, j) }
  }
  throw new Error(`${name} 的函数体没有闭合`)
}

/** 取一次 `xxx.register({ … })` 调用的对象字面量文本（用于断言注册选项）。 */
function registerCallBlock(source, name) {
  const at = source.indexOf(`name: '${name}'`)
  assert.ok(at >= 0, `找不到对 ${name} 的注册`)
  const open = source.lastIndexOf('{', at)
  assert.ok(open >= 0, `${name} 的注册缺少选项对象`)
  let depth = 0
  for (let j = open; j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') { depth--; if (depth === 0) return source.slice(open, j + 1) }
  }
  throw new Error(`${name} 的注册选项没有闭合`)
}

const menuSrc = stripComments(read('src/client/session-menu.ts'))
const menuRaw = read('src/client/session-menu.ts')
const indexSrc = stripComments(read('src/client/index.ts'))
const indexRaw = read('src/client/index.ts')
const iconSrc = stripComments(read('src/client/settings-section-icon.ts'))
const iconRaw = read('src/client/settings-section-icon.ts')
const switcherRaw = read('src/client/session-wiki.ts')
const dockRaw = read('src/client/wiki-scope-dock.ts')

// ── 1. contextMenus 必须是可选读法，绝不进 inject ────────────────────────────

test('contextMenus 走 ctx.get 的可选读法（不进 dsh.client.inject）', () => {
  assert.match(
    menuSrc,
    /get\('contextMenus'\)/,
    'session-menu.ts 必须用 get(\'contextMenus\') 读服务 —— 那是可选读法，服务缺席时只是没有这一行菜单',
  )
  // `ctx.contextMenus` / `ctx.get('contextMenus')!` 这类"假定它一定在"的写法一律拒绝。
  assert.ok(
    !/\bctx\.contextMenus\b/.test(menuSrc),
    'session-menu.ts 不得直接摸 ctx.contextMenus（那是 inject 之后的形态，我们没声明它）',
  )
  const injectLine = indexSrc.match(/export const inject: string\[\] = (\[[^\]]*\])/)
  assert.ok(injectLine !== null, 'index.ts 找不到 inject 声明')
  assert.ok(
    !injectLine[1].includes('contextMenus'),
    `inject 里出现了 contextMenus：${injectLine[1]} —— 它会让整个插件在没有该服务的宿主上不加载`,
  )
  // 接线必须把 ctx.get 传进去（不是把 ctx 整个传进去，那样模块就能绕过可选读法）。
  assert.match(
    indexSrc,
    /registerSessionWikiMenu\(ctx\.get\)/,
    'index.ts 必须把 ctx.get 交给 registerSessionWikiMenu（模块自己不许碰 ctx）',
  )
})

test('服务晚到时有界重试（不是查一次就放弃）', () => {
  assert.match(menuSrc, /attempts >= 40/, '必须有一个明确的重试上限（本仓库的既有做法是 250ms × 40 ≈ 10s）')
  assert.match(menuSrc, /setTimeout\(attempt, 250\)/, '重试间隔必须是有限轮询，不是无限循环')
  assert.match(menuSrc, /clearTimeout\(timer\)/, '重试定时器必须能被 disposer 回收（否则卸载后还在跑）')
})

// ── 2. resolver 必须同步：不许 await、不许 fetch ─────────────────────────────

test('菜单 resolver 全程同步：函数体里没有 await / fetch / 网络调用', () => {
  const body = functionBody(menuSrc, 'sessionWikiMenuActions')
  assert.ok(body.length > 200, `sessionWikiMenuActions 的函数体只取到 ${body.length} 字符 —— 抽取逻辑可能失效了`)
  assert.ok(!/\bawait\b/.test(body), 'resolver 路径里出现了 await：宿主 1s 预算会被吃掉，用户看到「操作失败」')
  assert.ok(!/\bfetch\s*\(/.test(body), 'resolver 路径里直接 fetch：不允许，网络只能在 resolve 之外异步预热')
  assert.ok(!/\bnew Promise\b/.test(body), 'resolver 路径里造 Promise：它会脱离宿主的同步返回路径')
  // 注册时的 resolve 必须是同步箭头函数，`async` 同样会返回 Promise。
  assert.match(
    menuSrc,
    /resolve: \(value\) => sessionWikiMenuActions\(value\)/,
    'provider 的 resolve 必须直接返回 sessionWikiMenuActions(...)（同步），不得包成 async',
  )
  assert.ok(!/resolve: async/.test(menuSrc), 'provider 的 resolve 不得是 async')
})

test('预热是 fire-and-forget（void），不是被 await 的', () => {
  // 缓存冷时必须"预热 + 这次返回空"，不能等。两处都是 void。
  assert.match(menuSrc, /void fetchStatus\(\)/, '名册缓存冷时必须 void fetchStatus() 预热（不 await）')
  assert.match(menuSrc, /void resolveSessionWikiId\(sessionId\)/, '作用域缓存冷时必须 void resolveSessionWikiId() 预热（不 await）')
})

// ── 3. 单库安装不出行 ───────────────────────────────────────────────────────

test('可见库 ≤1 时返回空数组（单库安装这个菜单没有意义）', () => {
  const body = functionBody(menuSrc, 'sessionWikiMenuActions')
  assert.match(body, /if \(wikis\.length <= 1\) return \[\]/, '必须有 `wikis.length <= 1 ⇒ return []` 的早退')
  // 阈值判断必须在**取作用域缓存之前**：单库时连预热都不该发生。
  const guardAt = body.indexOf('wikis.length <= 1')
  const peekAt = body.indexOf('peekSessionWikiScope')
  assert.ok(guardAt >= 0 && peekAt > guardAt, '单库早退必须排在读取作用域缓存之前')
})

test('名册只取 agentVisible 的库（隐身库宿主会拒绝，不能出现在菜单里）', () => {
  // 「隐身就跳过」必须写成显式的早退，不能靠 map 后过滤的副作用。
  assert.match(menuSrc, /if \(!wiki\.agentVisible\) continue/, '名册必须显式跳过非 agentVisible 的库')
  // 同一个 id 出现两次会让宿主抛 `Duplicate menu action`，整张菜单都没有。
  assert.match(menuSrc, /seen\.has\(wiki\.id\)/, '名册必须按 id 去重（重复 id 会抛 Duplicate menu action）')
})

// ── 4. 只有一个切库实现：菜单和选择器共用 ────────────────────────────────────

test('切库只有一份实现：POST + 清空发 null + 成功即失效缓存', () => {
  assert.match(
    switcherRaw,
    /wiki: wanted\.length > 0 \? wanted : null/,
    'session-wiki.ts 必须把"清空"发成 null（不是空字符串）',
  )
  assert.match(
    switcherRaw,
    /AbortSignal\.timeout\(120_000\)/,
    '起一个没在跑的库可能要几十秒，超时预算不能太短',
  )
  assert.match(
    switcherRaw,
    /invalidateSessionWikiId\(sessionId\)/,
    '成功后必须失效该会话的作用域缓存（否则卡片继续带旧库的 ?wiki=）',
  )
  // 选择器不得再自己 POST —— 否则又变成两套切库逻辑。
  assert.ok(
    !/method: 'POST'/.test(dockRaw),
    'wiki-scope-dock.ts 不得自己 POST /session/wiki（切库实现只有 session-wiki.ts 一份）',
  )
  assert.match(dockRaw, /switchSessionWiki\(sessionId, wanted\)/, '选择器必须调用共享的 switchSessionWiki')
})

// ── 5. settings.section 与 settings.section.icon 必须同一个 id ───────────────

test('设置分区与它的图标共用一个 id 常量（宿主按 id 精确匹配）', () => {
  const sectionBlock = registerCallBlock(indexSrc, 'settings.section')
  const iconBlock = registerCallBlock(indexSrc, 'settings.section.icon')
  assert.match(sectionBlock, /id: SETTINGS_SECTION_ID\b/, 'settings.section 的 id 必须是 SETTINGS_SECTION_ID 常量')
  assert.match(iconBlock, /id: SETTINGS_SECTION_ID\b/, 'settings.section.icon 的 id 必须是同一个 SETTINGS_SECTION_ID 常量')
  assert.ok(
    !/id: 'dsh-tiddlywiki'/.test(indexSrc),
    'index.ts 里又出现了写死的 id: \'dsh-tiddlywiki\' —— 成对注册必须共用常量，否则改一个忘一个会静默回落默认图标',
  )
  const defs = [...iconRaw.matchAll(/SETTINGS_SECTION_ID = '([^']+)'/g)]
  assert.equal(defs.length, 1, `SETTINGS_SECTION_ID 必须恰好定义一次（实际 ${defs.length} 次）`)
  assert.equal(defs[0][1], 'dsh-tiddlywiki', 'SETTINGS_SECTION_ID 的值必须是分区 id 本身')
})

test('图标座位：不传 label（宿主明说该座位的 label 不显示），且经 slots.inject 等声明', () => {
  const iconBlock = registerCallBlock(indexSrc, 'settings.section.icon')
  assert.ok(!/\blabel:/.test(iconBlock), 'settings.section.icon 的注册选项里不要带 label —— 宿主不显示它')
  assert.match(
    indexSrc,
    /slots\?\.inject\('settings\.section\.icon'/,
    '必须用 slots.inject 等座位声明（老宿主没有这个座位时静默跳过）',
  )
})

test('图标组件吃 { size, active }，且 active 只改描边/透明度、不改结构', () => {
  assert.match(iconSrc, /size\?: number/, 'owner props 必须声明 size（宿主传 16）')
  assert.match(iconSrc, /active\?: boolean/, 'owner props 必须声明 active（宿主传选中态）')
  assert.match(iconSrc, /strokeWidth: active \? 1\.7 : 1\.3/, 'active 只能改 strokeWidth')
  assert.match(iconSrc, /opacity: active \? 1 : 0\.7/, 'active 只能改 opacity')
  // 结构（子元素数量）不能随 active 变：断言子元素不依赖 active。
  const svgChildren = iconSrc.slice(iconSrc.indexOf("React.createElement('rect'"))
  assert.ok(!/active/.test(svgChildren), '图标的子元素不得依赖 active（否则选中时图形会"跳"一下）')
})

// ── 6. 包根元数据文件（能否生效取决于 package.json 的 exports/files）──────────

test('locale/<lang>.json 只放 meta.title/description（宿主只读这两个字段）', () => {
  for (const lang of ['zh', 'en']) {
    const file = `locale/${lang}.json`
    assert.ok(fs.existsSync(path.join(repoRoot, file)), `缺少 ${file}`)
    const parsed = JSON.parse(read(file))
    assert.deepEqual(Object.keys(parsed), ['meta'], `${file} 顶层只能是 meta`)
    assert.deepEqual(
      Object.keys(parsed.meta).sort(),
      ['description', 'title'],
      `${file} 的 meta 只能有 title/description（宿主的 readPluginMeta 只读这两个）`,
    )
    for (const [key, value] of Object.entries(parsed.meta)) {
      assert.equal(typeof value, 'string', `${file} 的 meta.${key} 必须是非空字符串`)
      assert.ok(value.trim().length > 0, `${file} 的 meta.${key} 不得为空`)
    }
  }
})

test('包根 icon.svg 在宿主的图标预算内（SVG/PNG/JPEG/WebP，≤256KiB）', () => {
  const file = 'icon.svg'
  assert.ok(fs.existsSync(path.join(repoRoot, file)), '缺少包根 icon.svg')
  const bytes = fs.statSync(path.join(repoRoot, file)).size
  assert.ok(bytes > 0 && bytes <= 256 * 1024, `icon.svg 必须是 1 字节～256KiB（实际 ${bytes}）`)
  const svg = read(file)
  assert.match(svg, /^<svg[\s>]/, 'icon.svg 必须以 <svg 开头（宿主按后缀选 media type，内容仍要是合法 SVG）')
  // 插件卡里它是 <img> 的 data URL：currentColor 会解析成黑色，必须自带颜色。
  // 注释里提到这个词不算（先剥 XML 注释，否则断言会被自己的说明文字满足）。
  const svgMarkup = svg.replace(/<!--[\s\S]*?-->/g, '')
  assert.ok(!/currentColor/.test(svgMarkup), 'icon.svg 是独立图片，不能用 currentColor（渲染成 data URL 后它是黑的）')
})

console.log(
  failures === 0
    ? '\nCONTEXT MENU CHECKS OK（可选读法 · 同步 resolver · 单库早退 · 共用 id）'
    : `\nCONTEXT MENU CHECKS FAILED (${failures} 项)`,
)
process.exit(failures === 0 ? 0 : 1)

/**
 * 守门：设置页「插件管理」必须如实反映 TW 运行时状态（v0.26.0）。
 *
 * 背景（真实用户疑惑）：设置页勾选只读 `tiddlywiki.info` 的 `plugins` 数组，
 * 而 TW 运行时集合 = tiddlywiki.info ∪ 以 tiddler 形式装进 wiki 的插件
 * − 被 `$:/config/Plugins/Disabled/<title>`（正文 `yes`）禁用的。于是
 * 「TW 里启用着、设置页显示没装」和「设置页勾着、TW 里被禁用」两种错位都真实存在。
 *
 * 断言分两层：
 *   A. 行为：`scanWikiRuntimePlugins()` 对磁盘形状的真实判定（含反向形态：
 *      dsh 自有命名空间排除、无 plugin-type 的 demo 数据排除、正文非 yes 不算禁用、
 *      目录读失败返回 null 而不是空数组）。
 *   B. 接线：/admin/state 回传 runtimePlugins；客户端把它传进 catalog 区块、
 *      渲染「wiki 内插件」只读小节，且 `null`（扫描失败）时隐藏而不是显示空。
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { scanWikiRuntimePlugins, bundledCatalog, resolveTwRoot } from '../src/host/admin.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
let failures = 0
const test = async (name, fn) => {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures++
    console.log(`  FAIL  ${name}\n        ${err instanceof Error ? err.message : String(err)}`)
  }
}

console.log('行为 —— scanWikiRuntimePlugins 对真实磁盘形状的判定')

const fixture = await mkdtemp(join(tmpdir(), 'dsh-tw-plugin-runtime-'))
const tiddlers = join(fixture, 'tiddlers')
await mkdir(tiddlers, { recursive: true })
// ① 插件库安装的标准形状：单 tiddler + .json.meta
await writeFile(join(tiddlers, '$__plugins_BTC_TiddlyFlex.json'), '{"tiddlers":{}}')
await writeFile(
  join(tiddlers, '$__plugins_BTC_TiddlyFlex.json.meta'),
  'title: $:/plugins/BTC/TiddlyFlex\nplugin-type: plugin\nname: TiddlyFlex\ndescription: A Flexbox Layout\nversion: 0.9.4\n',
)
// ② 拖拽导入的多 tiddler 数组形状（本机真实形态：mermaid）
await writeFile(
  join(tiddlers, '$__plugins_oeyoews_mermaid.json'),
  JSON.stringify([{ title: '$:/plugins/oeyoews/mermaid', 'plugin-type': 'plugin', type: 'application/json', name: 'Mermaid', version: '11.6.3', text: '{}' }]),
)
// ③ 无 plugin-type 的 `$:/plugins/…` 数据 tiddler（dynannotate demo）必须不算插件
await writeFile(join(tiddlers, '$__plugins_tiddlywiki_dynannotate_demo.json'), JSON.stringify([{ title: '$:/plugins/tiddlywiki/dynannotate/demo', text: 'x' }]))
// ④ 插件自己的种子 bundle（dsh / dsh-tiddlywiki 命名空间）必须排除
await writeFile(join(tiddlers, '$__plugins_dsh_send-to-agent.json.meta'), 'title: $:/plugins/dsh/send-to-agent\nplugin-type: plugin\nname: send-to-agent\n')
await writeFile(join(tiddlers, '$__plugins_dsh-tiddlywiki_seed-doc-note.json.meta'), 'title: $:/plugins/dsh-tiddlywiki/seed-doc-note\nplugin-type: plugin\nname: seed-doc-note\n')
// ⑤ 禁用标记：正文 yes = 禁用；正文 no / 缺正文 = 不算禁用
await writeFile(join(tiddlers, '$__config_Plugins_Disabled_$__plugins_tiddlywiki_menubar.tid'), 'title: $:/config/Plugins/Disabled/$:/plugins/tiddlywiki/menubar\ntype: text/vnd.tiddlywiki\n\nyes\n')
await writeFile(join(tiddlers, '$__config_Plugins_Disabled_$__plugins_tiddlywiki_help.tid'), 'title: $:/config/Plugins/Disabled/$:/plugins/tiddlywiki/help\ntype: text/vnd.tiddlywiki\n\nno\n')

const scanned = await scanWikiRuntimePlugins(fixture)

await test('插件库安装的插件（.json.meta）被识别，且带上 name/description/version', () => {
  const entry = scanned.wikiPlugins.find((p) => p.title === '$:/plugins/BTC/TiddlyFlex')
  assert.ok(entry, 'TiddlyFlex 必须在列表里')
  assert.equal(entry.name, 'TiddlyFlex')
  assert.equal(entry.description, 'A Flexbox Layout')
  assert.equal(entry.version, '0.9.4')
})

await test('多 tiddler 数组形状（拖拽导入）同样被识别', () => {
  const entry = scanned.wikiPlugins.find((p) => p.title === '$:/plugins/oeyoews/mermaid')
  assert.ok(entry, 'mermaid 必须在列表里')
  assert.equal(entry.version, '11.6.3')
})

await test('无 plugin-type 的 $:/plugins/… 数据 tiddler 不算插件', () => {
  assert.ok(!scanned.wikiPlugins.some((p) => p.title.includes('dynannotate')), 'demo 数据不得进插件清单')
})

await test('dsh 自己的命名空间（种子 bundle）必须排除', () => {
  assert.ok(!scanned.wikiPlugins.some((p) => p.title.startsWith('$:/plugins/dsh/') || p.title.startsWith('$:/plugins/dsh-tiddlywiki/')), '自有命名空间不得出现')
})

await test('禁用标记只在正文为 yes 时生效', () => {
  assert.deepEqual(scanned.disabled, ['$:/plugins/tiddlywiki/menubar'])
})

await test('tiddlers 目录不存在 → null（读失败 ≠ 没有插件）', async () => {
  assert.equal(await scanWikiRuntimePlugins(join(fixture, 'no-such-wiki')), null)
})

console.log('接线 —— host 回传 + 客户端如实渲染')

const adminSrc = await readFile(join(repoRoot, 'src/host/admin.ts'), 'utf8')
const pageSrc = await readFile(join(repoRoot, 'src/client/settings-page.ts'), 'utf8')

await test('/admin/state 回传 runtimePlugins（由 scanWikiRuntimePlugins 得出）', () => {
  assert.match(adminSrc, /const runtimePlugins = await scanWikiRuntimePlugins\(wikiPath\)/, 'handleState 必须调用扫描')
  assert.match(adminSrc, /^\s*runtimePlugins,$/m, '/admin/state 的 JSON 必须带 runtimePlugins')
})

await test('客户端把 runtimePlugins 传进 catalog 区块', () => {
  assert.match(pageSrc, /renderCatalogSection\(body, state\.info, state\.catalog, state\.runtimePlugins,/, '必须把 state.runtimePlugins 传进去')
})

await test('插件行显示两种错位徽标（TW 内已禁用 / wiki 内已装）', () => {
  assert.match(pageSrc, /'TW 内已禁用'/, '必须有「TW 内已禁用」徽标')
  assert.match(pageSrc, /'wiki 内已装'/, '必须有「wiki 内已装」徽标')
  assert.match(pageSrc, /disabledTitles\.has\(plugin\.title\)/, '徽标必须按标题匹配禁用集合')
})

await test('只读小节「wiki 内插件」在场，且 null 时不渲染', () => {
  assert.match(pageSrc, /'wiki 内插件（经 TW 原生安装，只读）'/, '必须只读列出 wiki 内插件')
  assert.match(pageSrc, /if \(runtimePlugins != null\) \{/, '扫描失败（null）必须隐藏，而不是显示空')
})

console.log('v0.26.1 —— 「没碰过」绝不等于「空集合」（P0：误点应用会清空启动清单）')

await test('catalogPending 必须是空对象，不得预置空 Set', () => {
  // 回归形状（v0.25.0 引入、v0.26.1 修）：`{ plugins: new Set(), … }` 会让
  // `pending.plugins ?? server` 永远取到空集合 → 勾选框全空 + 误点应用提交空数组。
  assert.doesNotMatch(pageSrc, /catalogPending: CatalogPending = \{ plugins: new Set\(\)/, 'catalogPending 不得预置空 Set')
  assert.match(pageSrc, /const catalogPending: CatalogPending = \{\}/, 'catalogPending 必须初始化成空对象（未碰过 = undefined = 跟随服务器）')
})

await test('三个「应用」按钮都必须以 pending 未定义作为不提交的闸门', () => {
  assert.match(pageSrc, /if \(pending\.plugins === undefined\) return/, '插件应用必须拒绝「未碰过」状态')
  assert.match(pageSrc, /if \(pending\.themes === undefined && pending\.themeActive === undefined\) return/, '主题应用必须拒绝「未碰过」状态')
  assert.match(pageSrc, /if \(pending\.languages === undefined\) return/, '语言应用必须拒绝「未碰过」状态')
})

await test('三个同步函数存在，且在勾选变化时重算按钮状态', () => {
  for (const fn of ['syncApplyPlugins', 'syncApplyThemes', 'syncApplyLangs']) {
    assert.match(pageSrc, new RegExp(`const ${fn} = \\(\\): void => \\{`), `${fn} 必须存在`)
    // 定义 1 次 + 初始调用 1 次 + 至少 1 处 change 回调调用
    const calls = pageSrc.split(`${fn}()`).length - 1
    assert.ok(calls >= 3, `${fn}() 至少要在定义、初始、change 回调三处出现（实际 ${calls}）`)
  }
})

await test('徽标判据取服务器集合，不随未应用的勾选抖动', () => {
  assert.match(pageSrc, /!serverPlugins\.includes\(plugin\.name\) && wikiTitles\.has\(plugin\.title\)/, '「wiki 内已装」徽标必须基于服务器集合判定')
})

console.log('v0.26.2 —— catalog 标题必须取自 plugin.info，不得用目录名推导')

await test('行为：plugin.info 声明的 title 优先，缺失才回落目录名', async () => {
  const twRoot = await mkdtemp(join(tmpdir(), 'dsh-tw-catalog-'))
  const mk = async (dir, info) => {
    await mkdir(join(twRoot, 'plugins', 'tiddlywiki', dir), { recursive: true })
    await writeFile(join(twRoot, 'plugins', 'tiddlywiki', dir, 'plugin.info'), JSON.stringify(info))
  }
  // 真实形状：目录名与插件真名不一致（npm 包里的 codemirror-fullscreen-editing）
  await mk('codemirror-fullscreen-editing', { title: '$:/plugins/tiddlywiki/codemirror-fullscreen', name: 'Fullscreen' })
  // 常规形状：plugin.info 不带 title → 回落目录名
  await mk('katex', { name: 'KaTeX' })
  const catalog = await bundledCatalog(twRoot)
  const fullscreen = catalog.plugins.find((p) => p.name === 'tiddlywiki/codemirror-fullscreen-editing')
  const katex = catalog.plugins.find((p) => p.name === 'tiddlywiki/katex')
  assert.equal(fullscreen?.title, '$:/plugins/tiddlywiki/codemirror-fullscreen', '必须用 plugin.info 的 title')
  assert.equal(katex?.title, '$:/plugins/tiddlywiki/katex', '没有 title 时回落目录名')
  await rm(twRoot, { recursive: true, force: true })
})

await test('不变量：真实 npm 包里每个 catalog 标题都等于其 plugin.info 的 title', async () => {
  const twRoot = resolveTwRoot()
  const catalog = await bundledCatalog(twRoot)
  assert.ok(catalog.plugins.length > 0, '必须能扫到自带插件')
  const mismatched = []
  for (const entry of catalog.plugins) {
    const dir = entry.name.replace(/^tiddlywiki\//, '')
    const info = JSON.parse(await readFile(join(twRoot, 'plugins', 'tiddlywiki', dir, 'plugin.info'), 'utf8'))
    const declared = typeof info.title === 'string' && info.title.length > 0 ? info.title : `$:/plugins/tiddlywiki/${dir}`
    if (entry.title !== declared) mismatched.push(`${entry.name}: catalog=${entry.title} plugin.info=${declared}`)
  }
  assert.deepEqual(mismatched, [], `catalog 标题与 plugin.info 不一致：\n${mismatched.join('\n')}`)
  // 这条真实数据断言的存在理由：本机 npm 包确实有一个不一致的插件，必须仍被正确解析。
  assert.equal(catalog.plugins.find((p) => p.name === 'tiddlywiki/codemirror-fullscreen-editing')?.title, '$:/plugins/tiddlywiki/codemirror-fullscreen', 'codemirror-fullscreen 的真名必须被采用')
})

await rm(fixture, { recursive: true, force: true })

if (failures > 0) {
  console.log(`\nPLUGIN RUNTIME GUARD FAILED (${failures})`)
  process.exit(1)
}
console.log('\nPLUGIN RUNTIME GUARD OK')

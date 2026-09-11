#!/usr/bin/env node
/**
 * 渲染路由 bundle 一致性守门（§4 再生成流水线）。
 *
 * 三道检查，全部是「逐字节」级别（CRLF 归一化后比较，与 build/gen 脚本的写法一致）：
 *   1. 源件 `scripts/bundle/render/server-routes/render.js` 与
 *      `scripts/bundle/render.bundle.json` 里对应 tiddler 的 `text` 完全一致
 *      （改了源件忘了重跑 build-render-bundle.mjs 会在这一步炸）；
 *   2. `render.bundle.json` 的文件字节与 `src/host/seed-render.ts` 内嵌的
 *      `RENDER_BUNDLE_TEXT` 字符串字面量**逐字节一致**（忘了重跑
 *      gen-seed-render.mjs 会在这里炸；对照 verify-send-to-agent-bundle.mjs 的
 *      source-parity 写法）；
 *   3. 外层 seed tiddler 的 `version` === bundle 内层 `plugin.info.version`
 *      === `scripts/bundle/versions.mjs` 的 `RENDER_BUNDLE_VERSION`
 *      （三处单源，防手改漂移）。
 *
 * 纯文件比对，不 import lib/。
 *
 *   node scripts/verify-render-bundle.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-render-bundle
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RENDER_BUNDLE_VERSION } from './bundle/versions.mjs'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptsDir, '..')

const bundlePath = path.join(scriptsDir, 'bundle', 'render.bundle.json')
const sourcePartPath = path.join(scriptsDir, 'bundle', 'render', 'server-routes', 'render.js')
const seedPath = path.join(repoRoot, 'src', 'host', 'seed-render.ts')

const PLUGIN_INFO_TITLE = '$:/plugins/dsh/render/plugin.info'
const ROUTE_TITLE = '$:/plugins/dsh/render/server-routes/render.js'

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

/** 与 build/gen 脚本一致的换行归一化（仓库在 Windows 上检出 CRLF 属正常）。 */
const norm = (s) => s.replace(/\r\n/g, '\n')

const bundleRaw = fs.readFileSync(bundlePath, 'utf8')
const sourcePartRaw = fs.readFileSync(sourcePartPath, 'utf8')
const seedRaw = fs.readFileSync(seedPath, 'utf8')

let bundle
await test('render.bundle.json 是合法的 {"tiddlers": {...}} bundle', () => {
  bundle = JSON.parse(bundleRaw)
  assert.ok(bundle && typeof bundle.tiddlers === 'object' && bundle.tiddlers !== null, 'bundle 缺少 tiddlers 对象')
  assert.ok(bundle.tiddlers[PLUGIN_INFO_TITLE] !== undefined, `bundle 缺少 ${PLUGIN_INFO_TITLE}`)
  assert.ok(bundle.tiddlers[ROUTE_TITLE] !== undefined, `bundle 缺少 ${ROUTE_TITLE}`)
})

let pluginInfo
await test('bundle 的 plugin.info 可解析且带 version / plugin-type', () => {
  pluginInfo = JSON.parse(bundle.tiddlers[PLUGIN_INFO_TITLE].text)
  assert.ok(typeof pluginInfo.version === 'string' && pluginInfo.version.length > 0, 'plugin.info 没有 version')
  assert.equal(pluginInfo['plugin-type'], 'plugin', 'plugin.info 缺 plugin-type: plugin（TW 不会注册未标记的插件 tiddler）')
  assert.equal(pluginInfo.title, '$:/plugins/dsh/render', `plugin.info.title 应为 $:/plugins/dsh/render（实际 ${pluginInfo.title}）`)
})

let embedded
await test('seed-render.ts 内嵌了单行 RENDER_BUNDLE_TEXT 字面量，且可 JSON.parse', () => {
  const m = seedRaw.match(/^export const RENDER_BUNDLE_TEXT = ("(?:\\.|[^"\\])*")$/m)
  assert.ok(m !== null, 'seed-render.ts 里找不到 `export const RENDER_BUNDLE_TEXT = "…"` 单行字面量（gen-seed-render.mjs 的输出格式变了？）')
  embedded = JSON.parse(m[1])
  assert.ok(typeof embedded === 'string' && embedded.length > 0, 'RENDER_BUNDLE_TEXT 解出来不是非空字符串')
})

await test('源件 render.js 与 bundle tiddler 正文逐字节一致（忘了重跑 build-render-bundle.mjs？）', () => {
  const disk = norm(sourcePartRaw)
  const inBundle = typeof bundle.tiddlers[ROUTE_TITLE]?.text === 'string' ? norm(bundle.tiddlers[ROUTE_TITLE].text) : null
  assert.ok(inBundle !== null, `${ROUTE_TITLE} 的 text 不是字符串`)
  assert.ok(
    disk === inBundle,
    'scripts/bundle/render/server-routes/render.js 与 render.bundle.json 不一致：改完源件请跑 `node scripts/build-render-bundle.mjs`',
  )
})

await test('render.bundle.json 与 seed-render.ts 的 RENDER_BUNDLE_TEXT 逐字节一致（忘了重跑 gen-seed-render.mjs？）', () => {
  assert.ok(
    norm(bundleRaw) === norm(embedded),
    'src/host/seed-render.ts 内嵌的 bundle 与 scripts/bundle/render.bundle.json 不一致：请跑 `node scripts/gen-seed-render.mjs scripts/bundle/render.bundle.json src/host/seed-render.ts` 再 npm run build',
  )
})

await test('seed-render.ts 外层 tiddler version === bundle 内层 plugin.info.version', () => {
  // gen-seed-render.mjs 把 `version: '${bundleVersion}'` 展开进 put({...})。
  const m = seedRaw.match(/^\s*version:\s*'([^']+)'/m)
  assert.ok(m !== null, 'seed-render.ts 里找不到外层 `version: \'…\'` 字段')
  assert.equal(m[1], pluginInfo.version, `外层 tiddler version（${m[1]}）与内层 plugin.info.version（${pluginInfo.version}）不一致`)
})

await test('bundle 内层 version === scripts/bundle/versions.mjs 的 RENDER_BUNDLE_VERSION', () => {
  assert.equal(pluginInfo.version, RENDER_BUNDLE_VERSION, `bundle 版本（${pluginInfo.version}）与 versions.mjs（${RENDER_BUNDLE_VERSION}）不一致：版本号只能在 scripts/bundle/versions.mjs 定义`)
})

await test('seed-render.ts 保留「do not hand-edit」提示（生成物标记）', () => {
  assert.ok(/do not hand-edit/i.test(seedRaw), 'seed-render.ts 顶部的「Generated … do not hand-edit」注释被删了——它提醒后人别手改常量')
})

await test('render 路由声明 POST /render 且链接改写为同源代理 hash', () => {
  const tiddler = bundle.tiddlers[ROUTE_TITLE]
  const text = tiddler.text
  assert.ok(text.includes('exports.methods'), 'bundle 路由没有 exports.methods')
  // `module-type` is a TIDDLER FIELD, not body text: the old check only matched
  // the source file's own header comment, so dropping the field still passed
  // (v0.20.0). Assert the fields TW's route loader actually reads.
  assert.equal(tiddler['module-type'], 'route', `bundle 路由 tiddler 缺 module-type: route 字段（当前 ${JSON.stringify(tiddler['module-type'])}）`)
  assert.equal(tiddler.type, 'application/javascript', `bundle 路由 tiddler 的 type 应为 application/javascript（当前 ${JSON.stringify(tiddler.type)}）`)
  assert.ok(text.includes('/render'), 'bundle 路由没有 /render 路径')
  assert.ok(text.includes('tv-wikilink-template') && text.includes('/dsh-tiddlywiki/tw/#$uri_encoded$'), 'bundle 路由没有把 wiki 链接改写成同源代理 hash')
})

console.log(failures === 0 ? '\nRENDER BUNDLE CHECKS OK' : `\nRENDER BUNDLE CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

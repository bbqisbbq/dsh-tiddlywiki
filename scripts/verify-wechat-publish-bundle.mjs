// Sanity checks for the assembled「发布到公众号」bundle + its generated seed
// module. Text/source level only: no lib/ import, no TW subprocess — so this
// can run before `npm run build` and still catch a "edited a source part but
// forgot to rerun build → gen" drift.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WECHAT_PUBLISH_BUNDLE_VERSION } from './bundle/versions.mjs'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptsDir, '..')
const bundlePath = path.join(scriptsDir, 'bundle', 'wechat-publish.bundle.json')
const seedPath = path.join(repoRoot, 'src', 'host', 'seed-wechat-publish.ts')

const bundleRaw = fs.readFileSync(bundlePath, 'utf8')
const bundle = JSON.parse(bundleRaw)
const T = bundle.tiddlers
const seedRaw = fs.readFileSync(seedPath, 'utf8')
const checks = []
const ok = (name, cond) => checks.push([name, !!cond])
const norm = (s) => s.replace(/\r\n/g, '\n')

const PLUGIN = '$:/plugins/dsh/wechat-publish'
const MARKER = '$:/plugins/dsh-tiddlywiki/seed-wechat-publish'

// --- bundle shape -----------------------------------------------------------
ok('bundle has 5 tiddlers', Object.keys(T).length === 5)
// The 5th tiddler is the toolbar-chooser row shadow — without it the 控制台 →
// 外观 → 工具栏 rows render caption/description but no icon (v0.23.3).
const ITEM_TEMPLATE = '$:/core/ui/ControlPanel/Toolbars/ItemTemplate'
ok('bundle shadows the toolbar-chooser row template', T[ITEM_TEMPLATE] !== undefined)
ok('chooser shadow is wikitext, not an image', T[ITEM_TEMPLATE]?.type === 'text/vnd.tiddlywiki' && T[ITEM_TEMPLATE]?.tags === undefined)
ok('chooser shadow transcludes {{!!icon}}', typeof T[ITEM_TEMPLATE]?.text === 'string' && T[ITEM_TEMPLATE].text.includes('<$transclude tiddler={{!!icon}}/>'))
for (const title of [
  `${PLUGIN}/plugin.info`,
  `${PLUGIN}/startup.js`,
  `${PLUGIN}/ui/icon`,
  `${PLUGIN}/ui/ViewToolbar/PublishToWechat`,
]) {
  ok(`bundle contains ${title}`, T[title] !== undefined)
}

const pi = JSON.parse(T[`${PLUGIN}/plugin.info`].text)
// Single source of truth: scripts/bundle/versions.mjs (imported by
// build-wechat-publish-bundle.mjs). The inner plugin.info version must equal it.
ok(`bundle plugin.info version === WECHAT_PUBLISH_BUNDLE_VERSION (${WECHAT_PUBLISH_BUNDLE_VERSION})`, pi.version === WECHAT_PUBLISH_BUNDLE_VERSION)
ok('bundle plugin.info carries plugin-type', pi['plugin-type'] === 'plugin')
ok('bundle plugin.info title matches its tiddler', pi.title === PLUGIN)
ok('bundle plugin.info name is WeChat Publish', pi.name === 'WeChat Publish')
ok('bundle plugin.info author is dsh-tiddlywiki', pi.author === 'dsh-tiddlywiki')
ok('bundle plugin.info has a description', typeof pi.description === 'string' && pi.description.length > 0)

// --- button / icon ----------------------------------------------------------
const btn = T[`${PLUGIN}/ui/ViewToolbar/PublishToWechat`]
ok('button fields icon', btn.icon === `${PLUGIN}/ui/icon`)
ok('button fields caption', btn.caption === '发布到公众号')
ok('button fields description', typeof btn.description === 'string' && btn.description.length > 0)
ok('button tagged ViewToolbar', Array.isArray(btn.tags) && btn.tags.includes('$:/tags/ViewToolbar'))
ok('button type is text/vnd.tiddlywiki', btn.type === 'text/vnd.tiddlywiki')
ok('button uses its own icon tiddler', btn.text.includes(`${PLUGIN}/ui/icon`))
ok('button message is dsh-wechat-publish', btn.text.includes('message="dsh-wechat-publish"'))
ok('button param is currentTiddler', btn.text.includes('param=<<currentTiddler>>'))
ok('button text is 发布到公众号', btn.text.includes('发布到公众号'))
ok('button no export icon', !btn.text.includes('export-button'))
// title: header would leak into the rendered button (it is wikitext, not a .meta)
ok('button body has no title: header leaked into text', !/^\s*title:/.test(btn.text))

const icon = T[`${PLUGIN}/ui/icon`]
// Core icons ($:/core/images/*) carry NO type field (defaults to wikitext), so
// `{{icon}}` wikifies into an inline <svg> with `\parameters` expanded. Setting
// image/svg+xml would send `{{icon}}` through the imageparser → <img> data URI,
// whose raw `\parameters`/`<<size>>` Chrome cannot parse → broken icon.
ok('icon tiddler has NO image/svg+xml type (core convention)', icon.type !== 'image/svg+xml' && (icon.type === undefined || icon.type === 'text/vnd.tiddlywiki'))
ok('icon tagged $:/tags/Image', Array.isArray(icon.tags) && icon.tags.includes('$:/tags/Image'))
ok('icon is svg', icon.text.includes('<svg') && icon.text.includes('</svg>'))
ok('icon svg has width/height via <<size>>', icon.text.includes('width=<<size>>') && icon.text.includes('height=<<size>>'))
ok('icon svg square viewBox', /viewBox="0 0 24 24"/.test(icon.text))
ok('icon svg has tc-image-button class', icon.text.includes('tc-image-button'))

const startupTiddler = T[`${PLUGIN}/startup.js`]
ok('startup.js type application/javascript', startupTiddler.type === 'application/javascript')
ok('startup.js module-type startup', startupTiddler['module-type'] === 'startup')

// --- startup.js behavior gates ---------------------------------------------
const s = startupTiddler.text
ok('startup exports name dsh-wechat-publish', s.includes('exports.name = "dsh-wechat-publish"'))
ok('startup runs on browser platform', s.includes('exports.platforms = ["browser"]'))
ok('startup after story', s.includes('exports.after = ["story"]'))
ok('startup logs a startup line', s.includes('[dsh-wechat-publish] startup ran'))
ok('startup listens for the dsh-wechat-publish root-widget event',
  s.includes('$tw.rootWidget.addEventListener("dsh-wechat-publish"'))
// v0.20.0 lesson from the send-to-agent button: $tw.notifier.display() renders a
// TIDDLER by title and silently does nothing for a missing one — so the message
// must be addTiddler'd FIRST and only then displayed.
ok('startup notify stores the message in a $:/temp tiddler before display',
  s.includes('$:/temp/dsh/wechat-publish/notice') && s.includes('$tw.wiki.addTiddler') && s.includes('$tw.notifier.display(NOTICE_TITLE)'))
ok('startup notify addTiddler precedes notifier.display', (() => {
  const a = s.indexOf('$tw.wiki.addTiddler({ title: NOTICE_TITLE')
  const b = s.indexOf('$tw.notifier.display(NOTICE_TITLE)')
  return a !== -1 && b !== -1 && a < b
})())
ok('startup hits GET /wechat/ready', s.includes('/wechat/ready'))
ok('startup hits POST /wechat/publish', s.includes('/wechat/publish"'))
ok('startup hits GET /wechat/publish/status?id=', s.includes('/wechat/publish/status?id='))
ok('startup sends the x-wechat-publish-token header', s.includes('x-wechat-publish-token'))
ok('startup sends title + adapter in the publish body', s.includes('JSON.stringify({ title: title, adapter: adapter })'))
ok('startup reads the wechat config block', s.includes('parsed.wechat') && s.includes('$:/plugins/dsh-tiddlywiki/config'))
ok('startup adapter default is publish-note', s.includes('"publish-note"'))
ok('startup knows publish-note-imgs', s.includes('publish-note-imgs'))
ok('startup clears the poll timer (clearInterval)', s.includes('clearInterval'))
ok('startup has a 2s poll interval', s.includes('POLL_INTERVAL_MS = 2000'))
ok('startup has a 10-minute poll timeout', s.includes('10 * 60 * 1000'))
ok('startup shows 只存到草稿箱', s.includes('只存到草稿箱'))
ok('startup shows 扫码', s.includes('扫码'))
ok('startup shows 复用你已登录的浏览器', s.includes('复用你已登录的浏览器'))
ok('startup checks no-publish tag', s.includes('no-publish'))
ok('startup checks pub-state', s.includes('pub-state'))
ok('startup warns about published / excluded', s.includes('"published"') && s.includes('"excluded"'))
ok('startup truncates the log tail', s.includes('LOG_TAIL_CHARS'))
// v0.23.4 defect C: an installed-but-outdated adapter must produce「版本过旧」,
// not the misleading「缺少发布脚本」 (the two lead to different user actions).
ok('startup reads adapters.stale', s.includes('adapters.stale'))
ok('startup distinguishes stale from missing', s.includes('版本过旧') && s.includes('缺少发布脚本'))
ok('startup wraps the handler in try/catch (never throws into TW startup)',
  s.includes('try {\n\t\t\thandlePublish(event.param);'))
ok('startup has no @deepseek-ai import', !s.includes('@deepseek-ai'))
ok('startup has no require(', !s.includes('require('))
ok('startup is a module wrapper (IIFE)', s.includes('(function(){') && s.includes('})();'))

// --- source parity gate -----------------------------------------------------
// The bundle must be a byte-exact assembly of its four editable source parts
// under scripts/bundle/wechat-publish/ (CRLF-normalized, exactly like
// build-wechat-publish-bundle.mjs). Catches "edited a source part but forgot to
// rerun build" before it reaches a wiki.
const SOURCE_PARTS = [
  ['startup.js', `${PLUGIN}/startup.js`],
  ['button.tid', `${PLUGIN}/ui/ViewToolbar/PublishToWechat`],
  ['icon.svg', `${PLUGIN}/ui/icon`],
  ['item-template.tid', ITEM_TEMPLATE],
]
for (const [file, title] of SOURCE_PARTS) {
  const disk = norm(fs.readFileSync(path.join(scriptsDir, 'bundle', 'wechat-publish', file), 'utf8'))
  const embedded = typeof T[title]?.text === 'string' ? norm(T[title].text) : null
  ok(`source part ${file} is byte-identical to bundle tiddler ${title}`, embedded !== null && disk === embedded)
}
// Both buttons shadow the SAME core tiddler, so their copies must not drift
// apart (an asymmetric edit would make whichever bundle unpacks last win).
{
  const ours = norm(fs.readFileSync(path.join(scriptsDir, 'bundle', 'wechat-publish', 'item-template.tid'), 'utf8'))
  const theirs = norm(fs.readFileSync(path.join(scriptsDir, 'bundle', 'send-to-agent', 'item-template.tid'), 'utf8'))
  ok('chooser shadow matches the send-to-agent bundle copy', ours === theirs)
}

// --- generated seed module --------------------------------------------------
ok('seed-wechat-publish.ts exports WECHAT_PUBLISH_PLUGIN_TITLE', seedRaw.includes('export const WECHAT_PUBLISH_PLUGIN_TITLE'))
ok('seed-wechat-publish.ts exports WECHAT_PUBLISH_MARKER_TITLE', seedRaw.includes('export const WECHAT_PUBLISH_MARKER_TITLE'))
ok('seed-wechat-publish.ts exports WECHAT_PUBLISH_BUNDLE_TEXT', seedRaw.includes('export const WECHAT_PUBLISH_BUNDLE_TEXT'))
ok('seed-wechat-publish.ts exports seedWechatPublish', seedRaw.includes('export async function seedWechatPublish'))
ok('seed-wechat-publish.ts exports unseedWechatPublish', seedRaw.includes('export async function unseedWechatPublish'))
ok('seed module has no @deepseek-ai import', !seedRaw.includes('@deepseek-ai'))

const pluginTitleMatch = seedRaw.match(/^export const WECHAT_PUBLISH_PLUGIN_TITLE = '([^']*)'$/m)
ok('WECHAT_PUBLISH_PLUGIN_TITLE is $:/plugins/dsh/wechat-publish', pluginTitleMatch !== null && pluginTitleMatch[1] === PLUGIN)
const markerMatch = seedRaw.match(/^export const WECHAT_PUBLISH_MARKER_TITLE = '([^']*)'$/m)
ok(`WECHAT_PUBLISH_MARKER_TITLE is ${MARKER}`, markerMatch !== null && markerMatch[1] === MARKER)
ok('seed writes the outer tiddler with plugin-type: plugin', seedRaw.includes("'plugin-type': 'plugin'"))

// The bundle file must carry no BOM and LF-only line endings (the repo's
// .gitattributes pins `* text=auto eol=lf`; a CRLF bundle would make the bytes
// in git differ from the ones the generator embedded).
ok('bundle file has no BOM', bundleRaw.charCodeAt(0) !== 0xfeff)
ok('bundle file is LF-only', !bundleRaw.includes('\r\n'))
ok('seed file is LF-only', !seedRaw.includes('\r\n'))

// --- seed parity gate -------------------------------------------------------
// "edited a bundle source → ran build → forgot gen-seed-…" must not be green:
// compare the bundle FILE against the literal in src/host/seed-wechat-publish.ts.
const literal = seedRaw.match(/^export const WECHAT_PUBLISH_BUNDLE_TEXT = ("(?:\\.|[^"\\])*")$/m)
ok('seed-wechat-publish.ts 内嵌单行 WECHAT_PUBLISH_BUNDLE_TEXT 字面量', literal !== null)
if (literal !== null) {
  let embeddedSeed = null
  try { embeddedSeed = JSON.parse(literal[1]) } catch { embeddedSeed = null }
  ok('WECHAT_PUBLISH_BUNDLE_TEXT 可 JSON.parse', typeof embeddedSeed === 'string' && embeddedSeed.length > 0)
  ok(
    'wechat-publish.bundle.json 与 seed-wechat-publish.ts 内嵌 bundle 逐字节一致（忘了重跑 gen-seed-wechat-publish.mjs？）',
    embeddedSeed !== null && norm(embeddedSeed) === norm(bundleRaw),
  )
}

// --- outer tiddler version gate ---------------------------------------------
// gen-seed-wechat-publish.mjs writes the outer `version` from the bundle's
// plugin.info; assert here so a stale literal cannot ship (a wiki would then
// badge the wrong plugin version with every other check green).
// (the trailing comma matters: the client.put() field is written by the
// generator as `version: '…',`)
const outerVersion = seedRaw.match(/^\s*version:\s*'([^']+)',/m)
ok('seed-wechat-publish.ts 外层 tiddler version === bundle plugin.info.version',
  outerVersion !== null && outerVersion[1] === pi.version)

let failed = false
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`)
  if (!pass) failed = true
}
console.log(failed ? 'WECHAT PUBLISH BUNDLE CHECKS FAILED' : 'WECHAT PUBLISH BUNDLE CHECKS OK')
process.exit(failed ? 1 : 0)

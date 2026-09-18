// One-shot generator: turn the built wechat-publish bundle
// (scripts/bundle/wechat-publish.bundle.json, produced by
// build-wechat-publish-bundle.mjs) into a TS source file with the bundle
// embedded as a JSON string constant.
//
// The module shape mirrors seed-send-to-agent.ts on purpose: same ONE-SHOT +
// marker semantics, same "write the outer tiddler with plugin-type so TW
// actually registers the plugin" requirement.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Usage: node gen-seed-wechat-publish.mjs <bundle.json> <out.ts>
// (the acceptance commands pass both explicitly; the defaults are the standard
// locations so a bare run still does the right thing).
const srcFile = process.argv[2] || path.join(repoRoot, 'scripts', 'bundle', 'wechat-publish.bundle.json')
const outFile = process.argv[3] || path.join(repoRoot, 'src', 'host', 'seed-wechat-publish.ts')

const raw = fs.readFileSync(srcFile, 'utf8').replace(/\r\n/g, '\n')
// sanity: must be a valid {"tiddlers": {...}} bundle
const parsed = JSON.parse(raw)
if (!parsed.tiddlers || typeof parsed.tiddlers !== 'object') {
  throw new Error('not a {"tiddlers": {...}} bundle')
}
const titles = Object.keys(parsed.tiddlers)
console.log('bundle tiddlers:', titles.join(', '))

// The OUTER wiki tiddler's `version` must mirror the bundle's INNER
// plugin.info — read it from the bundle instead of hardcoding it here (a
// literal here is exactly how the send-to-agent outer version drifted once).
const PLUGIN_INFO_TITLE = '$:/plugins/dsh/wechat-publish/plugin.info'
const pluginInfo = parsed.tiddlers[PLUGIN_INFO_TITLE]
if (pluginInfo === undefined || typeof pluginInfo.text !== 'string') {
  throw new Error(`bundle is missing ${PLUGIN_INFO_TITLE}`)
}
const info = JSON.parse(pluginInfo.text)
const bundleVersion = info.version
if (typeof bundleVersion !== 'string' || bundleVersion.length === 0) {
  throw new Error(`${PLUGIN_INFO_TITLE} carries no version`)
}
console.log('bundle version:', bundleVersion)

// Embed the exact JSON text as a JS string literal via JSON.stringify (safe
// escaping, no backticks / ${ issues). verify-wechat-publish-bundle.mjs then
// compares these bytes against the bundle file, so the two cannot drift.
const literal = JSON.stringify(raw)

const out = `/**
 * Generated from the wiki bundle (do not hand-edit the constant).
 * Source: ${path.basename(srcFile)}
 *
 * The「发布到公众号」TW view-toolbar button + its startup module, packaged as a
 * TiddlyWiki plugin bundle (\`{"tiddlers": {...}}\`) and seeded into wikis by
 * seedWechatPublish. It is the TW-side entry point of the OPT-IN 微信发布
 * feature: the button POSTs the current note's title to /wechat/publish on the
 * host, which drives tools/wechat/ through a browser the user is already
 * logged into (see docs/wechat-publish-setup.md).
 *
 * @module dsh-tiddlywiki/host/seed-wechat-publish
 */
import type { TiddlyWebClient } from './tw-api.ts'
import { readSeedTiddler, writeSeedMarker } from './seed-util.ts'

/** The packaged plugin tiddler title (a TW system tiddler, type application/json). */
export const WECHAT_PUBLISH_PLUGIN_TITLE = '${info.title}'

/** One-time marker: presence means "the button was offered once — hands off". */
export const WECHAT_PUBLISH_MARKER_TITLE = '$:/plugins/dsh-tiddlywiki/seed-wechat-publish'

/** The bundle's JSON text (\`{"tiddlers": {...}}\`), exactly as TW stores it. */
export const WECHAT_PUBLISH_BUNDLE_TEXT = ${literal}

/**
 * Seed the「发布到公众号」TW button exactly once per wiki (mirrors the
 * send-to-agent one-shot policy). The marker records the offer; afterwards the
 * bundle is user-owned — deleting it and restarting dsh web does NOT recreate
 * it, and edits are never overwritten. With \`opts.force\` the bundle is
 * (re)written even when it already exists and the marker is (re)written — the
 * settings page uses this for "重新初始化". Returns whether a bundle was
 * written this call. Throws when a read fails (the seed registry reports it as
 * \`ok:false\`).
 */
export async function seedWechatPublish(client: TiddlyWebClient, opts?: { force?: boolean }): Promise<boolean> {
  const force = opts?.force === true
  if (!force) {
    const marker = await readSeedTiddler(client, WECHAT_PUBLISH_MARKER_TITLE)
    if (marker !== undefined) return false
  }
  const existing = await readSeedTiddler(client, WECHAT_PUBLISH_PLUGIN_TITLE)
  let wrote = false
  if (force || existing === undefined) {
    await client.put({
      title: WECHAT_PUBLISH_PLUGIN_TITLE,
      text: WECHAT_PUBLISH_BUNDLE_TEXT,
      type: 'application/json',
      tags: [],
      // TW only REGISTERS a wiki tiddler as a plugin (boot.js
      // registerPluginTiddlers) when the OUTER tiddler carries a
      // \`plugin-type\` field — without it the bundle is never unpacked and its
      // startup module never runs in the embedded TW, so the toolbar button
      // would appear but clicking it would do nothing.
      'plugin-type': 'plugin',
      name: '${info.name}',
      author: '${info.author}',
      version: '${bundleVersion}',
      description: '${info.description}',
    })
    wrote = true
  }
  // Record the offer regardless, so an existing bundle (upgrade from a
  // pre-seed wiki) also becomes user-owned from here on.
  await writeSeedMarker(client, WECHAT_PUBLISH_MARKER_TITLE)
  return wrote
}

/** Remove the bundle + marker (反初始化). */
export async function unseedWechatPublish(client: TiddlyWebClient): Promise<{ removed: string[] }> {
  const removed: string[] = []
  for (const title of [WECHAT_PUBLISH_PLUGIN_TITLE, WECHAT_PUBLISH_MARKER_TITLE]) {
    try {
      await client.delete(title)
      removed.push(title)
    } catch {
      // 删除不存在的条目按幂等处理（与 seed-publish-spec / seed-send-to-agent 一致）
    }
  }
  return { removed }
}
`

fs.writeFileSync(outFile, out.replace(/\r\n/g, '\n'), 'utf8')
console.log('wrote', outFile)

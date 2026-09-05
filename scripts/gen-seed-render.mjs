// One-shot generator: turn the render plugin bundle JSON into a TS source file
// with the bundle embedded as a JSON string constant (mirrors
// gen-seed-send-to-agent.mjs). Run AFTER build-render-bundle.mjs:
//   node scripts/gen-seed-render.mjs \
//     scripts/bundle/render.bundle.json src/host/seed-render.ts
import fs from 'node:fs'
import path from 'node:path'

const srcFile = process.argv[2]
const outFile = process.argv[3]

const raw = fs.readFileSync(srcFile, 'utf8').replace(/\r\n/g, '\n')
// sanity: must be a valid {"tiddlers": {...}} bundle
const parsed = JSON.parse(raw)
if (!parsed.tiddlers || typeof parsed.tiddlers !== 'object') {
  throw new Error('not a {"tiddlers": {...}} bundle')
}
const titles = Object.keys(parsed.tiddlers)
console.log('bundle tiddlers:', titles.join(', '))

// Embed the exact JSON text as a JS string literal via JSON.stringify (safe
// escaping, no backticks / ${ issues).
const literal = JSON.stringify(raw)

const out = `/**
 * Generated from the wiki bundle (do not hand-edit the constant).
 * Source: ${path.basename(srcFile)}
 *
 * The "原生渲染路由" TW plugin, packaged as a TiddlyWiki plugin bundle
 * (\`{"tiddlers": {...}}\`), seeded into fresh wikis by seedRenderRoute. It
 * registers a server-side route module (\`server-routes/render.js\`,
 * module-type: route) that renders wiki text into a pure HTML fragment with
 * internal links rewritten to the same-origin DSH proxy hash.
 *
 * @module dsh-tiddlywiki/host/seed-render
 */
import type { TiddlyWebClient } from './tw-api.ts'

/** The packaged plugin tiddler title (a TW system tiddler, type application/json). */
export const RENDER_PLUGIN_TITLE = '$:/plugins/dsh/render'

/** One-time marker: presence means "the route was offered once — hands off". */
export const RENDER_MARKER_TITLE = '$:/plugins/dsh-tiddlywiki/seed-render'

/** The bundle's JSON text (\`{"tiddlers": {...}}\`), exactly as TW stores it. */
export const RENDER_BUNDLE_TEXT = ${literal}

/**
 * Seed the "原生渲染路由" TW plugin exactly once per wiki (mirrors the
 * send-to-agent one-shot policy). The marker records the offer; afterwards the
 * bundle is user-owned — deleting it and restarting dsh web does NOT recreate
 * it, and edits are never overwritten. With \`opts.force\` the bundle is
 * (re)written even when it already exists and the marker is (re)written — the
 * settings page uses this for "重新初始化". Returns whether a bundle was
 * written this call. Never throws.
 */
export async function seedRenderRoute(client: TiddlyWebClient, opts?: { force?: boolean }): Promise<boolean> {
  const force = opts?.force === true
  if (!force) {
    const marker = await client.get(RENDER_MARKER_TITLE).catch(() => undefined)
    if (marker !== undefined) return false
  }
  const existing = await client.get(RENDER_PLUGIN_TITLE).catch(() => undefined)
  let wrote = false
  if (force || existing === undefined) {
    await client.put({
      title: RENDER_PLUGIN_TITLE,
      text: RENDER_BUNDLE_TEXT,
      type: 'application/json',
      tags: [],
      // TW only REGISTERS a wiki tiddler as a plugin (boot.js
      // registerPluginTiddlers) when the OUTER tiddler carries a
      // \`plugin-type\` field — without it the bundle is never unpacked and its
      // server-routes module is never defined, so /render 404s. The metadata
      // mirrors what the live send-to-agent bundle's tiddler carries.
      'plugin-type': 'plugin',
      name: 'DSH Wiki Render',
      author: 'dsh-tiddlywiki',
      version: '0.1.0',
      description: '把 wiki 文本原生渲染成 HTML 片段（POST /render 服务端路由），供 DSH 回复流工具卡与 wiki 链接跳转使用',
    })
    wrote = true
  }
  // Record the offer regardless, so an existing bundle (upgrade from a
  // pre-seed wiki) also becomes user-owned from here on.
  await client
    .put({ title: RENDER_MARKER_TITLE, text: 'seeded-once', type: 'text/plain', tags: [] })
    .catch(() => undefined)
  return wrote
}
`

fs.writeFileSync(outFile, out, 'utf8')
console.log('wrote', outFile)

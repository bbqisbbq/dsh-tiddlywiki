// One-shot generator: turn the wiki's $__plugins_dsh_send-to-agent.json bundle
// into a TS source file with the bundle embedded as a JSON string constant.
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
 * The "发送给 Agent" TW button, packaged as a TiddlyWiki plugin bundle
 * (\`{"tiddlers": {...}}\`), seeded into fresh wikis by seedSendToAgent.
 *
 * @module dsh-tiddlywiki/host/seed-send-to-agent
 */
import type { TiddlyWebClient } from './tw-api.ts'

/** The packaged plugin tiddler title (a TW system tiddler, type application/json). */
export const SEND_TO_AGENT_PLUGIN_TITLE = '$:/plugins/dsh/send-to-agent'

/** One-time marker: presence means "the button was offered once — hands off". */
export const SEND_TO_AGENT_MARKER_TITLE = '$:/plugins/dsh-tiddlywiki/seed-send-to-agent'

/** The bundle's JSON text (\`{"tiddlers": {...}}\`), exactly as TW stores it. */
export const SEND_TO_AGENT_BUNDLE_TEXT = ${literal}

/**
 * Seed the "发送给 Agent" TW button exactly once per wiki (mirrors the doc-note
 * one-shot policy). The marker records the offer; afterwards the bundle is
 * user-owned — deleting it and restarting dsh web does NOT recreate it, and
 * edits are never overwritten. Returns whether a bundle was written this call.
 * Never throws.
 */
export async function seedSendToAgent(client: TiddlyWebClient): Promise<boolean> {
  const marker = await client.get(SEND_TO_AGENT_MARKER_TITLE).catch(() => undefined)
  if (marker !== undefined) return false
  const existing = await client.get(SEND_TO_AGENT_PLUGIN_TITLE).catch(() => undefined)
  let wrote = false
  if (existing === undefined) {
    await client.put({
      title: SEND_TO_AGENT_PLUGIN_TITLE,
      text: SEND_TO_AGENT_BUNDLE_TEXT,
      type: 'application/json',
      tags: [],
    })
    wrote = true
  }
  // Record the offer regardless, so an existing bundle (upgrade from a
  // pre-seed wiki) also becomes user-owned from here on.
  await client
    .put({ title: SEND_TO_AGENT_MARKER_TITLE, text: 'seeded-once', type: 'text/plain', tags: [] })
    .catch(() => undefined)
  return wrote
}
`

fs.writeFileSync(outFile, out, 'utf8')
console.log('wrote', outFile)

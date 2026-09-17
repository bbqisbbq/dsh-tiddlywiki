#!/usr/bin/env node
/**
 * One-shot generator: turn docs/wechat-publish-setup.md (the authoritative
 * 换机器还原指南, hand-maintained in docs/) into the seed module
 * src/host/seed-wechat-docs.ts, embedding the doc verbatim as a JS string
 * constant (same pipeline as gen-seed-send-to-agent.mjs).
 *
 * Why generated: the seed must ship the EXACT setup doc into the wiki. Two
 * hand-maintained copies drifted before (doc-note's tool list rotted for four
 * versions — v0.21.0); byte-for-byte generation + verify-wechat-docs-seed.mjs
 * (which re-reads the doc and compares) makes drift impossible.
 *
 *   node scripts/gen-seed-wechat-docs.mjs
 *
 * @module dsh-tiddlywiki/scripts/gen-seed-wechat-docs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcFile = path.join(repoRoot, 'docs', 'wechat-publish-setup.md')
const outFile = path.join(repoRoot, 'src', 'host', 'seed-wechat-docs.ts')

const raw = fs.readFileSync(srcFile, 'utf8').replace(/\r\n/g, '\n')

// Sanity: refuse to embed a truncated / wrong doc.
if (raw.length < 5_000) throw new Error(`docs/wechat-publish-setup.md looks truncated (${raw.length} chars)`)
for (const marker of ['## 1. 需要安装/准备的东西', '## 4. ⚠️ 三个必须知道的坑', '## 8. 排错']) {
  if (!raw.includes(marker)) throw new Error(`docs/wechat-publish-setup.md is missing the expected section "${marker}"`)
}
if (raw.includes('title:')) throw new Error('doc must not carry a tiddler title: header (it would render as text)')
console.log(`setup doc: ${raw.length} chars, sections ok`)

// Embed the exact text as a JS string literal via JSON.stringify (safe
// escaping; no backtick / ${ pitfalls).
const literal = JSON.stringify(raw)

const out = `/**
 * Generated from docs/wechat-publish-setup.md (do not hand-edit the constant).
 * Regenerate with: node scripts/gen-seed-wechat-docs.mjs
 *
 * Optional seed (v0.23.1): the「微信公众号发布」install / 换机器还原指南, seeded
 * into the wiki as the tiddler「${'微信公众号发布指南'}」when the opt-in feature is
 * enabled (config \`wechat.enabled\`, gated in the seed registry — same pattern
 * as seed-publish-spec). The wiki copy is byte-identical to docs/
 * wechat-publish-setup.md; verify-wechat-docs-seed.mjs re-reads the file and
 * asserts equality, so the two can never drift.
 *
 * ONE-SHOT + marker semantics identical to seed-clip-bridge: write only when
 * the tiddler is missing (non-force), force re-writes (settings page
 * 「重新初始化」), remove deletes doc + marker.
 *
 * @module dsh-tiddlywiki/host/seed-wechat-docs
 */
import type { TiddlyWebClient } from './tw-api.ts'
import { readSeedTiddler, writeSeedMarker } from './seed-util.ts'

/** The guide tiddler's title (a normal, searchable note; tagged dsh-docs). */
export const WECHAT_DOCS_TITLE = '微信公众号发布指南'

/** One-time marker: presence = "the doc was offered once — hands off". */
export const WECHAT_DOCS_MARKER_TITLE = '$:/plugins/dsh-tiddlywiki/seed-wechat-docs'

/**
 * The guide body — byte-identical to docs/wechat-publish-setup.md (the seed
 * registry's \`content\` declaration re-exports the same constant, so the
 * v0.22.0 content-hash bookkeeping guards exactly these bytes).
 */
export const WECHAT_DOCS_TEXT = ${literal}

/** Write the doc + marker (ONE-SHOT when \`force\` is false). */
export async function seedWechatDocs(client: TiddlyWebClient, opts?: { force?: boolean }): Promise<boolean> {
  const force = opts?.force === true
  if (!force) {
    const marker = await readSeedTiddler(client, WECHAT_DOCS_MARKER_TITLE)
    if (marker !== undefined) return false
  }
  const existing = await readSeedTiddler(client, WECHAT_DOCS_TITLE)
  let wrote = false
  if (force || existing === undefined) {
    await client.put({
      title: WECHAT_DOCS_TITLE,
      text: WECHAT_DOCS_TEXT,
      type: 'text/markdown',
      tags: ['dsh-docs', 'dsh-tiddlywiki'],
    })
    wrote = true
  }
  // Record the offer regardless, so a pre-existing copy (e.g. written by hand
  // before the seed existed) also becomes hash-tracked from here on.
  await writeSeedMarker(client, WECHAT_DOCS_MARKER_TITLE)
  return wrote
}

/** Remove the doc + marker (反初始化). */
export async function unseedWechatDocs(client: TiddlyWebClient): Promise<{ removed: string[] }> {
  const removed: string[] = []
  for (const title of [WECHAT_DOCS_TITLE, WECHAT_DOCS_MARKER_TITLE]) {
    try {
      await client.delete(title)
      removed.push(title)
    } catch {
      // 删除不存在的条目按幂等处理（与 seed-clip-bridge 一致）
    }
  }
  return { removed }
}
`

fs.writeFileSync(outFile, out.replace(/\r\n/g, '\n'), 'utf8')
console.log('wrote', outFile)

// One-shot generator: turn the wiki's home tiddlers (.tid files) into a TS
// source file with the tiddler bodies embedded as string constants, for
// seedHomeIndex (the "主页" default home + 所有标签 statistics + 标签笔记).
import fs from 'node:fs'
import path from 'node:path'

// Usage: node gen-seed-home.mjs <主页.tid> <所有标签.tid> <标签笔记.tid> <out.ts>
const [homeTid, tagTid, noteTid, outFile] = process.argv.slice(2)

/** Parse a .tid file into { meta, text }: meta = field lines before the first
 *  blank line, text = everything after. Normalizes CRLF. */
function parseTid(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const nl = raw.indexOf('\n\n')
  const meta = (nl === -1 ? raw : raw.slice(0, nl)).split('\n').filter(Boolean)
  const text = nl === -1 ? '' : raw.slice(nl + 2)
  const fields = {}
  for (const line of meta) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    fields[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return { fields, text }
}

const home = parseTid(homeTid)
const tag = parseTid(tagTid)
const note = parseTid(noteTid)
if (home.fields.title !== '主页' || tag.fields.title !== '所有标签' || note.fields.title !== '标签笔记') {
  throw new Error(`unexpected titles: ${home.fields.title} / ${tag.fields.title} / ${note.fields.title}`)
}

// Embed bodies as JS string literals via JSON.stringify (safe escaping).
const items = [
  { title: '主页', tags: ['索引'], type: 'text/vnd.tiddlywiki', text: home.text },
  { title: '所有标签', tags: ['索引'], type: 'text/vnd.tiddlywiki', text: tag.text },
  { title: '标签笔记', tags: ['索引'], type: 'text/vnd.tiddlywiki', text: note.text },
]

const literal = (v) => JSON.stringify(v)

const out = `/**
 * Generated from the wiki home tiddlers (do not hand-edit the constants).
 * Source: ${path.basename(homeTid)}, ${path.basename(tagTid)}, ${path.basename(noteTid)}
 *
 * The "首页" tiddlers that the plugin's system prompt promises (待办四象限 +
 * 所有标签统计 + 标签笔记): seeded into fresh wikis by seedHomeIndex, so new
 * users get the same home page instead of an empty wiki. 主页 is the default
 * home (the seed also ensures $:/DefaultTiddlers → [[主页]]).
 *
 * @module dsh-tiddlywiki/host/seed-home
 */
import type { TiddlyWebClient } from './tw-api.ts'

/** One-time marker: presence means "the home was offered once — hands off". */
export const HOME_INDEX_MARKER_TITLE = '$:/plugins/dsh-tiddlywiki/seed-home-index'

/** The $:/DefaultTiddlers body so 主页 opens by default in fresh wikis. */
export const HOME_DEFAULT_TIDDLERS = '[[主页]]'

export interface HomeIndexItem {
  title: string
  tags: string[]
  type: string
  text: string
}

/** The home tiddlers, exactly as seeded (user-owned afterwards). */
export const HOME_INDEX_ITEMS: HomeIndexItem[] = ${literal(items)}

/**
 * Seed the home/index tiddlers exactly once per wiki (mirrors the doc-note
 * one-shot policy). Also writes $:/DefaultTiddlers → [[主页]] so the new home
 * opens by default. With \`force\` the tiddlers are overwritten with the
 * built-in content and the marker is (re)written — the settings page uses this
 * for "重新初始化". Returns whether anything was written this call. Never throws.
 */
export async function seedHomeIndex(client: TiddlyWebClient, opts?: { force?: boolean }): Promise<boolean> {
  const force = opts?.force === true
  if (!force) {
    const marker = await client.get(HOME_INDEX_MARKER_TITLE).catch(() => undefined)
    if (marker !== undefined) return false
  }
  let wrote = false
  for (const item of HOME_INDEX_ITEMS) {
    const existing = await client.get(item.title).catch(() => undefined)
    if (force || existing === undefined) {
      await client.put({ title: item.title, text: item.text, type: item.type, tags: item.tags })
      wrote = true
    }
  }
  // Ensure the default home page is 主页. A fresh wiki's $:/DefaultTiddlers is
  // the core shadow "GettingStarted" (or absent), so a first seed writes it;
  // a user-customised DefaultTiddlers is left alone unless force.
  const dt = await client.get('$:/DefaultTiddlers').catch(() => undefined)
  const dtText = typeof dt?.text === 'string' ? dt.text.trim() : ''
  if (force || dt === undefined || dtText === 'GettingStarted' || dtText === '[[GettingStarted]]') {
    await client.put({ title: '$:/DefaultTiddlers', text: HOME_DEFAULT_TIDDLERS, type: 'text/vnd.tiddlywiki', tags: [] })
    wrote = true
  }
  await client
    .put({ title: HOME_INDEX_MARKER_TITLE, text: 'seeded-once', type: 'text/plain', tags: [] })
    .catch(() => undefined)
  return wrote
}
`

fs.writeFileSync(outFile, out, 'utf8')
console.log('wrote', outFile, `(${items.map((i) => i.title).join(', ')})`)

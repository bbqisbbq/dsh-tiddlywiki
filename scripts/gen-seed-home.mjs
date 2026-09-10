// One-shot generator: turn the wiki's home tiddlers (.tid files) into a TS
// source file with the tiddler bodies embedded as string constants, for
// seedHomeIndex (the "主页" default home + 所有标签 statistics + 标签笔记).
//
// Titles and tags come from each .tid file itself (not hardcoded), so the
// seed always mirrors the live wiki — including a renamed home page (e.g.
// "🏠 主页"). The default tiddler + un-seed check follow the actual home title.
//
// Sanitization: stripping is the DEFAULT — the plugin owner's PERSONAL home
// elements are removed before embedding: the 主题页 tag tabs (只对作者自己的
// 主题页有意义) and any entry buttons whose $action-navigate target is a
// private/dead page (此 wiki 现状：主题汇总 死链、书籍 个人书架). The seeded
// home must stay generic — it is what EVERY fresh wiki gets. Pass
// `--keep-private` to embed the live home verbatim (author's own wiki only).
import fs from 'node:fs'
import path from 'node:path'

// Usage: node gen-seed-home.mjs <主页.tid> <所有标签.tid> <标签笔记.tid> <out.ts> [--keep-private]
// (--strip-private is accepted as a legacy no-op: stripping is now the default.)
const FLAGS = ['--strip-private', '--keep-private']
const args = process.argv.slice(2)
const keepPrivate = args.includes('--keep-private')
const stripPrivate = !keepPrivate
const [homeTid, tagTid, noteTid, outFile] = args.filter((a) => !FLAGS.includes(a))

if (!homeTid || !tagTid || !noteTid || !outFile) {
  console.error('usage: node gen-seed-home.mjs <主页.tid> <所有标签.tid> <标签笔记.tid> <out.ts> [--keep-private]')
  process.exit(2)
}
console.log(stripPrivate
  ? 'gen-seed-home: stripping the owner’s private home elements (default; pass --keep-private to embed verbatim)'
  : 'gen-seed-home: --keep-private → embedding the live home VERBATIM (private elements included)')

/** Parse a .tid file into { fields, text }: fields = meta lines before the first
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
for (const [name, t] of [['主页', home], ['所有标签', tag], ['标签笔记', note]]) {
  if (!t.fields.title) throw new Error(`${name}.tid 缺少 title 字段`)
}

// ---------------------------------------------------------------- sanitize
// The wiki owner's home carries PERSONAL (or locally dead) elements that must
// NEVER ship inside the seed — a fresh wiki would get tabs/buttons pointing at
// pages only the author has. By DEFAULT we:
//   1. remove the owner's `<<tabs ...>>` theme-page strip (主题页 tabs);
//   2. remove entry buttons whose $action-navigate target is a private/dead
//      page (此 wiki 现状：主题汇总 死链、书籍 个人书架);
//   3. append the GENERIC 「📚 插件文档」 tabs strip (tag dsh-docs) so every
//      fresh wiki's home has the seeded docs (说明/教程/模板) one click away.
// Stripping is the default; --keep-private mirrors the wiki verbatim (author only).
const DOCS_TABS = `\n!! 📚 插件文档\n\n<div class="tc-message-box">这里收纳插件初始化时 seed 进来的说明 / 教程 / 模板。给新文档打上 <code>dsh-docs</code> 标签即自动出现在本栏；不需要可自由删除（删除后不会自动恢复）。</div>\n\n<<tabs "[tag[dsh-docs]!is[system]]" "dsh-tiddlywiki 插件说明">>\n\n`
const PRIVATE_NAV_TARGETS = ['主题汇总', '书籍']

function sanitizeHomeText(raw) {
  let text = raw
  // 1. drop the owner's personal theme-page tabs strip
  text = text.replace(/\n<<tabs[^\n]*>>\n/g, '\n')
  // 2. drop entry buttons navigating to private/dead pages. The lazy span is
  //    bounded by a negative lookahead so it never swallows a SIBLING button
  //    (the strip must keep 所有标签 / 所有文章).
  for (const target of PRIVATE_NAV_TARGETS) {
    const re = new RegExp(`<\\$button class="tc-btn-invisible tc-tiddlylink"(?:(?!<\\$button)[\\s\\S])*?\\$to="${target}"(?:(?!<\\$button)[\\s\\S])*?<\\/\\$button>\\s*`, 'g')
    text = text.replace(re, '')
  }
  // 3. append the generic docs tabs strip right before the quick-note section
  //    (or at the end if that heading is absent — keeps the seed generic)
  const marker = '!! ✍️ 快速记笔记'
  if (text.includes(marker)) {
    text = text.replace(marker, DOCS_TABS.trimStart() + marker)
  } else {
    text = text + DOCS_TABS
  }
  // tidy: collapse 3+ consecutive blank lines
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trimEnd() + '\n'
}

if (stripPrivate) home.text = sanitizeHomeText(home.text)

const homeTitle = home.fields.title
// tags field is space-separated, e.g. "索引 TableOfContents"; fall back to 索引.
const tagsOf = (t) => (t.fields.tags ? t.fields.tags.split(/\s+/).filter(Boolean) : ['索引'])
const items = [
  { title: homeTitle, tags: tagsOf(home), type: 'text/vnd.tiddlywiki', text: home.text },
  { title: tag.fields.title, tags: tagsOf(tag), type: 'text/vnd.tiddlywiki', text: tag.text },
  { title: note.fields.title, tags: tagsOf(note), type: 'text/vnd.tiddlywiki', text: note.text },
]

const literal = (v) => JSON.stringify(v)

const out = `/**
 * Generated from the wiki home tiddlers (do not hand-edit the constants).
 * Source: ${path.basename(homeTid)}, ${path.basename(tagTid)}, ${path.basename(noteTid)}
 *${stripPrivate ? `
 * Sanitized (default): the seed home is the GENERIC home (without the wiki
 * owner's personal 主题页 tabs / private entry buttons), plus the
 *「📚 插件文档」tabs strip (tag dsh-docs) so seeded docs are one click away.` : `
 * WARNING: generated with --keep-private — this home still carries the plugin
 * owner's PRIVATE elements. Do NOT ship it in a release.`}
 *
 * The "首页" tiddlers that the plugin's system prompt promises (待办四象限 +
 * 所有标签统计 + 标签笔记): seeded into fresh wikis by seedHomeIndex, so new
 * users get the same home page instead of an empty wiki. ${homeTitle} is the
 * default home (the seed also ensures $:/DefaultTiddlers → [[${homeTitle}]]).
 *
 * @module dsh-tiddlywiki/host/seed-home
 */
import type { TiddlyWebClient } from './tw-api.ts'
import { readSeedTiddler, writeSeedMarker } from './seed-util.ts'

/** One-time marker: presence means "the home was offered once — hands off". */
export const HOME_INDEX_MARKER_TITLE = '$:/plugins/dsh-tiddlywiki/seed-home-index'

/** The $:/DefaultTiddlers body so ${homeTitle} opens by default in fresh wikis. */
export const HOME_DEFAULT_TIDDLERS = ${literal(`[[${homeTitle}]]`)}

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
 * one-shot policy). Also writes $:/DefaultTiddlers → [[${homeTitle}]] so the
 * new home opens by default. With \`force\` the tiddlers are overwritten with the
 * built-in content and the marker is (re)written — the settings page uses this
 * for "重新初始化". Returns whether anything was written this call. Never throws.
 */
export async function seedHomeIndex(client: TiddlyWebClient, opts?: { force?: boolean }): Promise<boolean> {
  const force = opts?.force === true
  if (!force) {
    const marker = await readSeedTiddler(client, HOME_INDEX_MARKER_TITLE)
    if (marker !== undefined) return false
  }
  let wrote = false
  for (const item of HOME_INDEX_ITEMS) {
    const existing = await readSeedTiddler(client, item.title)
    if (force || existing === undefined) {
      await client.put({ title: item.title, text: item.text, type: item.type, tags: item.tags })
      wrote = true
    }
  }
  // Ensure the default home page is ${homeTitle}. A fresh wiki's $:/DefaultTiddlers is
  // the core shadow "GettingStarted" (or absent), so a first seed writes it;
  // a user-customised DefaultTiddlers is left alone unless force.
  const dt = await readSeedTiddler(client, '$:/DefaultTiddlers')
  const dtText = typeof dt?.text === 'string' ? dt.text.trim() : ''
  if (force || dt === undefined || dtText === 'GettingStarted' || dtText === '[[GettingStarted]]') {
    await client.put({ title: '$:/DefaultTiddlers', text: HOME_DEFAULT_TIDDLERS, type: 'text/vnd.tiddlywiki', tags: [] })
    wrote = true
  }
  await writeSeedMarker(client, HOME_INDEX_MARKER_TITLE)
  return wrote
}

/**
 * Un-seed (反初始化): remove the home tiddlers and their marker, restoring the
 * wiki's default home only when it still points at the seeded ${homeTitle}
 * (a user-customised $:/DefaultTiddlers is left alone). Deletion is idempotent —
 * a tiddler already gone is not listed. Never throws.
 */
export async function unseedHomeIndex(client: TiddlyWebClient): Promise<{ removed: string[] }> {
  const removed: string[] = []
  for (const item of HOME_INDEX_ITEMS) {
    const t = await readSeedTiddler(client, item.title)
    if (t !== undefined) {
      await client.delete(item.title)
      removed.push(item.title)
    }
  }
  const marker = await readSeedTiddler(client, HOME_INDEX_MARKER_TITLE)
  if (marker !== undefined) {
    await client.delete(HOME_INDEX_MARKER_TITLE)
    removed.push(HOME_INDEX_MARKER_TITLE)
  }
  const dt = await readSeedTiddler(client, '$:/DefaultTiddlers')
  if (dt !== undefined && typeof dt.text === 'string' && dt.text.trim() === ${literal(`[[${homeTitle}]]`)}) {
    await client.put({ title: '$:/DefaultTiddlers', text: '[[GettingStarted]]', type: 'text/vnd.tiddlywiki', tags: [] })
    removed.push('$:/DefaultTiddlers')
  }
  return { removed }
}
`

fs.writeFileSync(outFile, out, 'utf8')
console.log('wrote', outFile, `(${items.map((i) => i.title).join(', ')})`)

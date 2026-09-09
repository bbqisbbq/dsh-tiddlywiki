// One-shot generator: turn the wiki's custom stylesheet tiddlers (.css files
// + .meta) into a TS source file with the CSS bodies embedded as string
// constants, for seedUiStyles (the plugin's "自定义样式" optional seed).
//
// Sanitization: only the functional tag `$:/tags/Stylesheet` is preserved on
// seeded tiddlers — wiki-local tags (自定义 / tiddlywiki / menubar /
// dsh-tiddlywiki / agent-written …) are dropped so a fresh wiki gets a clean
// stylesheet set with zero personal baggage.
import fs from 'node:fs'
import path from 'node:path'

// Usage: node gen-seed-ui-styles.mjs <样式.css> [<样式.css> …] <out.ts>
// Each entry is a tiddler FILE (e.g. 编辑器美化 CSS.css); the tiddler title /
// type / tags come from the sibling `<file>.meta`.
const args = process.argv.slice(2)
const outFile = args.pop()
const cssFiles = args

if (cssFiles.length === 0 || !outFile) {
  console.error('usage: node gen-seed-ui-styles.mjs <样式.css> … <out.ts>')
  process.exit(1)
}

/** Parse a .meta file into fields (title / tags / type …). */
function parseMeta(file) {
  const fields = {}
  if (!fs.existsSync(file)) return fields
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  for (const line of raw.split('\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    fields[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return fields
}

const STYLESHEET_TAG = '$:/tags/Stylesheet'

const items = cssFiles.map((file) => {
  const meta = parseMeta(`${file}.meta`)
  const title = meta.title ?? path.basename(file, path.extname(file))
  const type = meta.type ?? 'text/css'
  const tags = (meta.tags ? meta.tags.split(/\s+/).filter(Boolean) : []).filter((t) => t === STYLESHEET_TAG)
  if (tags.length === 0) tags.push(STYLESHEET_TAG)
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trimEnd() + '\n'
  return { title, tags, type, text }
})

const literal = (v) => JSON.stringify(v)

const out = `/**
 * Generated from the wiki's custom stylesheet tiddlers (do not hand-edit the
 * constants). Source: ${cssFiles.map((f) => path.basename(f)).join(', ')}
 *
 * The「自定义样式」optional seed: the generic UI stylesheets the wiki owner
 * curated (编辑器美化 / 标题与按钮区分开 / 侧边栏窄屏自动隐藏 / 批注弹窗 /
 * menubar 顶栏加高). Only the functional tag $:/tags/Stylesheet is kept —
 * wiki-local tags (自定义 / agent-written …) are NOT seeded, and none of the
 * sheets carry personal data. Seeded ONE-SHOT (marker-gated, never overwrites
 * user edits) + force 重新初始化 + remove 反初始化, like the other optional seeds.
 *
 * @module dsh-tiddlywiki/host/seed-ui-styles
 */
import type { TiddlyWebClient } from './tw-api.ts'

/** One-time marker: presence means "the styles were offered once — hands off". */
export const UI_STYLES_MARKER_TITLE = '$:/plugins/dsh-tiddlywiki/seed-ui-styles'

export interface UiStyleItem {
  title: string
  tags: string[]
  type: string
  text: string
}

/** The stylesheets, exactly as seeded (user-owned afterwards). */
export const UI_STYLE_ITEMS: UiStyleItem[] = ${literal(items)}

/**
 * Seed the custom stylesheet tiddlers once per wiki (mirrors the one-shot
 * policy). With opts.force the tiddlers are overwritten with the built-in
 * content and the marker (re)written — the settings page uses this for
 * "重新初始化". Returns whether anything was written this call. Never throws.
 */
export async function seedUiStyles(client: TiddlyWebClient, opts?: { force?: boolean }): Promise<boolean> {
  const force = opts?.force === true
  if (!force) {
    const marker = await client.get(UI_STYLES_MARKER_TITLE).catch(() => undefined)
    if (marker !== undefined) return false
  }
  let wrote = false
  for (const item of UI_STYLE_ITEMS) {
    const existing = await client.get(item.title).catch(() => undefined)
    if (force || existing === undefined) {
      await client.put({ title: item.title, text: item.text, type: item.type, tags: item.tags })
      wrote = true
    }
  }
  await client
    .put({ title: UI_STYLES_MARKER_TITLE, text: 'seeded-once', type: 'text/plain', tags: [] })
    .catch(() => undefined)
  return wrote
}

/**
 * Un-seed (反初始化): remove the stylesheet tiddlers and their marker.
 * Deletion is idempotent — a tiddler already gone is not listed. Never throws.
 */
export async function unseedUiStyles(client: TiddlyWebClient): Promise<{ removed: string[] }> {
  const removed: string[] = []
  for (const item of UI_STYLE_ITEMS) {
    const t = await client.get(item.title).catch(() => undefined)
    if (t !== undefined) {
      await client.delete(item.title)
      removed.push(item.title)
    }
  }
  const marker = await client.get(UI_STYLES_MARKER_TITLE).catch(() => undefined)
  if (marker !== undefined) {
    await client.delete(UI_STYLES_MARKER_TITLE)
    removed.push(UI_STYLES_MARKER_TITLE)
  }
  return { removed }
}
`

fs.writeFileSync(outFile, out, 'utf8')
console.log('wrote', outFile, `(${items.map((i) => i.title).join(', ')})`)
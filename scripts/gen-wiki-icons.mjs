#!/usr/bin/env node
/**
 * Regenerate `src/client/wiki-icon.generated.ts` from the official DSH icon set
 * (v0.28.8).
 *
 * WHY THIS EXISTS: feedback item 1 wanted the per-wiki icon picker to offer "the
 * icons in the DSH icon system". DSH does ship one — `@deepseek-ai/dsh-client-ui-
 * primitives`, ~70 `Icon*Outline` components — and it is a client static-seed
 * module, so `require()` would resolve. We deliberately do NOT require it: those
 * are REACT components, this plugin's client is plain DOM (react only as a thin
 * settings wrapper), and pulling React element trees into every sidebar row is a
 * bad trade for a 14px glyph. We instead inline the ARTWORK (`path d` data), so
 * the icons are literally the official drawings with zero runtime dependency.
 *
 * This generator is the source of truth for that data. Hand-copying coordinates
 * is how the values would drift from upstream; running this keeps them exact.
 *
 *   node scripts/gen-wiki-icons.mjs        # writes src/client/wiki-icon.generated.ts
 *
 * It reads the local DSH checkout, so it is a DEVELOPMENT-time step: the generated
 * file is committed and the verify chain never needs DSH present.
 *
 * @module dsh-tiddlywiki/scripts/gen-wiki-icons
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const CANDIDATES = [
  process.env.DSH_PRIMITIVES,
  'D:/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js',
  join(process.env.DSH_HOME ?? '', 'profiles/web/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js'),
].filter((p) => typeof p === 'string' && p.length > 0)

const file = CANDIDATES.find((p) => existsSync(p))
if (file === undefined) {
  console.error('[gen-wiki-icons] 找不到 dsh-client-ui-primitives bundle；设置 DSH_PRIMITIVES 环境变量指向它的 lib/index.js')
  process.exit(1)
}
const source = readFileSync(file, 'utf8')

/**
 * Curated picker set: which official icons are worth offering for a knowledge
 * base's identity, and the short name we store in `wikis.json`.
 *
 * The stored value is the SHORT name (not the upstream component name), because
 * it lands in the control file a user reads and may hand-edit — `archive` beats
 * `IconArchiveOutline`. `src/host/wiki-registry.ts` holds the authoritative list
 * of legal names and this generator asserts the two agree.
 */
const ICONS = {
  archive: 'IconArchiveOutline',
  'archive-check': 'IconArchiveCheckOutline',
  'archive-off': 'IconArchiveOffOutline',
  unarchive: 'IconUnarchiveOutline',
  database: 'IconDatabaseOutline',
  data: 'IconDataOutline',
  folder: 'IconFolderOpenOutline',
  globe: 'IconGlobeOutline',
  branch: 'IconBranchOutline',
  list: 'IconListPenOutline',
  checklist: 'IconChecklistOutline',
  'flat-list': 'IconFlatListOutline',
  skill: 'IconSkillOutline',
  goal: 'IconGoalOutline',
  compact: 'IconCompactOutline',
  clock: 'IconClockOutline',
  alarm: 'IconAlarmClockOutline',
  pin: 'IconPinOutline',
  shield: 'IconShieldOutline',
  api: 'IconApiOutline',
  code: 'IconCodeOutline',
  users: 'IconUsersOutline',
  user: 'IconUserOutline',
  plugin: 'IconCordisPluginOutline',
  pinwheel: 'IconPluginPinwheelOutline',
  gauge: 'IconGaugeOutline',
  tree: 'IconWorkspaceTreeOutline',
  personalization: 'IconPersonalizationOutline',
  link: 'IconLinkOutline',
  search: 'IconSearchOutline',
  settings: 'IconSettingsOutline',
  sparkle: 'IconSparkle',
  think: 'IconThinkOutline',
  light: 'IconLightOutline',
  dark: 'IconDarkOutline',
  refresh: 'IconRefreshOutline',
}

/** Resolve a shared artwork constant, or the icon's own declaration. */
function artworkSource(artName) {
  for (const marker of [`const ${artName} = `, `const ${artName.replace(/^Icon/, '')} = `]) {
    const at = source.indexOf(marker)
    if (at >= 0) return { text: source.slice(at), start: at }
  }
  return null
}

/** Resolve a `d:` value: either a string literal or a named path constant. */
function pathData(raw) {
  const literal = /^"([^"]+)"$/.exec(raw)
  if (literal !== null) return literal[1]
  const id = raw.trim()
  if (!/^[A-Za-z_$][\w$]*$/.test(id)) return null
  const m = new RegExp(`const ${id} = "([^"]+)"`).exec(source)
  return m === null ? null : m[1]
}

/** Extract one icon's geometry: path data plus any circles. */
function extract(component) {
  const resolved = artworkSource(`${component}Artwork`)
  if (resolved === null) return null
  const lineEnd = resolved.text.indexOf('\n')
  const nextArt = source.indexOf('Artwork = ', resolved.start + (lineEnd > 0 ? lineEnd : 40))
  const body = source.slice(resolved.start, nextArt > resolved.start ? nextArt : resolved.start + 6000)
  const paths = []
  for (const m of body.matchAll(/\bd:\s*("[^"]+"|[A-Za-z_$][\w$]*)/g)) {
    const d = pathData(m[1])
    if (d !== null) paths.push(d)
  }
  const circles = [...body.matchAll(/cx:\s*"([^"]+)",\s*cy:\s*"([^"]+)",\s*r:\s*"([^"]+)"/g)]
    .map((m) => ({ cx: m[1], cy: m[2], r: m[3] }))
  if (paths.length === 0 && circles.length === 0) return null
  return { paths, circles }
}

const missing = []
const entries = []
for (const [short, component] of Object.entries(ICONS)) {
  const got = extract(component)
  if (got === null) {
    missing.push(`${short} → ${component}`)
    continue
  }
  entries.push({ short, component, ...got })
}
if (missing.length > 0) {
  console.error(`[gen-wiki-icons] 提取失败（上游改了名字/结构？）：\n  ${missing.join('\n  ')}`)
  process.exit(1)
}

/** Render `path`/`circle` children as an SVG body string. */
function svgChildren(shape) {
  const parts = shape.paths.map((d) => `<path d="${d}"/>`)
  for (const c of shape.circles) parts.push(`<circle cx="${c.cx}" cy="${c.cy}" r="${c.r}"/>`)
  return parts.join('')
}

const lines = []
lines.push('/**')
lines.push(' * GENERATED FILE — do not edit by hand (v0.28.8).')
lines.push(' *')
lines.push(' * The official DSH icon set, inlined as path data so the per-wiki icon picker can')
lines.push(' * offer "the system icons" with ZERO runtime dependency. Regenerate with:')
lines.push(' *')
lines.push(' *   node scripts/gen-wiki-icons.mjs')
lines.push(' *')
lines.push(' * Why inlined rather than `require`d: upstream ships React components, while this')
lines.push(" * plugin's client is plain DOM — see scripts/gen-wiki-icons.mjs for the full reason.")
lines.push(' * The drawings are upstream verbatim (16×16, stroke 1, `currentColor`), so they')
lines.push(' * match DSH exactly and follow both themes.')
lines.push(' *')
lines.push(' * @module dsh-tiddlywiki/client/wiki-icon.generated')
lines.push(' */')
lines.push('')
lines.push('/** viewBox shared by every icon in the set (upstream uses 16×16). */')
lines.push("export const WIKI_ICON_VIEWBOX = '0 0 16 16'")
lines.push('')
lines.push('/** Slugs that use FILLED geometry instead of strokes (their paths cover an area). */')
const filled = entries.filter((e) => /Z\s*Z|Z$/.test(e.paths.join('')) && e.paths.some((d) => d.length > 400))
lines.push(`export const WIKI_ICON_FILLED: readonly string[] = ${JSON.stringify(filled.map((e) => e.short))}`)
lines.push('')
lines.push('/** Icon slug → inner SVG markup (paths/circles only; the wrapper adds the rest). */')
lines.push('export const WIKI_ICON_SHAPES: Record<string, string> = {')
for (const e of entries) {
  lines.push(`  // ${e.component}`)
  lines.push(`  ${JSON.stringify(e.short)}: ${JSON.stringify(svgChildren(e))},`)
}
lines.push('}')
lines.push('')

const out = join(root, 'src/client/wiki-icon.generated.ts')
writeFileSync(out, lines.join('\n'), 'utf8')
console.log(`[gen-wiki-icons] 写入 ${out}`)
console.log(`[gen-wiki-icons] ${entries.length} 个图标（来自 ${file}）`)
if (filled.length > 0) console.log(`[gen-wiki-icons] 其中填充型：${filled.map((e) => e.short).join(', ')}`)

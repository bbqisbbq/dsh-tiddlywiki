#!/usr/bin/env node
/**
 * Extract path data for a chosen set of official DSH icons (v0.28.8).
 *
 * WHY: feedback item 1 asked whether the per-wiki icon picker can use "the icons
 * in the DSH icon system" instead of our 8 hand-drawn glyphs. DSH does ship an
 * icon set (`@deepseek-ai/dsh-client-ui-primitives`, ~70 `Icon*Outline` icons),
 * and it is a client static-seed module — so `require()` would work. We do NOT do
 * that: those are React components, while this plugin's client is plain DOM with
 * `react` resolving from the shell, and pulling React element trees into every
 * sidebar row is a poor trade for a 14px glyph.
 *
 * Instead we inline the ARTWORK — the same `path d` strings the official set
 * uses — so the icons look exactly like DSH's while staying zero-dependency.
 * This script is how that data was derived, kept in-tree so the next person can
 * re-derive/extend it instead of hand-copying coordinates (hand-copying is how
 * the values would silently drift from upstream).
 *
 *   node scripts/extract-dsh-icons.mjs [--emit] [name…]
 *
 * Without `--emit` it prints a summary; with `--emit` it prints the ready-to-
 * paste `path` payload per icon. Needs the DSH checkout to be present; it is a
 * DEVELOPMENT helper, not part of any verify chain.
 *
 * @module dsh-tiddlywiki/scripts/extract-dsh-icons
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Where the primitives bundle lives (first hit wins). */
const CANDIDATES = [
  'D:/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js',
  join(process.env.DSH_HOME ?? '', 'profiles/web/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js'),
]

/**
 * The icons worth offering for a knowledge base's identity.
 *
 * Curated, not "all 70": the picker is a grid a human scans, and icons that read
 * as unrelated chrome (Play, Microphone, Dislike…) only add noise. These map to
 * the ways people actually split knowledge bases — by domain, by material type,
 * by lifecycle (inbox → working → archive).
 *
 * Deliberately EXCLUDED (verified against the bundle, not assumed):
 *   · `IconBookOutline` — no such icon upstream. (Our own hand-drawn `book`
 *     glyph below is what the picker offers for "book".)
 *   · `IconPlanOutline` / `IconQueueOutline` — pure ALIASES of
 *     `IconListPenOutline` / `IconChatLinesOutlineArtwork`; offering both would
 *     put two identical pictures in the grid.
 *   · `IconInspectOutline` — only exists as a composite/shared-artwork name with
 *     no standalone declaration, so it cannot be extracted reliably.
 */
const WANTED = [
  'IconArchiveOutline', 'IconArchiveCheckOutline', 'IconUnarchiveOutline', 'IconArchiveOffOutline',
  'IconDatabaseOutline', 'IconDataOutline', 'IconFolderOpenOutline',
  'IconGlobeOutline', 'IconBranchOutline',
  'IconListPenOutline', 'IconChecklistOutline', 'IconFlatListOutline',
  'IconSkillOutline', 'IconGoalOutline', 'IconCompactOutline',
  'IconClockOutline', 'IconAlarmClockOutline', 'IconPinOutline',
  'IconShieldOutline', 'IconApiOutline', 'IconCodeOutline',
  'IconUsersOutline', 'IconUserOutline', 'IconCordisPluginOutline',
  'IconGaugeOutline', 'IconWorkspaceTreeOutline', 'IconPersonalizationOutline', 'IconLinkOutline',
  'IconSearchOutline', 'IconSettingsOutline', 'IconSparkle',
  'IconThinkOutline', 'IconLightOutline', 'IconDarkOutline', 'IconRefreshOutline',
  'IconPluginPinwheelOutline',
]

const file = CANDIDATES.find((p) => p.length > 0 && existsSync(p))
if (file === undefined) {
  console.error('找不到 dsh-client-ui-primitives 的 bundle，请先设置正确的路径（见 CANDIDATES）')
  process.exit(1)
}
const source = readFileSync(file, 'utf8')
const emit = process.argv.includes('--emit')
const requested = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const names = requested.length > 0 ? requested : WANTED

/**
 * Pull one artwork component's body and return its `path` `d` values.
 *
 * The bundle is minified-ish but keeps readable regions: each artwork is
 * `const <Name>Artwork = ({…}) => jsx(s|s)("svg", {…children: [...]})`. We slice
 * from the artwork declaration to the next artwork (or the next `/** ` doc), then
 * collect `d: "…"` strings. Attribute order varies (stroke vs fill icons), so we
 * only key on `d:`.
 */
/**
 * Resolve a shared artwork constant (`const GlobeOutlineArtwork = …`) or a shared
 * path constant (`const SHIELD_OUTLINE_PATH = "…"`) to its literal source text.
 *
 * Two indirections exist upstream and both would otherwise extract to nothing:
 *   · some icons point at a shared artwork (`IconGlobeOutlineRegular` → `GlobeOutlineArtwork`);
 *   · some artworks point at a shared path (`d: SHIELD_OUTLINE_PATH`).
 */
function resolveArtworkSource(artName) {
  const own = `const ${artName} = `
  let at = source.indexOf(own)
  if (at >= 0) return { text: source.slice(at), start: at }
  // Shared, prefix-less artwork constant (e.g. `GlobeOutlineArtwork`).
  const shared = artName.replace(/^Icon/, '')
  const sharedMarker = `const ${shared} = `
  at = source.indexOf(sharedMarker)
  if (at >= 0) return { text: source.slice(at), start: at }
  return null
}

/** Turn a `d:` value into path data, resolving a named constant when needed. */
function resolvePathData(raw) {
  const literal = /^"([^"]+)"$/.exec(raw)
  if (literal !== null) return literal[1]
  // A bare identifier: look up `const NAME = "…"`.
  const id = raw.trim()
  if (!/^[A-Za-z_$][\w$]*$/.test(id)) return null
  const m = new RegExp(`const ${id} = "([^"]+)"`).exec(source)
  return m === null ? null : m[1]
}

function extract(name) {
  // Names are the FULL component name (`IconArchiveOutline`) and the artwork
  // declaration is that name + `Artwork` — do NOT try to strip a suffix here:
  // the names already end in `Outline`, and stripping produced
  // `IconArchiveOutlineOutlineArtwork`, which of course matched nothing.
  const resolved = resolveArtworkSource(`${name}Artwork`)
  if (resolved === null) return null
  const at = resolved.start
  const markerLen = resolved.text.indexOf('\n') > 0 ? resolved.text.indexOf('\n') : 40
  // The body ends at the NEXT `const …Artwork = `, searched from the END of the
  // declaration line (searching from `at + 10` can re-match our own).
  const nextArt = source.indexOf('Artwork = ', at + markerLen)
  const body = source.slice(at, nextArt > at ? nextArt : at + 6000)
  const paths = []
  for (const m of body.matchAll(/\bd:\s*("[^"]+"|[A-Za-z_$][\w$]*)/g)) {
    const d = resolvePathData(m[1])
    if (d !== null) paths.push(d)
  }
  // Circles/rects are used by a few icons; capture them too so we do not ship a
  // half-drawn glyph.
  const circles = [...body.matchAll(/cx:\s*"([^"]+)",\s*cy:\s*"([^"]+)",\s*r:\s*"([^"]+)"/g)]
    .map((m) => ({ cx: m[1], cy: m[2], r: m[3] }))
  const fills = body.includes('fill: "currentColor"') || /fill: "currentColor"/.test(body)
  return { paths, circles, fills }
}

if (!emit) {
  let ok = 0
  const missing = []
  for (const name of names) {
    const got = extract(name)
    if (got === null || (got.paths.length === 0 && got.circles.length === 0)) missing.push(name)
    else ok++
  }
  console.log(`bundle: ${file}`)
  console.log(`可提取: ${ok} / ${names.length}`)
  if (missing.length > 0) console.log(`未找到: ${missing.join(', ')}`)
  process.exit(missing.length > 0 ? 1 : 0)
}

for (const name of names) {
  const got = extract(name)
  if (got === null) {
    console.error(`!! ${name}: 未找到`)
    continue
  }
  console.log(`${name}: ${JSON.stringify({ paths: got.paths, circles: got.circles, filled: got.fills })}`)
}

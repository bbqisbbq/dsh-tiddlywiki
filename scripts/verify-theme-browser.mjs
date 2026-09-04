// Browser E2E verification of the DSH-theme → TW-palette adaption (dev tool).
// Boots a real TW server (temp wiki), loads it in headless Chrome, then
// replicates what src/client/theme-sync.ts does in the browser and asserts:
//   1. palette flip live re-renders the page (computed body background),
//   2. the changeCount re-align + syncadaptor guard suppress persistence even
//      in the racy boot window (flip IMMEDIATELY after $tw appears, before the
//      initial syncFromServer settles) — server $:/palette unchanged, no disk write,
//   3. restore to light works and re-renders, 4. no page errors.
// OPTIONAL dev tool: requires a headless Chrome/Edge AND the puppeteer-core
// package. When either is missing the script prints SKIP and exits 0.
import { createRequire } from 'node:module'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { WikiServer } from '../lib/index.js'

const require = createRequire(import.meta.url)
let puppeteer
try {
  puppeteer = require('puppeteer-core')
} catch {
  try {
    puppeteer = require('D:/npm-global/node_modules/puppeteer-core')
  } catch {
    console.log('SKIP - puppeteer-core not installed')
    process.exit(0)
  }
}
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]
const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!executablePath) {
  console.log('SKIP - no Chrome/Edge binary found')
  process.exit(0)
}
let failures = 0
const ok = (cond, label) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'} - ${label}`)
  if (!cond) failures++
}

const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-tw-theme-verify-'))
let server
let browser
try {
  server = new WikiServer({ wikiRoot: tempRoot, wiki: 'main', port: 0 })
  const view = await server.start()
  console.log(`TW at ${view.url}`)

  browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text())
  })

  await page.goto(view.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  // Wait only for $tw — NOT for the syncer to settle (we want the boot race).
  await page.waitForFunction(() => typeof window.$tw?.wiki?.getTiddlerText === 'function', { timeout: 30_000 })

  const state = () => page.evaluate(() => {
    const $tw = window.$tw
    const palette = $tw.wiki.getTiddlerText('$:/palette') || ''
    return {
      palette,
      bg: getComputedStyle(document.body).backgroundColor,
      changeCount: $tw.wiki.getChangeCount('$:/palette'),
      info: $tw.syncer?.tiddlerInfo?.['$:/palette'],
      cupertino: $tw.wiki.getTiddler('$:/palettes/CupertinoDark')?.fields?.['color-scheme'] ?? null,
    }
  })

  // Flip IMMEDIATELY — exactly the theme-sync apply path (setText + fixup + guard).
  await page.evaluate(() => {
    const $tw = window.$tw
    const s = $tw.syncer
    window.__saves = []
    const orig = s.syncadaptor.saveTiddler.bind(s.syncadaptor)
    s.syncadaptor.saveTiddler = (t, cb) => { window.__saves.push(t.fields?.title); return orig(t, cb) }
    // installPaletteSaveGuard
    const guarded = new WeakSet()
    if (s && !guarded.has(s)) {
      s.syncadaptor.saveTiddler = (t, cb) => {
        const suppressed = t?.fields?.title === '$:/palette' && t?.fields?.text === '$:/palettes/CupertinoDark'
        if (suppressed) { window.__saves.push('GUARDED:' + t.fields.text); cb(null, {}, 0); return }
        orig(t, cb)
      }
      guarded.add(s)
    }
    // applyPalette dark branch
    const current = $tw.wiki.getTiddlerText('$:/palette') || ''
    if (current !== '$:/palettes/CupertinoDark') window.__userLightPalette = current
    $tw.wiki.setText('$:/palette', 'text', undefined, '$:/palettes/CupertinoDark')
    const cc = $tw.wiki.getChangeCount('$:/palette')
    const info = s.tiddlerInfo['$:/palette']
    if (info !== undefined) info.changeCount = cc
    else s.tiddlerInfo['$:/palette'] = { changeCount: cc }
  })
  // Re-apply lags (mirror the scheduled re-applies) — the boot sync may revert.
  for (const ms of [150, 600, 1500]) {
    await new Promise((r) => setTimeout(r, ms))
    await page.evaluate(() => {
      const $tw = window.$tw
      const p = $tw.wiki.getTiddlerText('$:/palette') || ''
      if (p !== '$:/palettes/CupertinoDark') $tw.wiki.setText('$:/palette', 'text', undefined, '$:/palettes/CupertinoDark')
      const cc = $tw.wiki.getChangeCount('$:/palette')
      const info = $tw.syncer.tiddlerInfo['$:/palette']
      if (info !== undefined) info.changeCount = cc
      else $tw.syncer.tiddlerInfo['$:/palette'] = { changeCount: cc }
    })
  }
  await new Promise((r) => setTimeout(r, 1500)) // let any boot save attempt flush

  const s1 = await state()
  ok(s1.palette === '$:/palettes/CupertinoDark', `active palette flipped in memory (${s1.palette})`)
  ok(s1.cupertino === 'dark', 'CupertinoDark declares color-scheme: dark')
  ok(s1.bg !== 'rgba(0, 0, 0, 0)' && s1.bg !== 'transparent', `page re-rendered to dark background (${s1.bg})`)
  ok(typeof s1.info?.changeCount === 'number' && s1.info.changeCount === s1.changeCount, `syncer changeCount aligned (${s1.changeCount} === ${s1.info?.changeCount})`)

  const saves = await page.evaluate(() => window.__saves)
  const restPalette = await (await fetch(`${view.url}/recipes/default/tiddlers/%24%3A%2Fpalette`)).text()
  const files = await readdir(join(tempRoot, 'main', 'tiddlers'))
  ok(!saves.includes('$:/palette'), `forced palette never PUT (saves: ${JSON.stringify(saves)})`)
  ok(restPalette.includes('$:/palettes/Vanilla'), 'server-side $:/palette unchanged (still Vanilla)')
  ok(!files.includes('$__palette.tid'), `no $__palette.tid on disk (got: ${files.filter((f) => f.includes('palette')).join(', ') || 'none'})`)

  // Restore (light branch) — replicate EXACTLY, allow the write to flow (it
  // targets the user's light palette, harmless/corrective).
  await page.evaluate(() => {
    const $tw = window.$tw
    const restore = window.__userLightPalette || '$:/palettes/Vanilla'
    $tw.wiki.setText('$:/palette', 'text', undefined, restore)
    const cc = $tw.wiki.getChangeCount('$:/palette')
    const info = $tw.syncer.tiddlerInfo['$:/palette']
    if (info !== undefined) info.changeCount = cc
    else $tw.syncer.tiddlerInfo['$:/palette'] = { changeCount: cc }
  })
  await new Promise((r) => setTimeout(r, 1500))
  const s2 = await state()
  ok(s2.palette === '$:/palettes/Vanilla', `palette restored in memory (${s2.palette})`)
  ok(s2.bg !== s1.bg, `page re-rendered back to light (${s1.bg} -> ${s2.bg})`)
  ok(errors.length === 0, `no page/console errors (${errors.slice(0, 3).join(' | ') || 'none'})`)
} finally {
  await browser?.close().catch(() => {})
  await server?.stop().catch(() => {})
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
}

if (failures > 0) {
  console.log(`\nTHEME BROWSER VERIFY FAILED (${failures})`)
  process.exit(1)
}
console.log('\nTHEME BROWSER VERIFY OK')

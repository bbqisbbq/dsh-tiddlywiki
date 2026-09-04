// Browser E2E: verify the menubar-theme override makes nav.tc-menubar follow
// the ACTIVE palette (light → light bar, dark → dark bar). Loads the LIVE wiki
// server, reads the computed menubar background under the stored palette
// (Blanca light), then flips $:/palette in-memory (exactly like theme-sync)
// and re-checks. Dev tool: requires puppeteer-core + Chrome; else SKIP.
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

const TW_URL = process.env.TW_URL || 'http://127.0.0.1:55373'
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

let browser
try {
  browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto(TW_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => typeof window.$tw?.wiki?.getTiddlerText === 'function', { timeout: 30_000 })
  await new Promise((r) => setTimeout(r, 1500)) // let the first render settle

  const sample = () => page.evaluate(() => {
    const $tw = window.$tw
    const bar = document.querySelector('nav.tc-menubar ul.tc-menubar-list')
    const item = document.querySelector('nav.tc-menubar li.tc-menubar-item > a, nav.tc-menubar li.tc-menubar-item > button')
    return {
      palette: $tw.wiki.getTiddlerText('$:/palette') || '',
      barBg: bar ? getComputedStyle(bar).backgroundColor : null,
      itemColor: item ? getComputedStyle(item).color : null,
      barExists: bar !== null,
    }
  })

  const light = await sample()
  console.log('light sample:', JSON.stringify(light))
  ok(light.barExists, 'menubar bar element present')
  if (light.barExists) {
    // Blanca light background is white/very light; must NOT be the menubar
    // default blue #5778d8 = rgb(87, 120, 216).
    const isBlue = light.barBg === 'rgb(87, 120, 216)'
    ok(!isBlue, `menubar background is NOT default blue under light palette (${light.barBg})`)
    // The palette's background should be light (high luminance).
    const [r, g, b] = (light.barBg || '').match(/\d+/g)?.map(Number) ?? [0, 0, 0]
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    ok(lum > 100, `menubar background is light under light palette (lum ${lum.toFixed(0)})`)
  }

  // Flip $:/palette in-memory to CupertinoDark, exactly like theme-sync.
  await page.evaluate(() => {
    const $tw = window.$tw
    $tw.wiki.setText('$:/palette', 'text', undefined, '$:/palettes/CupertinoDark')
    const cc = $tw.wiki.getChangeCount('$:/palette')
    const info = $tw.syncer?.tiddlerInfo?.['$:/palette']
    if (info !== undefined) info.changeCount = cc
    else if ($tw.syncer !== undefined) $tw.syncer.tiddlerInfo['$:/palette'] = { changeCount: cc }
  })
  await new Promise((r) => setTimeout(r, 1500)) // stylesheets re-render live

  const dark = await sample()
  console.log('dark sample:', JSON.stringify(dark))
  ok(dark.palette === '$:/palettes/CupertinoDark', `palette flipped in memory (${dark.palette})`)
  if (dark.barExists) {
    const [r, g, b] = (dark.barBg || '').match(/\d+/g)?.map(Number) ?? [255, 255, 255]
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    ok(lum < 100, `menubar background is DARK under dark palette (${dark.barBg}, lum ${lum.toFixed(0)})`)
    ok(dark.barBg !== light.barBg, `menubar background CHANGED with palette (${light.barBg} -> ${dark.barBg})`)
    ok(dark.itemColor !== light.itemColor, `menubar item color CHANGED with palette (${light.itemColor} -> ${dark.itemColor})`)
  }
  ok(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ') || 'none'})`)

  // Restore the wiki's stored palette (leave no memory state behind).
  await page.evaluate(() => {
    const $tw = window.$tw
    $tw.wiki.setText('$:/palette', 'text', undefined, '$:/palettes/Blanca')
  })
  await new Promise((r) => setTimeout(r, 500))
} finally {
  await browser?.close().catch(() => {})
}

if (failures > 0) {
  console.log(`\nMENUBAR THEME VERIFY FAILED (${failures})`)
  process.exit(1)
}
console.log('\nMENUBAR THEME VERIFY OK')

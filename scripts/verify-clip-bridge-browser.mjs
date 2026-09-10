#!/usr/bin/env node
/**
 * Browser E2E for the clip-bridge seed doc's DRAGGABLE bookmarklet anchor
 * (v0.16.27). Boots a REAL TW server (temp wiki), seeds the actual
 *「本地剪藏桥（书签小工具）」tiddler through seedClipBridge, loads it in
 * headless Chrome and asserts:
 *   1. markdown rendered (h1 visible);
 *   2. the draggable anchor survives rendering with its javascript: href
 *      INTACT (TW must NOT mangle/sanitize it) and draggable="true";
 *   3. the anchor href decodes to the full bookmarklet code (length check);
 *   4. executing the bookmarklet code in the page opens the overlay (#cb_p);
 *   5. no page JS exceptions.
 * OPTIONAL dev tool: requires a headless Chrome/Edge AND puppeteer-core (same
 * convention as verify-theme-browser.mjs). When either is missing → SKIP.
 *
 *   node scripts/verify-clip-bridge-browser.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-clip-bridge-browser
 */
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { WikiServer, TiddlyWebClient, seedClipBridge, CLIP_BRIDGE_DOC_TITLE, CLIP_BRIDGE_BOOKMARKLET } from '../lib/index.js'

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
const chrome = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p))
if (!chrome) {
  console.log('SKIP - no Chrome/Edge binary found')
  process.exit(0)
}

let failures = 0
const ok = (cond, label) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'} - ${label}`)
  if (!cond) failures++
}

const root = await mkdtemp(join(tmpdir(), 'dsh-tw-clip-browser-'))
let server, browser
try {
  server = new WikiServer({ wikiRoot: root, wiki: 'main', port: 0 })
  const view = await server.start()
  const client = new TiddlyWebClient(view.url)
  const seeded = await seedClipBridge(client)
  ok(seeded, 'real doc tiddler seeded through seedClipBridge')

  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  const jsErrors = []
  page.on('pageerror', (e) => jsErrors.push(String(e)))
  await page.goto(`${view.url}/#${encodeURIComponent(CLIP_BRIDGE_DOC_TITLE)}`, { waitUntil: 'networkidle2', timeout: 30_000 })
  await new Promise((r) => setTimeout(r, 3000))

  const rendered = await page.evaluate(() => ({
    h1: !!document.querySelector('h1'),
    anchors: [...document.querySelectorAll('a[href^="javascript:"]')].map((a) => ({
      text: a.textContent, draggable: a.getAttribute('draggable'),
      rawHref: a.getAttribute('href') ?? '',
    })),
  }))
  ok(rendered.h1, 'doc markdown rendered in real TW')
  const anchor = rendered.anchors.find((a) => a.text.includes('拖到书签栏')) ?? rendered.anchors[0]
  ok(!!anchor, 'draggable anchor present with javascript: href')
  ok(anchor?.draggable === 'true', 'anchor is draggable=true')
  // getAttribute returns the attribute value with HTML entities NOT decoded
  // (&quot; &amp; inflation), while the browser resolves .href (used by drag
  // and click) to the DECODED code — so decode here before comparing.
  const decodedHref = (anchor?.rawHref ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  ok(decodedHref.startsWith('javascript:('), 'anchor href is the bookmarklet code')
  ok(decodedHref === CLIP_BRIDGE_BOOKMARKLET, 'anchor href decodes to EXACTLY the shipped bookmarklet')
  ok((anchor?.rawHref ?? '').length > CLIP_BRIDGE_BOOKMARKLET.length, `raw attr is entity-inflated (${anchor?.rawHref.length} > ${CLIP_BRIDGE_BOOKMARKLET.length}) — escaping worked`)

  // Execute the drag-installed code in the real browser page → overlay opens.
  await page.evaluate((code) => { window.fetch = async () => ({ ok: false, status: 503, json: async () => ({ ok: false, error: 'test' }) }); window.eval(code) }, CLIP_BRIDGE_BOOKMARKLET.replace(/^javascript:/, ''))
  const overlay = await page.evaluate(() => !!document.querySelector('#cb_p'))
  ok(overlay, 'bookmarklet code opens the #cb_p overlay in a real browser')
  ok(jsErrors.length === 0, `no page JS exceptions (${jsErrors.length})${jsErrors.length ? ': ' + jsErrors[0] : ''}`)
} finally {
  if (browser) await browser.close()
  await server.stop()
  await rm(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nclip bridge BROWSER verify: ALL PASSED' : `\nclip bridge BROWSER verify: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
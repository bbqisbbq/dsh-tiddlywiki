/**
 * Shared browser discovery for the (non-CI) puppeteer-driven checks (v0.20.0).
 *
 * WHY: the three browser scripts each hardcoded
 * `require('D:/npm-global/node_modules/puppeteer-core')` — one developer's
 * machine path — and their Chrome candidate lists had already drifted (only two
 * of the three listed the Linux binaries, so verify-clip-bridge-browser always
 * printed "SKIP - no Chrome/Edge binary found" and exited 0 on Linux).
 *
 * Resolution order (first hit wins):
 *   1. `PUPPETEER_CORE_PATH` (explicit override, any machine);
 *   2. `require('puppeteer-core')` (normal install);
 *   3. a `puppeteer-core` package reachable from PUPPETEER_CORE_HOME / npm prefix.
 * Chrome: `CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH`, else the OS candidate list.
 *
 * @module dsh-tiddlywiki/scripts/lib/browser-env
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

/**
 * Load puppeteer-core, or return null (callers print a SKIP and exit 0).
 * @returns {any | null}
 */
export function loadPuppeteer() {
  const explicit = process.env.PUPPETEER_CORE_PATH
  if (typeof explicit === 'string' && explicit.length > 0) {
    const mod = tryRequire(explicit)
    if (mod !== null) return mod
  }
  const bare = tryRequire('puppeteer-core')
  if (bare !== null) return bare
  const home = process.env.PUPPETEER_CORE_HOME
  if (typeof home === 'string' && home.length > 0) {
    const mod = tryRequire(join(home, 'node_modules', 'puppeteer-core'))
    if (mod !== null) return mod
  }
  return null
}

function tryRequire(spec) {
  try {
    return require(spec)
  } catch {
    return null
  }
}

/** Chrome/Edge candidate paths for Windows / macOS / Linux. */
export const CHROME_CANDIDATES = [
  // Windows
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

/**
 * Find a usable Chrome/Edge binary, or null.
 * @returns {string | null}
 */
export function findChrome() {
  for (const envName of ['CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH']) {
    const value = process.env[envName]
    if (typeof value === 'string' && value.length > 0 && existsSync(value)) return value
  }
  return CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null
}

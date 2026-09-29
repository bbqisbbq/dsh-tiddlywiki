/**
 * Client-side i18n (v0.30.6).
 *
 * WHY: the client half had ZERO i18n — `uiLanguage` only ever drove the TW child,
 * while the FAB / sidebar / quick-note card / settings page / every toast were
 * hard-coded Chinese (the settings page even admitted it in a comment). This
 * module is the single entry point every surface uses.
 *
 * HOW THE LANGUAGE IS CHOSEN
 * --------------------------
 * The plugin config key `uiLanguage` (same one the TW child gets) is the source
 * of truth; the host exposes it on `/status` as `lang`. Because the plain-DOM
 * surfaces mount once, the current language is ALSO cached in `localStorage`, so
 * the first paint after a reload is already correct — and a language change
 * applies to the surfaces that re-render (the settings page) immediately, while
 * everything else picks it up on the next reload. The settings page says so.
 *
 * KEYS: `area.thing` (dots, lower-case). Every key must exist in BOTH catalogs
 * with the SAME set — `scripts/verify-client-i18n.mjs` enforces that, plus
 * "no user-visible CJK outside `t()`".
 *
 * @module dsh-tiddlywiki/client/i18n
 */
import { MESSAGES } from './i18n-catalog.ts'

export type Lang = 'zh' | 'en'

/** Fallback = the language this plugin has always spoken. */
export const DEFAULT_LANG: Lang = 'zh'

const STORAGE_KEY = 'dsh-tiddlywiki:lang'

/** Map any host/browser value ('zh-CN', 'en-US', 'ZH', garbage) onto a Lang. */
export function normalizeLang(raw: unknown): Lang {
  if (typeof raw !== 'string') return DEFAULT_LANG
  const value = raw.trim().toLowerCase()
  if (value.startsWith('en')) return 'en'
  if (value.startsWith('zh')) return 'zh'
  return DEFAULT_LANG
}

function readCachedLang(): Lang | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    return raw === null || raw === undefined ? undefined : normalizeLang(raw)
  } catch {
    return undefined // storage disabled (private mode / sandbox) — not fatal
  }
}

let current: Lang = readCachedLang() ?? DEFAULT_LANG

export function getLang(): Lang {
  return current
}

/**
 * Apply a language. Called from `fetchStatus()` (every `/status` payload carries
 * `lang`) and from the settings page on save. Returns true when it CHANGED, so a
 * caller that can re-render (the settings page) knows whether to redraw.
 */
export function setLang(raw: unknown): boolean {
  const next = normalizeLang(raw)
  const changed = next !== current
  current = next
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, next)
  } catch {
    /* best-effort cache; the UI still works with the in-memory value */
  }
  return changed
}

/**
 * Look one message up. `vars` interpolates `{name}` placeholders.
 *
 * Never throws and never returns an empty string: an unknown key falls back to
 * the default language and then to the KEY itself (visible in the UI, which is
 * exactly what you want while converting a surface — a missing entry shows up
 * instead of silently rendering "").
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const table = MESSAGES[current] as Record<string, string> | undefined
  const fallback = MESSAGES[DEFAULT_LANG] as Record<string, string> | undefined
  const raw = table?.[key] ?? fallback?.[key] ?? key
  if (vars === undefined) return raw
  return raw.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name]
    return value === undefined ? match : String(value)
  })
}

/** All keys (default language) — the gate and the settings preview use it. */
export function messageKeys(): string[] {
  return Object.keys(MESSAGES[DEFAULT_LANG] ?? {}).sort()
}

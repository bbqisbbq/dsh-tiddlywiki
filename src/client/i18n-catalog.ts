/**
 * The merged message catalog (v0.30.6).
 *
 * Split into per-AREA chunks (one file per group of surfaces) so a conversion
 * touches one small file at a time and two people never edit the same table.
 * `i18n.ts` reads this; `scripts/verify-client-i18n.mjs` asserts the zh/en key
 * sets are identical and that every `t('...')` key exists.
 *
 * @module dsh-tiddlywiki/client/i18n-catalog
 */
import { CHROME_MESSAGES } from './i18n-chrome.ts'
import { NOTE_MESSAGES } from './i18n-note.ts'
import { CARD_MESSAGES } from './i18n-card.ts'
import { SETTINGS_MESSAGES } from './i18n-settings.ts'
import { CONFIG_MESSAGES } from './i18n-config.ts'
import { PLUGINS_MESSAGES } from './i18n-plugins.ts'
import { FRAME_MESSAGES } from './i18n-frame.ts'

const CHUNKS = [
  CHROME_MESSAGES,
  NOTE_MESSAGES,
  CARD_MESSAGES,
  SETTINGS_MESSAGES,
  CONFIG_MESSAGES,
  PLUGINS_MESSAGES,
  FRAME_MESSAGES,
]

export const MESSAGES: { zh: Record<string, string>; en: Record<string, string> } = {
  zh: Object.assign({}, ...CHUNKS.map((chunk) => chunk.zh)),
  en: Object.assign({}, ...CHUNKS.map((chunk) => chunk.en)),
}
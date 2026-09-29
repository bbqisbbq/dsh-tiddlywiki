/**
 * Messages for plugins (v0.30.6): 设置页的插件/主题/语言/初始化面板（settings-page-catalog.ts、ui-config.ts、theme-sync.ts）.
 *
 * Key prefix `plugins.`. Keep `zh` and `en` key-for-key identical —
 * `scripts/verify-client-i18n.mjs` fails on any asymmetry, and every key must
 * also be USED (an unused entry is dead weight in the bundle).
 *
 * @module dsh-tiddlywiki/client/i18n-plugins
 */
export const PLUGINS_MESSAGES: { zh: Record<string, string>; en: Record<string, string> } = {
  zh: {},
  en: {},
}
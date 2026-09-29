/**
 * Messages for frame (v0.30.6): 中央 TW 面板与内核状态行（panel.ts、tw-frame.ts）、
 * 同步按钮（sync-button.ts）、toast（toast.ts）、客户端装配入口（client/index.ts）。
 *
 * Key prefix `frame.`. Keep `zh` and `en` key-for-key identical —
 * `scripts/verify-client-i18n.mjs` fails on any asymmetry, and every key must
 * also be USED (an unused entry is dead weight in the bundle).
 *
 * @module dsh-tiddlywiki/client/i18n-frame
 */
export const FRAME_MESSAGES: { zh: Record<string, string>; en: Record<string, string> } = {
  zh: {},
  en: {},
}
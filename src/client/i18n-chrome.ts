/**
 * Messages for chrome (v0.30.6): FAB / 侧边栏入口 / 输入框上方那一行（快速笔记 + 知识库选择器）/ 同步按钮 / 中央面板与 TW 内核的状态行 / 会话「知识库」Tab 的容器 / toast.
 *
 * Key prefix `chrome.`. Keep `zh` and `en` key-for-key identical —
 * `scripts/verify-client-i18n.mjs` fails on any asymmetry, and every key must
 * also be USED (an unused entry is dead weight in the bundle).
 *
 * @module dsh-tiddlywiki/client/i18n-chrome
 */
export const CHROME_MESSAGES: { zh: Record<string, string>; en: Record<string, string> } = {
  zh: {
    'chrome.scopeSlotLabel': '知识库',
    'chrome.dockQuickNote': '快速笔记',
  },
  en: {
    'chrome.scopeSlotLabel': 'Knowledge base',
    'chrome.dockQuickNote': 'Quick note',
  },
}
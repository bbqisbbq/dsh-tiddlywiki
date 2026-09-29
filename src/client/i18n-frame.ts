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
  zh: {
    'frame.syncRestarted': '，TW 已重启',
    'frame.syncNotRestarted': '，TW 未自动重启',
    'frame.rightbarTitle': 'TiddlyWiki 知识库',
    'frame.rightbarDescription': '在右侧边栏打开 TiddlyWiki 编辑器（与聊天并排）',
    'frame.settingsSection': 'TiddlyWiki 知识库',
    'frame.syncTooltip': '同步知识库',
    'frame.gitUnavailable': 'git 仓库不可用',
    'frame.branch': '分支 {branch}',
    'frame.ahead': '领先 {n}',
    'frame.behind': '落后 {n}',
    'frame.dirty': '有 {n} 个未提交改动',
    'frame.lastSync': '上次同步 {time}',
    'frame.syncing': '同步进行中…',
    'frame.syncDone': '同步完成：{message}',
    'frame.syncFailed': '同步失败：{message}',
    'frame.tabLabelDefault': '知识库',
  },
  en: {
    'frame.syncRestarted': ', TiddlyWiki restarted',
    'frame.syncNotRestarted': ', TiddlyWiki was not restarted automatically',
    'frame.rightbarTitle': 'TiddlyWiki knowledge base',
    'frame.rightbarDescription': 'Open the TiddlyWiki editor in the right sidebar, next to the chat',
    'frame.settingsSection': 'TiddlyWiki knowledge base',
    'frame.syncTooltip': 'Sync knowledge base',
    'frame.gitUnavailable': 'git repository unavailable',
    'frame.branch': 'branch {branch}',
    'frame.ahead': '{n} ahead',
    'frame.behind': '{n} behind',
    'frame.dirty': '{n} uncommitted change(s)',
    'frame.lastSync': 'last synced {time}',
    'frame.syncing': 'Syncing…',
    'frame.syncDone': 'Sync finished: {message}',
    'frame.syncFailed': 'Sync failed: {message}',
    'frame.tabLabelDefault': 'Knowledge base',
  },
}
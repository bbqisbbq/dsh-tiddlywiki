/**
 * Messages for card (v0.30.6; filled in v0.30.14): 回复流里的工具卡片与会话汇总视图
 * —— `tool-views*.ts` · `session-summary.ts`.
 *
 * Key prefix `card.`. Keep `zh` and `en` key-for-key identical —
 * `scripts/verify-client-i18n.mjs` fails on any asymmetry, and every key must
 * also be USED (an unused entry is dead weight in the bundle).
 *
 * ⚠️ 这些文案有两类用法，取值时机不同：
 *   - 组件渲染时求值（`React.createElement(..., t('card.…'))`）—— 语言切换后重渲染即生效；
 *   - 模块级常量（`TOOL_LABELS`）—— 必须存**函数**（`() => t(…)`）而不是字符串，
 *     否则它在 bundle 加载那一刻就把当时的语言冻住了。见 tool-views-shell.ts。
 *
 * @module dsh-tiddlywiki/client/i18n-card
 */
export const CARD_MESSAGES: { zh: Record<string, string>; en: Record<string, string> } = {
  zh: {
    // ── 卡片徽标：每个 tiddlywiki_* 工具一个（必须覆盖 TOOL_VIEW_KEYS）──────
    'card.toolGet': '读取笔记',
    'card.toolSearch': '检索笔记',
    'card.toolRecent': '最近修改',
    'card.toolListTags': '标签列表',
    'card.toolPut': '写入笔记',
    'card.toolBatchPut': '批量写入',
    'card.toolAppend': '增量写入',
    'card.toolReplace': '局部替换',
    'card.toolRename': '重命名笔记',
    'card.toolDelete': '删除笔记',
    'card.toolTrash': '回收站',
    'card.toolBacklinks': '反向链接',
    'card.toolAttach': '保存附件',
    'card.toolLint': '知识库体检',
    'card.toolGitSync': 'git 同步',
    'card.toolGitResolve': 'git 冲突解决',
    // ── 卡片外壳 ────────────────────────────────────────────────────────────
    'card.scopeBadgeTitle': '本会话作用域：{wiki}',
    'card.openInTw': '在 TW 打开',
    // ── 正文卡（get / put / rename / append）────────────────────────────────
    'card.rendering': '渲染中…',
    'card.tiddlerMissing': 'tiddler「{title}」不存在',
    'card.serviceUnavailable': 'wiki 服务不可用',
    'card.modifiedAt': '修改于 {modified}',
    'card.subRead': '读取',
    'card.subWritten': '已写入',
    'card.subAppended': '已增量写入',
    'card.subReplaced': '已局部替换',
    'card.subRenamed': '已重命名「{old}」→',
    // ── 检索卡（search）：作用域说明与摘要行 ────────────────────────────────
    'card.scopeNarrowed': ' · 已在工作区 {prefix}{id} 内缩小范围',
    'card.scopeWidened': ' · 工作区 {prefix}{id} 内 0 条，已扩大到全库',
    'card.queryLabel': '关键词「{query}」',
    'card.allQuery': '（全部）',
    'card.totalHits': ' · 共 {total} 条',
    'card.searchTitle': '检索',
    'card.noMatches': '没有匹配的笔记',
    // ── 附件卡 ──────────────────────────────────────────────────────────────
    'card.attachSavedRendered': '附件已保存进 wiki（二进制条目，卡片不内联渲染）。',
    'card.attachSaved': '附件已保存。',
    // ── 列表卡（recent / batch_put）─────────────────────────────────────────
    'card.recentTitle': '最近修改',
    'card.recentCount': '最近 {count} 条',
    'card.noNotes': '暂无笔记',
    'card.batchCount': '写入 {count} 篇',
    'card.batchNoItems': '（参数中没有可解析的 items）',
    'card.batchEmpty': '没有可展示的笔记',
    // ── 标签卡 ──────────────────────────────────────────────────────────────
    'card.tagsTitle': '标签',
    'card.tagsTotal': '共 {total} 个',
    'card.tagsMore': '…另有 {count} 个',
    'card.noTags': '暂无标签',
    // ── git / 删除卡 ────────────────────────────────────────────────────────
    'card.noResult': '（无结果）',
    'card.deletedTiddler': '已删除 tiddler「{title}」',
    'card.deleted': '（已删除）',
    // ── 调度器兜底文案 ──────────────────────────────────────────────────────
    'card.noCallInfo': '（无调用信息）',
    'card.pending': '处理中…',
    'card.callFailed': '工具调用失败',
    'card.done': '（完成）',
  },
  en: {
    'card.toolGet': 'Read note',
    'card.toolSearch': 'Search notes',
    'card.toolRecent': 'Recently changed',
    'card.toolListTags': 'Tag list',
    'card.toolPut': 'Write note',
    'card.toolBatchPut': 'Batch write',
    'card.toolAppend': 'Append to note',
    'card.toolReplace': 'Replace in note',
    'card.toolRename': 'Rename note',
    'card.toolDelete': 'Delete note',
    'card.toolTrash': 'Trash',
    'card.toolBacklinks': 'Backlinks',
    'card.toolAttach': 'Save attachment',
    'card.toolLint': 'Wiki checkup',
    'card.toolGitSync': 'git sync',
    'card.toolGitResolve': 'git conflict',
    'card.scopeBadgeTitle': 'Scope of this session: {wiki}',
    'card.openInTw': 'Open in TW',
    'card.rendering': 'Rendering…',
    'card.tiddlerMissing': 'tiddler "{title}" does not exist',
    'card.serviceUnavailable': 'wiki service unavailable',
    'card.modifiedAt': 'Modified {modified}',
    'card.subRead': 'Read',
    'card.subWritten': 'Written',
    'card.subAppended': 'Appended',
    'card.subReplaced': 'Replaced',
    'card.subRenamed': 'Renamed "{old}" →',
    'card.scopeNarrowed': ' · narrowed to workspace {prefix}{id}',
    'card.scopeWidened': ' · 0 hits in workspace {prefix}{id}, widened to the whole wiki',
    'card.queryLabel': 'query "{query}"',
    'card.allQuery': '(all)',
    'card.totalHits': ' · {total} total',
    'card.searchTitle': 'Search',
    'card.noMatches': 'No matching notes',
    'card.attachSavedRendered': 'Attachment saved into the wiki (a binary tiddler; the card does not inline it).',
    'card.attachSaved': 'Attachment saved.',
    'card.recentTitle': 'Recently changed',
    'card.recentCount': 'latest {count}',
    'card.noNotes': 'No notes yet',
    'card.batchCount': '{count} written',
    'card.batchNoItems': '(no parseable items in the arguments)',
    'card.batchEmpty': 'No notes to show',
    'card.tagsTitle': 'Tags',
    'card.tagsTotal': '{total} total',
    'card.tagsMore': '…{count} more',
    'card.noTags': 'No tags yet',
    'card.noResult': '(no result)',
    'card.deletedTiddler': 'Deleted tiddler "{title}"',
    'card.deleted': '(deleted)',
    'card.noCallInfo': '(no call information)',
    'card.pending': 'Working…',
    'card.callFailed': 'Tool call failed',
    'card.done': '(done)',
  },
}

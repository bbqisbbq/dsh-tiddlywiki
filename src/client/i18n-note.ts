/**
 * Messages for note (v0.30.6): 快速笔记卡片与原生编辑弹窗：note-widget.ts 及其 note-widget-{draft,tags,upload}.ts · editor-popup.ts · markdown-editor.ts.
 *
 * Key prefix `note.`. Keep `zh` and `en` key-for-key identical —
 * `scripts/verify-client-i18n.mjs` fails on any asymmetry, and every key must
 * also be USED (an unused entry is dead weight in the bundle).
 *
 * @module dsh-tiddlywiki/client/i18n-note
 */
export const NOTE_MESSAGES: { zh: Record<string, string>; en: Record<string, string> } = {
  zh: {
    'note.tagsPlaceholder': 'tag（可多选，自动补全）',
    'note.removeTag': '移除 tag「{tag}」',
    'note.addTag': '添加标签「{tag}」',
  },
  en: {
    'note.tagsPlaceholder': 'tag (multiple, with autocomplete)',
    'note.removeTag': 'Remove tag [{tag}]',
    'note.addTag': 'Add tag [{tag}]',
  },
}

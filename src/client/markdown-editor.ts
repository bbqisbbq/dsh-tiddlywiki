/**
 * CodeMirror 6 Markdown editor for the quick-note widget (replaces the
 * hand-rolled regex highlighter in the old markdown.ts — real Lezer syntax
 * tree, proper GFM coverage, undo/redo, and a native editing surface).
 *
 * The widget stays a plain-DOM product: CodeMirror is framework-agnostic, so
 * no React is pulled in. The editor is built into a wrapper `<div>`
 * (`.dsh-tw-note-editor`) that the widget can append, drag-drop onto, and
 * re-read via `getValue()`/`setValue()`.
 *
 * Theming follows the DSH design tokens (`--dsw-alias-*`) through a
 * `HighlightStyle` that maps Markdown tags onto the same palette the old
 * `.md-*` rules used, so light/dark both look right.
 *
 * @module dsh-tiddlywiki/client/markdown-editor
 */
import { EditorView, keymap, placeholder, drawSelection } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { tags as t } from '@lezer/highlight'

/** Design-token aliases (same values as styles.ts / the old .md-* rules). */
const BRAND = 'var(--dsw-alias-brand-primary, #3e63dd)'
const BRAND_DIM = 'color-mix(in srgb, var(--dsw-alias-brand-primary, #3e63dd) 55%, transparent)'
const SECONDARY = 'var(--dsw-alias-label-secondary, #888)'
const DIMMED = 'var(--dsw-alias-label-dimmed, #999)'
const MONO = 'ui-monospace, "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace'
const CODE_BG = 'color-mix(in srgb, var(--dsw-alias-label-secondary, #888) 12%, transparent)'
const CODE_BLOCK_BG = 'color-mix(in srgb, var(--dsw-alias-label-secondary, #888) 8%, transparent)'

/** Markdown token → design-token style map (mirrors the old .md-* palette). */
const mdHighlight = HighlightStyle.define([
  // Headings (# … ######) — brand + bold.
  { tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], color: BRAND, fontWeight: '700' },
  // Markers: #, >, -, *, `, [ ] etc.
  { tag: t.processingInstruction, color: BRAND_DIM },
  // Inline code + fenced code text — monospace, tinted background.
  { tag: t.monospace, fontFamily: MONO, backgroundColor: CODE_BG, borderRadius: '4px', padding: '0 3px' },
  // Code block content (inside a fence) gets a slightly wider tint.
  { tag: t.content, fontFamily: MONO, backgroundColor: CODE_BLOCK_BG },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', opacity: '.75' },
  { tag: t.link, color: BRAND, textDecoration: 'underline' },
  { tag: t.url, color: BRAND_DIM, textDecoration: 'underline dotted' },
  { tag: t.quote, fontStyle: 'italic', color: SECONDARY },
  { tag: t.contentSeparator, color: DIMMED, textDecoration: 'line-through' },
  { tag: t.comment, color: DIMMED },
])

/** Public editor surface the quick-note widget consumes. */
export interface MarkdownEditor {
  /** Wrapper element (append/drag-target). */
  el: HTMLDivElement
  /** The CodeMirror EditorView (advanced use / future extensions). */
  view: EditorView
  getValue(): string
  setValue(value: string): void
  /** Insert a Markdown line at the current caret (used by file upload). */
  insertAtCaret(markdown: string): void
  focus(): void
}

export interface MarkdownEditorOptions {
  /** Placeholder text shown when the doc is empty. */
  placeholder?: string
  /** Called on Ctrl/Cmd+Enter (wired after save is defined by the widget). */
  onSave?: () => void
  /** Called after every doc change (used for draft auto-save). */
  onChange?: () => void
}

/**
 * Build a CodeMirror 6 Markdown editor inside `.dsh-tw-note-editor`.
 * GFM base language (strikethrough, tables, task lists, autolinks) — strictly
 * more coverage than the old regex highlighter.
 */
export function buildMarkdownEditor(opts: MarkdownEditorOptions = {}): MarkdownEditor {
  const wrap = document.createElement('div')
  wrap.className = 'dsh-tw-note-editor'

  const view = new EditorView({
    parent: wrap,
    state: EditorState.create({
      doc: '',
      extensions: [
        EditorView.lineWrapping,
        history(),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(mdHighlight),
        drawSelection(),
        placeholder(opts.placeholder ?? ''),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          { key: 'Mod-Enter', run: () => { opts.onSave?.(); return true } },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) opts.onChange?.()
        }),
      ],
    }),
  })

  return {
    el: wrap,
    view,
    getValue: () => view.state.doc.toString(),
    setValue(value: string) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    },
    insertAtCaret(markdownLine: string) {
      const { from } = view.state.selection.main
      const line = view.state.doc.lineAt(from)
      const atLineStart = from === line.from
      const insert = `${atLineStart ? '' : '\n'}${markdownLine}\n`
      view.dispatch({
        changes: { from, insert },
        selection: { anchor: from + insert.length },
        scrollIntoView: true,
      })
      view.focus()
    },
    focus: () => view.focus(),
  }
}

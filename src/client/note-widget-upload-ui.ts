/**
 * Upload UI for the quick-note card (v0.30.46 slice): the 「上传」 button, its
 * hidden file input, and drop-onto-the-editor wiring.
 *
 * Two layers, deliberately in two files:
 *   - note-widget-upload.ts     the ACT  — `uploadInto(file, editor, wikiQuery)`
 *                               validates the size, POSTs, inserts the Markdown
 *                               line at the caret, toasts the result.
 *   - note-widget-upload-ui.ts  the WIRING (this file) — where the File objects
 *                               come from (button / drop) and when the editor
 *                               shows its `.dsh-tw-note-drop` highlight.
 *
 * Boundary (why this could leave `note-widget.ts` untouched elsewhere): the whole
 * group asks the card for exactly two things — the editor (the drop target and
 * the insertion point) and `wikiQuery` (uploads must land in the CARD's target
 * wiki, not the default one). `dragDepth` is this group's own state and travels
 * with it, so the card keeps no upload state at all.
 *
 * @module dsh-tiddlywiki/client/note-widget-upload-ui
 */
import { t } from './i18n.ts'
import { type MarkdownEditor } from './markdown-editor.ts'
import { uploadInto } from './note-widget-upload.ts'

export interface NoteUploadUiDeps {
  /** The card's Markdown editor: the drop target AND the insertion point. */
  editor: MarkdownEditor
  /** Scopes every upload to the card's target wiki (see `uploadInto`). */
  wikiQuery: (url: string) => string
}

export interface NoteUploadUi {
  /** The 「上传」 button — the card puts it in the card's footer. */
  button: HTMLButtonElement
}

/** Build the upload button + wire drag & drop onto `editor.el`. */
export function createNoteUploadUi(deps: NoteUploadUiDeps): NoteUploadUi {
  const { editor, wikiQuery } = deps

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'dsh-tw-note-upload'
  button.title = t('note.uploadTitle')
  button.textContent = t('note.upload')
  // The file input is never attached to the DOM — the button proxies its click.
  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.multiple = true
  fileInput.hidden = true
  button.addEventListener('click', () => { fileInput.click() })
  fileInput.addEventListener('change', () => {
    for (const file of Array.from(fileInput.files ?? [])) void uploadInto(file, editor, wikiQuery)
    fileInput.value = ''
  })

  // dragenter / dragleave fire per child element too, so a boolean would flash
  // the highlight off on every internal move: count the depth instead and only
  // drop the class when the pointer really left the editor.
  let dragDepth = 0
  editor.el.addEventListener('dragenter', (event) => {
    event.preventDefault()
    dragDepth++
    editor.el.classList.add('dsh-tw-note-drop')
  })
  editor.el.addEventListener('dragover', (event) => { event.preventDefault() })
  editor.el.addEventListener('dragleave', (event) => {
    event.preventDefault()
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) editor.el.classList.remove('dsh-tw-note-drop')
  })
  editor.el.addEventListener('drop', (event) => {
    event.preventDefault()
    dragDepth = 0
    editor.el.classList.remove('dsh-tw-note-drop')
    const files = event.dataTransfer?.files
    if (files === undefined || files.length === 0) return
    for (const file of Array.from(files)) void uploadInto(file, editor, wikiQuery)
  })

  return { button }
}

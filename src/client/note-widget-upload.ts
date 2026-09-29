/**
 * Attachment upload for the quick-note card (v0.28.8 split).
 *
 * One function, one concern: take a `File` the user dropped / picked, POST it to
 * the upload route, and insert the resulting Markdown image/link line at the
 * caret. Kept out of `note-widget.ts` so the widget file stays about the card's
 * state machine and DOM.
 *
 * @module dsh-tiddlywiki/client/note-widget-upload
 */
import { t } from './i18n.ts'
import { toast } from './toast.ts'
import { type MarkdownEditor } from './markdown-editor.ts'
import { UPLOAD_ENDPOINT } from './endpoints.ts'

export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/**
 * Upload one file to the wiki (raw body, name in ?name=), then insert a
 * Markdown image/link line at the caret of the given editor.
 *
 * `wikiQuery` scopes the upload to the CARD's target knowledge base (v0.28.0):
 * an attachment must land in the same wiki as the note that references it.
 */
export async function uploadInto(file: File, editor: MarkdownEditor, wikiQuery: (url: string) => string = (url) => url): Promise<void> {
  if (file.size > MAX_UPLOAD_BYTES) {
    toast(t('note.uploadTooLarge', { mb: Math.round(MAX_UPLOAD_BYTES / 1024 / 1024) }))
    return
  }
  try {
    const res = await fetch(wikiQuery(`${UPLOAD_ENDPOINT}?name=${encodeURIComponent(file.name)}`), {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
      signal: AbortSignal.timeout(120_000),
    })
    const payload = (await res.json().catch(() => null)) as { ok?: boolean; name?: string; url?: string; error?: string } | null
    if (!res.ok || payload?.ok !== true) {
      toast(t('note.uploadFailed', { message: payload?.error ?? `HTTP ${res.status}` }))
      return
    }
    const name = payload.name ?? file.name
    const markdown = file.type.startsWith('image/')
      ? `![${name}](${payload.url})`
      : `[${name}](${payload.url})`
    editor.insertAtCaret(markdown)
    toast(t('note.uploaded', { name }))
  } catch (err) {
    toast(t('note.uploadFailed', { message: err instanceof Error ? err.message : String(err) }))
  }
}

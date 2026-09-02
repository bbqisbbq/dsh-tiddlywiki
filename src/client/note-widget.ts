/**
 * Floating quick-note widget (design doc §12, D6/D7) — bottom-right, fixed,
 * collapsible, independent of any shell DOM. Lets the human jot drafts /
 * scratch notes while waiting for the AI or drafting the next prompt.
 *
 * Save posts to /dsh-tiddlywiki/note → an independent tiddler (title & tag
 * editable; defaults: timestamp title + config tag, usually "inbox").
 *
 * @module dsh-tiddlywiki/client/note-widget
 */
import { toast } from './toast.ts'
import { openEditorPopup } from './editor-popup.ts'

const NOTE_ENDPOINT = '/dsh-tiddlywiki/note'
const EDIT_ENDPOINT = '/dsh-tiddlywiki/edit'
const STATUS_ENDPOINT = '/dsh-tiddlywiki/status'

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Default note title: `YYYY-MM-DD HH:mm`. */
function timestampTitle(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function fetchDefaultTag(): Promise<string> {
  try {
    const res = await fetch(STATUS_ENDPOINT, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return 'inbox'
    const payload = (await res.json()) as { note?: { tag?: string } }
    return payload.note?.tag ?? 'inbox'
  } catch {
    return 'inbox'
  }
}

export function mountNoteWidget(): () => void {
  const root = document.createElement('div')
  root.className = 'dsh-tw-note'

  const card = document.createElement('div')
  card.className = 'dsh-tw-note-card'
  card.hidden = true

  const head = document.createElement('div')
  head.className = 'dsh-tw-note-head'
  const label = document.createElement('span')
  label.className = 'dsh-tw-note-label'
  label.textContent = '📝 快速笔记'
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'dsh-tw-note-close'
  closeBtn.title = '收起'
  closeBtn.textContent = '✕'
  head.append(label, closeBtn)

  const fields = document.createElement('div')
  fields.className = 'dsh-tw-note-fields'
  const titleInput = document.createElement('input')
  titleInput.className = 'dsh-tw-note-title'
  titleInput.placeholder = '标题（默认时间戳）'
  const tagInput = document.createElement('input')
  tagInput.className = 'dsh-tw-note-tag'
  tagInput.placeholder = 'tag（默认 inbox）'
  fields.append(titleInput, tagInput)

  const textarea = document.createElement('textarea')
  textarea.className = 'dsh-tw-note-text'
  textarea.placeholder = '写点东西…（Ctrl+Enter 保存）'

  const foot = document.createElement('div')
  foot.className = 'dsh-tw-note-foot'
  const hint = document.createElement('span')
  hint.className = 'dsh-tw-note-hint'
  hint.textContent = 'Ctrl+Enter'
  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'dsh-tw-note-edit'
  edit.title = '保存并在 TiddlyWiki 原生编辑器中打开'
  edit.textContent = '✏️ 在 TW 中编辑'
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'dsh-tw-note-save'
  save.textContent = '保存'
  foot.append(hint, edit, save)

  card.append(head, fields, textarea, foot)

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'dsh-tw-note-toggle'
  toggle.textContent = '📝 快速笔记'

  root.append(card, toggle)
  document.body.append(root)

  let defaultTag = 'inbox'
  let opened = false

  const resetTitle = (): void => {
    titleInput.value = timestampTitle()
  }

  const open = async (): Promise<void> => {
    card.hidden = false
    opened = true
    resetTitle()
    if (tagInput.value.length === 0) tagInput.value = defaultTag
    textarea.focus()
    // Refresh the configured default tag on each open (cheap, best effort).
    defaultTag = await fetchDefaultTag()
    if (tagInput.value.length === 0) tagInput.value = defaultTag
  }

  const close = (): void => {
    card.hidden = true
    opened = false
  }

  toggle.addEventListener('click', () => { void (opened ? close() : open()) })
  closeBtn.addEventListener('click', close)

  const doSave = async (): Promise<void> => {
    const text = textarea.value.trim()
    if (text.length === 0) {
      toast('内容为空，未保存')
      return
    }
    save.disabled = true
    save.textContent = '保存中…'
    try {
      const res = await fetch(NOTE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: titleInput.value.trim(),
          tag: tagInput.value.trim(),
          text,
        }),
        signal: AbortSignal.timeout(10_000),
      })
      const payload = (await res.json().catch(() => null)) as { ok?: boolean; title?: string; error?: string } | null
      if (!res.ok || payload?.ok !== true) {
        toast(`保存失败：${payload?.error ?? `HTTP ${res.status}`}`)
        return
      }
      textarea.value = ''
      resetTitle()
      toast(`已保存「${payload.title ?? titleInput.value}」`)
      close()
    } catch (err) {
      toast(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      save.disabled = false
      save.textContent = '保存'
    }
  }

  save.addEventListener('click', () => { void doSave() })
  textarea.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      void doSave()
    }
  })

  /** Save (if non-empty) and open the tiddler in TW's native editor. */
  const doEdit = async (): Promise<void> => {
    const title = titleInput.value.trim().length > 0 ? titleInput.value.trim() : timestampTitle()
    const text = textarea.value
    const tag = tagInput.value.trim()
    edit.disabled = true
    edit.textContent = '打开中…'
    try {
      const res = await fetch(EDIT_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, tag, text }),
        signal: AbortSignal.timeout(10_000),
      })
      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; title?: string; draftTitle?: string; twUrl?: string; error?: string }
        | null
      if (!res.ok || payload?.ok !== true) {
        toast(`打开失败：${payload?.error ?? `HTTP ${res.status}`}`)
        return
      }
      if (typeof payload.twUrl !== 'string' || typeof payload.draftTitle !== 'string') {
        toast('打开失败：服务未返回编辑器地址')
        return
      }
      openEditorPopup(`${payload.twUrl}#${encodeURIComponent(payload.draftTitle)}`, payload.title ?? title)
      toast(`已在弹出窗口打开「${payload.title ?? title}」编辑器`)
    } catch (err) {
      toast(`打开失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      edit.disabled = false
      edit.textContent = '✏️ 在 TW 中编辑'
    }
  }

  edit.addEventListener('click', () => { void doEdit() })

  return () => {
    root.remove()
    const toastEl = document.querySelector<HTMLElement>('.dsh-tw-toast')
    toastEl?.remove()
  }
}

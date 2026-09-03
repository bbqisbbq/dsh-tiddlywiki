/**
 * Floating quick-note widget (design doc §12, D6/D7) — bottom-right, fixed,
 * collapsible, independent of any shell DOM. Lets the human jot drafts /
 * scratch notes while waiting for the AI or drafting the next prompt.
 *
 * Save posts to /dsh-tiddlywiki/note → an independent tiddler (title & tags
 * editable; defaults: timestamp title + config tag, usually "inbox").
 *
 * ui.showQuickNote config: the widget is mounted async and stays hidden (and
 * never appended) when the option is off, so the toggle button can be disabled
 * from the settings page without touching the shell.
 *
 * Tag editor: multi-select chips + autocomplete from the wiki's existing tags
 * (GET /dsh-tiddlywiki/tags). Enter/`,` commits the typed value; Backspace on
 * an empty field removes the last chip; the dropdown filters on typing.
 *
 * Markdown editing: a "highlighted textarea" overlay (a `<pre>` rendered
 * behind a transparent-text `<textarea>`, see markdown.ts) so Markdown is
 * syntax-highlighted as you type — no dependencies, perfect alignment.
 *
 * File upload: the body accepts files via the 📎 button or drag-and-drop;
 * each file is POSTed raw to /dsh-tiddlywiki/upload (saved under the wiki's
 * `files/` folder, git-tracked and served at `/files/<name>`) and a Markdown
 * image/link line is inserted at the caret.
 *
 * @module dsh-tiddlywiki/client/note-widget
 */
import { toast } from './toast.ts'
import { openEditorPopup } from './editor-popup.ts'
import { highlightMarkdown } from './markdown.ts'

const NOTE_ENDPOINT = '/dsh-tiddlywiki/note'
const EDIT_ENDPOINT = '/dsh-tiddlywiki/edit'
const STATUS_ENDPOINT = '/dsh-tiddlywiki/status'
const TAGS_ENDPOINT = '/dsh-tiddlywiki/tags'
const UPLOAD_ENDPOINT = '/dsh-tiddlywiki/upload'
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Default note title: `YYYY-MM-DD HH:mm`. */
function timestampTitle(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

interface UiOptions {
  showQuickNote: boolean
  defaultTag: string
}

async function fetchUiOptions(): Promise<UiOptions> {
  const fallback: UiOptions = { showQuickNote: true, defaultTag: 'inbox' }
  try {
    const res = await fetch(STATUS_ENDPOINT, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return fallback
    const payload = (await res.json()) as { ui?: { showQuickNote?: boolean }; note?: { tag?: string } }
    return {
      showQuickNote: payload.ui?.showQuickNote !== false,
      defaultTag: payload.note?.tag ?? 'inbox',
    }
  } catch {
    return fallback
  }
}

/** Multi-tag chip editor with autocomplete from the wiki's existing tags. */
function buildTagEditor(): {
  el: HTMLDivElement
  getTags: () => string[]
  setDefault: (tag: string) => void
} {
  const wrap = document.createElement('div')
  wrap.className = 'dsh-tw-note-tags'

  const chipWrap = document.createElement('div')
  chipWrap.className = 'dsh-tw-note-chips'
  const input = document.createElement('input')
  input.className = 'dsh-tw-note-taginput'
  input.placeholder = 'tag（可多选，自动补全）'
  const suggest = document.createElement('div')
  suggest.className = 'dsh-tw-note-tagsuggest'
  suggest.hidden = true
  wrap.append(chipWrap, input, suggest)

  const chips: string[] = []
  const hideSuggest = (): void => { suggest.hidden = true }

  const renderChips = (): void => {
    chipWrap.replaceChildren()
    for (const tag of chips) {
      const chip = document.createElement('span')
      chip.className = 'dsh-tw-note-tagchip'
      chip.textContent = tag
      const x = document.createElement('span')
      x.className = 'dsh-tw-note-tagchip-x'
      x.textContent = '×'
      x.title = `移除 tag「${tag}」`
      x.addEventListener('click', (event) => {
        event.stopPropagation()
        const i = chips.indexOf(tag)
        if (i >= 0) {
          chips.splice(i, 1)
          renderChips()
        }
      })
      chip.append(x)
      chipWrap.append(chip)
    }
  }

  const addTag = (tag: string): void => {
    const t = tag.trim()
    if (t.length === 0 || chips.includes(t)) return
    chips.push(t)
    input.value = ''
    renderChips()
    hideSuggest()
    input.focus()
  }

  const commitInput = (): void => {
    for (const raw of input.value.split(/\s+/)) addTag(raw)
  }

  // Existing tags, fetched lazily once per widget lifetime.
  let knownTags: string[] = []
  let tagsPromise: Promise<string[]> | undefined
  const ensureTags = (): Promise<string[]> => {
    tagsPromise ??= fetch(TAGS_ENDPOINT, { signal: AbortSignal.timeout(5_000) })
      .then((r) => (r.ok ? (r.json() as Promise<{ tags?: string[] }>) : Promise.resolve<{ tags?: string[] }>({})))
      .then((p) => [...(p.tags ?? [])].sort((a, b) => a.localeCompare(b, 'zh')))
      .catch(() => [])
    void tagsPromise.then((list) => { knownTags = list })
    return tagsPromise
  }

  const showSuggest = (): void => {
    const q = input.value.trim().toLowerCase()
    const matches = knownTags
      .filter((t) => !chips.includes(t) && (q.length === 0 || t.toLowerCase().includes(q)))
      .slice(0, 8)
    suggest.replaceChildren()
    for (const tag of matches) {
      const item = document.createElement('div')
      item.className = 'dsh-tw-note-tagsuggest-item'
      item.textContent = tag
      item.addEventListener('mousedown', (event) => {
        event.preventDefault()
        addTag(tag)
      })
      suggest.append(item)
    }
    suggest.hidden = matches.length === 0
  }

  input.addEventListener('focus', () => { void ensureTags().then(showSuggest) })
  input.addEventListener('input', () => {
    if (knownTags.length === 0) void ensureTags().then(showSuggest)
    else showSuggest()
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      commitInput()
    } else if (event.key === 'Backspace' && input.value.length === 0 && chips.length > 0) {
      chips.pop()
      renderChips()
    } else if (event.key === 'Escape') {
      hideSuggest()
    }
  })
  document.addEventListener('click', (event) => {
    if (!wrap.contains(event.target as Node)) hideSuggest()
  }, true)

  return {
    el: wrap,
    getTags: () => {
      commitInput()
      return [...chips]
    },
    setDefault: (tag: string) => {
      // Only pre-fill when nothing is chosen yet; never steal focus.
      if (chips.length === 0) {
        const t = tag.trim()
        if (t.length > 0) {
          chips.push(t)
          renderChips()
        }
      }
    },
  }
}

/**
 * Markdown editor: a `<pre>` overlay (highlighted by markdown.ts) rendered
 * behind a transparent-text `<textarea>` with identical metrics. Scroll is
 * mirrored; on every input the overlay is re-rendered. The text layer stays
 * exactly aligned with the highlight layer because the highlighter never
 * changes the user's characters.
 */
function buildEditor(): {
  el: HTMLDivElement
  textarea: HTMLTextAreaElement
  render: () => void
  focus: () => void
} {
  const wrap = document.createElement('div')
  wrap.className = 'dsh-tw-note-editor'

  const hl = document.createElement('pre')
  hl.className = 'dsh-tw-note-hl'
  hl.setAttribute('aria-hidden', 'true')

  const textarea = document.createElement('textarea')
  textarea.className = 'dsh-tw-note-text'
  textarea.placeholder = '写点东西… Markdown 高亮，可 📎/拖入文件\nCtrl+Enter 保存'

  wrap.append(hl, textarea)

  const render = (): void => {
    hl.innerHTML = `${highlightMarkdown(textarea.value)}\n`
    hl.scrollTop = textarea.scrollTop
    hl.scrollLeft = textarea.scrollLeft
  }

  const syncScroll = (): void => {
    hl.scrollTop = textarea.scrollTop
    hl.scrollLeft = textarea.scrollLeft
  }

  textarea.addEventListener('input', render)
  textarea.addEventListener('scroll', syncScroll)
  render()

  return { el: wrap, textarea, render, focus: () => textarea.focus() }
}

/**
 * Upload one file to the wiki (raw body, name in ?name=), then insert a
 * Markdown image/link line at the caret of the given editor.
 */
async function uploadInto(file: File, editor: { textarea: HTMLTextAreaElement; render: () => void }): Promise<void> {
  if (file.size > MAX_UPLOAD_BYTES) {
    toast(`文件过大（≤ ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB）`)
    return
  }
  try {
    const res = await fetch(`${UPLOAD_ENDPOINT}?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
      signal: AbortSignal.timeout(120_000),
    })
    const payload = (await res.json().catch(() => null)) as { ok?: boolean; name?: string; url?: string; error?: string } | null
    if (!res.ok || payload?.ok !== true) {
      toast(`上传失败：${payload?.error ?? `HTTP ${res.status}`}`)
      return
    }
    const name = payload.name ?? file.name
    const markdown = file.type.startsWith('image/')
      ? `![${name}](${payload.url})`
      : `[${name}](${payload.url})`
    const ta = editor.textarea
    const start = ta.selectionStart ?? ta.value.length
    const end = ta.selectionEnd ?? start
    const before = ta.value.slice(0, start)
    const after = ta.value.slice(end)
    const needsLead = start > 0 && !before.endsWith('\n')
    const insert = `${needsLead ? '\n' : ''}${markdown}\n`
    ta.value = `${before}${insert}${after}`
    const caret = (before + insert).length
    ta.setSelectionRange(caret, caret)
    ta.focus()
    editor.render()
    toast(`已上传「${name}」并插入链接`)
  } catch (err) {
    toast(`上传失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Build the whole widget DOM and wire it up (returns the appended root). */
function buildWidget(): HTMLDivElement {
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
  const tagEditor = buildTagEditor()
  fields.append(titleInput, tagEditor.el)

  const editor = buildEditor()
  const textarea = editor.textarea

  // ── file upload (button + drag & drop onto the editor) ────────────────
  const uploadBtn = document.createElement('button')
  uploadBtn.type = 'button'
  uploadBtn.className = 'dsh-tw-note-upload'
  uploadBtn.title = '上传文件到 wiki 并插入 Markdown 链接（也可直接拖入编辑器）'
  uploadBtn.textContent = '📎 上传'
  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.multiple = true
  fileInput.hidden = true
  uploadBtn.addEventListener('click', () => { fileInput.click() })
  fileInput.addEventListener('change', () => {
    for (const file of Array.from(fileInput.files ?? [])) void uploadInto(file, editor)
    fileInput.value = ''
  })

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
    for (const file of Array.from(files)) void uploadInto(file, editor)
  })

  const foot = document.createElement('div')
  foot.className = 'dsh-tw-note-foot'
  const footLeft = document.createElement('div')
  footLeft.className = 'dsh-tw-note-foot-left'
  const hint = document.createElement('span')
  hint.className = 'dsh-tw-note-hint'
  hint.textContent = 'Ctrl+Enter'
  footLeft.append(uploadBtn, hint)
  const footRight = document.createElement('div')
  footRight.className = 'dsh-tw-note-foot-right'
  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'dsh-tw-note-edit'
  edit.title = '保存并在 TiddlyWiki 原生编辑器中打开'
  edit.textContent = '✏️ 在 TW 中编辑'
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'dsh-tw-note-save'
  save.textContent = '保存'
  footRight.append(edit, save)
  foot.append(footLeft, footRight)

  card.append(head, fields, editor.el, foot)

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
    editor.focus()
    // Fetch the effective default tag once, then pre-fill if nothing is chosen.
    defaultTag = (await fetchUiOptions()).defaultTag
    tagEditor.setDefault(defaultTag)
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
          tags: tagEditor.getTags(),
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
      editor.render()
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
    const tags = tagEditor.getTags()
    edit.disabled = true
    edit.textContent = '打开中…'
    try {
      const res = await fetch(EDIT_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, tags, text }),
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

  return root
}

/**
 * Mount the floating quick-note widget. Fetches /status first: when
 * `ui.showQuickNote` is off the widget is never created (no DOM side effects).
 * Returns a disposer that removes it.
 */
export function mountNoteWidget(): () => void {
  let disposed = false
  let root: HTMLDivElement | undefined
  const disposer = (): void => {
    disposed = true
    root?.remove()
    const toastEl = document.querySelector<HTMLElement>('.dsh-tw-toast')
    toastEl?.remove()
  }
  void (async () => {
    const ui = await fetchUiOptions()
    if (disposed || !ui.showQuickNote) return
    root = buildWidget()
  })()
  return disposer
}

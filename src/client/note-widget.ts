/**
 * Floating quick-note card (design doc §12, D6/D7) — a bottom-right, fixed,
 * collapsible card for jotting drafts / scratch notes while waiting for the AI
 * or drafting the next prompt. In v0.5 the trigger moved into the "知识库" FAB
 * (knowledge-fab.ts); this module ONLY owns the card itself via
 * `createNoteWidget()` (lazy build — no DOM until first open).
 *
 * Features:
 * - CodeMirror 6 Markdown editor (see markdown-editor.ts), file upload + drag
 *   & drop, multi-tag chips with autocomplete (GET /dsh-tiddlywiki/tags).
 * - DRAFT PERSISTENCE: editor/title/tags auto-save to localStorage on a 500ms
 *   debounce; reopening restores the draft with a "丢弃" banner. A successful
 *   save / "在 TW 中编辑" clears it.
 * - RECENT PICKER: a 「最近」 button lists the newest notes (GET
 *   /dsh-tiddlywiki/recent); clicking one loads it into the editor (GET
 *   /dsh-tiddlywiki/get) to continue editing.
 * - Ctrl+Enter saves; 「✏️ 在 TW 中编辑」 saves and opens TW's native editor.
 *
 * Save posts to /dsh-tiddlywiki/note → an independent tiddler (title & tags
 * editable; defaults: timestamp title + config tag, usually "inbox").
 *
 * @module dsh-tiddlywiki/client/note-widget
 */
import { toast } from './toast.ts'
import { openEditorPopup } from './editor-popup.ts'
import { buildMarkdownEditor, type MarkdownEditor } from './markdown-editor.ts'

const NOTE_ENDPOINT = '/dsh-tiddlywiki/note'
const EDIT_ENDPOINT = '/dsh-tiddlywiki/edit'
const STATUS_ENDPOINT = '/dsh-tiddlywiki/status'
const TAGS_ENDPOINT = '/dsh-tiddlywiki/tags'
const RECENT_ENDPOINT = '/dsh-tiddlywiki/recent'
const GET_ENDPOINT = '/dsh-tiddlywiki/get'
const UPLOAD_ENDPOINT = '/dsh-tiddlywiki/upload'
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/** localStorage key for the autosaved quick-note draft. */
const DRAFT_KEY = 'dsh-tw-note-draft-v1'
/** Draft auto-save debounce. */
const DRAFT_DEBOUNCE_MS = 500

interface Draft { text: string; title: string; tags: string[]; savedAt: number }

function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Partial<Draft>
    if (typeof parsed.text !== 'string' || typeof parsed.title !== 'string') return null
    return {
      text: parsed.text,
      title: parsed.title,
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === 'string') : [],
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
    }
  } catch {
    return null
  }
}

function persistDraft(draft: Draft): void {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)) } catch { /* storage unavailable */ }
}

function clearDraft(): void {
  try { localStorage.removeItem(DRAFT_KEY) } catch { /* ignore */ }
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Default note title: `YYYY-MM-DD HH:mm`. */
function timestampTitle(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Compact Chinese relative time for the recent picker (e.g. "3小时前"). */
function relativeTime(iso: string | null): string {
  if (iso === null) return ''
  const ms = new Date(iso).getTime()
  if (Number.isNaN(ms)) return ''
  const diff = Date.now() - ms
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min}分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}天前`
  return new Date(ms).toLocaleDateString('zh-CN')
}

interface UiOptions { showQuickNote: boolean; defaultTag: string }

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
function buildTagEditor(opts: { onChange?: () => void } = {}): {
  el: HTMLDivElement
  getTags: () => string[]
  setDefault: (tag: string) => void
  setTags: (tags: string[]) => void
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

  const emit = (): void => { opts.onChange?.() }

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
          emit()
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
    emit()
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
      emit()
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
    setTags: (tags: string[]) => {
      chips.length = 0
      for (const tag of Array.isArray(tags) ? tags : []) {
        const t = typeof tag === 'string' ? tag.trim() : ''
        if (t.length > 0 && !chips.includes(t)) chips.push(t)
      }
      input.value = ''
      renderChips()
      hideSuggest()
    },
  }
}

/** All DOM refs created by build(); undefined until the first open. */
interface BuiltUi {
  root: HTMLDivElement
  card: HTMLDivElement
  editor: MarkdownEditor
  titleInput: HTMLInputElement
  tagEditor: ReturnType<typeof buildTagEditor>
  saveBtn: HTMLButtonElement
  editBtn: HTMLButtonElement
  draftBanner: HTMLDivElement
  recentBtn: HTMLButtonElement
  recentWrap: HTMLDivElement
}

/**
 * Upload one file to the wiki (raw body, name in ?name=), then insert a
 * Markdown image/link line at the caret of the given editor.
 */
async function uploadInto(file: File, editor: MarkdownEditor): Promise<void> {
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
    editor.insertAtCaret(markdown)
    toast(`已上传「${name}」并插入链接`)
  } catch (err) {
    toast(`上传失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

interface RecentItem { title: string; tags: string[]; modified: string | null; snippet: string }

/** The quick-note card handle the FAB drives. */
export interface NoteWidgetHandle {
  open(): Promise<void>
  close(): void
  toggle(): Promise<void>
  isOpen(): boolean
  dispose(): void
}

/**
 * Create the quick-note card. Lazy: no DOM is created until the first
 * `open()`, so a hidden widget (`ui.showQuickNote` off, or never used) leaves
 * no side effects. Returns a handle the "知识库" FAB controls.
 */
export function createNoteWidget(): NoteWidgetHandle {
  // ── lazily-built state ──────────────────────────────────────────────────
  let ui: BuiltUi | undefined
  let disposed = false
  let opened = false
  let defaultTag = 'inbox'
  let draftTimer: number | undefined
  let recentOpen = false

  const resetTitle = (): void => {
    if (ui !== undefined) ui.titleInput.value = timestampTitle()
  }

  /** Debounced draft auto-save (500ms after the last change). */
  const scheduleDraft = (): void => {
    if (disposed || !opened || ui === undefined) return
    if (draftTimer !== undefined) { clearTimeout(draftTimer); draftTimer = undefined }
    draftTimer = window.setTimeout(() => {
      draftTimer = undefined
      if (ui === undefined) return
      const text = ui.editor.getValue()
      const title = ui.titleInput.value.trim()
      if (text.trim().length === 0 && title.length === 0) {
        clearDraft()
        return
      }
      persistDraft({ text, title, tags: ui.tagEditor.getTags(), savedAt: Date.now() })
    }, DRAFT_DEBOUNCE_MS)
  }

  const hideDraftBanner = (): void => {
    if (ui !== undefined) ui.draftBanner.hidden = true
  }

  const closeRecent = (): void => {
    recentOpen = false
    if (ui !== undefined) ui.recentWrap.hidden = true
  }

  /** Load a tiddler into the editor (recent picker click). */
  const loadNote = async (title: string): Promise<void> => {
    try {
      const res = await fetch(`${GET_ENDPOINT}?title=${encodeURIComponent(title)}`, { signal: AbortSignal.timeout(10_000) })
      const payload = (await res.json().catch(() => null)) as { ok?: boolean; title?: string; text?: string; tags?: string[]; notFound?: boolean; error?: string } | null
      if (!res.ok || payload?.ok !== true || typeof payload.title !== 'string') {
        const reason = payload?.notFound === true ? '不存在' : (payload?.error ?? `HTTP ${res.status}`)
        toast(`读取失败：${reason}`)
        return
      }
      if (ui === undefined) return
      ui.editor.setValue(payload.text ?? '')
      ui.titleInput.value = payload.title
      ui.tagEditor.setTags(payload.tags ?? [])
      hideDraftBanner()
      closeRecent()
      toast(`已载入「${payload.title}」`)
      ui.editor.focus()
    } catch (err) {
      toast(`读取失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Toggle the recent-notes dropdown (fetches lazily each open). */
  const toggleRecent = (): void => {
    if (ui === undefined) return
    if (recentOpen) { closeRecent(); return }
    recentOpen = true
    ui.recentWrap.hidden = false
    ui.recentWrap.textContent = ''
    const loading = document.createElement('div')
    loading.className = 'dsh-tw-note-recent-muted'
    loading.textContent = '加载中…'
    ui.recentWrap.append(loading)
    void (async () => {
      try {
        const res = await fetch(`${RECENT_ENDPOINT}?limit=15`, { signal: AbortSignal.timeout(10_000) })
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; items?: RecentItem[]; error?: string } | null
        if (!recentOpen || ui === undefined) return
        ui.recentWrap.replaceChildren()
        const items = payload?.ok === true ? (payload.items ?? []) : []
        if (items.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'dsh-tw-note-recent-muted'
          empty.textContent = payload?.ok === true ? '暂无笔记' : `加载失败：${payload?.error ?? '未知'}`
          ui.recentWrap.append(empty)
          return
        }
        for (const item of items) {
          const row = document.createElement('div')
          row.className = 'dsh-tw-note-recent-item'
          row.title = item.snippet || item.title
          const name = document.createElement('span')
          name.className = 'dsh-tw-note-recent-name'
          name.textContent = item.title
          const meta = document.createElement('span')
          meta.className = 'dsh-tw-note-recent-meta'
          const bits: string[] = [relativeTime(item.modified)]
          if (item.tags.length > 0) bits.unshift(item.tags.slice(0, 3).join(','))
          meta.textContent = bits.join(' · ')
          row.append(name, meta)
          row.addEventListener('click', () => { void loadNote(item.title) })
          ui.recentWrap.append(row)
        }
      } catch (err) {
        if (!recentOpen || ui === undefined) return
        ui.recentWrap.replaceChildren()
        const empty = document.createElement('div')
        empty.className = 'dsh-tw-note-recent-muted'
        empty.textContent = `加载失败：${err instanceof Error ? err.message : String(err)}`
        ui.recentWrap.append(empty)
      }
    })()
  }

  /** Build the whole card DOM once, then wire every interaction. */
  const build = (): void => {
    if (ui !== undefined) return

    const root = document.createElement('div')
    root.className = 'dsh-tw-note'
    root.hidden = true

    const card = document.createElement('div')
    card.className = 'dsh-tw-note-card'

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

    // Restored-draft banner (hidden until a draft is restored).
    const draftBanner = document.createElement('div')
    draftBanner.className = 'dsh-tw-note-draft'
    draftBanner.hidden = true
    const bannerText = document.createElement('span')
    bannerText.className = 'dsh-tw-note-draft-text'
    bannerText.textContent = '已恢复未保存草稿'
    const discardBtn = document.createElement('button')
    discardBtn.type = 'button'
    discardBtn.className = 'dsh-tw-note-draft-discard'
    discardBtn.textContent = '丢弃'
    draftBanner.append(bannerText, discardBtn)

    const fields = document.createElement('div')
    fields.className = 'dsh-tw-note-fields'
    const titleInput = document.createElement('input')
    titleInput.className = 'dsh-tw-note-title'
    titleInput.placeholder = '标题（默认时间戳）'
    const tagEditor = buildTagEditor({ onChange: scheduleDraft })
    fields.append(titleInput, tagEditor.el)
    titleInput.addEventListener('input', scheduleDraft)

    // Mod-Enter save routes through doSave, which is assigned below (the editor
    // keymap only runs after the widget is fully wired, so this is safe).
    let doSave: (() => Promise<void>) | undefined
    const editor = buildMarkdownEditor({
      placeholder: '写点东西… Markdown 高亮，可 📎/拖入文件\nCtrl+Enter 保存',
      onSave: () => { void doSave?.() },
      onChange: scheduleDraft,
    })

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
    const recentBtn = document.createElement('button')
    recentBtn.type = 'button'
    recentBtn.className = 'dsh-tw-note-recent-btn'
    recentBtn.title = '最近修改的笔记，点击载入继续编辑'
    recentBtn.textContent = '🕘 最近'
    recentBtn.addEventListener('click', toggleRecent)
    footLeft.append(uploadBtn, recentBtn, hint)
    const footRight = document.createElement('div')
    footRight.className = 'dsh-tw-note-foot-right'
    const editBtn = document.createElement('button')
    editBtn.type = 'button'
    editBtn.className = 'dsh-tw-note-edit'
    editBtn.title = '保存并在 TiddlyWiki 原生编辑器中打开'
    editBtn.textContent = '✏️ 在 TW 中编辑'
    const saveBtn = document.createElement('button')
    saveBtn.type = 'button'
    saveBtn.className = 'dsh-tw-note-save'
    saveBtn.textContent = '保存'
    footRight.append(editBtn, saveBtn)
    foot.append(footLeft, footRight)

    // Recent dropdown — absolute, pops above the card.
    const recentWrap = document.createElement('div')
    recentWrap.className = 'dsh-tw-note-recent'
    recentWrap.hidden = true

    card.append(head, draftBanner, fields, editor.el, foot)
    root.append(card, recentWrap)
    document.body.append(root)

    const handle: BuiltUi = { root, card, editor, titleInput, tagEditor, saveBtn, editBtn, draftBanner, recentBtn, recentWrap }
    ui = handle

    const close = (): void => {
      opened = false
      root.hidden = true
      closeRecent()
    }

    const saveDone = (): void => {
      clearDraft()
      hideDraftBanner()
      editor.setValue('')
      titleInput.value = timestampTitle()
      tagEditor.setTags([])
      close()
    }

    doSave = async (): Promise<void> => {
      const text = editor.getValue().trim()
      if (text.length === 0) {
        toast('内容为空，未保存')
        return
      }
      saveBtn.disabled = true
      saveBtn.textContent = '保存中…'
      try {
        const res = await fetch(NOTE_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: titleInput.value.trim(), tags: tagEditor.getTags(), text }),
          signal: AbortSignal.timeout(10_000),
        })
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; title?: string; error?: string } | null
        if (!res.ok || payload?.ok !== true) {
          toast(`保存失败：${payload?.error ?? `HTTP ${res.status}`}`)
          return
        }
        saveDone()
        toast(`已保存「${payload.title ?? titleInput.value}」`)
      } catch (err) {
        toast(`保存失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        saveBtn.disabled = false
        saveBtn.textContent = '保存'
      }
    }

    saveBtn.addEventListener('click', () => { void doSave?.() })

    /** Save (if non-empty) and open the tiddler in TW's native editor. */
    const doEdit = async (): Promise<void> => {
      const title = titleInput.value.trim().length > 0 ? titleInput.value.trim() : timestampTitle()
      const text = editor.getValue()
      const tags = tagEditor.getTags()
      editBtn.disabled = true
      editBtn.textContent = '打开中…'
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
        clearDraft()
        hideDraftBanner()
        openEditorPopup(`${payload.twUrl}#${encodeURIComponent(payload.draftTitle)}`, payload.title ?? title)
        toast(`已在弹出窗口打开「${payload.title ?? title}」编辑器`)
      } catch (err) {
        toast(`打开失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        editBtn.disabled = false
        editBtn.textContent = '✏️ 在 TW 中编辑'
      }
    }

    editBtn.addEventListener('click', () => { void doEdit() })
    closeBtn.addEventListener('click', close)

    // Clicking outside the card collapses it (but keeps the draft).
    document.addEventListener('click', (event) => {
      if (!opened) return
      const target = event.target as Node
      if (root.contains(target)) return
      if (recentWrap.contains(target)) return
      close()
    }, true)

    // Discard draft (banner button).
    discardBtn.addEventListener('click', () => {
      clearDraft()
      hideDraftBanner()
      editor.setValue('')
      titleInput.value = timestampTitle()
      tagEditor.setTags([])
      toast('已丢弃草稿')
    })
  }

  // ── public handle ────────────────────────────────────────────────────────
  return {
    async open() {
      if (disposed) return
      build()
      if (ui === undefined || opened) return
      opened = true
      ui.root.hidden = false
      const draft = loadDraft()
      if (draft !== null && (draft.text.trim().length > 0 || draft.title.trim().length > 0)) {
        // Restore the autosaved draft (survives reload / accidental close).
        ui.editor.setValue(draft.text)
        ui.titleInput.value = draft.title
        ui.tagEditor.setTags(draft.tags)
        ui.draftBanner.hidden = false
      } else {
        resetTitle()
        defaultTag = (await fetchUiOptions()).defaultTag
        ui.tagEditor.setDefault(defaultTag)
      }
      ui.editor.focus()
    },
    close() {
      if (ui === undefined) return
      opened = false
      ui.root.hidden = true
      closeRecent()
    },
    async toggle() {
      if (opened) this.close()
      else await this.open()
    },
    isOpen() {
      return opened
    },
    dispose() {
      disposed = true
      if (draftTimer !== undefined) { clearTimeout(draftTimer); draftTimer = undefined }
      ui?.editor.view.destroy()
      ui?.root.remove()
      const toastEl = document.querySelector<HTMLElement>('.dsh-tw-toast')
      toastEl?.remove()
      ui = undefined
    },
  }
}

/** Legacy compatibility export: the FAB owns the trigger in v0.5. */
export function mountNoteWidget(): () => void {
  const handle = createNoteWidget()
  return () => handle.dispose()
}

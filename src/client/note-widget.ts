/**
 * Floating quick-note card (design doc §12, D6/D7) — a fixed, collapsible card
 * for jotting drafts / scratch notes while waiting for the AI or drafting the
 * next prompt. In v0.5 the trigger moved into the "知识库" FAB
 * (knowledge-fab.ts); this module ONLY owns the card itself via
 * `createNoteWidget()` (lazy build — no DOM until first open).
 *
 * Positioning (v0.16.6): with an anchor (the input-dock quick-note button) the
 * card pops up right ABOVE it (horizontally centered, viewport-clamped);
 * without one it sits in the default bottom-right corner. The card is freely
 * draggable by its title bar (pointer events + setPointerCapture).
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
 * v0.28.8 split: this file is the card's ASSEMBLY POINT — the state machine and
 * the whole DOM build. Its sub-parts live next door and are re-exported at the
 * bottom so the public surface (index.ts, quick-note-dock.ts) is unchanged:
 *   - note-widget-draft.ts  draft persistence + pure helpers
 *   - note-widget-tags.ts   the multi-tag chip editor
 *   - note-widget-upload.ts attachment upload (and MAX_UPLOAD_BYTES)
 *
 * @module dsh-tiddlywiki/client/note-widget
 */
import { toast } from './toast.ts'
import { openEditorPopup, isEditorPopupOpen, isEditorPopupBlank } from './editor-popup.ts'
import { buildMarkdownEditor, type MarkdownEditor } from './markdown-editor.ts'
import { EDIT_ENDPOINT, GET_ENDPOINT, NOTE_ENDPOINT, RECENT_ENDPOINT, resolveTwUrl, twProxyFor, withWikiQuery } from './endpoints.ts'
import { fetchStatus } from './status-cache.ts'
import { resolveFocusWiki, subscribeFocusWiki } from './wiki-focus.ts'
import { buildTagEditor } from './note-widget-tags.ts'
import { uploadInto } from './note-widget-upload.ts'
import { DRAFT_DEBOUNCE_MS, adoptDraft, clearDraft, draftSignature, fetchDefaultTag, loadDraft, persistDraft, relativeTime, timestampTitle } from './note-widget-draft.ts'

/**
 * Broadcast by the card on open/close (detail: { open }). The input-dock quick-
 * note button (quick-note-dock.ts) listens to highlight while the card is open.
 */
export const NOTE_STATE_EVENT = 'dsh-tw-note-state'

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
  /** 草稿横幅文案（恢复「其它窗口草稿」时改写为带来源的提示）。 */
  bannerText: HTMLSpanElement
  recentWrap: HTMLDivElement
}

interface RecentItem { title: string; tags: string[]; modified: string | null; snippet: string }

/** The quick-note card handle the FAB drives. */
export interface NoteWidgetHandle {
  /**
   * Open the card. Pass an optional anchor element (e.g. the input-dock quick-
   * note button) to pop the card up right above it; without an anchor the card
   * falls back to its default bottom-right position.
   */
  open(anchor?: HTMLElement): Promise<void>
  /**
   * 直达 TW 原生编辑器（quickNoteMode=native 时点击「快速笔记」走这里）：
   * 把待存草稿（若有）或「时间戳标题 + 默认 tag 的空草稿」POST 到 /edit，
   * 成功后弹出 TW 原生编辑页。不依赖 Markdown 卡片。
   */
  openNative(): Promise<void>
  close(): void
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
  /** native 路径（openNative）的在途互斥标志：防连点重复 POST /edit。 */
  let nativeOpening = false
  /** build() 时注册的 pagehide 落盘回调（dispose 需回收）。 */
  let onPageHide: (() => void) | undefined
  let defaultTag = 'inbox'
  /**
   * WHICH knowledge base this card works on (v0.28.0, 需求 R7).
   *
   * Default = the GUI's focused wiki (你在看哪个库，快速笔记就进哪个库), and the card's
   * own selector overrides it for as long as the card is open. `undefined` = the
   * default wiki, i.e. exactly what every call used to do — single-wiki installs
   * never see a change (and never see the selector).
   *
   * EVERY call of the card must be scoped together: 标签建议 / 最近 / 草稿读取 /
   * 附件上传 / 保存 / 以及随后弹出的编辑器。只改保存那一处就会出现"标签列表来自 A、
   * 笔记写进 B"，比不做还糟。
   */
  let targetWiki: string | undefined
  /** True once the user picked a wiki in THIS card (stop following the focus). */
  let targetPicked = false
  /** The roster's mode, for the per-wiki proxy base of the editor popup. */
  let rosterMode = 'single'
  /** The knowledge-base roster (empty in single mode / before /status lands). */
  let roster: Array<{ id: string; label: string; running: boolean }> = []
  /** The registry default (its display name carries the 「（默认）」 mark). */
  let defaultWikiId: string | undefined
  /** 焦点库订阅（dispose 需回收）。 */
  let focusOff: (() => void) | undefined
  const wikiQuery = (url: string): string => withWikiQuery(url, targetWiki)
  /**
   * DOM half of `ensureTarget()`: repaint the 「写入」 selector from `roster`.
   *
   * A no-op until the Markdown card has been built — which is exactly why the
   * roster resolution can live OUTSIDE `build()` (v0.29.0). The native path
   * never builds the card, so it gets no selector but must still get the wiki.
   */
  let syncTargetDom: () => void = () => {}
  /**
   * Resolve WHICH knowledge base this card works on, ONCE, for BOTH entry paths.
   *
   * v0.29.0. This lookup used to live inside `build()`, so only the Markdown card
   * (`open()`) ever learned the roster. The DEFAULT click path is `openNative()`
   * (直达 TW 原生编辑器), which never builds the card — `targetWiki` therefore
   * stayed undefined and `rosterMode` stayed `'single'`, and every quick note was
   * written into the **default** wiki and opened in the default wiki's editor
   * while the user was reading another one. The 「写入」 selector that was
   * supposed to make that impossible never appeared either, because it is part of
   * the card. Silent, and only reachable in a multi-wiki install.
   */
  let targetPromise: Promise<void> | undefined
  const ensureTarget = (): Promise<void> => {
    targetPromise ??= fetchStatus().then((payload) => {
      if (disposed) return
      rosterMode = typeof payload?.mode === 'string' ? payload.mode : 'single'
      roster = (Array.isArray(payload?.wikis) ? payload.wikis : []).map((item) => ({ id: item.id, label: item.label, running: item.running }))
      // 单库：`targetWiki` 保持 undefined = 逐字与升级前相同的行为。
      if (roster.length <= 1) return
      defaultWikiId = typeof payload?.defaultId === 'string' ? payload.defaultId : undefined
      const followFocus = (): void => {
        if (!targetPicked) targetWiki = resolveFocusWiki(roster, defaultWikiId)
      }
      followFocus()
      // 未在本卡片里手动选过时，跟随 GUI 的焦点库（你在看哪个库，笔记就进哪个库）。
      focusOff ??= subscribeFocusWiki(() => {
        followFocus()
        syncTargetDom()
      })
      syncTargetDom()
    })
    return targetPromise
  }
  /**
   * The resolved target, when it is known AND not running.
   *
   * `/note` / `/edit` refuse a stopped wiki instead of writing into the default
   * one (v0.29.0), so the honest answer is to say so BEFORE the user writes a
   * paragraph — the card has `wikiHint` for that, the native path has only us.
   */
  const stoppedTarget = (): { id: string; label: string } | undefined => {
    if (targetWiki === undefined) return undefined
    const item = roster.find((entry) => entry.id === targetWiki)
    return item !== undefined && !item.running ? item : undefined
  }
  let draftTimer: number | undefined
  let recentOpen = false
  /**
   * Optimistic-concurrency token of the note currently loaded into the card
   * (v0.19.1): set by the 「🕘 最近」picker, echoed on save so a human edit made
   * in the embedded TW editor in the meantime is not silently overwritten.
   * Cleared once the note is saved (the fresh value is re-read on next load).
   */
  let loadedToken: { title: string; modified?: string; revision?: number } | null = null
  /**
   * Signature of content that was already persisted to the wiki by the last
   * successful save /「在 TW 中编辑」(v0.19.1). `flushDraft` skips re-persisting
   * the IDENTICAL content, so a no-op change event after saving no longer
   * resurrects an "unsaved draft" banner on the next open.
   */
  let persistedSignature: string | null = null

  /**
   * Broadcast the card's open/close state to the rest of the page (the input-
   * dock quick-note button highlights while the card is open). Plain DOM
   * CustomEvent — no shared service needed.
   */
  const emitState = (open: boolean): void => {
    try {
      window.dispatchEvent(new CustomEvent(NOTE_STATE_EVENT, { detail: { open } }))
    } catch { /* event dispatch is best-effort */ }
  }

  /**
   * Place the card: with an anchor (the input-dock button) it pops up right
   * ABOVE the anchor, horizontally centered on it and clamped inside the
   * viewport; without one it returns to the default bottom-right corner.
   * The card is `position: fixed`, so switching between left/top and
   * right/bottom positioning is a matter of which inline offsets are set.
   */
  const positionCard = (anchor?: HTMLElement): void => {
    if (ui === undefined) return
    const root = ui.root
    const card = ui.card
    if (anchor !== undefined) {
      const rect = anchor.getBoundingClientRect()
      const cardW = card.offsetWidth || 340
      const cardH = card.offsetHeight || 260
      const vw = window.innerWidth
      const vh = window.innerHeight
      const gap = 10
      const left = Math.min(Math.max(rect.left + rect.width / 2 - cardW / 2, 8), Math.max(8, vw - cardW - 8))
      const bottomRaw = vh - rect.top + gap
      const bottom = Math.min(Math.max(8, bottomRaw), Math.max(8, vh - cardH - 8))
      root.style.right = 'auto'
      root.style.top = 'auto'
      root.style.left = `${left}px`
      root.style.bottom = `${bottom}px`
    } else {
      root.style.right = '24px'
      root.style.bottom = '88px'
      root.style.left = 'auto'
      root.style.top = 'auto'
    }
  }

  /**
   * The auto-generated title currently in the title input, or null once the
   * user changed it. Used by `flushDraft` to recognise "opened the card, typed
   * nothing, closed it": that state must not be persisted as an unsaved draft
   * (v0.22.8 — `dispose()`/pagehide call `flushDraft()` unconditionally, and a
   * blank body with only an auto timestamp passed the old `text && title` guard,
   * so the next open announced「已恢复未保存草稿」over an empty editor).
   */
  let autoTitle: string | null = null

  const resetTitle = (): void => {
    if (ui !== undefined) {
      autoTitle = timestampTitle()
      ui.titleInput.value = autoTitle
    }
  }

  /**
   * 同步落盘一次当前草稿（防抖定时器的回调体，也是 dispose 时的收尾动作）。
   * 内容为空 = 把本窗口的草稿清掉（同旧行为）。
   */
  const flushDraft = (): void => {
    if (ui === undefined) return
    const text = ui.editor.getValue()
    const title = ui.titleInput.value.trim()
    // 正文与标题皆空，或「只有自动生成的标题、正文一个字都没写」：没有可恢复的
    // 内容，清掉草稿即可（否则会写出一份空草稿，下次打开误报「已恢复未保存草稿」）。
    if (text.trim().length === 0 && (title.length === 0 || title === autoTitle)) {
      clearDraft()
      return
    }
    // 刚写入 wiki / 刚在 TW 原生编辑器里打开过的同一份内容不再写成"未保存草稿"
    // （v0.19.1）：保存成功后清草稿，但编辑器内容还在，随后任何一个 change 事件
    // （哪怕内容没变）都会把整篇重新持久化成草稿，下次打开弹「已恢复未保存草稿」，
    // 用户会以为保存失败。
    // v0.20.0: use the PURE read. `getTags()` commits the pending input as a
    // side effect, and this debounce fires on ANY editor/title change — so a
    // half-typed tag ("meet", no Enter) used to be promoted to a chip and the
    // input cleared 500ms later.
    const signature = draftSignature(title, text, ui.tagEditor.peekTags())
    if (persistedSignature !== null && signature === persistedSignature) return
    persistDraft({ text, title, tags: ui.tagEditor.peekTags(), savedAt: Date.now() })
  }

  /** Debounced draft auto-save (500ms after the last change). */
  const scheduleDraft = (): void => {
    if (disposed || !opened || ui === undefined) return
    if (draftTimer !== undefined) { clearTimeout(draftTimer); draftTimer = undefined }
    draftTimer = window.setTimeout(() => {
      draftTimer = undefined
      flushDraft()
    }, DRAFT_DEBOUNCE_MS)
  }

  const hideDraftBanner = (): void => {
    if (ui !== undefined) ui.draftBanner.hidden = true
  }

  /**
   * POST /edit and open the native TW editor popup. Shared by the card's
   * 「✏️ 在 TW 中编辑」(doEdit) and the direct native mode (openNative).
   * Clears the pending draft on success. Returns true when the editor opened.
   */
  const postEditAndOpen = async (title: string, text: string, tags: string[]): Promise<boolean> => {
    try {
      const res = await fetch(wikiQuery(EDIT_ENDPOINT), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, tags, text }),
        signal: AbortSignal.timeout(10_000),
      })
      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; title?: string; draftTitle?: string; twUrl?: string; twUrlAbsolute?: string; error?: string }
        | null
      if (!res.ok || payload?.ok !== true) {
        toast(`打开失败：${payload?.error ?? `HTTP ${res.status}`}`)
        return false
      }
      if (typeof payload.twUrl !== 'string' || typeof payload.draftTitle !== 'string') {
        toast('打开失败：服务未返回编辑器地址')
        return false
      }
      clearDraft()
      hideDraftBanner()
      // The content just went to the wiki; remember it so no later no-op change
      // event re-persists it as an "unsaved draft" (v0.19.1), and drop the
      // concurrency token (the note was just rewritten).
      persistedSignature = draftSignature(title, text, tags)
      loadedToken = null
      // twUrl is the same-origin proxy path (e.g. /dsh-tiddlywiki/tw/);
      // resolveTwUrl turns it into an absolute URL against this page's origin
      // so the popup works from any host/domain DSH is reached on (loopback,
      // LAN, Tailscale, HTTPS) — and, on the DSH desktop app (`dsh-app:`), to
      // the host's loopback HTTP base, without which TW's sync adaptor refuses
      // to load and the native editor would come up read-only.
      // 弹窗编辑器必须落在**同一个**库上（v0.28.0）：写入的是 A、编辑器打开 B（空的）
      // 是这张卡片最容易出现的"看起来成功了"的失败。
      const bases = twProxyFor(rosterMode, targetWiki, payload.twUrl, payload.twUrlAbsolute)
      const popupUrl = `${resolveTwUrl(bases.relative, bases.absolute)}#${encodeURIComponent(payload.draftTitle)}`
      openEditorPopup(popupUrl, payload.title ?? title)
      toast(`已在弹出窗口打开「${payload.title ?? title}」编辑器`)
      return true
    } catch (err) {
      toast(`打开失败：${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  const closeRecent = (): void => {
    recentOpen = false
    if (ui !== undefined) ui.recentWrap.hidden = true
  }

  /** Load a tiddler into the editor (recent picker click). */
  const loadNote = async (title: string): Promise<void> => {
    try {
      const res = await fetch(wikiQuery(`${GET_ENDPOINT}?title=${encodeURIComponent(title)}`), { signal: AbortSignal.timeout(10_000) })
      const payload = (await res.json().catch(() => null)) as { ok?: boolean; title?: string; text?: string; tags?: string[]; notFound?: boolean; error?: string; modified?: string | null; revision?: number | null } | null
      if (!res.ok || payload?.ok !== true || typeof payload.title !== 'string') {
        const reason = payload?.notFound === true ? '不存在' : (payload?.error ?? `HTTP ${res.status}`)
        toast(`读取失败：${reason}`)
        return
      }
      if (ui === undefined) return
      ui.editor.setValue(payload.text ?? '')
      ui.titleInput.value = payload.title
      ui.tagEditor.setTags(payload.tags ?? [])
      // Remember the concurrency token of this note so a later save refuses to
      // overwrite a concurrent human edit (v0.19.1). A freshly loaded note is by
      // definition not "already persisted" by this card.
      loadedToken = {
        title: payload.title,
        ...(typeof payload.modified === 'string' && payload.modified.length > 0 ? { modified: payload.modified } : {}),
        ...(typeof payload.revision === 'number' ? { revision: payload.revision } : {}),
      }
      persistedSignature = draftSignature(payload.title, payload.text ?? '', payload.tags ?? [])
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
        const res = await fetch(wikiQuery(`${RECENT_ENDPOINT}?limit=15`), { signal: AbortSignal.timeout(10_000) })
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; items?: unknown[]; error?: string } | null
        if (!recentOpen || ui === undefined) return
        ui.recentWrap.replaceChildren()
        // 服务端字段可能缺失（旧 host / 异常项）：逐项归一化，绝不因为
        // item.tags 未定义就抛 TypeError 被兜底成「加载失败」（同 tool-views 写法）。
        const items: RecentItem[] = []
        if (payload?.ok === true) {
          for (const raw of payload.items ?? []) {
            if (raw === null || typeof raw !== 'object') continue
            const rec = raw as Record<string, unknown>
            const itemTitle = typeof rec.title === 'string' ? rec.title : ''
            if (itemTitle.length === 0) continue
            items.push({
              title: itemTitle,
              tags: Array.isArray(rec.tags) ? rec.tags.filter((t): t is string => typeof t === 'string') : [],
              modified: typeof rec.modified === 'string' ? rec.modified : null,
              snippet: typeof rec.snippet === 'string' ? rec.snippet : '',
            })
          }
        }
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
          // 键盘可达：div + click 对键盘用户不可用，补 role/tabIndex/Enter·Space。
          row.setAttribute('role', 'button')
          row.tabIndex = 0
          row.setAttribute('aria-label', `载入笔记「${item.title}」`)
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
          row.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              void loadNote(item.title)
            }
          })
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
    titleInput.setAttribute('aria-label', '笔记标题（默认时间戳）')
    // 标签建议必须来自**同一张卡片写入的那个库**（v0.29.0）：helper 一直支持
    // `wikiQuery`，但这里漏传了，于是多库下建议列表来自默认库——点一个建议就把
    // 一个只存在于别处的标签写进目标库。上传那两处一直是传的（见下）。
    const tagEditor = buildTagEditor({ onChange: scheduleDraft, wikiQuery })
    fields.append(titleInput, tagEditor.el)

    // ── 目标知识库（v0.28.0，R7）────────────────────────────────────────────
    // 只在"多于一个库"时出现（单库安装连这个元素都隐藏）。默认跟随 GUI 焦点库，
    // 在这里改只影响这张卡片（`targetPicked` 之后不再跟焦点跑）。
    const wikiField = document.createElement('label')
    wikiField.className = 'dsh-tw-note-wiki'
    wikiField.hidden = true
    const wikiLabel = document.createElement('span')
    wikiLabel.className = 'dsh-tw-note-wiki-label'
    wikiLabel.textContent = '写入'
    const wikiSelect = document.createElement('select')
    wikiSelect.className = 'dsh-tw-note-wiki-select'
    wikiSelect.setAttribute('aria-label', '这条笔记写进哪个知识库')
    wikiField.append(wikiLabel, wikiSelect)
    const wikiHint = document.createElement('span')
    wikiHint.className = 'dsh-tw-note-wiki-hint'
    wikiHint.hidden = true
    fields.append(wikiField, wikiHint)
    /**
     * Flag a target that is not running: `/note` cannot serve it (`deps.client`
     * is undefined), and the honest answer is to say so BEFORE the user writes a
     * paragraph and loses it. We deliberately do NOT auto-start here — the
     * 「知识库」 menu is the place that starts a wiki, and a save route spawning
     * processes is not something a card should trigger by accident.
     */
    const markStopped = (): void => {
      const wiki = roster.find((item) => item.id === targetWiki)
      const stopped = wiki !== undefined && !wiki.running
      wikiHint.hidden = !stopped
      wikiHint.textContent = stopped ? `${wiki.label} 当前没在运行：先在右下角「知识库」菜单里打开它` : ''
    }
    wikiSelect.addEventListener('change', () => {
      targetPicked = true
      targetWiki = wikiSelect.value.length > 0 ? wikiSelect.value : undefined
      markStopped()
    })

    /**
     * Paint the selector (+ the "not running" hint) from the resolved roster.
     * `ensureTarget()` may have resolved BEFORE this card existed (the native path
     * resolves it too), in which case it already called the no-op stub — so build()
     * calls it once more here to catch up.
     */
    syncTargetDom = (): void => {
      // 单库：连选择器都不该存在。这里**还有一个**兜底 —— 除 `hidden` 外把 select 禁用、
      // 标签也藏掉，因为"能看见一个没有选项的下拉"比"什么都不显示"糟得多（v0.28.1 修）。
      if (roster.length <= 1) {
        wikiField.hidden = true
        wikiField.style.display = 'none'
        wikiSelect.disabled = true
        return
      }
      wikiField.style.display = ''
      wikiSelect.disabled = false
      // 「默认库」不再作为选项出现（作者 2026-09-29 报障）：那个位置就是**被设为默认的那个
      // 库本身**，用它自己的显示名，只加「（默认）」作为身份标记。原来那个 `value=''` 的
      // 占位项其实是多余的 —— 清单里本来就有这个库，选中它写进去的就是它。
      wikiSelect.replaceChildren(
        ...roster.map((item) => {
          const option = document.createElement('option')
          option.value = item.id
          const mark = item.id === defaultWikiId ? '（默认）' : ''
          option.textContent = item.running ? `${item.label}${mark}` : `${item.label}${mark}（未运行）`
          return option
        }),
      )
      wikiSelect.value = targetWiki ?? ''
      wikiField.hidden = false
      markStopped()
    }
    void ensureTarget().then(() => syncTargetDom())
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
      for (const file of Array.from(fileInput.files ?? [])) void uploadInto(file, editor, wikiQuery)
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
      for (const file of Array.from(files)) void uploadInto(file, editor, wikiQuery)
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

    const handle: BuiltUi = { root, card, editor, titleInput, tagEditor, saveBtn, editBtn, draftBanner, bannerText, recentWrap }
    ui = handle

    const close = (): void => {
      opened = false
      root.hidden = true
      closeRecent()
      emitState(false)
    }

    /**
     * Reset the editor to a blank new note and make that reset STICK.
     *
     * `editor.setValue('')` fires CodeMirror's change listener → `scheduleDraft()`
     * while `opened` is still true, so a 500ms debounce lands in `flushDraft`
     * after save/discard. There the empty-body guard does not fire (the title is
     * a fresh non-empty timestamp) and the signature guard misses too (the title
     * changed), so a PHANTOM draft `{text:'', title:'<timestamp>', tags:[]}` was
     * persisted. The next open then showed「已恢复未保存草稿」over an empty
     * editor and skipped the default-tag branch — and 「已丢弃草稿」 came back
     * on the next open (v0.22.8).
     *
     * Cancelling the pending timer and recording the cleared state as already
     * "persisted" makes the debounce a no-op whichever way it is re-armed.
     */
    const resetForNewNote = (): void => {
      if (draftTimer !== undefined) { clearTimeout(draftTimer); draftTimer = undefined }
      editor.setValue('')
      titleInput.value = timestampTitle()
      autoTitle = titleInput.value
      tagEditor.setTags([])
      persistedSignature = draftSignature(titleInput.value.trim(), '', [])
    }

    const saveDone = (): void => {
      clearDraft()
      hideDraftBanner()
      // 这份内容已经进 wiki 了：同内容不再回写成草稿（v0.19.1），token 也失效。
      persistedSignature = draftSignature(titleInput.value.trim(), editor.getValue(), tagEditor.getTags())
      loadedToken = null
      resetForNewNote()
      close()
    }

    // In-flight guard: the save button is disabled while saving, but Ctrl+Enter
    // from the editor keymap is not — a second POST within the same second
    // would carry the same timestamp title and silently overwrite the first.
    let saving = false
    doSave = async (): Promise<void> => {
      if (saving) return
      const text = editor.getValue().trim()
      if (text.length === 0) {
        toast('内容为空，未保存')
        return
      }
      // 「写入」选中的那个库没在跑：host 现在会拒绝（而不是写进默认库），
      // 所以先说清楚，别让用户写完一整段才发现（v0.29.0）。
      const stopped = stoppedTarget()
      if (stopped !== undefined) {
        toast(`「${stopped.label}」当前没在运行：先在右下角「知识库」菜单里打开它，或改「写入」目标`)
        return
      }
      saving = true
      saveBtn.disabled = true
      saveBtn.textContent = '保存中…'
      try {
        const title = titleInput.value.trim()
        const body: Record<string, unknown> = { title, tags: tagEditor.getTags(), text }
        // Echo the token of the note loaded from 「🕘 最近」 (v0.19.1): if a human
        // edited it in the embedded TW editor meanwhile, the host answers 409 and
        // we refuse instead of silently overwriting their change.
        if (loadedToken !== null && loadedToken.title === title) {
          if (loadedToken.modified !== undefined) body.expectedModified = loadedToken.modified
          if (loadedToken.revision !== undefined) body.expectedRevision = loadedToken.revision
        }
        const res = await fetch(wikiQuery(NOTE_ENDPOINT), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        })
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; title?: string; error?: string; conflict?: boolean } | null
        if (!res.ok || payload?.ok !== true) {
          if (res.status === 409 || payload?.conflict === true) {
            toast('保存被拒绝：这篇笔记在你读取之后被改动过。请用「🕘 最近」重新载入后再保存。')
            return
          }
          toast(`保存失败：${payload?.error ?? `HTTP ${res.status}`}`)
          return
        }
        saveDone()
        toast(`已保存「${payload.title ?? titleInput.value}」`)
      } catch (err) {
        toast(`保存失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        saving = false
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
        await postEditAndOpen(title, text, tags)
      } finally {
        editBtn.disabled = false
        editBtn.textContent = '✏️ 在 TW 中编辑'
      }
    }

    editBtn.addEventListener('click', () => { void doEdit() })
    closeBtn.addEventListener('click', close)

    // ── 自由拖动（按住标题栏拖动整张卡片；✕ 仍是唯一关闭方式）──────────
    // Pointer events + setPointerCapture: the head keeps receiving moves even
    // when the pointer leaves it. Dragging switches the card from the default
    // right/bottom anchoring to explicit left/top, clamped to the viewport.
    let dragState: { startX: number; startY: number; origLeft: number; origTop: number; moved: boolean } | null = null
    const applyDrag = (left: number, top: number): void => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      const cardW = card.offsetWidth || 340
      const cardH = card.offsetHeight || 260
      const x = Math.min(Math.max(left, 8), Math.max(8, vw - cardW - 8))
      const y = Math.min(Math.max(top, 8), Math.max(8, vh - cardH - 8))
      root.style.right = 'auto'
      root.style.bottom = 'auto'
      root.style.left = `${x}px`
      root.style.top = `${y}px`
    }
    head.addEventListener('pointerdown', (event) => {
      if (closeBtn.contains(event.target as Node)) return
      event.preventDefault()
      const rect = root.getBoundingClientRect()
      dragState = { startX: event.clientX, startY: event.clientY, origLeft: rect.left, origTop: rect.top, moved: false }
      try { head.setPointerCapture(event.pointerId) } catch { /* capture unavailable */ }
      head.classList.add('dsh-tw-note-head-dragging')
    })
    head.addEventListener('pointermove', (event) => {
      if (dragState === null) return
      const dx = event.clientX - dragState.startX
      const dy = event.clientY - dragState.startY
      if (!dragState.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return
      dragState.moved = true
      applyDrag(dragState.origLeft + dx, dragState.origTop + dy)
    })
    const endDrag = (event: PointerEvent): void => {
      if (dragState === null) return
      try { head.releasePointerCapture(event.pointerId) } catch { /* already released */ }
      dragState = null
      head.classList.remove('dsh-tw-note-head-dragging')
    }
    head.addEventListener('pointerup', endDrag)
    head.addEventListener('pointercancel', endDrag)

    // 快速笔记弹窗只允许「手动点关闭按钮（✕）」关闭：刻意移除「点击卡片外部
    // 即收起」的监听（用户反馈会误关、丢失正在编辑的内容）。草稿仍会防抖
    // 自动保存，重开时原样恢复。

    // Discard draft (banner button).
    discardBtn.addEventListener('click', () => {
      clearDraft()
      hideDraftBanner()
      // 与保存后同样的「重置即定型」：否则 500ms 后防抖会把这份空内容又写成草稿，
      // 下次打开又弹「已恢复未保存草稿」（v0.22.8）。
      resetForNewNote()
      toast('已丢弃草稿')
    })

    // 刷新 / 关闭标签页（pagehide）也同步落盘一次：dispose() 只在插件卸载路径
    // 被调用，浏览器刷新不保证走到那里，但 500ms 防抖窗口内的输入同样不能丢。
    onPageHide = (): void => { flushDraft() }
    window.addEventListener('pagehide', onPageHide)
  }

  // ── public handle ────────────────────────────────────────────────────────
  return {
    async open(anchor?: HTMLElement) {
      if (disposed) return
      build()
      if (ui === undefined || opened) return
      opened = true
      ui.root.hidden = false
      // With an anchor (input-dock button) the card pops up right above it;
      // without one it sits in the default bottom-right corner.
      positionCard(anchor)
      emitState(true)
      const hit = loadDraft()
      const draft = hit?.draft ?? null
      if (draft !== null && (draft.text.trim().length > 0 || draft.title.trim().length > 0)) {
        // Restore the autosaved draft (survives reload / accidental close).
        ui.editor.setValue(draft.text)
        ui.titleInput.value = draft.title
        ui.tagEditor.setTags(draft.tags)
        ui.bannerText.textContent = hit?.foreign === true ? '已恢复未保存草稿（来自其它窗口）' : '已恢复未保存草稿'
        ui.draftBanner.hidden = false
        if (hit?.foreign === true) {
          // 不是本窗口写的草稿（旧全局 key 迁移 / 窗口 id 变化）：可见提示而不是
          // 静默覆盖，并采纳为本窗口所有，后续打开不再重复提示。
          toast('已恢复其它窗口的未保存草稿')
          adoptDraft(draft)
        }
      } else {
        resetTitle()
        defaultTag = await fetchDefaultTag()
        // dispose() may have run while awaiting (sets ui = undefined); a live
        // `ui` reference must be re-read under the same guard as above.
        if (disposed || ui === undefined) return
        ui.tagEditor.setDefault(defaultTag)
      }
      if (ui === undefined) return
      ui.editor.focus()
    },
    close() {
      if (ui === undefined) return
      opened = false
      ui.root.hidden = true
      closeRecent()
      emitState(false)
    },
    async openNative() {
      // 直达 TW 原生编辑页（quickNoteMode=native 时点击「快速笔记」走这里）：
      // 有未保存草稿就继续编辑它，否则新建「时间戳标题 + 默认 tag」的空草稿。
      // 互斥守卫（与 open() 的 opened 守卫等价）：dock 的点击回调要等
      // fetchUiConfig() 才分派，用户连点两次会各自走到这里 → 两个 POST /edit、
      // 两个草稿 tiddler。用「在途」标志 + 弹窗已打开判断挡住重复请求。
      // 「已打开」必须排除**空掉的**弹窗（v0.22.6）：在 TW 里删掉正在编辑的笔记
      // 之后 story 会被清空，若把它当成「编辑器已开」直接返回，用户就再也打不开
      // 编辑器了；空的弹窗按「需要重新打开」处理（openEditorPopup 会重载它）。
      if (disposed || nativeOpening) return
      if (isEditorPopupOpen() && !isEditorPopupBlank()) return
      nativeOpening = true
      try {
        // v0.29.0: 必须先解析目标库 —— 这条路径不建卡片，此前因此**永远**写进默认库。
        await ensureTarget()
        if (disposed) return
        const stopped = stoppedTarget()
        if (stopped !== undefined) {
          toast(`「${stopped.label}」当前没在运行：先在右下角「知识库」菜单里打开它，再记这条笔记`)
          return
        }
        const hit = loadDraft()
        const hasDraft = hit !== null && (hit.draft.text.trim().length > 0 || hit.draft.title.trim().length > 0)
        const title = hasDraft && hit.draft.title.trim().length > 0 ? hit.draft.title.trim() : timestampTitle()
        const text = hasDraft ? hit.draft.text : ''
        let tags: string[] = []
        if (hasDraft) {
          tags = hit.draft.tags
        } else {
          defaultTag = await fetchDefaultTag()
          if (disposed) return
          tags = [defaultTag]
        }
        if (hit !== null && hit.foreign && (hit.draft.text.trim().length > 0 || hit.draft.title.trim().length > 0)) {
          // 非本窗口的草稿：恢复进原生编辑器前给出可见提示，并采纳为本窗口所有。
          toast('已恢复其它窗口的未保存草稿')
          adoptDraft(hit.draft)
        }
        // 必须 await：否则 finally 会在 POST 在途时就放开守卫，第二次点击仍会重复提交。
        await postEditAndOpen(title, text, tags)
      } finally {
        nativeOpening = false
      }
    },
    isOpen() {
      return opened
    },
    dispose() {
      disposed = true
      focusOff?.()
      focusOff = undefined
      if (onPageHide !== undefined) {
        window.removeEventListener('pagehide', onPageHide)
        onPageHide = undefined
      }
      // 先同步落盘一次待写草稿，再清定时器：500ms 防抖窗口内点关闭/刷新（pagehide
      // 会走到这里）不丢最后输入。flushDraft 自带「内容为空则清草稿」的语义。
      if (draftTimer !== undefined) { clearTimeout(draftTimer); draftTimer = undefined }
      flushDraft()
      ui?.tagEditor.dispose()
      ui?.editor.view.destroy()
      ui?.root.remove()
      // NOTE: `.dsh-tw-toast` is deliberately NOT removed here (v0.22.3). It is a
      // page-level singleton owned by toast.ts and shared with the settings page;
      // deleting it on this widget's unmount killed a toast another surface was
      // showing (toast.ts would only re-create it on the next call).
      ui = undefined
    },
  }
}

// (The FAB owns the trigger since v0.5 — there is deliberately no standalone
// mount export here; index.ts wires createNoteWidget into mountKnowledgeFab.)

// ── public surface of the note-widget family (v0.28.8 split) ───────────────
// The sub-modules above were extracted out of THIS file; re-export their parts
// so every existing import path (`./note-widget.ts`) keeps working unchanged.
export { DRAFT_DEBOUNCE_MS, adoptDraft, clearDraft, draftSignature, fetchDefaultTag, loadDraft, persistDraft, relativeTime, timestampTitle } from './note-widget-draft.ts'
export type { Draft, DraftHit } from './note-widget-draft.ts'
export { buildTagEditor } from './note-widget-tags.ts'
export { MAX_UPLOAD_BYTES, uploadInto } from './note-widget-upload.ts'

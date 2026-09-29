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
 *   - note-widget-recent.ts the 「最近」picker (dropdown + load-into-editor,
 *                           v0.30.41: its open-state moved with it)
 *   - note-widget-scope.ts  WHICH wiki the card works on: roster + focus-follow
 *                           + "target is stopped" (v0.30.41). The DOM half of the
 *                           「写入」 selector stays here and is registered through
 *                           `scope.setSyncDom()`.
 *   - note-widget-placement.ts WHERE the card sits + dragging by its title bar
 *                           (v0.30.43: pure DOM, zero card state — see its header)
 *   - note-widget-autosave.ts the draft lifecycle: debounce → persist / clear,
 *                           plus「重置即定型」(v0.30.44). It OWNS `draftTimer` /
 *                           `persistedSignature`; the card only reads/writes them
 *                           through the handle it returns.
 *   - note-widget-save.ts   the two write-out paths: 「保存」(POST /note) and
 *                           「✏️ 在 TW 中编辑」/ Ctrl+Enter (POST /edit). It OWNS the
 *                           in-flight `saving` flag (v0.30.45); `postEditAndOpen`
 *                           stays in the card because openNative() shares it.
 *   - note-widget-upload-ui.ts the upload WIRING (v0.30.46): 「上传」 button +
 *                           hidden input + drop-onto-the-editor. Its own
 *                           `dragDepth` travels with it; it asks the card for
 *                           exactly two things — the editor and `wikiQuery`.
 *   - note-widget-foot.ts   the bottom action bar (v0.30.47): left group
 *                           (upload / 「最近」 / Ctrl+Enter hint) + right group
 *                           (「编辑」 / 「保存」). Layout only — zero card state.
 *
 * @module dsh-tiddlywiki/client/note-widget
 */
import { t } from './i18n.ts'
import { toast } from './toast.ts'
import { openEditorPopup, isEditorPopupOpen, isEditorPopupBlank } from './editor-popup.ts'
import { buildMarkdownEditor, type MarkdownEditor } from './markdown-editor.ts'
import { EDIT_ENDPOINT, resolveTwUrl, twProxyFor } from './endpoints.ts'
import { buildTagEditor } from './note-widget-tags.ts'
import { createNoteUploadUi } from './note-widget-upload-ui.ts'
import { createNoteFooter } from './note-widget-foot.ts'
import { createRecentPicker } from './note-widget-recent.ts'
import { createNoteScope } from './note-widget-scope.ts'
import { installCardDrag, positionCard } from './note-widget-placement.ts'
import { createDraftAutosave } from './note-widget-autosave.ts'
import { createNoteSave } from './note-widget-save.ts'
import { adoptDraft, clearDraft, fetchDefaultTag, loadDraft, timestampTitle } from './note-widget-draft.ts'

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
   * WHICH knowledge base this card works on (v0.28.0 需求 R7 / v0.29.0).
   *
   * The state and the resolution now live in note-widget-scope.ts (v0.30.41);
   * the card keeps the DOM half of the 「写入」 selector and registers it through
   * `scope.setSyncDom()`. `wikiQuery` stays the single way to build a URL — every
   * call of the card must be scoped together (标签建议 / 最近 / 草稿 / 附件 / 保存 /
   * 弹出的编辑器), or the note lands in A while its tags came from B.
   */
  const scope = createNoteScope({ isDisposed: () => disposed })
  const wikiQuery = scope.wikiQuery
  /**
   * 草稿生命周期（防抖落盘 / 幽灵草稿守卫 /「重置即定型」）住在
   * note-widget-autosave.ts（v0.30.44）。它**持有** `draftTimer` 与
   * `persistedSignature`，因为 `verify-frame-guards` 把这两条不变量**按名字**钉在
   * `resetForNewNote` 的函数体里 —— 变量随函数一起搬走，两处字面量逐字保留、守门
   * 一条都不用改；卡片只经它返回的句柄读写。
   */
  const autosave = createDraftAutosave({
    getUi: () => ui,
    isOpened: () => opened,
    isDisposed: () => disposed,
  })
  // 别名：这几个名字在 build() / dispose() 里到处都在用，改名只放大 diff 不增加信息。
  const { flush: flushDraft, schedule: scheduleDraft, hideBanner: hideDraftBanner, resetTitle } = autosave
  /**
   * Optimistic-concurrency token of the note currently loaded into the card
   * (v0.19.1): set by the 「🕘 最近」picker, echoed on save so a human edit made
   * in the embedded TW editor in the meantime is not silently overwritten.
   * Cleared once the note is saved (the fresh value is re-read on next load).
   */
  let loadedToken: { title: string; modified?: string; revision?: number } | null = null

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
        toast(t('note.openFailed', { message: payload?.error ?? `HTTP ${res.status}` }))
        return false
      }
      if (typeof payload.twUrl !== 'string' || typeof payload.draftTitle !== 'string') {
        toast(t('note.openNoEditorUrl'))
        return false
      }
      clearDraft()
      hideDraftBanner()
      // The content just went to the wiki; remember it so no later no-op change
      // event re-persists it as an "unsaved draft" (v0.19.1), and drop the
      // concurrency token (the note was just rewritten).
      autosave.markPersisted(title, text, tags)
      loadedToken = null
      // twUrl is the same-origin proxy path (e.g. /dsh-tiddlywiki/tw/);
      // resolveTwUrl turns it into an absolute URL against this page's origin
      // so the popup works from any host/domain DSH is reached on (loopback,
      // LAN, Tailscale, HTTPS) — and, on the DSH desktop app (`dsh-app:`), to
      // the host's loopback HTTP base, without which TW's sync adaptor refuses
      // to load and the native editor would come up read-only.
      // 弹窗编辑器必须落在**同一个**库上（v0.28.0）：写入的是 A、编辑器打开 B（空的）
      // 是这张卡片最容易出现的"看起来成功了"的失败。
      const bases = twProxyFor(scope.getMode(), scope.getTargetWiki(), payload.twUrl, payload.twUrlAbsolute)
      const popupUrl = `${resolveTwUrl(bases.relative, bases.absolute)}#${encodeURIComponent(payload.draftTitle)}`
      openEditorPopup(popupUrl, payload.title ?? title)
      toast(t('note.openedInPopup', { title: payload.title ?? title }))
      return true
    } catch (err) {
      toast(t('note.openFailed', { message: err instanceof Error ? err.message : String(err) }))
      return false
    }
  }

  /**
   * The 「🕘 最近」picker (v0.30.41). Its open-state, its dropdown DOM and the
   * load-into-editor path now live in note-widget-recent.ts; the two pieces of
   * card state it feeds (`loadedToken` / `persistedSignature`) arrive as setters,
   * so nothing in this file had to be renamed or moved.
   */
  const recent = createRecentPicker({
    getUi: () => ui,
    wikiQuery,
    hideDraftBanner,
    setLoadedToken: (token) => { loadedToken = token },
    setPersistedSignature: autosave.setPersistedSignature,
  })

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
    label.textContent = t('note.cardLabel')
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'dsh-tw-note-close'
    closeBtn.title = t('note.close')
    closeBtn.textContent = '✕'
    head.append(label, closeBtn)

    // Restored-draft banner (hidden until a draft is restored).
    const draftBanner = document.createElement('div')
    draftBanner.className = 'dsh-tw-note-draft'
    draftBanner.hidden = true
    const bannerText = document.createElement('span')
    bannerText.className = 'dsh-tw-note-draft-text'
    bannerText.textContent = t('note.draftRestored')
    const discardBtn = document.createElement('button')
    discardBtn.type = 'button'
    discardBtn.className = 'dsh-tw-note-draft-discard'
    discardBtn.textContent = t('note.discard')
    draftBanner.append(bannerText, discardBtn)

    const fields = document.createElement('div')
    fields.className = 'dsh-tw-note-fields'
    const titleInput = document.createElement('input')
    titleInput.className = 'dsh-tw-note-title'
    titleInput.placeholder = t('note.titlePlaceholder')
    titleInput.setAttribute('aria-label', t('note.titleAriaLabel'))
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
    wikiLabel.textContent = t('note.writeTo')
    const wikiSelect = document.createElement('select')
    wikiSelect.className = 'dsh-tw-note-wiki-select'
    wikiSelect.setAttribute('aria-label', t('note.writeToAriaLabel'))
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
      const wiki = scope.getRoster().find((item) => item.id === scope.getTargetWiki())
      const stopped = wiki !== undefined && !wiki.running
      wikiHint.hidden = !stopped
      wikiHint.textContent = stopped ? t('note.targetStopped', { label: wiki.label }) : ''
    }
    wikiSelect.addEventListener('change', () => {
      scope.pick(wikiSelect.value.length > 0 ? wikiSelect.value : undefined)
      markStopped()
    })

    /**
     * Paint the selector (+ the "not running" hint) from the resolved roster.
     * `ensureTarget()` may have resolved BEFORE this card existed (the native path
     * resolves it too), in which case it already called the no-op stub — so build()
     * calls it once more here to catch up.
     */
    scope.setSyncDom((): void => {
      const roster = scope.getRoster()
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
          const mark = item.id === scope.getDefaultWikiId() ? t('note.defaultMark') : ''
          option.textContent = item.running ? `${item.label}${mark}` : `${item.label}${mark}${t('note.notRunningSuffix')}`
          return option
        }),
      )
      wikiSelect.value = scope.getTargetWiki() ?? ''
      wikiField.hidden = false
      markStopped()
    })
    void scope.ensureTarget().then(() => scope.syncDom())
    titleInput.addEventListener('input', scheduleDraft)

    // Mod-Enter save routes through doSave, which is assigned below (the editor
    // keymap only runs after the widget is fully wired, so this is safe).
    let doSave: (() => Promise<void>) | undefined
    const editor = buildMarkdownEditor({
      placeholder: t('note.editorPlaceholder'),
      onSave: () => { void doSave?.() },
      onChange: scheduleDraft,
    })

    // ── file upload (button + drag & drop onto the editor) ────────────────
    // 整组（按钮、隐藏的 file input、拖放接线与它自有的 `dragDepth`）住在
    // note-widget-upload-ui.ts（v0.30.46）；卡片只把它要的东西递进去：编辑器与
    // `wikiQuery`（附件必须落在**这张卡片的目标库**里）。
    const upload = createNoteUploadUi({ editor, wikiQuery })

    // 底栏（左组：上传 / 最近 / Ctrl+Enter 提示；右组：编辑 / 保存）整段住在
    // note-widget-foot.ts（v0.30.47）—— 它只建 DOM、不留任何卡片状态：接一个
    // 已经建好的上传按钮 + `recent.toggle` 的函数引用，把两个按钮交回来由卡片
    // 接线（保存那一组的实现在 note-widget-save.ts）。
    const { foot, saveBtn, editBtn } = createNoteFooter({
      uploadButton: upload.button,
      onRecent: () => { recent.toggle() },
    })

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
      recent.close()
      emitState(false)
    }

    // 重置成空白新笔记 + 「这次重置要定型」的整段语义（幽灵草稿 v0.22.8）现在住在
    // note-widget-autosave.ts 的 `resetForNewNote()` 里 —— 它与 `draftTimer` /
    // `persistedSignature` 是同一个不变量，所以一起搬走。

    // 保存 / 「在 TW 中编辑」整组（`saveDone` · `saving` · `doSave` · `doEdit`）现在住在
    // note-widget-save.ts（v0.30.45）：`build()` 里别的部分都是建 DOM 与接线，只有这一组
    // 真的"说话"（发请求 / 读回执 / 弹 toast / 改按钮状态）。`postEditAndOpen` 与
    // `loadedToken` 刻意留在卡片里 —— 前者 native 路径也调用，后者「🕘 最近」picker 要写。
    const save = createNoteSave({
      getUi: () => ui,
      autosave,
      stoppedTarget: scope.stoppedTarget,
      getLoadedToken: () => loadedToken,
      clearLoadedToken: () => { loadedToken = null },
      wikiQuery,
      postEditAndOpen,
      close,
    })
    // 编辑器键位绑的是上面那个 `doSave` 变量，实现到这里才拿得到。
    doSave = save.doSave
    saveBtn.addEventListener('click', () => { void save.doSave() })
    editBtn.addEventListener('click', () => { void save.doEdit() })
    closeBtn.addEventListener('click', close)

    // ── 自由拖动（按住标题栏拖动整张卡片；✕ 仍是唯一关闭方式）──────────
    // v0.30.43：整段搬进 note-widget-placement.ts —— 它只碰 DOM（root/card/head/
    // closeBtn）与**自己私有的**手势状态，所以一个访问器都不用传。
    installCardDrag({ root, card, head, closeBtn })

    // 快速笔记弹窗只允许「手动点关闭按钮（✕）」关闭：刻意移除「点击卡片外部
    // 即收起」的监听（用户反馈会误关、丢失正在编辑的内容）。草稿仍会防抖
    // 自动保存，重开时原样恢复。

    // Discard draft (banner button).
    discardBtn.addEventListener('click', () => {
      clearDraft()
      hideDraftBanner()
      // 与保存后同样的「重置即定型」：否则 500ms 后防抖会把这份空内容又写成草稿，
      // 下次打开又弹「已恢复未保存草稿」（v0.22.8）。
      autosave.resetForNewNote()
      toast(t('note.draftDiscarded'))
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
      positionCard(ui.root, ui.card, anchor)
      emitState(true)
      const hit = loadDraft()
      const draft = hit?.draft ?? null
      if (draft !== null && (draft.text.trim().length > 0 || draft.title.trim().length > 0)) {
        // Restore the autosaved draft (survives reload / accidental close).
        ui.editor.setValue(draft.text)
        ui.titleInput.value = draft.title
        ui.tagEditor.setTags(draft.tags)
        ui.bannerText.textContent = hit?.foreign === true ? t('note.draftRestoredForeign') : t('note.draftRestored')
        ui.draftBanner.hidden = false
        if (hit?.foreign === true) {
          // 不是本窗口写的草稿（旧全局 key 迁移 / 窗口 id 变化）：可见提示而不是
          // 静默覆盖，并采纳为本窗口所有，后续打开不再重复提示。
          toast(t('note.draftRestoredForeignToast'))
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
      recent.close()
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
        await scope.ensureTarget()
        if (disposed) return
        const stopped = scope.stoppedTarget()
        if (stopped !== undefined) {
          toast(t('note.nativeTargetStopped', { label: stopped.label }))
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
          toast(t('note.draftRestoredForeignToast'))
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
      scope.dispose()
      if (onPageHide !== undefined) {
        window.removeEventListener('pagehide', onPageHide)
        onPageHide = undefined
      }
      // 先同步落盘一次待写草稿，再清定时器：500ms 防抖窗口内点关闭/刷新（pagehide
      // 会走到这里）不丢最后输入。flushDraft 自带「内容为空则清草稿」的语义。
      autosave.clearTimer()
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

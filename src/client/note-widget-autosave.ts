/**
 * The quick-note card's **draft lifecycle** — the state machine behind
 * 「输入 → 防抖 → 落盘草稿 / 清掉它」 (v0.30.44).
 *
 * Extracted out of the 774-line `createNoteWidget()` closure following the
 * `tw-frame` recipe. This slice OWNS two pieces of the card's closure state —
 *
 *   let draftTimer: number | undefined
 *   let persistedSignature: string | null
 *
 * — and moved them **together with** the five functions that touch them
 * (`resetTitle` / `flushDraft` / `scheduleDraft` / `hideDraftBanner` /
 * `resetForNewNote`).
 *
 * 为什么状态必须跟着走（而不是像 note-widget-scope.ts 那样只传访问器）：
 * `verify-frame-guards.mjs` 把这两个不变量**按名字钉在 `resetForNewNote` 的函数体里**
 * （`/clearTimeout\(draftTimer\)/` + `/persistedSignature\s*=/`）。它们编码的是 v0.22.8
 * 的「幽灵草稿」事故：「保存 / 丢弃后重置编辑器」必须①取消防抖定时器、②把空内容记成
 * "已定型"，否则 500ms 后那次防抖会把 `{text:'', title:'<时间戳>'}` 写成草稿，下次打开
 * 对着空编辑器报「已恢复未保存草稿」。把变量与函数整片搬走 ⇒ 两处字面量**逐字保留**、
 * 守门一条都不用改；反过来「改名成 `draft.timer` 再放宽守门」会把断言从「钉不变量」
 * 降级成「钉新名字」，那才是真正的损失。
 *
 * 卡片只经这里返回的句柄读写：`setPersistedSignature`（「最近」picker 载入别处的笔记后
 * 写入它的并发签名）/ `markPersisted`（内容刚进 wiki：保存成功、或刚在 TW 原生编辑器里
 * 打开过）/ `clearTimer`（dispose 先停工、再手动 flush）/ `flush` / `schedule` /
 * `hideBanner` / `resetForNewNote` / `resetTitle`。
 *
 * 刻意**不**在这里的东西：`opened` / `disposed`。它们同样门控防抖，但属于卡片的可见性
 * 生命周期（`open()` / `dispose()`），所以按谓词传进来（与 `note-widget-recent.ts` 同款）。
 *
 * 两个诚实的差异（都不改变可观察行为）：① 旧代码直接闭包引用 `editor`/`titleInput`/
 * `tagEditor`（`build()` 之后必然存在），这里改经 `deps.getUi()`，于是多了一条
 * `ui === undefined` 早退 —— 它只在"卡片还没建 / 已 dispose"时生效，而那些调用点本来就
 * 不存在（`ui === undefined` 时旧代码会抛 TypeError）。② `autoTitle` **删除**：它自
 * v0.29.0 起只写不读（`flushDraft` 的判据已从「正文为空 **且** 标题是自动生成的那个」
 * 升级为「正文为空」，守门还专门断言 `flushDraft` 不得再引用它）。把一个只写不读的变量
 * 搬进新文件，等于把债务搬进新家。
 *
 * @module dsh-tiddlywiki/client/note-widget-autosave
 */
import { DRAFT_DEBOUNCE_MS, clearDraft, draftSignature, persistDraft, timestampTitle } from './note-widget-draft.ts'

/** 本模块对卡片 DOM 的**最小**需求（`BuiltUi` 结构上满足它）。 */
export interface AutosaveUi {
  editor: { getValue: () => string; setValue: (value: string) => void }
  titleInput: { value: string }
  /** `peekTags` 是纯读（不把半打的标签提交成 chip）；重置只需要 `setTags`。 */
  tagEditor: { peekTags: () => string[]; setTags: (tags: string[]) => void }
  draftBanner: { hidden: boolean }
}

export interface NoteAutosaveDeps {
  /** 建好的卡片；`build()` 之前与 `dispose()` 之后是 undefined。 */
  getUi: () => AutosaveUi | undefined
  /** 卡片当前是否可见（关着的卡片不写草稿）。 */
  isOpened: () => boolean
  /** 插件已卸载：防抖回调不得再落盘。 */
  isDisposed: () => boolean
}

export interface NoteAutosave {
  /** 换一个时间戳标题（打开卡片、且没有草稿可恢复时）。 */
  resetTitle: () => void
  /** 同步落盘一次当前草稿（防抖回调体，也是 dispose / pagehide 的收尾动作）。 */
  flush: () => void
  /** 防抖落盘：最后一次输入之后 `DRAFT_DEBOUNCE_MS`。 */
  schedule: () => void
  /** 收起「已恢复未保存草稿」横幅。 */
  hideBanner: () => void
  /** 保存 / 丢弃后把编辑器重置成一张空白新笔记，并让这次重置**定型**。 */
  resetForNewNote: () => void
  /** 取消防抖定时器（dispose 用：先停工，再手动 flush）。 */
  clearTimer: () => void
  /** 载入别处的笔记后写入它的乐观并发签名（null = 没有）。 */
  setPersistedSignature: (signature: string | null) => void
  /** 内容刚进 wiki（保存成功 / 刚打开 TW 原生编辑器）：记为已定型。 */
  markPersisted: (title: string, text: string, tags: string[]) => void
}

export function createDraftAutosave(deps: NoteAutosaveDeps): NoteAutosave {
  let draftTimer: number | undefined
  /**
   * Signature of content that was already persisted to the wiki by the last
   * successful save /「在 TW 中编辑」(v0.19.1). `flushDraft` skips re-persisting
   * the IDENTICAL content, so a no-op change event after saving no longer
   * resurrects an "unsaved draft" banner on the next open.
   */
  let persistedSignature: string | null = null

  const resetTitle = (): void => {
    const ui = deps.getUi()
    if (ui !== undefined) ui.titleInput.value = timestampTitle()
  }

  /**
   * 同步落盘一次当前草稿（防抖定时器的回调体，也是 dispose 时的收尾动作）。
   * 内容为空 = 把本窗口的草稿清掉（同旧行为）。
   */
  const flushDraft = (): void => {
    const ui = deps.getUi()
    if (ui === undefined) return
    const text = ui.editor.getValue()
    const title = ui.titleInput.value.trim()
    // 正文为空 = 没有值得恢复的内容，一律清掉草稿（v0.29.0）。
    //
    // 旧判据是「正文为空 **且** 标题为空或是自动生成的那个标题」。它漏掉了一条
    // 真实入口：**恢复草稿**的分支从不设置自动标题（恢复出来的是草稿里存的那个
    // 标题），于是「打开卡片 → 恢复出旧时间戳标题 → 把正文清空 → 关窗」会写出
    // 一份 {text:'', title:'<旧时间戳>'} 的草稿，下次打开又对着**空白编辑器**报
    // 「已恢复未保存草稿」—— 正是 v0.22.8 修掉的那个症状。
    // 一份只有标题、没有正文的草稿没有任何恢复价值，所以判据直接取「正文为空」。
    if (text.trim().length === 0) {
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
    if (deps.isDisposed() || !deps.isOpened() || deps.getUi() === undefined) return
    if (draftTimer !== undefined) { clearTimeout(draftTimer); draftTimer = undefined }
    draftTimer = window.setTimeout(() => {
      draftTimer = undefined
      flushDraft()
    }, DRAFT_DEBOUNCE_MS)
  }

  const hideDraftBanner = (): void => {
    const ui = deps.getUi()
    if (ui !== undefined) ui.draftBanner.hidden = true
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
    const ui = deps.getUi()
    if (ui === undefined) return
    ui.editor.setValue('')
    ui.titleInput.value = timestampTitle()
    ui.tagEditor.setTags([])
    persistedSignature = draftSignature(ui.titleInput.value.trim(), '', [])
  }

  const clearTimer = (): void => {
    if (draftTimer !== undefined) { clearTimeout(draftTimer); draftTimer = undefined }
  }

  return {
    resetTitle,
    flush: flushDraft,
    schedule: scheduleDraft,
    hideBanner: hideDraftBanner,
    resetForNewNote,
    clearTimer,
    setPersistedSignature: (signature) => { persistedSignature = signature },
    markPersisted: (title, text, tags) => { persistedSignature = draftSignature(title, text, tags) },
  }
}

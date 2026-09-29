/**
 * The quick-note card's two **write-out** paths — 「保存」（`POST /note`）与
 * 「✏️ 在 TW 中编辑」（`POST /edit`）—— extracted out of the ~385-line `build()`
 * (v0.30.45).
 *
 * 分界线（可复用的判据）：`build()` 里剩下的几乎全是**建 DOM 与接线**，只有这一组
 * 真的"说话"（发请求、读回执、弹 toast、按状态改按钮文案与禁用态）。它自带一个私有
 * 状态 `saving`（在途互斥，只有 `doSave` 碰它）—— 与 v0.30.44 的 autosave 片同款：
 * **状态跟着函数走**，而不是摊成访问器。
 *
 * 刻意**留在卡片里**的四样，各有理由：
 *   - `close()`：卡片自己的可见性收尾（`opened` / `root.hidden` / `recent.close()` /
 *     `emitState`），不属于"保存"。
 *   - `postEditAndOpen()`：**两条路径共用**（卡片的 `doEdit` 与 `openNative()`），
 *     所以它必须住在两者都看得见的地方 —— 也就是卡片。
 *   - `loadedToken`：**「🕘 最近」picker 写它、保存读它**，主人是卡片 ⇒ 按
 *     getter/setter 传（与 v0.30.41 的 `persistedSignature` 同款）。
 *   - `scope`：这里只读它**一个**方法（`stoppedTarget()`），所以传函数而不是整个模块。
 *
 * ⚠️ `const doSave = async (): Promise<void> => {` 这一行是**逐字保留**的：
 * `verify-wiki-focus.mjs` 用 `indexOf(那句签名)` 定位函数体，再断言其后 900 字符内
 * 出现 `stoppedTarget()`（＝「卡片保存同样要拒绝未运行的目标库」，v0.29.0）。它是
 * **族读**（`readFamily('src/client/note-widget')`）⇒ 搬到这个文件仍然命中；会失配的
 * 是把它改名成 `async save()` 之类 —— 那条断言钉的正是「保存前必须先问一句目标库在
 * 不在跑」这条不变量，不是排版。
 *
 * ⚠️ 那条判据在 v0.30.45 被**加固**过一次：改成跑在**剥掉注释**的源码上。起因正是
 * **这段注释** —— 它逐字引用了那句签名、又提到 `stoppedTarget()`，于是 raw 文本里的
 * `indexOf` 先命中注释，断言被自己的文档满足（反向验证实测：把函数改名、甚至删掉整个
 * 拒绝分支，守门都照样绿）。因此现在可以放心在这里引用签名：加固后的判据不会被注释骗
 * 到，而引用它让「这一行为什么不许改名」变得可读。
 *
 * 一个诚实的差异（不改变可观察行为）：旧代码在 `build()` 里直接闭包引用
 * `editor` / `titleInput` / `tagEditor` / `saveBtn` / `editBtn`，这里改经 `deps.getUi()`，
 * 于是两个函数各多了一条 `ui === undefined` 早退。它在实践中**不可达** —— 两者都由
 * `build()` 建出来的按钮与编辑器键位触发，而那一定发生在 `ui` 赋值之后 —— 写出来只是
 * 为了让类型收窄（与 `note-widget-autosave.ts` 的同一条差异一致）。
 *
 * @module dsh-tiddlywiki/client/note-widget-save
 */
import { t } from './i18n.ts'
import { toast } from './toast.ts'
import { NOTE_ENDPOINT } from './endpoints.ts'
import { clearDraft, timestampTitle } from './note-widget-draft.ts'

/** 本模块对卡片 DOM 的**最小**需求（`BuiltUi` 结构上满足它）。 */
export interface NoteSaveUi {
  editor: { getValue: () => string }
  titleInput: { value: string }
  /** 保存要**提交**半打的标签，所以用 `getTags()`（不是 `peekTags()`）。 */
  tagEditor: { getTags: () => string[] }
  saveBtn: { disabled: boolean; textContent: string | null }
  editBtn: { disabled: boolean; textContent: string | null }
}

/** 「🕘 最近」载入的那篇笔记的乐观并发令牌（v0.19.1）。 */
export interface NoteLoadedToken {
  title: string
  modified?: string
  revision?: number
}

/** 草稿状态机（note-widget-autosave.ts）里这一组用到的三件事。 */
export interface NoteSaveAutosave {
  /** 收起「已恢复未保存草稿」横幅。 */
  hideBanner: () => void
  /**
   * 内容刚进 wiki：记为"已定型"。少了它，保存后任何一个 change 事件（哪怕内容没变）
   * 都会把整篇重新写成"未保存草稿"，下次打开对着空白编辑器报「已恢复未保存草稿」。
   */
  markPersisted: (title: string, text: string, tags: string[]) => void
  /** 保存后把编辑器重置成一张空白新笔记，并让这次重置**定型**（幽灵草稿 v0.22.8）。 */
  resetForNewNote: () => void
}

export interface NoteSaveDeps {
  /** 建好的卡片；`build()` 之前与 `dispose()` 之后是 undefined。 */
  getUi: () => NoteSaveUi | undefined
  autosave: NoteSaveAutosave
  /** 「写入」选中的库没在跑 ⇒ 返回它（host 也会 503）：先拒绝，再说话。 */
  stoppedTarget: () => { label: string } | undefined
  getLoadedToken: () => NoteLoadedToken | null
  clearLoadedToken: () => void
  /** 每条请求都要带上「写进哪个库」（漏了这条就会去默认库）。 */
  wikiQuery: (endpoint: string) => string
  /** 卡片自己的 `POST /edit` + 弹出 TW 原生编辑器（与 native 路径共用）。 */
  postEditAndOpen: (title: string, text: string, tags: string[]) => Promise<boolean>
  /** 保存成功后的收尾：卡片自己的 `close()`。 */
  close: () => void
}

export interface NoteSave {
  /** Ctrl+Enter / 「保存」按钮。 */
  doSave: () => Promise<void>
  /** 「✏️ 在 TW 中编辑」：把当前内容存进 wiki，再打开 TW 原生编辑器。 */
  doEdit: () => Promise<void>
}

export function createNoteSave(deps: NoteSaveDeps): NoteSave {
  // In-flight guard: the save button is disabled while saving, but Ctrl+Enter
  // from the editor keymap is not — a second POST within the same second
  // would carry the same timestamp title and silently overwrite the first.
  let saving = false

  /**
   * 保存成功后的收尾。顺序是承重的：`markPersisted` 必须取到**重置之前**的
   * 标题/正文/标签（`resetForNewNote` 会把它们换成一张空白新笔记）。
   */
  const saveDone = (ui: NoteSaveUi): void => {
    clearDraft()
    deps.autosave.hideBanner()
    // 这份内容已经进 wiki 了：同内容不再回写成草稿（v0.19.1），token 也失效。
    deps.autosave.markPersisted(ui.titleInput.value.trim(), ui.editor.getValue(), ui.tagEditor.getTags())
    deps.clearLoadedToken()
    deps.autosave.resetForNewNote()
    deps.close()
  }

  const doSave = async (): Promise<void> => {
    const ui = deps.getUi()
    if (ui === undefined) return
    if (saving) return
    const text = ui.editor.getValue().trim()
    if (text.length === 0) {
      toast(t('note.saveEmpty'))
      return
    }
    // 「写入」选中的那个库没在跑：host 现在会拒绝（而不是写进默认库），
    // 所以先说清楚，别让用户写完一整段才发现（v0.29.0）。
    const stopped = deps.stoppedTarget()
    if (stopped !== undefined) {
      toast(t('note.saveTargetStopped', { label: stopped.label }))
      return
    }
    saving = true
    ui.saveBtn.disabled = true
    ui.saveBtn.textContent = t('note.saving')
    try {
      const title = ui.titleInput.value.trim()
      const body: Record<string, unknown> = { title, tags: ui.tagEditor.getTags(), text }
      // Echo the token of the note loaded from 「🕘 最近」 (v0.19.1): if a human
      // edited it in the embedded TW editor meanwhile, the host answers 409 and
      // we refuse instead of silently overwriting their change.
      const loadedToken = deps.getLoadedToken()
      if (loadedToken !== null && loadedToken.title === title) {
        if (loadedToken.modified !== undefined) body.expectedModified = loadedToken.modified
        if (loadedToken.revision !== undefined) body.expectedRevision = loadedToken.revision
      }
      const res = await fetch(deps.wikiQuery(NOTE_ENDPOINT), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
      const payload = (await res.json().catch(() => null)) as { ok?: boolean; title?: string; error?: string; conflict?: boolean } | null
      if (!res.ok || payload?.ok !== true) {
        if (res.status === 409 || payload?.conflict === true) {
          toast(t('note.saveConflict'))
          return
        }
        toast(t('note.saveFailed', { message: payload?.error ?? `HTTP ${res.status}` }))
        return
      }
      saveDone(ui)
      toast(t('note.saved', { title: payload.title ?? ui.titleInput.value }))
    } catch (err) {
      toast(t('note.saveFailed', { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      saving = false
      ui.saveBtn.disabled = false
      ui.saveBtn.textContent = t('note.save')
    }
  }

  /** Save (if non-empty) and open the tiddler in TW's native editor. */
  const doEdit = async (): Promise<void> => {
    const ui = deps.getUi()
    if (ui === undefined) return
    const title = ui.titleInput.value.trim().length > 0 ? ui.titleInput.value.trim() : timestampTitle()
    const text = ui.editor.getValue()
    const tags = ui.tagEditor.getTags()
    ui.editBtn.disabled = true
    ui.editBtn.textContent = t('note.opening')
    try {
      await deps.postEditAndOpen(title, text, tags)
    } finally {
      ui.editBtn.disabled = false
      ui.editBtn.textContent = t('note.editInTw')
    }
  }

  return { doSave, doEdit }
}

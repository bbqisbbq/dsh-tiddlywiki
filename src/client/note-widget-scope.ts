/**
 * Quick-note card: WHICH knowledge base the card works on (v0.28.0 需求 R7 / v0.29.0).
 *
 * Extracted from `note-widget.ts` (v0.30.42) with the `tw-frame-hash.ts` recipe.
 * This is the card's **state-and-resolution** half: the roster, the focused wiki
 * the card follows, and the "target is stopped" verdict. The **DOM half** of the
 * 「写入」 selector deliberately stays in note-widget.ts — painting a `<select>` is
 * the card's business — and is handed back in through `setSyncDom`.
 *
 * ⚠️ EVERY call of the card must be scoped together: 标签建议 / 最近 / 草稿读取 /
 * 附件上传 / 保存 / 弹出的编辑器。只改保存那一处就会出现「标签列表来自 A、笔记写进
 * B」，比不做还糟 —— 所以 `wikiQuery` 住在这里，并且是构造 URL 的唯一入口。
 *
 * ⚠️ `ensureTarget()` must resolve BEFORE any write on BOTH entry paths. It used
 * to live inside `build()`, so the default click path (`openNative()`, which never
 * builds the card) wrote every quick note into the DEFAULT wiki. Silent, and only
 * reachable in a multi-wiki install — `verify-wiki-focus.mjs` pins the order.
 *
 * @module dsh-tiddlywiki/client/note-widget-scope
 */
import { fetchStatus } from './status-cache.ts'
import { resolveFocusWiki, subscribeFocusWiki } from './wiki-focus.ts'
import { withWikiQuery } from './endpoints.ts'

/** One knowledge base as the roster reports it (host `/status` payload). */
export interface WikiOption { id: string; label: string; running: boolean }

export interface NoteScopeDeps {
  /** The card's dispose flag: a resolution must not land after dispose. */
  isDisposed: () => boolean
}

export interface NoteScope {
  /** Target-wiki-scoped URL builder: `?wiki=<id>`, verbatim when no target. */
  wikiQuery: (url: string) => string
  /** Resolve WHICH knowledge base this card works on, ONCE, for BOTH entry paths. */
  ensureTarget: () => Promise<void>
  /**
   * The resolved target, when it is known AND not running.
   *
   * `/note` / `/edit` refuse a stopped wiki instead of writing into the default
   * one (v0.29.0), so the honest answer is to say so BEFORE the user writes a
   * paragraph.
   */
  stoppedTarget: () => { id: string; label: string } | undefined
  /** The user picked a wiki in THIS card: stop following the GUI focus wiki. */
  pick: (id: string | undefined) => void
  getRoster: () => WikiOption[]
  /** The registry default (its display name carries the 「（默认）」 mark). */
  getDefaultWikiId: () => string | undefined
  getTargetWiki: () => string | undefined
  /** The roster's mode — the popup editor's per-wiki proxy base needs it. */
  getMode: () => string
  /** Register how the card repaints its selector (a no-op until it builds one). */
  setSyncDom: (fn: () => void) => void
  /** Repaint the selector now. */
  syncDom: () => void
  /** Release the focus subscription (the card's `dispose()` calls this). */
  dispose: () => void
}

export function createNoteScope(deps: NoteScopeDeps): NoteScope {
  const { isDisposed } = deps
  /**
   * WHICH knowledge base this card works on.
   *
   * Default = the GUI's focused wiki (你在看哪个库，快速笔记就进哪个库), and the card's
   * own selector overrides it for as long as the card is open. `undefined` = the
   * default wiki, i.e. exactly what every call used to do — single-wiki installs
   * never see a change (and never see the selector).
   */
  let targetWiki: string | undefined
  /** True once the user picked a wiki in THIS card (stop following the focus). */
  let targetPicked = false
  let rosterMode = 'single'
  /** The knowledge-base roster (empty in single mode / before /status lands). */
  let roster: WikiOption[] = []
  let defaultWikiId: string | undefined
  /** 焦点库订阅（dispose 需回收）。 */
  let focusOff: (() => void) | undefined
  let targetPromise: Promise<void> | undefined
  /**
   * DOM half of `ensureTarget()`: repaint the 「写入」 selector from `roster`.
   *
   * A no-op until the Markdown card has been built — which is exactly why the
   * roster resolution can live OUTSIDE `build()` (v0.29.0). The native path never
   * builds the card, so it gets no selector but must still get the wiki.
   */
  let syncTargetDom: () => void = () => {}

  const wikiQuery = (url: string): string => withWikiQuery(url, targetWiki)

  const ensureTarget = (): Promise<void> => {
    targetPromise ??= fetchStatus().then((payload) => {
      if (isDisposed()) return
      // v0.29.0: a FAILED `/status` must not be memoized. `fetchStatus()`
      // resolves `null` when the request fails, and caching that verdict pinned
      // `targetWiki` to `undefined` for the rest of the page's life — so one
      // hiccup put every quick note back into the DEFAULT wiki (the exact bug
      // this function exists to prevent) and the 「写入」 selector never
      // appeared. Dropping the memo lets the next open try again.
      if (payload == null) {
        targetPromise = undefined
        return
      }
      rosterMode = typeof payload.mode === 'string' ? payload.mode : 'single'
      roster = (Array.isArray(payload.wikis) ? payload.wikis : []).map((item) => ({ id: item.id, label: item.label, running: item.running }))
      // 单库：`targetWiki` 保持 undefined = 逐字与升级前相同的行为。
      if (roster.length <= 1) return
      defaultWikiId = typeof payload.defaultId === 'string' ? payload.defaultId : undefined
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

  const stoppedTarget = (): { id: string; label: string } | undefined => {
    if (targetWiki === undefined) return undefined
    const item = roster.find((entry) => entry.id === targetWiki)
    return item !== undefined && !item.running ? item : undefined
  }

  const pick = (id: string | undefined): void => {
    targetPicked = true
    targetWiki = id
  }

  return {
    wikiQuery,
    ensureTarget,
    stoppedTarget,
    pick,
    getRoster: () => roster,
    getDefaultWikiId: () => defaultWikiId,
    getTargetWiki: () => targetWiki,
    getMode: () => rosterMode,
    setSyncDom: (fn) => { syncTargetDom = fn },
    syncDom: () => { syncTargetDom() },
    dispose: () => {
      focusOff?.()
      focusOff = undefined
    },
  }
}

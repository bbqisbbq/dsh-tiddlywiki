/**
 * Quick-note card: the 「🕘 最近」picker (dropdown + "load into the editor").
 *
 * Extracted from `note-widget.ts` (v0.30.41) with the `tw-frame-hash.ts` recipe:
 * this was the one group inside the 774-line `createNoteWidget()` closure whose
 * state (`recentOpen`) was private to its own three functions — so the state
 * MOVED here and **nothing in the card had to be renamed**.
 *
 * Everything else it needs from the card is either read-only (`ui`, reached
 * through a getter because `dispose()` sets it back to `undefined`) or a value
 * the card owns and must keep owning: `loadedToken` (the optimistic-concurrency
 * token echoed on save) and `persistedSignature` (what the card has already
 * written to the wiki). Those two arrive as setter callbacks — the card decides
 * what they mean, this module only feeds them.
 *
 * ⚠️ WHICH wiki is written is the card's business: every request goes through
 * the `wikiQuery` dep. Dropping it would silently send 「最近」to the default
 * wiki in a multi-wiki install (the exact bug `verify-wiki-focus.mjs` pins).
 *
 * @module dsh-tiddlywiki/client/note-widget-recent
 */
import { t } from './i18n.ts'
import { toast } from './toast.ts'
import { GET_ENDPOINT, RECENT_ENDPOINT } from './endpoints.ts'
import { draftSignature, relativeTime } from './note-widget-draft.ts'
import type { MarkdownEditor } from './markdown-editor.ts'

/**
 * The slice of the card's DOM refs (`BuiltUi` in note-widget.ts) the picker
 * touches. Declared structurally so this module never imports the card back
 * (a value import would be a runtime cycle; `BuiltUi` satisfies this shape).
 */
export interface RecentUi {
  editor: MarkdownEditor
  titleInput: HTMLInputElement
  tagEditor: { setTags(tags: string[]): void }
  draftBanner: { hidden: boolean }
  recentWrap: HTMLDivElement
}

export interface RecentPickerDeps {
  /** The card's DOM refs — `undefined` until the first `open()` builds them. */
  getUi: () => RecentUi | undefined
  /** Target-wiki-scoped URL builder (the card owns the target). */
  wikiQuery: (url: string) => string
  /** Hide the restored-draft banner (loading a note supersedes any draft). */
  hideDraftBanner: () => void
  /** The card's concurrency token for the note it has loaded. */
  setLoadedToken: (token: { title: string; modified?: string; revision?: number } | null) => void
  /** The card's "already written to the wiki" signature. */
  setPersistedSignature: (signature: string | null) => void
}

interface RecentItem { title: string; tags: string[]; modified: string | null; snippet: string }

export interface RecentPicker {
  /** Open the dropdown (fetching lazily each open), or close it when already open. */
  toggle(): void
  /** Close it and drop the open state (safe to call when never opened). */
  close(): void
}

export function createRecentPicker(deps: RecentPickerDeps): RecentPicker {
  const { getUi, wikiQuery, hideDraftBanner, setLoadedToken, setPersistedSignature } = deps
  /** Dropdown open state — private to this module (was a `let` in the closure). */
  let recentOpen = false

  const close = (): void => {
    recentOpen = false
    const ui = getUi()
    if (ui !== undefined) ui.recentWrap.hidden = true
  }

  /** Load a tiddler into the editor (recent picker click). */
  const loadNote = async (title: string): Promise<void> => {
    try {
      const res = await fetch(wikiQuery(`${GET_ENDPOINT}?title=${encodeURIComponent(title)}`), { signal: AbortSignal.timeout(10_000) })
      const payload = (await res.json().catch(() => null)) as { ok?: boolean; title?: string; text?: string; tags?: string[]; notFound?: boolean; error?: string; modified?: string | null; revision?: number | null } | null
      if (!res.ok || payload?.ok !== true || typeof payload.title !== 'string') {
        const reason = payload?.notFound === true ? t('note.notFound') : (payload?.error ?? `HTTP ${res.status}`)
        toast(t('note.loadFailed', { message: reason }))
        return
      }
      const ui = getUi()
      if (ui === undefined) return
      ui.editor.setValue(payload.text ?? '')
      ui.titleInput.value = payload.title
      ui.tagEditor.setTags(payload.tags ?? [])
      // Remember the concurrency token of this note so a later save refuses to
      // overwrite a concurrent human edit (v0.19.1). A freshly loaded note is by
      // definition not "already persisted" by this card.
      setLoadedToken({
        title: payload.title,
        ...(typeof payload.modified === 'string' && payload.modified.length > 0 ? { modified: payload.modified } : {}),
        ...(typeof payload.revision === 'number' ? { revision: payload.revision } : {}),
      })
      setPersistedSignature(draftSignature(payload.title, payload.text ?? '', payload.tags ?? []))
      hideDraftBanner()
      close()
      toast(t('note.loaded', { title: payload.title }))
      ui.editor.focus()
    } catch (err) {
      toast(t('note.loadFailed', { message: err instanceof Error ? err.message : String(err) }))
    }
  }

  /** Toggle the recent-notes dropdown (fetches lazily each open). */
  const toggle = (): void => {
    const ui = getUi()
    if (ui === undefined) return
    if (recentOpen) { close(); return }
    recentOpen = true
    ui.recentWrap.hidden = false
    ui.recentWrap.textContent = ''
    const loading = document.createElement('div')
    loading.className = 'dsh-tw-note-recent-muted'
    loading.textContent = t('note.loading')
    ui.recentWrap.append(loading)
    void (async () => {
      try {
        const res = await fetch(wikiQuery(`${RECENT_ENDPOINT}?limit=15`), { signal: AbortSignal.timeout(10_000) })
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; items?: unknown[]; error?: string } | null
        const current = getUi()
        if (!recentOpen || current === undefined) return
        current.recentWrap.replaceChildren()
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
          empty.textContent = payload?.ok === true ? t('note.noNotes') : t('note.listFailed', { message: payload?.error ?? t('note.unknown') })
          current.recentWrap.append(empty)
          return
        }
        for (const item of items) {
          const row = document.createElement('div')
          row.className = 'dsh-tw-note-recent-item'
          row.title = item.snippet || item.title
          // 键盘可达：div + click 对键盘用户不可用，补 role/tabIndex/Enter·Space。
          row.setAttribute('role', 'button')
          row.tabIndex = 0
          row.setAttribute('aria-label', t('note.loadNote', { title: item.title }))
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
          current.recentWrap.append(row)
        }
      } catch (err) {
        const current = getUi()
        if (!recentOpen || current === undefined) return
        current.recentWrap.replaceChildren()
        const empty = document.createElement('div')
        empty.className = 'dsh-tw-note-recent-muted'
        empty.textContent = t('note.listFailed', { message: err instanceof Error ? err.message : String(err) })
        current.recentWrap.append(empty)
      }
    })()
  }

  return { toggle, close }
}

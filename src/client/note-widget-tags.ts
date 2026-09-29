/**
 * Multi-tag chip editor for the quick-note card (v0.28.8 split).
 *
 * WHY IT IS ITS OWN MODULE: a self-contained widget with its own DOM, its own
 * tag-suggestion cache and its own document-level listener — the card only
 * mounts it. It also carries a rule worth reading on its own: tag suggestions
 * are fetched PER TARGET WIKI (v0.28.0), because a note written to wiki B must
 * not offer wiki A's tags.
 *
 * @module dsh-tiddlywiki/client/note-widget-tags
 */
import { t } from './i18n.ts'
import { TAGS_ENDPOINT } from './endpoints.ts'

/** Multi-tag chip editor with autocomplete from the wiki's existing tags. */
export function buildTagEditor(opts: { onChange?: () => void; wikiQuery?: (url: string) => string } = {}): {
  el: HTMLDivElement
  /** Commits any pending input first, then returns the chips (user actions). */
  getTags: () => string[]
  /** Pure read of the committed chips — never commits pending input. */
  peekTags: () => string[]
  setDefault: (tag: string) => void
  setTags: (tags: string[]) => void
  /** Remove the document-level outside-click listener (unmount must not leak). */
  dispose: () => void
} {
  const wrap = document.createElement('div')
  wrap.className = 'dsh-tw-note-tags'

  const chipWrap = document.createElement('div')
  chipWrap.className = 'dsh-tw-note-chips'
  const input = document.createElement('input')
  input.className = 'dsh-tw-note-taginput'
  input.placeholder = t('note.tagsPlaceholder')
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
      x.title = `t('note.removeTag', { tag })`
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

  // Existing tags, fetched lazily once per widget lifetime — PER TARGET WIKI
  // (v0.28.0): the card can be pointed at another knowledge base, and its tag
  // suggestions must come from the same one the note is written to. The memo is
  // keyed by the resolved URL, so switching the target re-reads automatically
  // (no reset call, nothing to forget).
  let knownTags: string[] = []
  let tagsPromise: Promise<string[]> | undefined
  let tagsPromiseKey: string | undefined
  const ensureTags = (): Promise<string[]> => {
    const url = opts.wikiQuery?.(TAGS_ENDPOINT) ?? TAGS_ENDPOINT
    if (tagsPromise === undefined || tagsPromiseKey !== url) {
      tagsPromiseKey = url
      tagsPromise = fetch(url, { signal: AbortSignal.timeout(5_000) })
        .then((r) => (r.ok ? (r.json() as Promise<{ tags?: string[] }>) : Promise.resolve<{ tags?: string[] }>({})))
        .then((p) => [...(p.tags ?? [])].sort((a, b) => a.localeCompare(b, 'zh')))
        .catch(() => [])
      void tagsPromise.then((list) => { knownTags = list })
    }
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
      // 键盘可达：div + mousedown 对键盘用户不可用，补 role/tabIndex/Enter·Space。
      item.setAttribute('role', 'button')
      item.tabIndex = 0
      item.setAttribute('aria-label', `t('note.addTag', { tag })`)
      item.addEventListener('mousedown', (event) => {
        event.preventDefault()
        addTag(tag)
      })
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          addTag(tag)
        }
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
  const onDocClick = (event: Event): void => {
    if (!wrap.contains(event.target as Node)) hideSuggest()
  }
  document.addEventListener('click', onDocClick, true)

  return {
    el: wrap,
    getTags: () => {
      commitInput()
      return [...chips]
    },
    peekTags: () => [...chips],
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
    dispose: () => document.removeEventListener('click', onDocClick, true),
  }
}

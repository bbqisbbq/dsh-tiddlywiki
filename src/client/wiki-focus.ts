/**
 * Which knowledge base the GUI is currently working in (v0.28.0).
 *
 * The GUI is single-focus by design: the center panel and the rightbar tab each
 * embed ONE wiki's editor at a time (`/tw/<id>/…`), and the FAB lists the others.
 * The choice is remembered PER BROWSER (localStorage) rather than per session —
 * it is a viewing preference, and reopening the GUI should land where you left
 * off.
 *
 * A remembered id is only a HINT: `resolveFocusWiki()` validates it against the
 * live roster from `/status` and falls back to the registry's default, so
 * removing or renaming a wiki can never strand the panel on a 404.
 *
 * @module dsh-tiddlywiki/client/wiki-focus
 */

/** localStorage key holding the focused wiki id. */
const STORAGE_KEY = 'dsh-tiddlywiki.focusWiki'

function readStored(): string | undefined {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw !== null && raw.length > 0 ? raw : undefined
  } catch {
    // Private mode / storage disabled: the focus simply is not remembered.
    return undefined
  }
}

let focusId: string | undefined = readStored()
const listeners = new Set<(id: string | undefined) => void>()

/** The remembered wiki id (may not exist any more — use `resolveFocusWiki`). */
export function getFocusWiki(): string | undefined {
  return focusId
}

/** Remember a new focused wiki (and notify every surface). */
export function setFocusWiki(id: string | undefined): void {
  if (id === focusId) return
  focusId = id
  try {
    if (id === undefined) window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, id)
  } catch {
    /* a preference that cannot be persisted is still honoured for this page */
  }
  for (const listener of [...listeners]) listener(id)
}

/** Subscribe to focus changes; returns the unsubscribe function. */
export function subscribeFocusWiki(listener: (id: string | undefined) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The minimum a roster entry must expose to be focusable. */
export interface FocusableWiki { id: string }

/**
 * The wiki the GUI should actually show: the remembered one when it still
 * exists, else the registry default, else the first entry. `undefined` only when
 * there is nothing to show at all.
 */
export function resolveFocusWiki(roster: readonly FocusableWiki[], defaultId: string | undefined): string | undefined {
  if (roster.length === 0) return focusId
  if (focusId !== undefined && roster.some((entry) => entry.id === focusId)) return focusId
  if (defaultId !== undefined && roster.some((entry) => entry.id === defaultId)) return defaultId
  return roster[0]?.id
}

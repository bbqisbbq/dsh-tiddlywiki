/**
 * Bottom action bar of the quick-note card (v0.30.47 slice).
 *
 * Layout only: the left group (upload button → recent button → the Ctrl+Enter
 * hint) and the right group (「✏️ 在 TW 中编辑」 / 「保存」). It owns NO card
 * state — it asks for two function references and the already-built upload
 * button, and hands back the elements the card wires the real actions onto
 * (`saveBtn` / `editBtn` click handlers are bound in the card, next to the save
 * module that implements them).
 *
 * Why the two groups are returned as well: `.dsh-tw-note-foot-left/right` carry
 * the flex rules that keep the right group pinned right and let it wrap instead
 * of squeezing the button labels onto two lines (v0.22.6) — the card appends
 * into them, so their class names are contract, not implementation detail.
 *
 * @module dsh-tiddlywiki/client/note-widget-foot
 */
import { t } from './i18n.ts'

export interface NoteFooterDeps {
  /** The upload button from `createNoteUploadUi` (v0.30.46) — appended, not created here. */
  uploadButton: HTMLButtonElement
  /** Opens/closes the 「🕘 最近」 dropdown (owned by `note-widget-recent.ts`). */
  onRecent: () => void
}

export interface NoteFooterUi {
  /** The bar itself — the card appends it to the card element. */
  foot: HTMLDivElement
  /** Left group: upload button + recent button (the recent one is wired here). */
  footLeft: HTMLDivElement
  /** Right group: 「编辑」 / 「保存」 (their click handlers are bound in the card). */
  footRight: HTMLDivElement
  saveBtn: HTMLButtonElement
  editBtn: HTMLButtonElement
}

/** The footer's left/right groups and their two buttons (no card state). */
export function createNoteFooter(deps: NoteFooterDeps): NoteFooterUi {
  const { uploadButton, onRecent } = deps

  const foot = document.createElement('div')
  foot.className = 'dsh-tw-note-foot'
  const footLeft = document.createElement('div')
  footLeft.className = 'dsh-tw-note-foot-left'
  const hint = document.createElement('span')
  hint.className = 'dsh-tw-note-hint'
  // The Mod-Enter shortcut itself is bound in the editor keymap; this is its label.
  hint.textContent = 'Ctrl+Enter'
  const recentBtn = document.createElement('button')
  recentBtn.type = 'button'
  recentBtn.className = 'dsh-tw-note-recent-btn'
  recentBtn.title = t('note.recentTitle')
  recentBtn.textContent = t('note.recent')
  recentBtn.addEventListener('click', () => { onRecent() })
  footLeft.append(uploadButton, recentBtn, hint)

  const footRight = document.createElement('div')
  footRight.className = 'dsh-tw-note-foot-right'
  const editBtn = document.createElement('button')
  editBtn.type = 'button'
  editBtn.className = 'dsh-tw-note-edit'
  editBtn.title = t('note.editTitle')
  editBtn.textContent = t('note.editInTw')
  const saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.className = 'dsh-tw-note-save'
  saveBtn.textContent = t('note.save')
  footRight.append(editBtn, saveBtn)

  foot.append(footLeft, footRight)
  return { foot, footLeft, footRight, saveBtn, editBtn }
}

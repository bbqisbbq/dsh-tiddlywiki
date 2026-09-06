/**
 * Quick-note button above the chat input box (需求: 输入框上方快速笔记按钮).
 *
 * Registers into the shell's `conversation.input.dock` slot — the sanctioned
 * "Full-width entries above the composer card" seat that sibling plugins
 * (todo / cost-meter / goal / queue / git-graph) already use. Entries render as
 * a flex column, so this strip stacks with theirs and can never overlap or
 * occlude anything. Gated by `ui.showQuickNoteDock` (default on), honored at
 * registration time in client/index.ts.
 *
 * Clicking opens the floating quick-note card (open-only; the card itself can
 * only be dismissed with its ✕ button). While the card is open the button
 * highlights, driven by the card's `dsh-tw-note-state` CustomEvent.
 *
 * @module dsh-tiddlywiki/client/quick-note-dock
 */
import * as React from 'react'
import type { NoteWidgetHandle } from './note-widget.ts'

/** Event name the note card dispatches on open/close (detail: { open }). */
export const NOTE_STATE_EVENT = 'dsh-tw-note-state'

/**
 * Build the dock entry component bound to one note-widget handle. Called once
 * per client mount; the returned component is what the slot renders.
 */
export function createQuickNoteDock(note: NoteWidgetHandle): () => React.ReactElement {
  return function QuickNoteDock() {
    const [open, setOpen] = React.useState(false)
    React.useEffect(() => {
      const onState = (event: Event): void => {
        const detail = (event as CustomEvent<{ open?: boolean }>).detail
        setOpen(detail?.open === true)
      }
      window.addEventListener(NOTE_STATE_EVENT, onState)
      return () => window.removeEventListener(NOTE_STATE_EVENT, onState)
    }, [])
    return React.createElement(
      'div',
      { className: 'dsh-tw-dock-note' },
      React.createElement(
        'button',
        {
          type: 'button',
          className: open ? 'dsh-tw-dock-note-btn dsh-tw-dock-note-btn-active' : 'dsh-tw-dock-note-btn',
          title: open ? '快速笔记已打开（点卡片右上角 ✕ 收起）' : '打开快速笔记（草稿自动保存，点别处不会关闭）',
          onClick: () => { void note.open() },
        },
        React.createElement('span', { className: 'dsh-tw-dock-note-icon', 'aria-hidden': 'true' }, '📝'),
        React.createElement('span', { className: 'dsh-tw-dock-note-label' }, open ? '快速笔记（已打开）' : '快速笔记'),
      ),
    )
  }
}

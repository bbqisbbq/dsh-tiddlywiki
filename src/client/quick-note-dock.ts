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
 *
 * 与输入框对齐：mount 后（含 resize / 窗口变化 / 卡片延迟挂载）测量 composer
 * 输入框（textarea / contenteditable）的右缘，把横条 paddingRight 设为差值，
 * 让按钮右缘与输入框右缘对齐——而不是悬在整列最右端。
 */
export function createQuickNoteDock(note: NoteWidgetHandle): () => React.ReactElement {
  return function QuickNoteDock() {
    const [open, setOpen] = React.useState(false)
    const wrapRef = React.useRef<HTMLDivElement | null>(null)
    const btnRef = React.useRef<HTMLButtonElement | null>(null)
    React.useEffect(() => {
      const onState = (event: Event): void => {
        const detail = (event as CustomEvent<{ open?: boolean }>).detail
        setOpen(detail?.open === true)
      }
      window.addEventListener(NOTE_STATE_EVENT, onState)
      return () => window.removeEventListener(NOTE_STATE_EVENT, onState)
    }, [])
    React.useLayoutEffect(() => {
      const wrap = wrapRef.current
      if (wrap === null) return
      const stack = wrap.parentElement
      if (stack === null) return
      const align = (): void => {
        const wrapRect = wrap.getBoundingClientRect()
        let right = wrapRect.right
        for (const el of stack.querySelectorAll('textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) {
          const r = el.getBoundingClientRect()
          if (r.width > 40 && r.height > 10) { right = r.right; break }
        }
        wrap.style.paddingRight = `${Math.max(0, wrapRect.right - right)}px`
      }
      align()
      const ro = new ResizeObserver(align)
      ro.observe(stack)
      window.addEventListener('resize', align)
      // The composer card may mount slightly later; re-measure a couple of times.
      const t1 = window.setTimeout(align, 120)
      const t2 = window.setTimeout(align, 600)
      return () => {
        ro.disconnect()
        window.removeEventListener('resize', align)
        window.clearTimeout(t1)
        window.clearTimeout(t2)
      }
    }, [])
    return React.createElement(
      'div',
      { ref: wrapRef, className: 'dsh-tw-dock-note' },
      React.createElement(
        'button',
        {
          ref: btnRef,
          type: 'button',
          className: open ? 'dsh-tw-dock-note-btn dsh-tw-dock-note-btn-active' : 'dsh-tw-dock-note-btn',
          title: open ? '快速笔记已打开（点卡片右上角 ✕ 收起）' : '打开快速笔记（在按钮上方弹出，可拖动标题栏移动）',
          onClick: () => { void note.open(btnRef.current ?? undefined) },
        },
        React.createElement('span', { className: 'dsh-tw-dock-note-icon', 'aria-hidden': 'true' }, '📝'),
        React.createElement('span', { className: 'dsh-tw-dock-note-label' }, open ? '快速笔记（已打开）' : '快速笔记'),
      ),
    )
  }
}

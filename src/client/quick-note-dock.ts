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
 * 与输入框对齐：mount 后（含 resize / 窗口变化）测量 composer 输入卡片
 * （Lexical contenteditable 所在、有边框圆角的可见「输入框」盒子）的右缘，
 * 把横条 paddingRight 设为差值，让按钮右缘与输入框右缘对齐——而不是悬在整列
 * 最右端。注意 dock 槽位会把各条目包在一个容器里、与输入栏是兄弟节点，所以
 * 必须逐级向上爬祖先才能找到输入框。
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
      /**
       * Find the composer input CARD: climb from the dock entry until an
       * ancestor's subtree contains a wide text field (>300px — the composer
       * input; dock entries' own inputs are small), then take the widest box
       * between that field and its containing column (the visible card).
       */
      const findCard = (): HTMLElement | null => {
        let input: Element | null = null
        let column: HTMLElement | null = null
        let node: HTMLElement | null = wrap
        while (node !== null && node !== document.documentElement) {
          node = node.parentElement
          if (node === null) break
          for (const el of node.querySelectorAll('textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) {
            if (el.getBoundingClientRect().width > 300) { input = el; column = node; break }
          }
          if (column !== null) break
        }
        if (input === null || column === null) return null
        const colW = column.getBoundingClientRect().width
        let cur: HTMLElement | null = input as HTMLElement
        let card: HTMLElement | null = null
        let cardW = 0
        while (cur !== null && cur !== column) {
          const w = cur.getBoundingClientRect().width
          if (w > 0 && w < colW - 8 && w >= cardW) { cardW = w; card = cur }
          cur = cur.parentElement
        }
        return card
      }
      const align = (): void => {
        const wrapRect = wrap.getBoundingClientRect()
        const card = findCard()
        const right = card !== null ? card.getBoundingClientRect().right : wrapRect.right
        const pad = Math.max(0, wrapRect.right - right)
        if (wrap.style.paddingRight !== `${pad}px`) wrap.style.paddingRight = `${pad}px`
      }
      align()
      // 侧边栏开/关会改变对话列宽度 → composer 输入卡片（居中、有 max-width）的
      // 右缘随之移动。旧实现只观察了 dock 容器，侧边栏变化时它不一定触发 resize，
      // 导致按钮停在上次的位置、不再对齐。这里观察「从 dock 条目一直到对话根节点
      // （带 data-phase）的整条祖先链」，任一祖先尺寸变化都会重测对齐。
      const ro = new ResizeObserver(align)
      let node: Element | null = wrap
      while (node !== null && node !== document.documentElement) {
        ro.observe(node)
        if (node instanceof HTMLElement && node.hasAttribute('data-phase')) break
        node = node.parentElement
      }
      window.addEventListener('resize', align)
      document.addEventListener('visibilitychange', align)
      // 自愈兜底：任何未观测到的布局变化（侧边栏切换、插件重渲染等）也会在
      // 1.5s 内被纠正；每帧只是几次 getBoundingClientRect 读取，开销可忽略。
      const guard = window.setInterval(align, 1500)
      // The composer card may mount slightly later; re-measure a couple of times.
      const t1 = window.setTimeout(align, 120)
      const t2 = window.setTimeout(align, 600)
      return () => {
        ro.disconnect()
        window.removeEventListener('resize', align)
        document.removeEventListener('visibilitychange', align)
        window.clearInterval(guard)
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
          title: open ? '快速笔记已打开（点此按钮或卡片右上角 ✕ 收起）' : '打开快速笔记（在按钮上方弹出，可拖动标题栏移动）',
          onClick: () => {
            // 开关：打开时再次点击即收起；打开时在按钮上方弹出（✕ 亦可关闭）。
            if (note.isOpen()) note.close()
            else void note.open(btnRef.current ?? undefined)
          },
        },
        React.createElement('span', { className: 'dsh-tw-dock-note-icon', 'aria-hidden': 'true' }, '📝'),
        React.createElement('span', { className: 'dsh-tw-dock-note-label' }, open ? '快速笔记（已打开）' : '快速笔记'),
      ),
    )
  }
}

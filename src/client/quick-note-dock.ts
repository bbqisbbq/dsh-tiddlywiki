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
import { NOTE_STATE_EVENT, type NoteWidgetHandle } from './note-widget.ts'
import { fetchUiConfig } from './ui-config.ts'
import { isEditorPopupOpen, closeEditorPopup } from './editor-popup.ts'

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
    // 点击行为由 ui.quickNoteMode 决定：native=直达 TW 原生编辑页（弹窗）；
    // card=Markdown 卡片。null = 配置尚未加载（点击时按配置实时分发）。
    const [mode, setMode] = React.useState<'native' | 'card' | null>(null)
    const wrapRef = React.useRef<HTMLDivElement | null>(null)
    const btnRef = React.useRef<HTMLButtonElement | null>(null)
    React.useEffect(() => {
      const onState = (event: Event): void => {
        const detail = (event as CustomEvent<{ open?: boolean }>).detail
        setOpen(detail?.open === true)
      }
      window.addEventListener(NOTE_STATE_EVENT, onState)
      void fetchUiConfig().then((cfg) => setMode(cfg.quickNoteMode))
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
      /** 测量一次对齐；返回 true = 找到了 composer 输入卡片（测量有效）。 */
      const align = (): boolean => {
        const wrapRect = wrap.getBoundingClientRect()
        const card = findCard()
        const right = card !== null ? card.getBoundingClientRect().right : wrapRect.right
        const pad = Math.max(0, wrapRect.right - right)
        if (wrap.style.paddingRight !== `${pad}px`) wrap.style.paddingRight = `${pad}px`
        return card !== null
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
      // 但常驻定时器没有必要：连续 3 次测量成功（找到 composer 输入卡片）即认为
      // 布局已稳定，清掉 interval；即使一直测不到（异常 shell），也在 20 次后
      // 强制收手，之后由 ResizeObserver + resize + visibilitychange 覆盖。
      let guardHits = 0
      let guardTicks = 0
      const guard = window.setInterval(() => {
        guardTicks++
        if (!align()) {
          if (guardTicks >= 20) window.clearInterval(guard)
          return
        }
        guardHits++
        if (guardHits >= 3) window.clearInterval(guard)
      }, 1500)
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
    const native = mode === 'native'
    const label = native ? '快速笔记' : (open ? '快速笔记（已打开）' : '快速笔记')
    const title = native
      ? '快速笔记：直接打开 TiddlyWiki 原生编辑器（再次点击可收起弹窗）'
      : (open ? '快速笔记已打开（点此按钮或卡片右上角 ✕ 收起）' : '打开快速笔记（在按钮上方弹出，可拖动标题栏移动）')
    return React.createElement(
      'div',
      { ref: wrapRef, className: 'dsh-tw-dock-note' },
      React.createElement(
        'button',
        {
          ref: btnRef,
          type: 'button',
          className: open ? 'dsh-tw-dock-note-btn dsh-tw-dock-note-btn-active' : 'dsh-tw-dock-note-btn',
          title,
          onClick: () => {
            // 开关：打开时再次点击即收起；card 模式在按钮上方弹出（✕ 亦可关闭），
            // native 模式直接开/关 TW 原生编辑弹窗。配置实时读取（短缓存）。
            void fetchUiConfig().then((cfg) => {
              if (cfg.quickNoteMode === 'native') {
                if (isEditorPopupOpen()) closeEditorPopup()
                else void note.openNative()
              } else if (note.isOpen()) {
                note.close()
              } else {
                void note.open(btnRef.current ?? undefined)
              }
            })
          },
        },
        React.createElement('span', { className: 'dsh-tw-dock-note-icon', 'aria-hidden': 'true' }, '📝'),
        React.createElement('span', { className: 'dsh-tw-dock-note-label' }, label),
      ),
    )
  }
}

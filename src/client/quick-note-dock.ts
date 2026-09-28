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
import { alignDockEntry } from './dock-align.ts'
import { isEditorPopupOpen, isEditorPopupBlank, closeEditorPopup } from './editor-popup.ts'

/**
 * Build the dock entry component bound to one note-widget handle. Called once
 * per client mount; the returned component is what the slot renders.
 *
 * 与输入框对齐：mount 后（含 resize / 窗口变化）测量 composer 输入卡片
 * （Lexical contenteditable 所在、有边框圆角的可见「输入框」盒子）的右缘，
 * 把横条 paddingRight 设为差值，让按钮右缘与输入框右缘对齐——而不是悬在整列
 * 最右端。注意 dock 槽位会把各条目包在一个容器里、与输入栏是兄弟节点，所以
 * 必须逐级往上爬祖先才能找到输入框。
 *
 * `scope`（v0.28.7）是同一行里渲染在按钮**前面**的元素（知识库选择器）。
 * 为什么合并成一个条目：dock 槽位是纵向 flex 列，**每个条目 = 一整行**，所以
 * "选择器一行、快速笔记一行"永远不可能对齐成一条 —— 各自量各自的宽度，视觉上
 * 就是两行错位（作者连报两次）。合并后只有一个条目、一次测量，两者天然同基线。
 */
export function createQuickNoteDock(
  note: NoteWidgetHandle,
  scope?: (props: { sessionId?: string }) => React.ReactElement | null,
): (props: { sessionId?: string }) => React.ReactElement {
  return function QuickNoteDock(props: { sessionId?: string }) {
    const [open, setOpen] = React.useState(false)
    // 点击行为由 ui.quickNoteMode 决定：native=直达 TW 原生编辑页（弹窗）；
    // card=Markdown 卡片。null = 配置尚未加载（点击时按配置实时分发）。
    const [mode, setMode] = React.useState<'native' | 'card' | null>(null)
    const wrapRef = React.useRef<HTMLDivElement | null>(null)
    const btnRef = React.useRef<HTMLButtonElement | null>(null)
    React.useEffect(() => {
      // alive 守卫（v0.22.3）：卸载后不再 setState；fetchUiConfig 带 TTL 缓存但
      // 首次调用会真的发请求，回调可能在组件卸载之后才 resolve。
      let alive = true
      const onState = (event: Event): void => {
        const detail = (event as CustomEvent<{ open?: boolean }>).detail
        setOpen(detail?.open === true)
      }
      window.addEventListener(NOTE_STATE_EVENT, onState)
      void fetchUiConfig().then((cfg) => {
        if (alive) setMode(cfg.quickNoteMode)
      })
      return () => {
        alive = false
        window.removeEventListener(NOTE_STATE_EVENT, onState)
      }
    }, [])
    // 与 composer 输入框右缘对齐：测量逻辑已抽到 client/dock-align.ts（v0.28.2），
    // 因为第二个 dock 条目（会话级知识库选择器）加进来时它没有对齐 —— 规则只写在
    // 这里，别人看不见。
    React.useLayoutEffect(() => {
      const wrap = wrapRef.current
      if (wrap === null) return
      return alignDockEntry(wrap)
    }, [])
    const native = mode === 'native'
    const label = native ? '快速笔记' : (open ? '快速笔记（已打开）' : '快速笔记')
    const title = native
      ? '快速笔记：直接打开 TiddlyWiki 原生编辑器（再次点击可收起弹窗）'
      : (open ? '快速笔记已打开（点此按钮或卡片右上角 ✕ 收起）' : '打开快速笔记（在按钮上方弹出，可拖动标题栏移动）')
    return React.createElement(
      'div',
      { ref: wrapRef, className: 'dsh-tw-dock-note' },
      // 知识库选择器排在按钮**前面**（同一行、同一基线）。它的 sessionId 必须
      // 从本条目透传下去 —— 槽位的 scope=session，props 是发给**条目组件**的，
      // 子元素不会自动拿到（v0.28.7：漏了这一步选择器会永远读不到会话 id）。
      // scope 为 undefined 时（单库安装）什么都不渲染，DOM 与以前逐字相同。
      scope?.({ ...(props.sessionId !== undefined ? { sessionId: props.sessionId } : {}) }) ?? null,
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
                // 只有「开着且里面确实有内容」才收起；空掉的弹窗（在 TW 里删掉
                // 正在编辑的笔记后 story 被清空，v0.22.6）要重新打开编辑器，
                // 否则用户连点也只会把一块白板关了又开。
                if (isEditorPopupOpen() && !isEditorPopupBlank()) closeEditorPopup()
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

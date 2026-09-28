/**
 * Per-SESSION knowledge-base selector above the chat input box
 * (需求: 会话栏上面可动态选择当前会话能用的 wiki).
 *
 * Registers into `conversation.input.dock` — the sanctioned "full-width entries
 * above the composer" seat the quick-note button already uses. That slot is
 * `kind: 'list', scope: 'session'`, so the component receives the `sessionId` it
 * is mounted for, which is exactly what the host needs to answer "which wiki is
 * THIS conversation working on".
 *
 * WHY THE SELECTION LIVES HOST-SIDE: it drives the agent's tool scope AND the
 * injected prompt (see host/session-scope.ts), so it cannot be a browser-only
 * preference. Picking here is all the user has to do.
 *
 * SINGLE-WIKI INSTALLS SEE NOTHING: the control renders only when MORE THAN ONE
 * `agentVisible` wiki exists. Hidden wikis are deliberately absent from the
 * list — offering one would contradict the setting the user just made (the host
 * refuses it with a 400 as well).
 *
 * @module dsh-tiddlywiki/client/wiki-scope-dock
 */
import * as React from 'react'
import { fetchStatus } from './status-cache.ts'
import { SESSION_WIKI_ENDPOINT } from './endpoints.ts'

interface WikiOption { id: string; label: string; running: boolean }

/** Props the shell passes to a `conversation.input.dock` entry (scope: session). */
interface DockProps {
  sessionId?: string
  /**
   * Session store reader, provided by the shell on session-scoped slots
   * (v0.28.8). Used to tell a BLANK (new) session from an active one; optional
   * because not every shell version supplies it.
   */
  useSessions?: (selector: (state: unknown) => unknown) => unknown
}

/** How the chip behaves in each seat (see scope-seat.ts). */
export interface WikiScopeDockOptions {
  /**
   * Render ONLY for a blank (new) session.
   *
   * Set when mounting into a seat that is not exclusive to blank sessions —
   * notably the dock FALLBACK: the dock already carries the selector inside the
   * quick-note row (v0.28.7), so an unconditional second mount would show the
   * same control twice. When the real selector-context seat exists, blank
   * sessions are the only thing it renders for anyway.
   */
  blankOnly?: boolean
}

/**
 * Read the session store's `blank` flag, tolerating every shape we might be
 * handed: an absent reader, an absent session, or a store that does not track
 * blankness. Unknown ⇒ `false`, i.e. "treat as active" — the conservative
 * choice, because rendering a blank-only chip in an active session is exactly
 * the duplication this option exists to prevent.
 */
function isBlankSession(props: DockProps): boolean {
  const sessionId = props.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false
  if (typeof props.useSessions !== 'function') return false
  try {
    return props.useSessions((state) => {
      const byId = (state as { byId?: Record<string, { blank?: unknown }> } | undefined)?.byId
      return byId?.[sessionId]?.blank === true
    }) === true
  } catch {
    return false
  }
}

/**
 * 会话级知识库选择器（v0.28.0）。
 *
 * 它**不是**一个独立的 dock 条目，而是渲染在快速笔记那一行**里面**的元素
 * （v0.28.7）：dock 是纵向 flex 列，一个条目 = 一整行，两个条目各自量宽度就永远
 * 对不齐。所以这里返回的是"一行里的一个内联块"，宽度由内容决定，不占满整行。
 *
 * 返回 `null` 表示"这一行不需要它"——单库安装（可见库 ≤1）时正是如此，DOM 与
 * 加这个功能之前逐字相同。
 */
export function createWikiScopeDock(options: WikiScopeDockOptions = {}): (props: DockProps) => React.ReactElement | null {
  const blankOnly = options.blankOnly === true
  return function WikiScopeDock(props: DockProps) {
    const sessionId = typeof props.sessionId === 'string' && props.sessionId.length > 0 ? props.sessionId : undefined
    // Hooks must run unconditionally — read blankness before any early return.
    const blank = isBlankSession(props)
    const [wikis, setWikis] = React.useState<WikiOption[]>([])
    const [scope, setScope] = React.useState('')
    const [note, setNote] = React.useState<string | undefined>(undefined)
    const [busy, setBusy] = React.useState(false)
    const wrapRef = React.useRef<HTMLDivElement | null>(null)

    // 注意（v0.28.7）：这里**不再**自己调 alignDockEntry。选择器已经从独立 dock 条目
    // 改成渲染在快速笔记那一行**里面**的元素，而那一行整行负责与输入框右缘对齐
    // （quick-note-dock.ts 的 wrapRef）。如果这里再量一次、再补一次右内边距，就是
    // 同一个右缘被补两遍 —— 选择器会被推进去一大截，正是"没和对话框对齐"的复现。
    // 保留 wrapRef 是为了给根元素一个稳定引用做测量/调试锚点，不参与对齐计算。

    React.useEffect(() => {
      if (sessionId === undefined) return
      let alive = true
      void (async () => {
        const [status, current] = await Promise.all([
          fetchStatus(),
          fetch(`${SESSION_WIKI_ENDPOINT}?session=${encodeURIComponent(sessionId)}`, { signal: AbortSignal.timeout(8_000) })
            .then((res) => (res.ok ? res.json() : null))
            .catch(() => null),
        ])
        if (!alive) return
        const visible = (status?.wikis ?? []).filter((wiki) => wiki.agentVisible)
        setWikis(visible.map((wiki) => ({ id: wiki.id, label: wiki.label, running: wiki.running })))
        setScope(typeof current?.scope === 'string' ? current.scope : '')
        setNote(typeof current?.reason === 'string' ? current.reason : undefined)
      })()
      return () => { alive = false }
    }, [sessionId])

    if (sessionId === undefined || wikis.length <= 1) return null
    // blankOnly（v0.28.8）：这一挂载点只在「新会话」阶段显示，避免与会话内
    // quick-note 行里的同一个选择器重复出现（见 WikiScopeDockOptions 的说明）。
    if (blankOnly && !blank) return null

    const apply = (next: string): void => {
      setBusy(true)
      void (async () => {
        try {
          const res = await fetch(SESSION_WIKI_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // A generous budget: selecting a wiki that is not running STARTS it
            // host-side (the tools resolve the scope synchronously and never start
            // anything themselves), and a cold child can take tens of seconds.
            body: JSON.stringify({ session: sessionId, wiki: next.length > 0 ? next : null }),
            signal: AbortSignal.timeout(120_000),
          })
          const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; scope?: string; reason?: string; error?: string }
          if (!res.ok || payload.ok !== true) {
            setNote(payload.error ?? `切换失败（HTTP ${res.status}）`)
            return
          }
          setScope(typeof payload.scope === 'string' ? payload.scope : next)
          setNote(typeof payload.reason === 'string' ? payload.reason : undefined)
        } catch (err) {
          setNote(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      })()
    }

    return React.createElement(
      'div',
      { ref: wrapRef, className: 'dsh-tw-scope-dock' },
      React.createElement('span', { className: 'dsh-tw-scope-label' }, '知识库'),
      React.createElement(
        'select',
        {
          className: 'dsh-tw-scope-select',
          value: scope,
          disabled: busy,
          'aria-label': '本会话使用的知识库',
          title: '本会话的 tiddlywiki_* 工具与注入提示词都作用于这个知识库（下一个模型步骤生效）',
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => { apply(event.target.value) },
        },
        React.createElement('option', { value: '' }, '默认库'),
        ...wikis.map((wiki) => React.createElement(
          'option',
          { key: wiki.id, value: wiki.id },
          `${wiki.label}${wiki.running ? '' : '（未运行，选中会启动）'}`,
        )),
      ),
      note !== undefined ? React.createElement('span', { className: 'dsh-tw-scope-note' }, note) : null,
    )
  }
}

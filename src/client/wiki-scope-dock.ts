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
// 切库后要立刻失效其它界面的作用域缓存（v0.28.8，见 wiki-scope.ts）。
import { invalidateSessionWikiId } from './wiki-scope.ts'
// 空白会话那一格（selector.context）是否已经拿着选择器（v0.28.11）。
import { isBlankSeatMounted, subscribeBlankSeat } from './scope-seat.ts'

interface WikiOption { id: string; label: string; running: boolean }

/** `resolved` of `/session/wiki`: the wiki a session EFFECTIVELY uses. */
interface ResolvedWiki { id: string; label: string }

/**
 * Read `{id,label}` out of a `/session/wiki` payload, tolerating every shape we
 * may be handed (absent field, wrong types, id-only). `undefined` = unknown.
 */
function readResolvedWiki(value: unknown): ResolvedWiki | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const id = (value as { id?: unknown }).id
  if (typeof id !== 'string' || id.length === 0) return undefined
  const label = (value as { label?: unknown }).label
  return { id, label: typeof label === 'string' && label.length > 0 ? label : id }
}

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
 * React binding for the blank-seat ownership flag (v0.28.11).
 *
 * The flag is written by `mountScopeSeat()` (possibly BEFORE this component
 * mounts, e.g. a re-render after the seat appeared), so the initial state must
 * be read, not assumed false — and the subscription keeps it live.
 */
function useBlankSeatMounted(): boolean {
  const [mounted, setMounted] = React.useState<boolean>(() => isBlankSeatMounted())
  React.useEffect(() => subscribeBlankSeat(() => { setMounted(isBlankSeatMounted()) }), [])
  return mounted
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
    const blankSeat = useBlankSeatMounted()
    const [wikis, setWikis] = React.useState<WikiOption[]>([])
    const [scope, setScope] = React.useState('')
    /**
     * The wiki this session effectively uses when no explicit scope is set —
     * the host resolves it (registry default, or the first running visible one)
     * and returns it as `resolved` (v0.28.12).
     *
     * WHY: the picker used to render a nameless 「默认库」 option. The author's
     * 2026-09-29 report: with a default wiki configured, the UI should show
     * THAT LIBRARY'S NAME everywhere (and a new session should already show it
     * selected) — 「默认库」 as a name must not appear in the list at all.
     */
    const [defaultWiki, setDefaultWiki] = React.useState<ResolvedWiki | undefined>(undefined)
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
        setDefaultWiki(readResolvedWiki(current?.resolved))
        setNote(typeof current?.reason === 'string' ? current.reason : undefined)
      })()
      return () => { alive = false }
    }, [sessionId])

    if (sessionId === undefined || wikis.length <= 1) return null
    // blankOnly（v0.28.8）：这一挂载点只在「新会话」阶段显示，避免与会话内
    // quick-note 行里的同一个选择器重复出现（见 WikiScopeDockOptions 的说明）。
    if (blankOnly && !blank) return null
    // 让位（v0.28.11）：新会话里 selector.context 那一格已经拿着选择器了，dock 里
    // 这一个（与快速笔记同一行）必须消失——作者 2026-09-29 报障「有两个知识库选择」。
    // 反向也成立：本机 shell 没有那一格时 blankSeat 恒为 false，这里照旧渲染，
    // 空白会话里仍有唯一一个选择器。
    if (!blankOnly && blank && blankSeat) return null

    // 「默认库」不再作为一个**名字**出现在这里（作者 2026-09-29 报障）：那个选项就是被设为
    // 默认的那个库本身，用它自己的显示名，后缀「（默认）」标示身份。选中它 = 清空显式
    // 作用域（仍然跟随默认），所以以后改了默认库，没动过选择器的会话会跟着走 —— 语义与
    // 原来那行 `value=''` 完全一致，只是不再用无名占位符。
    const defaultId = defaultWiki?.id ?? ''
    const listed = (id: string): boolean => wikis.some((wiki) => wiki.id === id)
    const selected = scope.length > 0 && listed(scope) ? scope : defaultId

    const options: WikiOption[] = [...wikis]
    if (defaultId.length > 0 && !listed(defaultId)) {
      // 默认库不在可见清单里（例如它被设成「对 Agent 隐身」）时必须**补一行**：
      // 否则下拉的 value 指向一个不存在的 option，界面直接显示成空白。
      // `running: true` 表示不额外标「未运行」—— 我们在这里拿不到它的运行态，
      // 而能被解析成"本会话实际使用"的库本来就一定是正在跑的那个。
      options.push({ id: defaultId, label: defaultWiki?.label ?? defaultId, running: true })
    }
    // 默认库排在最前（原来是那个无名选项的位置），其余保持清单顺序。
    const ordered = defaultId.length > 0 && listed(defaultId)
      ? [...options.filter((wiki) => wiki.id === defaultId), ...options.filter((wiki) => wiki.id !== defaultId)]
      : options

    const apply = (next: string): void => {
      // 选中默认库那一项 = 清空显式作用域，仍然跟随默认（默认库改了也跟着改）。
      const wanted = next === defaultId ? '' : next
      setBusy(true)
      void (async () => {
        try {
          const res = await fetch(SESSION_WIKI_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // A generous budget: selecting a wiki that is not running STARTS it
            // host-side (the tools resolve the scope synchronously and never start
            // anything themselves), and a cold child can take tens of seconds.
            body: JSON.stringify({ session: sessionId, wiki: wanted.length > 0 ? wanted : null }),
            signal: AbortSignal.timeout(120_000),
          })
          const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; scope?: string; resolved?: unknown; reason?: string; error?: string }
          if (!res.ok || payload.ok !== true) {
            setNote(payload.error ?? `切换失败（HTTP ${res.status}）`)
            return
          }
          setScope(typeof payload.scope === 'string' ? payload.scope : wanted)
          setDefaultWiki(readResolvedWiki(payload.resolved) ?? defaultWiki)
          setNote(typeof payload.reason === 'string' ? payload.reason : undefined)
          // 立即让工具卡/会话汇总重新解析作用域（v0.28.8）：它们按会话缓存 wiki id，
          // 不失效的话切库后已显示的卡片仍带着旧库的 ?wiki= 与库徽标。
          invalidateSessionWikiId(sessionId)
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
          value: selected,
          disabled: busy,
          'aria-label': '本会话使用的知识库',
          title: '本会话的 tiddlywiki_* 工具与注入提示词都作用于这个知识库（下一个模型步骤生效）',
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => { apply(event.target.value) },
        },
        ...ordered.map((wiki) => React.createElement(
          'option',
          { key: wiki.id, value: wiki.id },
          // 「（默认）」是**身份标记**，不是库名：库名照旧是它自己的显示名。
          `${wiki.label}${wiki.id === defaultId ? '（默认）' : ''}${wiki.running ? '' : '（未运行，选中会启动）'}`,
        )),
      ),
      note !== undefined ? React.createElement('span', { className: 'dsh-tw-scope-note' }, note) : null,
    )
  }
}

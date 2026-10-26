/**
 * Per-SESSION knowledge-base selector in the composer's tool row
 * (需求: 会话栏上面可动态选择当前会话能用的 wiki).
 *
 * SEAT (v0.30.66): `conversation.input.left` — DSH's documented seat for
 * "compact controls at the left of the composer tool row" (`kind: 'list'`,
 * `scope: 'session'`, owner props `{}` plus the standard session-scoped props,
 * so `sessionId` still arrives).
 *
 * WHAT IT REPLACED, AND WHY (read this before moving it again)
 * -----------------------------------------------------------
 * · v0.28.0 mounted it as its own `conversation.input.dock` entry. That slot is
 *   a **vertical flex column — one entry = one full row**, so the selector and
 *   the quick-note button could never sit side by side.
 * · v0.28.7 rendered it INSIDE the quick-note dock row (a `scope` child), and
 *   v0.28.8 tried to upgrade blank sessions to
 *   `conversation.input.selector.context` next to the mode picker.
 * · v0.30.66 audit: **that seat does not exist in DSH 0.2.1** — not merely
 *   "undeclared by this shell": the string appears nowhere in the shipped
 *   client bundles nor in the host's slot catalogue. The blank-session branch
 *   was dead code that had never rendered, and the whole `blankSeat` hand-off
 *   dance existed only to stop two copies showing at once.
 * · Now there is exactly ONE home: the tool row. No blank/active distinction,
 *   no second mount, no hand-off protocol.
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
import { t } from './i18n.ts'
import { fetchStatus } from './status-cache.ts'
import { SESSION_WIKI_ENDPOINT } from './endpoints.ts'
// 切库后要立刻失效其它界面的作用域缓存（v0.28.8，见 wiki-scope.ts）。
import { invalidateSessionWikiId } from './wiki-scope.ts'

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

/** Props the shell passes to a session-scoped `conversation.input.left` entry. */
interface DockProps {
  sessionId?: string
}

/**
 * 会话级知识库选择器（v0.28.0；座位演进见模块头）。
 *
 * 渲染在输入框工具行里（`conversation.input.left`），是一个 inline-flex 小控件：
 * 宽度由内容决定，不占满整行，也不再自己测量任何东西 —— 对齐由宿主那一行负责。
 *
 * 返回 `null` 表示"这里不需要它"：单库安装（可见库 ≤1）时正是如此。
 */
export function createWikiScopeDock(): (props: DockProps) => React.ReactElement | null {
  return function WikiScopeDock(props: DockProps) {
    const sessionId = typeof props.sessionId === 'string' && props.sessionId.length > 0 ? props.sessionId : undefined
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

    // 不测量、不补内边距（v0.30.66）：控件住在宿主的工具行里，那一行自己负责
    // 与输入框对齐。历史上它塞在 dock 行里时需要 ref + 逐行测量，那套逻辑已随
    // 迁移退役（见 dock-align.ts 的模块头）。

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
            setNote(payload.error ?? t('chrome.scopeSwitchFailed', { status: res.status }))
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
      // 不再挂 ref / 不再自己测量（v0.30.66）：这个控件现在住在宿主的工具行里，
      // 对齐由那一行负责。历史上这里挂 ref 是为了给 `alignDockEntry` 一个可测量
      // 的身份 —— 那套逻辑随「选择器塞进 dock 行」一起退役了。
      { className: 'dsh-tw-scope-dock' },
      React.createElement('span', { className: 'dsh-tw-scope-label' }, t('chrome.scopeSlotLabel')),
      React.createElement(
        'select',
        {
          className: 'dsh-tw-scope-select',
          value: selected,
          disabled: busy,
          'aria-label': t('chrome.scopeAriaLabel'),
          title: t('chrome.scopeTitle'),
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => { apply(event.target.value) },
        },
        ...ordered.map((wiki) => React.createElement(
          'option',
          { key: wiki.id, value: wiki.id },
          // 「（默认）」是**身份标记**，不是库名：库名照旧是它自己的显示名。
          `${wiki.label}${wiki.id === defaultId ? t('chrome.scopeDefaultMark') : ''}${wiki.running ? '' : t('chrome.scopeNotRunning')}`,
        )),
      ),
      note !== undefined ? React.createElement('span', { className: 'dsh-tw-scope-note' }, note) : null,
    )
  }
}

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
interface DockProps { sessionId?: string }

/**
 * The dock entry. Returning `null` is a supported way to occupy the slot and
 * show nothing — which is what a single-wiki install gets.
 */
export function createWikiScopeDock(): (props: DockProps) => React.ReactElement | null {
  return function WikiScopeDock(props: DockProps) {
    const sessionId = typeof props.sessionId === 'string' && props.sessionId.length > 0 ? props.sessionId : undefined
    const [wikis, setWikis] = React.useState<WikiOption[]>([])
    const [scope, setScope] = React.useState('')
    const [note, setNote] = React.useState<string | undefined>(undefined)
    const [busy, setBusy] = React.useState(false)

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
      { className: 'dsh-tw-scope-dock' },
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

/**
 * Session row → 「绑定本会话知识库」 context menu (v0.35.0).
 *
 * THE SEAT
 * --------
 * DSH 0.2.2 added `contextMenu.content` / `contextMenu.icon` slots plus the
 * `contextMenus` SERVICE (`client-ui-context-menu`). The service is what adds
 * ROWS to an existing native menu; the keyed slots only supply extra CONTENT
 * for a target kind the owner already dispatches. We want rows on the session
 * row's menu, so this module talks to the service and registers no slot at all.
 *
 * Contract, read off the shipped host (`dsh-client-ui-context-menu/lib/client.js`):
 *
 *   register({ id, target, order, observe?, resolve })
 *     · `target` is the KIND string; the owner dispatches `'session'` for a
 *       sidebar session row, with `value = { sessionId, displayTitle }`
 *       (`ui-workspace`: `getTriggerProps({ kind: 'session', value: { sessionId, displayTitle } })`).
 *     · providers are filtered by `kind === target.kind`, then sorted by
 *       `order`, then `id`.
 *     · `resolve(value, signal)` returns `Action[]`; it may return a Promise,
 *       but a Promise is raced against a `resolutionTimeoutMs` budget (default
 *       1000 ms) after which the host calls its own `failed()` (a toast). So
 *       this resolver is SYNCHRONOUS and never awaits.
 *     · Action: `{ id, label, children?, disabled?, danger?, icon?, run?(),
 *       separatorBefore?, afterContent? }`. The host refuses to `run` an action
 *       that has `disabled` or `children`, so a parent row is a submenu only.
 *
 * WHY `'session'` AND NOT OUR OWN KIND
 * ------------------------------------
 * Registering a provider for an existing kind ADDS rows (`providers.flatMap`).
 * Occupying the `contextMenu.content` cell for key `'session'` would instead
 * REPLACE the workspace's own body (`replaceRisk: "shadows-shipped-ui"`), which
 * we must never do. So: provider on `'session'`, no slot.
 *
 * WHY WE READ SERVICES WITH `ctx.get()` INSTEAD OF DECLARING THEM
 * --------------------------------------------------------------
 * `dsh.client.inject` is a static array; declaring `contextMenus` there would
 * make the WHOLE plugin wait for (and refuse to load without) a service that
 * only exists on DSH ≥ 0.2.2. The context menu is a convenience, not a
 * prerequisite, so it stays an optional read with a bounded retry — the same
 * pattern `tid-preview.ts` uses for `documentPreviews`.
 *
 * NEVER BLOCK, NEVER THROW
 * ------------------------
 * A resolver that throws or blocks breaks a native shell menu. Every path here
 * is wrapped: a missing cache yields `[]` (the menu simply has no row yet),
 * and any failure is a `console.warn` plus an empty result.
 *
 * @module dsh-tiddlywiki/client/session-menu
 */
import { t } from './i18n.ts'
import { fetchStatus, peekStatus } from './status-cache.ts'
import { peekSessionWikiScope, resolveSessionWikiId } from './wiki-scope.ts'
import { switchSessionWiki } from './session-wiki.ts'

/** Stable provider id (namespaced: the host keys providers by `target`/`id`). */
export const SESSION_MENU_PROVIDER_ID = 'dsh-tiddlywiki.session-wiki'
/** Order within the session menu; official rows live at 0–300. */
export const SESSION_MENU_ORDER = 320

/** The subset of `ContextMenuAction` we produce. */
export interface ContextMenuAction {
  id: string
  label: string
  children?: ContextMenuAction[]
  disabled?: boolean
  run?: () => void
}

/** The subset of the `contextMenus` service we call. */
interface ContextMenusFace {
  register(provider: {
    id: string
    target: string
    order: number
    resolve: (value: unknown, signal?: AbortSignal) => ContextMenuAction[]
  }): () => void
}

/** A visible knowledge base, as `/status` names it. */
interface VisibleWiki { id: string; label: string }

/** Pull `sessionId` out of whatever the owner captured. */
function sessionIdOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const id = (value as { sessionId?: unknown }).sessionId
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * The `agentVisible` roster, from the synchronous snapshot only.
 *
 * Returns `[]` when nothing has been read yet — the caller then warms the cache
 * and shows no row. Hidden knowledge bases are absent on purpose: the host
 * refuses an invisible scope with a 400, and offering one would contradict the
 * setting the user just made (same rule the composer selector follows).
 */
function visibleWikis(): VisibleWiki[] {
  const status = peekStatus()
  if (status === undefined) {
    // Warm for the NEXT open; fire-and-forget, never awaited.
    void fetchStatus()
    return []
  }
  const roster = Array.isArray(status.wikis) ? status.wikis : []
  // Deduplicate by id: the host refuses a duplicate ACTION id inside one
  // provider (`Duplicate menu action`), and a roster with two rows for one id
  // would otherwise break the whole menu, not just that row.
  const seen = new Set<string>()
  const out: VisibleWiki[] = []
  for (const wiki of roster) {
    if (!wiki.agentVisible) continue
    if (seen.has(wiki.id)) continue
    seen.add(wiki.id)
    out.push({ id: wiki.id, label: wiki.label })
  }
  return out
}

/**
 * Build the menu rows for one captured session target.
 *
 * PURE with respect to the host: it reads the two client caches, formats copy,
 * and returns actions. Exported so it can be asserted without a browser.
 *
 * @param value - captured target value, `{ sessionId, displayTitle }`.
 * @returns one parent row with the knowledge-base choices, or `[]` when the
 *   menu must stay silent (unknown session, single-wiki install, cache cold).
 */
export function sessionWikiMenuActions(value: unknown): ContextMenuAction[] {
  try {
    const sessionId = sessionIdOf(value)
    if (sessionId === undefined) return []
    const wikis = visibleWikis()
    // Single-wiki installs have nothing to choose: the composer selector hides
    // for the same reason (`wiki-scope-dock.ts`).
    if (wikis.length <= 1) return []

    const peek = peekSessionWikiScope(sessionId)
    if (!peek.ready) {
      // Cache cold: warm it and stay silent this time. Awaiting here would burn
      // the host's 1 s budget and could freeze the native menu.
      void resolveSessionWikiId(sessionId)
      return []
    }
    const explicit = peek.scope !== undefined && peek.scope.length > 0 ? peek.scope : undefined
    // The wiki that is effectively in use: the explicit scope, else the resolved
    // default — 「默认库」 is never a NAME here, it is the default wiki itself
    // (author's 2026-09-29 rule, same as the composer selector).
    const current = explicit ?? peek.resolved

    const children: ContextMenuAction[] = [
      {
        id: 'follow-default',
        label: t('chrome.menuWikiFollowDefault'),
        // Already following the default ⇒ nothing to do.
        disabled: explicit === undefined,
        run: () => { void applySessionWiki(sessionId, '') },
      },
    ]
    for (const wiki of wikis) {
      children.push({
        id: `wiki:${wiki.id}`,
        label: wiki.label,
        // The effective one cannot be re-selected (it is the current state).
        disabled: wiki.id === current,
        run: () => { void applySessionWiki(sessionId, wiki.id) },
      })
    }
    return [{ id: 'wiki', label: t('chrome.menuWikiParent'), children }]
  } catch (error) {
    // A throwing resolver would break a native shell menu.
    console.warn('[dsh-tiddlywiki] session menu: resolve failed:', error)
    return []
  }
}

/** Reuse the one switch path; failures stay off the menu's critical path. */
async function applySessionWiki(sessionId: string, wanted: string): Promise<void> {
  try {
    const result = await switchSessionWiki(sessionId, wanted)
    if (!result.ok) console.warn('[dsh-tiddlywiki] session menu: switch failed:', result.error)
  } catch (error) {
    console.warn('[dsh-tiddlywiki] session menu: switch threw:', error)
  }
}

/**
 * Register the session menu provider once `contextMenus` exists.
 *
 * `contextMenus` is provided by the shell's context-menu plugin, which may be
 * applied after us, so this polls briefly (250 ms × 40 ≈ 10 s) like
 * `registerTidPreview`. Never appearing is not an error: the composer selector
 * remains the primary way to switch, and older DSH has no such service at all.
 *
 * @param get - `ctx.get` (optional service read); absent ⇒ skip silently.
 * @returns disposers the caller must run on teardown.
 */
export function registerSessionWikiMenu(get: ((name: string) => unknown) | undefined): Array<() => void> {
  const disposers: Array<() => void> = []
  if (get === undefined) return disposers

  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let done = false

  const attempt = (): void => {
    if (done) return
    attempts += 1
    const menus = get('contextMenus') as ContextMenusFace | undefined
    if (menus === undefined || menus === null) {
      if (attempts >= 40) {
        // Developer log, not user copy (client gate forbids CJK literals here).
        console.warn('[dsh-tiddlywiki] session menu: contextMenus never appeared after ' + attempts + ' attempts; the session row will have no knowledge-base row (the composer selector still works)')
        return
      }
      timer = setTimeout(attempt, 250)
      return
    }
    done = true
    try {
      disposers.push(menus.register({
        id: SESSION_MENU_PROVIDER_ID,
        target: 'session',
        order: SESSION_MENU_ORDER,
        resolve: (value) => sessionWikiMenuActions(value),
      }))
      console.info('[dsh-tiddlywiki] session menu: provider registered on attempt ' + attempts + ' (target=session, id=' + SESSION_MENU_PROVIDER_ID + ')')
      // The roster is needed on the FIRST open; warm it now (coalesced with the
      // app's other `/status` readers, so this adds no extra request).
      void fetchStatus()
    } catch (error) {
      console.warn('[dsh-tiddlywiki] session menu: registration failed:', error)
    }
  }

  disposers.push(() => { if (timer !== undefined) clearTimeout(timer) })
  attempt()
  return disposers
}

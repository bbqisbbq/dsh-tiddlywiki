/**
 * Reply-stream native TiddlyWiki tool views (design 「回复流原生 TW wiki」 ②③).
 *
 * Registers the `tool.call.toolview` KEYED slot (key = each `tiddlywiki_*`
 * wire tool name, domain open — verified via Slots Inspect that none of our
 * keys are taken) so a tool call's card in the conversation flow renders the
 * wiki content in its NATIVE form:
 *
 *   title (from block.call.argsRaw) → GET /dsh-tiddlywiki/get (full tiddler)
 *                                   → POST /dsh-tiddlywiki/render (native HTML
 *                                     fragment, links rewritten to the
 *                                     same-origin proxy hash) → card body
 *
 * The whole component is plain React (`React.createElement`, no JSX — the
 * client bundle is not transpiled); `react` is never bundled and resolves from
 * the web app at runtime. The native fragment is injected via
 * `dangerouslySetInnerHTML`; it comes from the HOST render route
 * (`RENDER_ENDPOINT`, never TW's raw `/tw/render`), which runs every fragment
 * through the whitelist sanitizer first (v0.19.1) — see src/host/sanitize.ts.
 *
 * The render fragment + the agent's `[标题](/dsh-tiddlywiki/tw/#标题)` markdown
 * links are handled by a document-level click interceptor → openTiddler()
 * (open the center panel + set the iframe hash → TW native page).
 *
 * v0.30.14 split — this file is the DISPATCHER + registration point, and the
 * pieces live next door (the guard reads the whole FAMILY, so the layout can
 * change without touching `scripts/`; see scripts/lib/source-family.mjs):
 *   - tool-views-types.ts   structural types + argument decoding
 *   - tool-views-fetch.ts   same-origin fetchers, useAsync, tiddler-body LRU cache
 *   - tool-views-shell.ts   card chrome, per-tool badge, knowledge-base scope
 *   - tool-views-body.ts    native-rendered tiddler card + list primitives
 *   - tool-views-search.ts  search / recent / batch list cards
 *   - tool-views-misc.ts    attachment / tags / git / delete cards
 *   - tool-views-links.ts   TW-proxy path matcher + link interceptor
 *
 * @module dsh-tiddlywiki/client/tool-views
 */
import * as React from 'react'
import { t } from './i18n.ts'
import { callArgs, contentText, isSettled, parseArgs, str, type ToolCallOwnerProps } from './tool-views-types.ts'
import { ToolCardShell, WikiScopeContext, useScopeProviderValue } from './tool-views-shell.ts'
import { TiddlerBodyCard } from './tool-views-body.ts'
import { BatchCard, RecentCard, SearchCard } from './tool-views-search.ts'
import { AttachCard, DeleteCard, GitCard, TagsCard } from './tool-views-misc.ts'

/** A title for the card header, where the tool has one (empty = no title). */
function headerTitle(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'tiddlywiki_get':
    case 'tiddlywiki_put':
    case 'tiddlywiki_append':
    case 'tiddlywiki_replace':
    case 'tiddlywiki_delete':
    case 'tiddlywiki_attach':
    case 'tiddlywiki_backlinks':
      return str(args.title)
    case 'tiddlywiki_rename':
      return str(args.newTitle)
    case 'tiddlywiki_search':
      return str(args.query)
    default:
      return ''
  }
}

/** The one component registered under every `tiddlywiki_*` toolview key.
 *  Module-private (v0.22.8): only `registerToolViews()` below registers it. */
function TiddlywikiToolView(props: ToolCallOwnerProps): React.ReactNode {
  const wikiId = useScopeProviderValue(props.sessionId)
  return React.createElement(
    WikiScopeContext.Provider,
    { value: wikiId },
    React.createElement(TiddlywikiToolViewBody, props),
  )
}

/** The card body; runs INSIDE WikiScopeContext so `useScopedWikiId()` works. */
function TiddlywikiToolViewBody(props: ToolCallOwnerProps): React.ReactNode {
  const block = props.block
  const toolName = props.toolName
  const settled = isSettled(block)
  const call = callArgs(block)
  const name = toolName !== undefined && toolName.length > 0 ? toolName : call?.name ?? ''
  const args = parseArgs(call?.argsRaw ?? '')
  const text = settled ? contentText(block.content) : ''

  if (call === null) {
    return React.createElement(
      ToolCardShell,
      { toolName: name },
      React.createElement('pre', { className: 'dsh-tw-toolcard-fallback' }, text || t('card.noCallInfo')),
    )
  }

  if (!settled) {
    return React.createElement(
      ToolCardShell,
      { toolName: name, title: headerTitle(name, args) },
      React.createElement('div', { className: 'dsh-tw-toolcard-pending' }, t('card.pending')),
    )
  }

  if (block.isError === true) {
    return React.createElement(
      ToolCardShell,
      { toolName: name, title: headerTitle(name, args) },
      React.createElement('div', { className: 'dsh-tw-toolcard-error' }, text || t('card.callFailed')),
    )
  }

  switch (name) {
    case 'tiddlywiki_get':
      return React.createElement(TiddlerBodyCard, { toolName: name, title: str(args.title), subtitle: t('card.subRead') })
    case 'tiddlywiki_put':
      // 写入会改变正文：卡片带 fresh，loader（effect 阶段）先失效缓存再取最新内容。
      return React.createElement(TiddlerBodyCard, { toolName: name, title: str(args.title), subtitle: t('card.subWritten'), fresh: true })
    case 'tiddlywiki_append':
      // 增量写入同样改变正文（追加/前插/段落写入）。
      return React.createElement(TiddlerBodyCard, { toolName: name, title: str(args.title), subtitle: t('card.subAppended'), fresh: true })
    case 'tiddlywiki_replace':
      // 局部替换也改变正文。
      return React.createElement(TiddlerBodyCard, { toolName: name, title: str(args.title), subtitle: t('card.subReplaced'), fresh: true })
    case 'tiddlywiki_rename':
      return React.createElement(TiddlerBodyCard, { toolName: name, title: str(args.newTitle), subtitle: t('card.subRenamed', { old: str(args.oldTitle) }), fresh: true })
    case 'tiddlywiki_delete':
      // 删除类卡片只展示工具文本，没有 body 缓存；旧标题的残留缓存由 TTL 兜底。
      return React.createElement(DeleteCard, { toolName: name, title: str(args.title), text })
    case 'tiddlywiki_attach':
      return React.createElement(AttachCard, { toolName: name, title: str(args.title) })
    case 'tiddlywiki_batch_put':
      return React.createElement(BatchCard, { toolName: name, args })
    case 'tiddlywiki_search':
      // `text` carries the scope note the tool rendered (v0.25.0).
      return React.createElement(SearchCard, { toolName: name, args, text })
    case 'tiddlywiki_recent':
      return React.createElement(RecentCard, { toolName: name, args })
    case 'tiddlywiki_list_tags':
      return React.createElement(TagsCard, { toolName: name })
    case 'tiddlywiki_git_sync':
    case 'tiddlywiki_git_resolve':
      return React.createElement(GitCard, { toolName: name, text })
    default:
      return React.createElement(
        ToolCardShell,
        { toolName: name, title: headerTitle(name, args) },
        React.createElement('pre', { className: 'dsh-tw-toolcard-fallback' }, text || t('card.done')),
      )
  }
}

/** All `tiddlywiki_*` wire tool names the keyed slot should own. Module-private
 *  (v0.22.8): the registration loop below is its only consumer. */
const TOOL_VIEW_KEYS: readonly string[] = [
  'tiddlywiki_get',
  'tiddlywiki_search',
  'tiddlywiki_recent',
  'tiddlywiki_list_tags',
  'tiddlywiki_put',
  'tiddlywiki_batch_put',
  'tiddlywiki_append',
  'tiddlywiki_replace',
  'tiddlywiki_rename',
  'tiddlywiki_delete',
  'tiddlywiki_trash',
  'tiddlywiki_backlinks',
  'tiddlywiki_attach',
  'tiddlywiki_lint',
  'tiddlywiki_git_sync',
  'tiddlywiki_git_resolve',
]

/**
 * Register the tool card under every key. Returns an array of disposers.
 *
 * `tool.call.toolview` is a CHILD slot (declared by an entry inside
 * `conversation.chat.node`), so a bare `slots.register` throws
 * `slot "tool.call.toolview" is not declared (a parent entry's children table
 * must declare it)` when it runs before the parent declaration. Each key must
 * therefore be wrapped in `slots.inject('tool.call.toolview', cb)`, which runs
 * `cb` synchronously when the declaration already exists and otherwise waits
 * for it — the same pattern `settings.section` uses.
 */
export function registerToolViews(slots: {
  inject(key: string, callback: () => () => void): (() => void) | undefined
  register(opts: { name: string; id: string; key: string; order?: number; label?: string }, component: unknown): () => void
}): Array<() => void> {
  const disposers: Array<() => void> = []
  for (const key of TOOL_VIEW_KEYS) {
    try {
      const remove = slots.inject('tool.call.toolview', () =>
        slots.register(
          { name: 'tool.call.toolview', id: `dsh-tiddlywiki-toolview-${key}`, key, order: 20, label: `TiddlyWiki: ${key}` },
          TiddlywikiToolView,
        ),
      )
      if (remove !== undefined) disposers.push(remove)
    } catch (error) {
      console.error(`[dsh-tiddlywiki] register toolview ${key} failed:`, error)
    }
  }
  return disposers
}

// Public surface of the family, kept on `tool-views.ts` so `index.ts` (the only
// consumer) never has to know how the module is split internally.
export { installWikiLinkInterceptor, matchTwProxyPath } from './tool-views-links.ts'

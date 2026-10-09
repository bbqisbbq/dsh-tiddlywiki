/**
 * Card shell + knowledge-base scope of the reply-stream tool cards (v0.30.14
 * split of `tool-views.ts`).
 *
 * Two things live here because every card needs both:
 *   1. the shared chrome (`ToolCardShell`, the per-tool badge, the 「在 TW 打开」
 *      button, the reveal-in-TW click handler), and
 *   2. the knowledge-base SCOPE (`WikiScopeContext` + its provider), which is what
 *      keeps a card from asking the host for the DEFAULT wiki while the model is
 *      talking about another one (v0.28.8).
 *
 * @module dsh-tiddlywiki/client/tool-views-shell
 */
import * as React from 'react'
import { t } from './i18n.ts'
import { openTiddler } from './panel.ts'
import { resolveSessionWikiId } from './wiki-scope.ts'

/**
 * Badge text for each tool, as a THUNK (v0.30.14 i18n).
 *
 * A module-level `Record<string, string>` of translated labels would be resolved
 * once, when the bundle loads, and would then show that language forever — the
 * card tree is plain React and re-renders on every language change, so the delay
 * has to happen at render time. `scripts/verify-tool-views.mjs` asserts that this
 * map covers every `TOOL_VIEW_KEYS` entry.
 */
const TOOL_LABELS: Record<string, () => string> = {
  tiddlywiki_get: () => t('card.toolGet'),
  tiddlywiki_search: () => t('card.toolSearch'),
  tiddlywiki_recent: () => t('card.toolRecent'),
  tiddlywiki_list_tags: () => t('card.toolListTags'),
  tiddlywiki_put: () => t('card.toolPut'),
  tiddlywiki_batch_put: () => t('card.toolBatchPut'),
  tiddlywiki_append: () => t('card.toolAppend'),
  tiddlywiki_replace: () => t('card.toolReplace'),
  tiddlywiki_rename: () => t('card.toolRename'),
  tiddlywiki_delete: () => t('card.toolDelete'),
  tiddlywiki_trash: () => t('card.toolTrash'),
  tiddlywiki_backlinks: () => t('card.toolBacklinks'),
  tiddlywiki_attach: () => t('card.toolAttach'),
  tiddlywiki_lint: () => t('card.toolLint'),
  tiddlywiki_git_sync: () => t('card.toolGitSync'),
  tiddlywiki_git_resolve: () => t('card.toolGitResolve'),
}

/** Open a tiddler in the center TW panel (shared by rows + 「在 TW 打开」). */
export function openTw(title: string, wikiId?: string): (event: React.MouseEvent) => void {
  return (event) => {
    // 列表行是 <a href=tw/#标题>：带修饰键 / 非左键的点击保留浏览器默认语义
    // （新标签页、新窗口、复制链接），只有普通左键点击才改走中央 TW 面板。
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    event.stopPropagation()
    // 卡片**知道**自己来自哪个库（会话作用域，v0.28.8）：`undefined` 在这里是
    // 「默认库」的确切答案，必须传 null——省略就退化成「未指定」，多库下面板会
    // 留在当前焦点库上（作者 2026-09-29 报障：点开跳到最后打开的库）。
    openTiddler(title, wikiId === undefined ? null : wikiId)
  }
}

/* ── shared card shell ── */

export function ToolCardShell(props: {
  toolName: string
  title?: string
  subtitle?: string
  tags?: readonly string[]
  onOpen?: (event: React.MouseEvent) => void
  foot?: React.ReactNode
  children?: React.ReactNode
}): React.ReactElement {
  const label = TOOL_LABELS[props.toolName]?.() ?? props.toolName
  const wikiId = useScopedWikiId()
  const head = React.createElement(
    'div',
    { className: 'dsh-tw-toolcard-head' },
    React.createElement('span', { className: 'dsh-tw-toolcard-badge' }, label),
    // 知识库徽标（v0.28.8）：只有会话明确选了某个库时才显示。多库下「这张卡来自
    // 哪个库」是必须可见的信息 —— 模型文本里有【知识库：X】、卡片却什么都不说，
    // 用户无法判断两者是否一致。单库/默认库时整块不渲染，DOM 与以前相同。
    wikiId !== undefined
      ? React.createElement('span', { className: 'dsh-tw-toolcard-wiki', title: t('card.scopeBadgeTitle', { wiki: wikiId }) }, wikiId)
      : null,
    props.title !== undefined && props.title.length > 0
      ? React.createElement('span', { className: 'dsh-tw-toolcard-title', title: props.title }, props.title)
      : null,
    props.onOpen !== undefined
      ? React.createElement('button', { type: 'button', className: 'dsh-tw-toolcard-open', onClick: props.onOpen }, t('card.openInTw'))
      : null,
  )
  const meta = props.subtitle !== undefined || (props.tags !== undefined && props.tags.length > 0)
    ? React.createElement(
        'div',
        { className: 'dsh-tw-toolcard-meta' },
        props.subtitle !== undefined ? React.createElement('span', { className: 'dsh-tw-toolcard-sub' }, props.subtitle) : null,
        props.tags !== undefined && props.tags.length > 0
          ? React.createElement(
              'span',
              { className: 'dsh-tw-toolcard-tags' },
              // index in the key: a tiddler can carry the same tag twice (TW does
              // not dedup), and duplicate keys make React drop/reshuffle chips.
              ...props.tags.map((tag, index) => React.createElement('span', { className: 'dsh-tw-toolcard-tag', key: `${index}-${tag}` }, tag)),
            )
          : null,
      )
    : null
  return React.createElement(
    'div',
    {
      className: 'dsh-tw-toolcard',
      // 卡片正文里的原生链接（Agent 写的裸 `/tw/#标题`）由全局拦截器接管；拦截器
      // 需要一个「这张卡来自哪个库」的答案，所以把作用域挂到卡片根上（v0.28.11）。
      // wikiId 为 undefined（默认库/单库）时不渲染该属性，DOM 与以前逐字相同。
      'data-dsh-tw-wiki': wikiId,
    },
    head,
    meta,
    React.createElement('div', { className: 'dsh-tw-toolcard-body' }, props.children),
    props.foot !== undefined && props.foot !== null ? React.createElement('div', { className: 'dsh-tw-toolcard-foot' }, props.foot) : null,
  )
}

/* ── knowledge-base scope ── */

/**
 * The knowledge base the CURRENT session is scoped to (v0.28.8, feedback 10).
 *
 * Provided once at the top of the card tree and read by every fetch/link below,
 * so no card can accidentally ask the host for the DEFAULT wiki while the model
 * is talking about another one. `undefined` = default wiki = exactly what every
 * request did before this existed.
 */
export const WikiScopeContext = React.createContext<string | undefined>(undefined)

/** The scoped wiki id, or undefined for the default wiki. */
export function useScopedWikiId(): string | undefined {
  return React.useContext(WikiScopeContext)
}

/**
 * Read the session's wiki scope once and provide it to the subtree.
 *
 * `sessionId` comes from the tool-call owner props (the shell passes it on the
 * session-scoped `tool.call.toolview` slot). While the read is in flight the
 * value is `undefined`, i.e. the card renders against the default wiki and then
 * re-renders against the right one — a brief mismatch, never a wrong write, and
 * the card's own data loader keeps its `wikiId` in its dependency list so the
 * fetch is redone rather than cached under the wrong key.
 */
export function useScopeProviderValue(sessionId: string | undefined): string | undefined {
  const [wikiId, setWikiId] = React.useState<string | undefined>(undefined)
  React.useEffect(() => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      setWikiId(undefined)
      return
    }
    let alive = true
    void resolveSessionWikiId(sessionId).then((id) => {
      if (alive) setWikiId(id)
    })
    return () => { alive = false }
  }, [sessionId])
  return wikiId
}

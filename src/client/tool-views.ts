/**
 * Reply-stream native TiddlyWiki tool views (design 「回复流原生 TW wiki」 ②③).
 *
 * Registers the `tool.call.toolview` KEYED slot (key = each `tiddlywiki_*`
 * wire tool name, domain open — verified via Slots Inspect that none of our
 * keys are taken) so a tool call's card in the conversation flow renders the
 * wiki content in its NATIVE form:
 *
 *   title (from block.call.argsRaw) → GET /dsh-tiddlywiki/get (full tiddler)
 *                                   → POST /dsh-tiddlywiki/tw/render (native
 *                                     HTML fragment, links rewritten to the
 *                                     same-origin proxy hash) → card body
 *
 * The whole component is plain React (`React.createElement`, no JSX — the
 * client bundle is not transpiled); `react` is never bundled and resolves from
 * the web app at runtime. The native fragment is injected via
 * `dangerouslySetInnerHTML` — acceptable because the HTML comes from the LOCAL
 * wiki (same trust as the embedded center-column editor).
 *
 * The render fragment + the agent's `[标题](/dsh-tiddlywiki/tw/#标题)` markdown
 * links are handled by a document-level click interceptor → openTiddler()
 * (open the center panel + set the iframe hash → TW native page).
 *
 * @module dsh-tiddlywiki/client/tool-views
 */
import * as React from 'react'
import { openTiddler } from './panel.ts'

/** Same-origin TW proxy base (mirrors host TW_PROXY_PATH, client can't import it). */
const TW_PROXY_BASE = '/dsh-tiddlywiki/tw/'

const GET_ENDPOINT = '/dsh-tiddlywiki/get'
const SEARCH_ENDPOINT = '/dsh-tiddlywiki/search'
const RECENT_ENDPOINT = '/dsh-tiddlywiki/recent'
const TAGS_ENDPOINT = '/dsh-tiddlywiki/tags'
const RENDER_ENDPOINT = '/dsh-tiddlywiki/tw/render'

/** Chinese label for each tool (card badge). */
const TOOL_LABELS: Record<string, string> = {
  tiddlywiki_get: '读取笔记',
  tiddlywiki_search: '检索笔记',
  tiddlywiki_recent: '最近修改',
  tiddlywiki_list_tags: '标签列表',
  tiddlywiki_put: '写入笔记',
  tiddlywiki_batch_put: '批量写入',
  tiddlywiki_rename: '重命名笔记',
  tiddlywiki_delete: '删除笔记',
  tiddlywiki_git_sync: 'git 同步',
  tiddlywiki_git_resolve: 'git 冲突解决',
}

/* ── structural types (subset of dsh-client-ui-conversation records) ── */

interface CallHead {
  name: string
  argsRaw: string
}

interface RunningCallLike {
  name?: string
  argsRaw?: string
}

interface SettledLike {
  kind?: string
  call?: CallHead | null
  content?: readonly ContentBlockLike[]
  isError?: boolean
}

interface ContentBlockLike {
  kind?: string
  text?: unknown
}

/** Owner props the shell passes to a keyed tool view (verified via Inspect). */
interface ToolCallOwnerProps {
  callId: string
  toolName: string
  block: RunningCallLike | SettledLike
  cwd?: string
  home?: string
  openFile: (path: string) => void
  inspect?: () => void
}

function isSettled(block: RunningCallLike | SettledLike): block is SettledLike {
  return typeof block === 'object' && block !== null && (block as SettledLike).kind === 'tool-result'
}

/** The call identity: settled nodes carry it under `call`, running nodes top-level. */
function callArgs(block: RunningCallLike | SettledLike): CallHead | null {
  if (typeof block !== 'object' || block === null) return null
  const settled = block as SettledLike
  if (typeof settled.call === 'object' && settled.call !== null) {
    const c = settled.call as CallHead
    if (typeof c.name === 'string' && typeof c.argsRaw === 'string') return c
  }
  const running = block as RunningCallLike
  if (typeof running.name === 'string' && typeof running.argsRaw === 'string') {
    return { name: running.name, argsRaw: running.argsRaw }
  }
  return null
}

function parseArgs(argsRaw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsRaw) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Model-visible rendered text of a settled node (fallback when service is down). */
function contentText(content: readonly ContentBlockLike[] | undefined): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is ContentBlockLike & { text: string } => typeof b?.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/* ── fetch helpers (same-origin JSON / fragment) ── */

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    const data = (await res.json()) as unknown
    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function fetchRender(title: string): Promise<string | null> {
  try {
    const res = await fetch(RENDER_ENDPOINT, {
      method: 'POST',
      // TW's server gates every POST behind the writer CSRF header
      // (core-server/server.js: POST → "writers", requires X-Requested-With).
      // Same-origin requests may set it freely; the header is what makes the
      // request land instead of a 403.
      headers: { 'content-type': 'application/json', 'x-requested-with': 'TiddlyWiki' },
      body: JSON.stringify({ title }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

/** Lightweight async-state hook for one loader keyed by `deps`. */
function useAsync<T>(factory: () => Promise<T | null>, deps: readonly unknown[]): { loading: boolean; data: T | null } {
  const [state, setState] = React.useState<{ loading: boolean; data: T | null }>({ loading: true, data: null })
  React.useEffect(() => {
    let alive = true
    setState({ loading: true, data: null })
    Promise.resolve(factory()).then(
      (data) => {
        if (alive) setState({ loading: false, data })
      },
      () => {
        if (alive) setState({ loading: false, data: null })
      },
    )
    return () => {
      alive = false
    }
    // factory identity is not a dep on purpose — callers pass stable closures
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}

/** Open a tiddler in the center TW panel (shared by rows + 「在 TW 打开」). */
function openTw(title: string): (event: React.MouseEvent) => void {
  return (event) => {
    event.preventDefault()
    event.stopPropagation()
    openTiddler(title)
  }
}

/* ── shared card shell ── */

function ToolCardShell(props: {
  toolName: string
  title?: string
  subtitle?: string
  tags?: readonly string[]
  onOpen?: (event: React.MouseEvent) => void
  foot?: React.ReactNode
  children?: React.ReactNode
}): React.ReactElement {
  const label = TOOL_LABELS[props.toolName] ?? props.toolName
  const head = React.createElement(
    'div',
    { className: 'dsh-tw-toolcard-head' },
    React.createElement('span', { className: 'dsh-tw-toolcard-badge' }, label),
    props.title !== undefined && props.title.length > 0
      ? React.createElement('span', { className: 'dsh-tw-toolcard-title', title: props.title }, props.title)
      : null,
    props.onOpen !== undefined
      ? React.createElement('button', { type: 'button', className: 'dsh-tw-toolcard-open', onClick: props.onOpen }, '在 TW 打开')
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
              ...props.tags.map((tag) => React.createElement('span', { className: 'dsh-tw-toolcard-tag', key: tag }, tag)),
            )
          : null,
      )
    : null
  return React.createElement(
    'div',
    { className: 'dsh-tw-toolcard' },
    head,
    meta,
    React.createElement('div', { className: 'dsh-tw-toolcard-body' }, props.children),
    props.foot !== undefined && props.foot !== null ? React.createElement('div', { className: 'dsh-tw-toolcard-foot' }, props.foot) : null,
  )
}

/* ── tiddler card (get / put / rename): native-rendered body ── */

function TiddlerBodyCard(props: { toolName: string; title: string; subtitle: string }): React.ReactElement {
  const { title } = props
  const both = useAsync(
    async () => {
      const [get, html] = await Promise.all([fetchJson(`${GET_ENDPOINT}?title=${encodeURIComponent(title)}`), fetchRender(title)])
      return { get, html }
    },
    [title],
  )
  const { loading, data } = both
  const get = data?.get ?? null
  const html = data?.html ?? null

  let body: React.ReactNode
  if (loading) {
    body = React.createElement('div', { className: 'dsh-tw-toolcard-loading' }, '渲染中…')
  } else if (get !== null && get.notFound === true) {
    body = React.createElement('div', { className: 'dsh-tw-toolcard-empty' }, `tiddler「${title}」不存在`)
  } else if (typeof html === 'string' && html.length > 0) {
    body = React.createElement('div', {
      className: 'dsh-tw-toolcard-native',
      dangerouslySetInnerHTML: { __html: html },
    })
  } else if (get !== null && typeof get.text === 'string' && get.text.length > 0) {
    // Native render unavailable (wiki up but route missing) → raw text.
    body = React.createElement('pre', { className: 'dsh-tw-toolcard-fallback' }, get.text)
  } else {
    body = React.createElement('div', { className: 'dsh-tw-toolcard-empty' }, 'wiki 服务不可用')
  }

  const tags = Array.isArray(get?.tags) ? (get.tags as unknown[]).filter((t): t is string => typeof t === 'string') : []
  const modified = typeof get?.modified === 'string' ? (get.modified as string) : undefined

  return React.createElement(
    ToolCardShell,
    {
      toolName: props.toolName,
      title,
      subtitle: props.subtitle,
      tags,
      onOpen: openTw(title),
      foot: modified !== undefined ? `修改于 ${modified}` : undefined,
    },
    body,
  )
}

/* ── list cards (search / recent / batch) ── */

function HitRow(props: { title: string; tags?: readonly string[]; modified?: string | null; snippet?: string }): React.ReactElement {
  return React.createElement(
    'a',
    {
      className: 'dsh-tw-toolcard-row',
      href: `${TW_PROXY_BASE}#${encodeURIComponent(props.title)}`,
      onClick: openTw(props.title),
      title: props.title,
    },
    React.createElement('span', { className: 'dsh-tw-toolcard-row-title' }, props.title),
    props.tags !== undefined && props.tags.length > 0
      ? React.createElement('span', { className: 'dsh-tw-toolcard-row-tags' }, props.tags.slice(0, 4).join(' · '))
      : null,
    typeof props.modified === 'string' && props.modified.length > 0
      ? React.createElement('span', { className: 'dsh-tw-toolcard-row-meta' }, props.modified)
      : null,
  )
}

function ListCard(props: {
  toolName: string
  title: string
  subtitle: string
  rows: readonly { title: string; tags?: readonly string[]; modified?: string | null; snippet?: string }[]
  fallbackText: string
}): React.ReactElement {
  const rows = props.rows.slice(0, 60)
  let body: React.ReactNode
  if (rows.length === 0) {
    body = React.createElement('div', { className: 'dsh-tw-toolcard-empty' }, props.fallbackText)
  } else {
    body = React.createElement(
      'div',
      { className: 'dsh-tw-toolcard-list' },
      ...rows.map((row, index) => React.createElement(HitRow, { key: `${row.title}-${index}`, ...row })),
    )
  }
  return React.createElement(ToolCardShell, { toolName: props.toolName, title: props.title, subtitle: props.subtitle }, body)
}

function SearchCard(props: { toolName: string; args: Record<string, unknown>; text: string }): React.ReactElement {
  const query = str(props.args.query)
  const params = new URLSearchParams()
  if (query.length > 0) params.set('query', query)
  if (Array.isArray(props.args.tags)) {
    for (const t of props.args.tags) if (typeof t === 'string' && t.length > 0) params.append('tags', t)
  }
  if (typeof props.args.tag === 'string' && props.args.tag.length > 0) params.set('tag', props.args.tag)
  if (typeof props.args.since === 'string' && props.args.since.length > 0) params.set('since', props.args.since)
  if (typeof props.args.type === 'string' && props.args.type.length > 0) params.set('type', props.args.type)
  if (typeof props.args.limit === 'number') params.set('limit', String(props.args.limit))
  const paramsKey = params.toString()
  const data = useAsync(() => fetchJson(`${SEARCH_ENDPOINT}?${paramsKey}`), [paramsKey])
  const payload = data.data
  const items = Array.isArray(payload?.items) ? (payload.items as Record<string, unknown>[]) : []
  const rows = items.map((item) => ({
    title: str(item.title),
    tags: Array.isArray(item.tags) ? (item.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [],
    modified: typeof item.modified === 'string' ? (item.modified as string) : null,
  }))
  const total = typeof payload?.total === 'number' ? (payload.total as number) : undefined
  const subtitle = `关键词「${query || '（全部）'}」${total !== undefined ? ` · 共 ${total} 条` : ''}`
  return React.createElement(ListCard, {
    toolName: props.toolName,
    title: query.length > 0 ? query : '检索',
    subtitle,
    rows,
    fallbackText: '没有匹配的笔记',
  })
}

function RecentCard(props: { toolName: string; args: Record<string, unknown>; text: string }): React.ReactElement {
  const params = new URLSearchParams()
  if (typeof props.args.limit === 'number') params.set('limit', String(props.args.limit))
  if (typeof props.args.since === 'string' && props.args.since.length > 0) params.set('since', props.args.since)
  const paramsKey = params.toString()
  const data = useAsync(() => fetchJson(`${RECENT_ENDPOINT}?${paramsKey}`), [paramsKey])
  const payload = data.data
  const items = Array.isArray(payload?.items) ? (payload.items as Record<string, unknown>[]) : []
  const rows = items.map((item) => ({
    title: str(item.title),
    tags: Array.isArray(item.tags) ? (item.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [],
    modified: typeof item.modified === 'string' ? (item.modified as string) : null,
  }))
  return React.createElement(ListCard, {
    toolName: props.toolName,
    title: '最近修改',
    subtitle: rows.length > 0 ? `最近 ${rows.length} 条` : '',
    rows,
    fallbackText: '暂无笔记',
  })
}

function BatchCard(props: { toolName: string; args: Record<string, unknown>; text: string }): React.ReactElement {
  const rawItems = Array.isArray(props.args.items) ? (props.args.items as unknown[]) : []
  const rows = rawItems
    .map((item): string | null => (typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).title === 'string' ? str((item as Record<string, unknown>).title) : null))
    .filter((t): t is string => t !== null && t.length > 0)
    .map((title) => ({ title }))
  return React.createElement(ListCard, {
    toolName: props.toolName,
    title: '批量写入',
    subtitle: rows.length > 0 ? `写入 ${rows.length} 篇` : '（参数中没有可解析的 items）',
    rows,
    fallbackText: '没有可展示的笔记',
  })
}

/* ── tags card ── */

function TagsCard(props: { toolName: string; text: string }): React.ReactElement {
  const data = useAsync(() => fetchJson(TAGS_ENDPOINT), [])
  const payload = data.data
  const items = Array.isArray(payload?.items) ? (payload.items as Record<string, unknown>[]) : []
  const chips = items.map((item) => ({
    tag: str(item.tag),
    count: typeof item.count === 'number' ? (item.count as number) : 0,
  }))
  let body: React.ReactNode
  if (chips.length === 0) {
    body = React.createElement('div', { className: 'dsh-tw-toolcard-empty' }, '暂无标签')
  } else {
    body = React.createElement(
      'div',
      { className: 'dsh-tw-toolcard-tags-wrap' },
      ...chips.map((chip) =>
        React.createElement(
          'span',
          { className: 'dsh-tw-toolcard-tag', key: chip.tag },
          `${chip.tag} · ${chip.count}`,
        ),
      ),
    )
  }
  return React.createElement(ToolCardShell, { toolName: props.toolName, title: '标签', subtitle: `共 ${chips.length} 个` }, body)
}

/* ── git / delete cards (no native render — show the model-visible text) ── */

function GitCard(props: { toolName: string; text: string }): React.ReactElement {
  const body = props.text.trim().length > 0
    ? React.createElement('pre', { className: 'dsh-tw-toolcard-fallback' }, props.text)
    : React.createElement('div', { className: 'dsh-tw-toolcard-empty' }, '（无结果）')
  return React.createElement(ToolCardShell, { toolName: props.toolName }, body)
}

function DeleteCard(props: { toolName: string; title: string; text: string }): React.ReactElement {
  const body = props.title.length > 0
    ? React.createElement('div', { className: 'dsh-tw-toolcard-empty' }, `已删除 tiddler「${props.title}」`)
    : React.createElement('pre', { className: 'dsh-tw-toolcard-fallback' }, props.text || '（已删除）')
  return React.createElement(ToolCardShell, { toolName: props.toolName, title: props.title.length > 0 ? props.title : undefined }, body)
}

/* ── top-level dispatcher ── */

/** A title for the card header, where the tool has one. */
function headerTitle(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'tiddlywiki_get':
    case 'tiddlywiki_put':
    case 'tiddlywiki_delete':
      return str(args.title)
    case 'tiddlywiki_rename':
      return str(args.newTitle)
    case 'tiddlywiki_search':
      return str(args.query)
    case 'tiddlywiki_recent':
    case 'tiddlywiki_list_tags':
    case 'tiddlywiki_batch_put':
    case 'tiddlywiki_git_sync':
    case 'tiddlywiki_git_resolve':
      return ''
    default:
      return ''
  }
}

/** The one component registered under every `tiddlywiki_*` toolview key. */
export function TiddlywikiToolView(props: ToolCallOwnerProps): React.ReactNode {
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
      React.createElement('pre', { className: 'dsh-tw-toolcard-fallback' }, text || '（无调用信息）'),
    )
  }

  if (!settled) {
    return React.createElement(
      ToolCardShell,
      { toolName: name, title: headerTitle(name, args) },
      React.createElement('div', { className: 'dsh-tw-toolcard-pending' }, '处理中…'),
    )
  }

  if (block.isError === true) {
    return React.createElement(
      ToolCardShell,
      { toolName: name, title: headerTitle(name, args) },
      React.createElement('div', { className: 'dsh-tw-toolcard-error' }, text || '工具调用失败'),
    )
  }

  switch (name) {
    case 'tiddlywiki_get':
      return React.createElement(TiddlerBodyCard, { toolName: name, title: str(args.title), subtitle: '读取' })
    case 'tiddlywiki_put':
      return React.createElement(TiddlerBodyCard, { toolName: name, title: str(args.title), subtitle: '已写入' })
    case 'tiddlywiki_rename':
      return React.createElement(TiddlerBodyCard, { toolName: name, title: str(args.newTitle), subtitle: `已重命名「${str(args.oldTitle)}」→` })
    case 'tiddlywiki_delete':
      return React.createElement(DeleteCard, { toolName: name, title: str(args.title), text })
    case 'tiddlywiki_batch_put':
      return React.createElement(BatchCard, { toolName: name, args, text })
    case 'tiddlywiki_search':
      return React.createElement(SearchCard, { toolName: name, args, text })
    case 'tiddlywiki_recent':
      return React.createElement(RecentCard, { toolName: name, args, text })
    case 'tiddlywiki_list_tags':
      return React.createElement(TagsCard, { toolName: name, text })
    case 'tiddlywiki_git_sync':
    case 'tiddlywiki_git_resolve':
      return React.createElement(GitCard, { toolName: name, text })
    default:
      return React.createElement(
        ToolCardShell,
        { toolName: name, title: headerTitle(name, args) },
        React.createElement('pre', { className: 'dsh-tw-toolcard-fallback' }, text || '（完成）'),
      )
  }
}

/** All `tiddlywiki_*` wire tool names the keyed slot should own. */
export const TOOL_VIEW_KEYS: readonly string[] = [
  'tiddlywiki_get',
  'tiddlywiki_search',
  'tiddlywiki_recent',
  'tiddlywiki_list_tags',
  'tiddlywiki_put',
  'tiddlywiki_batch_put',
  'tiddlywiki_rename',
  'tiddlywiki_delete',
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

/**
 * Document-level click interceptor (capture, additive): any anchor whose href
 * is the same-origin TW proxy hash (`/dsh-tiddlywiki/tw/#<title>`) — the agent
 * convention `[标题](/dsh-tiddlywiki/tw/#标题)` and the links inside render
 * fragments — opens the center TW panel at that tiddler instead of navigating
 * the DSH page. Returns a disposer.
 */
export function installWikiLinkInterceptor(): () => void {
  const onDocumentClick = (event: MouseEvent): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const anchor = target.closest('a')
    if (anchor === null) return
    const href = anchor.getAttribute('href') ?? ''
    const match = href.match(/^\/dsh-tiddlywiki\/tw\/#(.+)$/)
    if (match === null || match[1] === undefined) return
    event.preventDefault()
    event.stopPropagation()
    let title = match[1]
    try {
      title = decodeURIComponent(title)
    } catch {
      /* keep the raw hash when decoding fails */
    }
    openTiddler(title)
  }
  document.addEventListener('click', onDocumentClick, true)
  return () => document.removeEventListener('click', onDocumentClick, true)
}

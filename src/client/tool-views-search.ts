/**
 * Search / recent / batch list cards (v0.30.14 split of `tool-views.ts`).
 *
 * The search card is the one with real logic: it must send the host the SAME
 * filters the agent tool was given, including the workspace scope it read out of
 * the model-visible receipt — otherwise the card lists a different (larger)
 * result set than the model saw (v0.25.0).
 *
 * @module dsh-tiddlywiki/client/tool-views-search
 */
import * as React from 'react'
import { t } from './i18n.ts'
import { RECENT_ENDPOINT, SEARCH_ENDPOINT, withWikiQuery } from './endpoints.ts'
import { fetchJsonOrNull, useAsync, useInvalidateBodies } from './tool-views-fetch.ts'
import { ListCard } from './tool-views-body.ts'
import { useScopedWikiId } from './tool-views-shell.ts'
import { str } from './tool-views-types.ts'

/**
 * The workspace scope the agent tool reported in its model-visible receipt
 * (v0.25.0). `tiddlywiki_search` narrows to the session's workspace and says so
 * in the rendered text; the reply-stream card used to call `/search` WITHOUT
 * that scope, so it listed a different (larger) result set than the model saw.
 * Echoing the id back lets the route reproduce the tool's exact behaviour
 * (including the widen-when-empty fallback).
 *
 * The prefix literal must stay in sync with `WORKSPACE_TAG_PREFIX`
 * (src/host/workspace.ts) — `scripts/verify-tool-views.mjs` asserts that.
 */
const WORKSPACE_TAG_PREFIX = 'ws/'

function receiptWorkspace(text: string): string | null {
  // Matches both shapes: 「已在工作区 ws/<id> 内缩小范围」 and
  // 「工作区 ws/<id> 内 0 条，已扩大到全库」.
  const m = /工作区\s+(ws\/[^\s（(]+)/.exec(text)
  if (m === null || m[1] === undefined) return null
  const id = m[1].slice(WORKSPACE_TAG_PREFIX.length)
  return id.length > 0 ? id : null
}

export function SearchCard(props: { toolName: string; args: Record<string, unknown>; text: string }): React.ReactElement {
  const query = str(props.args.query)
  const params = new URLSearchParams()
  if (query.length > 0) params.set('query', query)
  if (Array.isArray(props.args.tags)) {
    for (const t of props.args.tags) if (typeof t === 'string' && t.length > 0) params.append('tags', t)
  }
  if (typeof props.args.tag === 'string' && props.args.tag.length > 0) params.set('tag', props.args.tag)
  if (typeof props.args.since === 'string' && props.args.since.length > 0) params.set('since', props.args.since)
  if (typeof props.args.type === 'string' && props.args.type.length > 0) params.set('type', props.args.type)
  // Custom-field filter (v0.20.0): must be forwarded, otherwise the card lists
  // unfiltered hits while the tool actually filtered by `field`/`value`.
  if (typeof props.args.field === 'string' && props.args.field.length > 0) params.set('field', props.args.field)
  if (typeof props.args.value === 'string' && props.args.value.length > 0) params.set('value', props.args.value)
  if (typeof props.args.limit === 'number') params.set('limit', String(props.args.limit))
  // Workspace scope (v0.25.0) — see receiptWorkspace above.
  const workspace = receiptWorkspace(props.text)
  if (workspace !== null) params.set('workspace', workspace)
  const paramsKey = params.toString()
  const wikiId = useScopedWikiId()
  // wikiId 要进依赖：scope 解析完成后再取一次，而不是把默认库的结果留在屏上。
  const data = useAsync(() => fetchJsonOrNull(withWikiQuery(`${SEARCH_ENDPOINT}?${paramsKey}`, wikiId)), [paramsKey, wikiId])
  const payload = data.data
  const items = Array.isArray(payload?.items) ? (payload.items as Record<string, unknown>[]) : []
  const rows = items.map((item) => ({
    title: str(item.title),
    tags: Array.isArray(item.tags) ? (item.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [],
    modified: typeof item.modified === 'string' ? (item.modified as string) : null,
    snippet: typeof item.snippet === 'string' ? (item.snippet as string) : '',
  }))
  const total = typeof payload?.total === 'number' ? (payload.total as number) : undefined
  const payloadWorkspace = typeof payload?.workspace === 'string' && payload.workspace.length > 0 ? payload.workspace : null
  let scopeNote = ''
  if (payloadWorkspace !== null && payload?.scope === 'workspace') {
    scopeNote = t('card.scopeNarrowed', { prefix: WORKSPACE_TAG_PREFIX, id: payloadWorkspace })
  } else if (payloadWorkspace !== null && payload?.fellBack === true) {
    scopeNote = t('card.scopeWidened', { prefix: WORKSPACE_TAG_PREFIX, id: payloadWorkspace })
  }
  const subtitle = `${t('card.queryLabel', { query: query || t('card.allQuery') })}${total !== undefined ? t('card.totalHits', { total }) : ''}${scopeNote}`
  return React.createElement(ListCard, {
    toolName: props.toolName,
    title: query.length > 0 ? query : t('card.searchTitle'),
    subtitle,
    rows,
    fallbackText: t('card.noMatches'),
  })
}

export function RecentCard(props: { toolName: string; args: Record<string, unknown> }): React.ReactElement {
  const params = new URLSearchParams()
  if (typeof props.args.limit === 'number') params.set('limit', String(props.args.limit))
  if (typeof props.args.since === 'string' && props.args.since.length > 0) params.set('since', props.args.since)
  const paramsKey = params.toString()
  const wikiId = useScopedWikiId()
  const data = useAsync(() => fetchJsonOrNull(withWikiQuery(`${RECENT_ENDPOINT}?${paramsKey}`, wikiId)), [paramsKey, wikiId])
  const payload = data.data
  const items = Array.isArray(payload?.items) ? (payload.items as Record<string, unknown>[]) : []
  const rows = items.map((item) => ({
    title: str(item.title),
    tags: Array.isArray(item.tags) ? (item.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [],
    modified: typeof item.modified === 'string' ? (item.modified as string) : null,
    snippet: typeof item.snippet === 'string' ? (item.snippet as string) : '',
  }))
  return React.createElement(ListCard, {
    toolName: props.toolName,
    title: t('card.recentTitle'),
    subtitle: rows.length > 0 ? t('card.recentCount', { count: rows.length }) : '',
    rows,
    fallbackText: t('card.noNotes'),
  })
}

export function BatchCard(props: { toolName: string; args: Record<string, unknown> }): React.ReactElement {
  const rawItems = Array.isArray(props.args.items) ? (props.args.items as unknown[]) : []
  const rows = rawItems
    .map((item): string | null => (typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).title === 'string' ? str((item as Record<string, unknown>).title) : null))
    .filter((t): t is string => t !== null && t.length > 0)
    .map((title) => ({ title }))
  // 批量写入的标题在挂载时失效缓存（effect 阶段，见 useInvalidateBodies）。
  // wikiId 必须带上（v0.29.0）：缓存键是 `wikiId\0title`，只按标题清会留下
  // `A\0X`，之后同一篇的读取卡还能拿回被覆盖前的旧正文。
  useInvalidateBodies(rows.map((row) => row.title), useScopedWikiId())
  return React.createElement(ListCard, {
    toolName: props.toolName,
    title: t('card.toolBatchPut'),
    subtitle: rows.length > 0 ? t('card.batchCount', { count: rows.length }) : t('card.batchNoItems'),
    rows,
    fallbackText: t('card.batchEmpty'),
  })
}

/**
 * Native-rendered body card + the list primitives every list card builds on
 * (v0.30.14 split of `tool-views.ts`).
 *
 * `TiddlerBodyCard` fetches one tiddler and renders it through the HOST render
 * route (never TW's raw `/tw/render`), so the fragment that reaches
 * `dangerouslySetInnerHTML` has been through the whitelist sanitizer.
 * `HitRow` / `ListCard` are the shared shape of search / recent / batch results.
 *
 * @module dsh-tiddlywiki/client/tool-views-body
 */
import * as React from 'react'
import { t } from './i18n.ts'
import { GET_ENDPOINT, TW_PROXY_BASE, twProxyFor, withWikiQuery } from './endpoints.ts'
import {
  fetchJsonOrNull,
  fetchRender,
  invalidateBodyCache,
  readBodyCache,
  useAsync,
  writeBodyCache,
} from './tool-views-fetch.ts'
import { ToolCardShell, openTw, useScopedWikiId } from './tool-views-shell.ts'

/* ── tiddler card (get / put / rename): native-rendered body ── */

export function TiddlerBodyCard(props: { toolName: string; title: string; subtitle: string; fresh?: boolean }): React.ReactElement {
  const { title, fresh } = props
  const wikiId = useScopedWikiId()
  const both = useAsync(
    async () => {
      // 写入类卡片的 loader 先失效缓存（effect 阶段执行），保证看到最新正文。
      if (fresh === true) invalidateBodyCache(title, wikiId)
      const cached = readBodyCache(wikiId, title)
      if (cached !== undefined) return { get: cached.get, html: cached.html }
      const [get, html] = await Promise.all([
        fetchJsonOrNull(withWikiQuery(`${GET_ENDPOINT}?title=${encodeURIComponent(title)}`, wikiId)),
        fetchRender(title, wikiId),
      ])
      // 只缓存「渲染成功」的结果：服务不可用 / 条目不存在 / 渲染降级这类瞬时或
      // 失败态不缓存，重新挂载时照常重试（否则一次抖动会被缓存 5 分钟）。
      if (typeof html === 'string' && html.length > 0) writeBodyCache(wikiId, title, { get, html })
      return { get, html }
    },
    // wikiId 必须在依赖里：scope 解析完成（undefined → 某个库）后要重新取数，
    // 否则卡片会一直显示「默认库」那份内容（v0.28.8）。
    [title, fresh, wikiId],
  )
  const { loading, data } = both
  const get = data?.get ?? null
  const html = data?.html ?? null

  let body: React.ReactNode
  if (loading) {
    body = React.createElement('div', { className: 'dsh-tw-toolcard-loading' }, t('card.rendering'))
  } else if (get !== null && get.notFound === true) {
    body = React.createElement('div', { className: 'dsh-tw-toolcard-empty' }, t('card.tiddlerMissing', { title }))
  } else if (typeof html === 'string' && html.length > 0) {
    body = React.createElement('div', {
      className: 'dsh-tw-toolcard-native',
      dangerouslySetInnerHTML: { __html: html },
    })
  } else if (get !== null && typeof get.text === 'string' && get.text.length > 0) {
    // Native render unavailable (wiki up but route missing) → raw text.
    body = React.createElement('pre', { className: 'dsh-tw-toolcard-fallback' }, get.text)
  } else {
    body = React.createElement('div', { className: 'dsh-tw-toolcard-empty' }, t('card.serviceUnavailable'))
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
      onOpen: openTw(title, wikiId),
      foot: modified !== undefined ? t('card.modifiedAt', { modified }) : undefined,
    },
    body,
  )
}

/* ── list cards (search / recent / batch) ── */

/** One list row: title, tags, modified stamp — and the match snippet.
 *
 *  `snippet` used to be declared but never read (v0.22.8): the route has shipped
 *  a per-hit context snippet since v0.19.0 precisely so a hit deep inside a long
 *  note is visible, and dropping it left the card showing only a title — the
 *  model-visible tool result (see tools.ts' render contract) carried more than
 *  the card did. It is rendered as a second line and only when non-empty. */
export function HitRow(props: { title: string; tags?: readonly string[]; modified?: string | null; snippet?: string }): React.ReactElement {
  const wikiId = useScopedWikiId()
  const meta = React.createElement(
    'span',
    { className: 'dsh-tw-toolcard-row-head' },
    React.createElement('span', { className: 'dsh-tw-toolcard-row-title' }, props.title),
    props.tags !== undefined && props.tags.length > 0
      ? React.createElement('span', { className: 'dsh-tw-toolcard-row-tags' }, props.tags.slice(0, 4).join(' · '))
      : null,
    typeof props.modified === 'string' && props.modified.length > 0
      ? React.createElement('span', { className: 'dsh-tw-toolcard-row-meta' }, props.modified)
      : null,
  )
  const snippet = typeof props.snippet === 'string' && props.snippet.trim().length > 0 ? props.snippet : null
  return React.createElement(
    'a',
    {
      className: 'dsh-tw-toolcard-row',
      // 多库下裸 TW_PROXY_BASE 是「默认库」的别名，点开就会打开错库（v0.28.8）。
      href: `${twProxyFor(wikiId === undefined ? undefined : 'multi', wikiId, TW_PROXY_BASE).relative}#${encodeURIComponent(props.title)}`,
      onClick: openTw(props.title, wikiId),
      title: snippet === null ? props.title : `${props.title}\n${snippet}`,
    },
    meta,
    snippet === null ? null : React.createElement('span', { className: 'dsh-tw-toolcard-row-snippet' }, snippet),
  )
}

export function ListCard(props: {
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

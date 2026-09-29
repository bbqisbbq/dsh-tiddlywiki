/**
 * The remaining cards (v0.30.14 split of `tool-views.ts`): attachment, tags, and
 * the two that have no native render at all (git / delete) so they simply show
 * the model-visible text.
 *
 * @module dsh-tiddlywiki/client/tool-views-misc
 */
import * as React from 'react'
import { t } from './i18n.ts'
import { TAGS_ENDPOINT, withWikiQuery } from './endpoints.ts'
import { fetchJsonOrNull, useAsync, useInvalidateBodies } from './tool-views-fetch.ts'
import { ToolCardShell, openTw, useScopedWikiId } from './tool-views-shell.ts'
import { str } from './tool-views-types.ts'

/**
 * Attachment card (v0.25.0): `tiddlywiki_attach` used to fall through to the
 * generic text card, so saving an image showed a receipt with no way to open it.
 * The binary payload is never inlined (the host withholds base64 on `/get`), so
 * the card offers the title + 「在 TW 打开」 instead.
 */
export function AttachCard(props: { toolName: string; title: string }): React.ReactElement {
  const wikiId = useScopedWikiId()
  const body = props.title.length > 0
    ? React.createElement('div', { className: 'dsh-tw-toolcard-empty' }, t('card.attachSavedRendered'))
    : React.createElement('div', { className: 'dsh-tw-toolcard-empty' }, t('card.attachSaved'))
  return React.createElement(ToolCardShell, {
    toolName: props.toolName,
    title: props.title.length > 0 ? props.title : undefined,
    ...(props.title.length > 0 ? { onOpen: openTw(props.title, wikiId) } : {}),
  }, body)
}

/** How many chips the card renders, and therefore how many the route returns
 *  (v0.19.4: `?limit=&sort=count` — a big wiki no longer ships every tag to
 *  the browser just so we can throw most of them away). */
const TAGS_CARD_LIMIT = 60

export function TagsCard(props: { toolName: string }): React.ReactElement {
  const wikiId = useScopedWikiId()
  const data = useAsync(
    () => fetchJsonOrNull(withWikiQuery(`${TAGS_ENDPOINT}?limit=${TAGS_CARD_LIMIT}&sort=count`, wikiId)),
    [wikiId],
  )
  const payload = data.data
  const items = Array.isArray(payload?.items) ? (payload.items as Record<string, unknown>[]) : []
  const chips = items.map((item) => ({
    tag: str(item.tag),
    count: typeof item.count === 'number' ? (item.count as number) : 0,
  }))
  // 服务端已按 limit 截断（并按使用次数排序），这里只兜底防御。
  const shown = chips.slice(0, TAGS_CARD_LIMIT)
  const total = typeof payload?.total === 'number' ? (payload.total as number) : chips.length
  let body: React.ReactNode
  if (chips.length === 0) {
    body = React.createElement('div', { className: 'dsh-tw-toolcard-empty' }, t('card.noTags'))
  } else {
    body = React.createElement(
      'div',
      { className: 'dsh-tw-toolcard-tags-wrap' },
      ...shown.map((chip) =>
        React.createElement(
          'span',
          { className: 'dsh-tw-toolcard-tag', key: chip.tag },
          `${chip.tag} · ${chip.count}`,
        ),
      ),
      ...(total > shown.length
        ? [React.createElement('span', { className: 'dsh-tw-toolcard-tag-more', key: '__more' }, t('card.tagsMore', { count: total - shown.length }))]
        : []),
    )
  }
  return React.createElement(ToolCardShell, { toolName: props.toolName, title: t('card.tagsTitle'), subtitle: t('card.tagsTotal', { total }) }, body)
}

/* ── git / delete cards (no native render — show the model-visible text) ── */

export function GitCard(props: { toolName: string; text: string }): React.ReactElement {
  const body = props.text.trim().length > 0
    ? React.createElement('pre', { className: 'dsh-tw-toolcard-fallback' }, props.text)
    : React.createElement('div', { className: 'dsh-tw-toolcard-empty' }, t('card.noResult'))
  return React.createElement(ToolCardShell, { toolName: props.toolName }, body)
}

export function DeleteCard(props: { toolName: string; title: string; text: string }): React.ReactElement {
  // 删除后同标题的缓存必须失效，否则紧跟着的读取卡会拿旧正文（effect 阶段执行）。
  // 同样必须带 wikiId（v0.29.0，理由见 BatchCard）。
  useInvalidateBodies([props.title], useScopedWikiId())
  const body = props.title.length > 0
    ? React.createElement('div', { className: 'dsh-tw-toolcard-empty' }, t('card.deletedTiddler', { title: props.title }))
    : React.createElement('pre', { className: 'dsh-tw-toolcard-fallback' }, props.text || t('card.deleted'))
  return React.createElement(ToolCardShell, { toolName: props.toolName, title: props.title.length > 0 ? props.title : undefined }, body)
}

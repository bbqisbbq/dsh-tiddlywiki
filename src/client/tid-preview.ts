/**
 * `.tid` / `.tiddler` 文件的侧栏预览（v0.32.0）。
 *
 * WHY
 * ---
 * wiki 文件夹本身就是一堆 `.tid` 文件（人用编辑器打开、Agent 用工具写）。DSH 的
 * 文件预览把未知扩展名当纯文本，于是打开一个 `.tid` 看到的是 `title: …` 字段行
 * 加原始 wikitext；而 TiddlyWiki 的语法（`[[链接]]`、`<<宏>>`、`$:/` 引用）在纯文本
 * 里几乎不可读。插件已经有一条**净化管道**（`POST /dsh-tiddlywiki/render`，铁律 #7
 * 要求所有 TW 注入都走它），正好把这段文本换成真 TW 渲染结果。
 *
 * 契约（2026-10-26 从宿主 `app.asar` 的
 * `dsh-client-ui-sidebar-documentpreview/lib/client.js` 逐行核实，见 docs/development.md）：
 *   · 元数据：`ctx.documentPreviews.register({ id, extensions, …, loading })`，
 *     **按 id 去重**，`binaryExtensions` 必须在 `extensions` 内；
 *   · 正文：以**同一个 id** 注入 keyed、Session 作用域的 `sidebar.right.tab.document`；
 *     正文拿到 `content: { kind: 'text', pages, text }`（`loading: 'text-pages'`）。
 *
 * NEVER A BLANK PANEL
 * -------------------
 * 正文的 props 是宿主内部契约，我们只用**显式可选链**读它：拿不到文本就显示"等待
 * 文件内容"，渲染失败就退回 `<pre>` 原文。**白屏是沉默失败**，这一条优先级高于"好看"。
 *
 * @module dsh-tiddlywiki/client/tid-preview
 */
import * as React from 'react'
import { t } from './i18n.ts'
import { RENDER_ENDPOINT, withWikiQuery } from './endpoints.ts'

import { parseTidText, TID_EXTENSIONS, TID_PREVIEW_ID, TID_PREVIEW_SLOT } from './tid-parse.ts'

// 纯逻辑住在 tid-parse.ts（宿主 barrel 也要导出它，而宿主包不能出现 react）。
export { parseTidText, TID_EXTENSIONS, TID_PREVIEW_ID, TID_PREVIEW_SLOT } from './tid-parse.ts'
export type { ParsedTid } from './tid-parse.ts'

/** 从预览正文的 props 里取文件文本（契约未公开，全部可选链）。 */
function textOf(props: unknown): string {
  const content = (props as { content?: { kind?: unknown; text?: unknown } } | undefined)?.content
  if (typeof content?.text === 'string') return content.text
  const raw = (props as { content?: unknown } | undefined)?.content
  return typeof raw === 'string' ? raw : ''
}

/** 把一段 wikitext 换成宿主**净化过**的 HTML；失败回 null（调用方退回原文）。 */
export async function renderTidHtml(text: string, wikiId?: string): Promise<string | null> {
  try {
    const res = await fetch(withWikiQuery(RENDER_ENDPOINT, wikiId), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'TiddlyWiki' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const html = await res.text()
    return html.trim().length > 0 ? html : null
  } catch {
    return null
  }
}

/** 正文组件。**任何一步失败都退回 `<pre>` 原文**，绝不渲染空白面板。 */
export function createTidPreviewBody(): (props: unknown) => React.ReactElement {
  return function TidPreviewBody(props: unknown): React.ReactElement {
    const raw = textOf(props)
    const parsed = React.useMemo(() => parseTidText(raw), [raw])
    const [html, setHtml] = React.useState<string | null>(null)
    const [failed, setFailed] = React.useState(false)

    React.useEffect(() => {
      let alive = true
      setFailed(false)
      if (parsed.text.trim().length === 0) {
        setHtml(null)
        return () => { alive = false }
      }
      void renderTidHtml(parsed.text).then((next) => {
        if (!alive) return
        if (next === null) {
          setFailed(true)
          setHtml(null)
        } else {
          setHtml(next)
        }
      })
      return () => { alive = false }
    }, [parsed.text])

    const head: React.ReactElement[] = []
    if (parsed.title !== undefined && parsed.title.length > 0) {
      head.push(React.createElement('div', { key: 'title', className: 'dsh-tw-tid-title' }, `📄 ${parsed.title}`))
    }
    if (parsed.fields.length > 0) {
      head.push(
        React.createElement(
          'div',
          { key: 'fields', className: 'dsh-tw-tid-fields' },
          parsed.fields.map(([key, value]) => React.createElement('span', { key, className: 'dsh-tw-tid-field' }, `${key}: ${value.length > 60 ? `${value.slice(0, 60)}…` : value}`)),
        ),
      )
    }

    let body: React.ReactElement
    if (raw.trim().length === 0) {
      body = React.createElement('div', { className: 'dsh-tw-tid-empty' }, t('frame.tidPreviewWaiting'))
    } else if (parsed.text.trim().length === 0) {
      body = React.createElement('div', { className: 'dsh-tw-tid-empty' }, t('frame.tidPreviewNoBody'))
    } else if (html !== null) {
      // 来自宿主 `POST /render`，已过 sanitize.ts（铁律 #7）。
      body = React.createElement('div', { className: 'dsh-tw-tid-body', dangerouslySetInnerHTML: { __html: html } })
    } else {
      // 正在渲染、或渲染失败：**原文兜底**（失败时附一句说明）。
      body = React.createElement(
        'div',
        { className: 'dsh-tw-tid-raw' },
        failed ? React.createElement('div', { className: 'dsh-tw-tid-note' }, t('frame.tidPreviewFallback')) : null,
        React.createElement('pre', null, parsed.text),
      )
    }

    return React.createElement('div', { className: 'dsh-tw-tid-preview' }, ...head, body)
  }
}

/** 宿主侧 `ctx.documentPreviews` 的结构面（不 import @deepseek-ai）。 */
interface DocumentPreviewsFace {
  register(definition: {
    id: string
    extensions: string[]
    binaryExtensions?: string[]
    priority?: number
    title?: string
    loading?: 'text-pages' | 'bytes-complete' | 'renderer'
    wrap?: boolean
  }): () => void
}

/** 我们需要的 ctx 片段：`get`（可选服务）与 `slots`。 */
interface PreviewCtx {
  get?: (name: string) => unknown
  slots?: {
    inject(name: string, register: () => unknown): (() => void) | undefined
    register(opts: { name: string; id: string }, component: unknown): (() => void) | undefined
  }
}

/**
 * 注册 `.tid` 预览（元数据 + 正文**成对**）。
 *
 * 宿主没有 `documentPreviews` 服务时**什么都不做**（老版本 DSH 不受影响）。
 * 任何一步抛错都只记日志并回滚已注册的那一半 —— 单边注册会让宿主按 id 找不到正文。
 */
export function registerTidPreview(ctx: PreviewCtx): Array<() => void> {
  const disposers: Array<() => void> = []
  const previews = ctx.get?.('documentPreviews') as DocumentPreviewsFace | undefined
  if (previews === undefined) return disposers
  try {
    disposers.push(
      previews.register({
        id: TID_PREVIEW_ID,
        extensions: [...TID_EXTENSIONS],
        priority: 100,
        title: t('frame.tidPreviewTitle'),
        loading: 'text-pages',
      }),
    )
  } catch (err) {
    // 开发者日志，不是用户文案（与仓库其它模块的 console.warn 同一性质）。
    console.warn('[dsh-tiddlywiki] tid preview registration failed:', err)
    return disposers
  }
  const slots = ctx.slots
  if (slots === undefined) {
    // 元数据已注册但没有正文 → 宿主会拿不到渲染器，宁可整体撤回。
    for (const dispose of disposers.splice(0)) dispose()
    return disposers
  }
  const bodyDispose = slots.inject(TID_PREVIEW_SLOT, () =>
    slots.register({ name: TID_PREVIEW_SLOT, id: TID_PREVIEW_ID }, createTidPreviewBody()),
  )
  if (bodyDispose !== undefined) disposers.push(bodyDispose)
  return disposers
}

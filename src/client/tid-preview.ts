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
 *   · 元数据：`ctx.documentPreviews.register({ id, extensions, priority, title, loading, wrap })`，
 *     **按 id 去重**，`binaryExtensions` 必须在 `extensions` 内；
 *     `priority` 是**字符串**（宿主只判 `=== 'builtin' ? 0 : 1`，非 builtin 压过内置）；
 *     `title` 宿主自己传的是**函数**；`wrap` 表示是否按纯文本换行（我们要 HTML，用 false）。
 *   · 正文：注入 keyed、Session 作用域的 `sidebar.right.tab.document`，**按 `key` 配对**：
 *     `ctx.slots.register({ name: 'sidebar.right.tab.document', key: <与元数据同一个 id> }, Body)`。
 *     ⚠️ 用 `id` 而不是 `key` 会**静默退化成内置纯文本**（v0.32.0 的实际症状）。
 *   · 正文 props：`{ content, useTabInfo, … }`，`loading: 'text-pages'` 时
 *     `content = { kind: 'text', pages }`，每页 `{ offset, lines, text }`。
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

/**
 * 从正文 props 里取文件文本。
 *
 * `loading: 'text-pages'` 时宿主给的是 `content = { kind: 'text', pages }`，每页是
 * `{ offset, lines, text }`（见宿主 `documentpreview/lib/client.js` 的 `linesOf`）。
 * `pages` 既可能是数组、也可能是 `{ offset: page }` 记录，所以两种都收；
 * 另外也支持更简单的 `content.text`（某些加载模式直接给整段）。
 */
function textOf(props: unknown): string {
  const content = (props as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content
  if (content === null || typeof content !== 'object') return ''
  const bag = content as { text?: unknown; pages?: unknown }
  if (typeof bag.text === 'string') return bag.text
  const rawPages = bag.pages
  const list: Array<{ offset: number; text: string }> = []
  if (Array.isArray(rawPages)) {
    for (const page of rawPages) {
      if (page !== null && typeof page === 'object') {
        const p = page as { offset?: unknown; text?: unknown }
        list.push({ offset: typeof p.offset === 'number' ? p.offset : 0, text: typeof p.text === 'string' ? p.text : '' })
      }
    }
  } else if (rawPages !== null && typeof rawPages === 'object') {
    for (const [offset, page] of Object.entries(rawPages as Record<string, unknown>)) {
      if (page !== null && typeof page === 'object') {
        const p = page as { text?: unknown }
        list.push({ offset: Number(offset) || 0, text: typeof p.text === 'string' ? p.text : '' })
      }
    }
  }
  return list.sort((a, b) => a.offset - b.offset).map((p) => p.text).join('')
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

    return React.createElement('div', { className: 'dsh-tw-tid-preview', 'data-dsh-tw-tid': TID_PREVIEW_ID }, ...head, body)
  }
}

/** 宿主侧 `ctx.documentPreviews` 的结构面（不 import @deepseek-ai）。 */
interface DocumentPreviewsFace {
  register(definition: {
    id: string
    extensions: string[]
    binaryExtensions?: string[]
    /**
     * **字符串**，不是数字：宿主只判 `priority === 'builtin' ? 0 : 1`，
     * rank 高的先命中，也就是「非 builtin（外部实现）压过内置」。宿主内置的
     * 纯文本/Markdown 都是 `'builtin'`，所以我们要声明 `'external'`。
     */
    priority?: 'builtin' | 'external'
    /** 展示名。宿主自己的实现传的是**函数**（`() => t('viewer.text')`），照抄。 */
    title?: string | (() => string)
    loading?: 'text-pages' | 'bytes-complete' | 'renderer'
    wrap?: boolean
  }): () => void
}

/** 我们需要的 ctx 片段：`get`（可选服务）与 `slots`。 */
interface PreviewCtx {
  get?: (name: string) => unknown
  slots?: {
    inject(name: string, register: () => unknown): (() => void) | undefined
    /**
     * keyed 子槽按 **`key`** 配对（宿主写的是 `register({ name, key: BODY_ID }, C)`）——
     * 不是 `id`。用 `id` 会静默退化成内置纯文本，正是 v0.32.0 的实际症状。
     */
    register(opts: { name: string; key: string }, component: unknown): (() => void) | undefined
  }
}

/**
 * 注册 `.tid` 预览（元数据 + 正文**成对**）。
 *
 * 为什么要「等」而不是查一次：`documentPreviews` 是**另一个插件**（宿主的
 * `dsh-client-ui-sidebar-documentpreview`）用 `ctx.reflect.provide('documentPreviews', …)`
 * 提供的。如果本插件先加载，`ctx.get('documentPreviews')` 那一刻还是 `undefined` ——
 * v0.32/0.33.0 就是在这里**静默放弃**的（用户看到的仍是内置纯文本，console 里
 * 一条日志都没有，排查成本极高）。现在改成**短轮询**（250ms × 40 ≈ 10s）：
 * 服务一出现就注册；始终没出现才记一条 warn 说明原因。
 *
 * 诊断日志都带 `[dsh-tiddlywiki]` 前缀，方便在 devtools 里一眼认出是我们的。
 */
export function registerTidPreview(ctx: PreviewCtx): Array<() => void> {
  const disposers: Array<() => void> = []
  const getter = typeof ctx.get === 'function' ? ctx.get.bind(ctx) : undefined
  console.info('[dsh-tiddlywiki] tid preview: ctx.get=' + (getter === undefined ? 'missing' : 'present') + ', ctx.slots=' + (ctx.slots === undefined ? 'missing' : 'present'))
  if (getter === undefined) {
    // 没有服务读取器 ⇒ 这个宿主版本给不了 documentPreviews，按设计跳过。
    return disposers
  }

  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let done = false

  const attempt = (): void => {
    if (done) return
    attempts += 1
    const previews = getter('documentPreviews') as DocumentPreviewsFace | undefined
    if (previews === undefined || previews === null) {
      if (attempts >= 40) {
        console.warn('[dsh-tiddlywiki] tid preview: documentPreviews 服务始终没出现（尝试 ' + attempts + ' 次），.tid 将显示内置纯文本')
        return
      }
      timer = setTimeout(attempt, 250)
      return
    }
    done = true
    try {
      disposers.push(
        previews.register({
          id: TID_PREVIEW_ID,
          extensions: [...TID_EXTENSIONS],
          // 外部实现压过宿主的纯文本兜底（宿主按 `priority === 'builtin'` 分档）。
          priority: 'external',
          // 宿主自己传的是函数（`) => t('viewer.text')`），语言切换时能重取。
          title: () => t('frame.tidPreviewTitle'),
          loading: 'text-pages',
          wrap: false,
        }),
      )
      console.info('[dsh-tiddlywiki] tid preview: 元数据已注册（第 ' + attempts + ' 次尝试）id=' + TID_PREVIEW_ID + ' 后缀=' + TID_EXTENSIONS.join('/'))
    } catch (err) {
      // 开发者日志，不是用户文案（与仓库其它模块的 console.warn 同一性质）。
      console.warn('[dsh-tiddlywiki] tid preview registration failed:', err)
      return
    }
    const slots = ctx.slots
    if (slots === undefined) {
      // 元数据已注册但没有正文 → 宿主会拿不到渲染器，宁可整体撤回。
      console.warn('[dsh-tiddlywiki] tid preview: 没有 ctx.slots，撤回元数据')
      for (const dispose of disposers.splice(0)) dispose()
      return
    }
    const bodyDispose = slots.inject(TID_PREVIEW_SLOT, () =>
      slots.register({ name: TID_PREVIEW_SLOT, key: TID_PREVIEW_ID }, createTidPreviewBody()),
    )
    if (bodyDispose === undefined) console.warn('[dsh-tiddlywiki] tid preview: 正文注册失败（slot ' + TID_PREVIEW_SLOT + '）')
    else {
      disposers.push(bodyDispose)
      console.info('[dsh-tiddlywiki] tid preview: 正文已注册到 ' + TID_PREVIEW_SLOT + ' key=' + TID_PREVIEW_ID)
    }
  }

  attempt()
  // 清理：停掉还在等服务的定时器 + 回收已注册的两半。
  return [
    () => {
      done = true
      if (timer !== undefined) clearTimeout(timer)
      for (const dispose of disposers.splice(0)) dispose()
    },
  ]
}

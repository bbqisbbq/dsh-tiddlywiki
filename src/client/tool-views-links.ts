/**
 * The TW-proxy path matcher + the document-level link interceptor (v0.30.14
 * split of `tool-views.ts`).
 *
 * Any anchor pointing at the same-origin TW proxy with a title in its hash — the
 * agent convention `[标题](/dsh-tiddlywiki/tw/#标题)` and the links inside render
 * fragments — must open the CENTER TW panel at that tiddler instead of navigating
 * the DSH page, and it must open the RIGHT knowledge base.
 *
 * @module dsh-tiddlywiki/client/tool-views-links
 */
import { TW_PROXY_BASE } from './endpoints.ts'
import { openTiddler } from './panel.ts'

/**
 * Recognise a TW proxy pathname and report the wiki it targets (v0.28.8).
 *
 * `undefined` = the bare `/dsh-tiddlywiki/tw/` (the default-wiki alias, which is
 * what agents' `[标题](/dsh-tiddlywiki/tw/#标题)` links use). A string = the id in
 * `/dsh-tiddlywiki/tw/<id>/`. `null` = not a TW proxy path at all.
 */
export function matchTwProxyPath(pathname: string): string | undefined | null {
  if (pathname === TW_PROXY_BASE) return undefined
  if (!pathname.startsWith(TW_PROXY_BASE)) return null
  const rest = pathname.slice(TW_PROXY_BASE.length)
  // `/tw/<id>/` — the id is a single path segment (the host validates its
  // charset), so anything with another slash is not a wiki route.
  if (!rest.endsWith('/')) return null
  const id = rest.slice(0, -1)
  if (id.length === 0 || id.includes('/')) return null
  try {
    return decodeURIComponent(id)
  } catch {
    return id
  }
}

/**
 * Document-level click interceptor (capture, additive): any anchor whose href
 * is the same-origin TW proxy hash (`/dsh-tiddlywiki/tw/#<title>`) — the agent
 * convention `[标题](/dsh-tiddlywiki/tw/#标题)` and the links inside render
 * fragments — opens the center TW panel at that tiddler instead of navigating
 * the DSH page. Returns a disposer.
 *
 * The href may be RELATIVE (`/dsh-tiddlywiki/tw/#标题`, what agents/tools emit)
 * or ABSOLUTE (`https://host/dsh-tiddlywiki/tw/#标题`, what the DSH web app's
 * markdown renderer resolves to before classifying http(s) links as "external"
 * and giving them its own `target="_blank"` + `openExternalLink` onClick). Both
 * must be matched, otherwise the click falls through to DSH's external-link
 * handler and the note opens in a new browser tab instead of the TW panel.
 *
 * The knowledge base comes from the LINK when it names one (`/tw/<id>/`), else
 * from the enclosing card's `data-dsh-tw-wiki` (v0.28.11) — a bare `/tw/` is
 * the default-wiki alias, and following it would open the wrong library.
 */
export function installWikiLinkInterceptor(): () => void {
  const onDocumentClick = (event: MouseEvent): void => {
    // 只接管「普通左键点击」：中键 / Ctrl(⌘)·Shift·Alt+点击是浏览器的新标签页、
    // 新窗口、下载等语义，一律放行（否则无法新标签页打开、无法复制链接）。
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const target = event.target
    if (!(target instanceof Element)) return
    const anchor = target.closest('a')
    if (anchor === null) return
    const href = anchor.getAttribute('href') ?? ''
    // Resolve relative AND absolute hrefs against the current origin, then only
    // take same-origin links to the TW proxy whose hash carries a title.
    //
    // Two path shapes must match (v0.28.8): the bare `/dsh-tiddlywiki/tw/`
    // (single-wiki installs and the default-wiki alias, what agents emit) AND
    // the per-wiki `/dsh-tiddlywiki/tw/<id>/` our multi-wiki cards now link to.
    // Matching only the bare form would send a multi-wiki click to DSH's
    // external-link handler — i.e. a new browser tab instead of the TW panel.
    let title: string | null = null
    let wiki: string | undefined
    try {
      const url = new URL(href, window.location.origin)
      if (url.origin === window.location.origin && url.hash.length > 1) {
        const parsed = matchTwProxyPath(url.pathname)
        if (parsed !== null) {
          title = url.hash.substring(1)
          // 裸 `/tw/` 解析出 undefined = 「链接没写库」（Agent 正文里的
          // `[标题](/dsh-tiddlywiki/tw/#标题)` 就是这样），下面再拿所在卡片的
          // 作用域补上；`/tw/<id>/` 则是明确答案。
          wiki = parsed
        }
      }
    } catch {
      /* not a parseable URL — leave for the browser's default handling */
    }
    if (title === null) return
    event.preventDefault()
    event.stopPropagation()
    try {
      title = decodeURIComponent(title)
    } catch {
      /* keep the raw hash when decoding fails */
    }
    // 没写库的链接跟随**所在卡片**的库（v0.28.11）：卡片正文是原生片段，里面的
    // 链接一律是裸路径（render bundle 只认 `/tw/#$uri_encoded$`），照裸路径走就等于
    // 「默认库」，会把已作用域到别的库的卡片开到默认库去（打不开或打开同名条目）。
    // 卡片外（助手正文里的链接）仍按未指定处理：没有可信答案时跟随焦点库最好。
    if (wiki === undefined) {
      const card = anchor.closest('[data-dsh-tw-wiki]')
      const attr = card?.getAttribute('data-dsh-tw-wiki')
      if (typeof attr === 'string' && attr.length > 0) wiki = attr
    }
    openTiddler(title, wiki)
  }
  document.addEventListener('click', onDocumentClick, true)
  return () => document.removeEventListener('click', onDocumentClick, true)
}

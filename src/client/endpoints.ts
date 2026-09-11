/**
 * Same-origin DSH endpoints the client calls. The authoritative route table
 * lives in src/host/routes.ts (see AGENTS.md §1「DSH 路由」) — this is just the
 * client-side mirror, so the path string exists once per endpoint instead of
 * being re-typed in every widget.
 *
 * @module dsh-tiddlywiki/client/endpoints
 */
export const STATUS_ENDPOINT = '/dsh-tiddlywiki/status'
export const GET_ENDPOINT = '/dsh-tiddlywiki/get'
/**
 * Render endpoint (v0.19.1): the HOST route, **not** TW's `/tw/render`.
 * The host proxies to TW and sanitizes the fragment; the reply-stream tool card
 * and the session summary tab inject it with `dangerouslySetInnerHTML` inside
 * the DSH page, so raw TW output must never reach the browser.
 */
export const RENDER_ENDPOINT = '/dsh-tiddlywiki/render'

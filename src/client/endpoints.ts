/**
 * Same-origin DSH endpoints the client calls. The authoritative route table
 * lives in src/host/routes.ts + src/host/admin.ts (see AGENTS.md §1「DSH 路由」)
 * — this module is the single client-side mirror, so each path literal exists
 * exactly once instead of being re-typed per widget (v0.20.0: the previous
 * three-endpoint version had already drifted, with TAGS/RECENT/SYNC/RESTART/GET
 * re-declared in eight other modules).
 *
 * @module dsh-tiddlywiki/client/endpoints
 */

/** Host route prefix (mirrors PATH_PREFIX in src/host/wiki.ts). */
export const ROUTE_PREFIX = '/dsh-tiddlywiki'

/** Same-origin TW proxy base (mirrors TW_PROXY_PATH in src/host/wiki.ts). */
export const TW_PROXY_BASE = `${ROUTE_PREFIX}/tw/`

export const STATUS_ENDPOINT = `${ROUTE_PREFIX}/status`
export const GET_ENDPOINT = `${ROUTE_PREFIX}/get`
/**
 * Render endpoint (v0.19.1): the HOST route, **not** TW's `/tw/render`.
 * The host proxies to TW and sanitizes the fragment; the reply-stream tool card
 * and the session summary tab inject it with `dangerouslySetInnerHTML` inside
 * the DSH page, so raw TW output must never reach the browser.
 */
export const RENDER_ENDPOINT = `${ROUTE_PREFIX}/render`
export const NOTE_ENDPOINT = `${ROUTE_PREFIX}/note`
export const EDIT_ENDPOINT = `${ROUTE_PREFIX}/edit`
export const TAGS_ENDPOINT = `${ROUTE_PREFIX}/tags`
export const RECENT_ENDPOINT = `${ROUTE_PREFIX}/recent`
export const SEARCH_ENDPOINT = `${ROUTE_PREFIX}/search`
export const UPLOAD_ENDPOINT = `${ROUTE_PREFIX}/upload`
export const SYNC_ENDPOINT = `${ROUTE_PREFIX}/sync`
export const RESTART_ENDPOINT = `${ROUTE_PREFIX}/restart`
export const SESSION_SUMMARY_ENDPOINT = `${ROUTE_PREFIX}/session/summary`

export const ADMIN_STATE_ENDPOINT = `${ROUTE_PREFIX}/admin/state`
/** Built system-prompt text preview (v0.21.0). */
export const ADMIN_PROMPT_ENDPOINT = `${ROUTE_PREFIX}/admin/prompt`
export const ADMIN_INFO_ENDPOINT = `${ROUTE_PREFIX}/admin/info`
export const ADMIN_CONFIG_ENDPOINT = `${ROUTE_PREFIX}/admin/config`
export const ADMIN_RESTART_ENDPOINT = `${ROUTE_PREFIX}/admin/restart`
export const ADMIN_SEEDS_ENDPOINT = `${ROUTE_PREFIX}/admin/seeds`
export const ADMIN_SEEDS_RUN_ENDPOINT = `${ROUTE_PREFIX}/admin/seeds/run`
export const ADMIN_SEEDS_REMOVE_ENDPOINT = `${ROUTE_PREFIX}/admin/seeds/remove`

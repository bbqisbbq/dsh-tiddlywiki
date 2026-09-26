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
/** Runtime wiki location (v0.22.0): read current folder / switch / reset. */
export const ADMIN_WIKI_LOCATION_ENDPOINT = `${ROUTE_PREFIX}/admin/wiki/location`
export const ADMIN_WIKI_SWITCH_ENDPOINT = `${ROUTE_PREFIX}/admin/wiki/switch`
export const ADMIN_WIKI_RESET_ENDPOINT = `${ROUTE_PREFIX}/admin/wiki/reset`

/**
 * Resolve a TW proxy URL for THIS document (v0.26.7).
 *
 * On an http(s) page the relative proxy path is right — it keeps working behind
 * whatever host/domain/HTTPS the user reached DSH on. But TiddlyWiki's own
 * TiddlyWeb sync adaptor only loads when the DOCUMENT's protocol starts with
 * `http` (`plugins/tiddlywiki/tiddlyweb/tiddlywebadaptor.js`:
 * `if($tw.browser && document.location.protocol.substr(0,4) === "http")`), and
 * the DSH **desktop** app serves its renderer from the custom `dsh-app:`
 * scheme: framed from there the wiki had no sync adaptor at all, so
 * `$:/status/IsReadOnly` was never written, TW's read-only stylesheet (which
 * treats a missing status as read-only) hid 添加条目 / 编辑 / 导入 … and no edit
 * could be saved.
 *
 * `absolute` is the host's own loopback HTTP base (`twProxyAbsolute` /
 * `twUrlAbsolute`, built from the port it actually listens on); it is used only
 * when this page is NOT on http(s), i.e. exactly the desktop case, so an
 * http(s) embedder is never sent to a different origin than its own.
 */
export function resolveTwUrl(relative: string, absolute?: string): string {
  const protocol = typeof location === 'undefined' ? '' : location.protocol
  const origin = typeof location === 'undefined' ? undefined : location.origin
  const notHttp = protocol !== 'http:' && protocol !== 'https:'
  if (notHttp && typeof absolute === 'string' && absolute.length > 0) return absolute
  return new URL(relative, origin).href
}

/** The subset of the `/sync` JSON body both client callers report on. */
export interface SyncResultPayload {
  ok?: boolean
  message?: string
  error?: string
  push?: string
  changed?: boolean
  restarted?: boolean
  restartError?: string
}

/**
 * Turn one `/sync` response into the `{ ok, message }` pair a toast shows.
 *
 * One implementation (v0.22.8): the FAB's sync controller and the settings
 * page's 同步 button each built this string by hand, including the identical
 * 「，TW 已重启 / ，TW 未自动重启（err）」 construction — and they had already
 * drifted (only the FAB one reported the `push` detail).
 */
export function describeSyncResult(
  payload: SyncResultPayload | null,
  httpStatus: number,
): { ok: true; message: string } | { ok: false; message: string } {
  if (payload === null || payload.ok !== true) {
    return { ok: false, message: payload?.error ?? payload?.message ?? `HTTP ${httpStatus}` }
  }
  let detail = ''
  if (typeof payload.push === 'string' && payload.push.length > 0 && payload.push !== 'nothing to commit') {
    detail = `（${payload.push}）`
  }
  if (payload.changed === true) {
    detail += payload.restarted === true ? '，TW 已重启' : '，TW 未自动重启'
    if (typeof payload.restartError === 'string' && payload.restartError.length > 0) detail += `（${payload.restartError}）`
  }
  return { ok: true, message: `${payload.message ?? 'OK'}${detail}` }
}

/**
 * Same-origin DSH endpoints the client calls. The authoritative route table
 * lives in src/host/routes.ts (see AGENTS.md §1「DSH 路由」) — this is just the
 * client-side mirror, so the path string exists once per endpoint instead of
 * being re-typed in every widget.
 *
 * @module dsh-tiddlywiki/client/endpoints
 */
export const STATUS_ENDPOINT = '/dsh-tiddlywiki/status'

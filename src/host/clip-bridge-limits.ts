/**
 * Size caps shared by the clip bridge's halves (v0.30.0 split).
 *
 * They live in their own module so neither half has to import the other: the
 * server + payload builders (`clip-bridge.ts`) and the network guard
 * (`clip-bridge-ssrf.ts`) both read the caps from here.
 *
 * @module dsh-tiddlywiki/host/clip-bridge-limits
 */
/**
 * Cap on a single /clip request body (bytes).
 *
 * The text cap below is derived from THIS number, not chosen independently
 * (v0.33.4): the old pair (200 000 characters vs 256 KiB) was self-contradictory
 * — CJK text is 3 bytes per character in UTF-8, so ~600 KB was "allowed" by the
 * character cap and killed by the body cap with「请求体不是合法的 JSON（或过大）」.
 * 60 000 characters stays under 256 KiB even if every character is 3 bytes
 * (180 KB) plus JSON escaping and the url/title/tag fields.
 */
export const MAX_CLIP_BODY_BYTES = 256 * 1024
/** Cap on the clipped text (characters) — plenty for a page selection. */
export const MAX_CLIP_TEXT_LENGTH = 60_000
/** Cap on one downloaded image (bytes) — 15 MB keeps the wiki sane. */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024
/** Max images stored per clip (the picker already caps the page list). */
export const MAX_CLIP_IMAGES = 10

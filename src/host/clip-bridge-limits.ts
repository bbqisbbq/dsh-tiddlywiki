/**
 * Size caps shared by the clip bridge's halves (v0.30.0 split).
 *
 * They live in their own module so neither half has to import the other: the
 * server + payload builders (`clip-bridge.ts`) and the network guard
 * (`clip-bridge-ssrf.ts`) both read the caps from here.
 *
 * @module dsh-tiddlywiki/host/clip-bridge-limits
 */
/** Cap on the clipped text (characters) — plenty for a page selection. */
export const MAX_CLIP_TEXT_LENGTH = 200_000
/** Cap on a single /clip request body (bytes). */
export const MAX_CLIP_BODY_BYTES = 256 * 1024
/** Cap on one downloaded image (bytes) — 15 MB keeps the wiki sane. */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024
/** Max images stored per clip (the picker already caps the page list). */
export const MAX_CLIP_IMAGES = 10

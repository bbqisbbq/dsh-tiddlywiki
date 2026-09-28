/**
 * Per-wiki entry icons.
 *
 * A wiki's icon is part of its identity, stored next to `label` in the control
 * file (`wikis.json`). A value is either one of {@link ICON_SVG}'s names — the
 * official DSH icon set (inlined as path data by
 * `scripts/gen-wiki-icons.mjs`, see {@link WIKI_ICON_SHAPES}) plus a few of our
 * own hand-drawn glyphs — or a short emoji literal (📚 / 💼 / 🏠), which costs
 * nothing and tells four wikis apart at a glance.
 *
 * WHY THE OFFICIAL SET IS INLINED, NOT REQUIRED (v0.28.8, feedback item 1): DSH
 * really does ship an icon system (`@deepseek-ai/dsh-client-ui-primitives`,
 * ~70 `Icon*Outline` components) and it is a client static-seed module, so a
 * runtime `require` WOULD resolve. But those are React components, and this
 * plugin's client is plain DOM — the only React here is a thin wrapper around
 * the settings section. Rendering a React element tree per sidebar row to draw a
 * 14px glyph is a poor trade, so we inline upstream's own `path` data instead:
 * identical drawings, zero dependency, nothing added to the bundle's peer surface.
 *
 * The host validates the same shape (`normalizeWikiIcon`); this module is only
 * the rendering side, and it must never throw on a value it does not recognise —
 * an unknown string falls back to the default icon rather than breaking the row.
 *
 * @module dsh-tiddlywiki/client/wiki-icon
 */

import { WIKI_ICON_SHAPES, WIKI_ICON_VIEWBOX, WIKI_ICON_FILLED } from './wiki-icon.generated.ts'

/** The default icon: a wiki page with a TiddlyWiki-style "T". */
export const DEFAULT_ICON_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.5h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/><path d="M6 6h4M6 8.5h2.5"/></svg>'

/**
 * Wrap one shape in the SVG shell every icon shares.
 *
 * Stroke geometry gets `fill:none` + `stroke:currentColor` (matching upstream's
 * Regular weight); the handful of FILLED glyphs (`data`, `plugin`, `settings`,
 * `dark`) instead get `fill:currentColor`, because stroking their outlines would
 * render them hollow and unrecognisable. `currentColor` on both is what makes an
 * icon follow the surrounding text colour in either DSH theme.
 */
function wrapShape(name: string, inner: string): string {
  const filled = WIKI_ICON_FILLED.includes(name)
  const paint = filled
    ? 'fill="currentColor" stroke="none"'
    : 'fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"'
  return `<svg viewBox="${WIKI_ICON_VIEWBOX}" width="14" height="14" ${paint} aria-hidden="true">${inner}</svg>`
}

/** Our own hand-drawn glyphs, kept because upstream has no equivalent. */
const HAND_DRAWN: Record<string, string> = {
  book: '<path d="M3.5 3h9v10h-9z"/><path d="M6.5 3v10"/><path d="M8.5 6h2.5M8.5 8.5h2"/>',
  briefcase: '<path d="M2.5 5.5h11v7h-11z"/><path d="M6 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5"/><path d="M2.5 8.5h11"/>',
  home: '<path d="M2.5 7.5 8 3l5.5 4.5"/><path d="M4 7v6h8V7"/>',
  notebook: '<path d="M4 2.5h7.5v11H4z"/><path d="M6 2.5v11"/><path d="M8 6h2M8 8.5h2"/>',
  flask: '<path d="M6.5 2.5v4L3.5 12a1 1 0 0 0 .9 1.5h7.2A1 1 0 0 0 12.5 12L9.5 6.5v-4"/><path d="M5.5 2.5h5"/><path d="M4.8 10h6.4"/>',
  star: '<path d="m8 2.5 1.7 3.6 3.8.5-2.8 2.7.7 3.9L8 11.4l-3.4 1.8.7-3.9-2.8-2.7 3.8-.5z"/>',
}

/**
 * The name → SVG map. Names match `WIKI_ICON_NAMES` on the host — the official
 * set first (so the picker leads with the system icons), then our hand-drawn few.
 */
export const ICON_SVG: Record<string, string> = {
  ...Object.fromEntries(Object.entries(WIKI_ICON_SHAPES).map(([name, inner]) => [name, wrapShape(name, inner)])),
  ...Object.fromEntries(Object.entries(HAND_DRAWN).map(([name, inner]) => [name, wrapShape(name, inner)])),
}

/** The curated names, in picker order (mirrors the host's `WIKI_ICON_NAMES`). */
export const ICON_NAMES: readonly string[] = Object.keys(ICON_SVG)

/**
 * Is this value a name we ship an SVG for? Anything else is treated as an emoji
 * literal by {@link applyWikiIcon}.
 */
export function isIconName(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(ICON_SVG, value)
}

/**
 * Put `icon` into `el` (an `.dsh-tw-entry-icon` span), falling back to the
 * default. A name sets innerHTML to our own SVG; anything else is set as TEXT
 * content, never HTML — the value comes from a file a user can edit, so it must
 * not be able to inject markup into the sidebar.
 */
export function applyWikiIcon(el: HTMLElement, icon: string | undefined): void {
  if (icon !== undefined && isIconName(icon)) {
    el.innerHTML = ICON_SVG[icon] ?? DEFAULT_ICON_SVG
    el.classList.remove('dsh-tw-entry-emoji')
    return
  }
  if (icon !== undefined && icon.trim().length > 0) {
    // textContent, deliberately: a control-file string must never be markup.
    el.textContent = icon.trim()
    el.classList.add('dsh-tw-entry-emoji')
    return
  }
  el.innerHTML = DEFAULT_ICON_SVG
  el.classList.remove('dsh-tw-entry-emoji')
}

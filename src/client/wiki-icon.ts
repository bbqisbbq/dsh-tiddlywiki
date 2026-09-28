/**
 * Per-wiki entry icons (v0.28.4).
 *
 * A wiki's icon is part of its identity, stored next to `label` in the control
 * file (`wikis.json`). A value is either one of {@link ICON_SVG}'s names — a
 * curated set of hand-written 16×16 stroke SVGs that inherit `currentColor`, so
 * they look right in both DSH themes with no assets to ship — or a short emoji
 * literal (📚 / 💼 / 🏠), which costs nothing and tells four wikis apart at a
 * glance.
 *
 * The host validates the same shape (`normalizeWikiIcon`); this module is only
 * the rendering side, and it must never throw on a value it does not recognise —
 * an unknown string falls back to the default icon rather than breaking the row.
 *
 * @module dsh-tiddlywiki/client/wiki-icon
 */

/** The default icon: a wiki page with a TiddlyWiki-style "T". */
export const DEFAULT_ICON_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.5h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/><path d="M6 6h4M6 8.5h2.5"/></svg>'

/** The curated name → SVG map. Names match `WIKI_ICON_NAMES` on the host. */
export const ICON_SVG: Record<string, string> = {
  book: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 3h9v10h-9z"/><path d="M6.5 3v10"/><path d="M8.5 6h2.5M8.5 8.5h2"/></svg>',
  briefcase: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 5.5h11v7h-11z"/><path d="M6 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5"/><path d="M2.5 8.5h11"/></svg>',
  home: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.5 8 3l5.5 4.5"/><path d="M4 7v6h8V7"/></svg>',
  notebook: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.5h7.5v11H4z"/><path d="M6 2.5v11"/><path d="M8 6h2M8 8.5h2"/></svg>',
  flask: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 2.5v4L3.5 12a1 1 0 0 0 .9 1.5h7.2A1 1 0 0 0 12.5 12L9.5 6.5v-4"/><path d="M5.5 2.5h5"/><path d="M4.8 10h6.4"/></svg>',
  globe: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11"/><path d="M8 2.5c1.6 1.6 2.4 3.5 2.4 5.5S9.6 12 8 13.5C6.4 12 5.6 10 5.6 8s.8-3.9 2.4-5.5z"/></svg>',
  star: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 2.5 1.7 3.6 3.8.5-2.8 2.7.7 3.9L8 11.4l-3.4 1.8.7-3.9-2.8-2.7 3.8-.5z"/></svg>',
  archive: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3.5h11v3h-11z"/><path d="M3.5 6.5v6h9v-6"/><path d="M6.5 9h3"/></svg>',
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

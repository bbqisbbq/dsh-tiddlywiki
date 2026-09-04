/**
 * The menubar theme override seed.
 *
 * The `tiddlywiki/menubar` plugin colours its top bar with
 * `<<colour menubar-background>>`. Most light palettes (Vanilla, Blanca, …) do
 * NOT define `menubar-background`, so the `colour` macro falls through to the
 * plugin's hardcoded `$:/config/DefaultColourMappings/` → `#5778d8` (blue) —
 * the menubar stays blue in every light theme no matter which palette is
 * active. Dark palettes that DO define it (e.g. CupertinoDark → #464646) look
 * fine, but light ones never adapt.
 *
 * The fix lives entirely on the TW side: a small stylesheet tiddler (tagged
 * `$:/tags/Stylesheet`) that pins the menubar's bar/items to the ACTIVE
 * palette's `background` / `foreground` with `!important`. TW re-renders all
 * stylesheets live whenever `$:/palette` changes, and the DSH theme-sync
 * (src/client/theme-sync.ts) flips `$:/palette` in-memory to follow the DSH
 * light/dark theme — so the menubar follows DSH automatically.
 *
 * Registered as the `menubar-theme` seed: ONE-SHOT (marker-gated, never
 * overwrites user edits) + force "重新初始化" from the settings page, exactly
 * like the other seeds.
 *
 * @module dsh-tiddlywiki/host/seed-menubar-theme
 */
import type { TiddlyWebClient } from './tw-api.ts'

/** One-time marker: presence means "the override was offered once — hands off". */
export const MENUBAR_THEME_MARKER_TITLE = '$:/plugins/dsh-tiddlywiki/seed-menubar-theme'

/** The stylesheet tiddler that adapts the menubar to the active palette. */
export const MENUBAR_THEME_TIDDLER = '$:/plugins/dsh-tiddlywiki/menubar-theme'

/**
 * The override stylesheet body, exactly as seeded (user-owned afterwards).
 * `<<colour background>>` / `<<colour foreground>>` resolve against the ACTIVE
 * palette at render time; `!important` beats the menubar plugin's own rules
 * regardless of stylesheet ordering. `\rules` mirrors the menubar plugin's own
 * styles.tid (macrocallinline needed for `<<colour>>`).
 */
export const MENUBAR_THEME_TEXT = `\\rules only filteredtranscludeinline transcludeinline macrodef macrocallinline

nav.tc-menubar ul.tc-menubar-list {
	background: <<colour background>> !important;
}

nav.tc-menubar li.tc-menubar-item > a,
nav.tc-menubar li.tc-menubar-item > button {
	color: <<colour foreground>> !important;
	fill: <<colour foreground>> !important;
	border-radius: 6px !important;
	transition: background-color 120ms ease, color 120ms ease;
}

nav.tc-menubar li.tc-menubar-item svg {
	fill: <<colour foreground>> !important;
}

nav.tc-menubar li.tc-menubar-item > a:hover,
nav.tc-menubar li.tc-menubar-item > button:hover {
	background: color-mix(in srgb, <<colour foreground>> 12%, transparent) !important;
	color: <<colour foreground>> !important;
	fill: <<colour foreground>> !important;
}

nav.tc-menubar li.tc-menubar-item > a:active,
nav.tc-menubar li.tc-menubar-item > button:active {
	background: color-mix(in srgb, <<colour foreground>> 20%, transparent) !important;
	color: <<colour foreground>> !important;
	fill: <<colour foreground>> !important;
}

nav.tc-menubar li.tc-menubar-item > a.tc-selected,
nav.tc-menubar li.tc-menubar-item > button.tc-selected {
	background: color-mix(in srgb, <<colour foreground>> 16%, transparent) !important;
	color: <<colour foreground>> !important;
	fill: <<colour foreground>> !important;
}

nav.tc-menubar li.tc-menubar-item > a:focus-visible,
nav.tc-menubar li.tc-menubar-item > button:focus-visible {
	outline: none !important;
	box-shadow: none !important;
}
`

/**
 * Seed the menubar theme override exactly once per wiki (mirrors the other
 * one-shot seeds). With `opts.force` the tiddler is overwritten with the
 * built-in content and the marker (re)written — the settings page uses this
 * for "重新初始化". Returns whether anything was written this call. Never throws.
 */
export async function seedMenubarTheme(client: TiddlyWebClient, opts?: { force?: boolean }): Promise<boolean> {
  const force = opts?.force === true
  if (!force) {
    const marker = await client.get(MENUBAR_THEME_MARKER_TITLE).catch(() => undefined)
    if (marker !== undefined) return false
  }
  const existing = await client.get(MENUBAR_THEME_TIDDLER).catch(() => undefined)
  let wrote = false
  if (force || existing === undefined) {
    await client.put({
      title: MENUBAR_THEME_TIDDLER,
      text: MENUBAR_THEME_TEXT,
      type: 'text/vnd.tiddlywiki',
      tags: ['$:/tags/Stylesheet'],
    })
    wrote = true
  }
  await client
    .put({ title: MENUBAR_THEME_MARKER_TITLE, text: 'seeded-once', type: 'text/plain', tags: [] })
    .catch(() => undefined)
  return wrote
}

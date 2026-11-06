/**
 * Icon for our Settings section (v0.35.0).
 *
 * THE SEAT
 * --------
 * DSH 0.2.2 added `settings.section.icon` — a `list`/`root` slot whose entries
 * are matched to a Settings navigation row by `id`:
 *
 *   renderSlot('settings.section.icon', { size: 16, active: row.id === active },
 *              { only: row.id, fallback: navIcon(row.id) })
 *   — `dsh-client-ui-settings-general/lib/client.js:310`
 *
 * Two consequences, both load-bearing:
 *   · the registration `id` must equal the `settings.section` registration's
 *     `id` EXACTLY (`only:` is an id filter, not an order match), which is why
 *     both call sites now share {@link SETTINGS_SECTION_ID} instead of each
 *     retyping `'dsh-tiddlywiki'`;
 *   · the slot is optional and the shell keeps its own glyph as `fallback`, so
 *     unregistering (plugin unloaded) restores the default gear with no work
 *     from us. On a host without the seat the registration simply never lands.
 *
 * `label` on this seat is accepted but NEVER displayed (host doc: "The icon's
 * label option is not displayed"), and the shell wraps us in
 * `<span aria-hidden="true">`, so the icon is decoration only: no title, no
 * aria-label, no tooltip is expected from it.
 *
 * @module dsh-tiddlywiki/client/settings-section-icon
 */
import * as React from 'react'

/**
 * The Settings section id — ONE constant for both seats.
 *
 * `settings.section` (the panel) and `settings.section.icon` (this glyph) are
 * two separate registrations that must carry the same id. Keeping the literal
 * in one place is what stops "renamed one, forgot the other" from silently
 * producing a section with the default gear.
 */
export const SETTINGS_SECTION_ID = 'dsh-tiddlywiki'
/** Order used by both seats (nav position of the section). */
export const SETTINGS_SECTION_ORDER = 50

/** Props the shell passes to a `settings.section.icon` entry. */
export interface SettingsSectionIconProps {
  /** Requested square edge in pixels (the shell asks for 16). */
  size?: number
  /** Whether this section is the selected one. */
  active?: boolean
}

/**
 * Knowledge-base glyph: a note card with a bookmark ribbon and two text lines.
 *
 * Drawing rules (so it can sit in the shell's nav without shouting):
 *   · `currentColor` only — the row decides the tone, light/dark comes free;
 *   · `active` changes ONLY `opacity` and `stroke-width`, never the geometry,
 *     so the glyph does not visually "jump" when the row is selected;
 *   · `aria-hidden` + `focusable="false"`: the row owns the accessible name.
 */
export function SettingsSectionIcon(props: SettingsSectionIconProps): React.ReactElement {
  const size = typeof props.size === 'number' && props.size > 0 ? props.size : 16
  const active = props.active === true
  return React.createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: active ? 1.7 : 1.3,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      opacity: active ? 1 : 0.7,
      'aria-hidden': 'true',
      focusable: 'false',
    },
    // Card outline.
    React.createElement('rect', { key: 'card', x: 2.75, y: 2.75, width: 10.5, height: 10.5, rx: 2 }),
    // Bookmark ribbon: the "saved note" half of the metaphor.
    React.createElement('path', { key: 'ribbon', d: 'M9.75 2.75v4l1.375-1.1L12.5 6.75v-4' }),
    // Two text lines.
    React.createElement('path', { key: 'line1', d: 'M5.25 9h5.5' }),
    React.createElement('path', { key: 'line2', d: 'M5.25 11.25h3.25' }),
  )
}

/**
 * Client stylesheet injection (design doc D5 — pure DOM, no React).
 * All rules are `dsh-tw-*` scoped; the tag is stable per plugin so the HMR
 * driver can identify it on rebuild.
 *
 * Theme: uses the live `--dsw-alias-*` design tokens (same family as the
 * shutdown launcher) with fallbacks, so it follows light/dark automatically.
 *
 * @module dsh-tiddlywiki/client/styles
 */

export const STYLE_ID = 'dsh-tiddlywiki-styles'

const CSS_TEXT = `
/* ── sidebar entry ───────────────────────────────────────────── */
.dsh-tw-entry {
  display: flex; align-items: center; gap: 8px; position: relative;
  width: calc(100% - 8px); margin: 2px 4px; padding: 6px 10px;
  border: none; border-radius: 8px; background: transparent;
  color: var(--dsw-alias-label-secondary, inherit); font: inherit; font-size: 13px;
  cursor: pointer; text-align: left;
}
.dsh-tw-entry:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); color: var(--dsw-alias-label-primary, inherit); }
.dsh-tw-entry[data-active="true"] { background: var(--dsw-alias-interactive-bg-active, rgba(128,128,128,.18)); color: var(--dsw-alias-label-primary, inherit); font-weight: 500; }
.dsh-tw-entry svg { flex: none; }
.dsh-tw-entry .dsh-tw-entry-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── center-column panel (fixed overlay, JS-pinned to the column rect) ── */
.dsh-tw-view {
  display: none; flex-direction: column; min-height: 0; box-sizing: border-box;
  background: var(--dsw-alias-bg-layer-1, var(--dsw-bg, #fff));
}
html[data-dsh-tw-active] .dsh-tw-view { display: flex; }
/* Hide the conversation content the panel overlays (all three column gens). */
html[data-dsh-tw-active] [data-pane="conversation"] > :not([data-dsh-tw-view]),
html[data-dsh-tw-active] [class*="centerCol"] > :not([data-dsh-tw-view]),
html[data-dsh-tw-active] .dshDesktopConversationSurface > :not([data-dsh-tw-view]) { display: none !important; }

.dsh-tw-panel-bar {
  display: flex; align-items: center; gap: 8px; padding: 6px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18));
  background: var(--dsw-alias-bg-layer-1, transparent);
  font-size: 12px; color: var(--dsw-alias-label-secondary, inherit);
  flex: none;
}
.dsh-tw-panel-bar button {
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
  background: transparent; color: inherit; font: inherit; font-size: 12px;
  padding: 2px 8px; border-radius: 6px; cursor: pointer;
}
.dsh-tw-panel-bar button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.dsh-tw-panel-title { font-weight: 600; margin-right: auto; }
.dsh-tw-status-chip { font-variant-numeric: tabular-nums; }
.dsh-tw-status-chip[data-state="running"] { color: var(--dsw-alias-state-success-primary, #3eaa5f); }
.dsh-tw-status-chip[data-state="starting"] { color: var(--dsw-alias-state-warning-primary, #d9822b); }
.dsh-tw-status-chip[data-state="failed"], .dsh-tw-status-chip[data-state="stopped"] { color: var(--dsw-alias-state-error-primary, #d13b3b); }

.dsh-tw-panel-frame { flex: 1; min-height: 0; border: 0; width: 100%; display: block; background: #fff; }
/* [hidden] must beat the author display rules above (UA hidden is overridden). */
.dsh-tw-panel-frame[hidden],
.dsh-tw-panel-error[hidden] { display: none !important; }

.dsh-tw-panel-error {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; color: var(--dsw-alias-label-secondary, #666); font-size: 13px; text-align: center; padding: 20px;
}
.dsh-tw-panel-error button {
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25)); background: transparent;
  color: inherit; font: inherit; padding: 6px 14px; border-radius: 8px; cursor: pointer;
}
.dsh-tw-panel-error button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.dsh-tw-panel-error code { font-size: 11px; opacity: .8; max-width: 80%; overflow-wrap: anywhere; }

/* ── floating quick-note widget ────────────────────────────────
   Positioned ABOVE the shutdown launcher FAB (fixed right:24 bottom:24,
   z-index 900, 46px) and BELOW its confirm overlay (z-index 1000). */
.dsh-tw-note {
  position: fixed; right: 24px; bottom: 88px; z-index: 950;
  display: flex; flex-direction: column; align-items: flex-end; gap: 10px;
  font-family: inherit;
}
.dsh-tw-note-card {
  width: 340px; max-width: calc(100vw - 40px);
  background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #222);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15));
  border-radius: 14px; box-shadow: var(--dsw-shadow-lv3, 0 8px 30px rgba(0,0,0,.22));
  padding: 12px; display: flex; flex-direction: column; gap: 10px;
  font-size: 13px;
}
.dsh-tw-note-card[hidden] { display: none; }
.dsh-tw-note-head {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary, #222);
}
.dsh-tw-note-head .dsh-tw-note-label { margin-right: auto; display: flex; align-items: center; gap: 6px; }
.dsh-tw-note-close {
  border: none; background: transparent; color: var(--dsw-alias-label-secondary, #888);
  font: inherit; font-size: 15px; line-height: 1; padding: 2px 6px; border-radius: 6px; cursor: pointer;
}
.dsh-tw-note-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); color: var(--dsw-alias-label-primary, #222); }
.dsh-tw-note-fields { display: flex; gap: 8px; }
.dsh-tw-note-fields input {
  flex: 1; min-width: 0; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18));
  border-radius: 8px; padding: 6px 9px; font: inherit; font-size: 12px;
  background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, inherit);
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.dsh-tw-note-fields input:focus, .dsh-tw-note-text:focus {
  outline: none; border-color: var(--dsw-alias-brand-primary, #3e63dd);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary, #3e63dd) 25%, transparent);
}
.dsh-tw-note-text {
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18)); border-radius: 8px;
  padding: 8px 9px; font: inherit; font-size: 13px; min-height: 120px; resize: vertical;
  background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, inherit);
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.dsh-tw-note-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsh-tw-note-hint { font-size: 11px; color: var(--dsw-alias-label-dimmed, #999); }
.dsh-tw-note-save {
  border: 1px solid transparent; background: var(--dsw-alias-brand-primary, #3e63dd); color: #fff;
  font: inherit; font-size: 12px; padding: 6px 16px; border-radius: 8px; cursor: pointer;
  transition: filter 120ms ease;
}
.dsh-tw-note-save:hover:not(:disabled) { filter: brightness(1.08); }
.dsh-tw-note-save:disabled { opacity: .55; cursor: default; }
.dsh-tw-note-edit {
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18));
  background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #222);
  font: inherit; font-size: 12px; padding: 6px 10px; border-radius: 8px; cursor: pointer;
  transition: filter 120ms ease;
}
.dsh-tw-note-edit:hover:not(:disabled) { filter: brightness(.96); }
.dsh-tw-note-edit:disabled { opacity: .55; cursor: default; }
/* ── Native-editor popup iframe (quick-note "在 TW 中编辑") ──────────────── */
.dsh-tw-editor-popup {
  position: fixed; left: 0; right: 0; top: 0; bottom: 0; margin: auto;
  width: min(880px, 92vw); height: min(640px, 86vh);
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #222);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.2));
  border-radius: 12px; box-shadow: 0 14px 44px rgba(0,0,0,.3);
  z-index: 980; font-family: inherit; font-size: 13px;
}
.dsh-tw-editor-bar {
  display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
  padding: 7px 8px 7px 14px; cursor: move; user-select: none;
  background: var(--dsw-alias-bg-layer-1, #f4f5f7);
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1));
}
.dsh-tw-editor-title { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tw-editor-close {
  border: none; background: transparent; cursor: pointer; font-size: 14px; line-height: 1;
  color: var(--dsw-alias-label-dimmed, #888); padding: 5px 8px; border-radius: 6px;
}
.dsh-tw-editor-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); color: var(--dsw-alias-label-primary, #222); }
.dsh-tw-editor-frame { flex: 1; min-height: 0; width: 100%; border: 0; background: #fff; }
.dsh-tw-editor-resize { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; }
.dsh-tw-note-toggle {
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18));
  background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #222);
  font: inherit; font-size: 13px; padding: 9px 16px; border-radius: 999px;
  box-shadow: var(--dsw-shadow-lv3, 0 4px 16px rgba(0,0,0,.16)); cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
  transition: background-color 120ms ease;
}
.dsh-tw-note-toggle:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); }

/* ── toast ──────────────────────────────────────────────────── */
.dsh-tw-toast {
  position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%);
  background: var(--dsw-alias-bg-inverse, rgba(30,30,30,.92)); color: var(--dsw-alias-label-inverse, #fff);
  font-size: 13px; padding: 8px 16px; border-radius: 999px; z-index: 10001;
  opacity: 0; transition: opacity .2s ease; pointer-events: none;
  max-width: 80vw; overflow-wrap: anywhere;
}
.dsh-tw-toast.dsh-tw-toast-show { opacity: 1; }

/* ── settings page (config panel §13) ────────────────────────── */
.dsh-tw-settings { display: flex; flex-direction: column; gap: 10px; padding: 12px 16px; min-width: 0; }
.dsh-tw-settings-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dsh-tw-settings-chip {
  font-size: 12px; padding: 2px 10px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
}
.dsh-tw-settings-chip[data-state="running"] { color: var(--dsw-alias-state-success-primary, #3eaa5f); }
.dsh-tw-settings-chip[data-state="starting"] { color: var(--dsw-alias-state-warning-primary, #d9822b); }
.dsh-tw-settings-chip[data-state="failed"], .dsh-tw-settings-chip[data-state="stopped"] { color: var(--dsw-alias-state-error-primary, #d13b3b); }
.dsh-tw-settings-section { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18)); }
.dsh-tw-settings-h { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #222); }
.dsh-tw-settings-field { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
.dsh-tw-settings-field-check { cursor: pointer; }
.dsh-tw-settings-label { flex: 0 0 170px; }
.dsh-tw-settings-input {
  flex: 1; min-width: 0; font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28));
  background: var(--dsw-alias-bg-input, transparent); color: var(--dsw-alias-label-primary, #222);
}
.dsh-tw-settings-input:focus {
  outline: none; border-color: var(--dsw-alias-brand-primary, #3e63dd);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #3e63dd) 22%, transparent);
}
.dsh-tw-settings-list { display: flex; flex-direction: column; gap: 2px; max-height: 240px; overflow: auto; }
.dsh-tw-settings-plugin { display: flex; align-items: center; gap: 8px; padding: 3px 4px; border-radius: 6px; font-size: 12px; }
.dsh-tw-settings-plugin:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08)); }
.dsh-tw-settings-name { font-weight: 500; flex: 0 0 130px; color: var(--dsw-alias-label-primary, #222); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tw-settings-head { padding: 2px 4px 4px; font-size: 11px; }
.dsh-tw-settings-col { flex: 0 0 14px; text-align: center; color: var(--dsw-alias-label-dimmed, #999); }
.dsh-tw-settings-row.dsh-tw-settings-plugin input { flex: 0 0 auto; margin: 0; }
.dsh-tw-settings-muted { color: var(--dsw-alias-label-dimmed, #999); font-size: 12px; }
.dsh-tw-settings-btn {
  align-self: flex-start; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28));
  background: transparent; color: var(--dsw-alias-label-primary, #222);
  font: inherit; font-size: 12px; padding: 4px 12px; border-radius: 7px; cursor: pointer;
}
.dsh-tw-settings-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); }
.dsh-tw-settings-btn:disabled { opacity: .55; cursor: default; }
.dsh-tw-settings-btn.dsh-tw-settings-primary {
  background: var(--dsw-alias-brand-primary, #3e63dd); border-color: transparent; color: #fff;
}
.dsh-tw-settings-error { color: var(--dsw-alias-state-error-primary, #d13b3b); font-size: 12px; }
.dsh-tw-settings-search { flex: 0 0 auto; max-width: 220px; }
.dsh-tw-settings-check { accent-color: var(--dsw-alias-brand-primary, #3e63dd); }
`

export function injectStyles(): void {
  if (typeof document === 'undefined') return
  let el = document.getElementById(STYLE_ID)
  if (el !== null) return
  el = document.createElement('style')
  el.id = STYLE_ID
  el.dataset.plugin = 'dsh-tiddlywiki'
  el.textContent = CSS_TEXT
  document.head.append(el)
}

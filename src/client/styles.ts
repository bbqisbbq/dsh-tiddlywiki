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
/* Collapsed rail: the shell narrows the sidebar to a 56px icon rail (dual
   signals — the frame's data-sidebar-collapsed + the sidebar root's hashed
   *_collapsed class, same doctrine as dsh-taskboard 0.4.3). Mirror the
   native 36×36 icon-button geometry: center the icon, hide the label, and
   scale it up to match the shell's 18px rail icons. */
[data-sidebar-collapsed] [data-dsh-tw-entry],
[class*="_collapsed"] [data-dsh-tw-entry] {
  width: 36px; height: 36px; min-width: 36px;
  margin: 0 0 12px; padding: 0;
  justify-content: center; gap: 0; text-align: center;
}
[data-sidebar-collapsed] [data-dsh-tw-entry] .dsh-tw-entry-label,
[class*="_collapsed"] [data-dsh-tw-entry] .dsh-tw-entry-label { display: none; }
[data-sidebar-collapsed] [data-dsh-tw-entry] svg,
[class*="_collapsed"] [data-dsh-tw-entry] svg { width: 18px; height: 18px; }

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

/* ── bottom-right status / reload floating buttons ───────────────────
   The top panel bar (title + status + reload row) is gone so TW's menubar
   reaches the panel top; status/reload now live here as floating buttons,
   same visual language as the quick-note toggle. The ui.showPanelStatus
   setting controls whether they mount at all. */
.dsh-tw-panel-status {
  /* 状态/重载悬浮按钮：右对齐到与快速笔记按钮同一条竖线（right:24），
     垂直排在「同步」按钮（bottom:140）上方；
     两个按钮竖直依次排列（状态在上、重载在下），与其他插件按钮列对齐、不堆叠。 */
  position: fixed; right: 24px; bottom: 192px; z-index: 950;
  display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
}
.dsh-tw-panel-status-btn {
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18));
  background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #222);
  font: inherit; font-size: 12px; padding: 7px 12px; border-radius: 999px;
  box-shadow: var(--dsw-shadow-lv3, 0 4px 16px rgba(0,0,0,.16)); cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
  transition: background-color 120ms ease;
}
.dsh-tw-panel-status-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); }
.dsh-tw-status-dot { width: 8px; height: 8px; border-radius: 50%; background: #999; flex: none; }
.dsh-tw-status-dot[data-state="running"] { background: var(--dsw-alias-state-success-primary, #3eaa5f); }
.dsh-tw-status-dot[data-state="starting"] { background: var(--dsw-alias-state-warning-primary, #d9822b); }
.dsh-tw-status-dot[data-state="failed"], .dsh-tw-status-dot[data-state="stopped"] { background: var(--dsw-alias-state-error-primary, #d13b3b); }

/* The iframe background follows the DSH theme so a blank/preload frame never
   flashes pure white in dark mode (TW paints its own palette once loaded). */
.dsh-tw-panel-frame { flex: 1; min-height: 0; border: 0; width: 100%; display: block; background: var(--dsw-alias-bg-layer-1, #fff); }
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
   z-index 900, 46px) and BELOW its confirm overlay (z-index 1000).
   Interactive overlays (the open card, the native-editor popup) sit ABOVE the
   passive FAB column (sync/status, z-index 950) so those FABs never cover the
   card's own bottom-right buttons. */
.dsh-tw-note {
  position: fixed; right: 24px; bottom: 88px; z-index: 980;
  display: flex; flex-direction: column; align-items: flex-end; gap: 10px;
  font-family: inherit;
}
/* The wrapper's display:flex would beat the UA [hidden]{display:none} rule,
   so the card's show/hide (root.hidden) needs an explicit rule. */
.dsh-tw-note[hidden] { display: none; }
.dsh-tw-note-card {
  width: 340px; max-width: calc(100vw - 40px);
  background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #222);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15));
  border-radius: 14px; box-shadow: var(--dsw-shadow-lv3, 0 8px 30px rgba(0,0,0,.22));
  padding: 12px; display: flex; flex-direction: column; gap: 10px;
  font-size: 13px;
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  animation: dsh-tw-note-in 180ms ease;
}
.dsh-tw-note-card[hidden] { display: none; }
@keyframes dsh-tw-note-in {
  from { opacity: 0; transform: translateY(8px) scale(.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.dsh-tw-note-head {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; font-weight: 600; letter-spacing: .2px;
  color: var(--dsw-alias-label-primary, #222);
}
.dsh-tw-note-head .dsh-tw-note-label { margin-right: auto; display: flex; align-items: center; gap: 6px; }
.dsh-tw-note-close {
  border: none; background: transparent; color: var(--dsw-alias-label-secondary, #888);
  font: inherit; font-size: 15px; line-height: 1; padding: 2px 6px; border-radius: 6px; cursor: pointer;
}
.dsh-tw-note-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); color: var(--dsw-alias-label-primary, #222); }
/* 标题与标签上下分行：标题一行，标签 chips+输入框独占一行，
   避免标签增多时把并排的标题栏一起撑高。 */
.dsh-tw-note-fields { display: flex; flex-direction: column; gap: 8px; }
.dsh-tw-note-fields input {
  width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18));
  border-radius: 8px; padding: 6px 9px; font: inherit; font-size: 12px;
  background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, inherit);
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.dsh-tw-note-fields input:focus, .dsh-tw-note-editor .cm-editor.cm-focused {
  outline: none; border-color: var(--dsw-alias-brand-primary, #3e63dd);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary, #3e63dd) 25%, transparent);
}
/* ── Markdown editor (CodeMirror 6, see markdown-editor.ts) ──────────
   The .cm-editor box carries the border/radius/min-height the old textarea
   had; font metrics live on the scroller so lines/selection stay aligned. */
.dsh-tw-note-editor { position: relative; min-width: 0; }
.dsh-tw-note-editor .cm-editor {
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18)); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #222);
  font-size: 13px; min-height: 120px;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.dsh-tw-note-editor .cm-scroller {
  font-family: inherit; font-size: 13px; line-height: 1.5;
  min-height: 120px; overflow: auto;
}
.dsh-tw-note-editor .cm-content {
  caret-color: var(--dsw-alias-label-primary, #222);
  padding: 8px 9px;
}
.dsh-tw-note-editor .cm-placeholder { color: var(--dsw-alias-label-dimmed, #999); }
.dsh-tw-note-editor .cm-line { padding: 0; }
/* Selection + active line follow the theme. */
.dsh-tw-note-editor .cm-editor .cm-selectionBackground,
.dsh-tw-note-editor .cm-editor.cm-focused .cm-selectionBackground {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #3e63dd) 22%, transparent) !important;
}
.dsh-tw-note-editor .cm-editor .cm-activeLine {
  background: color-mix(in srgb, var(--dsw-alias-label-secondary, #888) 8%, transparent);
}
/* Drag-over highlight (file upload) targets the CodeMirror box now. */
.dsh-tw-note-drop .cm-editor {
  border-color: var(--dsw-alias-brand-primary, #3e63dd);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary, #3e63dd) 25%, transparent);
}
.dsh-tw-note-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsh-tw-note-foot-left, .dsh-tw-note-foot-right { display: flex; align-items: center; gap: 8px; }
.dsh-tw-note-hint { font-size: 11px; color: var(--dsw-alias-label-dimmed, #999); }
.dsh-tw-note-upload {
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18));
  background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #222);
  font: inherit; font-size: 12px; padding: 6px 10px; border-radius: 8px; cursor: pointer;
  transition: filter 120ms ease, transform 80ms ease;
}
.dsh-tw-note-upload:hover { filter: brightness(.96); }
.dsh-tw-note-upload:active { transform: scale(.96); }
.dsh-tw-note-save {
  border: 1px solid transparent; background: var(--dsw-alias-brand-primary, #3e63dd); color: #fff;
  font: inherit; font-size: 12px; padding: 6px 16px; border-radius: 8px; cursor: pointer;
  transition: filter 120ms ease, transform 80ms ease;
}
.dsh-tw-note-save:hover:not(:disabled) { filter: brightness(1.08); }
.dsh-tw-note-save:active:not(:disabled) { transform: scale(.96); }
.dsh-tw-note-save:disabled { opacity: .55; cursor: default; }
.dsh-tw-note-edit {
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18));
  background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #222);
  font: inherit; font-size: 12px; padding: 6px 10px; border-radius: 8px; cursor: pointer;
  transition: filter 120ms ease, transform 80ms ease;
}
.dsh-tw-note-edit:hover:not(:disabled) { filter: brightness(.96); }
.dsh-tw-note-edit:active:not(:disabled) { transform: scale(.96); }
.dsh-tw-note-edit:disabled { opacity: .55; cursor: default; }
/* ── Multi-tag chip editor (quick-note tags) ─────────────────────────────── */
.dsh-tw-note-tags { position: relative; width: 100%; display: flex; flex-direction: column; gap: 4px; }
.dsh-tw-note-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.dsh-tw-note-tagchip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 6px 2px 8px; border-radius: 999px; font-size: 11px; line-height: 1.4;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #3e63dd) 10%, var(--dsw-alias-bg-layer-1, #fff));
  border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #3e63dd) 30%, transparent);
  color: var(--dsw-alias-label-primary, #222);
}
.dsh-tw-note-tagchip-x {
  cursor: pointer; font-size: 12px; line-height: 1; padding: 0 2px; border-radius: 50%;
  color: var(--dsw-alias-label-secondary, #888);
}
.dsh-tw-note-tagchip-x:hover { color: var(--dsw-alias-state-error-primary, #d13b3b); }
.dsh-tw-note-taginput { width: 100%; box-sizing: border-box; }
.dsh-tw-note-tagsuggest {
  position: absolute; left: 0; right: 0; top: calc(100% + 2px); z-index: 60;
  max-height: 168px; overflow-y: auto; border-radius: 8px; padding: 4px;
  background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #222);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18));
  box-shadow: var(--dsw-shadow-lv2, 0 4px 16px rgba(0,0,0,.16));
  font-size: 12px;
}
.dsh-tw-note-tagsuggest-item {
  padding: 6px 9px; border-radius: 6px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dsh-tw-note-tagsuggest-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
/* ── Native-editor popup iframe (quick-note "在 TW 中编辑") ──────────────── */
.dsh-tw-editor-popup {
  position: fixed; left: 0; right: 0; top: 0; bottom: 0; margin: auto;
  width: min(880px, 92vw); height: min(640px, 86vh);
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #222);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.2));
  border-radius: 12px; box-shadow: 0 14px 44px rgba(0,0,0,.3);
  z-index: 990; font-family: inherit; font-size: 13px;
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
.dsh-tw-editor-frame { flex: 1; min-height: 0; width: 100%; border: 0; background: var(--dsw-alias-bg-layer-1, #fff); }
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

/* ── floating sync button (bottom-right) ───────────────────────
   Pill FAB between the quick-note toggle (bottom:88) and the TW panel
   status/reload floaters (bottom:192); dot reflects git state. */
.dsh-tw-sync {
  position: fixed; right: 24px; bottom: 140px; z-index: 950;
  display: inline-flex; align-items: center; gap: 7px;
  padding: 9px 14px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18));
  background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #222);
  font: inherit; font-size: 13px; box-shadow: var(--dsw-shadow-lv3, 0 4px 16px rgba(0,0,0,.16));
  cursor: pointer; transition: background-color 120ms ease;
}
.dsh-tw-sync:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); }
.dsh-tw-sync:disabled { opacity: .65; cursor: default; }
.dsh-tw-sync-icon { display: inline-flex; flex: none; }
.dsh-tw-sync-spin .dsh-tw-sync-icon svg { animation: dsh-tw-spin 1s linear infinite; transform-origin: center; }
@keyframes dsh-tw-spin { to { transform: rotate(360deg); } }
.dsh-tw-sync-dot { width: 8px; height: 8px; border-radius: 50%; background: #999; flex: none; }
.dsh-tw-sync-dot[data-state="clean"] { background: var(--dsw-alias-state-success-primary, #3eaa5f); }
.dsh-tw-sync-dot[data-state="dirty"] { background: var(--dsw-alias-state-warning-primary, #d9822b); }
.dsh-tw-sync-dot[data-state="behind"] { background: var(--dsw-alias-state-error-primary, #d13b3b); }
.dsh-tw-sync-dot[data-state="syncing"] { background: var(--dsw-alias-brand-primary, #3e63dd); }

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

/* ── "知识库" FAB (v0.5: quick-note + sync + panel status merged) ──────────
   One fixed cluster above the shutdown launcher FAB (bottom:24). The FAB
   carries a git status dot; the menu pops upward from it. */
.dsh-tw-fab-wrap {
  position: fixed; right: 24px; bottom: 88px; z-index: 960;
  display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
}
.dsh-tw-fab {
  position: relative;
  width: 46px; height: 46px; border-radius: 50%;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18));
  background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #222);
  box-shadow: var(--dsw-shadow-lv3, 0 4px 16px rgba(0,0,0,.16)); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  transition: background-color 120ms ease, transform 80ms ease;
}
.dsh-tw-fab:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); }
.dsh-tw-fab:active { transform: scale(.94); }
.dsh-tw-fab-icon { display: inline-flex; }
.dsh-tw-fab-dot {
  position: absolute; right: 0; bottom: 0; width: 11px; height: 11px;
  border-radius: 50%; border: 2px solid var(--dsw-alias-bg-layer-2, #fff);
  background: #999; box-sizing: border-box;
}
.dsh-tw-fab-dot[data-state="clean"] { background: var(--dsw-alias-state-success-primary, #3eaa5f); }
.dsh-tw-fab-dot[data-state="dirty"] { background: var(--dsw-alias-state-warning-primary, #d9822b); }
.dsh-tw-fab-dot[data-state="behind"] { background: var(--dsw-alias-state-error-primary, #d13b3b); }
.dsh-tw-fab-dot[data-state="syncing"] { background: var(--dsw-alias-brand-primary, #3e63dd); }
.dsh-tw-fab-menu {
  min-width: 220px; max-width: calc(100vw - 48px);
  display: flex; flex-direction: column; gap: 2px; padding: 6px;
  border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15));
  background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #222);
  box-shadow: var(--dsw-shadow-lv3, 0 8px 30px rgba(0,0,0,.22));
  font-size: 13px;
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  animation: dsh-tw-note-in 160ms ease;
}
.dsh-tw-fab-menu[hidden] { display: none; }
.dsh-tw-fab-status {
  display: flex; align-items: center; gap: 7px;
  padding: 6px 9px; font-size: 12px; color: var(--dsw-alias-label-secondary, #666);
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
  margin-bottom: 4px;
}
.dsh-tw-fab-status + .dsh-tw-fab-status { border-bottom: 0; margin-bottom: 4px; }
.dsh-tw-fab-status-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tw-fab-status-dot { width: 8px; height: 8px; border-radius: 50%; background: #999; flex: none; }
.dsh-tw-fab-status-dot[data-state="running"] { background: var(--dsw-alias-state-success-primary, #3eaa5f); }
.dsh-tw-fab-status-dot[data-state="starting"] { background: var(--dsw-alias-state-warning-primary, #d9822b); }
.dsh-tw-fab-status-dot[data-state="failed"], .dsh-tw-fab-status-dot[data-state="stopped"] { background: var(--dsw-alias-state-error-primary, #d13b3b); }
.dsh-tw-fab-status-dot[data-state="clean"] { background: var(--dsw-alias-state-success-primary, #3eaa5f); }
.dsh-tw-fab-status-dot[data-state="dirty"] { background: var(--dsw-alias-state-warning-primary, #d9822b); }
.dsh-tw-fab-status-dot[data-state="behind"] { background: var(--dsw-alias-state-error-primary, #d13b3b); }
.dsh-tw-fab-status-dot[data-state="syncing"] { background: var(--dsw-alias-brand-primary, #3e63dd); }
.dsh-tw-fab-item {
  display: flex; align-items: center; gap: 6px; text-align: left;
  border: none; background: transparent; color: inherit; font: inherit; font-size: 13px;
  padding: 7px 9px; border-radius: 8px; cursor: pointer;
}
.dsh-tw-fab-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.dsh-tw-fab-item:active { background: var(--dsw-alias-interactive-bg-active, rgba(128,128,128,.18)); }

/* ── quick-note restored-draft banner ─────────────────────────────────────── */
.dsh-tw-note-draft {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 5px 9px; border-radius: 8px; font-size: 12px;
  background: color-mix(in srgb, var(--dsw-alias-state-warning-primary, #d9822b) 12%, transparent);
  color: var(--dsw-alias-label-primary, #222);
}
.dsh-tw-note-draft[hidden] { display: none; }
.dsh-tw-note-draft-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tw-note-draft-discard {
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18));
  background: transparent; color: inherit; font: inherit; font-size: 12px;
  padding: 2px 10px; border-radius: 999px; cursor: pointer; flex: none;
}
.dsh-tw-note-draft-discard:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }

/* ── quick-note recent-notes picker ───────────────────────────────────────── */
.dsh-tw-note-recent {
  position: absolute; right: 0; bottom: calc(100% - 8px); z-index: 70;
  width: 340px; max-width: calc(100vw - 40px); max-height: 280px; overflow-y: auto;
  display: flex; flex-direction: column; gap: 2px; padding: 6px;
  border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15));
  background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #222);
  box-shadow: var(--dsw-shadow-lv3, 0 8px 30px rgba(0,0,0,.22));
  font-size: 13px;
}
.dsh-tw-note-recent[hidden] { display: none; }
.dsh-tw-note-recent-item {
  display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
  padding: 6px 8px; border-radius: 7px; cursor: pointer;
}
.dsh-tw-note-recent-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.dsh-tw-note-recent-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tw-note-recent-meta { flex: none; font-size: 11px; color: var(--dsw-alias-label-dimmed, #999); }
.dsh-tw-note-recent-muted { padding: 8px 10px; font-size: 12px; color: var(--dsw-alias-label-dimmed, #999); }
.dsh-tw-note-recent-btn {
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18));
  background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #222);
  font: inherit; font-size: 12px; padding: 6px 10px; border-radius: 8px; cursor: pointer;
  transition: filter 120ms ease, transform 80ms ease;
}
.dsh-tw-note-recent-btn:hover { filter: brightness(.96); }
.dsh-tw-note-recent-btn:active { transform: scale(.96); }
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

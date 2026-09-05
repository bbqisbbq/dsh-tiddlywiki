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
.dsh-tw-note-editor .cm-placeholder { color: color-mix(in srgb, var(--dsw-alias-label-primary, #222) 55%, transparent); }
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
.dsh-tw-note-hint { font-size: 11px; color: color-mix(in srgb, var(--dsw-alias-label-primary, #222) 58%, transparent); }
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
  color: color-mix(in srgb, var(--dsw-alias-label-primary, #222) 58%, transparent); padding: 5px 8px; border-radius: 6px;
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
.dsh-tw-settings-chip[data-state="ok"] { color: var(--dsw-alias-state-success-primary, #3eaa5f); }
.dsh-tw-settings-chip[data-state="missing"] { color: var(--dsw-alias-state-error-primary, #d13b3b); }
.dsh-tw-settings-section { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18)); }
.dsh-tw-settings-h { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #222); }
/* 字段行：标签自然换行（不再固定 170px 列导致断行错乱），输入框右对齐限宽。
   align-items: flex-start 让多行标签与输入框顶对齐；复选框行保持垂直居中。 */
.dsh-tw-settings-field {
  display: flex; align-items: flex-start; gap: 10px; font-size: 12px;
  color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary, #222));
}
.dsh-tw-settings-field-check { align-items: center; cursor: pointer; }
.dsh-tw-settings-label { flex: 1 1 45%; min-width: 0; line-height: 1.55; padding-top: 3px; }
.dsh-tw-settings-field-check .dsh-tw-settings-label { padding-top: 0; }
.dsh-tw-settings-input {
  flex: 0 1 240px; min-width: 140px; max-width: 55%; box-sizing: border-box;
  font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 6px;
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
/* 行内名称：可增长到 200px 再省略，长中文标题不再被 130px 列截断得七零八落。 */
.dsh-tw-settings-name {
  font-weight: 500; flex: 0 1 200px; min-width: 0;
  color: var(--dsw-alias-label-primary, #222);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 行内说明：占剩余空间、单行省略（悬停 title 看全），避免 flex-wrap 换行错乱。 */
.dsh-tw-settings-row.dsh-tw-settings-plugin .dsh-tw-settings-muted {
  flex: 1 1 100px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-tw-settings-head { padding: 2px 4px 4px; font-size: 11px; }
.dsh-tw-settings-col { flex: 0 0 14px; text-align: center; color: var(--dsw-alias-label-secondary, #666); }
.dsh-tw-settings-row.dsh-tw-settings-plugin input { flex: 0 0 auto; margin: 0; }
/* 说明/次要文字：不依赖可能缺失或与背景不一致的 label-dimmed token，改由主题
   主文字色 label-primary 派生（58% 透明），在任何深浅主题下都保证可读。 */
.dsh-tw-settings-muted {
  color: color-mix(in srgb, var(--dsw-alias-label-primary, #222) 58%, transparent);
  font-size: 12px;
}
.dsh-tw-settings-btn {
  align-self: flex-start; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28));
  background: transparent; color: var(--dsw-alias-label-primary, #222);
  font: inherit; font-size: 12px; padding: 4px 12px; border-radius: 7px; cursor: pointer;
  flex: none;
}
.dsh-tw-settings-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); }
.dsh-tw-settings-btn:disabled { opacity: .55; cursor: default; }
.dsh-tw-settings-btn.dsh-tw-settings-primary {
  background: var(--dsw-alias-brand-primary, #3e63dd); border-color: transparent; color: #fff;
}
/* 反初始化/危险操作按钮：错误色描边+文字，悬停浅色底。 */
.dsh-tw-settings-btn.dsh-tw-settings-danger {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d13b3b) 45%, transparent);
  color: var(--dsw-alias-state-error-primary, #d13b3b);
}
.dsh-tw-settings-btn.dsh-tw-settings-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d13b3b) 10%, transparent);
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
.dsh-tw-note-recent-meta { flex: none; font-size: 11px; color: color-mix(in srgb, var(--dsw-alias-label-primary, #222) 55%, transparent); }
.dsh-tw-note-recent-muted { padding: 8px 10px; font-size: 12px; color: color-mix(in srgb, var(--dsw-alias-label-primary, #222) 55%, transparent); }
.dsh-tw-note-recent-btn {
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18));
  background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #222);
  font: inherit; font-size: 12px; padding: 6px 10px; border-radius: 8px; cursor: pointer;
  transition: filter 120ms ease, transform 80ms ease;
}
.dsh-tw-note-recent-btn:hover { filter: brightness(.96); }
.dsh-tw-note-recent-btn:active { transform: scale(.96); }

/* ── reply-stream native tool cards ────────────────────────────────── */
.dsh-tw-toolcard {
  margin: 4px 0; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16));
  border-radius: 10px; background: var(--dsw-alias-bg-layer-2, #fff);
  overflow: hidden; max-width: 640px;
}
.dsh-tw-toolcard-head {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px 6px;
}
.dsh-tw-toolcard-badge {
  flex: none; font-size: 11px; line-height: 1; padding: 4px 8px; border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #3e63dd) 12%, transparent);
  color: var(--dsw-alias-brand-primary, #3e63dd); font-weight: 600;
}
.dsh-tw-toolcard-title {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #222);
}
.dsh-tw-toolcard-open {
  flex: none; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18));
  background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #222);
  font: inherit; font-size: 11px; padding: 4px 9px; border-radius: 999px; cursor: pointer;
  transition: filter 120ms ease, transform 80ms ease;
}
.dsh-tw-toolcard-open:hover { filter: brightness(.96); }
.dsh-tw-toolcard-open:active { transform: scale(.96); }
.dsh-tw-toolcard-meta {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 0 10px 6px; font-size: 11px;
}
.dsh-tw-toolcard-sub { color: color-mix(in srgb, var(--dsw-alias-label-primary, #222) 55%, transparent); }
.dsh-tw-toolcard-tags { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.dsh-tw-toolcard-tag {
  font-size: 10px; line-height: 1; padding: 3px 7px; border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #222) 8%, transparent);
  color: color-mix(in srgb, var(--dsw-alias-label-primary, #222) 70%, transparent);
}
.dsh-tw-toolcard-body {
  padding: 4px 12px 10px; font-size: 13px; line-height: 1.6;
  color: var(--dsw-alias-label-primary, #222);
}
.dsh-tw-toolcard-body > :first-child { margin-top: 4px; }
.dsh-tw-toolcard-body > :last-child { margin-bottom: 0; }
.dsh-tw-toolcard-loading, .dsh-tw-toolcard-pending {
  color: color-mix(in srgb, var(--dsw-alias-label-primary, #222) 55%, transparent); font-size: 12px;
}
.dsh-tw-toolcard-empty, .dsh-tw-toolcard-error { font-size: 12px; }
.dsh-tw-toolcard-error { color: var(--dsw-alias-danger-1, #c0392b); }
.dsh-tw-toolcard-fallback {
  margin: 0; padding: 8px; border-radius: 6px; white-space: pre-wrap; word-break: break-word;
  font: 11px/1.55 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #222) 5%, transparent);
  max-height: 320px; overflow: auto;
}
.dsh-tw-toolcard-foot {
  padding: 0 10px 8px; font-size: 11px;
  color: color-mix(in srgb, var(--dsw-alias-label-primary, #222) 45%, transparent);
}
/* Native TW fragment — minimal re-theme of the tc-* classes TW emits, so
   links/tables/code render legibly in the DSH page (TW's own CSS is not
   loaded here). Trust: the HTML comes from the LOCAL wiki. */
.dsh-tw-toolcard-native {
  max-height: 420px; overflow: auto; padding-right: 4px;
}
.dsh-tw-toolcard-native a { color: var(--dsw-alias-brand-primary, #3e63dd); text-decoration: underline; cursor: pointer; }
.dsh-tw-toolcard-native a.tc-tiddlylink-missing { text-decoration-style: dashed; opacity: .85; }
.dsh-tw-toolcard-native table { border-collapse: collapse; margin: 6px 0; display: block; max-width: 100%; overflow-x: auto; }
.dsh-tw-toolcard-native th, .dsh-tw-toolcard-native td { border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.2)); padding: 4px 8px; text-align: left; }
.dsh-tw-toolcard-native pre, .dsh-tw-toolcard-native code {
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
}
.dsh-tw-toolcard-native pre { background: color-mix(in srgb, var(--dsw-alias-label-primary, #222) 6%, transparent); padding: 8px; border-radius: 6px; overflow-x: auto; }
.dsh-tw-toolcard-native code { background: color-mix(in srgb, var(--dsw-alias-label-primary, #222) 8%, transparent); padding: 1px 4px; border-radius: 4px; }
.dsh-tw-toolcard-native pre code { background: transparent; padding: 0; }
.dsh-tw-toolcard-native blockquote { margin: 6px 0; padding-left: 10px; border-left: 3px solid var(--dsw-alias-border-l2, rgba(0,0,0,.25)); color: color-mix(in srgb, var(--dsw-alias-label-primary, #222) 70%, transparent); }
.dsh-tw-toolcard-native img { max-width: 100%; height: auto; border-radius: 6px; }
.dsh-tw-toolcard-native .tc-error { color: var(--dsw-alias-danger-1, #c0392b); }
/* List rows (search / recent / batch). */
.dsh-tw-toolcard-list { display: flex; flex-direction: column; gap: 2px; }
.dsh-tw-toolcard-row {
  display: flex; align-items: baseline; gap: 8px; padding: 4px 6px; border-radius: 6px;
  color: inherit; text-decoration: none; font-size: 12px;
}
.dsh-tw-toolcard-row:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #222) 7%, transparent); }
.dsh-tw-toolcard-row-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary, #222); }
.dsh-tw-toolcard-row:hover .dsh-tw-toolcard-row-title { color: var(--dsw-alias-brand-primary, #3e63dd); }
.dsh-tw-toolcard-row-tags { flex: none; font-size: 10px; color: color-mix(in srgb, var(--dsw-alias-label-primary, #222) 55%, transparent); }
.dsh-tw-toolcard-row-meta { flex: none; font-size: 10px; color: color-mix(in srgb, var(--dsw-alias-label-primary, #222) 40%, transparent); }
.dsh-tw-toolcard-tags-wrap { display: flex; flex-wrap: wrap; gap: 4px; }
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

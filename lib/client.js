window.__ModuleLoader__.load({
	id: "dsh-tiddlywiki",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
//#endregion
let react = require("react");
react = __toESM(react, 1);
//#region src/client/styles.ts
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
const STYLE_ID = "dsh-tiddlywiki-styles";
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
   z-index 900, 46px) and BELOW its confirm overlay (z-index 1000).
   Interactive overlays (the open card, the native-editor popup) sit ABOVE the
   passive FAB column (sync/status, z-index 950) so those FABs never cover the
   card's own bottom-right buttons. */
.dsh-tw-note {
  position: fixed; right: 24px; bottom: 88px; z-index: 980;
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
.dsh-tw-note-text::placeholder { color: var(--dsw-alias-label-dimmed, #999); }
/* ── Markdown editor (highlighted-textarea overlay) ────────────────
   The <pre> highlight layer and the transparent <textarea> share identical
   metrics (border/padding/font/line-height/white-space) so lines align 1:1. */
.dsh-tw-note-editor { position: relative; min-width: 0; }
.dsh-tw-note-editor pre,
.dsh-tw-note-editor textarea {
  margin: 0; box-sizing: border-box; width: 100%;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18)); border-radius: 8px;
  padding: 8px 9px; font: inherit; font-size: 13px; line-height: 1.5; min-height: 120px;
  white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; tab-size: 4;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.dsh-tw-note-editor .dsh-tw-note-hl {
  position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 0;
  background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #222);
  pointer-events: none; overflow: hidden;
}
.dsh-tw-note-editor .dsh-tw-note-text {
  position: relative; z-index: 1; resize: vertical;
  background: transparent; color: transparent; caret-color: var(--dsw-alias-label-primary, #222);
  overflow: auto;
}
.dsh-tw-note-editor .dsh-tw-note-text:focus { outline: none; }
.dsh-tw-note-drop .dsh-tw-note-text,
.dsh-tw-note-drop .dsh-tw-note-hl {
  border-color: var(--dsw-alias-brand-primary, #3e63dd);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary, #3e63dd) 25%, transparent);
}
/* ── markdown highlight tokens (colors only — never size/height, so the
      overlay keeps line-for-line alignment with the invisible textarea) ── */
.dsh-tw-note-hl .md-heading { font-weight: 700; color: var(--dsw-alias-brand-primary, #3e63dd); }
.dsh-tw-note-hl .md-hash { font-weight: 700; color: color-mix(in srgb, var(--dsw-alias-brand-primary, #3e63dd) 55%, transparent); }
.dsh-tw-note-hl .md-code,
.dsh-tw-note-hl .md-code-block,
.dsh-tw-note-hl .md-fence {
  font-family: ui-monospace, "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace;
}
.dsh-tw-note-hl .md-code {
  background: color-mix(in srgb, var(--dsw-alias-label-secondary, #888) 14%, transparent);
  border-radius: 4px; padding: 0 3px;
}
.dsh-tw-note-hl .md-code-block,
.dsh-tw-note-hl .md-fence {
  display: block; background: color-mix(in srgb, var(--dsw-alias-label-secondary, #888) 8%, transparent);
}
.dsh-tw-note-hl .md-bold { font-weight: 700; }
.dsh-tw-note-hl .md-italic { font-style: italic; }
.dsh-tw-note-hl .md-strike { text-decoration: line-through; opacity: .75; }
.dsh-tw-note-hl .md-link { color: var(--dsw-alias-brand-primary, #3e63dd); text-decoration: underline; }
.dsh-tw-note-hl .md-url { color: color-mix(in srgb, var(--dsw-alias-brand-primary, #3e63dd) 70%, #999); text-decoration: underline dotted; }
.dsh-tw-note-hl .md-image { color: var(--dsw-alias-state-success-primary, #3eaa5f); font-weight: 600; }
.dsh-tw-note-hl .md-bullet { font-weight: 700; color: var(--dsw-alias-brand-primary, #3e63dd); }
.dsh-tw-note-hl .md-number { font-weight: 700; color: var(--dsw-alias-state-warning-primary, #d9822b); }
.dsh-tw-note-hl .md-quote { font-style: italic; color: var(--dsw-alias-label-secondary, #888); }
.dsh-tw-note-hl .md-hr { color: var(--dsw-alias-label-dimmed, #999); text-decoration: line-through; }
.dsh-tw-note-hl .md-task { color: var(--dsw-alias-label-secondary, #888); }
.dsh-tw-note-hl .md-task-checked { color: var(--dsw-alias-state-success-primary, #3eaa5f); font-weight: 600; }
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
.dsh-tw-note-tags { position: relative; flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
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
`;
function injectStyles() {
	if (typeof document === "undefined") return;
	let el = document.getElementById(STYLE_ID);
	if (el !== null) return;
	el = document.createElement("style");
	el.id = STYLE_ID;
	el.dataset.plugin = "dsh-tiddlywiki";
	el.textContent = CSS_TEXT;
	document.head.append(el);
}
//#endregion
//#region src/client/state.ts
var PanelState = class {
	open = false;
	listeners = /* @__PURE__ */ new Set();
	isOpen() {
		return this.open;
	}
	toggle() {
		this.set(!this.open);
	}
	openPanel() {
		this.set(true);
	}
	closePanel() {
		this.set(false);
	}
	set(value) {
		if (this.open === value) return;
		this.open = value;
		for (const listener of [...this.listeners]) listener(value);
	}
	subscribe(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
};
/** Inline icon: a wiki page with a TiddlyWiki-style "T" (nav-icon look). */
const ICON = "<svg viewBox=\"0 0 16 16\" width=\"14\" height=\"14\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M4 2.5h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z\"/><path d=\"M6 6h4M6 8.5h2.5\"/></svg>";
/** Family entries from sibling plugins, kept in a stable relative order. */
const FAMILY_SELECTOR = "[data-dsh-tw-entry], [data-dsh-atb-entry], [data-dsh-taskboard-entry], [data-dsh-ssh-entry]";
/** Find the sidebar shell root element, or undefined while not yet mounted. */
function sidebarRoot() {
	const column = document.querySelector("[data-pane=\"sidebar\"], [class*=\"sidebarCol\"], .dshDesktopUpstreamSidebar, .dshDesktopSidebarSurface");
	if (column === null) return void 0;
	return column.querySelector("[class*=\"logoRow\"]")?.parentElement ?? column.firstElementChild;
}
/** The New Session button inside the sidebar root. */
function newSessionButton(root) {
	const nested = root.querySelector("button[class*=\"newSession\"]");
	if (nested !== null) return nested;
	for (const child of root.children) if (child instanceof HTMLButtonElement && !child.matches("[data-dsh-tw-entry]")) return child;
	const byAria = root.querySelector("button[aria-label=\"新建会话\"], button[aria-label=\"New Session\"], button[aria-label*=\"新会话\"], button[aria-label*=\"new session\" i]");
	if (byAria !== null) return byAria;
	return Array.from(root.querySelectorAll("button")).find((button) => !button.matches("[data-dsh-tw-entry]") && /新会话|新建会话|new session/i.test(button.textContent ?? ""));
}
/** Build the entry row (a detached button; insert once the shell is up). */
function createEntry(state) {
	const entry = document.createElement("button");
	entry.type = "button";
	entry.dataset.dshTwEntry = "";
	entry.className = "dsh-tw-entry";
	entry.setAttribute("aria-label", "TiddlyWiki 知识库");
	entry.innerHTML = `<span class="dsh-tw-entry-icon">${ICON}</span><span class="dsh-tw-entry-label">TiddlyWiki</span>`;
	entry.addEventListener("click", () => {
		state.toggle();
	});
	return entry;
}
/** Re-insert the entry before the whole family block (stable ordering). */
function placeEntry(root, entry) {
	const button = newSessionButton(root);
	if (button === void 0) return false;
	if (entry.parentElement !== root) {
		const row = button.closest("[class*=\"logoRow\"]");
		const base = row !== null && row.parentElement === root ? row : button;
		const family = Array.from(root.children).filter((el) => el instanceof HTMLElement && el.matches(FAMILY_SELECTOR));
		const anchor = family.length > 0 ? family[0] ?? null : base.nextElementSibling ?? null;
		root.insertBefore(entry, anchor);
	}
	return true;
}
/**
* Mount the sidebar entry, waiting for the shell and self-healing on later
* re-renders.
* @param state - the shared panel state the entry toggles.
* @returns disposer removing the entry and its observers.
*/
function mountSidebarEntry(state) {
	const entry = createEntry(state);
	const debug = {
		attempts: 0,
		found: false,
		placed: false
	};
	const host = globalThis.location?.hostname;
	if (host === "localhost" || host === "127.0.0.1") window.__twDebug = debug;
	let root;
	let placed = false;
	const tryPlace = () => {
		debug.attempts++;
		if (root !== void 0 && !root.isConnected) {
			rootObserver.disconnect();
			root = void 0;
			placed = false;
		}
		if (placed) {
			if (document.body.contains(entry)) return;
			rootObserver.disconnect();
			root = void 0;
			placed = false;
		}
		root ??= sidebarRoot();
		if (root === void 0) return;
		debug.found = newSessionButton(root) !== void 0;
		placed = placeEntry(root, entry);
		debug.placed = placed;
		if (placed) rootObserver.observe(root, {
			childList: true,
			subtree: true
		});
	};
	const waitObserver = new MutationObserver(() => {
		tryPlace();
	});
	waitObserver.observe(document.body, {
		childList: true,
		subtree: true
	});
	const rootObserver = new MutationObserver(() => {
		if (root === void 0 || !root.isConnected) {
			placed = false;
			tryPlace();
			return;
		}
		if (!root.contains(entry)) placed = placeEntry(root, entry);
	});
	const retry = setInterval(() => {
		tryPlace();
	}, 2e3);
	const syncActive = () => {
		if (state.isOpen()) entry.dataset.active = "true";
		else delete entry.dataset.active;
	};
	const unsubscribe = state.subscribe(syncActive);
	syncActive();
	tryPlace();
	return () => {
		clearInterval(retry);
		waitObserver.disconnect();
		rootObserver.disconnect();
		unsubscribe();
		entry.remove();
	};
}
//#endregion
//#region src/client/panel.ts
/**
* Center-column targets, most-specific shell generation first. The official
* layout shell (dsh-client-ui-layout) drops data-pane and uses a CSS-Module
* hashed `centerCol`; older shells put `data-pane="conversation"` on the same
* full-height grid item; DSH Desktop exposes the non-compat
* `.dshDesktopConversationSurface`.
*/
const COLUMN_SELECTORS = [
	"[class*=\"centerCol\"]",
	"[data-pane=\"conversation\"]",
	".dshDesktopConversationSurface"
];
const ACTIVE_ATTR = "data-dsh-tw-active";
/** Sibling panels' activation attributes, evicted when this panel opens. */
const OTHER_ACTIVE_ATTRS = [
	"data-dsh-atb-active",
	"data-dsh-taskboard-active",
	"data-dsh-ssh-active"
];
/** Cross-plugin activation event; detail is the activating panel name. */
const ACTIVATE_EVENT = "dsh-panel-activate";
const PANEL_NAME = "dsh-tiddlywiki";
/** Overlay z-index: above the shell content, below the note widget (950). */
const PANEL_Z_INDEX = 40;
/**
* dsh-better-sidebar's unified fixed host layer (its persistent
* expand/collapse toggle cluster lives inside it, at a global z-index of 25
* — its internal 45 is trapped by the host's stacking context). When this
* host is present the panel must stay BELOW it, so the sidebar toggle
* buttons stay visible and clickable above the full-screen TW panel.
*/
const PANEL_HOST_SELECTOR = "[data-dsh-panel-host]";
/** The app's own shell overlay layer (dsh-client-ui-layout pins it at 20). */
const APP_OVERLAY_Z_INDEX = 20;
/** Safety re-measure cadence for shell layout changes CSS can't see. */
const SYNC_INTERVAL_MS = 2e3;
const STATUS_ENDPOINT$2 = "/dsh-tiddlywiki/status";
const RESTART_ENDPOINT$1 = "/dsh-tiddlywiki/restart";
/**
* The panel's z-index: below any dsh-better-sidebar host layer so its
* persistent toggle cluster (top-right corner) stays visible and clickable
* above the full-screen TW panel, otherwise the default 40. The host's live
* computed z-index is read instead of hardcoding 25, so the rule tracks
* plugin updates; the panel is still clamped above the app's own shell
* overlay layer (dsh-client-ui-layout pins it at 20).
*/
function resolvePanelZIndex() {
	const host = document.querySelector(PANEL_HOST_SELECTOR);
	if (host === null) return PANEL_Z_INDEX;
	const parsed = parseInt(getComputedStyle(host).zIndex, 10);
	if (!Number.isFinite(parsed)) return PANEL_Z_INDEX;
	return Math.max(APP_OVERLAY_Z_INDEX, Math.min(PANEL_Z_INDEX, parsed - 1));
}
function conversationColumn() {
	for (const selector of COLUMN_SELECTORS) {
		const el = document.querySelector(selector);
		if (el !== null) return el;
	}
}
async function fetchStatus$1() {
	try {
		const res = await fetch(STATUS_ENDPOINT$2, { signal: AbortSignal.timeout(8e3) });
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}
async function requestRestart() {
	try {
		return (await fetch(RESTART_ENDPOINT$1, {
			method: "POST",
			signal: AbortSignal.timeout(8e3)
		})).ok;
	} catch {
		return false;
	}
}
function mountPanel(state) {
	let container;
	let columnEl;
	let iframe;
	let frameArea;
	let errorArea;
	let chip;
	let statusDot;
	let statusFloater;
	let refreshTimer;
	let refreshAttempts = 0;
	const build = () => {
		const view = document.createElement("div");
		view.dataset.dshTwView = "";
		view.className = "dsh-tw-view";
		frameArea = document.createElement("div");
		frameArea.className = "dsh-tw-panel-frame-wrap";
		frameArea.style.cssText = "flex:1;min-height:0;display:flex;flex-direction:column";
		iframe = document.createElement("iframe");
		iframe.className = "dsh-tw-panel-frame";
		iframe.title = "TiddlyWiki";
		iframe.hidden = true;
		frameArea.append(iframe);
		errorArea = document.createElement("div");
		errorArea.className = "dsh-tw-panel-error";
		errorArea.hidden = true;
		view.append(frameArea, errorArea);
		return view;
	};
	/**
	* Bottom-right floating status/reload buttons (same visual language as the
	* quick-note toggle) — the top panel bar is gone, so TW's menubar reaches
	* the very top of the panel and clears the host's top-right buttons. Mount
	* is gated by `ui.showPanelStatus` (settings page toggle).
	*/
	const buildStatusFloater = () => {
		const wrap = document.createElement("div");
		wrap.className = "dsh-tw-panel-status";
		const statusBtn = document.createElement("button");
		statusBtn.type = "button";
		statusBtn.className = "dsh-tw-panel-status-btn";
		statusBtn.title = "刷新状态";
		statusDot = document.createElement("span");
		statusDot.className = "dsh-tw-status-dot";
		statusDot.dataset.state = "unknown";
		chip = document.createElement("span");
		chip.className = "dsh-tw-panel-status-text";
		chip.textContent = "—";
		statusBtn.append(statusDot, chip);
		statusBtn.addEventListener("click", () => {
			doRefresh();
		});
		const reloadBtn = document.createElement("button");
		reloadBtn.type = "button";
		reloadBtn.className = "dsh-tw-panel-status-btn";
		reloadBtn.textContent = "重载";
		reloadBtn.title = "重载 TiddlyWiki 面板";
		reloadBtn.addEventListener("click", () => {
			if (iframe !== void 0 && !iframe.hidden) iframe.src = iframe.src;
		});
		wrap.append(statusBtn, reloadBtn);
		document.body.append(wrap);
		return wrap;
	};
	const setChip = (stateName, text) => {
		if (statusDot !== void 0) statusDot.dataset.state = stateName;
		if (chip !== void 0) chip.textContent = text;
	};
	/** Pin the overlay to the center column's current viewport rect. */
	const syncRect = () => {
		if (container === void 0 || columnEl === void 0) return;
		const rect = columnEl.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) return;
		const left = `${rect.left}px`;
		const top = `${rect.top}px`;
		const width = `${rect.width}px`;
		const height = `${rect.height}px`;
		if (container.style.left !== left) container.style.left = left;
		if (container.style.top !== top) container.style.top = top;
		if (container.style.width !== width) container.style.width = width;
		if (container.style.height !== height) container.style.height = height;
	};
	/**
	* Coexist with dsh-better-sidebar: keep the panel's z-index below the
	* host layer (so its toggle cluster stays clickable above the panel) and
	* flag the host's presence so CSS can reserve the cluster's width at the
	* panel bar's right end. Re-run whenever the host mounts/unmounts.
	*/
	const applyChrome = () => {
		if (container === void 0) return;
		container.style.zIndex = String(resolvePanelZIndex());
		if (document.querySelector(PANEL_HOST_SELECTOR) !== null) container.dataset.sidebarHost = "1";
		else delete container.dataset.sidebarHost;
	};
	const ensure = () => {
		if (container !== void 0) return;
		columnEl = conversationColumn();
		if (columnEl === void 0) return;
		container = build();
		container.style.position = "fixed";
		applyChrome();
		document.body.append(container);
		syncRect();
	};
	const showError = (message) => {
		if (iframe === void 0 || errorArea === void 0 || frameArea === void 0) return;
		iframe.hidden = true;
		errorArea.hidden = false;
		errorArea.textContent = "";
		const p = document.createElement("div");
		p.textContent = "TiddlyWiki 服务不可用";
		const code = document.createElement("code");
		code.textContent = message;
		const retry = document.createElement("button");
		retry.type = "button";
		retry.textContent = "重试";
		retry.addEventListener("click", () => {
			retry.disabled = true;
			retry.textContent = "重启中…";
			requestRestart().finally(() => {
				doRefresh();
			});
		});
		errorArea.append(p, code, retry);
	};
	const showStarting = () => {
		if (iframe === void 0 || errorArea === void 0 || frameArea === void 0) return;
		iframe.hidden = true;
		errorArea.hidden = false;
		errorArea.textContent = "";
		const p = document.createElement("div");
		p.textContent = "TiddlyWiki 服务正在启动…";
		errorArea.append(p);
	};
	const showFrame = (url) => {
		if (iframe === void 0 || errorArea === void 0) return;
		errorArea.hidden = true;
		iframe.hidden = false;
		if (iframe.dataset.loaded !== url) {
			iframe.dataset.loaded = url;
			iframe.src = url;
		}
	};
	const doRefresh = async () => {
		if (refreshTimer !== void 0) {
			window.clearTimeout(refreshTimer);
			refreshTimer = void 0;
		}
		const payload = await fetchStatus$1();
		if (payload === null) {
			setChip("failed", "状态不可达");
			showError("无法访问 /dsh-tiddlywiki/status");
			return;
		}
		if (payload.status === "running" && typeof payload.url === "string") {
			setChip("running", "在线");
			refreshAttempts = 0;
			showFrame(payload.url);
			return;
		}
		if (payload.status === "starting") {
			setChip("starting", "启动中");
			showStarting();
			if (refreshAttempts < 30) {
				refreshAttempts++;
				refreshTimer = window.setTimeout(() => {
					doRefresh();
				}, 1500);
			}
			return;
		}
		setChip("failed", "离线");
		refreshAttempts = 0;
		showError(payload.error ?? `服务状态：${payload.status}`);
	};
	const applyActive = () => {
		if (state.isOpen()) {
			for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr);
			document.documentElement.setAttribute(ACTIVE_ATTR, "");
			document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }));
			doRefresh();
		} else {
			document.documentElement.removeAttribute(ACTIVE_ATTR);
			if (refreshTimer !== void 0) {
				window.clearTimeout(refreshTimer);
				refreshTimer = void 0;
			}
			refreshAttempts = 0;
		}
	};
	const onOtherActivate = (event) => {
		if (event.detail !== PANEL_NAME && state.isOpen()) state.closePanel();
	};
	const onClickSidebarRow = (event) => {
		if (!state.isOpen()) return;
		const target = event.target;
		if (target === null) return;
		if (target.closest("[data-dsh-tw-entry]") !== null) return;
		if (target.closest("[class*=\"sessionRow\"], [class*=\"projectRow\"], [class*=\"searchResultRow\"], [class*=\"searchResultWorkspace\"], [class*=\"newSession\"]") !== null) state.closePanel();
	};
	const waitObserver = new MutationObserver(() => {
		ensure();
		applyChrome();
	});
	waitObserver.observe(document.body, {
		childList: true,
		subtree: true
	});
	const resizeObserver = new ResizeObserver(() => syncRect());
	resizeObserver.observe(document.body);
	const syncInterval = window.setInterval(syncRect, SYNC_INTERVAL_MS);
	const onWindowResize = () => syncRect();
	window.addEventListener("resize", onWindowResize);
	const onAnyScroll = () => syncRect();
	window.addEventListener("scroll", onAnyScroll, true);
	document.addEventListener("click", onClickSidebarRow, true);
	document.addEventListener(ACTIVATE_EVENT, onOtherActivate);
	const unsubscribe = state.subscribe(applyActive);
	ensure();
	applyActive();
	(async () => {
		if ((await fetchStatus$1())?.ui?.showPanelStatus === false) return;
		statusFloater = buildStatusFloater();
	})();
	return () => {
		if (refreshTimer !== void 0) window.clearTimeout(refreshTimer);
		window.clearInterval(syncInterval);
		window.removeEventListener("resize", onWindowResize);
		window.removeEventListener("scroll", onAnyScroll, true);
		resizeObserver.disconnect();
		document.removeEventListener("click", onClickSidebarRow, true);
		document.removeEventListener(ACTIVATE_EVENT, onOtherActivate);
		waitObserver.disconnect();
		unsubscribe();
		document.documentElement.removeAttribute(ACTIVE_ATTR);
		container?.remove();
		statusFloater?.remove();
	};
}
//#endregion
//#region src/client/toast.ts
/**
* One-shot transient toast, shared by the quick-note widget and the settings
* page. Reuses a single body-level element (`.dsh-tw-toast`) with a show
* class; the element is created lazily and styled by styles.ts.
*
* @module dsh-tiddlywiki/client/toast
*/
function toast(message) {
	let el = document.querySelector(".dsh-tw-toast");
	if (el === null) {
		el = document.createElement("div");
		el.className = "dsh-tw-toast";
		document.body.append(el);
	}
	el.textContent = message;
	el.classList.add("dsh-tw-toast-show");
	clearTimeout(el.__twToastTimer);
	el.__twToastTimer = window.setTimeout(() => {
		el?.classList.remove("dsh-tw-toast-show");
	}, 2500);
}
//#endregion
//#region src/client/editor-popup.ts
/**
* Floating popup iframe that loads TiddlyWiki's NATIVE editor for a draft
* (quick-note "✏️ 在 TW 中编辑"). A small draggable + resizable overlay with its
* own iframe pointed at `twUrl#<draftTitle>`: the fragment-only navigation
* triggers TW's hashchange, which opens the draft in the story, and because the
* draft tiddler carries `draft.of` the story renders the native EditTemplate.
*
* Independent of the center panel — a separate floating window so the user can
* edit a note without leaving the chat context.
*
* @module dsh-tiddlywiki/client/editor-popup
*/
let root;
let frame;
let titleEl;
/** Open (create on first use) the popup and load `url` (twUrl#draftTitle). */
function openEditorPopup(url, label) {
	ensurePopup();
	if (root === void 0 || frame === void 0) return;
	if (titleEl !== void 0) titleEl.textContent = `TiddlyWiki 编辑器 · ${label}`;
	root.style.display = "";
	frame.src = url;
}
/** Remove the popup DOM entirely (plugin dispose). */
function disposeEditorPopup() {
	root?.remove();
	root = void 0;
	frame = void 0;
	titleEl = void 0;
}
function ensurePopup() {
	if (root !== void 0 && frame !== void 0) return;
	root = document.createElement("div");
	root.className = "dsh-tw-editor-popup";
	root.style.display = "none";
	const bar = document.createElement("div");
	bar.className = "dsh-tw-editor-bar";
	titleEl = document.createElement("span");
	titleEl.className = "dsh-tw-editor-title";
	titleEl.textContent = "TiddlyWiki 编辑器";
	const close = document.createElement("button");
	close.type = "button";
	close.className = "dsh-tw-editor-close";
	close.textContent = "✕";
	close.title = "关闭";
	bar.append(titleEl, close);
	frame = document.createElement("iframe");
	frame.className = "dsh-tw-editor-frame";
	frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups");
	frame.title = "TiddlyWiki 编辑器";
	const resize = document.createElement("div");
	resize.className = "dsh-tw-editor-resize";
	resize.title = "拖拽调整大小";
	root.append(bar, frame, resize);
	document.body.append(root);
	close.addEventListener("click", () => {
		if (root !== void 0) root.style.display = "none";
	});
	bar.addEventListener("mousedown", (event) => {
		if (event.button !== 0 || root === void 0) return;
		event.preventDefault();
		const rect = root.getBoundingClientRect();
		const startX = event.clientX;
		const startY = event.clientY;
		const baseLeft = rect.left;
		const baseTop = rect.top;
		const onMove = (ev) => {
			if (root === void 0) return;
			root.style.left = `${baseLeft + ev.clientX - startX}px`;
			root.style.top = `${baseTop + ev.clientY - startY}px`;
			root.style.margin = "0";
			root.style.right = "auto";
			root.style.bottom = "auto";
		};
		const onUp = () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	});
	resize.addEventListener("mousedown", (event) => {
		if (event.button !== 0 || root === void 0) return;
		event.preventDefault();
		event.stopPropagation();
		const rect = root.getBoundingClientRect();
		const startX = event.clientX;
		const startY = event.clientY;
		const baseW = rect.width;
		const baseH = rect.height;
		const onMove = (ev) => {
			if (root === void 0) return;
			root.style.width = `${Math.max(360, baseW + ev.clientX - startX)}px`;
			root.style.height = `${Math.max(260, baseH + ev.clientY - startY)}px`;
			root.style.right = "auto";
			root.style.bottom = "auto";
		};
		const onUp = () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	});
}
//#endregion
//#region src/client/markdown.ts
/**
* Lightweight Markdown syntax highlighter for the quick-note editor.
*
* The editor is the classic "highlighted textarea": a `<pre>` rendered BEHIND
* a transparent-text `<textarea>` with identical metrics. To keep the two
* layers perfectly aligned we NEVER change the user's text — every token is
* only wrapped in a colored `<span class="md-*">`, so each line keeps its
* exact characters and column widths. Leading whitespace (indentation) is
* preserved as-is so list/heading/quote alignment survives.
*
* Coverage is deliberately pragmatic (a scratch-note editor, not CommonMark):
* ATX headings, fenced code blocks, blockquotes, bullet + ordered + task
* lists, horizontal rules, inline code, bold, italic, strikethrough, links
* and images. HTML is escaped first, so the output is always safe to set as
* `innerHTML` (no raw HTML from the user is ever executed).
*
* @module dsh-tiddlywiki/client/markdown
*/
/** Escape a raw source fragment for safe insertion into the overlay HTML. */
function escapeHtml(value) {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/**
* Inline token highlighting on ALREADY-ESCAPED text. Inline code spans are
* first pulled out into placeholders so later passes (links/bold/italic) can
* never reach inside them, then restored.
*/
function highlightInline(escaped) {
	const codeTokens = [];
	let s = escaped.replace(/(`+)([^`]+?)\1/g, (_all, t, code) => {
		codeTokens.push(`<span class="md-code">${t}${code}${t}</span>`);
		return `\u0000${codeTokens.length - 1}\u0000`;
	});
	s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_a, alt, url) => `<span class="md-image">![${alt}](</span><span class="md-url">${url}</span><span class="md-image">)</span>`);
	s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_a, text, url) => `<span class="md-link">[${text}](</span><span class="md-url">${url}</span><span class="md-link">)</span>`);
	const boldTokens = [];
	s = s.replace(/(\*\*|__)([^*_]+?)\1/g, (_a, d, text) => {
		boldTokens.push(`<span class="md-bold">${d}${text}${d}</span>`);
		return `\u0001${boldTokens.length - 1}\u0001`;
	});
	s = s.replace(/(\*|_)([^*_]+?)\1/g, "<span class=\"md-italic\">$1$2$1</span>");
	s = s.replace(/~~([^~]+?)~~/g, "<span class=\"md-strike\">~~$1~~</span>");
	return s.replace(/\u0001(\d+)\u0001/g, (_a, i) => boldTokens[Number(i)] ?? "").replace(/\u0000(\d+)\u0000/g, (_a, i) => codeTokens[Number(i)] ?? "");
}
/**
* Match and return groups as a plain string array ('' for absent groups), or
* null when the pattern does not match. Avoids noUncheckedIndexedAccess
* friction on RegExpMatchArray indexing.
*/
function groups(re, value) {
	const m = value.match(re);
	if (m === null) return null;
	return Array.from(m, (g) => g ?? "");
}
/** Highlight one non-fence line (leading whitespace preserved verbatim). */
function highlightLine(raw) {
	const leadMatch = groups(/^(\s*)(.*)$/, raw);
	const lead = leadMatch === null ? "" : leadMatch[1];
	const body = leadMatch === null ? raw : leadMatch[2];
	if (body.length === 0) return raw;
	const heading = groups(/^(#{1,6})(\s+)(.*)$/, body);
	if (heading !== null) return `${lead}<span class="md-heading">${escapeHtml(heading[1])}${escapeHtml(heading[2])}</span>${highlightInline(escapeHtml(heading[3]))}`;
	if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(body)) return `${lead}<span class="md-hr">${escapeHtml(body)}</span>`;
	const quote = groups(/^(>)( ?)(.*)$/, body);
	if (quote !== null) return `${lead}<span class="md-quote">${escapeHtml(quote[1])}</span>${escapeHtml(quote[2])}${highlightInline(escapeHtml(quote[3]))}`;
	const task = groups(/^([-*+])(\s+)(\[[ xX]\])(\s+)(.*)$/, body);
	if (task !== null) {
		const checked = /\[[xX]\]/.test(task[3]);
		return `${lead}<span class="md-bullet">${escapeHtml(task[1])}</span>${escapeHtml(task[2])}<span class="md-task${checked ? " md-task-checked" : ""}">${escapeHtml(task[3])}</span>${escapeHtml(task[4])}${highlightInline(escapeHtml(task[5]))}`;
	}
	const bullet = groups(/^([-*+])(\s+)(.*)$/, body);
	if (bullet !== null) return `${lead}<span class="md-bullet">${escapeHtml(bullet[1])}</span>${escapeHtml(bullet[2])}${highlightInline(escapeHtml(bullet[3]))}`;
	const ordered = groups(/^(\d+)([.)])(\s+)(.*)$/, body);
	if (ordered !== null) return `${lead}<span class="md-number">${escapeHtml(ordered[1])}${escapeHtml(ordered[2])}</span>${escapeHtml(ordered[3])}${highlightInline(escapeHtml(ordered[4]))}`;
	return `${lead}${highlightInline(escapeHtml(body))}`;
}
/**
* Highlight full Markdown source into safe `<span>`-wrapped HTML. Line count
* and per-line text (including whitespace) are preserved exactly.
*/
function highlightMarkdown(src) {
	const lines = src.split("\n");
	const out = [];
	let inFence = false;
	for (const rawLine of lines) {
		if (rawLine.match(/^\s*(```|~~~)\s*([\w-]*)\s*$/) !== null) {
			inFence = !inFence;
			out.push(`<span class="md-fence">${escapeHtml(rawLine)}</span>`);
			continue;
		}
		if (inFence) {
			out.push(`<span class="md-code-block">${escapeHtml(rawLine)}</span>`);
			continue;
		}
		out.push(highlightLine(rawLine));
	}
	return out.join("\n");
}
//#endregion
//#region src/client/note-widget.ts
/**
* Floating quick-note widget (design doc §12, D6/D7) — bottom-right, fixed,
* collapsible, independent of any shell DOM. Lets the human jot drafts /
* scratch notes while waiting for the AI or drafting the next prompt.
*
* Save posts to /dsh-tiddlywiki/note → an independent tiddler (title & tags
* editable; defaults: timestamp title + config tag, usually "inbox").
*
* ui.showQuickNote config: the widget is mounted async and stays hidden (and
* never appended) when the option is off, so the toggle button can be disabled
* from the settings page without touching the shell.
*
* Tag editor: multi-select chips + autocomplete from the wiki's existing tags
* (GET /dsh-tiddlywiki/tags). Enter/`,` commits the typed value; Backspace on
* an empty field removes the last chip; the dropdown filters on typing.
*
* Markdown editing: a "highlighted textarea" overlay (a `<pre>` rendered
* behind a transparent-text `<textarea>`, see markdown.ts) so Markdown is
* syntax-highlighted as you type — no dependencies, perfect alignment.
*
* File upload: the body accepts files via the 📎 button or drag-and-drop;
* each file is POSTed raw to /dsh-tiddlywiki/upload (saved under the wiki's
* `files/` folder, git-tracked and served at `/files/<name>`) and a Markdown
* image/link line is inserted at the caret.
*
* @module dsh-tiddlywiki/client/note-widget
*/
const NOTE_ENDPOINT = "/dsh-tiddlywiki/note";
const EDIT_ENDPOINT = "/dsh-tiddlywiki/edit";
const STATUS_ENDPOINT$1 = "/dsh-tiddlywiki/status";
const TAGS_ENDPOINT = "/dsh-tiddlywiki/tags";
const UPLOAD_ENDPOINT = "/dsh-tiddlywiki/upload";
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
function pad$1(n) {
	return n < 10 ? `0${n}` : String(n);
}
/** Default note title: `YYYY-MM-DD HH:mm`. */
function timestampTitle(date = /* @__PURE__ */ new Date()) {
	return `${date.getFullYear()}-${pad$1(date.getMonth() + 1)}-${pad$1(date.getDate())} ${pad$1(date.getHours())}:${pad$1(date.getMinutes())}`;
}
async function fetchUiOptions() {
	const fallback = {
		showQuickNote: true,
		defaultTag: "inbox"
	};
	try {
		const res = await fetch(STATUS_ENDPOINT$1, { signal: AbortSignal.timeout(5e3) });
		if (!res.ok) return fallback;
		const payload = await res.json();
		return {
			showQuickNote: payload.ui?.showQuickNote !== false,
			defaultTag: payload.note?.tag ?? "inbox"
		};
	} catch {
		return fallback;
	}
}
/** Multi-tag chip editor with autocomplete from the wiki's existing tags. */
function buildTagEditor() {
	const wrap = document.createElement("div");
	wrap.className = "dsh-tw-note-tags";
	const chipWrap = document.createElement("div");
	chipWrap.className = "dsh-tw-note-chips";
	const input = document.createElement("input");
	input.className = "dsh-tw-note-taginput";
	input.placeholder = "tag（可多选，自动补全）";
	const suggest = document.createElement("div");
	suggest.className = "dsh-tw-note-tagsuggest";
	suggest.hidden = true;
	wrap.append(chipWrap, input, suggest);
	const chips = [];
	const hideSuggest = () => {
		suggest.hidden = true;
	};
	const renderChips = () => {
		chipWrap.replaceChildren();
		for (const tag of chips) {
			const chip = document.createElement("span");
			chip.className = "dsh-tw-note-tagchip";
			chip.textContent = tag;
			const x = document.createElement("span");
			x.className = "dsh-tw-note-tagchip-x";
			x.textContent = "×";
			x.title = `移除 tag「${tag}」`;
			x.addEventListener("click", (event) => {
				event.stopPropagation();
				const i = chips.indexOf(tag);
				if (i >= 0) {
					chips.splice(i, 1);
					renderChips();
				}
			});
			chip.append(x);
			chipWrap.append(chip);
		}
	};
	const addTag = (tag) => {
		const t = tag.trim();
		if (t.length === 0 || chips.includes(t)) return;
		chips.push(t);
		input.value = "";
		renderChips();
		hideSuggest();
		input.focus();
	};
	const commitInput = () => {
		for (const raw of input.value.split(/\s+/)) addTag(raw);
	};
	let knownTags = [];
	let tagsPromise;
	const ensureTags = () => {
		tagsPromise ??= fetch(TAGS_ENDPOINT, { signal: AbortSignal.timeout(5e3) }).then((r) => r.ok ? r.json() : Promise.resolve({})).then((p) => [...p.tags ?? []].sort((a, b) => a.localeCompare(b, "zh"))).catch(() => []);
		tagsPromise.then((list) => {
			knownTags = list;
		});
		return tagsPromise;
	};
	const showSuggest = () => {
		const q = input.value.trim().toLowerCase();
		const matches = knownTags.filter((t) => !chips.includes(t) && (q.length === 0 || t.toLowerCase().includes(q))).slice(0, 8);
		suggest.replaceChildren();
		for (const tag of matches) {
			const item = document.createElement("div");
			item.className = "dsh-tw-note-tagsuggest-item";
			item.textContent = tag;
			item.addEventListener("mousedown", (event) => {
				event.preventDefault();
				addTag(tag);
			});
			suggest.append(item);
		}
		suggest.hidden = matches.length === 0;
	};
	input.addEventListener("focus", () => {
		ensureTags().then(showSuggest);
	});
	input.addEventListener("input", () => {
		if (knownTags.length === 0) ensureTags().then(showSuggest);
		else showSuggest();
	});
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter" || event.key === ",") {
			event.preventDefault();
			commitInput();
		} else if (event.key === "Backspace" && input.value.length === 0 && chips.length > 0) {
			chips.pop();
			renderChips();
		} else if (event.key === "Escape") hideSuggest();
	});
	document.addEventListener("click", (event) => {
		if (!wrap.contains(event.target)) hideSuggest();
	}, true);
	return {
		el: wrap,
		getTags: () => {
			commitInput();
			return [...chips];
		},
		setDefault: (tag) => {
			if (chips.length === 0) {
				const t = tag.trim();
				if (t.length > 0) {
					chips.push(t);
					renderChips();
				}
			}
		}
	};
}
/**
* Markdown editor: a `<pre>` overlay (highlighted by markdown.ts) rendered
* behind a transparent-text `<textarea>` with identical metrics. Scroll is
* mirrored; on every input the overlay is re-rendered. The text layer stays
* exactly aligned with the highlight layer because the highlighter never
* changes the user's characters.
*/
function buildEditor() {
	const wrap = document.createElement("div");
	wrap.className = "dsh-tw-note-editor";
	const hl = document.createElement("pre");
	hl.className = "dsh-tw-note-hl";
	hl.setAttribute("aria-hidden", "true");
	const textarea = document.createElement("textarea");
	textarea.className = "dsh-tw-note-text";
	textarea.placeholder = "写点东西… Markdown 高亮，可 📎/拖入文件\nCtrl+Enter 保存";
	wrap.append(hl, textarea);
	const render = () => {
		hl.innerHTML = `${highlightMarkdown(textarea.value)}\n`;
		hl.scrollTop = textarea.scrollTop;
		hl.scrollLeft = textarea.scrollLeft;
	};
	const syncScroll = () => {
		hl.scrollTop = textarea.scrollTop;
		hl.scrollLeft = textarea.scrollLeft;
	};
	textarea.addEventListener("input", render);
	textarea.addEventListener("scroll", syncScroll);
	render();
	return {
		el: wrap,
		textarea,
		render,
		focus: () => textarea.focus()
	};
}
/**
* Upload one file to the wiki (raw body, name in ?name=), then insert a
* Markdown image/link line at the caret of the given editor.
*/
async function uploadInto(file, editor) {
	if (file.size > MAX_UPLOAD_BYTES) {
		toast(`文件过大（≤ ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB）`);
		return;
	}
	try {
		const res = await fetch(`${UPLOAD_ENDPOINT}?name=${encodeURIComponent(file.name)}`, {
			method: "POST",
			headers: { "content-type": file.type || "application/octet-stream" },
			body: file,
			signal: AbortSignal.timeout(12e4)
		});
		const payload = await res.json().catch(() => null);
		if (!res.ok || payload?.ok !== true) {
			toast(`上传失败：${payload?.error ?? `HTTP ${res.status}`}`);
			return;
		}
		const name = payload.name ?? file.name;
		const markdown = file.type.startsWith("image/") ? `![${name}](${payload.url})` : `[${name}](${payload.url})`;
		const ta = editor.textarea;
		const start = ta.selectionStart ?? ta.value.length;
		const end = ta.selectionEnd ?? start;
		const before = ta.value.slice(0, start);
		const after = ta.value.slice(end);
		const insert = `${start > 0 && !before.endsWith("\n") ? "\n" : ""}${markdown}\n`;
		ta.value = `${before}${insert}${after}`;
		const caret = (before + insert).length;
		ta.setSelectionRange(caret, caret);
		ta.focus();
		editor.render();
		toast(`已上传「${name}」并插入链接`);
	} catch (err) {
		toast(`上传失败：${err instanceof Error ? err.message : String(err)}`);
	}
}
/** Build the whole widget DOM and wire it up (returns the appended root). */
function buildWidget() {
	const root = document.createElement("div");
	root.className = "dsh-tw-note";
	const card = document.createElement("div");
	card.className = "dsh-tw-note-card";
	card.hidden = true;
	const head = document.createElement("div");
	head.className = "dsh-tw-note-head";
	const label = document.createElement("span");
	label.className = "dsh-tw-note-label";
	label.textContent = "📝 快速笔记";
	const closeBtn = document.createElement("button");
	closeBtn.type = "button";
	closeBtn.className = "dsh-tw-note-close";
	closeBtn.title = "收起";
	closeBtn.textContent = "✕";
	head.append(label, closeBtn);
	const fields = document.createElement("div");
	fields.className = "dsh-tw-note-fields";
	const titleInput = document.createElement("input");
	titleInput.className = "dsh-tw-note-title";
	titleInput.placeholder = "标题（默认时间戳）";
	const tagEditor = buildTagEditor();
	fields.append(titleInput, tagEditor.el);
	const editor = buildEditor();
	const textarea = editor.textarea;
	const uploadBtn = document.createElement("button");
	uploadBtn.type = "button";
	uploadBtn.className = "dsh-tw-note-upload";
	uploadBtn.title = "上传文件到 wiki 并插入 Markdown 链接（也可直接拖入编辑器）";
	uploadBtn.textContent = "📎 上传";
	const fileInput = document.createElement("input");
	fileInput.type = "file";
	fileInput.multiple = true;
	fileInput.hidden = true;
	uploadBtn.addEventListener("click", () => {
		fileInput.click();
	});
	fileInput.addEventListener("change", () => {
		for (const file of Array.from(fileInput.files ?? [])) uploadInto(file, editor);
		fileInput.value = "";
	});
	let dragDepth = 0;
	editor.el.addEventListener("dragenter", (event) => {
		event.preventDefault();
		dragDepth++;
		editor.el.classList.add("dsh-tw-note-drop");
	});
	editor.el.addEventListener("dragover", (event) => {
		event.preventDefault();
	});
	editor.el.addEventListener("dragleave", (event) => {
		event.preventDefault();
		dragDepth = Math.max(0, dragDepth - 1);
		if (dragDepth === 0) editor.el.classList.remove("dsh-tw-note-drop");
	});
	editor.el.addEventListener("drop", (event) => {
		event.preventDefault();
		dragDepth = 0;
		editor.el.classList.remove("dsh-tw-note-drop");
		const files = event.dataTransfer?.files;
		if (files === void 0 || files.length === 0) return;
		for (const file of Array.from(files)) uploadInto(file, editor);
	});
	const foot = document.createElement("div");
	foot.className = "dsh-tw-note-foot";
	const footLeft = document.createElement("div");
	footLeft.className = "dsh-tw-note-foot-left";
	const hint = document.createElement("span");
	hint.className = "dsh-tw-note-hint";
	hint.textContent = "Ctrl+Enter";
	footLeft.append(uploadBtn, hint);
	const footRight = document.createElement("div");
	footRight.className = "dsh-tw-note-foot-right";
	const edit = document.createElement("button");
	edit.type = "button";
	edit.className = "dsh-tw-note-edit";
	edit.title = "保存并在 TiddlyWiki 原生编辑器中打开";
	edit.textContent = "✏️ 在 TW 中编辑";
	const save = document.createElement("button");
	save.type = "button";
	save.className = "dsh-tw-note-save";
	save.textContent = "保存";
	footRight.append(edit, save);
	foot.append(footLeft, footRight);
	card.append(head, fields, editor.el, foot);
	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = "dsh-tw-note-toggle";
	toggle.textContent = "📝 快速笔记";
	root.append(card, toggle);
	document.body.append(root);
	let defaultTag = "inbox";
	let opened = false;
	const resetTitle = () => {
		titleInput.value = timestampTitle();
	};
	const open = async () => {
		card.hidden = false;
		opened = true;
		resetTitle();
		editor.focus();
		defaultTag = (await fetchUiOptions()).defaultTag;
		tagEditor.setDefault(defaultTag);
	};
	const close = () => {
		card.hidden = true;
		opened = false;
	};
	toggle.addEventListener("click", () => {
		opened ? close() : open();
	});
	closeBtn.addEventListener("click", close);
	const doSave = async () => {
		const text = textarea.value.trim();
		if (text.length === 0) {
			toast("内容为空，未保存");
			return;
		}
		save.disabled = true;
		save.textContent = "保存中…";
		try {
			const res = await fetch(NOTE_ENDPOINT, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					title: titleInput.value.trim(),
					tags: tagEditor.getTags(),
					text
				}),
				signal: AbortSignal.timeout(1e4)
			});
			const payload = await res.json().catch(() => null);
			if (!res.ok || payload?.ok !== true) {
				toast(`保存失败：${payload?.error ?? `HTTP ${res.status}`}`);
				return;
			}
			textarea.value = "";
			editor.render();
			resetTitle();
			toast(`已保存「${payload.title ?? titleInput.value}」`);
			close();
		} catch (err) {
			toast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
		} finally {
			save.disabled = false;
			save.textContent = "保存";
		}
	};
	save.addEventListener("click", () => {
		doSave();
	});
	textarea.addEventListener("keydown", (event) => {
		if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
			event.preventDefault();
			doSave();
		}
	});
	/** Save (if non-empty) and open the tiddler in TW's native editor. */
	const doEdit = async () => {
		const title = titleInput.value.trim().length > 0 ? titleInput.value.trim() : timestampTitle();
		const text = textarea.value;
		const tags = tagEditor.getTags();
		edit.disabled = true;
		edit.textContent = "打开中…";
		try {
			const res = await fetch(EDIT_ENDPOINT, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					title,
					tags,
					text
				}),
				signal: AbortSignal.timeout(1e4)
			});
			const payload = await res.json().catch(() => null);
			if (!res.ok || payload?.ok !== true) {
				toast(`打开失败：${payload?.error ?? `HTTP ${res.status}`}`);
				return;
			}
			if (typeof payload.twUrl !== "string" || typeof payload.draftTitle !== "string") {
				toast("打开失败：服务未返回编辑器地址");
				return;
			}
			openEditorPopup(`${payload.twUrl}#${encodeURIComponent(payload.draftTitle)}`, payload.title ?? title);
			toast(`已在弹出窗口打开「${payload.title ?? title}」编辑器`);
		} catch (err) {
			toast(`打开失败：${err instanceof Error ? err.message : String(err)}`);
		} finally {
			edit.disabled = false;
			edit.textContent = "✏️ 在 TW 中编辑";
		}
	};
	edit.addEventListener("click", () => {
		doEdit();
	});
	return root;
}
/**
* Mount the floating quick-note widget. Fetches /status first: when
* `ui.showQuickNote` is off the widget is never created (no DOM side effects).
* Returns a disposer that removes it.
*/
function mountNoteWidget() {
	let disposed = false;
	let root;
	const disposer = () => {
		disposed = true;
		root?.remove();
		document.querySelector(".dsh-tw-toast")?.remove();
	};
	(async () => {
		const ui = await fetchUiOptions();
		if (disposed || !ui.showQuickNote) return;
		root = buildWidget();
	})();
	return disposer;
}
//#endregion
//#region src/client/sync-button.ts
/**
* Floating "sync" button (bottom-right) — one click pulls + commits + pushes
* the wiki git repository and reports the result, with a live status dot so
* the human always sees whether the knowledge base is in sync.
*
* - honors `ui.showSyncButton`: the button is mounted async and never created
*   when the option is off (settings page toggle);
* - polls /dsh-tiddlywiki/status every 30s for the git state;
* - clicking POSTs /dsh-tiddlywiki/sync (pull → commit → push) and toasts the
*   outcome, then refreshes the dot immediately.
*
* Status dot mapping (git summary from /status):
*   offline → gray   (no repo / service unreachable)
*   dirty   → amber  (uncommitted changes)
*   behind  → red    (remote has commits we don't — pull will rebase)
*   clean   → green  (worktree clean)
*
* @module dsh-tiddlywiki/client/sync-button
*/
const STATUS_ENDPOINT = "/dsh-tiddlywiki/status";
const SYNC_ENDPOINT$1 = "/dsh-tiddlywiki/sync";
const POLL_MS = 3e4;
/** Inline sync icon (circular arrows, stroke-based, theme-colored). */
const SYNC_ICON = "<svg viewBox=\"0 0 16 16\" width=\"15\" height=\"15\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M13 8a5 5 0 1 1-1.4-3.5\"/><path d=\"M13 2.5v3h-3\"/></svg>";
function pad(n) {
	return n < 10 ? `0${n}` : String(n);
}
/** Compact local time for the tooltip (e.g. "10:32"). */
function clock(date) {
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
async function fetchStatus() {
	try {
		const res = await fetch(STATUS_ENDPOINT, { signal: AbortSignal.timeout(8e3) });
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}
/**
* Mount the floating sync button. Fetches /status first: when
* `ui.showSyncButton` is off the button is never created. Returns a disposer.
*/
function mountSyncButton() {
	let disposed = false;
	let root;
	let dot;
	let label;
	let lastSync;
	let timer;
	const build = () => {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "dsh-tw-sync";
		btn.title = "同步知识库（pull → commit → push）";
		const icon = document.createElement("span");
		icon.className = "dsh-tw-sync-icon";
		icon.innerHTML = SYNC_ICON;
		dot = document.createElement("span");
		dot.className = "dsh-tw-sync-dot";
		dot.dataset.state = "offline";
		label = document.createElement("span");
		label.className = "dsh-tw-sync-label";
		label.textContent = "同步";
		btn.append(icon, label, dot);
		btn.addEventListener("click", () => {
			doSync();
		});
		document.body.append(btn);
		return btn;
	};
	/** Map a git summary onto the dot + label + tooltip. */
	const applyStatus = (payload) => {
		if (root === void 0 || dot === void 0 || label === void 0) return;
		const git = payload?.git;
		const bits = ["同步知识库"];
		let state = "offline";
		let word = "离线";
		if (git === null || git === void 0 || git.exists !== true) bits.push("git 仓库不可用");
		else {
			bits.push(`分支 ${git.branch ?? "?"}`);
			if (typeof git.lastCommit === "string") bits.push(git.lastCommit);
			const behind = typeof git.behind === "number" ? git.behind : 0;
			const ahead = typeof git.ahead === "number" ? git.ahead : 0;
			if (ahead > 0) bits.push(`领先 ${ahead}`);
			if (behind > 0) bits.push(`落后 ${behind}`);
			if (git.dirty === true) {
				state = "dirty";
				word = "待提交";
				bits.push(`有 ${git.dirtyFiles?.length ?? 0} 个未提交改动`);
			} else if (behind > 0) {
				state = "behind";
				word = "可更新";
			} else {
				state = "clean";
				word = "已同步";
			}
		}
		if (lastSync !== void 0) bits.push(`上次同步 ${clock(lastSync)}`);
		root.title = bits.join(" · ");
		dot.dataset.state = state;
		label.textContent = word;
	};
	const doSync = async () => {
		if (root === void 0) return;
		root.disabled = true;
		root.classList.add("dsh-tw-sync-spin");
		if (label !== void 0) label.textContent = "同步中…";
		if (dot !== void 0) dot.dataset.state = "syncing";
		try {
			const res = await fetch(SYNC_ENDPOINT$1, {
				method: "POST",
				signal: AbortSignal.timeout(12e4)
			});
			const payload = await res.json().catch(() => null);
			lastSync = /* @__PURE__ */ new Date();
			if (payload === null || payload.ok !== true) toast(`同步失败：${payload?.error ?? payload?.message ?? `HTTP ${res.status}`}`);
			else {
				let detail = "";
				if (payload.push && payload.push !== "nothing to commit") detail = `（${payload.push}）`;
				if (payload.changed === true) {
					detail += payload.restarted === true ? "，TW 已重启" : "，TW 未自动重启";
					if (payload.restartError) detail += `（${payload.restartError}）`;
				}
				toast(`同步完成：${payload.message ?? "OK"}${detail}`);
			}
			applyStatus(await fetchStatus());
		} catch (err) {
			toast(`同步失败：${err instanceof Error ? err.message : String(err)}`);
		} finally {
			root.disabled = false;
			root.classList.remove("dsh-tw-sync-spin");
		}
	};
	const poll = async () => {
		applyStatus(await fetchStatus());
	};
	(async () => {
		const payload = await fetchStatus();
		if (disposed || payload?.ui?.showSyncButton === false) return;
		root = build();
		applyStatus(payload);
		timer = window.setInterval(() => {
			poll();
		}, POLL_MS);
	})();
	return () => {
		disposed = true;
		if (timer !== void 0) window.clearInterval(timer);
		root?.remove();
	};
}
//#endregion
//#region src/client/settings-page.ts
/**
* Settings-page half (design doc §13, config panel): a pure-DOM page mounted
* inside a `settings.section` React wrapper. Everything talks to the host
* admin routes — same-origin JSON, no client services beyond `slots`:
*
*   GET  /dsh-tiddlywiki/admin/state    current info + catalog + config
*   POST /dsh-tiddlywiki/admin/info     { plugins?, themes? } → restart TW
*   POST /dsh-tiddlywiki/admin/config   { ...patch }           → persist
*   POST /dsh-tiddlywiki/admin/restart  restart the TW child
*
* Sections:
*   1. 状态/重启      TW 运行状态 + git 概览 + 重启按钮
*   2. 常规配置       note.tag / git.* / uiLanguage（改了什么保存什么）
*   3. 插件管理       自带官方插件勾选（可搜索）→ 应用并重启 TW
*   4. 主题管理       自带主题单选 → 应用并重启 TW
*
* @module dsh-tiddlywiki/client/settings-page
*/
const STATE_ENDPOINT = "/dsh-tiddlywiki/admin/state";
const INFO_ENDPOINT = "/dsh-tiddlywiki/admin/info";
const CONFIG_ENDPOINT = "/dsh-tiddlywiki/admin/config";
const RESTART_ENDPOINT = "/dsh-tiddlywiki/admin/restart";
const SYNC_ENDPOINT = "/dsh-tiddlywiki/sync";
function make(tag, className, text) {
	const node = document.createElement(tag);
	if (className !== void 0) node.className = className;
	if (text !== void 0) node.textContent = text;
	return node;
}
async function fetchJson(url, init) {
	const res = await fetch(url, {
		...init,
		signal: AbortSignal.timeout(15e3)
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		const err = data.error ?? `HTTP ${res.status}`;
		throw new Error(err);
	}
	return data;
}
function mountSettingsPage(container) {
	let disposed = false;
	container.classList.add("dsh-tw-settings");
	const statusRow = make("div", "dsh-tw-settings-row dsh-tw-settings-status");
	const body = make("div", "dsh-tw-settings-body");
	container.append(statusRow, body);
	const disposers = [];
	const refresh = async () => {
		try {
			const state = await fetchJson(STATE_ENDPOINT);
			if (disposed) return;
			renderStatus(statusRow, state, refresh);
			renderMain(body, state, refresh);
		} catch (err) {
			if (disposed) return;
			body.replaceChildren();
			statusRow.replaceChildren();
			const msg = make("div", "dsh-tw-settings-error", `加载配置失败：${err instanceof Error ? err.message : String(err)}`);
			const retry = make("button", "dsh-tw-settings-btn", "重试");
			retry.type = "button";
			retry.addEventListener("click", () => {
				refresh();
			});
			body.append(msg, retry);
		}
	};
	refresh();
	disposers.push(() => {
		disposed = true;
		container.replaceChildren();
		container.classList.remove("dsh-tw-settings");
	});
	return () => {
		for (const dispose of disposers.splice(0)) dispose();
	};
}
function renderStatus(row, state, refresh) {
	row.replaceChildren();
	const server = state.server ?? {};
	const status = server.status ?? "unknown";
	const chip = make("span", `dsh-tw-settings-chip`, status);
	chip.dataset.state = status;
	const label = make("span", "dsh-tw-settings-muted", [
		server.url !== void 0 ? `TW ${server.url}` : "",
		state.git?.branch !== void 0 ? `git ${state.git.branch}` : "",
		state.git?.lastCommit !== void 0 ? state.git.lastCommit : "",
		state.git?.dirty === true ? "有未提交改动" : ""
	].filter(Boolean).join(" · "));
	const sync = make("button", "dsh-tw-settings-btn", "同步");
	sync.type = "button";
	sync.title = "git 同步（pull → commit → push）";
	sync.addEventListener("click", () => {
		sync.disabled = true;
		sync.textContent = "同步中…";
		(async () => {
			try {
				const res = await fetch(SYNC_ENDPOINT, {
					method: "POST",
					signal: AbortSignal.timeout(12e4)
				});
				const payload = await res.json().catch(() => null);
				if (!res.ok || payload?.ok !== true) toast(`同步失败：${payload?.error ?? payload?.message ?? `HTTP ${res.status}`}`);
				else {
					let detail = "";
					if (payload.changed === true) {
						detail += payload.restarted === true ? "，TW 已重启" : "，TW 未自动重启";
						if (payload.restartError) detail += `（${payload.restartError}）`;
					}
					toast(`同步完成：${payload.message ?? "OK"}${detail}`);
				}
			} catch (err) {
				toast(`同步失败：${err instanceof Error ? err.message : String(err)}`);
			} finally {
				sync.disabled = false;
				sync.textContent = "同步";
				refresh();
			}
		})();
	});
	const restart = make("button", "dsh-tw-settings-btn", "重启 TW");
	restart.type = "button";
	restart.addEventListener("click", () => {
		restart.disabled = true;
		restart.textContent = "重启中…";
		(async () => {
			try {
				await fetchJson(RESTART_ENDPOINT, { method: "POST" });
				toast("TW 已重启");
			} catch (err) {
				toast(`重启失败：${err instanceof Error ? err.message : String(err)}`);
			} finally {
				restart.disabled = false;
				restart.textContent = "重启 TW";
				refresh();
			}
		})();
	});
	row.append(chip, label, sync, restart);
}
/** Config section: fields bound to effective config, changed-only save. */
function renderConfigSection(body, config, refresh) {
	const section = make("section", "dsh-tw-settings-section");
	section.append(make("h3", "dsh-tw-settings-h", "常规配置"));
	const note = config.note ?? {};
	const git = config.git ?? {};
	const ui = config.ui ?? {};
	const fields = [];
	const textField = (key, label, initial) => {
		const input = make("input", "dsh-tw-settings-input");
		input.value = initial;
		const wrap = make("label", "dsh-tw-settings-field");
		wrap.append(make("span", "dsh-tw-settings-label", label), input);
		fields.push({
			key,
			input,
			initial,
			read: () => input.value.trim(),
			changed: () => input.value.trim() !== initial
		});
		section.append(wrap);
	};
	const checkField = (key, label, initial) => {
		const input = make("input", "dsh-tw-settings-check");
		input.type = "checkbox";
		input.checked = initial;
		const wrap = make("label", "dsh-tw-settings-field dsh-tw-settings-field-check");
		wrap.append(input, make("span", "dsh-tw-settings-label", label));
		fields.push({
			key,
			input,
			initial,
			read: () => input.checked,
			changed: () => input.checked !== initial
		});
		section.append(wrap);
	};
	const numField = (key, label, initial) => {
		const input = make("input", "dsh-tw-settings-input");
		input.type = "number";
		input.value = String(initial);
		const wrap = make("label", "dsh-tw-settings-field");
		wrap.append(make("span", "dsh-tw-settings-label", label), input);
		fields.push({
			key,
			input,
			initial,
			read: () => Number(input.value) || initial,
			changed: () => (Number(input.value) || initial) !== initial
		});
		section.append(wrap);
	};
	textField("note.tag", "快速笔记默认 tag", typeof note.tag === "string" ? note.tag : "inbox");
	checkField("git.autoCommit", "自动 commit（防抖）", git.autoCommit !== false);
	numField("git.debounceMs", "自动 commit 防抖(ms)", typeof git.debounceMs === "number" ? git.debounceMs : 6e4);
	textField("git.remote", "git 远端（空=仅本地）", typeof git.remote === "string" ? git.remote : "");
	textField("git.branch", "git 分支", typeof git.branch === "string" ? git.branch : "main");
	checkField("ui.showQuickNote", "显示「快速笔记」悬浮按钮", ui.showQuickNote !== false);
	checkField("ui.showPanelStatus", "显示 TW 面板右下角「状态/重载」悬浮按钮", ui.showPanelStatus !== false);
	checkField("ui.showSyncButton", "显示右下角「同步」悬浮按钮", ui.showSyncButton !== false);
	const save = make("button", "dsh-tw-settings-btn dsh-tw-settings-primary", "保存配置");
	save.type = "button";
	save.addEventListener("click", () => {
		save.disabled = true;
		(async () => {
			const patch = {};
			for (const field of fields) {
				if (!field.changed()) continue;
				const parts = field.key.split(".");
				if (parts.length === 1) {
					const key = parts[0];
					if (key !== void 0) patch[key] = field.read();
				} else {
					const [top, rest] = parts;
					const obj = patch[top] ?? {};
					obj[rest] = field.read();
					patch[top] = obj;
				}
			}
			try {
				await fetchJson(CONFIG_ENDPOINT, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(patch)
				});
				toast("配置已保存");
				refresh();
			} catch (err) {
				toast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
			} finally {
				save.disabled = false;
			}
		})();
	});
	section.append(save);
	body.append(section);
}
/** Plugin/theme manager: checkboxes/radios + apply (writes info, restarts). */
function renderCatalogSection(body, info, catalog, refresh) {
	const plugins = catalog?.plugins ?? [];
	const themes = catalog?.themes ?? [];
	const languages = catalog?.languages ?? [];
	const activePlugins = new Set(info?.plugins ?? []);
	const loadedThemes = new Set(info?.themes ?? []);
	const activeLanguages = new Set(info?.languages ?? []);
	const pluginSection = make("section", "dsh-tw-settings-section");
	pluginSection.append(make("h3", "dsh-tw-settings-h", "插件管理（自带官方插件）"));
	const search = make("input", "dsh-tw-settings-input dsh-tw-settings-search");
	search.placeholder = "搜索插件…";
	const listWrap = make("div", "dsh-tw-settings-list");
	const applyPlugins = make("button", "dsh-tw-settings-btn dsh-tw-settings-primary", "应用插件（重启 TW）");
	applyPlugins.type = "button";
	const renderPluginList = (needle) => {
		listWrap.replaceChildren();
		const q = needle.toLowerCase();
		for (const plugin of plugins) {
			if (q.length > 0 && !`${plugin.label} ${plugin.name} ${plugin.description}`.toLowerCase().includes(q)) continue;
			const input = make("input", "dsh-tw-settings-check");
			input.type = "checkbox";
			input.checked = activePlugins.has(plugin.name);
			input.addEventListener("change", () => {
				if (input.checked) activePlugins.add(plugin.name);
				else activePlugins.delete(plugin.name);
			});
			const label = make("label", "dsh-tw-settings-row dsh-tw-settings-plugin");
			const name = make("span", "dsh-tw-settings-name", plugin.label);
			name.title = plugin.name;
			const desc = make("span", "dsh-tw-settings-muted", plugin.description || plugin.name);
			label.append(input, name, desc);
			listWrap.append(label);
		}
	};
	search.addEventListener("input", () => renderPluginList(search.value));
	applyPlugins.addEventListener("click", () => {
		applyPlugins.disabled = true;
		(async () => {
			try {
				await fetchJson(INFO_ENDPOINT, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ plugins: [...activePlugins] })
				});
				toast("插件已应用，TW 已重启");
				refresh();
			} catch (err) {
				toast(`应用失败：${err instanceof Error ? err.message : String(err)}`);
				applyPlugins.disabled = false;
			}
		})();
	});
	renderPluginList("");
	pluginSection.append(search, listWrap, applyPlugins);
	body.append(pluginSection);
	const themeSection = make("section", "dsh-tw-settings-section");
	themeSection.append(make("h3", "dsh-tw-settings-h", "主题管理（自带主题）"));
	const themeHint = make("div", "dsh-tw-settings-muted", "「加载」= TW 里可用的主题（可多选，依赖链自动带上，如 heavier 会带 snowwhite+vanilla）；「活动」= 当前视觉主题（单选，自动加入加载集）。应用后重启 TW。");
	const themeHead = make("div", "dsh-tw-settings-row dsh-tw-settings-head");
	themeHead.append(make("span", "dsh-tw-settings-col", "加载"), make("span", "dsh-tw-settings-col", "活动"), make("span", "dsh-tw-settings-name", "主题"));
	const themeList = info?.themes ?? [];
	let activeThemeName = themeList.length > 0 ? themeList[themeList.length - 1] : "tiddlywiki/vanilla";
	const themeWrap = make("div", "dsh-tw-settings-list");
	for (const theme of themes) {
		const load = make("input", "dsh-tw-settings-check");
		load.type = "checkbox";
		load.checked = loadedThemes.has(theme.name);
		load.title = "加载该主题";
		load.addEventListener("change", () => {
			if (load.checked) loadedThemes.add(theme.name);
			else loadedThemes.delete(theme.name);
		});
		const act = make("input", "dsh-tw-settings-check");
		act.type = "radio";
		act.name = "dsh-tw-active-theme";
		act.checked = theme.name === activeThemeName;
		act.title = "设为活动主题";
		act.addEventListener("change", () => {
			if (act.checked) activeThemeName = theme.name;
		});
		const name = make("span", "dsh-tw-settings-name", theme.label);
		name.title = theme.name;
		const desc = make("span", "dsh-tw-settings-muted", theme.description || theme.name);
		const row = make("div", "dsh-tw-settings-row dsh-tw-settings-plugin");
		row.append(load, act, name, desc);
		themeWrap.append(row);
	}
	const applyThemes = make("button", "dsh-tw-settings-btn dsh-tw-settings-primary", "应用主题（重启 TW）");
	applyThemes.type = "button";
	applyThemes.addEventListener("click", () => {
		applyThemes.disabled = true;
		(async () => {
			try {
				await fetchJson(INFO_ENDPOINT, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						themes: [...loadedThemes],
						themeActive: activeThemeName
					})
				});
				toast("主题已应用，TW 已重启");
				refresh();
			} catch (err) {
				toast(`应用失败：${err instanceof Error ? err.message : String(err)}`);
				applyThemes.disabled = false;
			}
		})();
	});
	themeSection.append(themeHint, themeHead, themeWrap, applyThemes);
	body.append(themeSection);
	const langSection = make("section", "dsh-tw-settings-section");
	langSection.append(make("h3", "dsh-tw-settings-h", "语言管理（自带官方语言包）"));
	const langHint = make("div", "dsh-tw-settings-muted", "勾选启用语言插件并重启 TW；如中文请选 zh-Hans（简体）或 zh-CN。");
	const langWrap = make("div", "dsh-tw-settings-list");
	for (const lang of languages) {
		const input = make("input", "dsh-tw-settings-check");
		input.type = "checkbox";
		input.checked = activeLanguages.has(lang.name);
		input.addEventListener("change", () => {
			if (input.checked) activeLanguages.add(lang.name);
			else activeLanguages.delete(lang.name);
		});
		const label = make("label", "dsh-tw-settings-row dsh-tw-settings-plugin");
		const name = make("span", "dsh-tw-settings-name", lang.label);
		name.title = lang.name;
		const desc = make("span", "dsh-tw-settings-muted", lang.description || lang.name);
		label.append(input, name, desc);
		langWrap.append(label);
	}
	const applyLangs = make("button", "dsh-tw-settings-btn dsh-tw-settings-primary", "应用语言（重启 TW）");
	applyLangs.type = "button";
	applyLangs.addEventListener("click", () => {
		applyLangs.disabled = true;
		(async () => {
			try {
				await fetchJson(INFO_ENDPOINT, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ languages: [...activeLanguages] })
				});
				toast("语言已应用，TW 已重启");
				refresh();
			} catch (err) {
				toast(`应用失败：${err instanceof Error ? err.message : String(err)}`);
				applyLangs.disabled = false;
			}
		})();
	});
	langSection.append(langHint, langWrap, applyLangs);
	body.append(langSection);
}
function renderMain(body, state, refresh) {
	body.replaceChildren();
	renderConfigSection(body, state.config ?? {}, refresh);
	renderCatalogSection(body, state.info, state.catalog, refresh);
}
/** React wrapper consumed by the shell's settings.section slot. */
function SettingsSection() {
	const ref = react.useRef(null);
	react.useEffect(() => {
		const el = ref.current;
		return el === null ? void 0 : mountSettingsPage(el);
	}, []);
	return react.createElement("div", { ref });
}
//#endregion
//#region src/client/index.ts
/**
* Browser half entry for dsh-tiddlywiki (design doc §12, D5): injects the
* stylesheet, mounts the sidebar entry, the center-column TiddlyWiki panel,
* the floating quick-note widget, and registers the plugin's settings page
* (config panel, §13) into the shell's Settings.
*
* Failure policy: DOM mounting problems are logged, never thrown — the web
* shell fails the whole boot when a plugin apply throws.
*
* Export shape: `name` / `inject` / `apply`, no default.
*
* @module dsh-tiddlywiki/client
*/
/** Client plugin name. */
const name = "dsh-tiddlywiki/client";
/** Required client services: the slots registry (settings.section seat). */
const inject = ["slots"];
/**
* Client entry: installs styles and mounts the DOM seats + settings page.
* @param ctx - the cordis client context.
*/
function apply(ctx) {
	try {
		injectStyles();
		const state = new PanelState();
		const disposers = [];
		try {
			disposers.push(mountSidebarEntry(state));
			disposers.push(mountPanel(state));
			disposers.push(mountNoteWidget());
			disposers.push(mountSyncButton());
			disposers.push(disposeEditorPopup);
		} catch (error) {
			console.error("[dsh-tiddlywiki] mount failed:", error);
		}
		try {
			const removeSettings = ctx.slots?.inject("settings.section", () => ctx.slots?.register({
				name: "settings.section",
				id: "dsh-tiddlywiki",
				order: 50,
				label: "TiddlyWiki 知识库"
			}, SettingsSection));
			if (removeSettings !== void 0) disposers.push(removeSettings);
		} catch (error) {
			console.error("[dsh-tiddlywiki] settings section failed:", error);
		}
		ctx.effect?.(() => () => {
			for (const dispose of disposers.splice(0)) dispose();
		}, "dsh-tiddlywiki: client mount");
	} catch (error) {
		console.error("[dsh-tiddlywiki] client half failed to start:", error);
	}
}
//#endregion
exports.apply = apply;
exports.inject = inject;
exports.name = name;

		return module.exports;
	}
});

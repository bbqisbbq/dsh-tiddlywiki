/**
 * tw-frame 的**公共 API 层**（v0.30.28 从 tw-frame.ts 拆出，**纯搬迁**）。
 *
 * 这里只有「别的模块要用 tw-frame 的什么」：两个事件名、面板重载/重启请求、
 * 标签文字、标签图标、以及「这份 dataset 能不能直接当 iframe src 用」的判定。
 * 它们全是**模块级**的、彼此不依赖 `createTwFrameSurface()` 这个 444 行的内核，
 * 也不引用文件后半部分的任何东西 —— 所以搬出去不会造出回指 base 的环。
 *
 * 拆出来的理由：此前「公共 API」与「内核实现」混在一个 736 行的文件里，
 * 想看内核的人得先翻过一堆导出；而想用 API 的人也不该 import 一个装着整个
 * 生命周期状态机的模块。tw-frame.ts 原样再导出这些名字，**外部导入路径不变**。
 *
 * @module dsh-tiddlywiki/client/tw-frame-api
 */
import * as React from 'react'
import { t } from './i18n.ts'
import { RESTART_ENDPOINT } from './endpoints.ts'


export const ACTIVATE_EVENT = 'dsh-panel-activate'
/** The "知识库" FAB's reload event; side frames reload with the center one. */
export const PANEL_RELOAD_EVENT = 'dsh-tw-panel-reload'

/**
 * Ask every mounted TW surface to reload the document it is already showing
 * (v0.30.14).
 *
 * The event exists since v0.22.4, but until now only the FAB's 「重新载入」 item
 * fired it — every path that restarts the TW child *in place* left the open
 * panel rendering the pre-restart document, whose tiddlers may not even exist
 * any more. The named call is what those paths use instead of hand-rolling a
 * `new CustomEvent(...)` and hoping the event name is spelled the same.
 *
 * What a surface does is its own business (see `onReloadRequest`): a frame that
 * never loaded a TW URL is left untouched, and a frame that did is re-assigned
 * the SAME url so TW re-reads the wiki from scratch.
 */
export function reloadTwSurfaces(): void {
  document.dispatchEvent(new CustomEvent(PANEL_RELOAD_EVENT))
}

/**
 * Tab chip / + menu / guide copy default (label refreshed from `/status` ui.tabLabel).
 *
 * v0.30.13: the fallback is resolved LAZILY in `getTabLabel()` — a module-level
 * `t(...)` would freeze whichever language happened to be cached when the bundle
 * loaded, and a language change would never show up on this surface.
 */
let tabLabel: string | undefined

/** Update the shared surface label from the live config (ui.tabLabel). */
export function setTabLabel(label: string | undefined): void {
  const trimmed = typeof label === 'string' ? label.trim() : ''
  if (trimmed.length > 0) tabLabel = trimmed
}

/** Current shared surface label (ui.tabLabel, default 「知识库」/「Knowledge base」). */
export function getTabLabel(): string {
  return tabLabel ?? t('frame.tabLabelDefault')
}

/** POST /restart; `false` on any failure. Shared by both TW surfaces (v0.22.3). */
export async function requestRestart(): Promise<boolean> {
  try {
    const res = await fetch(RESTART_ENDPOINT, { method: 'POST', signal: AbortSignal.timeout(8_000) })
    return res.ok
  } catch {
    return false
  }
}

/** The shared surface glyph: a wiki page with a TiddlyWiki-style "T". */
export function TwTabIcon({ size = 16, className }: { size?: number; className?: string }): React.ReactElement {
  return React.createElement(
    'svg',
    { width: size, height: size, className, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    React.createElement('path', { d: 'M4 2.5h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z' }),
    React.createElement('path', { d: 'M6 6h4M6 8.5h2.5' }),
  )
}

/**
 * The last URL a TW surface actually assigned to its iframe, or null when the
 * frame never loaded one. Both surfaces cache it in `iframe.dataset.loaded`
 * (only `showFrame` writes it), which keeps "is this frame pointing at the TW
 * proxy?" answerable without trusting `src` — see `loadableFrameUrl`.
 */
export interface FrameLoadedState {
  loaded?: string
}

/**
 * Non-empty `dataset.loaded`, or null when the frame has no real URL yet
 * (v0.22.3). NEVER read `iframe.src` for this: for an iframe whose `src`
 * attribute was never assigned the property returns the EMBEDDING page's URL,
 * and assigning it back to `src` makes the DSH GUI load itself inside the
 * iframe (a second DSH instance: duplicate FAB, duplicated global listeners,
 * blank white page). Every full-reload path must refuse to touch a frame that
 * has no loaded TW URL.
 */
export function loadableFrameUrl(dataset: FrameLoadedState): string | null {
  const loaded = dataset.loaded
  return loaded === undefined || loaded.length === 0 ? null : loaded
}

/* ────────────────────────── the shared frame kernel ─────────────────────── */


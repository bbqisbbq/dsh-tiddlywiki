/**
 * Shared TiddlyWiki iframe machinery for DSH side surfaces (v0.16.23).
 *
 * The center-column panel and the native right-sidebar tab (rightbar-tab.ts)
 * both embed the SAME-ORIGIN
 * TW proxy (`/dsh-tiddlywiki/tw/`) in an iframe and share the same lifecycle:
 * lazy-load on first show, `/status` polling with restart/error states, DSH
 * theme sync, reload-on-FAB-event, and tiddler-hash navigation. This module
 * owns that machinery — `createTwFrameSurface()` is the ONE implementation —
 * plus the two small shared bits of state the surfaces mirror (the tab chip
 * label from `ui.tabLabel` and the tab icon).
 *
 * v0.22.4 convergence: `panel.ts` used to carry its own copies of
 * showError/showStarting/showFrame/fallbackLoad/doRefresh. They drifted, and
 * the drift is exactly what produced the v0.22.3 empty-`src` bug (one copy got
 * the guard, the other did not). A surface now supplies only its SKIN (class
 * names), its lazy build point and its visibility; every lifecycle decision
 * lives here. Add new lifecycle behaviour in this file, never at a call site.
 *
 * Link routing: each mounted TW surface registers its live frame controller
 * here; panel.ts asks `openTiddlerInLiveTab` first, so a wiki link lands in a
 * visible side TW tab (the native rightbar tab) before falling back to the
 * center overlay. Mutual exclusion (one TW client at a time) rides the
 * `dsh-panel-activate` protocol — each surface dispatches its own panel name
 * on becoming visible and closes itself when another name activates.
 *
 * @module dsh-tiddlywiki/client/tw-frame
 */
import * as React from 'react'
import { RESTART_ENDPOINT, resolveTwUrl, twProxyFor } from './endpoints.ts'
import { fetchStatus, type StatusPayload } from './status-cache.ts'
import { getFocusWiki, subscribeFocusWiki } from './wiki-focus.ts'
import { attachThemeSync, setThemeSyncConfig } from './theme-sync.ts'

/** Cross-plugin activation event; detail is the activating panel name. */
export const ACTIVATE_EVENT = 'dsh-panel-activate'
/** The "知识库" FAB's reload event; side frames reload with the center one. */
export const PANEL_RELOAD_EVENT = 'dsh-tw-panel-reload'

/** Tab chip / + menu / guide copy default (label refreshed from `/status` ui.tabLabel). */
let tabLabel = '知识库'

/** Update the shared surface label from the live config (ui.tabLabel). */
export function setTabLabel(label: string): void {
  const trimmed = typeof label === 'string' ? label.trim() : ''
  if (trimmed.length > 0) tabLabel = trimmed
}

/** Current shared surface label (ui.tabLabel, default 「知识库」). */
export function getTabLabel(): string {
  return tabLabel
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

/** Per-surface skin: the class names (and inline style) a surface wears. */
export interface TwFrameSkin {
  /** Wrapper filling the surface body (owns the flex chain). */
  view: string
  /** `data-*` attributes for the view wrapper (panel tags it for its CSS). */
  viewDataset?: Record<string, string>
  /** Wrapper around the iframe. */
  frameWrap: string
  /** Inline style for the frame wrapper (the panel's has no stylesheet rule). */
  frameWrapStyle?: string
  /** The TW iframe. */
  frame: string
  /** Error / starting panel. */
  error: string
  /** Hint shown while a DIFFERENT wiki's document is on the wire (v0.28.14). */
  loading: string
}

/**
 * Which knowledge base a link belongs to (v0.28.11).
 *
 *   - `string`    —— 该库的 id；
 *   - `null`      —— **明确**要默认库（卡片/列表行说得出自己来自哪个库，
 *                    默认库就是 `undefined` 那个语义的显式说法）；
 *   - `undefined` —— 未指定：跟随该 surface 的 `wikiId` hook（当前焦点库）。
 *
 * 三者必须分得开：从前 `undefined` 既表示"默认库"又表示"未指定"，于是多库下
 * 点卡片上的「在 TW 打开」永远落在**最后一次打开的库**上（作者 2026-09-29 报障）。
 */
export type TwWikiTarget = string | null | undefined

/** A TW iframe surface: DOM + lifecycle, shared by every embedding surface. */
export interface TwFrameSurface {
  /**
   * Build the surface DOM (view wrapper + iframe + error area) and return the
   * view element; the CALLER decides where to append it. Idempotent, and safe
   * to call AFTER `setVisible(true)`: a surface asked to show before its DOM
   * existed (the panel builds lazily, once the center column appears) re-arms
   * its `/status` load right here instead of stranding an empty surface.
   */
  build(): HTMLDivElement
  /**
   * Reflect visibility. The first `true` starts the lazy load and is the only
   * thing that reveals the frame; `false` hides it and stops the bounded
   * retry polling, so a later `true` starts a fresh budget. Only a frame that
   * already carries a TW URL is ever revealed.
   */
  setVisible(visible: boolean): void
  /**
   * Open a tiddler by title; false when this surface cannot serve it.
   *
   * `wiki` (v0.28.11) names the knowledge base the link belongs to — see
   * `TwWikiTarget`. When it differs from the wiki this frame is showing, the
   * frame reloads at `/tw/<id>/` FIRST and only then navigates (otherwise the
   * hash lands in the outgoing document and the reload swallows it).
   */
  openTiddler(title: string, wiki?: TwWikiTarget): boolean
  /** Tear down listeners/timers/theme sync and remove the view from the DOM. */
  dispose(): void
}

/**
 * Create the frame machinery for one surface. Every `/status`-driven decision
 * (starting / error / running, iframe URL, theme config, shared chip label)
 * and every tiddler-hash navigation is implemented here ONCE.
 */
/**
 * Per-surface hooks (v0.28.0). `wikiId` answers "which knowledge base should
 * this surface embed?" — the center panel and the rightbar tab both embed the
 * wiki the user focused, and reload when that choice changes.
 */
export interface TwFrameHooks {
  wikiId?: () => string | undefined
}

export function createTwFrameSurface(skin: TwFrameSkin, hooks: TwFrameHooks = {}): TwFrameSurface {
  let visible = false
  let started = false
  let disposed = false
  let view: HTMLDivElement | undefined
  let frame: HTMLIFrameElement | undefined
  let errorArea: HTMLDivElement | undefined
  let loadingEl: HTMLDivElement | undefined
  let refreshTimer: number | undefined
  /** "Switching wiki" hint timer (v0.28.14). */
  let switchTimer: number | undefined
  /**
   * The last successful `/status` payload (v0.28.14).
   *
   * A wiki switch needs only two things from it — `mode` and the proxy bases — and we
   * already have them from the refresh that opened the current wiki. Re-fetching costs
   * a full round-trip (the host runs up to five `git` processes per `/status`, measured
   * 300–400 ms here), which used to sit BETWEEN the click and the start of the switch.
   */
  let lastStatus: StatusPayload | undefined
  /** In-flight hash-readiness retry timers (cancelled by dispose, v0.19.1). */
  const hashWaitTimers = new Set<number>()
  let refreshAttempts = 0
  let frameLoaded = false
  let pendingHash: string | null = null
  /**
   * Which wiki the iframe currently points at, and whether a switch to another
   * one is still in flight (v0.28.11).
   *
   * A link names the wiki it belongs to; when that differs from the wiki the
   * frame is showing, the frame must RELOAD at `/tw/<id>/` BEFORE the hash is
   * applied. Applying it first puts the hash in the outgoing document (wrong
   * wiki, or "找不到条目"), and the reload that follows clears `pendingHash`,
   * so the navigation is silently lost. `wikiSwitchPending` is what makes the
   * hash wait; `showFrame()` clears it once the refresh has run.
   */
  let frameWiki: string | undefined
  let frameWikiKnown = false
  let wikiSwitchPending = false
  let themeSyncDispose: (() => void) | undefined

  /** Cancel the pending bounded retry (a new refresh supersedes it). */
  const clearRetry = (): void => {
    if (refreshTimer !== undefined) {
      window.clearTimeout(refreshTimer)
      refreshTimer = undefined
    }
  }

  const showError = (message: string): void => {
    if (frame === undefined || errorArea === undefined) return
    hideSwitching()
    frame.hidden = true
    errorArea.hidden = false
    errorArea.replaceChildren()
    const p = document.createElement('div')
    p.textContent = 'TiddlyWiki 服务不可用'
    const code = document.createElement('code')
    code.textContent = message
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.textContent = '重试'
    retry.addEventListener('click', () => {
      retry.disabled = true
      retry.textContent = '重启中…'
      void requestRestart().finally(() => { void doRefresh() })
    })
    errorArea.append(p, code, retry)
  }

  const showStarting = (): void => {
    if (frame === undefined || errorArea === undefined) return
    hideSwitching()
    frame.hidden = true
    errorArea.hidden = false
    errorArea.replaceChildren()
    const p = document.createElement('div')
    p.textContent = 'TiddlyWiki 服务正在启动…'
    errorArea.append(p)
  }

  /** Cancel the "switching wiki" hint's safety timer. */
  const clearSwitchTimer = (): void => {
    if (switchTimer !== undefined) {
      window.clearTimeout(switchTimer)
      switchTimer = undefined
    }
  }

  /** Drop the "loading another wiki" hint (the new document arrived, or we gave up). */
  const hideSwitching = (): void => {
    clearSwitchTimer()
    if (loadingEl !== undefined) loadingEl.hidden = true
  }

  /**
   * Say 「正在载入知识库「X」…」 while a DIFFERENT wiki's document is on the wire.
   *
   * WHY (v0.28.14，作者报障「点击切换感觉会卡那么一下」): 一个 iframe 只能装一份 TW
   * 文档，换库 = 重新下载并解析**整份** wiki。本机实测这份文档是 **9.9 MB / 29.9 MB /
   * 28 MB**，而且 TW 自己回 `Cache-Control: no-store`、没有 ETag —— 既缓存不了也预取不了。
   * 这段时间界面完全不动，用户只能感觉"卡住了"。加载时长不是这套代码能把控的，但**界面
   * 必须说清正在发生什么**（否则一次正常的 1–2 秒等待看起来就是"卡死/没反应"）。
   *
   * 兜底 15s：`load` 万一不来（库没起来 / 服务挂了），提示不能永久挂在界面上 —— 那条路径
   * 由 showError/showStarting 接管。
   */
  const showSwitching = (label: string): void => {
    if (loadingEl === undefined) return
    loadingEl.textContent = `正在载入知识库「${label}」…`
    loadingEl.hidden = false
    clearSwitchTimer()
    switchTimer = window.setTimeout(() => { switchTimer = undefined; hideSwitching() }, 15_000)
  }

  /** A wiki's display name, from the last roster we saw (falls back to its id). */
  const wikiLabel = (id: string): string => lastStatus?.wikis?.find((w) => w.id === id)?.label ?? id

  const showFrame = (url: string, wiki: string | undefined, label?: string): void => {
    if (frame === undefined || errorArea === undefined) return
    errorArea.hidden = true
    // Only reveal the frame while the surface is on screen: doRefresh() can
    // still be in flight after the surface was hidden, and an unconditional
    // `hidden = false` would pop a closed surface back into view.
    frame.hidden = !visible
    frameWiki = wiki
    frameWikiKnown = true
    // Set the src only when the url changed, so an editor never loses unsaved
    // state on a status refresh.
    if (frame.dataset.loaded !== url) {
      frame.dataset.loaded = url
      frameLoaded = false
      frame.src = url
      // 换了文档 = 重新下载整份 wiki（10–30MB、no-store）：这段时间必须给个可见说明。
      if (label !== undefined) showSwitching(label)
    }
    // 换库这一步到此为止（url 没变也算了结：单库模式下两个 id 解析出同一条裸路径）。
    // 迟到的 hash 请求现在才允许落地 —— src 真的换了就等 load 事件再调一次。
    wikiSwitchPending = false
    if (pendingHash !== null) applyPendingHash()
  }

  /**
   * Apply a pending tiddler-hash navigation once the iframe document is ready.
   * Preferred: same-origin `contentWindow.location.hash` — a hashchange INSIDE
   * the frame (no reload), TW's story handler opens the tiddler. Fallback: a
   * full `iframe.src` reload with the hash (TW auto-saves drafts, acceptable).
   *
   * TW registers its hashchange listener in a STARTUP module that runs after
   * the iframe's `load` event, so setting `location.hash` right on load is a
   * no-op (hash lost → TW stays on its home page). We therefore wait for TW to
   * become ready inside the frame (the `$tw` global appears once boot settles)
   * before setting the hash; if it never does (service down / slow boot) we
   * fall back to a full reload with the hash, which TW processes at startup.
   * A newer open request supersedes an in-flight wait.
   */
  const applyPendingHash = (): void => {
    if (pendingHash === null || frame === undefined || !frameLoaded) return
    // 换库还没完成：此刻写 hash 只会落进**正在被替换**的那份文档。
    if (wikiSwitchPending) return
    const hash = pendingHash
    const win = frame.contentWindow
    if (win === null) {
      fallbackLoad(hash)
      return
    }
    const tryOnce = (attempt: number): void => {
      if (disposed) return // unmounted: do not keep waiting or touch the frame
      if (pendingHash !== hash) return // superseded by a newer request
      // Cross-origin frame (v0.26.7): on the DSH desktop app the TW frame is
      // loaded from the host's loopback HTTP origin — the only way TW's
      // TiddlyWeb sync adaptor will load there — which makes it a different
      // origin than the DSH page. Reading `$tw` inside it raises SecurityError,
      // so we cannot watch for TW's boot: go straight to the full
      // reload-with-hash fallback (TW honours the hash at startup).
      let frameIsTw = false
      try {
        const frameTw = win as { $tw?: unknown }
        frameIsTw = typeof frameTw.$tw === 'object' && frameTw.$tw !== null
      } catch {
        fallbackLoad(hash)
        return
      }
      if (!frameIsTw) {
        if (attempt < 40) {
          // Tracked so dispose() cancels the chain (v0.19.1 — the untracked
          // 40×150ms retry kept the iframe/closure alive after unmount).
          const timer = window.setTimeout(() => {
            hashWaitTimers.delete(timer)
            tryOnce(attempt + 1)
          }, 150)
          hashWaitTimers.add(timer)
          return
        }
        fallbackLoad(hash)
        return
      }
      pendingHash = null
      try {
        if (win.location.hash !== hash) win.location.hash = hash
      } catch {
        fallbackLoad(hash)
      }
    }
    tryOnce(0)
  }

  const fallbackLoad = (hash: string): void => {
    if (disposed || frame === undefined) return // never drive a detached frame
    if (pendingHash === hash) pendingHash = null
    // Guard against the never-loaded frame: `frame.src` is '' before showFrame
    // ran, and `'' + '#title'` resolves against the DSH page URL, which loads
    // the GUI into the iframe (v0.22.3).
    const base = loadableFrameUrl(frame.dataset)
    if (base === null) return
    const next = `${base.split('#')[0]}${hash}`
    if (frame.src !== next) frame.src = next
  }

  const doRefresh = async (): Promise<void> => {
    clearRetry()
    const payload = await fetchStatus()
    if (disposed) return // unmounted while fetching: stop, don't touch DOM
    // Re-check VISIBILITY after the await (v0.22.8). setVisible(false) clears the
    // pending retry and resets refreshAttempts — but a /status call already in
    // flight could land afterwards and take the `starting` branch below, arming a
    // BRAND NEW 30×1.5s budget on a hidden surface (and revealing the starting
    // panel on it). That contradicts setVisible's own contract and re-creates the
    // /status polling load (each call can spawn up to five host git processes)
    // that status-cache exists to bound.
    if (!visible) return
    if (payload === null) {
      showError('无法访问 /dsh-tiddlywiki/status')
      return
    }
    // 记住这一份：换库要用它的 mode / 代理基址 / 名册（见 switchFrameNow 与 wikiLabel）。
    lastStatus = payload
    if (payload.ui !== undefined) {
      // Shared surface label + theme config: both are module-level, so any
      // surface that polls keeps them fresh for every other surface.
      setTabLabel(payload.ui.tabLabel ?? tabLabel)
      setThemeSyncConfig({
        enabled: payload.ui.followDshTheme !== false,
        darkPalette: payload.ui.darkPalette,
      })
    }
    if (payload.status === 'running') {
      refreshAttempts = 0
      // Same-origin proxy URL: build from the page's own origin so it works no
      // matter which host/domain the user reached DSH on. Fall back to the
      // legacy loopback `url` for older servers that do not send twProxy.
      if (typeof payload.twProxy === 'string') {
        // resolveTwUrl prefers the host's ABSOLUTE loopback base when THIS page
        // is not on http(s) (the DSH desktop app's `dsh-app:` renderer), because
        // TW refuses to load its sync adaptor anywhere else — see resolveTwUrl.
        // WHICH knowledge base (v0.28.0): the focused one in multi mode, else the
        // bare path (= the default wiki, exactly as before).
        const wiki = hooks.wikiId?.()
        const bases = twProxyFor(payload.mode, wiki, payload.twProxy, payload.twProxyAbsolute)
        showFrame(resolveTwUrl(bases.relative, bases.absolute), wiki, wiki === undefined ? undefined : wikiLabel(wiki))
      } else if (typeof payload.url === 'string') {
        const wiki = hooks.wikiId?.()
        showFrame(payload.url, wiki, wiki === undefined ? undefined : wikiLabel(wiki))
      } else {
        showError('服务未返回编辑器地址')
      }
      return
    }
    if (payload.status === 'starting') {
      showStarting()
      if (refreshAttempts < 30) {
        refreshAttempts++
        refreshTimer = window.setTimeout(() => { void doRefresh() }, 1_500)
      }
      return
    }
    refreshAttempts = 0
    showError(payload.error ?? `服务状态：${payload.status}`)
  }

  const onReloadRequest = (): void => {
    // Reload = re-assign the URL the frame is ALREADY showing (full reload, so
    // TW re-reads the wiki; `location.reload()` could be blocked mid-edit).
    // The ONLY valid condition is `dataset.loaded` (v0.22.3): `frame.src` is ''
    // before showFrame ran, and `frame.src = frame.src` with `src === ''` loads
    // the DSH page into the iframe.
    // Deliberately NOT gated on `frame.hidden`: the FAB entry is an EXPLICIT
    // reload request, so it must reach every frame that really points at TW —
    // including a closed panel that would otherwise reopen onto stale assets
    // (v0.22.4; the panel used to reload in that state). An extra reload costs
    // less than showing stale content.
    if (frame === undefined) return
    const loaded = loadableFrameUrl(frame.dataset)
    if (loaded !== null) frame.src = loaded
  }
  document.addEventListener(PANEL_RELOAD_EVENT, onReloadRequest)

  /**
   * Point the frame at the focused wiki RIGHT NOW, using the last `/status` payload.
   *
   * v0.28.14（作者报障「点击切换感觉会卡那么一下」）：旧实现只调 `doRefresh()`，而它要**先**
   * 等一次 `/status` 往返才动 iframe。host 处理一次 `/status` 会跑最多五个 `git` 进程
   * （本机实测 300–400 ms），于是"点下去"与"真的开始换库"之间空了 0.3–0.4 秒，紧接着才是
   * 10–30MB 文档的下载与解析 —— 两段加起来就是那一下卡顿。换库需要的全部信息（`mode`、
   * 代理基址、名册）上一次刷新已经拿到了，没有理由再等一次。
   *
   * 没有可用 payload（首次加载失败、服务在重启）时什么都不做：调用方的 `doRefresh()`
   * 仍会照旧把整件事做完，行为与 v0.28.13 完全一致。
   */
  const switchFrameNow = (): void => {
    const payload = lastStatus
    if (payload === undefined || payload.status !== 'running') return
    const wiki = hooks.wikiId?.()
    const label = wiki === undefined ? undefined : wikiLabel(wiki)
    if (typeof payload.twProxy === 'string') {
      const bases = twProxyFor(payload.mode, wiki, payload.twProxy, payload.twProxyAbsolute)
      showFrame(resolveTwUrl(bases.relative, bases.absolute), wiki, label)
    } else if (typeof payload.url === 'string') {
      showFrame(payload.url, wiki, label)
    }
  }

  /**
   * Switching the focused knowledge base needs a different proxy path, so the
   * frame reloads (v0.28.0). TW reloads inside the iframe — one iframe cannot
   * host two editors, and silently keeping the old wiki's data while the UI says
   * otherwise is exactly the confusion this feature must not create.
   *
   * v0.28.14：**先立即换，再后台复探**。`switchFrameNow()` 用已有 payload 当场把 iframe
   * 指过去（并把"正在载入…"挂上），`doRefresh()` 只负责随后的状态/配置对账，不再挡在
   * 用户点击与界面反应之间。
   */
  const unsubscribeFocus = subscribeFocusWiki(() => {
    if (disposed || !visible) return
    switchFrameNow()
    void doRefresh()
  })

  const build = (): HTMLDivElement => {
    if (view !== undefined) return view
    const viewEl = document.createElement('div')
    viewEl.className = skin.view
    if (skin.viewDataset !== undefined) {
      for (const [key, value] of Object.entries(skin.viewDataset)) viewEl.dataset[key] = value
    }
    const wrapEl = document.createElement('div')
    wrapEl.className = skin.frameWrap
    if (skin.frameWrapStyle !== undefined) wrapEl.style.cssText = skin.frameWrapStyle
    const frameEl = document.createElement('iframe')
    frameEl.className = skin.frame
    frameEl.title = 'TiddlyWiki'
    frameEl.hidden = true
    wrapEl.append(frameEl)
    const errorEl = document.createElement('div')
    errorEl.className = skin.error
    errorEl.hidden = true
    // 换库提示（v0.28.14）：**view 的最后一个孩子**。刻意不放进 wrap / 不改 frame 的
    // 显隐规则 —— 那条"未载入 TW 地址就绝不显示 frame"的规则是 v0.22.3 的血债，不碰它。
    const loadingEl2 = document.createElement('div')
    loadingEl2.className = skin.loading
    loadingEl2.hidden = true
    viewEl.append(wrapEl, errorEl, loadingEl2)
    view = viewEl
    frame = frameEl
    errorArea = errorEl
    loadingEl = loadingEl2
    // Track load so a pending tiddler-hash navigation can target a ready
    // document (setting contentWindow.location.hash before load is a no-op).
    frameEl.addEventListener('load', () => {
      frameLoaded = true
      // 新文档到了：收起"正在载入…"（幂等，普通刷新时它本来就是隐藏的）。
      hideSwitching()
      applyPendingHash()
    })
    // Embedded TW follows the DSH light/dark theme (non-persisting palette
    // swap inside the same-origin iframe; re-applied on load + theme change).
    themeSyncDispose = attachThemeSync(frameEl)
    // The surface may already have been asked to show before its DOM existed
    // (the panel builds lazily): re-arm the load so it never stays empty.
    if (visible) void doRefresh()
    return viewEl
  }

  return {
    build,
    setVisible(next: boolean): void {
      if (disposed) return
      visible = next
      if (next && !started) started = true
      if (frame !== undefined) {
        // Reveal only a frame that already carries a TW URL; showFrame /
        // showStarting decide what to display until the first /status lands.
        frame.hidden = !next || loadableFrameUrl(frame.dataset) === null
      }
      if (next) {
        // 每次重新显示都重探一次状态：启动轮询是有界的（30×1.5s），首次打开时
        // 服务没起来就会把错误界面永久固定（切走再切回也不恢复）。doRefresh 自己
        // 会清旧 timer，不会重复轮询。
        void doRefresh()
      } else {
        // Hidden surfaces stop polling and get a fresh budget on the next show.
        clearRetry()
        // 界面都不显示了，"正在载入…" 没有意义（也不该在再次打开时凭空挂着）。
        hideSwitching()
        refreshAttempts = 0
      }
    },
    openTiddler(title: string, wiki?: TwWikiTarget): boolean {
      if (disposed || !visible) return false
      // `null` = 明确的默认库；字符串 = 那个库；`undefined` = 未指定（跟随 hook，
      // 也就是当前焦点库）。三者的区别见 TwWikiTarget 的注释。
      const wanted: string | null = wiki === null ? '' : wiki === undefined ? null : wiki
      const resolved = wanted === null ? (hooks.wikiId?.() ?? '') : wanted
      if (frameWikiKnown && (frameWiki ?? '') !== resolved) {
        // 要换库：hash 必须等 frame 真的指到那个库之后再落。自己发起这次刷新
        // ——调用方可能只是换了 hook（焦点库），刷新也可能来自别的入口。
        wikiSwitchPending = true
        void doRefresh()
      }
      pendingHash = `#${encodeURIComponent(title)}`
      if (!started) {
        started = true
        void doRefresh()
      } else {
        applyPendingHash()
      }
      return true
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      document.removeEventListener(PANEL_RELOAD_EVENT, onReloadRequest)
      unsubscribeFocus()
      clearRetry()
      clearSwitchTimer()
      for (const timer of hashWaitTimers) window.clearTimeout(timer)
      hashWaitTimers.clear()
      themeSyncDispose?.()
      view?.remove()
    },
  }
}

/** The plain-DOM TW frame controller owned by one surface body. */
export interface TwFrameController {
  /** Reflect the surface's visibility; loads lazily on the first show. */
  setVisible(visible: boolean): void
  /** Open a tiddler by title (and optionally its knowledge base); false when
   *  this controller cannot serve it. */
  openTiddler(title: string, wiki?: TwWikiTarget): boolean
  dispose(): void
}

/**
 * Controller for an ALREADY-aborted signal: no DOM is ever built, so there is
 * nothing to show and nothing to reap (the abort listener would never fire).
 */
function disposedController(): TwFrameController {
  return {
    setVisible(): void {},
    openTiddler(): boolean { return false },
    dispose(): void {},
  }
}

/** Live visible-capable TW frames; a controller joins on creation, leaves on dispose. */
const liveFrames = new Set<TwFrameController>()

/**
 * Ask every live side TW surface to open a tiddler; true when one served it.
 * A controller answers false while hidden or disposed, so the center overlay
 * only opens when no visible side TW tab can take the link.
 */
export function openTiddlerInLiveTab(title: string, wiki?: TwWikiTarget): boolean {
  for (const controller of liveFrames) {
    if (controller.openTiddler(title, wiki)) return true
  }
  return false
}

/**
 * Refresh the shared surface label from `/status` (ui.tabLabel) so a surface
 * that mounts before the first status call already shows the right name.
 */
export function warmTabLabel(): void {
  void fetchStatus().then((payload) => {
    if (payload?.ui !== undefined) setTabLabel(payload.ui.tabLabel ?? tabLabel)
  })
}

/** The rightbar tab's skin for the shared kernel (CSS owns the flex chain). */
const RIGHTBAR_SKIN: TwFrameSkin = {
  view: 'dsh-tw-rightbar-view',
  frameWrap: 'dsh-tw-rightbar-frame-wrap',
  frame: 'dsh-tw-rightbar-frame',
  error: 'dsh-tw-rightbar-error',
  loading: 'dsh-tw-loading',
}

/**
 * Create a TW frame controller inside `host`: the shared kernel (which loads
 * lazily on the first `setVisible(true)`, polls `/status`, follows the DSH
 * theme, reloads on the FAB's reload event and navigates `#<title>` hashes)
 * plus the rightbar skin and the live-frame registry. `signal` (the tab's
 * abort) tears the whole controller down.
 */
export function createTwFrameController(host: HTMLElement, signal: AbortSignal): TwFrameController {
  // Already aborted (the tab was closed before this body mounted): 'abort' will
  // never fire again, so registering here would strand the iframe in
  // liveFrames forever. Hand back a no-op controller and build nothing.
  if (signal.aborted) return disposedController()

  const surface = createTwFrameSurface(RIGHTBAR_SKIN, { wikiId: getFocusWiki })
  host.append(surface.build())

  let disposed = false
  const onAbort = (): void => controller.dispose()
  signal.addEventListener('abort', onAbort, { once: true })

  const controller: TwFrameController = {
    setVisible(visible: boolean): void {
      surface.setVisible(visible)
    },
    openTiddler(title: string, wiki?: TwWikiTarget): boolean {
      return surface.openTiddler(title, wiki)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      liveFrames.delete(controller)
      signal.removeEventListener('abort', onAbort)
      surface.dispose()
    },
  }
  liveFrames.add(controller)
  return controller
}

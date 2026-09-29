/**
 * tw-frame 内核的 **hash 导航**（v0.30.40 从 `tw-frame.ts` 的闭包里抽出，**行为零变化**）。
 *
 * 只做一件事：把「待落的 hash」落到 iframe 上 —— 含跨源兜底与 40×150ms 的等待链。
 *
 * ## 为什么用「访问器」，而不是把状态搬过来
 *
 * 这段代码对 `frame` / `disposed` **只读**（`frame.src = …` 是对**对象属性**赋值，不是重绑变量），
 * 所以它们**不需要改名、也不需要搬家**：用 `getFrame()` / `isDisposed()` 传进来即可。
 * 这很关键 —— `frame` 在 tw-frame.ts 里**同时**是接口属性与对象字面量的键
 * （`frame: string` / `frame: 'dsh-tw-rightbar-frame'`），任何文件级改名都会误伤它们
 * （v0.30.38 实测被 tsc 拦下）。**抽取只要求集中「写入点」，改名才要求改对所有「出现点」**
 * —— 名字超载时，优先抽取、少改名。
 *
 * 真正**会被写**的状态（`pendingHash` / `hashWaitTimers`）留在 `surfaceState` 里，按引用传入。
 *
 * @module dsh-tiddlywiki/client/tw-frame-hash
 */
import { loadableFrameUrl } from './tw-frame-api.ts'

export interface HashNavigatorDeps {
  /** 可写状态（按引用传入，与 base 共享同一份）。 */
  surfaceState: {
    /** 待落的 hash；`null` = 没有待办。 */
    pendingHash: string | null
    /** 等 TW 启动的重试定时器（`dispose()` 必须能取消整条链）。 */
    hashWaitTimers: Set<number>
    /** iframe 是否已经 load 过。 */
    frameLoaded: boolean
  }
  /** iframe 元素，只读。 */
  getFrame: () => HTMLIFrameElement | undefined
  /** 是否已卸载，只读。 */
  isDisposed: () => boolean
  /** 换库是否进行中，只读。 */
  isWikiSwitchPending: () => boolean
}

export function createHashNavigator(deps: HashNavigatorDeps) {
  const applyPendingHash = (): void => {
    const frame = deps.getFrame()
    if (deps.surfaceState.pendingHash === null || frame === undefined || !deps.surfaceState.frameLoaded) return
    // 换库还没完成：此刻写 hash 只会落进**正在被替换**的那份文档。
    if (deps.isWikiSwitchPending()) return
    const hash = deps.surfaceState.pendingHash
    const win = frame.contentWindow
    if (win === null) {
      fallbackLoad(hash)
      return
    }
    const tryOnce = (attempt: number): void => {
      if (deps.isDisposed()) return // unmounted: do not keep waiting or touch the frame
      if (deps.surfaceState.pendingHash !== hash) return // superseded by a newer request
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
            deps.surfaceState.hashWaitTimers.delete(timer)
            tryOnce(attempt + 1)
          }, 150)
          deps.surfaceState.hashWaitTimers.add(timer)
          return
        }
        fallbackLoad(hash)
        return
      }
      deps.surfaceState.pendingHash = null
      try {
        if (win.location.hash !== hash) win.location.hash = hash
      } catch {
        fallbackLoad(hash)
      }
    }
    tryOnce(0)
  }

  const fallbackLoad = (hash: string): void => {
    const frame = deps.getFrame()
    if (deps.isDisposed() || frame === undefined) return // never drive a detached frame
    if (deps.surfaceState.pendingHash === hash) deps.surfaceState.pendingHash = null
    // Guard against the never-loaded frame: `frame.src` is '' before showFrame
    // ran, and `'' + '#title'` resolves against the DSH page URL, which loads
    // the GUI into the iframe (v0.22.3).
    const base = loadableFrameUrl(frame.dataset)
    if (base === null) return
    const next = `${base.split('#')[0]}${hash}`
    if (frame.src !== next) frame.src = next
  }

  return { applyPendingHash, fallbackLoad }
}
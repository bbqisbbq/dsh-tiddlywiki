/**
 * dsh-tiddlywiki — host half: the local clip bridge wiring (书签小工具后端).
 *
 * WHY THIS IS ITS OWN MODULE (v0.28.8)
 * ------------------------------------
 * The clip bridge runs its OWN loopback HTTP server, so its requests never
 * reach the host webServer's `?wiki=` resolver. That makes "which wiki does a
 * clip land in" a question answered HERE and nowhere else — and it is exactly
 * the kind of decision that silently regresses (a multi-wiki install could only
 * ever clip into the default wiki before v0.28.8). Keeping the resolver, the
 * throttle and the bridge construction in one file keeps that answer in one
 * place; the target resolution itself (`clipTarget`) is the documented order
 * below and is unchanged by the move.
 *
 * @module dsh-tiddlywiki/index-clip
 */
import { ClipBridge, downloadClipImage, type BridgeConfig, type ClipImageDownload } from './host/clip-bridge.ts'
import type { TiddlyWebClient } from './host/tw-api.ts'
import type { WikiEntry } from './host/wiki-registry.ts'
import type { WikiFarm } from './host/wiki-farm.ts'
import type { WikiInstance } from './host/wiki-instance.ts'

export interface ClipDeps {
  /** The farm, or undefined until the control file has been read. */
  farm: () => WikiFarm<WikiInstance> | undefined
  /** The runtime clips fall back to when no target is configured/running. */
  defaultInstance: () => WikiInstance | undefined
  /** The DEFAULT wiki's effective bridge config (cordis base when nothing runs). */
  effectiveBridge: () => BridgeConfig
  /** Where the binding happens: called once by the startup task. */
  effect: (fn: () => unknown, label?: string) => void
}

export interface ClipSurface {
  /** The clip bridge instance (bind/stop are owned by the startup + teardown). */
  clipBridge: ClipBridge
  /**
   * Which wiki does a CLIP land in? (v0.28.8)
   *
   * The clip bridge runs its OWN loopback HTTP server (clip-bridge.ts), so its
   * requests never reach the host webServer's `?wiki=` resolver
   * (`targetRuntimeFor`). Before this existed the write path called `client()`,
   * which is hard-wired to the DEFAULT runtime — meaning a multi-wiki install
   * could only ever clip into the default wiki, with no way to say otherwise.
   *
   * Resolution order:
   *   1. `bridge.wiki` (config) when it names a wiki that EXISTS in the
   *      registry — running or not (a stopped one is a legitimate target: the
   *      bookmarklet must not have to care which wikis happen to be up);
   *   2. otherwise the farm's default runtime.
   *
   * Deliberately NOT an error when the id is unknown: this is a preference read
   * per request, and the bookmarklet is fire-and-forget. Falling back to the
   * default keeps clipping working, and the response reports which wiki was
   * actually used (see `write`/`exists` below).
   */
  clipTarget: () => { runtime: WikiInstance; id: string } | undefined
  /** The clip target's TiddlyWeb client, plus the id to report back. */
  clipClient: () => { client: TiddlyWebClient; wikiId: string } | undefined
}

export function createClipSurface(deps: ClipDeps): ClipSurface {
  const { farm, defaultInstance } = deps

  /**
   * Warn about a clip falling back to the default wiki, at most once per
   * DISTINCT configured id (so a stale `bridge.wiki` costs one log line, not one
   * per clip, while switching the setting and back still explains itself again).
   */
  const clipFallbackWarned = new Set<string>()
  const warnClipFallbackOnce = (wanted: string): void => {
    if (clipFallbackWarned.has(wanted)) return
    clipFallbackWarned.add(wanted)
    console.warn(`[dsh-tiddlywiki] clip bridge: 配置的 bridge.wiki「${wanted}」当前不在运行（或已移出清单），剪藏回落到默认库（设置页可改）`)
  }

  const clipTarget = (): { runtime: WikiInstance; id: string } | undefined => {
    const configured = deps.effectiveBridge()?.wiki
    const wanted = typeof configured === 'string' ? configured.trim() : ''
    if (wanted.length > 0) {
      const entry: WikiEntry | undefined = farm()?.registry.wikis.find((item) => item.id === wanted)
      if (entry !== undefined) {
        const runtime = farm()?.runtime(entry.id)
        if (runtime !== undefined) return { runtime, id: entry.id }
      }
      // Configured but not running (or since removed): say so, then fall back.
      // A silent fallback is how a user ends up with clips in the wrong wiki.
      // Throttled: this runs per clip and a stale setting would otherwise write
      // the same line to the log on every save a user makes.
      warnClipFallbackOnce(wanted)
    }
    const fallback = defaultInstance()
    if (fallback === undefined) return undefined
    return { runtime: fallback, id: fallback.entry.id }
  }

  /** The clip target's TiddlyWeb client, plus the id to report back. */
  const clipClient = (): { client: TiddlyWebClient; wikiId: string } | undefined => {
    const target = clipTarget()
    if (target === undefined) return undefined
    const c = target.runtime.client()
    return c === undefined ? undefined : { client: c, wikiId: target.id }
  }

  // 本地剪藏桥（书签小工具后端）：只监听 127.0.0.1，per-request 读 effective
  // config —— enabled/token/tag 在设置页保存后立即生效；port 只在启动时绑定
  // 一次（改端口需重启 dsh web，seed 文档已说明）。写入走唯一的 TiddlyWebClient
  // 通道（D1），不存在第二条写路径。
  const clipBridge = new ClipBridge({
    getConfig: deps.effectiveBridge,
    // v0.28.8: every clip operation resolves its target wiki per request
    // (`bridge.wiki`, else the default) — see clipClient(). The clipboard bridge
    // cannot use the host's `?wiki=` path, so this is the only place the choice
    // can be made.
    write: async (tiddler) => {
      const target = clipClient()
      if (target === undefined) throw new Error('wiki not ready')
      await target.client.put(tiddler)
    },
    exists: async (title) => {
      const target = clipClient()
      if (target === undefined) throw new Error('wiki not ready')
      return (await target.client.get(title)) !== undefined
    },
    /** Which wiki the CURRENT clip is writing to (reported back to the caller). */
    targetWiki: () => clipTarget()?.id,
    // Server-side image download: no browser CORS; a browser-ish UA + the clip
    // source page as Referer get past most hotlink-protected CDNs. The whole
    // SSRF posture (public http(s) only, per-hop validation with the resolved
    // address PINNED so DNS cannot rebind between check and connect, manual
    // redirects, streaming 15MB cap, no transparent decompression) lives in
    // downloadClipImage (v0.19.0).
    download: async (imageUrl, referer): Promise<ClipImageDownload> => {
      const result = await downloadClipImage(imageUrl, referer)
      return { buffer: result.buffer, type: result.type ?? null }
    },
    log: (m) => console.info('[dsh-tiddlywiki] clip bridge:', m),
  })
  deps.effect(() => () => clipBridge.stop(), 'dsh-tiddlywiki: clip bridge')

  return { clipBridge, clipTarget, clipClient }
}

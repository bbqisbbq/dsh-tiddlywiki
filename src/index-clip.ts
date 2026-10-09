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
import { stoppedWikiMessage } from './host/wiki-farm.ts'
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
   * Resolution order (v0.30.62):
   *   1. `bridge.wiki` naming a RUNNING wiki → that one;
   *   2. `bridge.wiki` naming a REGISTERED but stopped wiki → UNDEFINED (refuse):
   *      the same rule every `?wiki=` route has followed since v0.29.0. Silently
   *      writing the clip into a different knowledge base is the one failure this
   *      feature exists to prevent, and the bookmarklet cannot detect it;
   *   3. `bridge.wiki` naming an UNKNOWN id (removed / typo) → the farm's default
   *      runtime, with one warning (an old bookmark must keep working);
   *   4. no `bridge.wiki` → the farm's default runtime.
   */
  clipTarget: () => { runtime: WikiInstance; id: string } | undefined
  /** The clip target's TiddlyWeb client, plus the id to report back. */
  clipClient: () => { client: TiddlyWebClient; wikiId: string } | undefined
  /**
   * Why the CONFIGURED target cannot take a clip right now (v0.30.62), or
   * undefined. Names the wiki and what to do; the bridge puts it in the 503 body,
   * so a bookmarklet user is told why nothing was written.
   */
  targetProblem: () => string | undefined
}

export function createClipSurface(deps: ClipDeps): ClipSurface {
  const { farm, defaultInstance } = deps

  /** The configured `bridge.wiki`, trimmed ('' = follow the default wiki). */
  const configuredClipWiki = (): string => {
    const configured = deps.effectiveBridge()?.wiki
    return typeof configured === 'string' ? configured.trim() : ''
  }

  /**
   * Warn about a clip falling back to the default wiki because the configured id
   * is not in the registry at all (removed wiki, typo). At most once per DISTINCT
   * id, so a stale setting costs one log line rather than one per clip — while
   * switching the setting and back still explains itself again.
   */
  const clipFallbackWarned = new Set<string>()
  const warnClipFallbackOnce = (wanted: string): void => {
    if (clipFallbackWarned.has(wanted)) return
    clipFallbackWarned.add(wanted)
    console.warn(`[dsh-tiddlywiki] clip bridge: 配置的 bridge.wiki「${wanted}」不在知识库清单里，剪藏回落到默认的那个知识库（设置页可改）`)
  }

  const clipTarget = (): { runtime: WikiInstance; id: string } | undefined => {
    const wanted = configuredClipWiki()
    if (wanted.length > 0) {
      const entry: WikiEntry | undefined = farm()?.registry.wikis.find((item) => item.id === wanted)
      if (entry !== undefined) {
        const runtime = farm()?.runtime(entry.id)
        // Registered but NOT running ⇒ refuse; never fall back (v0.30.62). The
        // bridge reports `targetProblem()` (the wiki's name) as a 503.
        return runtime === undefined ? undefined : { runtime, id: entry.id }
      }
      warnClipFallbackOnce(wanted)
    }
    const fallback = defaultInstance()
    if (fallback === undefined) return undefined
    return { runtime: fallback, id: fallback.entry.id }
  }

  /** See {@link ClipSurface.targetProblem}: only a REGISTERED, stopped target. */
  const targetProblem = (): string | undefined => {
    const wanted = configuredClipWiki()
    if (wanted.length === 0) return undefined
    const entry: WikiEntry | undefined = farm()?.registry.wikis.find((item) => item.id === wanted)
    if (entry === undefined) return undefined
    if (farm()?.runtime(entry.id) !== undefined) return undefined
    return stoppedWikiMessage(entry)
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
    /** A configured-but-stopped target is a named 503, never a silent fallback. */
    targetProblem,
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

  return { clipBridge, clipTarget, clipClient, targetProblem }
}

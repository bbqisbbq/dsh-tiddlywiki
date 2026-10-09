/**
 * 本地剪藏桥（bookmarklet 剪藏小工具的后端）。
 *
 * A tiny loopback-only HTTP bridge that turns a browser bookmarklet's
 * "剪藏" request into TiddlyWiki tiddlers. The bookmarklet (JS in the
 * browser's bookmarks bar) POSTs { title, url, text, images } to the bridge;
 * the bridge writes ONE note tiddler (markdown, or wikitext when images are
 * stored) plus optional IMAGE ATTACHMENTS through the SAME TiddlyWebClient
 * every other writer uses (D1 — there is never a second write path).
 *
 * Images (v0.16.25): TW 5.4.1's REST facade is JSON-only (put-tiddler.js
 * JSON.parses the body — there is no binary upload route), but its binary
 * tiddlers ARE representable as `{ type: image/*, text: <base64> }` — verified
 * empirically: type + base64 roundtrip byte-exact, tags survive, custom fields
 * nest under `fields`. So the bridge downloads each chosen image (server-side,
 * no CORS; referer + UA sent for hotlink-protected CDNs), stores it as a
 * binary ATTACHMENT tiddler, and embeds it in the note with `[img[Title]]`.
 * A failed download degrades gracefully to a plain source-URL line.
 *
 * Security posture (deliberate):
 * - binds `127.0.0.1` ONLY — never reachable from the network;
 * - Host-header whitelist (127.0.0.1 / localhost / ::1) blocks DNS rebinding:
 *   a malicious website that resolves its own domain to the loopback cannot
 *   use the bridge with its own Host header;
 * - **ANY web page may submit a clip — that is ACCEPTED, by the author's
 *   decision (2026-09-29)**, as long as it cannot destroy system state: the
 *   payload validator refuses every `$:/…` title (v0.30.0), so a page can ADD
 *   notes but cannot overwrite the plugin's config, the trash index or any
 *   other system tiddler. No Origin / Sec-Fetch-Site check is applied on
 *   purpose — the bookmarklet runs INSIDE the page's origin, so such a check
 *   would break the very feature it is meant to serve;
 * - `bridge.token` is an OPT-IN extra restriction, NOT the premise: when set,
 *   every write must present `x-clip-token`. Off by default — 「任意页面能给
 *   你的 wiki 建笔记」是许可的，不允许的只有覆盖系统项（上面那条）；
 * - CORS preflight answered with `Access-Control-Allow-Origin: *` +
 *   `Access-Control-Allow-Private-Network: true` so (a) a bookmarklet running
 *   on an https page may read the response, and (b) Chromium's Private Network
 *   Access preflight for public→loopback requests succeeds;
 * - `enabled` is evaluated PER REQUEST against the effective (settings-page)
 *   config, so toggling the flag takes effect immediately — no dsh web
 *   restart. Changing the PORT still needs a restart (the listener binds once).
 *
 * @module dsh-tiddlywiki/host/clip-bridge
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Tiddler } from './tw-api.ts'
import { readBody, safeTokenEqual } from './http.ts'
import { MAX_CLIP_BODY_BYTES, MAX_IMAGE_BYTES } from './clip-bridge-limits.ts'
import { assertPublicImageUrl } from './clip-bridge-ssrf.ts'

// The v0.30.0 split must be INVISIBLE to callers: `src/index.ts` re-exports
// this exact list from THIS module and the guards import these names from
// lib/, so both halves are re-exported here instead of moving the public
// surface. (`downloadClipImage` / `isPrivateAddress` are only re-exported —
// the server half itself calls just `assertPublicImageUrl`.)
export { MAX_CLIP_BODY_BYTES, MAX_CLIP_IMAGES, MAX_CLIP_TEXT_LENGTH, MAX_IMAGE_BYTES } from './clip-bridge-limits.ts'
export { assertPublicImageUrl, downloadClipImage, isPrivateAddress } from './clip-bridge-ssrf.ts'

/** Effective bridge config (resolved from the plugin config store). */
export interface BridgeConfig {
  /** 是否启用剪藏桥（每个请求实时判定，保存设置即生效）。 */
  enabled: boolean
  /** 监听端口（仅启动时绑定一次；改动端口需重启 dsh web）。 */
  port: number
  /** 共享口令；非空时每个写入须带 `x-clip-token` 头。 */
  token: string
  /** 剪藏笔记默认 tag。 */
  tag: string
  /**
   * 剪藏写进哪个知识库（id，v0.28.8）。空串 = 默认库。
   *
   * 桥只在这里**声明**这个字段；解析成实际实例是宿主的事（剪藏桥自建
   * loopback 服务，走不到 `?wiki=` 那套解析）。
   */
  wiki?: string
}

/** A downloaded image (raw bytes + declared content-type, nullable). */
export interface ClipImageDownload {
  buffer: Buffer
  type: string | null
}

/** Everything the bridge needs from the plugin (no @deepseek-ai deps). */
export interface ClipBridgeDeps {
  /** Resolve the EFFECTIVE bridge config per request. */
  getConfig(): BridgeConfig
  /** Write one tiddler; throws when the wiki is not ready. */
  write(tiddler: Tiddler): Promise<unknown>
  /** True when a tiddler with that title already exists (title dedupe). */
  exists(title: string): Promise<boolean>
  /** Download an image's bytes (server-side fetch; throws on failure). */
  download(url: string, referer: string): Promise<ClipImageDownload>
  /**
   * The wiki id this clip is being written to (v0.28.8), or undefined when the
   * caller does not implement per-wiki targeting.
   *
   * Reported back in the `/clip` response so the bookmarklet can tell the user
   * ("已存到 books") — with several knowledge bases a silent success is
   * indistinguishable from "it went to the wrong one".
   */
  targetWiki?(): string | undefined
  /**
   * Why the CONFIGURED target wiki cannot take a clip right now (v0.30.62), or
   * undefined. A registered-but-stopped target is a named 503 — never a silent
   * fallback into a different knowledge base.
   */
  targetProblem?(): string | undefined
  /** Optional logger (console.info prefixed by the caller). */
  log?(message: string): void
}


/** Validated request body accepted by POST /clip (all fields normalized). */
export interface ClipPayload {
  title: string
  url: string
  text: string
  /** Optional extra tiddler tags (merged with the configured clip tag). */
  tags: string[]
  /** Where the clip came from ("bookmarklet" default; "api"/"script"…). */
  source: string
  /** Chosen image URLs to download + store as attachments (≤ MAX_CLIP_IMAGES). */
  images: string[]
}

/** Per-image result echoed back to the bookmarklet. */
export interface ClipImageResult {
  url: string
  ok: boolean
  /** Stored attachment tiddler title (when ok). */
  title?: string
  /** Human-readable failure reason (when !ok). */
  error?: string
}

/** Loopback-only Host header whitelist (DNS-rebinding defense). */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (typeof host !== 'string') return false
  const h = host.trim().toLowerCase()
  const ok = (base: string): boolean => h === base || h === `${base}:${port}`
  return ok('127.0.0.1') || ok('localhost') || ok('[::1]') || ok('::1')
}

import { buildBinaryTiddler, buildClipTiddler, buildImageNoteTiddler, imageExtensionForMime, parseClipPayload, pickImageMime, resolveClipTitle } from './clip-bridge-payload.ts'

// The payload builders moved to `clip-bridge-payload.ts` (v0.30.3, pure move).
// Re-exported so this module keeps the public surface `src/index.ts` and
// `verify-clip-bridge.mjs` (which imports them from lib/) already depend on.
export {
  buildBinaryTiddler,
  buildClipTiddler,
  buildImageNoteTiddler,
  imageExtensionForMime,
  parseClipPayload,
  pickImageMime,
  resolveClipTitle,
} from './clip-bridge-payload.ts'


/** CORS + no-store headers for every bridge response. */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type, x-clip-token',
  'access-control-allow-private-network': 'true',
  'access-control-max-age': '86400',
  'cache-control': 'no-store',
}

/**
 * The loopback clip bridge. `start(port)` binds once (127.0.0.1); config
 * (enabled/token/tag) is re-resolved per request through `deps.getConfig`,
 * so settings-page saves apply live. `stop()` is idempotent.
 */
export class ClipBridge {
  private server: Server | undefined
  private boundPort = 0
  /**
   * 剪藏请求的串行队列（v0.29.0）。
   *
   * WHY: the note title is chosen with a check-then-write
   * (`resolveClipTitle(deps.exists, …)`), so two clips of the same page in flight
   * — a double bookmarklet click, or two tabs — both see "X is free" and the
   * second PUT silently replaces the first note (leaving the first note's image
   * tiddlers orphaned). TW's REST has no compare-and-set, so the cross-process
   * race cannot be closed; the same-process one can, and that IS the common case:
   * serialize `/clip` handling here. The second request then resolves the title
   * AFTER the first landed and picks 「X 2」.
   */
  private clipChain: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: ClipBridgeDeps) {}

  /** The port currently bound (0 until start succeeds). */
  get port(): number {
    return this.boundPort
  }

  /** Bind 127.0.0.1:port; rejects on EADDRINUSE etc. (caller logs & carries on). */
  start(port: number): Promise<void> {
    if (this.server !== undefined) return Promise.resolve()
    const server = createServer((req, res) => {
      // 串行执行（v0.29.0）：标题解析是"先查后写"，并发时第二次会覆盖第一次
      // （见 clipChain 的注释）。队列本身必须永远保持 resolved，否则一次失败
      // 会把后续所有剪藏请求一起卡住。
      const run = this.clipChain.then(() => this.handle(req, res))
      this.clipChain = run.then(() => undefined, () => undefined)
      run.catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this.deps.log?.(`request failed: ${message}`)
        if (!res.headersSent) {
          this.respond(res, { ok: false, error: '内部错误' }, 500)
        } else {
          res.destroy()
        }
      })
    })
    // Malformed HTTP must not crash the bridge (default behavior would emit
    // an unhandled 'clientError').
    server.on('clientError', (_err, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    })
    this.server = server
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener('listening', onListening)
        if (this.server === server) this.server = undefined
        this.deps.log?.(`bind 127.0.0.1:${port} failed: ${err.message}`)
        reject(err)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        // Replace the bind-time handler with a PERMANENT one (v0.19.3): without
        // any 'error' listener a later server error (e.g. EMFILE/ECONNRESET on a
        // accept) is an unhandled 'error' event → Node throws → the whole dsh
        // web process dies. Log and keep serving.
        server.on('error', (err: Error) => {
          this.deps.log?.(`server error after listen: ${err.message}`)
        })
        const addr = server.address() as AddressInfo
        this.boundPort = addr.port
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    })
  }

  /** Close the listener (idempotent; awaited by the host teardown). */
  stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.boundPort = 0
    if (server === undefined) return Promise.resolve()
    // `server.close()` only resolves once every open connection ends, and the
    // bookmarklet's keep-alive socket can hold it open forever — the effect
    // disposer (plugin unload) would then hang (v0.19.3). Force-close the
    // connections and cap the wait.
    return new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        resolve()
      }
      try {
        ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
      } catch { /* not available on this Node */ }
      server.close(() => finish())
      setTimeout(finish, 1_000).unref?.()
    })
  }

  private respond(res: ServerResponse, payload: unknown, status = 200): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS })
    res.end(JSON.stringify(payload))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cfg = this.deps.getConfig()
    const urlPath = (req.url ?? '/').split('?')[0] ?? '/'

    // CORS preflight is answered unconditionally (Cross-Origin requests from a
    // bookmarklet always preflight: content-type application/json is not a
    // "simple" header, and Chromium's PNA wants Access-Control-Allow-Private-Network).
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }
    // DNS-rebinding defense BEFORE anything else: only loopback Host headers.
    if (!hostAllowed(req.headers.host, this.boundPort)) {
      this.respond(res, { ok: false, error: 'Forbidden host' }, 403)
      return
    }

    if (req.method === 'GET' && (urlPath === '/' || urlPath === '/health')) {
      // Minimal liveness answer: CORS is `*`, so any web page can read this.
      // `tag` / `tokenSet` used to be echoed here — a page could fingerprint
      // the bridge (and whether a token is configured) without knowing it
      // (v0.19.0).
      this.respond(res, {
        ok: true,
        name: 'dsh-tiddlywiki clip bridge',
        enabled: cfg.enabled,
      })
      return
    }

    if (req.method !== 'POST' || urlPath !== '/clip') {
      this.respond(res, { ok: false, error: `未知路径 ${req.method} ${urlPath}` }, 404)
      return
    }

    // Enabled + token gates: the port stays bound even while disabled so the
    // settings-page toggle works without a dsh web restart; a disabled bridge
    // answers 503 (and the token check never runs for it).
    if (!cfg.enabled) {
      this.respond(res, { ok: false, error: '剪藏桥未启用：请在 DSH 设置 → 常规配置 勾选「启用本地剪藏桥」' }, 503)
      return
    }
    if (cfg.token.length > 0) {
      const got = req.headers['x-clip-token']
      if (typeof got !== 'string' || !safeTokenEqual(got, cfg.token)) {
        this.respond(res, { ok: false, error: 'token 校验失败' }, 401)
        return
      }
    }

    let body: unknown
    try {
      body = JSON.parse(await readBody(req, MAX_CLIP_BODY_BYTES)) as unknown
    } catch {
      this.respond(res, { ok: false, error: '请求体不是合法的 JSON（或过大）' }, 400)
      return
    }
    const parsed = parseClipPayload(body)
    if (!parsed.ok) {
      this.respond(res, { ok: false, error: parsed.error }, 400)
      return
    }
    const { title, url, text, tags, source, images } = parsed.value

    // A configured-but-stopped target is refused HERE, before anything is written
    // (v0.30.62): the caller gets the wiki's name and what to do with it, instead
    // of a clip landing in the default wiki while the bookmarklet says「已剪藏」.
    const problem = this.deps.targetProblem?.()
    if (problem !== undefined) {
      this.respond(res, { ok: false, error: problem }, 503)
      return
    }

    let resolvedTitle: string
    try {
      resolvedTitle = await resolveClipTitle((t) => this.deps.exists(t), title)
    } catch {
      this.respond(res, { ok: false, error: this.deps.targetProblem?.() ?? 'TiddlyWiki 服务暂不可用，请稍后重试' }, 503)
      return
    }

    const at = new Date().toISOString()
    const sourceName = source.length > 0 ? source : 'bookmarklet'

    // Download + store the chosen images as binary attachment tiddlers.
    const stored: string[] = []
    const failed: Array<{ url: string; error: string }> = []
    const imageResults: ClipImageResult[] = []
    for (let i = 0; i < images.length; i++) {
      const imageUrl = images[i]
      if (imageUrl === undefined) continue
      try {
        // SSRF gate (policy lives here, not in the caller's downloader): never
        // fetch a loopback/LAN/metadata URL on behalf of a web page.
        await assertPublicImageUrl(imageUrl)
        const { buffer, type } = await this.deps.download(imageUrl, url)
        if (buffer.length > MAX_IMAGE_BYTES) {
          throw new Error('图片超过 15MB 上限')
        }
        const mime = pickImageMime(type, imageUrl)
        if (mime === null) {
          throw new Error('内容不是可识别的图片')
        }
        const ext = imageExtensionForMime(mime)
        const imageTitle = await resolveClipTitle((t) => this.deps.exists(t), `${resolvedTitle} 图片 ${i + 1}.${ext}`)
        await this.deps.write(buildBinaryTiddler({
          title: imageTitle,
          mime,
          buffer,
          srcUrl: imageUrl,
          noteTitle: resolvedTitle,
          tag: cfg.tag,
          source: sourceName,
          at,
        }))
        stored.push(imageTitle)
        imageResults.push({ url: imageUrl, ok: true, title: imageTitle })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        failed.push({ url: imageUrl, error: message })
        imageResults.push({ url: imageUrl, ok: false, error: message })
      }
    }

    // The note: when images were chosen (stored or failed), wikitext with
    // `[img[Title]]` embeds + failed ones degrade to URL lines; a pure
    // text-only clip stays markdown as before.
    const noteTiddler = stored.length > 0 || images.length > 0
      ? buildImageNoteTiddler({
          title: resolvedTitle, url, ...(text.length > 0 ? { text } : {}),
          tag: cfg.tag, source: sourceName, at, stored, failed, extraTags: tags,
        })
      : buildClipTiddler({
          title: resolvedTitle, url, ...(text.length > 0 ? { text } : {}),
          tag: cfg.tag, source: sourceName, at, extraTags: tags,
        })
    try {
      await this.deps.write(noteTiddler)
    } catch {
      // The note is the primary artifact — fail the clip (images may already
      // be stored; they are still referenced by the note if it lands later).
      this.respond(res, { ok: false, error: this.deps.targetProblem?.() ?? 'TiddlyWiki 服务暂不可用，剪藏未写入' }, 503)
      return
    }
    // `wiki` (v0.28.8) tells a multi-wiki user WHICH knowledge base took the
    // clip; omitted when the caller has no per-wiki targeting, so a single-wiki
    // install's response is byte-identical to before.
    const wikiId = this.deps.targetWiki?.()
    this.respond(res, {
      ok: true, title: resolvedTitle, url, tag: cfg.tag, source: sourceName, images: imageResults,
      ...(typeof wikiId === 'string' && wikiId.length > 0 ? { wiki: wikiId } : {}),
    })
  }
}

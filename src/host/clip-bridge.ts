/**
 * 本地剪藏桥（bookmarklet 剪藏小工具的后端）。
 *
 * A tiny loopback-only HTTP bridge that turns a browser bookmarklet's
 * "剪藏" request into a TiddlyWiki tiddler. The bookmarklet (JS in the
 * browser's bookmarks bar) POSTs { title, url, text } to the bridge; the
 * bridge writes one markdown tiddler through the SAME TiddlyWebClient every
 * other writer uses (D1 — there is never a second write path).
 *
 * Security posture (deliberate):
 * - binds `127.0.0.1` ONLY — never reachable from the network;
 * - Host-header whitelist (127.0.0.1 / localhost / ::1) blocks DNS rebinding:
 *   a malicious website that resolves its own domain to the loopback cannot
 *   use the bridge with its own Host header;
 * - optional shared `token` — when set, every write must carry
 *   `x-clip-token`. The bookmarklet ships it; a random webpage on the
 *   internet cannot know it, so it cannot pollute the wiki;
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
import { readBody } from './http.ts'

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
}

/** Everything the bridge needs from the plugin (no @deepseek-ai deps). */
export interface ClipBridgeDeps {
  /** Resolve the EFFECTIVE bridge config per request. */
  getConfig(): BridgeConfig
  /** Write one tiddler; throws when the wiki is not ready. */
  write(tiddler: Tiddler): Promise<unknown>
  /** True when a tiddler with that title already exists (title dedupe). */
  exists(title: string): Promise<boolean>
  /** Optional logger (console.info prefixed by the caller). */
  log?(message: string): void
}

/** Cap on the clipped text (characters) — plenty for a page selection. */
export const MAX_CLIP_TEXT_LENGTH = 200_000
/** Cap on a single /clip request body (bytes). */
export const MAX_CLIP_BODY_BYTES = 256 * 1024

/** Validated request body accepted by POST /clip (all fields normalized). */
export interface ClipPayload {
  title: string
  url: string
  text: string
  /** Optional extra tiddler tags (merged with the configured clip tag). */
  tags: string[]
  /** Where the clip came from ("bookmarklet" default; "api"/"script"…). */
  source: string
}

/** Constant-time-ish string compare (token check). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Loopback-only Host header whitelist (DNS-rebinding defense). */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (typeof host !== 'string') return false
  const h = host.trim().toLowerCase()
  const ok = (base: string): boolean => h === base || h === `${base}:${port}`
  return ok('127.0.0.1') || ok('localhost') || ok('[::1]') || ok('::1')
}

/**
 * Pick a collision-free tiddler title: `base`, then `base（2）…（20）` while an
 * existing tiddler holds the name (so re-clipping the same page never
 * overwrites the previous clip), then a timestamp fallback.
 */
export async function resolveClipTitle(exists: (title: string) => Promise<boolean>, base: string): Promise<string> {
  if (!(await exists(base))) return base
  for (let i = 2; i <= 20; i++) {
    const candidate = `${base}（${i}）`
    if (!(await exists(candidate))) return candidate
  }
  return `${base}（${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}）`
}

/** Build the markdown tiddler for one clip (pure, unit-verifiable). */
export function buildClipTiddler(opts: {
  title: string
  url: string
  text?: string
  tag: string
  source?: string
  at?: string
  extraTags?: string[]
}): Tiddler {
  const at = opts.at ?? new Date().toISOString()
  const selection = typeof opts.text === 'string' ? opts.text.trim() : ''
  const lines = [`> 来源：${opts.url}`, '']
  if (selection.length > 0) lines.push(selection, '')
  lines.push('---', `剪藏时间：${at}`)
  const tags = [opts.tag, ...(opts.extraTags ?? [])].filter((t) => t.trim().length > 0)
  return {
    title: opts.title,
    text: lines.join('\n'),
    type: 'text/markdown',
    ...(tags.length > 0 ? { tags } : {}),
    'clip-url': opts.url,
    'clip-source': opts.source ?? 'bookmarklet',
    'clip-at': at,
  }
}

function cleanStr(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Validate a clip payload → { title, url, text, tags, source } or an error. */
export function parseClipPayload(body: unknown): { ok: true; value: ClipPayload } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: '请求体必须是 JSON 对象' }
  }
  const raw = body as Record<string, unknown>
  const title = cleanStr(raw.title).trim().slice(0, 300)
  const url = cleanStr(raw.url).trim().slice(0, 2000)
  const text = cleanStr(raw.text).slice(0, MAX_CLIP_TEXT_LENGTH)
  const source = cleanStr(raw.source).trim().slice(0, 40)
  let extraTags: string[] = []
  if (Array.isArray(raw.tags)) {
    extraTags = raw.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean).slice(0, 10)
  }
  if (title.length === 0) return { ok: false, error: '缺少 title（页面标题）' }
  if (url.length === 0) return { ok: false, error: '缺少 url（页面地址）' }
  return { ok: true, value: { title, url, text, tags: extraTags, source } }
}

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

  constructor(private readonly deps: ClipBridgeDeps) {}

  /** The port currently bound (0 until start succeeds). */
  get port(): number {
    return this.boundPort
  }

  /** Bind 127.0.0.1:port; rejects on EADDRINUSE etc. (caller logs & carries on). */
  start(port: number): Promise<void> {
    if (this.server !== undefined) return Promise.resolve()
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((err: unknown) => {
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
    return new Promise<void>((resolve) => {
      server.close(() => resolve())
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
      this.respond(res, {
        ok: true,
        name: 'dsh-tiddlywiki clip bridge',
        enabled: cfg.enabled,
        port: this.boundPort,
        tag: cfg.tag,
        tokenSet: cfg.token.length > 0,
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
      if (typeof got !== 'string' || !safeEqual(got, cfg.token)) {
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
    const { title, url, text, tags, source } = parsed.value

    let resolvedTitle: string
    try {
      resolvedTitle = await resolveClipTitle((t) => this.deps.exists(t), title)
    } catch {
      this.respond(res, { ok: false, error: 'TiddlyWiki 服务暂不可用，请稍后重试' }, 503)
      return
    }

    const tiddler = buildClipTiddler({
      title: resolvedTitle,
      url,
      ...(text.length > 0 ? { text } : {}),
      tag: cfg.tag,
      source: source.length > 0 ? source : undefined,
      extraTags: tags,
    })
    try {
      await this.deps.write(tiddler)
    } catch {
      this.respond(res, { ok: false, error: 'TiddlyWiki 服务暂不可用，剪藏未写入' }, 503)
      return
    }
    this.respond(res, { ok: true, title: resolvedTitle, url, tag: cfg.tag, source: tiddler['clip-source'] })
  }
}
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
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { AddressInfo, LookupFunction } from 'node:net'
import { createHash, timingSafeEqual } from 'node:crypto'
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
  /** Optional logger (console.info prefixed by the caller). */
  log?(message: string): void
}

/** Cap on the clipped text (characters) — plenty for a page selection. */
export const MAX_CLIP_TEXT_LENGTH = 200_000
/** Cap on a single /clip request body (bytes). */
export const MAX_CLIP_BODY_BYTES = 256 * 1024
/** Cap on one downloaded image (bytes) — 15 MB keeps the wiki sane. */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024
/** Max images stored per clip (the picker already caps the page list). */
export const MAX_CLIP_IMAGES = 10

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

/**
 * Constant-time token compare: hash both sides first, so neither the content
 * nor the LENGTH of the expected token leaks through timing (v0.19.0 — the
 * previous loop returned early on a length mismatch).
 */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

/** Loopback-only Host header whitelist (DNS-rebinding defense). */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (typeof host !== 'string') return false
  const h = host.trim().toLowerCase()
  const ok = (base: string): boolean => h === base || h === `${base}:${port}`
  return ok('127.0.0.1') || ok('localhost') || ok('[::1]') || ok('::1')
}

/** IPv4 ranges that must never be fetched on behalf of a web page. */
const PRIVATE_V4_PATTERNS = [
  /^0\./, // "this network"
  /^10\./, // private
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64/10
  /^127\./, // loopback
  /^169\.254\./, // link-local (cloud metadata 169.254.169.254)
  /^172\.(1[6-9]|2\d|3[01])\./, // private
  /^192\.0\.0\./, // IETF protocol assignments
  /^192\.168\./, // private
  /^198\.1[89]\./, // benchmarking
]

/** Parse a dotted-quad IPv4 into 4 bytes, or null. */
function parseIpv4(input: string): number[] | null {
  const parts = input.split('.')
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    out.push(value)
  }
  return out
}

/**
 * Expand ANY IPv6 textual form (compressed `::`, expanded, embedded dotted
 * IPv4 tail, zone id, bracketed) into exactly 16 bytes — or null when it is not
 * a valid IPv6 literal. Written by hand because the guard must be total:
 * `net.isIP()` accepts forms such as `0:0:0:0:0:0:0:1` (which IS `::1`) that the
 * old prefix-regex guard let through.
 */
function ipv6ToBytes(input: string): number[] | null {
  let ip = input.trim().toLowerCase()
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1)
  const zone = ip.indexOf('%')
  if (zone >= 0) ip = ip.slice(0, zone)
  const halves = ip.split('::')
  if (halves.length > 2) return null
  const parseGroups = (text: string): number[] | null => {
    if (text.length === 0) return []
    const out: number[] = []
    for (const group of text.split(':')) {
      if (group.length === 0) return null
      if (group.includes('.')) {
        const v4 = parseIpv4(group)
        if (v4 === null) return null
        out.push((v4[0] ?? 0) * 256 + (v4[1] ?? 0), (v4[2] ?? 0) * 256 + (v4[3] ?? 0))
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null
      out.push(Number.parseInt(group, 16))
    }
    return out
  }
  const head = parseGroups(halves[0] ?? '')
  if (head === null) return null
  let groups: number[]
  if (halves.length === 2) {
    const tail = parseGroups(halves[1] ?? '')
    if (tail === null) return null
    const missing = 8 - head.length - tail.length
    if (missing < 0) return null
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail]
  } else {
    groups = head
  }
  if (groups.length !== 8) return null
  const bytes: number[] = []
  for (const group of groups) bytes.push((group >> 8) & 0xff, group & 0xff)
  return bytes
}

/**
 * True for loopback / link-local / private / unique-local / CGNAT / multicast
 * addresses. IPv6 is judged on its PARSED BYTES, not on string prefixes
 * (v0.19.0): `0:0:0:0:0:0:0:1`, `::0:1` and `::ffff:7f00:1` all denote `::1` /
 * `127.0.0.1` and were previously ALLOWED, i.e. the SSRF guard was bypassable.
 * IPv4-mapped (`::ffff:0:0/96`), IPv4-compatible (`::/96`) and 6to4
 * (`2002::/16`) forms embed an IPv4 address and are judged as that address.
 */
export function isPrivateAddress(address: string): boolean {
  const raw = address.trim().toLowerCase()
  const ip = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  const family = isIP(ip)
  if (family === 4) return PRIVATE_V4_PATTERNS.some((re) => re.test(ip))
  if (family !== 6) return false
  const bytes = ipv6ToBytes(ip)
  // Unparseable but accepted by isIP(): fail closed.
  if (bytes === null) return true
  const isZero = (slice: number[]): boolean => slice.every((b) => b === 0)
  const at = (index: number): number => bytes[index] ?? 0
  const v4 = (offset: number): string => `${at(offset)}.${at(offset + 1)}.${at(offset + 2)}.${at(offset + 3)}`
  if (isZero(bytes)) return true // ::
  if (isZero(bytes.slice(0, 15)) && at(15) === 1) return true // ::1
  if ((at(0) & 0xfe) === 0xfc) return true // fc00::/7 unique-local
  if (at(0) === 0xfe && (at(1) & 0xc0) === 0x80) return true // fe80::/10
  if (at(0) === 0xff) return true // ff00::/8 multicast
  if (at(0) === 0x20 && at(1) === 0x01 && at(2) === 0x0d && at(3) === 0xb8) return true // 2001:db8::/32
  // IPv4-mapped ::ffff:a.b.c.d
  if (isZero(bytes.slice(0, 10)) && at(10) === 0xff && at(11) === 0xff) return isPrivateAddress(v4(12))
  // 6to4 2002:<v4>:…  and NAT64 64:ff9b::<v4>
  if (at(0) === 0x20 && at(1) === 0x02) return isPrivateAddress(v4(2))
  if (at(0) === 0x00 && at(1) === 0x64 && at(2) === 0xff && at(3) === 0x9b) return isPrivateAddress(v4(12))
  // IPv4-compatible ::a.b.c.d (deprecated, still routed by some stacks)
  if (isZero(bytes.slice(0, 12))) return isPrivateAddress(v4(12))
  return false
}

/**
 * SSRF guard for a clip image URL. The bridge downloads on behalf of a page in
 * the user's browser, so it must never become a proxy into the local network
 * (or a cloud metadata endpoint). Rejects non-http(s) schemes, loopback/LAN
 * hostnames, literal private addresses, and public names that RESOLVE to a
 * private address. Redirects are re-validated per hop by the caller
 * (`redirect: 'manual'` in index.ts), so a redirect cannot escape the check.
 */
export async function assertPublicImageUrl(rawUrl: string): Promise<void> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('图片地址不是合法 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`不支持的图片协议 ${url.protocol}`)
  }
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    throw new Error('拒绝下载内网主机名的图片')
  }
  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (isIP(literal) !== 0) {
    if (isPrivateAddress(literal)) throw new Error('拒绝下载内网地址的图片')
    return
  }
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    throw new Error(`图片主机无法解析：${host}`)
  }
  if (addresses.length === 0) throw new Error(`图片主机无法解析：${host}`)
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('拒绝下载解析到内网地址的图片')
  }
}

/** One hop's outcome: either a redirect target, or the downloaded bytes. */
interface ImageHopResult {
  buffer: Buffer
  type: string | undefined
  redirect?: string
}

/** A validated URL plus the exact address the guard approved for connecting. */
interface PublicTarget {
  url: URL
  address: string
  family: number
}

/**
 * Resolve one image URL to a PUBLIC address and PIN it. The guard validates the
 * DNS answer here; the request then connects to that exact address (custom
 * `lookup`), so a rebinding domain cannot pass the check with a public answer
 * and then be re-resolved to 127.0.0.1 at connect time (v0.19.0 — the previous
 * implementation validated the name and then let `fetch` resolve it again).
 */
async function resolvePublicTarget(rawUrl: string): Promise<PublicTarget> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('图片地址不是合法 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`不支持的图片协议 ${url.protocol}`)
  }
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    throw new Error('拒绝下载内网主机名的图片')
  }
  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  const literalFamily = isIP(literal)
  if (literalFamily !== 0) {
    if (isPrivateAddress(literal)) throw new Error('拒绝下载内网地址的图片')
    return { url, address: literal, family: literalFamily }
  }
  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    throw new Error(`图片主机无法解析：${host}`)
  }
  if (addresses.length === 0) throw new Error(`图片主机无法解析：${host}`)
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('拒绝下载解析到内网地址的图片')
  }
  const first = addresses[0]
  if (first === undefined) throw new Error(`图片主机无法解析：${host}`)
  return { url, address: first.address, family: first.family }
}

/** One GET against an already-validated, pinned target (no redirect following). */
function requestImageHop(target: PublicTarget, referer: string, maxBytes: number, timeoutMs: number): Promise<ImageHopResult> {
  return new Promise<ImageHopResult>((resolveP, rejectP) => {
    const isHttps = target.url.protocol === 'https:'
    const requester = isHttps ? httpsGet : httpGet
    // Node calls `lookup(hostname, options, cb)`; answer with the address the
    // SSRF guard approved so DNS is never consulted a second time.
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all === true) {
        callback(null, [{ address: target.address, family: target.family }])
        return
      }
      callback(null, target.address, target.family)
    }
    const request = requester({
      protocol: target.url.protocol,
      hostname: target.url.hostname,
      port: target.url.port.length > 0 ? Number(target.url.port) : (isHttps ? 443 : 80),
      path: `${target.url.pathname}${target.url.search}`,
      method: 'GET',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; dsh-tiddlywiki clip bridge)',
        referer,
        accept: 'image/*,*/*;q=0.8',
        // No transparent decompression: the byte cap must apply to what we store.
        'accept-encoding': 'identity',
      },
      lookup: pinnedLookup,
    }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400) {
        const location = res.headers.location
        res.resume()
        if (location === undefined || location.length === 0) {
          rejectP(new Error(`重定向缺少 Location（HTTP ${status}）`))
          return
        }
        resolveP({ buffer: Buffer.alloc(0), type: undefined, redirect: new URL(location, target.url).href })
        return
      }
      if (status < 200 || status >= 300) {
        res.resume()
        rejectP(new Error(`下载失败 HTTP ${status}`))
        return
      }
      // Cheap up-front rejection when the server declares a size.
      const declared = Number(res.headers['content-length'] ?? Number.NaN)
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy()
        rejectP(new Error('图片超过 15MB 上限'))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) {
          // STREAMING cap: stop reading instead of buffering the whole body and
          // checking afterwards (a chunked or zip-bomb response used to fill
          // memory before the limit was applied).
          res.destroy()
          rejectP(new Error('图片超过 15MB 上限'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (size === 0) {
          rejectP(new Error('下载内容为空'))
          return
        }
        resolveP({ buffer: Buffer.concat(chunks), type: res.headers['content-type'] })
      })
      res.on('error', rejectP)
    })
    request.on('timeout', () => { request.destroy(new Error('图片下载超时')) })
    request.on('error', rejectP)
    request.setTimeout(timeoutMs)
  })
}

/**
 * Download one clip image with the full SSRF posture: every hop is validated
 * AND pinned, redirects are followed manually (max `maxRedirects`), the byte
 * cap is enforced while streaming, and compression is disabled.
 */
export async function downloadClipImage(
  imageUrl: string,
  referer: string,
  options: { maxBytes?: number; maxRedirects?: number; timeoutMs?: number } = {},
): Promise<{ buffer: Buffer; type: string | undefined }> {
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES
  const maxRedirects = options.maxRedirects ?? 3
  const timeoutMs = options.timeoutMs ?? 20_000
  let current = imageUrl
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const target = await resolvePublicTarget(current)
    const result = await requestImageHop(target, referer, maxBytes, timeoutMs)
    if (result.redirect !== undefined) {
      current = result.redirect
      continue
    }
    return { buffer: result.buffer, type: result.type }
  }
  throw new Error(`图片重定向次数超过 ${maxRedirects} 次`)
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

/** Build the markdown tiddler for ONE TEXT-ONLY clip (no images). */
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

/**
 * Build the note tiddler for a clip WITH stored images: wikitext so the
 * attachments render inline via `[img[Title]]` (works in the embedded TW,
 * story view and /tw/render). Failed downloads degrade to plain URL lines.
 */
export function buildImageNoteTiddler(opts: {
  title: string
  url: string
  text?: string
  tag: string
  source?: string
  at?: string
  stored: string[]
  failed: Array<{ url: string; error: string }>
  extraTags?: string[]
}): Tiddler {
  const at = opts.at ?? new Date().toISOString()
  const selection = typeof opts.text === 'string' ? opts.text.trim() : ''
  const lines = [`> 来源：${opts.url}`, '']
  if (selection.length > 0) lines.push(selection, '')
  lines.push('---', '!! 图片')
  for (const title of opts.stored) lines.push(`[img[${title}]]`)
  for (const f of opts.failed) lines.push(`* ${f.url}（${f.error}）`)
  lines.push('', '---', `剪藏时间：${at}`)
  const tags = [opts.tag, ...(opts.extraTags ?? [])].filter((t) => t.trim().length > 0)
  return {
    title: opts.title,
    text: lines.join('\n'),
    type: 'text/vnd.tiddlywiki',
    ...(tags.length > 0 ? { tags } : {}),
    'clip-url': opts.url,
    'clip-source': opts.source ?? 'bookmarklet',
    'clip-at': at,
  }
}

/** Build a binary attachment tiddler: `type: <mime>`, `text: <base64>`. */
export function buildBinaryTiddler(opts: {
  title: string
  mime: string
  buffer: Uint8Array | Buffer
  srcUrl: string
  noteTitle: string
  tag: string
  source?: string
  at?: string
}): Tiddler {
  const at = opts.at ?? new Date().toISOString()
  const tags = [opts.tag].filter((t) => t.trim().length > 0)
  return {
    title: opts.title,
    type: opts.mime,
    text: Buffer.from(opts.buffer).toString('base64'),
    ...(tags.length > 0 ? { tags } : {}),
    'clip-url': opts.srcUrl,
    'clip-source': opts.source ?? 'bookmarklet',
    'clip-at': at,
    'clip-note': opts.noteTitle,
  }
}

/** Known image extensions → mime (used when a CDN mislabels as octet-stream). */
const IMAGE_EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
}

/**
 * Decide the stored mime for a downloaded image: an `image/*` content-type
 * wins; otherwise a known image extension in the URL rescues CDNs that serve
 * `application/octet-stream`. null = not (recognizably) an image.
 */
export function pickImageMime(contentType: string | null, url: string): string | null {
  const ct = ((contentType ?? '').split(';')[0] ?? '').trim().toLowerCase()
  if (ct.startsWith('image/')) return ct
  const ext = ((url.split('?')[0] ?? '').split('.').pop() ?? '').toLowerCase()
  if (ct === 'application/octet-stream' && IMAGE_EXT_MIME[ext] !== undefined) return IMAGE_EXT_MIME[ext]
  return null
}

/** File extension for a stored image mime. */
export function imageExtensionForMime(mime: string): string {
  const map: Record<string, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/x-icon': 'ico',
  }
  if (map[mime] !== undefined) return map[mime]
  const subtype = (mime.split('/')[1] ?? 'img').replace(/[^a-z0-9]/gi, '')
  return subtype.length > 0 ? subtype.slice(0, 8) : 'img'
}

function cleanStr(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Validate a clip payload → normalized value or an error. */
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
  let images: string[] = []
  if (Array.isArray(raw.images)) {
    images = raw.images
      .filter((u): u is string => typeof u === 'string')
      .map((u) => u.trim())
      .filter((u) => u.length > 0 && u.length <= 2000)
      .slice(0, MAX_CLIP_IMAGES)
  }
  if (title.length === 0) return { ok: false, error: '缺少 title（页面标题）' }
  if (url.length === 0) return { ok: false, error: '缺少 url（页面地址）' }
  return { ok: true, value: { title, url, text, tags: extraTags, source, images } }
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
    const { title, url, text, tags, source, images } = parsed.value

    let resolvedTitle: string
    try {
      resolvedTitle = await resolveClipTitle((t) => this.deps.exists(t), title)
    } catch {
      this.respond(res, { ok: false, error: 'TiddlyWiki 服务暂不可用，请稍后重试' }, 503)
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
      this.respond(res, { ok: false, error: 'TiddlyWiki 服务暂不可用，剪藏未写入' }, 503)
      return
    }
    this.respond(res, { ok: true, title: resolvedTitle, url, tag: cfg.tag, source: sourceName, images: imageResults })
  }
}
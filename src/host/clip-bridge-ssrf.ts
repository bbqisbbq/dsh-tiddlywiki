/**
 * The clip bridge's SSRF posture: URL validation, DNS pinning, manual redirect
 * following and the byte-capped download (v0.30.0: split out of
 * `clip-bridge.ts`, which was 870 lines mixing three concerns).
 *
 * WHY ITS OWN MODULE: this is the only part of the bridge that talks to the
 * public internet on behalf of a web page, so it is the part most worth reading
 * on its own. `assertPublicImageUrl()` is the pre-flight guard every image URL
 * must pass; `downloadClipImage()` re-validates AND pins EVERY redirect hop
 * (DNS rebinding cannot swap the answer between check and connect).
 *
 * @module dsh-tiddlywiki/host/clip-bridge-ssrf
 */
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { LookupFunction } from 'node:net'
import { MAX_IMAGE_BYTES } from './clip-bridge-limits.ts'
/** IPv4 ranges that must never be fetched on behalf of a web page. */
const PRIVATE_V4_PATTERNS = [
  /^0\./, // "this network"
  /^10\./, // private
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64/10
  /^127\./, // loopback
  /^169\.254\./, // link-local (cloud metadata 169.254.169.254)
  /^172\.(1[6-9]|2\d|3[01])\./, // private
  /^192\.0\.0\./, // IETF protocol assignments
  /^192\.0\.2\./, // TEST-NET-1
  /^192\.88\.99\./, // 6to4 relay anycast
  /^192\.168\./, // private
  /^198\.1[89]\./, // benchmarking 198.18/15
  /^198\.51\.100\./, // TEST-NET-2
  /^203\.0\.113\./, // TEST-NET-3
  /^22[4-9]\./, /^23\d\./, // multicast 224/4
  /^24\d\./, /^25[0-5]\./, // reserved 240/4 (incl. 255.255.255.255 broadcast)
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
 * private address. Redirects are re-validated per hop by the caller.
 *
 * v0.20.0: this used to be a second, hand-maintained copy of the policy inside
 * `resolvePublicTarget` (the two had to be kept in sync by hand). It now simply
 * performs the same resolve-and-validate step and discards the pinned target;
 * `downloadClipImage` still pins the approved address, so the check is not
 * duplicated at connect time either.
 */
export async function assertPublicImageUrl(rawUrl: string): Promise<void> {
  await resolvePublicTarget(rawUrl)
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

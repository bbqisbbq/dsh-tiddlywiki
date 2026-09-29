/**
 * Pure payload ↔ tiddler translation for the clip bridge (v0.30.3: split out of
 * `clip-bridge.ts`, which mixed the network guard, the payload builders and the
 * loopback server in one 870-line file).
 *
 * WHAT BELONGS HERE: everything that turns a bookmarklet's JSON into TW tiddlers
 * (or validates it) and touches no network and no server — the title de-dup
 * rule, the three tiddler builders, the mime/extension mapping and the payload
 * validator (which also enforces the `$:/` system-namespace refusal).
 *
 * @module dsh-tiddlywiki/host/clip-bridge-payload
 */
import { MAX_CLIP_IMAGES, MAX_CLIP_TEXT_LENGTH } from './clip-bridge-limits.ts'
import type { Tiddler } from './tw-api.ts'
import type { ClipPayload } from './clip-bridge.ts'
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
  // v0.29.0 SECURITY: the bridge is reachable from an ARBITRARY page by design
  // (a bookmarklet runs in the page's origin, so no Origin/Sec-Fetch-Site check
  // can be added without breaking the feature), and `bridge.token` is empty by
  // default — so the title it accepts must at least stay out of the SYSTEM
  // namespace. It used to be taken verbatim, which let a malicious page
  // `PUT $:/plugins/dsh-tiddlywiki/config` with attacker JSON: the ConfigStore
  // then reads it (`wechat.command` is spawned as a CLI, `git.remote` is used
  // for the next sync) — or simply overwrite the plugin's own state. No
  // legitimate web clip lands under `$:/`.
  if (title.startsWith('$:/')) {
    return { ok: false, error: '标题落在系统命名空间（$:/…）：剪藏桥拒绝写入' }
  }
  if (url.length === 0) return { ok: false, error: '缺少 url（页面地址）' }
  return { ok: true, value: { title, url, text, tags: extraTags, source, images } }
}

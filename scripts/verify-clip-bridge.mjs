#!/usr/bin/env node
/**
 * Verify the local clip bridge (v0.16.25) headlessly against an in-memory
 * tiddler store: bind → health info → clip write + title dedupe → CORS
 * preflight → Host-header (DNS-rebinding) gate → optional token gate →
 * disabled 503 → bad-request 400 → IMAGE flows (download → binary attachment
 * tiddler + wikitext note with [img[...]] embeds; partial/all-failure
 * degradation; octet-stream CDN rescue; 10-image cap) → pure builders → the
 * seeded bookmarklet parses as valid JS.
 *
 * Run AFTER `npm run build` (imports the bundled lib/index.js).
 *
 *   node scripts/verify-clip-bridge.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-clip-bridge
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { ClipBridge, buildClipTiddler, buildImageNoteTiddler, buildBinaryTiddler, hostAllowed, parseClipPayload, pickImageMime, imageExtensionForMime, resolveClipTitle, CLIP_BRIDGE_DOC_TEXT } from '../lib/index.js'

let failures = 0
function test(name, fn) {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures++
    console.error(`FAIL  ${name}\n      ${err && err.message ? err.message : err}`)
  }
}

async function request(url, init = {}) {
  const res = await fetch(url, init)
  let body = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON response (e.g. the raw 400 socket reply) */
  }
  return { status: res.status, headers: res.headers, body }
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex')
const PNG_B64 = PNG.toString('base64')

// ---------------------------------------------------------------------------
console.log('pure builders')
// ---------------------------------------------------------------------------
test('hostAllowed accepts loopback hosts only', () => {
  assert.equal(hostAllowed('127.0.0.1:8618', 8618), true)
  assert.equal(hostAllowed('127.0.0.1', 8618), true)
  assert.equal(hostAllowed('localhost:8618', 8618), true)
  assert.equal(hostAllowed('[::1]:8618', 8618), true)
  assert.equal(hostAllowed('127.0.0.1:9999', 8618), false)
  assert.equal(hostAllowed('evil.example.com', 8618), false)
  assert.equal(hostAllowed(undefined, 8618), false)
})

test('parseClipPayload validates and normalizes (incl. images cap)', () => {
  const ok = parseClipPayload({ title: '  A  ', url: 'https://x', text: 'sel', tags: ['t1', 42, '', 't2'], source: ' api ', images: [' https://x/a.png ', '', 7] })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.deepEqual(ok.value, { title: 'A', url: 'https://x', text: 'sel', tags: ['t1', 't2'], source: 'api', images: ['https://x/a.png'] })
  }
  const capped = parseClipPayload({ title: 'A', url: 'https://x', images: Array.from({ length: 12 }, (_, i) => `https://x/${i}.png`) })
  assert.equal(capped.ok, true)
  if (capped.ok) assert.equal(capped.value.images.length, 10)
  assert.equal(parseClipPayload(null).ok, false)
  assert.equal(parseClipPayload([]).ok, false)
  assert.equal(parseClipPayload({ url: 'https://x' }).ok, false)          // no title
  assert.equal(parseClipPayload({ title: 'A' }).ok, false)                // no url
  assert.equal(parseClipPayload('nope').ok, false)
})

test('resolveClipTitle dedupes with（n）suffix then timestamp', async () => {
  const taken = new Set(['A', 'A（2）'])
  const exists = async (t) => taken.has(t)
  assert.equal(await resolveClipTitle(exists, 'A'), 'A（3）')
  assert.equal(await resolveClipTitle(exists, 'B'), 'B')
})

test('buildClipTiddler produces expected markdown + fields', () => {
  const t = buildClipTiddler({ title: 'A', url: 'https://x', text: '  sel  ', tag: 'clip', source: 'bookmarklet', at: '2026-09-09T08:00:00.000Z' })
  assert.equal(t.type, 'text/markdown')
  assert.deepEqual(t.tags, ['clip'])
  assert.equal(t['clip-url'], 'https://x')
  assert.equal(t['clip-source'], 'bookmarklet')
  assert.match(t.text, /> 来源：https:\/\/x/)
  assert.match(t.text, /sel/)
})

test('buildImageNoteTiddler embeds stored + lists failed', () => {
  const t = buildImageNoteTiddler({
    title: 'N', url: 'https://x', text: '正文', tag: 'clip', source: 'bookmarklet', at: '2026-09-09T08:00:00.000Z',
    stored: ['N 图片 1.png'], failed: [{ url: 'https://x/bad.png', error: 'HTTP 403' }],
  })
  assert.equal(t.type, 'text/vnd.tiddlywiki')
  assert.match(t.text, /\[img\[N 图片 1\.png\]\]/)
  assert.match(t.text, /https:\/\/x\/bad\.png（HTTP 403）/)
})

test('buildBinaryTiddler stores base64 + provenance', () => {
  const t = buildBinaryTiddler({ title: 'A 图片 1.png', mime: 'image/png', buffer: PNG, srcUrl: 'https://cdn/a.png', noteTitle: 'A', tag: 'clip', source: 'bookmarklet', at: '2026-09-09T08:00:00.000Z' })
  assert.equal(t.type, 'image/png')
  assert.equal(t.text, PNG_B64)
  assert.deepEqual(t.tags, ['clip'])
  assert.equal(t['clip-url'], 'https://cdn/a.png')
  assert.equal(t['clip-note'], 'A')
})

test('pickImageMime + imageExtensionForMime', () => {
  assert.equal(pickImageMime('image/jpeg; charset=…', 'https://x/a'), 'image/jpeg')
  assert.equal(pickImageMime('application/octet-stream', 'https://cdn/a.png'), 'image/png')
  assert.equal(pickImageMime('text/html', 'https://x/a.png'), null)
  assert.equal(pickImageMime(null, 'https://x/a'), null)
  assert.equal(imageExtensionForMime('image/png'), 'png')
  assert.equal(imageExtensionForMime('image/svg+xml'), 'svg')
  assert.equal(imageExtensionForMime('image/x-weird'), 'xweird')
})

test('seed doc bookmarklet is valid JS (new Function)', () => {
  const fence = CLIP_BRIDGE_DOC_TEXT.match(/```javascript\n([\s\S]*?)\n```/)
  assert.ok(fence, 'seed doc carries a javascript code fence')
  const code = fence[1].replace(/^javascript:/, '')
  assert.doesNotThrow(() => new Function(code), 'bookmarklet body must parse')
  assert.ok(fence[1].includes('x-clip-token'), 'bookmarklet ships the token header')
  assert.ok(fence[1].includes('images:urls'), 'bookmarklet sends chosen images')
  // v0.16.26 regression guards: overlay fields must be resolved SCOPED to the
  // overlay (p.querySelector) — never unscoped document.getElementById — and
  // values set only AFTER document.body.appendChild(ov). The 0.16.25
  // bookmarklet crashed in real pages: getElementById returned null because p
  // was still detached from the document when cb_t/cb_s were populated.
  assert.ok(!code.includes("document.getElementById('cb_"), 'overlay ids resolved via p.querySelector, not document.getElementById')
  assert.ok(code.includes("Q('cb_t')") && !code.includes("E('cb_t')"), 'field getter is Q (scoped) everywhere')
  const attachAt = code.indexOf('document.body.appendChild(ov)')
  const valueAt = code.indexOf("Q('cb_t').value=t")
  assert.ok(attachAt >= 0 && valueAt > attachAt, 'overlay is attached BEFORE field values are set')
})

// ---------------------------------------------------------------------------
console.log('live bridge (in-memory store)')
// ---------------------------------------------------------------------------
const store = new Map()
function makeDeps(overrides = {}) {
  const state = { enabled: true, port: 0, token: '', tag: 'clip' }
  return {
    state,
    bridge: new ClipBridge({
      getConfig: () => ({ ...state }),
      write: async (tiddler) => { store.set(tiddler.title, tiddler) },
      exists: async (title) => store.has(title),
      // Default: image downloads are unexpected unless a stub is supplied.
      download: async () => { throw new Error('unexpected download (text-only test)') },
      log: () => {},
      ...overrides,
    }),
  }
}

const { state, bridge } = makeDeps()
await bridge.start(0)
const base = `http://127.0.0.1:${bridge.port}`
const clip = (title, url, text) => request(`${base}/clip`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title, url, text }),
})

test('GET / health info', async () => {
  const r = await request(`${base}/`)
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.enabled, true)
  assert.equal(r.body.port, bridge.port)
  assert.equal(r.body.tokenSet, false)
})

test('POST /clip writes one markdown tiddler (bookmarklet)', async () => {
  const r = await clip('测试页面', 'https://example.com/a', '选中的文字')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.title, '测试页面')
  const t = store.get('测试页面')
  assert.ok(t, 'tiddler stored')
  assert.equal(t.type, 'text/markdown')
  assert.deepEqual(t.tags, ['clip'])
  assert.equal(t['clip-url'], 'https://example.com/a')
  assert.match(t.text, /选中的文字/)
})

test('same title again →（2）, never overwrites', async () => {
  const r = await clip('测试页面', 'https://example.com/a', '第二次')
  assert.equal(r.status, 200)
  assert.equal(r.body.title, '测试页面（2）')
  assert.ok(store.get('测试页面'))
  assert.ok(store.get('测试页面（2）'))
})

test('extra tags merge with the clip tag', async () => {
  const r = await request(`${base}/clip`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '带标签', url: 'https://example.com/b', text: '', tags: ['调研', 'web'] }),
  })
  assert.equal(r.status, 200)
  assert.deepEqual(store.get('带标签').tags, ['clip', '调研', 'web'])
})

test('OPTIONS preflight → 204 + CORS/PNA headers', async () => {
  const r = await request(`${base}/clip`, { method: 'OPTIONS' })
  assert.equal(r.status, 204)
  assert.equal(r.headers.get('access-control-allow-origin'), '*')
  assert.equal(r.headers.get('access-control-allow-private-network'), 'true')
  assert.match(r.headers.get('access-control-allow-headers') ?? '', /x-clip-token/)
})

test('non-loopback Host header → 403 (DNS rebinding)', async () => {
  const status = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: bridge.port, path: '/clip', method: 'POST', headers: { host: 'evil.example.com', 'content-type': 'application/json' } }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', resolve)
    req.end(JSON.stringify({ title: 'x', url: 'https://x' }))
  })
  assert.equal(status, 403)
})

test('bad JSON / missing fields → 400', async () => {
  const bad = await request(`${base}/clip`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })
  assert.equal(bad.status, 400)
  const noTitle = await request(`${base}/clip`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://x' }) })
  assert.equal(noTitle.status, 400)
})

test('disabled → 503 with guidance', async () => {
  state.enabled = false
  const r = await clip('x', 'https://x', '')
  assert.equal(r.status, 503)
  assert.match(r.body.error, /未启用/)
  state.enabled = true
})

test('token gate: 401 without / with wrong token, 200 with it', async () => {
  state.token = 's3cret'
  const noHeader = await clip('y', 'https://y', '')
  assert.equal(noHeader.status, 401)
  const wrong = await request(`${base}/clip`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-clip-token': 'nope' },
    body: JSON.stringify({ title: 'y', url: 'https://y' }),
  })
  assert.equal(wrong.status, 401)
  const right = await request(`${base}/clip`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-clip-token': 's3cret' },
    body: JSON.stringify({ title: 'y', url: 'https://y', text: 'hi' }),
  })
  assert.equal(right.status, 200)
  assert.equal(right.body.title, 'y')
  state.token = ''
})

test('wiki not ready → 503 (write throws)', async () => {
  const { bridge: b2 } = makeDeps()
  b2.deps = { ...b2.deps, write: async () => { throw new Error('wiki down') }, exists: async () => { throw new Error('wiki down') } }
  await b2.start(0)
  const r = await request(`http://127.0.0.1:${b2.port}/clip`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'z', url: 'https://z' }),
  })
  assert.equal(r.status, 503)
  await b2.stop()
})

test('unknown path → 404', async () => {
  const r = await request(`${base}/nope`)
  assert.equal(r.status, 404)
})

// ---------------------------------------------------------------------------
console.log('image flows (stubbed download)')
// ---------------------------------------------------------------------------
// download stub: url → bytes; a 'fail' marker URL throws.
const images = new Map([
  ['https://cdn/ok.png', { buffer: PNG, type: 'image/png' }],
  ['https://cdn/cdn.png', { buffer: PNG, type: 'application/octet-stream' }], // CDN mislabel
  ['https://cdn/fail.png', { buffer: PNG, type: 'image/png' }],
])
const { bridge: bImg } = makeDeps({
  download: async (url) => {
    if (url.includes('fail')) throw new Error('HTTP 403')
    const hit = images.get(url)
    if (hit === undefined) throw new Error('404')
    return hit
  },
})
await bImg.start(0)
const imgBase = `http://127.0.0.1:${bImg.port}`
const clipWithImages = (title, url, text, urls) => request(`${imgBase}/clip`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title, url, text, images: urls }),
})

test('chosen images → binary attachments + wikitext note with [img[...]]', async () => {
  const r = await clipWithImages('图片页A', 'https://page/a', '配图正文', ['https://cdn/ok.png'])
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.ok(Array.isArray(r.body.images) && r.body.images.length === 1 && r.body.images[0].ok, 'per-image result ok')

  const note = store.get('图片页A')
  assert.ok(note, 'note stored')
  assert.equal(note.type, 'text/vnd.tiddlywiki', 'note switches to wikitext when images present')
  assert.match(note.text, /\[img\[图片页A 图片 1\.png\]\]/)
  assert.match(note.text, /配图正文/)

  const att = store.get('图片页A 图片 1.png')
  assert.ok(att, 'attachment tiddler stored')
  assert.equal(att.type, 'image/png')
  assert.equal(att.text, PNG_B64, 'base64 roundtrips byte-exact')
  assert.deepEqual(att.tags, ['clip'])
  assert.equal(att['clip-url'], 'https://cdn/ok.png')
  assert.equal(att['clip-note'], '图片页A')
})

test('partial failure → embed the stored one + degrade the failed one to a URL line', async () => {
  const r = await clipWithImages('图片页B', 'https://page/b', '', ['https://cdn/ok.png', 'https://cdn/fail.png'])
  assert.equal(r.status, 200)
  assert.equal(r.body.images[0].ok, true)
  assert.equal(r.body.images[1].ok, false)
  assert.match(r.body.images[1].error, /403/)

  const note = store.get('图片页B')
  assert.equal(note.type, 'text/vnd.tiddlywiki')
  assert.match(note.text, /\[img\[图片页B 图片 1\.png\]\]/)
  assert.match(note.text, /https:\/\/cdn\/fail\.png（HTTP 403）/)
  assert.ok(store.get('图片页B 图片 1.png'), 'stored image exists')
})

test('all images fail → wikitext note still lists the URLs (no silent loss)', async () => {
  const r = await clipWithImages('图片页C', 'https://page/c', '无图成功', ['https://cdn/fail.png'])
  assert.equal(r.status, 200)
  assert.equal(r.body.images[0].ok, false)
  const note = store.get('图片页C')
  assert.equal(note.type, 'text/vnd.tiddlywiki', 'note stays wikitext so failed URLs are visible')
  assert.match(note.text, /https:\/\/cdn\/fail\.png/)
  assert.doesNotMatch(note.text, /\[img\[/)
})

test('CDN octet-stream + .png extension → stored as image/png', async () => {
  const r = await clipWithImages('图片页D', 'https://page/d', '', ['https://cdn/cdn.png'])
  assert.equal(r.status, 200)
  assert.equal(r.body.images[0].ok, true)
  const att = store.get('图片页D 图片 1.png')
  assert.ok(att && att.type === 'image/png', 'octet-stream rescued by extension')
})

test('text-only clip still writes markdown (regression)', async () => {
  const r = await request(`${imgBase}/clip`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '纯文字页E', url: 'https://page/e', text: '只有文字' }),
  })
  assert.equal(r.status, 200)
  const note = store.get('纯文字页E')
  assert.equal(note.type, 'text/markdown')
  assert.doesNotMatch(note.text, /\[img\[/)
})

await bridge.stop()
await bImg.stop()

console.log(failures === 0 ? `\nclip bridge verify: ALL PASSED` : `\nclip bridge verify: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
#!/usr/bin/env node
/**
 * Verify the local clip bridge (v0.16.24) headlessly against an in-memory
 * tiddler store: bind → health info → clip write + title dedupe → CORS
 * preflight → Host-header (DNS-rebinding) gate → optional token gate →
 * disabled 503 → bad-request 400 → pure builders.
 *
 * Run AFTER `npm run build` (imports the bundled lib/index.js).
 *
 *   node scripts/verify-clip-bridge.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-clip-bridge
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { ClipBridge, buildClipTiddler, hostAllowed, parseClipPayload, resolveClipTitle } from '../lib/index.js'

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

test('parseClipPayload validates and normalizes', () => {
  const ok = parseClipPayload({ title: '  A  ', url: 'https://x', text: 'sel', tags: ['t1', 42, '', 't2'], source: ' api ' })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.deepEqual(ok.value, { title: 'A', url: 'https://x', text: 'sel', tags: ['t1', 't2'], source: 'api' })
  }
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

await bridge.stop()
await bridge.stop() // idempotent

console.log(failures === 0 ? `\nclip bridge verify: ALL PASSED` : `\nclip bridge verify: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
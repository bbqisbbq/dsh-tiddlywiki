// One-shot E2E: real wiki + real HTTP server exposing the admin routes —
// verify GET /admin/seeds (statuses) and POST /admin/seeds/run (force single
// + all) drive the unified seed registry end to end.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import {
  WikiServer,
  TiddlyWebClient,
  ConfigStore,
  TW_PROXY_PATH,
  registerAdminRoutes,
  runAllSeeds,
  checkAllSeeds,
  runSeedById,
} from '../lib/index.js'

const ROUTE_PREFIX = '/dsh-tiddlywiki'
const root = await mkdtemp(join(tmpdir(), 'dsh-tw-seeds-admin-'))
console.log('temp wiki root:', root)
const server = new WikiServer({ wikiRoot: root, wiki: 'main', port: 0 })

// Minimal webServer face recording registered routes like dsh-host-webserver.
const registered = []
const webServer = {
  register: (entry) => {
    registered.push(entry)
    return () => {
      const i = registered.indexOf(entry)
      if (i >= 0) registered.splice(i, 1)
    }
  },
}

let clientRef = undefined
const deps = {
  server,
  getClient: () => clientRef,
  getWikiPath: () => root,
  twRoot: () => root,
  config: new ConfigStore({}),
  seeds: {
    checkAll: async (c) => checkAllSeeds({ client: c }),
    run: async (c, id, force) => runSeedById({ client: c }, id, force),
  },
}

// Real HTTP dispatcher: exact then longest-prefix (mirrors host webserver).
const mini = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  let handler
  const exact = registered.find((r) => r.kind === 'exact' && r.path === pathname)
  if (exact !== undefined) handler = exact.handler
  else {
    let best
    for (const r of registered) {
      if (r.kind !== 'prefix') continue
      if (pathname !== r.path && !pathname.startsWith(`${r.path}/`)) continue
      if (best === undefined || r.path.length > best.path.length) best = r
    }
    handler = best?.handler
  }
  if (handler === undefined) { res.writeHead(404); res.end(); return }
  Promise.resolve(handler(req, res)).catch((err) => {
    if (!res.headersSent) { res.writeHead(400); res.end(String(err)) }
    else res.destroy()
  })
})

const post = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

try {
  const view = await server.start()
  clientRef = new TiddlyWebClient(view.url)
  const dispose = registerAdminRoutes({ webServer }, deps)

  const base = `http://127.0.0.1:${await new Promise((resolveP) => mini.listen(0, '127.0.0.1', () => resolveP(mini.address().port)))}`

  // 1. GET statuses on a FRESH wiki: all five seeds missing.
  let res = await fetch(`${base}${ROUTE_PREFIX}/admin/seeds`)
  let data = await res.json()
  console.log('fresh statuses:', data.items?.map((i) => `${i.id}:${i.present}`).join(' '))
  if (res.status !== 200 || data.ok !== true || data.items?.length !== 5) throw new Error('expected 5 seed statuses')
  if (data.items.some((i) => i.present)) throw new Error('fresh wiki must report everything missing')

  // 2. Startup path (runAllSeeds) writes all five; statuses flip to present.
  const startup = await runAllSeeds({ client: clientRef })
  if (startup.length !== 5 || !startup.every((r) => r.ok && r.wrote)) throw new Error('runAllSeeds failed on fresh wiki')
  res = await fetch(`${base}${ROUTE_PREFIX}/admin/seeds`)
  data = await res.json()
  console.log('after startup:', data.items?.map((i) => `${i.id}:${i.present}`).join(' '))
  if (!data.items.every((i) => i.present)) throw new Error('all seeds should be present after startup')

  // 3. Force single seed via HTTP: corrupt home tiddler, then POST run force.
  await clientRef.put({ title: '所有标签', text: 'corrupted', tags: ['索引'] })
  let run = await post(`${base}${ROUTE_PREFIX}/admin/seeds/run`, { id: 'home-index', force: true })
  console.log('force home-index:', JSON.stringify(run.json?.results?.[0]))
  if (run.status !== 200 || run.json?.results?.[0]?.ok !== true || run.json.results[0].wrote !== true) throw new Error('force single seed failed')
  const restored = await clientRef.get('所有标签')
  if (!restored?.text.includes('agent-tags-pure')) throw new Error('home tiddler not restored by force')

  // 4. Non-force single seed is a no-op while present (user content preserved).
  await clientRef.put({ title: '所有标签', text: 'user edit', tags: ['索引'] })
  run = await post(`${base}${ROUTE_PREFIX}/admin/seeds/run`, { id: 'home-index' })
  console.log('non-force home-index:', JSON.stringify(run.json?.results?.[0]))
  if (run.json?.results?.[0]?.wrote !== false) throw new Error('non-force must not overwrite user content')
  const still = await clientRef.get('所有标签')
  if (still?.text !== 'user edit') throw new Error('user edit must survive non-force run')

  // 5. Force ALL seeds via HTTP (tw-web-host included → proxy path restored).
  await clientRef.put({ title: '$:/config/tiddlyweb/host', text: 'https://custom.example/', type: 'text/plain', tags: [] })
  run = await post(`${base}${ROUTE_PREFIX}/admin/seeds/run`, { force: true })
  console.log('force all:', run.json?.results?.map((r) => `${r.id}:${r.ok}`).join(' '))
  if (run.status !== 200 || !run.json?.results?.every((r) => r.ok)) throw new Error('force-all failed')
  const host = await clientRef.get('$:/config/tiddlyweb/host')
  if (host?.text !== TW_PROXY_PATH) throw new Error('tw-web-host not restored by force-all')

  // 6. Unknown id → 400 with explicit error.
  run = await post(`${base}${ROUTE_PREFIX}/admin/seeds/run`, { id: 'nope', force: true })
  console.log('unknown id:', run.status, JSON.stringify(run.json))
  if (run.status !== 400 || run.json?.ok !== false) throw new Error('unknown seed id must 400')

  await new Promise((resolveP) => mini.close(resolveP))
  dispose()
  console.log('E2E OK')
} finally {
  await server.stop()
  await rm(root, { recursive: true, force: true })
}

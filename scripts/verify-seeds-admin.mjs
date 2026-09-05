// One-shot E2E: real wiki + real HTTP server exposing the admin routes —
// verify GET /admin/seeds (statuses), POST /admin/seeds/run (force single +
// all) and POST /admin/seeds/remove (反初始化) drive the unified seed registry
// end to end. v0.15.0: the startup path (runAllSeeds) seeds ONLY the two CORE
// items; optional seeds are opt-in from the settings page.
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
  removeSeedById,
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
    remove: async (c, id) => removeSeedById({ client: c }, id),
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

  // 1. GET statuses on a FRESH wiki: all six seeds missing.
  let res = await fetch(`${base}${ROUTE_PREFIX}/admin/seeds`)
  let data = await res.json()
  console.log('fresh statuses:', data.items?.map((i) => `${i.id}:${i.present}`).join(' '))
  if (res.status !== 200 || data.ok !== true || data.items?.length !== 6) throw new Error('expected 6 seed statuses')
  if (data.items.some((i) => i.present)) throw new Error('fresh wiki must report everything missing')

  // 2. Startup path (runAllSeeds, v0.15.0) seeds ONLY the two CORE items;
  // the four optional seeds stay missing (opt-in, never forced).
  const startup = await runAllSeeds({ client: clientRef })
  if (startup.length !== 2 || !startup.every((r) => r.ok && r.wrote)) throw new Error('runAllSeeds must seed exactly the two core items')
  if (!startup.every((r) => r.id === 'send-to-agent' || r.id === 'tw-web-host')) throw new Error('runAllSeeds must only touch send-to-agent + tw-web-host')
  res = await fetch(`${base}${ROUTE_PREFIX}/admin/seeds`)
  data = await res.json()
  console.log('after startup:', data.items?.map((i) => `${i.id}:${i.present}`).join(' '))
  const coreIds = ['send-to-agent', 'tw-web-host']
  const optionalIds = ['doc-note', 'home-index', 'all-articles', 'menubar-theme']
  if (!data.items.every((i) => coreIds.includes(i.id) ? i.present : !i.present)) throw new Error('after startup: core present, optional missing')
  if (!data.items.every((i) => i.removable === optionalIds.includes(i.id))) throw new Error('removable flag must mark exactly the optional seeds')

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

  // 7. POST /admin/seeds/remove (反初始化, v0.15.0): removes an optional
  // seed's tiddlers + markers via HTTP; core seeds are rejected with 400.
  run = await post(`${base}${ROUTE_PREFIX}/admin/seeds/remove`, { id: 'menubar-theme' })
  console.log('remove menubar-theme:', JSON.stringify(run.json?.results?.[0]))
  if (run.status !== 200 || run.json?.results?.[0]?.ok !== true) throw new Error('remove optional seed failed')
  if ((await clientRef.get('$:/plugins/dsh-tiddlywiki/menubar-theme')) !== undefined) throw new Error('menubar-theme tiddler not removed')
  if ((await clientRef.get('$:/plugins/dsh-tiddlywiki/seed-menubar-theme')) !== undefined) throw new Error('menubar-theme marker not removed')
  // Core seed remove → 400 (功能必需).
  run = await post(`${base}${ROUTE_PREFIX}/admin/seeds/remove`, { id: 'tw-web-host' })
  console.log('remove core tw-web-host:', run.status, JSON.stringify(run.json))
  if (run.status !== 400 || run.json?.ok !== false) throw new Error('core seed remove must 400')
  if ((await clientRef.get('$:/config/tiddlyweb/host'))?.text !== TW_PROXY_PATH) throw new Error('core tw-web-host must survive remove attempt')
  // Remove-all removes the remaining optional seeds, keeps the core ones.
  run = await post(`${base}${ROUTE_PREFIX}/admin/seeds/remove`, {})
  console.log('remove all:', run.json?.results?.map((r) => `${r.id}:${r.ok}`).join(' '))
  if (run.status !== 200 || run.json?.results?.length !== 4 || !run.json.results.every((r) => r.ok)) throw new Error('remove-all failed')
  const finalStatuses = await (await fetch(`${base}${ROUTE_PREFIX}/admin/seeds`)).json()
  const presentIds = finalStatuses.items.filter((i) => i.present).map((i) => i.id).sort()
  if (JSON.stringify(presentIds) !== JSON.stringify(coreIds)) throw new Error('after remove-all only core seeds remain present')

  await new Promise((resolveP) => mini.close(resolveP))
  dispose()
  console.log('E2E OK')
} finally {
  await server.stop()
  await rm(root, { recursive: true, force: true })
}

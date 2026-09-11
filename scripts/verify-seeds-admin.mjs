// One-shot E2E: real wiki + real HTTP server exposing the admin routes —
// verify GET /admin/seeds (statuses), POST /admin/seeds/run (force single +
// all) and POST /admin/seeds/remove (反初始化) drive the unified seed registry
// end to end. v0.16.22: the startup path (runAllSeeds) seeds the CORE items
// (send-to-agent / render-route / tw-web-host) PLUS the STARTER items (doc-note
// / starter-docs, safe-skip); the four optional seeds are opt-in from the
// settings page.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouteServer } from './lib/tw-harness.mjs'
import {
  WikiServer,
  TiddlyWebClient,
  ConfigStore,
  TW_PROXY_PATH,
  buildPromptText,
  docNoteText,
  hashText,
  registerAdminRoutes,
  registerTiddlywikiTools,
  runAllSeeds,
  checkAllSeeds,
  runSeedById,
  removeSeedById,
  tiddlywikiToolSummary,
  DOC_NOTE_TITLE,
  STARTER_DOCS_ITEMS,
  STARTER_DOCS_MARKER_TITLE,
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
// Fill the tool registry exactly like the plugin's startup does, so the prompt
// preview below is built from the REAL tool summaries (v0.21.0).
registerTiddlywikiTools(
  { tools: { register: () => () => {} } },
  { wiki: () => clientRef, git: {}, wikiPath: () => join(root, 'main'), autoCommit: () => {} },
)
let configChanged = 0
const deps = {
  server,
  getClient: () => clientRef,
  getWikiPath: () => join(root, 'main'),
  twRoot: () => root,
  config: new ConfigStore({}),
  // v0.21.0: the settings page save must notify the plugin so it can
  // re-register its prompt section without a dsh web restart.
  onConfigChanged: () => { configChanged += 1 },
  getPrompt: () => {
    const p = deps.config.get().prompt ?? {}
    const enabled = p.enabled !== false
    return {
      enabled,
      mode: p.mode === 'full' ? 'full' : 'slim',
      text: buildPromptText({
        enabled,
        mode: p.mode,
        extra: typeof p.extra === 'string' ? p.extra : '',
        override: typeof p.override === 'string' ? p.override : '',
        tools: tiddlywikiToolSummary(),
      }),
    }
  },
  seeds: {
    checkAll: async (c) => checkAllSeeds({ client: c, tools: tiddlywikiToolSummary() }),
    run: async (c, id, force) => runSeedById({ client: c, tools: tiddlywikiToolSummary() }, id, force),
    remove: async (c, id) => removeSeedById({ client: c }, id),
  },
}

// Real HTTP dispatcher: exact then longest-prefix (mirrors host webserver).
// Shared with selftest/verify-auth — see scripts/lib/tw-harness.mjs.
const miniHarness = createRouteServer(registered)
const miniBase = await miniHarness.listen()
const mini = miniHarness.server

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

  const base = miniBase

  // 1. GET statuses on a FRESH wiki: all ten seeds missing.
  let res = await fetch(`${base}${ROUTE_PREFIX}/admin/seeds`)
  let data = await res.json()
  console.log('fresh statuses:', data.items?.map((i) => `${i.id}:${i.present}`).join(' '))
  if (res.status !== 200 || data.ok !== true || data.items?.length !== 10) throw new Error('expected 10 seed statuses')
  if (data.items.some((i) => i.present)) throw new Error('fresh wiki must report everything missing')

  // 2. Startup path (v0.16.22) seeds the three CORE items + two STARTER items
  // (doc-note 插件说明 / starter-docs 示例与文档); the four optional seeds stay
  // missing (opt-in, never forced).
  const startup = await runAllSeeds({ client: clientRef })
  if (startup.length !== 5 || !startup.every((r) => r.ok && r.wrote)) throw new Error('runAllSeeds must seed exactly the three core + two starter items')
  if (!startup.every((r) => ['send-to-agent', 'render-route', 'tw-web-host', 'doc-note', 'starter-docs'].includes(r.id))) throw new Error('runAllSeeds must only touch core + starter seeds')
  res = await fetch(`${base}${ROUTE_PREFIX}/admin/seeds`)
  data = await res.json()
  console.log('after startup:', data.items?.map((i) => `${i.id}:${i.present}`).join(' '))
  const coreIds = ['send-to-agent', 'render-route', 'tw-web-host']
  const starterIds = ['doc-note', 'starter-docs']
  const optionalIds = ['home-index', 'all-articles', 'ui-styles', 'menubar-theme', 'clip-bridge']
  if (!data.items.every((i) => coreIds.includes(i.id) || starterIds.includes(i.id) ? i.present : !i.present)) throw new Error('after startup: core + starter present, optional missing')
  if (!data.items.every((i) => i.removable === !coreIds.includes(i.id))) throw new Error('removable flag must mark every non-core seed (core = not removable)')

  // 3. Force single seed via HTTP: corrupt home tiddler, then POST run force.
  await clientRef.put({ title: '所有标签', text: 'corrupted', tags: ['索引'] })
  let run = await post(`${base}${ROUTE_PREFIX}/admin/seeds/run`, { id: 'home-index', force: true })
  console.log('force home-index:', JSON.stringify(run.json?.results?.[0]))
  if (run.status !== 200 || run.json?.results?.[0]?.ok !== true || run.json.results[0].wrote !== true) throw new Error('force single seed failed')
  const restored = await clientRef.get('所有标签')
  if (!restored?.text.includes('agent-tags-pure')) {
    throw new Error(`home tiddler not restored by force (got: ${restored === undefined ? '<missing>' : JSON.stringify(restored.text)?.slice(0, 200)})`)
  }

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
  // Remove-all removes the remaining non-core seeds (5 optional + 2 starter),
  // keeps the core ones.
  run = await post(`${base}${ROUTE_PREFIX}/admin/seeds/remove`, {})
  console.log('remove all:', run.json?.results?.map((r) => `${r.id}:${r.ok}`).join(' '))
  if (run.status !== 200 || run.json?.results?.length !== 7 || !run.json.results.every((r) => r.ok)) throw new Error('remove-all failed')
  const finalStatuses = await (await fetch(`${base}${ROUTE_PREFIX}/admin/seeds`)).json()
  console.log('final statuses:', finalStatuses.items?.map((i) => `${i.id}:${i.present}`).join(' '))
  const presentIds = finalStatuses.items.filter((i) => i.present).map((i) => i.id).sort()
  if (JSON.stringify(presentIds) !== JSON.stringify([...coreIds].sort())) throw new Error('after remove-all only core seeds remain present')

  // 8. v0.21.0 — 注入提示词的预览与「改配置即生效」接线。
  //    GET /admin/prompt 必须回 host 实时拼出的文本；POST /admin/config 必须
  //    触发 onConfigChanged（插件据此重新注册 prompt section，无需重启 dsh web）。
  let promptRes = await fetch(`${base}${ROUTE_PREFIX}/admin/prompt`)
  let promptData = await promptRes.json()
  console.log('prompt (default):', promptRes.status, promptData.mode, promptData.length)
  if (promptRes.status !== 200 || promptData.ok !== true) throw new Error('GET /admin/prompt must answer 200 ok')
  if (promptData.mode !== 'slim') throw new Error('default prompt mode must be slim')
  if (!promptData.text.includes('同步纪律')) throw new Error('prompt text must carry the sync discipline')
  if (/tiddlywiki_[a-z_]+`（[a-z?]/u.test(promptData.text)) throw new Error('slim prompt must not carry a parameter catalogue')

  configChanged = 0
  let saved = await post(`${base}${ROUTE_PREFIX}/admin/config`, { prompt: { mode: 'full', extra: '团队规范：动手前先看 wiki。' } })
  if (saved.status !== 200 || saved.json?.ok !== true) throw new Error(`saving prompt config failed: ${JSON.stringify(saved.json)}`)
  if (configChanged !== 1) throw new Error(`onConfigChanged must fire exactly once per save (got ${configChanged})`)
  promptData = await (await fetch(`${base}${ROUTE_PREFIX}/admin/prompt`)).json()
  console.log('prompt (full+extra):', promptData.mode, promptData.length)
  if (promptData.mode !== 'full') throw new Error('saved mode must reach the preview')
  if (!promptData.text.includes('tiddlywiki_search')) throw new Error('full prompt must list the tool catalogue')
  if (!promptData.text.endsWith('团队规范：动手前先看 wiki。')) throw new Error('extra must be appended at the end')

  saved = await post(`${base}${ROUTE_PREFIX}/admin/config`, { prompt: { enabled: false } })
  if (saved.status !== 200) throw new Error('disabling the prompt must save')
  promptData = await (await fetch(`${base}${ROUTE_PREFIX}/admin/prompt`)).json()
  console.log('prompt (disabled):', promptData.enabled, JSON.stringify(promptData.length))
  if (promptData.enabled !== false || promptData.text !== '') throw new Error('disabled prompt must render empty text')

  // The preview is a READ route: a POST must be rejected by method check.
  const promptPost = await post(`${base}${ROUTE_PREFIX}/admin/prompt`, {})
  console.log('POST /admin/prompt:', promptPost.status)
  if (promptPost.status !== 405) throw new Error(`POST /admin/prompt must be 405, got ${promptPost.status}`)

  // 9. v0.22.0 — seed 内容哈希：区分「内置内容已更新」与「用户自己改过」，
  //    并证明文档正文是**生成**的（工具清单来自注册表，不会再过期）。
  const MARKER = '$:/plugins/dsh-tiddlywiki/seed-doc-note'
  const runDoc = await post(`${base}${ROUTE_PREFIX}/admin/seeds/run`, { id: 'doc-note', force: true })
  if (runDoc.status !== 200 || runDoc.json?.results?.[0]?.wrote !== true) throw new Error('force doc-note failed')
  const tools = tiddlywikiToolSummary()
  const seededText = docNoteText(tools)
  const seededTiddler = await clientRef.get(DOC_NOTE_TITLE)
  if (seededTiddler?.text !== seededText) throw new Error('the doc note must be generated from the live tool registry')
  // The count is read from the registry, never hard-coded: the note claimed a
  // stale 「10 个 agent 工具」 for five versions, which is why it is generated now.
  if (!seededText.includes(`${tools.length} 个 agent 工具`)) {
    throw new Error(`the generated doc note must carry the live tool count (${tools.length})`)
  }
  for (const tool of tools) {
    if (!seededText.includes(`\`${tool.name}\``)) throw new Error(`the generated doc note is missing ${tool.name}`)
  }
  const findSeed = async (id) => {
    const items = (await (await fetch(`${base}${ROUTE_PREFIX}/admin/seeds`)).json()).items ?? []
    return items.find((i) => i.id === id)
  }
  let doc = await findSeed('doc-note')
  console.log('doc-note (fresh):', JSON.stringify({ update: doc.updateAvailable, modified: doc.userModified, legacy: doc.legacyMarker }))
  if (doc.updateAvailable !== false || doc.userModified !== false) throw new Error('freshly seeded content must report neither update nor local edit')

  // (b) a user edit → userModified (and never silently overwritten).
  await clientRef.put({ title: DOC_NOTE_TITLE, text: `${seededText}\n\n我的补充`, type: 'text/vnd.tiddlywiki', tags: ['docs', 'dsh-docs'] })
  doc = await findSeed('doc-note')
  if (doc.userModified !== true) throw new Error('a user edit must be reported as userModified')

  // (c) the BUILT-IN moved on: marker holds the old text's hash, the stored
  //     tiddler still holds the old text → update, but no user modification.
  const OLD = '旧的内置正文'
  await clientRef.put({ title: DOC_NOTE_TITLE, text: OLD, type: 'text/vnd.tiddlywiki', tags: ['docs', 'dsh-docs'] })
  await clientRef.put({ title: MARKER, text: JSON.stringify({ version: 1, hashes: { [DOC_NOTE_TITLE]: hashText(OLD) } }), type: 'application/json', tags: [] })
  doc = await findSeed('doc-note')
  console.log('doc-note (built-in moved on):', JSON.stringify({ update: doc.updateAvailable, modified: doc.userModified }))
  if (doc.updateAvailable !== true || doc.userModified !== false) throw new Error('an upgraded built-in must report updateAvailable without userModified')

  // (d) pre-v0.22 marker (no hashes): different text → update + unknown authorship.
  await clientRef.put({ title: MARKER, text: 'seeded-once', type: 'text/plain', tags: [] })
  doc = await findSeed('doc-note')
  console.log('doc-note (legacy marker, diverged):', JSON.stringify({ update: doc.updateAvailable, modified: doc.userModified }))
  if (doc.updateAvailable !== true || doc.userModified !== undefined) throw new Error('a legacy marker with different text must report update-unknown')
  // (d2) legacy marker but identical text → nothing to update (marker upgradeable).
  await clientRef.put({ title: DOC_NOTE_TITLE, text: seededText, type: 'text/vnd.tiddlywiki', tags: ['docs', 'dsh-docs'] })
  doc = await findSeed('doc-note')
  console.log('doc-note (legacy marker, identical):', JSON.stringify({ update: doc.updateAvailable, legacy: doc.legacyMarker }))
  if (doc.updateAvailable !== false || doc.legacyMarker !== true) throw new Error('a legacy marker with identical text must report no update but legacyMarker')

  // (e) 重新初始化 refreshes the recorded hashes → the chip disappears.
  await post(`${base}${ROUTE_PREFIX}/admin/seeds/run`, { id: 'doc-note', force: true })
  doc = await findSeed('doc-note')
  if (doc.updateAvailable !== false || doc.userModified !== false || doc.legacyMarker !== false) throw new Error('after re-init the marker must hold fresh hashes')
  const marker = JSON.parse((await clientRef.get(MARKER)).text)
  if (marker.hashes[DOC_NOTE_TITLE] !== hashText(seededText)) throw new Error('the marker must record the built-in hash')

  // (f) v0.22.0 回归：**有自定义 check/run 的 content seed 也必须记账**。
  //     starter-docs / home-index / ui-styles 走自己的 runner，早期实现把它们
  //     静默漏掉（哈希既不进状态也不写标记），而当时的测试只覆盖了 doc-note。
  const starterRun = await post(`${base}${ROUTE_PREFIX}/admin/seeds/run`, { id: 'starter-docs', force: true })
  if (starterRun.status !== 200 || starterRun.json?.results?.[0]?.wrote !== true) throw new Error('force starter-docs failed')
  const starter = await findSeed('starter-docs')
  console.log('starter-docs (custom runner):', JSON.stringify({ update: starter.updateAvailable, modified: starter.userModified, legacy: starter.legacyMarker }))
  if (starter.updateAvailable !== false || starter.userModified !== false || starter.legacyMarker !== false) {
    throw new Error('a content seed with a custom runner must still get hash bookkeeping')
  }
  const starterMarker = JSON.parse((await clientRef.get(STARTER_DOCS_MARKER_TITLE)).text)
  if (Object.keys(starterMarker.hashes ?? {}).length !== STARTER_DOCS_ITEMS.length) {
    throw new Error(`the custom-run seed must record a hash per written tiddler (got ${Object.keys(starterMarker.hashes ?? {}).length})`)
  }

  await new Promise((resolveP) => mini.close(() => resolveP()))
  dispose()
  console.log('E2E OK')
} finally {
  // Close the mini HTTP server on EVERY path (success and assertion failure):
  // close() is idempotent — a second close hands the error to the callback,
  // which we deliberately ignore, so no port is left listening.
  await new Promise((resolveP) => mini.close(() => resolveP()))
  await server.stop()
  await rm(root, { recursive: true, force: true })
}

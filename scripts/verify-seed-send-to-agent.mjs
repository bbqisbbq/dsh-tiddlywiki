// One-shot E2E: fresh wiki -> seedSendToAgent -> verify the plugin tiddler is
// written and readable through the REAL TW server (not just the mock).
//
// Every step is a real ASSERTION (checks[] + exit code), not a log line: a
// regression must fail the script instead of printing "E2E OK".
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WikiServer,
  TiddlyWebClient,
  seedSendToAgent,
  SEND_TO_AGENT_PLUGIN_TITLE,
  SEND_TO_AGENT_MARKER_TITLE,
} from '../lib/index.js'

let failures = 0
const ok = (name, cond) => {
  const pass = !!cond
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`)
  if (!pass) failures++
}

const root = await mkdtemp(join(tmpdir(), 'dsh-tw-seed-e2e-'))
console.log('temp wiki root:', root)
const server = new WikiServer({ wikiRoot: root, wiki: 'main', port: 0 })
try {
  const view = await server.start()
  const api = new TiddlyWebClient(view.url)
  const wrote = await seedSendToAgent(api)
  console.log('seedSendToAgent first run ->', wrote)
  ok('first run writes the bundle', wrote === true)

  const tid = await api.get(SEND_TO_AGENT_PLUGIN_TITLE)
  ok('plugin tiddler present after seed', tid !== undefined)
  ok('plugin tiddler type is application/json', tid?.type === 'application/json')
  ok('is bundle text', typeof tid?.text === 'string' && tid.text.includes('"tiddlers"'))
  ok('has 待办说明', typeof tid?.text === 'string' && tid.text.includes('【待办说明】'))
  ok('has no old prefix', typeof tid?.text === 'string' && !tid.text.includes('【TiddlyWiki 笔记一键发送】'))

  const marker = await api.get(SEND_TO_AGENT_MARKER_TITLE)
  ok('marker present', marker !== undefined)

  const wrote2 = await seedSendToAgent(api)
  console.log('seedSendToAgent second run ->', wrote2)
  ok('second run is an idempotent no-op', wrote2 === false)

  // The DEFAULT recipe listing excludes `$:/` system tiddlers (TW's own
  // server-side filter), so the plugin bundle must NOT show up there even
  // though `get()` reaches it — assert that boundary.
  const listed = await api.list()
  ok('default recipe listing excludes the $:/ system bundle', !listed.some((t) => t.title === SEND_TO_AGENT_PLUGIN_TITLE))
  ok('bundle is still reachable through get()', (await api.get(SEND_TO_AGENT_PLUGIN_TITLE)) !== undefined)
} finally {
  await server.stop()
  await rm(root, { recursive: true, force: true })
}

console.log(failures === 0 ? 'E2E OK' : `E2E FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

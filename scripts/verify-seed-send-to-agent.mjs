// One-shot E2E: fresh wiki -> seedSendToAgent -> verify the plugin tiddler is
// written and readable through the REAL TW server (not just the mock).
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

const root = await mkdtemp(join(tmpdir(), 'dsh-tw-seed-e2e-'))
console.log('temp wiki root:', root)
const server = new WikiServer({ wikiRoot: root, wiki: 'main', port: 0 })
try {
  const view = await server.start()
  const api = new TiddlyWebClient(view.url)
  const wrote = await seedSendToAgent(api)
  console.log('seedSendToAgent first run ->', wrote)
  if (wrote !== true) throw new Error('expected first-run seed to write')
  const tid = await api.get(SEND_TO_AGENT_PLUGIN_TITLE)
  if (!tid) throw new Error('plugin tiddler missing after seed')
  console.log('plugin tiddler type:', tid.type)
  console.log('is bundle text:', typeof tid.text === 'string' && tid.text.includes('"tiddlers"'))
  console.log('has 待办说明:', tid.text.includes('【待办说明】'))
  console.log('has no old prefix:', !tid.text.includes('【TiddlyWiki 笔记一键发送】'))
  const marker = await api.get(SEND_TO_AGENT_MARKER_TITLE)
  console.log('marker present:', marker !== undefined)
  const wrote2 = await seedSendToAgent(api)
  console.log('seedSendToAgent second run ->', wrote2)
  if (wrote2 !== false) throw new Error('expected idempotent no-op on second run')
  // listing the recipe should surface the bundle tiddler too
  const listed = await api.list()
  console.log('listed:', listed.some((t) => t.title === SEND_TO_AGENT_PLUGIN_TITLE))
  console.log('E2E OK')
} finally {
  await server.stop()
  await rm(root, { recursive: true, force: true })
}

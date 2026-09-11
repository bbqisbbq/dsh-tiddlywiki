#!/usr/bin/env node
/**
 * Runtime wiki switching E2E (v0.22.0) — real TiddlyWiki child, two temp wiki
 * folders, real rebind + real rollback:
 *
 *   1. serve wiki A, write a tiddler only A has;
 *   2. switchWiki() to a not-yet-existing folder under root B:
 *      the folder is scaffolded, the TW child is re-spawned on it, and the
 *      plugin now reads B (A's tiddler is gone, B's tiddler is visible);
 *   3. the pointer file records the new location;
 *   4. a switch to an IMPOSSIBLE target (root is a FILE) must fail AND roll the
 *      server back to the wiki that was running — plus leave the pointer alone,
 *      so a later dsh web restart cannot land on a half-initialised folder;
 *   5. the location helpers behave (reject relative roots, survive malformed
 *      pointer files, list wiki-looking folders).
 *
 *   node scripts/verify-wiki-switch.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-wiki-switch
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WikiServer,
  TiddlyWebClient,
  listWikiCandidates,
  locationPath,
  normalizeLocation,
  readLocationState,
  switchWiki,
  writeLocationState,
} from '../lib/index.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-tw-switch-'))
const rootA = join(root, 'A')
const rootB = join(root, 'B')
const stateFile = join(root, 'location.json')
console.log('temp root:', root)

const server = new WikiServer({ wikiRoot: rootA, wiki: 'wikiA', port: 0 })
let current = { root: rootA, name: 'wikiA' }
let path = locationPath(current)
const calls = { teardown: 0, setup: 0, reload: 0, bootstrap: 0, pointer: 0 }

const clientFor = () => new TiddlyWebClient(server.url)

const deps = {
  currentLocation: () => current,
  currentPath: () => path,
  stopServer: () => server.stop(),
  applyLocation: (next) => {
    server.setLocation({ root: next.root, name: next.name })
    current = next
    path = locationPath(next)
  },
  startServer: () => server.start().then(() => undefined),
  teardownExtras: async () => { calls.teardown += 1 },
  setupExtras: () => { calls.setup += 1 },
  reloadConfig: async () => { calls.reload += 1 },
  bootstrap: async () => { calls.bootstrap += 1 },
  savePointer: async (target) => {
    calls.pointer += 1
    await writeLocationState(target, stateFile)
  },
  log: (message) => console.log('  [log]', message),
}

try {
  // ── 1. serve wiki A ──────────────────────────────────────────────────────
  await server.start()
  assert.equal(server.status().status, 'running', 'wiki A must start')
  const clientA = clientFor()
  await clientA.put({ title: 'OnlyInA', text: 'A 的内容', tags: [] })
  console.log('wiki A ready:', server.status().wikiPath, 'port', server.currentPort)

  // ── 2. switch to a brand-new folder under root B ─────────────────────────
  await mkdir(rootB, { recursive: true })
  const result = await switchWiki(deps, { root: rootB, name: 'wikiB' })
  console.log('switch result:', JSON.stringify(result))
  assert.equal(result.ok, true, `switch must succeed: ${JSON.stringify(result)}`)
  assert.equal(path, join(rootB, 'wikiB'))
  assert.equal(server.status().wikiPath, join(rootB, 'wikiB'), 'server must serve the new folder')
  assert.equal(server.status().status, 'running', 'the new wiki must be running')
  assert.ok(existsSync(join(rootB, 'wikiB', 'tiddlywiki.info')), 'a fresh folder must be scaffolded with --init server')
  assert.equal(calls.teardown, 1, 'the old committer/watcher must be released once')
  assert.equal(calls.setup, 1, 'the new committer/watcher must be armed once')
  assert.equal(calls.reload, 1, 'the config overlay must be reloaded from the new wiki')
  assert.equal(calls.bootstrap, 1, 'the new wiki must be core-bootstrapped')

  const clientB = clientFor()
  assert.equal(await clientB.get('OnlyInA'), undefined, 'A\'s tiddler must NOT be visible in B')
  await clientB.put({ title: 'OnlyInB', text: 'B 的内容', tags: [] })
  assert.ok((await clientB.get('OnlyInB')) !== undefined, 'B must accept writes')

  // ── 3. the pointer records the choice ────────────────────────────────────
  assert.equal(calls.pointer, 1)
  const pointer = JSON.parse(await readFile(stateFile, 'utf8'))
  console.log('pointer:', JSON.stringify(pointer.active))
  assert.deepEqual(pointer.active, { root: rootB, name: 'wikiB' })
  const reread = await readLocationState(stateFile)
  assert.deepEqual(reread.active, { root: rootB, name: 'wikiB' }, 'the pointer must be readable back')
  assert.equal(reread.error, undefined)

  // ── 4. an impossible target must fail AND roll back ──────────────────────
  const blockerFile = join(root, 'not-a-directory.txt')
  await writeFile(blockerFile, 'plain file', 'utf8')
  const failed = await switchWiki(deps, { root: blockerFile, name: 'wiki' })
  console.log('failed switch:', JSON.stringify(failed))
  assert.equal(failed.ok, false, 'switching onto a FILE must fail')
  assert.equal(failed.rolledBack, true)
  assert.equal(path, join(rootB, 'wikiB'), 'the folder must be rolled back')
  assert.equal(server.status().status, 'running', 'the previous wiki must be running again')
  const afterRollback = clientFor()
  assert.ok((await afterRollback.get('OnlyInB')) !== undefined, 'rollback must serve wiki B again')
  assert.equal(await afterRollback.get('OnlyInA'), undefined, 'rollback must not land on wiki A')
  assert.deepEqual((await readLocationState(stateFile)).active, { root: rootB, name: 'wikiB' }, 'a failed switch must not touch the pointer')

  // Invalid input is rejected before anything is stopped.
  const bad = await switchWiki(deps, { root: 'relative/path', name: 'main' })
  assert.equal(bad.ok, false, 'a relative root must be refused')
  assert.equal(server.status().status, 'running', 'an invalid request must not stop the wiki')

  // ── 5. location helpers ──────────────────────────────────────────────────
  assert.equal(normalizeLocation({ root: '   ', name: 'main' }).error !== undefined, true, 'empty root rejected')
  assert.equal(normalizeLocation({ root: 'D:/x', name: 'a/b' }).error !== undefined, true, 'name with a separator rejected')
  assert.deepEqual(normalizeLocation({ root: rootA, name: '' }).location, { root: rootA, name: 'main' }, 'empty name → main')
  assert.deepEqual(normalizeLocation({ root: rootA, name: '.' }).location, { root: rootA, name: '.' })

  const broken = join(root, 'broken.json')
  await writeFile(broken, '{ not json', 'utf8')
  const brokenState = await readLocationState(broken)
  assert.equal(brokenState.active, undefined, 'a malformed pointer must not produce a location')
  assert.ok(typeof brokenState.error === 'string' && brokenState.error.length > 0, 'a malformed pointer must be reported')
  const missingState = await readLocationState(join(root, 'nope.json'))
  assert.deepEqual(missingState, {}, 'a missing pointer is not an error')

  const candidatesA = await listWikiCandidates(rootA)
  const candidatesB = await listWikiCandidates(rootB)
  const candidatesRoot = await listWikiCandidates(root)
  console.log('candidates:', `A=[${candidatesA.join(', ')}]`, `B=[${candidatesB.join(', ')}]`, `root=[${candidatesRoot.join(', ')}]`)
  assert.ok(candidatesA.includes('wikiA'), 'wikiA must be discovered under its root')
  assert.ok(candidatesB.includes('wikiB'), 'wikiB must be discovered under its root')
  assert.deepEqual(candidatesRoot, [], 'a plain parent folder holds no wiki itself (only its children do)')

  await server.stop()
  console.log('\nWIKI SWITCH OK')
} finally {
  await server.stop().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}

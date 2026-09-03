/**
 * Headless self-test for the DoD items that do not need the GUI (design doc
 * §15): spawn the real TW child, exercise the REST client, drive git, verify
 * teardown leaves no orphan, and clean up.
 *
 * Requires a prior `npm run build` (imports the public host exports).
 */
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WikiServer, TiddlyWebClient, GitFace, AutoCommitter, resolveTwRoot, bundledCatalog, readWikiInfo, writeWikiInfo, ensureLanguage, normalizeThemes, openInTwEditor, registerRoutes, seedDocNote, DOC_NOTE_TITLE, DOC_NOTE_TAG, ConfigStore, deepMerge } from '../lib/index.js'

const assert = (cond, label) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`)
  console.log(`  ok - ${label}`)
}

const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-tw-selftest-'))
console.log(`selftest root: ${tempRoot}`)

let exitCode = 0
try {
  // 1. WikiServer lifecycle
  const server = new WikiServer({ wikiRoot: tempRoot, wiki: 'main', port: 0 })
  const view = await server.start()
  assert(view.status === 'running', `wiki status running (got ${view.status})`)
  assert(typeof view.url === 'string' && view.url.startsWith('http://127.0.0.1:'), `url is loopback: ${view.url}`)
  assert(view.url.endsWith(`:${server.currentPort}`), `url has no path-prefix (root serving): ${view.url}`)
  assert(typeof view.pid === 'number' && view.pid > 0, `child pid present (${view.pid})`)

  // 2. REST client round-trip
  const api = new TiddlyWebClient(view.url)
  await api.put({ title: 'Hello', text: 'world hello tiddlywiki', tags: ['inbox', 'test'] })
  const got = await api.get('Hello')
  assert(got !== undefined && got.text.includes('hello tiddlywiki'), 'get returns written text')
  assert(Array.isArray(got.tags) && got.tags.includes('inbox'), 'tags persisted')

  await api.put({ title: '第二篇', text: '一篇中文笔记' })
  const found = await api.search('hello')
  assert(found.items.some((t) => t.title === 'Hello') && found.total >= 1, 'search finds by keyword (items+total)')
  const byTag = await api.search('world', { tag: 'test' })
  assert(byTag.items.some((t) => t.title === 'Hello'), 'search honors tag filter')
  const byTags = await api.search('world', { tags: ['inbox', 'test'] })
  assert(byTags.items.some((t) => t.title === 'Hello'), 'search honors AND tags array')
  const byType = await api.search('world', { type: 'text/vnd.tiddlywiki' })
  assert(byType.total >= 1, 'search honors type filter')
  const recent = await api.recent(5)
  assert(recent.some((t) => t.title === 'Hello' || t.title === '第二篇'), 'recent lists newest tiddlers')
  const tagList = await api.listTags()
  assert(tagList.some((x) => x.tag === 'inbox' && x.count >= 1), 'listTags returns tag counts')
  const listed = await api.list()
  assert(listed.some((t) => t.title === '第二篇'), 'recipe list contains new tiddler')

  await api.delete('Hello')
  const gone = await api.get('Hello')
  assert(gone === undefined, 'delete removes tiddler')

  // 3. Git face over the wiki folder
  const git = new GitFace()
  const wikiDir = join(tempRoot, 'main')
  assert(await git.isRepo(wikiDir) === false, 'fresh wiki folder is not a repo')
  await git.init(wikiDir, 'main')
  await git.initialCommit(wikiDir)
  const st = await git.status(wikiDir)
  assert(st.exists && st.branch === 'main', `git branch main (got ${st.branch})`)

  // 4. AutoCommitter debounced commit
  const committed = []
  const committer = new AutoCommitter({
    git, dir: wikiDir, enabled: true, debounceMs: 300,
    message: () => `selftest commit ${Date.now()}`,
    onCommit: (info) => committed.push(info),
  })
  await api.put({ title: 'Draft', text: 'auto commit me' })
  committer.touch()
  await new Promise((r) => setTimeout(r, 1_000))
  assert(committed.some((c) => c.committed), 'auto-commit fired after debounce')
  const after = await git.status(wikiDir)
  assert(!after.dirty, 'working tree clean after auto-commit')
  committer.dispose()

  // 5. git remote round-trip against a local bare origin + conflict policy
  const barePath = join(tempRoot, 'origin.git')
  await git.exec(['init', '--bare', '-b', 'main', barePath], { cwd: tempRoot, timeout: 15_000 })
  await git.ensureRemote(wikiDir, barePath)
  const first = await git.firstPush(wikiDir)
  assert(first.ok, `first push -u succeeds (${first.message})`)

  const clonePath = join(tempRoot, 'clone')
  const clone = await git.exec(['clone', barePath, clonePath], { cwd: tempRoot, timeout: 30_000 })
  assert(clone.ok, 'git clone succeeds')
  const gclone = new GitFace()
  await writeFile(join(clonePath, 'tiddlers', 'FromClone.tid'), 'from clone\n')
  const cc = await gclone.commit(clonePath, 'from clone')
  assert(cc.committed, 'clone commit succeeds')
  const pushC = await gclone.push(clonePath)
  assert(pushC.ok, `clone push succeeds (${pushC.message})`)
  const pulled = await git.pull(wikiDir)
  assert(pulled.ok, `pull --rebase --autostash succeeds (${pulled.message})`)
  const afterPull = await git.status(wikiDir)
  assert(!afterPull.dirty, 'wiki dir clean after pull')

  // conflict: same file diverges on both sides
  await writeFile(join(wikiDir, 'tiddlers', 'Conflict.tid'), 'local\n')
  const cl = await git.commit(wikiDir, 'local conflict side')
  assert(cl.committed, 'wiki commits local side')
  const pullC = await gclone.pull(clonePath)
  assert(pullC.ok, 'clone pulls local side')
  await writeFile(join(clonePath, 'tiddlers', 'Conflict.tid'), 'remote\n')
  await gclone.commit(clonePath, 'remote conflict side')
  const pushC2 = await gclone.push(clonePath)
  assert(pushC2.ok, 'clone pushes remote side')
  const conflict = await git.pull(wikiDir)
  assert(!conflict.ok, 'pull with diverging same file reports failure')
  assert(conflict.conflictFiles?.includes('tiddlers/Conflict.tid'), `conflict files listed (${conflict.conflictFiles?.join(', ')})`)

  // 5a'. Tiddler-granular conflict resolution: keep-remote (fetch + checkout
  // FETCH_HEAD) then commit — the keep-local half is trivially "abort already
  // left local content", exercised by the conflict abort above.
  const fetchedRes = await git.fetch(wikiDir)
  assert(fetchedRes.ok, 'resolve: git fetch succeeds')
  const checkedRes = await git.checkoutFetchHead(wikiDir, ['tiddlers/Conflict.tid'])
  assert(checkedRes.ok, 'resolve: checkout FETCH_HEAD takes remote version')
  const resolveCommit = await git.commit(wikiDir, 'resolve conflict (keep remote)')
  assert(resolveCommit.committed, 'resolve: commit created')
  const resolvedText = (await readFile(join(wikiDir, 'tiddlers', 'Conflict.tid'), 'utf8')).replace(/\r/g, '')
  assert(resolvedText === 'remote\n', 'resolve: keep-remote overwrote with the remote version')
  const afterResolve = await git.status(wikiDir)
  assert(!afterResolve.dirty, 'resolve: working tree clean after commit')

  // 5aa. files/ folder is served by TW without restart (validates the quick-note
  // upload approach: writing under <wiki>/files/ is enough for /files/<name>).
  const filesDir = join(wikiDir, 'files')
  await mkdir(filesDir, { recursive: true })
  await writeFile(join(filesDir, 'hello-upload.txt'), 'served via files/')
  const filesRes = await fetch(`${server.url}/files/hello-upload.txt`)
  assert(filesRes.ok && (await filesRes.text()) === 'served via files/', 'TW serves files/ without restart')

  // 5b. UI language: enable bundled zh-Hans → restart → pin $:/language
  const langTwRoot = resolveTwRoot()
  const langCatalog = await bundledCatalog(langTwRoot)
  assert(langCatalog.languages.some((l) => l.name === 'zh-Hans'), 'bundled languages include zh-Hans')
  const langInfoBefore = await readWikiInfo(wikiDir)
  const langChanged = await ensureLanguage(wikiDir, langTwRoot, 'zh-Hans')
  assert(langChanged === true, 'ensureLanguage adds zh-Hans to tiddlywiki.info')
  const langChanged2 = await ensureLanguage(wikiDir, langTwRoot, 'zh-Hans')
  assert(langChanged2 === false, 'ensureLanguage is idempotent')
  const urlBeforeRestart = server.url
  await server.restart()
  assert(server.url === urlBeforeRestart, 'restart keeps the same port (client stays valid)')
  const langApi = new TiddlyWebClient(server.url)
  await langApi.put({ title: '$:/language', text: '$:/languages/zh-Hans', type: 'text/plain', tags: [] })
  const langTiddler = await langApi.get('$:/language')
  const basicsCaption = await langApi.get('$:/language/ControlPanel/Basics/Caption').catch(() => undefined)
  assert((langTiddler.text ?? '').includes('$:/languages/zh-Hans'), `$:/language pinned to zh-Hans (got ${JSON.stringify(langTiddler.text)})`)
  assert(basicsCaption !== undefined && (basicsCaption.text ?? '').includes('基础'), `zh-Hans UI strings take effect (got ${JSON.stringify(basicsCaption?.text)})`)
  await writeWikiInfo(wikiDir, langInfoBefore)

  // 5c. Open in native editor: draft creation, reuse, no-clobber.
  const editApi = new TiddlyWebClient(server.url)
  const editResult = await openInTwEditor(editApi, 'EditTarget', 'initial body', ['inbox'])
  assert(editResult.draftTitle.startsWith('Draft of "EditTarget"'), `draft title generated (${editResult.draftTitle})`)
  const draft1 = await editApi.get(editResult.draftTitle)
  assert(draft1 !== undefined, 'draft tiddler exists')
  const draft1Of = draft1['draft.of'] ?? draft1.fields?.['draft.of']
  const draft1Title = draft1['draft.title'] ?? draft1.fields?.['draft.title']
  assert(draft1Of === 'EditTarget' && draft1Title === 'EditTarget', 'draft carries draft.of/draft.title')
  assert((draft1.text ?? '') === 'initial body', 'draft starts from provided text')
  const editResult2 = await openInTwEditor(editApi, 'EditTarget', 'updated body', ['inbox'])
  assert(editResult2.draftTitle === editResult.draftTitle, 'existing draft is reused')
  const draft2 = await editApi.get(editResult2.draftTitle)
  assert((draft2.text ?? '') === 'updated body', 'draft updated in place')
  assert((draft2.type ?? draft2.fields?.type) === 'text/markdown', 'draft carries text/markdown (keeps the type when saved in TW)')
  const target = await editApi.get('EditTarget')
  assert((target.text ?? '') === 'updated body', 'real tiddler saved with latest text')
  assert((target.type ?? target.fields?.type) === 'text/markdown', 'native-editor target is saved as Markdown')
  // Empty-text open must NOT clobber an existing tiddler.
  const noClobber = await openInTwEditor(editApi, 'EditTarget', '', ['inbox'])
  assert(noClobber.draftTitle === editResult.draftTitle, 'empty-text open reuses draft')
  const afterNoClobber = await editApi.get('EditTarget')
  assert((afterNoClobber.text ?? '') === 'updated body', 'empty-text open does not wipe existing tiddler')
  await editApi.delete('EditTarget')
  await editApi.delete(editResult.draftTitle)

  // 5d. registerRoutes: exercise the new /upload and /sync handlers through
  // the webserver face (mock), so the quick-note upload + one-click sync
  // routes are covered headlessly end to end.
  const routeHandlers = new Map()
  const mockCtx = {
    webServer: {
      register: (route) => { routeHandlers.set(route.path, route.handler); return () => {} },
    },
  }
  const makeReq = (url, body) => {
    const req = new EventEmitter()
    req.url = url
    req.headers = {}
    req.destroy = () => {}
    queueMicrotask(() => { if (body !== undefined) req.emit('data', body); req.emit('end') })
    return req
  }
  const makeRes = () => {
    const res = { _status: 200, _payload: null }
    res.writeHead = (code) => { res._status = code }
    res.end = (body) => { res._payload = body }
    return res
  }
  const disposeRoutes = registerRoutes(mockCtx, {
    server,
    getClient: () => new TiddlyWebClient(server.url),
    git,
    autoCommit: () => {},
    noteDefaults: () => ({ tag: 'inbox' }),
    uiDefaults: () => ({ showQuickNote: true, showPanelStatus: true, showSyncButton: true }),
    getWikiPath: () => wikiDir,
  })
  assert(routeHandlers.has('/dsh-tiddlywiki/upload') && routeHandlers.has('/dsh-tiddlywiki/sync'), 'upload + sync routes registered')

  // Routes are registered fire-and-forget (`void handleX(req,res)`), so poll
  // the mock response until the handler has written it.
  const callRoute = async (handler, req, res, ms = 8000) => {
    handler(req, res)
    const deadline = Date.now() + ms
    while (res._payload === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
    if (res._payload === null) throw new Error('route did not respond in time')
    return JSON.parse(res._payload)
  }

  // /upload: raw bytes land under <wiki>/files/ with a /files/<name> URL;
  // a name collision gets a -1 suffix instead of overwriting.
  const up = await callRoute(
    routeHandlers.get('/dsh-tiddlywiki/upload'),
    makeReq('/dsh-tiddlywiki/upload?name=hello%20notes.txt', Buffer.from('file content here')),
    makeRes(),
  )
  assert(up.ok === true && up.name === 'hello notes.txt' && up.url === '/files/hello%20notes.txt', `upload returns name+url (${JSON.stringify(up)})`)
  assert(await readFile(join(wikiDir, 'files', 'hello notes.txt'), 'utf8') === 'file content here', 'uploaded bytes saved under wiki files/')
  const up2 = await callRoute(
    routeHandlers.get('/dsh-tiddlywiki/upload'),
    makeReq('/dsh-tiddlywiki/upload?name=hello%20notes.txt', Buffer.from('second')),
    makeRes(),
  )
  assert(up2.ok === true && up2.name === 'hello notes-1.txt', `upload collision gets -1 suffix (${JSON.stringify(up2)})`)
  const upBad = await callRoute(
    routeHandlers.get('/dsh-tiddlywiki/upload'),
    makeReq('/dsh-tiddlywiki/upload?name=..%2F..%2Fevil.txt', Buffer.from('x')),
    makeRes(),
  )
  assert(upBad.ok === true && upBad.name === 'evil.txt', `path-traversal name sanitized to a bare name (${JSON.stringify(upBad.name)})`)
  const upDotdot = await callRoute(
    routeHandlers.get('/dsh-tiddlywiki/upload'),
    makeReq('/dsh-tiddlywiki/upload?name=..', Buffer.from('x')),
    makeRes(),
  )
  assert(upDotdot.ok === false, 'bare ".." filename rejected')

  // /note: quick-note tiddlers are saved as Markdown so uploaded images/links
  // actually render in TW (a type-less tiddler would show raw `![..]`).
  const note = await callRoute(
    routeHandlers.get('/dsh-tiddlywiki/note'),
    makeReq('/dsh-tiddlywiki/note', Buffer.from(JSON.stringify({ title: 'NoteTypeTest', tags: ['inbox'], text: '![img](/files/a.png)' }))),
    makeRes(),
  )
  assert(note.ok === true && note.type === 'text/markdown', `note response carries the markdown type (${JSON.stringify(note)})`)
  const noteTid = await new TiddlyWebClient(server.url).get('NoteTypeTest')
  assert((noteTid.type ?? noteTid.fields?.type) === 'text/markdown', 'note tiddler type is text/markdown on the wiki')

  // /sync: pull a change made on the clone side, then commit + push. The wiki
  // is still mid-divergence from the step-5 conflict test, so first align it
  // onto origin (a /sync on a genuinely conflicted repo MUST fail — the
  // conflict policy aborts rather than auto-merging — so run this on a clean
  // baseline instead). Also drop untracked artifacts (files/ uploads from the
  // tests above, the lang test's $__language.* tiddlers) so the baseline is
  // truly clean.
  await git.exec(['fetch', 'origin'], { cwd: wikiDir, timeout: 15_000 })
  await git.exec(['reset', '--hard', 'origin/main'], { cwd: wikiDir, timeout: 15_000 })
  await git.exec(['clean', '-fd'], { cwd: wikiDir, timeout: 15_000 })
  const syncBefore = await git.status(wikiDir)
  assert(!syncBefore.dirty && !syncBefore.dirtyFiles.includes('tiddlers/Conflict.tid'), `wiki aligned to origin/main (dirty=${syncBefore.dirty} files=${JSON.stringify(syncBefore.dirtyFiles)})`)
  await writeFile(join(clonePath, 'tiddlers', 'SyncTest.tid'), 'from clone\n')
  await gclone.commit(clonePath, 'sync-test remote change')
  assert((await gclone.push(clonePath)).ok, 'clone pushes change for sync test')
  const sync = await callRoute(routeHandlers.get('/dsh-tiddlywiki/sync'), makeReq('/dsh-tiddlywiki/sync'), makeRes())
  assert(sync.ok === true && sync.pull === 'ok' && sync.status?.branch === 'main', `sync pulls+commits+pushes (${JSON.stringify(sync.message ?? sync.error)})`)
  assert(sync.changed === true && sync.restarted === true, `changed pull restarts TW (changed=${sync.changed} restarted=${sync.restarted})`)
  const syncText = (await readFile(join(wikiDir, 'tiddlers', 'SyncTest.tid'), 'utf8')).replace(/\r/g, '')
  assert(syncText === 'from clone\n', 'sync pulled the remote change into the wiki')
  // A no-op sync (nothing new on origin) must NOT restart TW.
  const sync2 = await callRoute(routeHandlers.get('/dsh-tiddlywiki/sync'), makeReq('/dsh-tiddlywiki/sync'), makeRes())
  assert(sync2.ok === true && sync2.changed !== true && sync2.restarted !== true, `no-op sync does not restart (changed=${sync2.changed} restarted=${sync2.restarted})`)

  // /recent + /get: the quick-note "最近" picker backend. Raw files written by
  // the git tests carry NO title: line, so TW titles them by their file path —
  // assert on a properly API-written tiddler instead.
  const routeApi = new TiddlyWebClient(server.url)
  await routeApi.put({ title: 'RouteNote', text: 'route probe note', tags: ['inbox'] })
  const recentRes = await callRoute(routeHandlers.get('/dsh-tiddlywiki/recent'), makeReq('/dsh-tiddlywiki/recent?limit=10'), makeRes())
  assert(recentRes.ok === true && Array.isArray(recentRes.items) && recentRes.items.some((i) => i.title === 'RouteNote'), `recent route returns newest notes (${recentRes.items?.length ?? 0} items)`)
  const getRes = await callRoute(routeHandlers.get('/dsh-tiddlywiki/get'), makeReq(`/dsh-tiddlywiki/get?title=${encodeURIComponent('RouteNote')}`), makeRes())
  assert(getRes.ok === true && getRes.title === 'RouteNote' && typeof getRes.text === 'string' && getRes.tags?.includes('inbox'), 'get route returns a full tiddler with tags')
  const getMissing = await callRoute(routeHandlers.get('/dsh-tiddlywiki/get'), makeReq('/dsh-tiddlywiki/get?title=' + encodeURIComponent('NoSuchTiddler')), makeRes())
  assert(getMissing.ok === false && getMissing.notFound === true, 'get route reports notFound for a missing tiddler')
  disposeRoutes()

  // 5b. Doc-note seed: ONE-SHOT (marker-gated), never overwrites edits.
  const SEED_MARKER_TITLE = '$:/plugins/dsh-tiddlywiki/seed-doc-note'
  const seedApi = new TiddlyWebClient(view.url)
  assert(await seedDocNote(seedApi) === true, 'doc note seeded on first run')
  const seedNote = await seedApi.get(DOC_NOTE_TITLE)
  assert(seedNote !== undefined && seedNote.text.includes('TiddlyWiki 5'), 'doc note has guide content')
  assert(Array.isArray(seedNote.tags) && seedNote.tags.includes(DOC_NOTE_TAG), 'doc note carries its tag')
  assert(await seedDocNote(seedApi) === false, 'doc note NOT re-seeded while marker present')
  await seedApi.put({ title: DOC_NOTE_TITLE, text: 'user edit', tags: ['docs'] })
  assert(await seedDocNote(seedApi) === false, 'edited doc note is never overwritten by the seed')
  await seedApi.delete(DOC_NOTE_TITLE)
  assert(await seedDocNote(seedApi) === false, 'deleted doc note NOT re-created (one-shot marker stays)')
  await seedApi.delete(SEED_MARKER_TITLE)
  assert(await seedDocNote(seedApi) === true, 'doc note re-seeds after marker removed (fresh wiki)')
  await seedApi.delete(DOC_NOTE_TITLE)

  // 6. Teardown: no orphan process
  const pidBefore = view.pid
  await server.stop()
  assert(server.status().pid === undefined, 'child handle cleared on stop')
  // process.kill(pid, 0) throws ESRCH once the process is gone.
  let orphan = false
  try {
    process.kill(pidBefore, 0)
    orphan = true
  } catch (err) {
    orphan = err.code !== 'ESRCH'
  }
  assert(!orphan, 'child process is gone after stop (no orphan)')

  // 7. Settings-panel logic: catalog + tiddlywiki.info + ConfigStore
  const twRoot = resolveTwRoot()
  assert(typeof twRoot === 'string' && twRoot.length > 0, `tiddlywiki package root resolved (${twRoot})`)
  const catalog = await bundledCatalog(twRoot)
  assert(catalog.plugins.some((p) => p.name === 'tiddlywiki/katex'), 'catalog lists bundled plugin katex')
  assert(catalog.plugins.every((p) => p.title.startsWith('$:/plugins/')), 'catalog plugin titles use $:/plugins/ prefix')
  assert(catalog.themes.some((t) => t.name === 'tiddlywiki/vanilla'), 'catalog lists bundled theme vanilla')
  assert(catalog.themes.some((t) => t.name === 'tiddlywiki/tight'), 'catalog keeps real overlay theme tight')
  assert(!catalog.themes.some((t) => t.name === 'tiddlywiki/tight-heavier'), 'catalog skips empty-stub theme tight-heavier')

  assert(JSON.stringify(normalizeThemes(['tiddlywiki/snowwhite'])) === JSON.stringify(['tiddlywiki/vanilla', 'tiddlywiki/snowwhite']), 'normalizeThemes prepends vanilla base')
  assert(JSON.stringify(normalizeThemes(['tiddlywiki/vanilla'])) === JSON.stringify(['tiddlywiki/vanilla']), 'normalizeThemes keeps plain vanilla')
  assert(JSON.stringify(normalizeThemes([])) === JSON.stringify(['tiddlywiki/vanilla']), 'normalizeThemes empty → vanilla')
  const heavierEntry = catalog.themes.find((t) => t.name === 'tiddlywiki/heavier')
  assert(JSON.stringify(heavierEntry?.dependents) === JSON.stringify(['tiddlywiki/snowwhite']), 'catalog carries theme dependents (heavier → snowwhite)')
  const realDeps = {}
  for (const t of catalog.themes) if (t.dependents && t.dependents.length > 0) realDeps[t.name] = t.dependents
  assert(
    JSON.stringify(normalizeThemes(['tiddlywiki/heavier'], realDeps)) ===
      JSON.stringify(['tiddlywiki/vanilla', 'tiddlywiki/snowwhite', 'tiddlywiki/heavier']),
    'real catalog deps resolve heavier closure (vanilla+snowwhite+heavier)',
  )
  assert(
    JSON.stringify(normalizeThemes(['tiddlywiki/tight'], realDeps)) === JSON.stringify(['tiddlywiki/vanilla', 'tiddlywiki/tight']),
    'real catalog deps resolve tight closure (vanilla+tight)',
  )
  assert(
    JSON.stringify(normalizeThemes(['tiddlywiki/snowwhite', 'tiddlywiki/heavier'], realDeps)) ===
      JSON.stringify(['tiddlywiki/vanilla', 'tiddlywiki/snowwhite', 'tiddlywiki/heavier']),
    'closure over a multi-load set keeps deps-first order (snowwhite+heavier → vanilla+snowwhite+heavier)',
  )

  const infoBefore = await readWikiInfo(wikiDir)
  assert(Array.isArray(infoBefore.plugins) && infoBefore.plugins.includes('tiddlywiki/tiddlyweb'), `wiki info has tiddlyweb (${infoBefore.plugins.join(',')})`)
  const patched = { ...infoBefore, plugins: [...infoBefore.plugins, 'tiddlywiki/katex'] }
  await writeWikiInfo(wikiDir, patched)
  const infoAfter = await readWikiInfo(wikiDir)
  assert(infoAfter.plugins.includes('tiddlywiki/katex'), 'tiddlywiki.info round-trip preserves new plugin')
  assert(JSON.stringify(infoAfter.themes) === JSON.stringify(infoBefore.themes), 'tiddlywiki.info preserves themes untouched')
  await writeWikiInfo(wikiDir, infoBefore)

  assert(deepMerge({ a: 1, git: { x: 1 } }, { git: { y: 2 } }).git?.y === 2, 'deepMerge merges nested git object')
  const store = new ConfigStore({ note: { tag: 'inbox' }, git: { autoCommit: true, debounceMs: 60000 } })
  const fakeClient = {
    saved: null,
    get: async () => null,
    put: async (t) => { fakeClient.saved = t; return t },
  }
  assert(store.get().note?.tag === 'inbox', 'ConfigStore base config readable')
  await store.set(fakeClient, { note: { tag: 'meeting' }, uiLanguage: 'zh-Hans' })
  assert(store.get().note?.tag === 'meeting', 'ConfigStore override wins over base')
  assert(store.get().git?.autoCommit === true, 'ConfigStore keeps base field not overridden')
  assert(fakeClient.saved?.title === '$:/plugins/dsh-tiddlywiki/config', 'ConfigStore writes the config tiddler')
  const parsed = JSON.parse(fakeClient.saved.text)
  assert(parsed.note?.tag === 'meeting' && parsed.uiLanguage === 'zh-Hans', 'config tiddler text holds merged overrides')

  console.log('\nSELFTEST PASSED')
} catch (err) {
  exitCode = 1
  console.error('\nSELFTEST FAILED')
  console.error(err)
} finally {
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
}
process.exit(exitCode)

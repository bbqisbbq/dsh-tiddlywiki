/**
 * Headless self-test for the DoD items that do not need the GUI (design doc
 * §15): spawn the real TW child, exercise the REST client, drive git, verify
 * teardown leaves no orphan, and clean up.
 *
 * Requires a prior `npm run build` (imports the public host exports).
 */
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WikiServer, TiddlyWebClient, GitFace, AutoCommitter, resolveTwRoot, bundledCatalog, readWikiInfo, writeWikiInfo, ensurePlugin, ensureLanguage, normalizeThemes, openInTwEditor, registerRoutes, seedDocNote, DOC_NOTE_TITLE, DOC_NOTE_TAG, seedStarterDocs, STARTER_DOCS_MARKER_TITLE, seedSendToAgent, SEND_TO_AGENT_PLUGIN_TITLE, SEND_TO_AGENT_MARKER_TITLE, SEND_TO_AGENT_BUNDLE_TEXT, seedRenderRoute, RENDER_PLUGIN_TITLE, RENDER_MARKER_TITLE, RENDER_BUNDLE_TEXT, seedHomeIndex, HOME_INDEX_ITEMS, HOME_INDEX_MARKER_TITLE, seedAllArticles, ALL_ARTICLES_TITLE, seedMenubarTheme, MENUBAR_THEME_TIDDLER, MENUBAR_THEME_MARKER_TITLE, seedUiStyles, UI_STYLES_MARKER_TITLE, seedClipBridge, CLIP_BRIDGE_DOC_TITLE, CLIP_BRIDGE_MARKER_TITLE, checkAllSeeds, runSeedById, runAllSeeds, removeSeedById, SEED_DEFS, ConfigStore, deepMerge, TW_PROXY_PATH, TW_PROXY_PREFIX, ensureTwWebHost, TW_WEB_HOST_TIDDLER, registerTiddlywikiTools, isBinaryType, TEXT_LIST_FILTER } from '../lib/index.js'

const assert = (cond, label) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`)
  console.log(`  ok - ${label}`)
}

/** Poll `cond` every 100ms until it is truthy (or the 10s cap passes) — a
 *  bounded replacement for fixed sleeps: continue the moment the awaited state
 *  lands, never wait longer than the cap. Returns whether it was hit. */
async function waitFor(cond, timeoutMs = 10_000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let hit = false
    try { hit = await cond() } catch { hit = false }
    if (hit) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-tw-selftest-'))
console.log(`selftest root: ${tempRoot}`)

let exitCode = 0
// Hoisted out of the try so the finally can ALWAYS reap the TW child: a failed
// assertion used to skip server.stop() and leave a process holding the port
// (stop() is idempotent, so the success path may still stop it explicitly).
let server
try {
  // 1. WikiServer lifecycle
  server = new WikiServer({ wikiRoot: tempRoot, wiki: 'main', port: 0 })
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

  // 2b2. Binary tiddlers never ride along in search/recent/full listings
  // (v0.16.20): list(includeText) runs TEXT_LIST_FILTER server-side, the first
  // search self-heals the ExternalFilters whitelist tiddler, and get() withholds
  // base64 from the model.
  assert(isBinaryType('image/jpeg') === true && isBinaryType('application/pdf') === true && isBinaryType('text/markdown') === false && isBinaryType(undefined) === false, 'isBinaryType classifies binary vs text types')
  await api.put({ title: 'BigImage.jpg', text: 'a'.repeat(300_000), type: 'image/jpeg', tags: ['binary-test'] })
  const fullList = await api.list(undefined, true)
  assert(!fullList.some((t) => t.title === 'BigImage.jpg'), 'list(includeText) excludes binary tiddlers')
  const base64Search = await api.search('aaaa')
  assert(!base64Search.items.some((t) => t.title === 'BigImage.jpg'), 'search never matches binary base64 payloads')
  const titleSearch = await api.search('BigImage')
  assert(titleSearch.total === 0, 'search skips binary tiddlers even on a title match (flood guard)')
  const recentNoBin = await api.recent(50)
  assert(!recentNoBin.some((t) => t.title === 'BigImage.jpg'), 'recent excludes binary tiddlers')
  const binRaw = await api.get('BigImage.jpg')
  assert(binRaw !== undefined && (binRaw.text ?? '').length === 300_000, 'raw client still returns the binary payload (the base64 guard lives in the tool layer)')
  const whitelist = await api.get(`$:/config/Server/ExternalFilters/${TEXT_LIST_FILTER}`)
  assert(whitelist !== undefined && whitelist.text === 'yes', 'first text listing self-heals the ExternalFilters whitelist tiddler')
  const textStillWorks = await api.search('hello')
  assert(textStillWorks.total >= 1, 'text search still works with binary tiddlers present')
  await api.delete('BigImage.jpg')

  await api.delete('Hello')
  const gone = await api.get('Hello')
  assert(gone === undefined, 'delete removes tiddler')

  // 2b. Theme adaption PREREQUISITES (read-only — the git sections below must
  // not see palette writes, because TW flushes filesystem saves ASYNCHRONOUSLY
  // after a REST PUT and a late flush would dirty the working tree): the dark
  // palette the client forces must exist, be registered, declare
  // `color-scheme: dark`, and the wiki's active palette must be light.
  {
    const active = await api.get('$:/palette')
    const origPalette = active?.text ?? ''
    assert(typeof origPalette === 'string' && origPalette.startsWith('$:/palettes/'), `wiki has an active palette (${origPalette || 'EMPTY'})`)
    const cupertino = await api.get('$:/palettes/CupertinoDark')
    assert(cupertino !== undefined, 'dark palette $:/palettes/CupertinoDark exists (core shadow)')
    assert(Array.isArray(cupertino?.tags) && cupertino.tags.includes('$:/tags/Palette'), 'CupertinoDark is a registered palette')
    assert(String(cupertino?.fields?.['color-scheme']) === 'dark', 'CupertinoDark declares color-scheme: dark')
    const vanilla = await api.get('$:/palettes/Vanilla')
    assert(String(vanilla?.fields?.['color-scheme']) === 'light', 'Vanilla declares color-scheme: light')
  }

  // 2a. tiddlywiki_rename through the REAL tool registry (regression: the
  // tool once re-put the tiddler under its OLD title and then deleted it, so
  // the note vanished and the new title was never created).
  const toolsByName = new Map()
  registerTiddlywikiTools(
    { tools: { register: (tool) => { toolsByName.set(tool.name, tool); return () => {} } } },
    { wiki: () => api, git: new GitFace(), wikiPath: () => wikiDir, noteTag: () => 'inbox', autoCommit: () => {} },
  )
  const renameTool = toolsByName.get('tiddlywiki_rename')
  assert(renameTool !== undefined, 'rename tool registered through the registry')
  await api.put({ title: 'RenameMe', text: 'rename payload', tags: ['inbox'] })
  await api.put({ title: 'RefHolder', text: 'see [[RenameMe]] and {{RenameMe}} here' })
  const renamed = await renameTool.execute({ oldTitle: 'RenameMe', newTitle: 'RenamedTitle' }, undefined)
  assert(renamed.ok === true && renamed.to === 'RenamedTitle', `rename reports success (to=${renamed.to})`)
  const newTid = await api.get('RenamedTitle')
  assert(newTid !== undefined && (newTid.text ?? '').includes('rename payload'), 'new title holds the content after rename')
  const oldTid = await api.get('RenameMe')
  assert(oldTid === undefined, 'old title removed after rename')
  const refTid = await api.get('RefHolder')
  assert((refTid.text ?? '').includes('[[RenamedTitle]]') && (refTid.text ?? '').includes('{{RenamedTitle}}'), 'references migrated to the new title')
  assert(renamed.refsTiddlers >= 1 && renamed.refsUpdated >= 2, `refs migrated (${renamed.refsTiddlers} tiddlers / ${renamed.refsUpdated} hits)`)
  const sameTitle = await renameTool.execute({ oldTitle: 'RenamedTitle', newTitle: 'RenamedTitle' }, undefined)
  assert(sameTitle.ok === true && (await api.get('RenamedTitle')) !== undefined, 'same-title rename is a safe no-op')
  await api.delete('RenamedTitle')
  await api.delete('RefHolder')

  // 2a2. tiddlywiki_get binary guard through the REAL tool registry: an
  // image/audio/… tiddler returns metadata only — never the base64 payload.
  await api.put({ title: 'BigImageTool.jpg', text: 'b'.repeat(100_000), type: 'image/png', tags: [] })
  const getTool = toolsByName.get('tiddlywiki_get')
  const binToolResult = await getTool.execute({ title: 'BigImageTool.jpg' }, undefined)
  assert(binToolResult.binary === true && binToolResult.text === '' && binToolResult.binaryType === 'image/png' && binToolResult.binaryChars === 100_000, 'get tool withholds base64 for binary tiddlers (binary=true, text empty)')
  const textGetResult = await getTool.execute({ title: '第二篇' }, undefined)
  assert(textGetResult.binary !== true && (textGetResult.text ?? '').includes('一篇中文笔记'), 'get tool still returns full text for a normal note')
  await api.delete('BigImageTool.jpg')

  // 2a3. v0.19.0 tool-layer safety rails + new tools — all through the REAL
  // registry: optimistic concurrency, incremental append, backlinks,
  // soft-delete + trash/restore, attachment storage, lint, ranked search.
  const putTool = toolsByName.get('tiddlywiki_put')
  const appendTool = toolsByName.get('tiddlywiki_append')
  const backlinksTool = toolsByName.get('tiddlywiki_backlinks')
  const trashTool = toolsByName.get('tiddlywiki_trash')
  const deleteTool = toolsByName.get('tiddlywiki_delete')
  const lintTool = toolsByName.get('tiddlywiki_lint')
  const attachTool = toolsByName.get('tiddlywiki_attach')
  const searchTool = toolsByName.get('tiddlywiki_search')
  assert([putTool, appendTool, backlinksTool, trashTool, deleteTool, lintTool, attachTool, searchTool].every((t) => t !== undefined), 'v0.19.0 tool set registers (put/append/backlinks/trash/delete/lint/attach/search)')

  // put: fields must not hijack identity fields, and a NEW tiddler is stamped.
  const putRes = await putTool.execute({ title: 'FieldGuard', text: 'body', fields: { title: 'Hijacked', created: '1999', type: 'text/markdown' } }, undefined)
  const fieldGuard = await api.get('FieldGuard')
  assert(fieldGuard?.title === 'FieldGuard', 'put: fields cannot override the title')
  assert(fieldGuard?.created !== '1999', 'put: fields cannot override created')
  assert(fieldGuard?.type === 'text/markdown', 'put: fields.type is the legitimate content-type override')
  assert(putRes.tags.includes('agent-written'), 'put: a NEW tiddler is stamped agent-written')
  await api.put({ title: 'HumanNote', text: 'by human' })
  await putTool.execute({ title: 'HumanNote', text: 'edited by agent' }, undefined)
  assert(!((await api.get('HumanNote'))?.tags ?? []).includes('agent-written'), 'put: overwriting a human note does NOT stamp agent-written')

  // put: a text-only update must NOT drop the note's tags/custom fields
  // (v0.19.0 data-loss fix — PUT replaces the whole tiddler, so the tool now
  // bases the write on the existing one when `tags` is omitted).
  await api.put({ title: 'PreserveProbe', text: 'v1', tags: ['keep-me', 'inbox'], mine: 'custom-value' })
  await putTool.execute({ title: 'PreserveProbe', text: 'v2' }, undefined)
  const preserved = await api.get('PreserveProbe')
  assert((preserved?.tags ?? []).includes('keep-me'), `put without tags preserves existing tags (${JSON.stringify(preserved?.tags)})`)
  assert(preserved?.mine === 'custom-value' || preserved?.fields?.mine === 'custom-value', 'put without fields preserves existing custom fields')
  await putTool.execute({ title: 'PreserveProbe', text: 'v3', tags: ['new-tag'] }, undefined)
  const replaced = await api.get('PreserveProbe')
  assert((replaced?.tags ?? []).join(',') === 'new-tag', `explicit tags replace the whole tag set (${JSON.stringify(replaced?.tags)})`)

  // put: optimistic concurrency (revision token — a freshly written tiddler has
  // no `modified` until the syncer writes + reloads it).
  await api.put({ title: 'ConcurrencyProbe', text: 'v1' })
  const stale = await api.get('ConcurrencyProbe')
  assert(typeof stale.revision === 'number', `get exposes the revision token (${JSON.stringify(stale.revision)})`)
  await putTool.execute({ title: 'ConcurrencyProbe', text: 'agent write' }, undefined)
  let conflictThrew = false
  try {
    await putTool.execute({ title: 'ConcurrencyProbe', text: 'stale write', expectedRevision: stale.revision }, undefined)
  } catch { conflictThrew = true }
  assert(conflictThrew, 'put: expectedRevision mismatch refuses the write (no silent lost update)')
  assert((await api.get('ConcurrencyProbe'))?.text === 'agent write', 'put: the refused write left the note untouched')
  const fresh = await api.get('ConcurrencyProbe')
  await putTool.execute({ title: 'ConcurrencyProbe', text: 'matching write', expectedRevision: fresh.revision }, undefined)
  assert((await api.get('ConcurrencyProbe'))?.text === 'matching write', 'put: a matching revision is accepted')
  await putTool.execute({ title: 'ConcurrencyProbe', text: 'forced', expectedRevision: stale.revision, force: true }, undefined)
  assert((await api.get('ConcurrencyProbe'))?.text === 'forced', 'put: force=true bypasses the concurrency guard')

  // append: incremental write, no full-document read, section targeting.
  await appendTool.execute({ title: 'AppendProbe', text: 'first line' }, undefined)
  await appendTool.execute({ title: 'AppendProbe', text: 'second line' }, undefined)
  const appended = await api.get('AppendProbe')
  assert(appended?.text === 'first line\n\nsecond line', `append adds at the end (${JSON.stringify(appended?.text)})`)
  assert((appended?.tags ?? []).includes('agent-written'), 'append on a missing tiddler creates it with agent-written')
  await appendTool.execute({ title: 'AppendProbe', text: '## Section A\nA body' }, undefined)
  await appendTool.execute({ title: 'AppendProbe', text: 'A tail', heading: 'Section A' }, undefined)
  const sectioned = (await api.get('AppendProbe'))?.text ?? ''
  assert(sectioned.includes('A body\n\nA tail'), `append heading= inserts inside the section (${JSON.stringify(sectioned)})`)
  await appendTool.execute({ title: 'AppendProbe', text: 'TOP', mode: 'prepend' }, undefined)
  assert(((await api.get('AppendProbe'))?.text ?? '').startsWith('TOP'), 'append mode=prepend inserts at the top')
  let missingThrew = false
  try { await appendTool.execute({ title: 'NoSuchNote', text: 'x', createIfMissing: false }, undefined) } catch { missingThrew = true }
  assert(missingThrew, 'append createIfMissing=false refuses a missing tiddler')

  // backlinks: links + tag membership.
  await api.put({ title: 'LinkTarget', text: 'target' })
  await api.put({ title: 'LinkSource', text: 'see [[LinkTarget]] and {{LinkTarget}}' })
  await api.put({ title: 'TaggedWithTarget', text: 'x', tags: ['LinkTarget'] })
  const bl = await backlinksTool.execute({ title: 'LinkTarget' }, undefined)
  assert(bl.items.some((i) => i.title === 'LinkSource' && i.refs >= 2 && i.via === 'link'), `backlinks finds the referencing note (${JSON.stringify(bl.items)})`)
  assert(bl.items.some((i) => i.title === 'TaggedWithTarget' && i.via === 'tag'), 'backlinks counts tag membership')
  assert(bl.tagCount >= 1 && bl.linkCount >= 1, 'backlinks reports per-kind counts')

  // delete → trash → restore → permanent.
  await api.put({ title: 'TrashProbe', text: 'recover me', tags: ['inbox'] })
  const softDeleted = await deleteTool.execute({ title: 'TrashProbe' }, undefined)
  assert(softDeleted.trashed === true && softDeleted.trashTitle?.startsWith('$:/dsh-tiddlywiki/trash/'), `delete is a SOFT delete by default (${JSON.stringify(softDeleted)})`)
  assert((await api.get('TrashProbe')) === undefined, 'soft delete removes the original title')
  assert((await api.get(softDeleted.trashTitle))?.text === 'recover me', 'soft delete keeps the content in the trash')
  const trashList = await trashTool.execute({ action: 'list' }, undefined)
  assert((trashList.items ?? []).some((i) => i.of === 'TrashProbe'), `trash list shows the deleted note (${JSON.stringify(trashList.items)})`)
  const searchAfterDelete = await searchTool.execute({ query: 'recover me' }, undefined)
  assert(!searchAfterDelete.results.some((r) => r.title === 'TrashProbe'), 'a trashed note no longer appears in search')
  const restoreResult = await trashTool.execute({ action: 'restore', title: 'TrashProbe' }, undefined)
  assert(restoreResult.action === 'restore', 'trash restore reports success')
  const restoredTid = await api.get('TrashProbe')
  assert(restoredTid?.text === 'recover me' && (restoredTid.tags ?? []).includes('inbox'), 'restore brings back content AND tags')
  await deleteTool.execute({ title: 'TrashProbe', permanent: true }, undefined)
  assert((await api.get('TrashProbe')) === undefined, 'permanent=true deletes for good')
  const trashEmpty = await trashTool.execute({ action: 'empty' }, undefined)
  assert(trashEmpty.action === 'empty', 'trash empty reports success')

  // lint: finds the class of damage the live wiki actually carries.
  await api.put({ title: 'JunkTagProbe', text: 'x', tags: ['筛选器错误:', 'Missing', 'in'] })
  await api.put({ title: 'BrokenLinkProbe', text: 'see [[NoSuchTiddlerAnywhere]]' })
  const lint = await lintTool.execute({}, undefined)
  assert(lint.issues.some((i) => i.kind === 'junk-tags' && i.count >= 1), `lint reports junk tags (${JSON.stringify(lint.issues.map((i) => i.kind))})`)
  assert(lint.issues.some((i) => i.kind === 'broken-links' && i.samples.some((s) => s.includes('NoSuchTiddlerAnywhere'))), 'lint reports broken links')
  await api.delete('JunkTagProbe')
  await api.delete('BrokenLinkProbe')

  // attach: a local file becomes a binary attachment tiddler, embedded in a note.
  const attachSrc = join(tmpdir(), `dsh-tw-attach-${Date.now()}.png`)
  await writeFile(attachSrc, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const attached = await attachTool.execute({ title: 'AttachProbe.png', path: attachSrc, noteTitle: 'AttachNote' }, undefined)
  assert(attached.mime === 'image/png' && attached.bytes === 8, `attach stores the file with its mime (${attached.mime}/${attached.bytes})`)
  const attachTid = await api.get('AttachProbe.png')
  assert(attachTid?.type === 'image/png' && (attachTid.text ?? '').length > 0, 'attachment tiddler carries the base64 body')
  assert(isBinaryType(attachTid?.type) === true, 'attachment registers as a binary type (excluded from search)')
  assert(((await api.get('AttachNote'))?.text ?? '').includes('[img[AttachProbe.png]]'), 'attach embeds the image into the target note')
  let attachBothThrew = false
  try { await attachTool.execute({ title: 'Bad', path: attachSrc, url: 'https://example.com/x.png' }, undefined) } catch { attachBothThrew = true }
  assert(attachBothThrew, 'attach requires exactly one of path/url')
  let attachRelativeThrew = false
  try { await attachTool.execute({ title: 'Bad2', path: 'relative.png' }, undefined) } catch { attachRelativeThrew = true }
  assert(attachRelativeThrew, 'attach refuses a relative local path')
  let attachSsrfThrew = false
  try { await attachTool.execute({ title: 'Bad3', url: 'http://127.0.0.1:1/x.png' }, undefined) } catch { attachSsrfThrew = true }
  assert(attachSsrfThrew, 'attach routes remote URLs through the SSRF guard (loopback refused)')
  await rm(attachSrc, { force: true })

  // search: snippet is taken AROUND the hit, and results are ranked.
  const longPrefix = '填充文字'.repeat(200)
  await api.put({ title: 'DeepHit', text: `${longPrefix} 深层关键词 ${longPrefix}` })
  await api.put({ title: 'RankProbe-标题命中', text: 'nothing else' })
  await api.put({ title: 'BodyOnlyProbe', text: 'the body merely mentions RankProbe somewhere' })
  const deepSearch = await searchTool.execute({ query: '深层关键词' }, undefined)
  const deepHit = deepSearch.results.find((r) => r.title === 'DeepHit')
  assert(deepHit !== undefined && deepHit.snippet.includes('深层关键词'), `search snippet contains the match (${JSON.stringify(deepHit?.snippet?.slice(0, 40))})`)
  const ranked = await searchTool.execute({ query: 'RankProbe' }, undefined)
  assert(ranked.results[0]?.title === 'RankProbe-标题命中', `search ranks a title hit above a body-only hit (${JSON.stringify(ranked.results.slice(0, 2).map((r) => r.title))})`)
  await api.delete('DeepHit')
  await api.delete('RankProbe-标题命中')
  await api.delete('BodyOnlyProbe')

  // search: custom-field filter.
  await api.put({ title: 'FieldSearchProbe', text: 'no keyword here', tags: ['inbox'], q: 'q1' })
  const fieldSearch = await searchTool.execute({ query: 'FieldSearchProbe', field: 'q', value: 'q1' }, undefined)
  assert(fieldSearch.results.some((r) => r.title === 'FieldSearchProbe'), 'search can filter on a custom field + value')
  const fieldMiss = await searchTool.execute({ query: 'FieldSearchProbe', field: 'q', value: 'nope' }, undefined)
  assert(fieldMiss.total === 0, 'search field filter rejects a non-matching value')
  const limitClamp = await searchTool.execute({ query: 'a', limit: 99999 }, undefined)
  assert(limitClamp.results.length <= 200, 'search clamps an abusive limit to 200')
  await api.delete('FieldSearchProbe')

  await api.delete('FieldGuard')
  await api.delete('HumanNote')
  await api.delete('PreserveProbe')
  await api.delete('ConcurrencyProbe')
  await api.delete('AppendProbe')
  await api.delete('LinkTarget')
  await api.delete('LinkSource')
  await api.delete('TaggedWithTarget')
  await api.delete('AttachProbe.png')
  await api.delete('AttachNote')

  // 3. Git face over the wiki folder (the whitelist tiddler written by 2b2 is
  // on disk here, so this also guards the "Filename too long" regression that
  // a too-long TEXT_LIST_FILTER would cause on Windows).
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
  // Bounded poll instead of a fixed 1s sleep: continue as soon as the debounced
  // commit fires (auto-commit is asynchronous).
  await waitFor(() => committed.some((c) => c.committed))
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
  const registered = []
  const mockCtx = {
    webServer: {
      register: (route) => {
        routeHandlers.set(route.path, route.handler)
        registered.push({ kind: route.kind, path: route.path, handler: route.handler })
        return () => {}
      },
    },
  }
  const makeReq = (url, body, method = 'GET') => {
    const req = new EventEmitter()
    req.url = url
    req.method = method
    req.headers = {}
    req.destroy = () => {}
    queueMicrotask(() => { if (body !== undefined) req.emit('data', body); req.emit('end') })
    return req
  }
  // Minimal ServerResponse double. It must model a real Writable because the
  // /tw proxy now STREAMS the upstream body (`Readable.fromWeb(...).pipe(res)`)
  // instead of buffering it — so `write`/`on`/`emit` and Buffer accumulation
  // are part of the contract this double has to honour (v0.19.0).
  const makeRes = () => {
    const res = new EventEmitter()
    res._status = 200
    res._payload = null
    res._chunks = []
    res.headersSent = false
    res.writeHead = (code) => { res._status = code; res.headersSent = true }
    res.write = (chunk) => {
      res._chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      return true
    }
    res.end = (body) => {
      if (body !== undefined && body !== null && body !== '') {
        res._chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body))
      }
      res._payload = Buffer.concat(res._chunks)
      queueMicrotask(() => {
        res.emit('finish')
        res.emit('close')
      })
    }
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

  // Like callRoute but returns the raw (possibly binary) response body.
  const callRaw = async (handler, req, res, ms = 8000) => {
    handler(req, res)
    const deadline = Date.now() + ms
    while (res._payload === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
    if (res._payload === null) throw new Error('route did not respond in time')
    return res._payload
  }

  // /upload: raw bytes land under <wiki>/files/ with a /files/<name> URL;
  // a name collision gets a -1 suffix instead of overwriting.
  // NOTE (v0.19.0): every WRITE route now enforces its HTTP method — the test
  // must POST (the handler used to run for any method, which is exactly the
  // CSRF hole that was fixed).
  const up = await callRoute(
    routeHandlers.get('/dsh-tiddlywiki/upload'),
    makeReq('/dsh-tiddlywiki/upload?name=hello%20notes.txt', Buffer.from('file content here'), 'POST'),
    makeRes(),
  )
  assert(up.ok === true && up.name === 'hello notes.txt' && up.url === `${TW_PROXY_PATH}files/hello%20notes.txt`, `upload returns name+proxy url (${JSON.stringify(up)})`)
  assert(await readFile(join(wikiDir, 'files', 'hello notes.txt'), 'utf8') === 'file content here', 'uploaded bytes saved under wiki files/')
  const up2 = await callRoute(
    routeHandlers.get('/dsh-tiddlywiki/upload'),
    makeReq('/dsh-tiddlywiki/upload?name=hello%20notes.txt', Buffer.from('second'), 'POST'),
    makeRes(),
  )
  assert(up2.ok === true && up2.name === 'hello notes-1.txt', `upload collision gets -1 suffix (${JSON.stringify(up2)})`)
  const upBad = await callRoute(
    routeHandlers.get('/dsh-tiddlywiki/upload'),
    makeReq('/dsh-tiddlywiki/upload?name=..%2F..%2Fevil.txt', Buffer.from('x'), 'POST'),
    makeRes(),
  )
  assert(upBad.ok === true && upBad.name === 'evil.txt', `path-traversal name sanitized to a bare name (${JSON.stringify(upBad.name)})`)
  const upDotdot = await callRoute(
    routeHandlers.get('/dsh-tiddlywiki/upload'),
    makeReq('/dsh-tiddlywiki/upload?name=..', Buffer.from('x'), 'POST'),
    makeRes(),
  )
  assert(upDotdot.ok === false, 'bare ".." filename rejected')

  // SECURITY REGRESSION (v0.19.0): a GET must never reach a write handler.
  // `http.ts` used to skip the CSRF check for GET and the host webserver
  // dispatches by pathname only, so `<img src=".../sync">` used to pull,
  // commit and push, and `.../restart` restarted the TW child.
  const upGetRes = makeRes()
  await callRaw(routeHandlers.get('/dsh-tiddlywiki/upload'), makeReq('/dsh-tiddlywiki/upload?name=get-should-not-write.txt', Buffer.from('x')), upGetRes)
  assert(upGetRes._status === 405, `GET on a write route is 405 (got ${upGetRes._status})`)
  const uploadAfterGet = await readFile(join(wikiDir, 'files', 'get-should-not-write.txt'), 'utf8').catch(() => null)
  assert(uploadAfterGet === null, 'a rejected GET /upload wrote nothing')
  for (const path of ['/dsh-tiddlywiki/sync', '/dsh-tiddlywiki/restart', '/dsh-tiddlywiki/note', '/dsh-tiddlywiki/edit']) {
    const res = makeRes()
    await callRaw(routeHandlers.get(path), makeReq(path), res)
    assert(res._status === 405, `GET ${path} is 405 (got ${res._status})`)
  }
  // A POST to a READ route is refused too (no accidental state change).
  const statusPost = makeRes()
  await callRaw(routeHandlers.get('/dsh-tiddlywiki/status'), makeReq('/dsh-tiddlywiki/status', Buffer.from('{}'), 'POST'), statusPost)
  assert(statusPost._status === 405, `POST /status is 405 (got ${statusPost._status})`)

  // /note: quick-note tiddlers are saved as Markdown so uploaded images/links
  // actually render in TW (a type-less tiddler would show raw `![..]`).
  const note = await callRoute(
    routeHandlers.get('/dsh-tiddlywiki/note'),
    makeReq('/dsh-tiddlywiki/note', Buffer.from(JSON.stringify({ title: 'NoteTypeTest', tags: ['inbox'], text: '![img](/files/a.png)' })), 'POST'),
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
  const sync = await callRoute(routeHandlers.get('/dsh-tiddlywiki/sync'), makeReq('/dsh-tiddlywiki/sync', undefined, 'POST'), makeRes())
  assert(sync.ok === true && sync.pull === 'ok' && sync.status?.branch === 'main', `sync pulls+commits+pushes (${JSON.stringify(sync.message ?? sync.error)})`)
  assert(sync.changed === true && sync.restarted === true, `changed pull restarts TW (changed=${sync.changed} restarted=${sync.restarted})`)
  const syncText = (await readFile(join(wikiDir, 'tiddlers', 'SyncTest.tid'), 'utf8')).replace(/\r/g, '')
  assert(syncText === 'from clone\n', 'sync pulled the remote change into the wiki')
  // A no-op sync (nothing new on origin) must NOT restart TW.
  const sync2 = await callRoute(routeHandlers.get('/dsh-tiddlywiki/sync'), makeReq('/dsh-tiddlywiki/sync', undefined, 'POST'), makeRes())
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

  // /search: keyword search backend for the reply-stream tool card (mirrors
  // tools.ts tiddlywiki_search — local match, AND tags, limit clamp).
  await routeApi.put({ title: 'SearchProbe', text: 'probe text 唯一关键词', tags: ['probe-tag'] })
  const searchRes = await callRoute(routeHandlers.get('/dsh-tiddlywiki/search'), makeReq('/dsh-tiddlywiki/search?query=' + encodeURIComponent('唯一关键词') + '&tag=probe-tag'), makeRes())
  assert(searchRes.ok === true && Array.isArray(searchRes.items) && searchRes.items.some((i) => i.title === 'SearchProbe'), `search route returns hits (${JSON.stringify(searchRes.items?.[0]?.title)})`)
  assert(typeof searchRes.items[0].snippet === 'string' && searchRes.items[0].snippet.length > 0, 'search route returns a snippet per hit')
  const searchNoHit = await callRoute(routeHandlers.get('/dsh-tiddlywiki/search'), makeReq('/dsh-tiddlywiki/search?query=' + encodeURIComponent('zzz-no-such')), makeRes())
  assert(searchNoHit.ok === true && searchNoHit.items.length === 0 && searchNoHit.total === 0, 'search route returns empty for no hits')
  const searchClamp = await callRoute(routeHandlers.get('/dsh-tiddlywiki/search'), makeReq('/dsh-tiddlywiki/search?query=' + encodeURIComponent('唯一关键词') + '&limit=99999'), makeRes())
  assert(searchClamp.ok === true && searchClamp.limit === 200, 'search route clamps limit to 200')

  // /tags: flat list for the autocomplete AND counted items for the tool card.
  // (SearchProbe still carries probe-tag here — delete it afterwards.)
  const tagsRes = await callRoute(routeHandlers.get('/dsh-tiddlywiki/tags'), makeReq('/dsh-tiddlywiki/tags'), makeRes())
  assert(tagsRes.ok === true && Array.isArray(tagsRes.tags) && tagsRes.tags.includes('probe-tag'), 'tags route lists distinct non-system tags')
  const probeCount = (tagsRes.items ?? []).find((i) => i.tag === 'probe-tag')
  assert(typeof probeCount?.count === 'number' && probeCount.count >= 1, 'tags route counts tiddlers per tag')
  await routeApi.delete('SearchProbe')

  // /tw same-origin proxy: the embedded editor's whole frontend is served to
  // the browser through the DSH origin (remote-access mode). Verify it strips
  // the prefix, serves JSON + binary losslessly, and forwards writes (CSRF).
  const proxyHandler = routeHandlers.get(TW_PROXY_PREFIX)
  assert(proxyHandler !== undefined, 'tw same-origin proxy route registered')
  const proxyStatus = await callRaw(proxyHandler, makeReq(`${TW_PROXY_PREFIX}/status`), makeRes())
  const proxyStatusJson = JSON.parse(proxyStatus.toString('utf8'))
  assert(proxyStatusJson.username !== undefined && proxyStatusJson.space !== undefined, `proxy /status returns TW status JSON (${JSON.stringify(proxyStatusJson).slice(0, 80)})`)
  const proxyTiddler = await callRaw(proxyHandler, makeReq(`${TW_PROXY_PREFIX}/recipes/default/tiddlers/${encodeURIComponent('RouteNote')}`), makeRes())
  assert(JSON.parse(proxyTiddler.toString('utf8')).title === 'RouteNote', 'proxy serves the TiddlyWeb read route (same content as the host client)')
  await mkdir(join(wikiDir, 'files'), { recursive: true })
  const binary = Buffer.from([0, 1, 2, 3, 254, 255])
  await writeFile(join(wikiDir, 'files', 'proxy.bin'), binary)
  const proxyFile = await callRaw(proxyHandler, makeReq(`${TW_PROXY_PREFIX}/files/proxy.bin`), makeRes())
  assert(proxyFile.equals(binary), 'proxy serves /files/ bytes losslessly (arrayBuffer, not .text())')
  const proxyWrite = await callRaw(proxyHandler, makeReq(`${TW_PROXY_PREFIX}/recipes/default/tiddlers/ProxyWrite`, Buffer.from(JSON.stringify({ title: 'ProxyWrite', text: 'via proxy', tags: ['test'] })), 'PUT'), makeRes())
  assert(proxyWrite.length === 0, 'proxy PUT returns an empty body (204)')
  const proxyWritten = await api.get('ProxyWrite')
  assert(proxyWritten?.text === 'via proxy', 'proxy PUT reached TW (CSRF header injected)')

  // ensureTwWebHost: TW's frontend API base must point at the same-origin
  // proxy; a missing/legacy-default tiddler is replaced, a user override kept.
  await ensureTwWebHost(api)
  const hostTid = await api.get(TW_WEB_HOST_TIDDLER)
  assert(hostTid?.text === TW_PROXY_PATH, `tiddlyweb/host points at the same-origin proxy (${JSON.stringify(hostTid?.text)})`)
  await api.put({ title: TW_WEB_HOST_TIDDLER, text: '$protocol$//$host$/', type: 'text/plain', tags: [] })
  await ensureTwWebHost(api)
  assert((await api.get(TW_WEB_HOST_TIDDLER))?.text === TW_PROXY_PATH, 'legacy default host replaced by the proxy path')
  await api.put({ title: TW_WEB_HOST_TIDDLER, text: 'https://custom.example/', type: 'text/plain', tags: [] })
  await ensureTwWebHost(api)
  assert((await api.get(TW_WEB_HOST_TIDDLER))?.text === 'https://custom.example/', 'custom tiddlyweb/host override is honored')

  // Real-HTTP end-to-end: a mini node:http server replicating
  // dsh-host-webserver's exact-then-longest-prefix match, driving the real
  // route handlers over real sockets — the browser view of the proxy
  // (status codes, content-type, served index HTML) rather than direct calls.
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
  const miniPort = await new Promise((resolveP) => {
    mini.listen(0, '127.0.0.1', () => resolveP(mini.address().port))
  })
  const miniBase = `http://127.0.0.1:${miniPort}`
  const indexRes = await fetch(`${miniBase}/dsh-tiddlywiki/tw/`)
  const indexHtml = await indexRes.text()
  assert(indexRes.status === 200 && (indexRes.headers.get('content-type') ?? '').includes('text/html'), `proxy serves the TW index as html (${indexRes.status} ${indexRes.headers.get('content-type')})`)
  assert(indexHtml.includes('<html') && indexHtml.includes('tiddlywiki'), 'proxy index HTML is the TW app (not a 404 shell)')
  const statusRes = await fetch(`${miniBase}/dsh-tiddlywiki/tw/status`)
  const statusJson = await statusRes.json()
  assert(statusRes.status === 200 && statusJson.anonymous === true, `proxy /status over real HTTP (${statusRes.status} anon=${statusJson.anonymous})`)
  const exactRes = await fetch(`${miniBase}/dsh-tiddlywiki/status`)
  assert(exactRes.status === 200 && (await exactRes.json()).twProxy === TW_PROXY_PATH, 'exact /status route wins and reports the same-origin twProxy path')
  await new Promise((resolveP) => mini.close(resolveP))

  disposeRoutes()

  // 5d1. /session/summary route (会话「知识库」Tab 后端): mock sessionQuery with
  // synthetic events in the REAL DSH shapes (tool/call name+arguments JSON string,
  // assistant/message text blocks), a real TW client, then assert the generated
  // $:/temp tiddler groups produced/read/searches and never lands on disk.
  {
    const summaryHandlers = new Map()
    const summaryMockCtx = {
      webServer: {
        register: (route) => {
          summaryHandlers.set(route.path, route.handler)
          return () => {}
        },
      },
    }
    const mainEvents = [
      { type: 'tool/call', seq: 1, time: 1788700000000, data: { name: 'tiddlywiki_put', arguments: JSON.stringify({ title: 'SummaryProduced', text: 'x', tags: ['inbox'] }) } },
      { type: 'tool/call', seq: 2, time: 1788700001000, data: { name: 'tiddlywiki_batch_put', arguments: JSON.stringify({ items: [{ title: 'SummaryBatch1' }, { title: 'SummaryBatch2' }] }) } },
      { type: 'tool/call', seq: 3, time: 1788700002000, data: { name: 'tiddlywiki_get', arguments: JSON.stringify({ title: 'SummaryRead' }) } },
      { type: 'tool/call', seq: 4, time: 1788700003000, data: { name: 'tiddlywiki_search', arguments: JSON.stringify({ query: 'hello', tags: ['inbox'] }) } },
      { type: 'tool/call', seq: 5, time: 1788700004000, data: { name: 'tiddlywiki_recent', arguments: JSON.stringify({}) } },
      { type: 'tool/call', seq: 6, time: 1788700005000, data: { name: 'tiddlywiki_rename', arguments: JSON.stringify({ oldTitle: 'SummaryOld', newTitle: 'SummaryRenamed' }) } },
      { type: 'assistant/message', seq: 7, time: 1788700006000, data: { message: { content: [{ type: 'text', text: '引用 [A%20B](/dsh-tiddlywiki/tw/#A%20B) 链接' }] } } },
    ]
    const mockSessionQuery = {
      readSession: async (id) => {
        if (id === 'session-summary-1-sub1') {
          return { session: { id }, events: [{ type: 'tool/call', seq: 1, time: 1788700010000, data: { name: 'tiddlywiki_put', arguments: JSON.stringify({ title: 'SummarySubProduced' }) } }] }
        }
        if (id === 'session-summary-1-sub2') {
          return { session: { id }, events: [{ type: 'tool/call', seq: 1, time: 1788700020000, data: { name: 'tiddlywiki_get', arguments: JSON.stringify({ title: 'SummarySubRead' }) } }] }
        }
        return { session: { id }, events: mainEvents }
      },
      traceSession: async (id) => ({
        descendants: [
          { session: { header: { id: `${id}-sub1` } }, descendants: [{ session: { header: { id: `${id}-sub2` } }, descendants: [] }] },
        ],
      }),
    }
    const summaryApi = new TiddlyWebClient(server.url)
    // Produce the notes the summary should list; leave SummaryRenamed missing so
    // the 已删除/不存在 marker is exercised.
    for (const t of ['SummaryProduced', 'SummaryBatch1', 'SummaryBatch2', 'SummarySubProduced', 'SummaryRead', 'SummarySubRead']) {
      await summaryApi.put({ title: t, text: `body of ${t}`, tags: ['inbox'] })
    }
    const disposeSummaryRoutes = registerRoutes(summaryMockCtx, {
      server,
      getClient: () => summaryApi,
      git,
      autoCommit: () => {},
      noteDefaults: () => ({ tag: 'inbox' }),
      uiDefaults: () => ({ showQuickNote: true, showQuickNoteDock: true, sidebarLabel: 'TW', showPanelStatus: true, showSyncButton: true, followDshTheme: true, darkPalette: '$:/palettes/CupertinoDark', tabLabel: '知识库', showSessionTab: true }),
      getWikiPath: () => wikiDir,
      getSessionQuery: () => mockSessionQuery,
    })
    assert(summaryHandlers.has('/dsh-tiddlywiki/session/summary'), 'session/summary route registered')
    const summary = await callRoute(
      summaryHandlers.get('/dsh-tiddlywiki/session/summary'),
      makeReq('/dsh-tiddlywiki/session/summary', Buffer.from(JSON.stringify({ session: 'session-summary-1' })), 'POST'),
      makeRes(),
    )
    assert(summary.ok === true, `session/summary returns ok (${JSON.stringify(summary)})`)
    assert(summary.title === '$:/temp/dsh/session-summary/session-summary-1', `volatile summary title (${JSON.stringify(summary.title)})`)
    assert(summary.counts.produced === 5 && summary.counts.read === 3 && summary.counts.searches === 2 && summary.counts.sessions === 3, `summary counts (${JSON.stringify(summary.counts)})`)
    const summaryTid = await summaryApi.get(summary.title)
    assert(summaryTid !== undefined && typeof summaryTid.text === 'string', 'summary tiddler readable through the real TW client')
    const stext = summaryTid.text
    assert(stext.includes('!!! 📝 产生') && stext.includes('[[SummaryProduced]]') && stext.includes('[[SummaryBatch1]]') && stext.includes('[[SummaryBatch2]]'), 'produced section lists put + batch titles')
    assert(stext.includes('[[SummaryRenamed]]') && stext.includes('已删除/不存在'), 'renamed-but-missing title flagged as deleted')
    assert(stext.includes('!!! 👀 读取') && stext.includes('[[SummaryRead]]') && stext.includes('[[A B]]'), 'read section lists get + decoded assistant-link titles')
    assert(stext.includes('!!! 🔍 检索记录') && stext.includes('tiddlywiki_search') && stext.includes('tiddlywiki_recent'), 'search section lists search + recent')
    assert(stext.includes('（子代理）') && stext.includes('[[SummarySubProduced]]') && stext.includes('[[SummarySubRead]]'), 'descendant subagent notes included + marked')
    const missing = await callRoute(
      summaryHandlers.get('/dsh-tiddlywiki/session/summary'),
      makeReq('/dsh-tiddlywiki/session/summary', Buffer.from(JSON.stringify({})), 'POST'),
      makeRes(),
    )
    assert(missing.ok === false && missing.error === 'session is required', 'session/summary rejects a missing session')
    // $:/temp must NOT reach the filesystem (volatile, git-clean).
    const diskFiles = []
    for (const f of await readdir(join(wikiDir, 'tiddlers'))) {
      if (f.includes('$__temp_dsh_session-summary') || f.includes('$__temp')) diskFiles.push(f)
    }
    assert(diskFiles.length === 0, `$:/temp summary never lands on disk (${diskFiles.join(',')})`)
    for (const t of ['SummaryProduced', 'SummaryBatch1', 'SummaryBatch2', 'SummarySubProduced', 'SummaryRead', 'SummarySubRead']) await summaryApi.delete(t)
    disposeSummaryRoutes()
  }

  // 5d2. agent routes (mock DSH services the routes resolve lazily):
  // /agent/modes exposes the permission-preset roster alongside the 工作模式,
  // and /agent/create validates + applies the chosen permission preset to the
  // just-created session's log (permissionPresets.set). Unknown presets are
  // rejected before any session is created.
  {
    const agentHandlers = new Map()
    const agentMockCtx = {
      webServer: {
        register: (route) => {
          agentHandlers.set(route.path, route.handler)
          return () => {}
        },
      },
    }
    const applied = []
    const mockSessions = {
      get: (id) => (id === 'session-mock-1' ? { mock: true } : undefined),
    }
    const mockPermissionPresets = {
      names: ['workspace-write', 'danger-full-access'],
      defaultPreset: 'workspace-write',
      optionOf: (n) => ({ value: n, name: n, description: `preset ${n}` }),
      set: (session, name) => applied.push({ session, name }),
    }
    const mockSessionController = {
      list: async () => ({
        items: [{ sessionId: 'session-mock-1', cwd: '/tmp', updatedAt: 1, running: false, blank: false }],
      }),
      create: async (req) => ({ sessionId: 'session-mock-1', agentPreset: req.agentPreset }),
      prompt: async () => ({ accepted: true }),
    }
    const mockWorkspaceRegistry = { create: async (p) => ({ id: `ws-${p}`, path: p }) }
    const mockAgentPresets = {
      list: async () => [{ id: 'default', name: '默认', description: '', trust: 'user' }],
      resolve: async () => ({ id: 'default', name: '默认' }),
    }
    const mockSessionPersistence = { list: async () => [{ id: 'session-mock-1', agentPreset: 'default' }] }
    const disposeAgentRoutes = registerRoutes(agentMockCtx, {
      server,
      getClient: () => new TiddlyWebClient(server.url),
      git,
      autoCommit: () => {},
      noteDefaults: () => ({ tag: 'inbox' }),
      uiDefaults: () => ({ showQuickNote: true, showPanelStatus: true, showSyncButton: true }),
      getWikiPath: () => wikiDir,
      getSessionController: () => mockSessionController,
      getWorkspaceRegistry: () => mockWorkspaceRegistry,
      getAgentPresets: () => mockAgentPresets,
      getSessionPersistence: () => mockSessionPersistence,
      getPermissionPresets: () => mockPermissionPresets,
      getSessions: () => mockSessions,
      sendToAgentEnabled: () => true,
      sendToAgentToken: () => '',
    })
    assert(agentHandlers.has('/dsh-tiddlywiki/agent/modes') && agentHandlers.has('/dsh-tiddlywiki/agent/create'), 'agent modes + create routes registered')
    const modesRes = await callRoute(agentHandlers.get('/dsh-tiddlywiki/agent/modes'), makeReq('/dsh-tiddlywiki/agent/modes'), makeRes())
    assert(
      modesRes.ok === true && Array.isArray(modesRes.permissions?.items) && modesRes.permissions.items.length === 2,
      `agent/modes carries the permission roster (${JSON.stringify(modesRes.permissions?.items?.map((x) => x.value))})`,
    )
    assert(modesRes.permissions?.defaultId === 'workspace-write', 'agent/modes reports the default permission preset')
    const createCwd = join(tempRoot, 'agent-ws')
    const createRes = await callRoute(
      agentHandlers.get('/dsh-tiddlywiki/agent/create'),
      makeReq('/dsh-tiddlywiki/agent/create', Buffer.from(JSON.stringify({ cwd: createCwd, mode: 'default', permission: 'danger-full-access' })), 'POST'),
      makeRes(),
    )
    assert(
      createRes.ok === true && createRes.permissionApplied === true && createRes.permission === 'danger-full-access',
      `agent/create applies the permission preset (${JSON.stringify(createRes)})`,
    )
    assert(applied.length === 1 && applied[0].name === 'danger-full-access', 'permissionPresets.set called once with the chosen preset')
    const badPerm = await callRoute(
      agentHandlers.get('/dsh-tiddlywiki/agent/create'),
      makeReq('/dsh-tiddlywiki/agent/create', Buffer.from(JSON.stringify({ cwd: createCwd, permission: 'nope' })), 'POST'),
      makeRes(),
    )
    assert(badPerm.ok === false && (badPerm.error ?? '').includes('unknown permission preset'), `agent/create rejects an unknown permission preset (${JSON.stringify(badPerm.error)})`)
    const noPerm = await callRoute(
      agentHandlers.get('/dsh-tiddlywiki/agent/create'),
      makeReq('/dsh-tiddlywiki/agent/create', Buffer.from(JSON.stringify({ cwd: createCwd })), 'POST'),
      makeRes(),
    )
    assert(noPerm.ok === true && noPerm.permission === null && noPerm.permissionApplied === false, 'agent/create without permission keeps the default (permission null)')
    disposeAgentRoutes()
  }

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

  // 5c. send-to-agent button seed: ONE-SHOT (marker-gated), never overwrites,
  // and the embedded bundle must carry the CURRENT (prefix-free + explanation)
  // message builder so a fresh wiki ships the updated button.
  const S2A_MARKER_TITLE = SEND_TO_AGENT_MARKER_TITLE
  assert(await seedSendToAgent(seedApi) === true, 'send-to-agent button seeded on first run')
  const s2aBundle = await seedApi.get(SEND_TO_AGENT_PLUGIN_TITLE)
  assert(s2aBundle !== undefined, 'send-to-agent plugin tiddler exists')
  assert(s2aBundle.type === 'application/json', 'send-to-agent plugin tiddler is application/json')
  assert(typeof s2aBundle.text === 'string' && s2aBundle.text.includes('"tiddlers"'), 'bundle text is a {"tiddlers": {...}} package')
  assert(s2aBundle.text.includes('$:/plugins/dsh/send-to-agent/startup.js'), 'bundle contains the startup.js tiddler')
  assert(s2aBundle.text.includes('【待办说明】'), 'bundle startup.js carries the todo explanation')
  assert(!s2aBundle.text.includes('【TiddlyWiki 笔记一键发送】'), 'bundle startup.js no longer carries the old prefix')
  assert(s2aBundle.text.includes('$:/plugins/dsh/send-to-agent/ui/icon'), 'bundle ships its own (non-export) toolbar icon')
  assert(s2aBundle.text.includes('附加说明（可选，随笔记一起发给 Agent）'), 'bundle startup.js carries the optional-note input')
  assert(s2aBundle.text.includes('body.permission = state.permission'), 'bundle startup.js forwards the chosen permission preset')
  assert(s2aBundle.text.includes('$:/core/ui/ControlPanel/Toolbars/ItemTemplate'), 'bundle overrides the toolbar-chooser row template so icons show in 设置')
  assert(s2aBundle.text.includes('tc-image-button') && s2aBundle.text.includes('width=<<size>>'), 'bundle icon follows core toolbar-icon conventions')
  assert(!s2aBundle.text.includes('"type": "image/svg+xml"'), 'bundle icon carries NO image/svg+xml type (core icons are wikitext; the image parser would render a data-URI <img> that breaks on \\parameters/<<size>> in Chrome)')
  assert(await seedSendToAgent(seedApi) === false, 'send-to-agent NOT re-seeded while marker present')
  await seedApi.put({ title: SEND_TO_AGENT_PLUGIN_TITLE, text: 'user edit', type: 'application/json', tags: [] })
  assert(await seedSendToAgent(seedApi) === false, 'edited send-to-agent bundle is never overwritten by the seed')
  await seedApi.delete(SEND_TO_AGENT_PLUGIN_TITLE)
  assert(await seedSendToAgent(seedApi) === false, 'deleted send-to-agent bundle NOT re-created (one-shot marker stays)')
  await seedApi.delete(S2A_MARKER_TITLE)
  assert(await seedSendToAgent(seedApi) === true, 'send-to-agent re-seeds after marker removed (fresh wiki)')
  await seedApi.delete(SEND_TO_AGENT_PLUGIN_TITLE)
  await seedApi.delete(S2A_MARKER_TITLE)

  // 5c2. render-route seed (回复流原生渲染插件): ONE-SHOT (marker-gated), never
  // overwrites edits, and the bundled route module must carry the CURRENT
  // proxy-hash wikilink rewrite. The route only loads at TW boot, so leave the
  // bundle seeded, wait for the filesystem flush, restart, and POST /render.
  assert(await seedRenderRoute(seedApi) === true, 'render-route plugin seeded on first run')
  const renderBundle = await seedApi.get(RENDER_PLUGIN_TITLE)
  assert(renderBundle !== undefined && renderBundle.type === 'application/json', 'render plugin tiddler exists (application/json)')
  assert(typeof renderBundle.text === 'string' && renderBundle.text.includes('server-routes/render.js'), 'render bundle contains the route module tiddler')
  assert(renderBundle.text.includes('module-type'), 'render bundle declares the route module')
  assert(renderBundle.text.includes('tv-wikilink-template') && renderBundle.text.includes('/dsh-tiddlywiki/tw/#$uri_encoded$'), 'render route rewrites wiki links to the same-origin proxy hash')
  assert(await seedRenderRoute(seedApi) === false, 'render-route NOT re-seeded while marker present')
  await seedApi.put({ title: RENDER_PLUGIN_TITLE, text: 'user edit', type: 'application/json', tags: [] })
  assert(await seedRenderRoute(seedApi) === false, 'edited render bundle is never overwritten by the seed')
  await seedApi.delete(RENDER_PLUGIN_TITLE)
  assert(await seedRenderRoute(seedApi) === false, 'deleted render bundle NOT re-created (one-shot marker stays)')
  await seedApi.delete(RENDER_MARKER_TITLE)
  assert(await seedRenderRoute(seedApi) === true, 'render-route re-seeds after marker removed (fresh wiki)')
  // Leave it seeded; the route needs a TW restart to load (server-routes modules
  // are registered at boot). Wait out TW's async filesystem flush first — a
  // bounded poll for the bundle actually landing on disk (title $:/plugins/dsh/render
  // is path-escaped to tiddlers/, .tid or .json depending on the adaptor).
  await waitFor(async () => {
    const dir = join(wikiDir, 'tiddlers')
    const files = await readdir(dir).catch(() => [])
    const file = files.find((name) => name.includes('plugins_dsh_render'))
    if (file === undefined) return false
    return (await readFile(join(dir, file), 'utf8').catch(() => '')).includes('server-routes')
  })
  await server.restart()
  const renderUrl = `${server.url}/render`
  const postJson = async (url, body) => {
    const res = await fetch(url, {
      method: 'POST',
      // TW's server gates every POST behind the writer CSRF header (POST maps
      // to "writers"; without X-Requested-With: TiddlyWiki the request 403s).
      headers: { 'content-type': 'application/json', 'x-requested-with': 'TiddlyWiki' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    return { status: res.status, text: await res.text() }
  }
  const renderTid = new TiddlyWebClient(server.url)
  await renderTid.put({ title: 'RenderMe', text: '原生正文 with [[Render Target]] and a 表格', tags: ['inbox'] })
  const r1 = await postJson(renderUrl, { title: 'RenderMe' })
  assert(r1.status === 200, `POST /render {title} returns 200 (got ${r1.status})`)
  assert(r1.text.includes('原生正文'), 'render {title} emits the tiddler body')
  assert(r1.text.includes('href="/dsh-tiddlywiki/tw/#Render%20Target"'), `render {title} rewrites internal wiki links to the proxy hash (${r1.text.slice(0, 160)})`)
  assert(r1.text.includes('tc-tiddlylink'), 'render fragment carries TW link classes')
  const r2 = await postJson(renderUrl, { text: 'Hello [[Inline Link]] world' })
  assert(r2.status === 200 && r2.text.includes('href="/dsh-tiddlywiki/tw/#Inline%20Link"'), 'POST /render {text} renders arbitrary wiki text')
  const r3 = await postJson(renderUrl, { title: 'DoesNotExist123' })
  assert(r3.status === 404, 'POST /render {title} 404s for a missing tiddler')
  const r4 = await postJson(renderUrl, {})
  assert(r4.status === 400, 'POST /render {} rejects with 400')
  const r5 = await postJson(renderUrl, { text: 'x' })
  assert(r5.status === 200, 'POST /render {text} works with a bare text body')
  await renderTid.delete('RenderMe')
  await seedApi.delete(RENDER_PLUGIN_TITLE)
  await seedApi.delete(RENDER_MARKER_TITLE)

  // 5d. Unified seed registry: home-index seed + checkAllSeeds + runSeedById
  // force (the settings-page 重新初始化 path) + tw-web-host ensure.
  // 5b/5c left doc-note and send-to-agent markers removed, so runAllSeeds here
  // must (re)write every missing seed.
  const seedCtx = { client: seedApi }

  // home-index first-run (marker-gated) + content sanity.
  assert(await seedHomeIndex(seedApi) === true, 'home-index seeded on first run')
  const homeTiddler = await seedApi.get('所有标签')
  assert(homeTiddler !== undefined && homeTiddler.text.includes('agent-written'), 'home 所有标签 carries the Agent 区块 (agent-written)')
  assert(homeTiddler.text.includes('agent-tags-pure') && homeTiddler.text.includes('agent-notes-mixed'), 'home 所有标签 carries pure/mixed agent blocks')
  const tagPage = await seedApi.get('标签笔记')
  assert(tagPage !== undefined && tagPage.text.includes('$:/state/tag'), 'home 标签笔记 page seeded')
  const mainHome = await seedApi.get('🏠 主页')
  assert(mainHome !== undefined && mainHome.text.includes('quadrant-board') && mainHome.text.includes('所有文章'), '主页 seeded with quadrant board + entries')
  // The seeded home is the GENERIC one: no personal 主题页 tabs / private nav
  // buttons, and it carries the「📚 插件文档」tabs strip (tag dsh-docs).
  assert(!mainHome.text.includes('主题页·工作') && !mainHome.text.includes('$to="书籍"'), 'seeded home strips personal tabs/private entries')
  assert(mainHome.text.includes('插件文档') && mainHome.text.includes('tag[dsh-docs]'), 'seeded home carries the docs tabs strip')
  const defTiddlers = await seedApi.get('$:/DefaultTiddlers')
  assert(defTiddlers !== undefined && (defTiddlers.text ?? '').includes('[[🏠 主页]]'), '$:/DefaultTiddlers points at 🏠 主页')
  assert(await seedHomeIndex(seedApi) === false, 'home-index NOT re-seeded while marker present')
  await seedApi.put({ title: '所有标签', text: 'user home edit', tags: ['索引'] })
  assert(await seedHomeIndex(seedApi) === false, 'edited home tiddler is never overwritten by the seed')
  await seedApi.delete('所有标签')
  assert(await seedHomeIndex(seedApi) === false, 'deleted home tiddler NOT re-created (one-shot marker stays)')

  // force = manual 重新初始化: overwrites user edits AND restores the tiddler.
  await seedApi.put({ title: '所有标签', text: 'user home edit', tags: ['索引'] })
  assert(await seedHomeIndex(seedApi, { force: true }) === true, 'home-index force re-initializes an edited tiddler')
  const restored = await seedApi.get('所有标签')
  assert(restored !== undefined && restored.text.includes('agent-tags-pure'), 'force restored built-in home content')
  await seedApi.delete('所有标签')
  await seedApi.delete(HOME_INDEX_MARKER_TITLE)

  // checkAllSeeds: the registry has exactly the ten联动 items.
  const statuses = await checkAllSeeds(seedCtx)
  const ids = statuses.map((s) => s.id).sort()
  assert(JSON.stringify(ids) === JSON.stringify(['all-articles', 'clip-bridge', 'doc-note', 'home-index', 'menubar-theme', 'render-route', 'send-to-agent', 'starter-docs', 'tw-web-host', 'ui-styles']), `seed registry lists all ten联动 items (${ids.join(',')})`)
  assert(statuses.every((s) => typeof s.title === 'string' && s.title.length > 0), 'every seed has a display title')

  // all-articles first-run (marker-gated) + content sanity + force.
  assert(await seedAllArticles(seedApi) === true, 'all-articles seeded on first run')
  const articlesPage = await seedApi.get(ALL_ARTICLES_TITLE)
  assert(articlesPage !== undefined && articlesPage.text.includes('agent-list') && articlesPage.text.includes('human-list'), 'all-articles page carries both column filters')
  assert(await seedAllArticles(seedApi) === false, 'all-articles NOT re-seeded while marker present')
  await seedApi.put({ title: ALL_ARTICLES_TITLE, text: 'user edit', tags: ['索引'] })
  assert(await seedAllArticles(seedApi) === false, 'edited all-articles page never overwritten by the seed')
  assert(await seedAllArticles(seedApi, { force: true }) === true, 'all-articles force re-initializes an edited page')
  const restoredArticles = await seedApi.get(ALL_ARTICLES_TITLE)
  assert(restoredArticles !== undefined && restoredArticles.text.includes('human-list'), 'force restored built-in all-articles content')
  await seedApi.delete(ALL_ARTICLES_TITLE)
  await seedApi.delete('$:/plugins/dsh-tiddlywiki/seed-all-articles')

  // menubar-theme first-run (marker-gated) + ONE-SHOT semantics + force.
  assert(await seedMenubarTheme(seedApi) === true, 'menubar-theme seeded on first run')
  const menubarT = await seedApi.get(MENUBAR_THEME_TIDDLER)
  assert(menubarT !== undefined && menubarT.text.includes('<<colour background>>'), 'menubar-theme carries the palette-driven override')
  assert(Array.isArray(menubarT.tags) && menubarT.tags.includes('$:/tags/Stylesheet'), 'menubar-theme is tagged as a Stylesheet')
  assert(await seedMenubarTheme(seedApi) === false, 'menubar-theme NOT re-seeded while marker present')
  await seedApi.put({ title: MENUBAR_THEME_TIDDLER, text: 'user edit', tags: ['$:/tags/Stylesheet'] })
  assert(await seedMenubarTheme(seedApi) === false, 'edited menubar-theme never overwritten by the seed')
  assert(await seedMenubarTheme(seedApi, { force: true }) === true, 'menubar-theme force re-initializes an edited tiddler')
  const menubarRestored = await seedApi.get(MENUBAR_THEME_TIDDLER)
  assert(menubarRestored !== undefined && menubarRestored.text.includes('nav.tc-menubar ul.tc-menubar-list'), 'force restored built-in menubar-theme content')
  await seedApi.delete(MENUBAR_THEME_TIDDLER)
  await seedApi.delete(MENUBAR_THEME_MARKER_TITLE)

  // starter-docs (示例与文档) first-run + safe-skip + force + dsh-docs tag.
  assert(await seedStarterDocs(seedApi) === true, 'starter-docs seeded on first run')
  const tutT = await seedApi.get('教程：按主题/标签做汇总页')
  assert(tutT !== undefined && tutT.text.includes('核心思路'), 'starter-docs carries the 汇总页 tutorial')
  assert(Array.isArray(tutT.tags) && tutT.tags.includes('dsh-docs'), 'starter doc is tagged dsh-docs (lands in the home docs tab)')
  const tmplT = await seedApi.get('主题汇总页·模板')
  assert(tmplT !== undefined && tmplT.text.includes('主题A'), 'template tiddler seeded with placeholder tag')
  const exLog = await seedApi.get('主题页·日志')
  assert(exLog !== undefined && exLog.text.includes('[tag[日志]'), 'example theme page 日志 seeded')
  // safe-skip: a same-named tiddler already present is NEVER overwritten.
  await seedApi.put({ title: '主题页·日志', text: 'user edit', tags: ['主题页'] })
  assert(await seedStarterDocs(seedApi) === false, 'starter-docs NOT re-seeded while marker present')
  assert((await seedApi.get('主题页·日志'))?.text === 'user edit', 'user edit to a starter doc survives (safe-skip)')
  assert(await seedStarterDocs(seedApi, { force: true }) === true, 'starter-docs force re-initializes')
  assert((await seedApi.get('主题页·日志'))?.text.includes('[tag[日志]'), 'force restored built-in example content')
  await seedApi.delete('主题页·日志')
  await seedApi.delete(STARTER_DOCS_MARKER_TITLE)

  // ui-styles (自定义样式) first-run + one-shot + force + clean stylesheet tag.
  assert(await seedUiStyles(seedApi) === true, 'ui-styles seeded on first run')
  const styleT = await seedApi.get('编辑器美化 CSS')
  assert(styleT !== undefined && styleT.text.includes('CodeMirror'), 'ui-styles carries the editor beautification sheet')
  assert(styleT.type === 'text/css' && Array.isArray(styleT.tags) && styleT.tags.length === 1 && styleT.tags[0] === '$:/tags/Stylesheet', 'ui-style tiddlers carry ONLY the functional stylesheet tag')
  const nbSheet = await seedApi.get('侧边栏窄屏自动隐藏.css')
  assert(nbSheet !== undefined && nbSheet.text.includes('max-width: 959px'), 'narrow-sidebar sheet seeded')
  const mbSheet = await seedApi.get('menubar 顶栏加高样式')
  assert(mbSheet !== undefined && mbSheet.text.includes('min-height: 44px'), 'menubar-height sheet seeded')
  assert(await seedUiStyles(seedApi) === false, 'ui-styles NOT re-seeded while marker present')
  await seedApi.put({ title: '编辑器美化 CSS', text: 'user edit', tags: ['$:/tags/Stylesheet'] })
  assert(await seedUiStyles(seedApi) === false, 'edited ui-style sheet never overwritten')
  assert(await seedUiStyles(seedApi, { force: true }) === true, 'ui-styles force re-initializes an edited sheet')
  assert((await seedApi.get('编辑器美化 CSS'))?.text.includes('CodeMirror'), 'force restored built-in stylesheet content')
  await seedApi.delete('编辑器美化 CSS')
  await seedApi.delete(UI_STYLES_MARKER_TITLE)

  // clip-bridge (本地剪藏桥说明文档, v0.16.24) first-run + one-shot + force + dsh-docs tag.
  assert(await seedClipBridge(seedApi) === true, 'clip-bridge doc seeded on first run')
  const clipDoc = await seedApi.get(CLIP_BRIDGE_DOC_TITLE)
  assert(clipDoc !== undefined && clipDoc.type === 'text/markdown' && clipDoc.text.includes('javascript:('), 'clip-bridge doc is markdown and carries the bookmarklet')
  assert(Array.isArray(clipDoc.tags) && clipDoc.tags.includes('dsh-docs'), 'clip-bridge doc is tagged dsh-docs (lands in the home docs tab)')
  assert(await seedClipBridge(seedApi) === false, 'clip-bridge NOT re-seeded while marker present')
  await seedApi.put({ title: CLIP_BRIDGE_DOC_TITLE, text: 'user edit' })
  assert(await seedClipBridge(seedApi) === false, 'edited clip-bridge doc never overwritten by the seed')
  assert(await seedClipBridge(seedApi, { force: true }) === true, 'clip-bridge force re-initializes an edited doc')
  assert((await seedApi.get(CLIP_BRIDGE_DOC_TITLE))?.text.includes('本地剪藏桥'), 'force restored built-in clip-bridge doc content')
  await seedApi.delete(CLIP_BRIDGE_DOC_TITLE)
  await seedApi.delete(CLIP_BRIDGE_MARKER_TITLE)

  // runAllSeeds (startup path, v0.16.22): seeds the CORE items (功能必需：
  // 发送给 Agent 按钮 + TW 前端 API 基址 + 原生渲染路由) AND the STARTER items
  // (首次安装默认: 插件说明 + 示例与文档). The remaining optional seeds (首页 /
  // 所有文章 / 自定义样式 / menubar 顶栏主题自适应 / 剪藏桥说明) are never forced.
  // Earlier sections left mixed state: doc-note's marker stays while its
  // tiddler was deleted, and the earlier ensureTwWebHost test left a CUSTOM
  // host override. Clear the core markers + bundles so send-to-agent,
  // tw-web-host and render-route are genuinely missing here; also clear the
  // starter markers so doc-note + starter-docs are re-seeded by startup.
  await seedApi.delete('$:/plugins/dsh-tiddlywiki/seed-doc-note')
  await seedApi.delete(TW_WEB_HOST_TIDDLER)
  await seedApi.delete(SEND_TO_AGENT_MARKER_TITLE)
  await seedApi.delete(SEND_TO_AGENT_PLUGIN_TITLE)
  await seedApi.delete(RENDER_MARKER_TITLE)
  await seedApi.delete(RENDER_PLUGIN_TITLE)
  const startup = await runAllSeeds(seedCtx)
  assert(startup.length === 5, 'startup runAllSeeds seeds the three core + two starter items')
  assert(startup.every((r) => r.ok), 'core + starter seeds run ok at startup')
  assert(startup.every((r) => r.wrote), 'all five startup seeds were missing and got written')
  assert(startup.every((r) => ['send-to-agent', 'tw-web-host', 'render-route', 'doc-note', 'starter-docs'].includes(r.id)), 'startup only touches the core + starter seeds')
  assert((await seedApi.get(DOC_NOTE_TITLE)) !== undefined, 'startup path re-creates the starter doc note')
  assert((await seedApi.get('教程：按主题/标签做汇总页')) !== undefined, 'startup path re-creates the starter docs')
  assert((await seedApi.get(MENUBAR_THEME_TIDDLER)) === undefined, 'startup path does NOT re-create the optional menubar-theme')
  assert((await seedApi.get(ALL_ARTICLES_TITLE)) === undefined, 'startup path does NOT re-create the optional all-articles')
  assert((await seedApi.get('所有标签')) === undefined, 'startup path does NOT re-create the optional home-index')
  assert((await seedApi.get('编辑器美化 CSS')) === undefined, 'startup path does NOT re-create the optional ui-styles')
  assert((await seedApi.get(CLIP_BRIDGE_DOC_TITLE)) === undefined, 'startup path does NOT re-create the optional clip-bridge doc')

  // Manual run-all (settings "全部重新初始化", non-force) still covers every
  // registry item; only the missing optional seeds get written now.
  const all = await runSeedById(seedCtx, undefined, false)
  assert(all.length === 10, 'manual run-all covers every registry item')
  assert(all.every((r) => r.ok), 'all seeds run ok')
  const allWrote = all.filter((r) => r.wrote).map((r) => r.id).sort()
  assert(JSON.stringify(allWrote) === JSON.stringify(['all-articles', 'clip-bridge', 'home-index', 'menubar-theme', 'ui-styles']), `manual run-all writes exactly the missing optional seeds (${allWrote.join(',')})`)

  // runSeedById with an id runs only that one; force rewrites regardless.
  const onlyHome = await runSeedById(seedCtx, 'home-index', false)
  assert(onlyHome.length === 1 && onlyHome[0].id === 'home-index' && onlyHome[0].wrote === false, 'single-seed run is idempotent while present')
  await seedApi.put({ title: '所有标签', text: 'again edited', tags: ['索引'] })
  const forceHome = await runSeedById(seedCtx, 'home-index', true)
  assert(forceHome.length === 1 && forceHome[0].ok && forceHome[0].wrote, 'single-seed force rewrites an edited tiddler')
  assert((await seedApi.get('所有标签')).text.includes('agent-tags-pure'), 'force single-seed restored built-in content')
  await seedApi.delete('所有标签')
  await seedApi.delete(HOME_INDEX_MARKER_TITLE)

  // unknown seed id → explicit error result.
  const unknown = await runSeedById(seedCtx, 'nope', false)
  assert(unknown.length === 1 && !unknown[0].ok && unknown[0].error?.includes('unknown seed'), 'unknown seed id is reported, not thrown')

  // tw-web-host seed: ensure semantics (non-force) and force rewrite.
  // runAllSeeds above already wrote the proxy host; verify the three branches.
  // 1) custom host override is honored by non-force (never overwritten).
  await seedApi.put({ title: TW_WEB_HOST_TIDDLER, text: 'https://example.com/', type: 'text/plain', tags: [] })
  const hostKeep = await runSeedById(seedCtx, 'tw-web-host', false)
  assert(hostKeep.length === 1 && hostKeep[0].ok && hostKeep[0].wrote === false, 'tw-web-host non-force honors a custom host override')
  assert((await seedApi.get(TW_WEB_HOST_TIDDLER))?.text?.trim() === 'https://example.com/', 'custom host override survives non-force run')
  // 2) force rewrites even a custom host (settings-page 重新初始化).
  const hostForce = await runSeedById(seedCtx, 'tw-web-host', true)
  assert(hostForce.length === 1 && hostForce[0].ok && hostForce[0].wrote, 'tw-web-host force rewrites the proxy host')
  assert((await seedApi.get(TW_WEB_HOST_TIDDLER))?.text?.trim() === TW_PROXY_PATH, 'tw-web-host force restored the proxy path')
  // 3) legacy default host is repaired by non-force.
  await seedApi.put({ title: TW_WEB_HOST_TIDDLER, text: '$protocol$//$host$/', type: 'text/plain', tags: [] })
  const hostRepair = await runSeedById(seedCtx, 'tw-web-host', false)
  assert(hostRepair.length === 1 && hostRepair[0].ok && hostRepair[0].wrote, 'tw-web-host non-force repairs the legacy default host')
  assert((await seedApi.get(TW_WEB_HOST_TIDDLER))?.text?.trim() === TW_PROXY_PATH, 'legacy host repaired to the proxy path')

  // 反初始化 (removeSeedById, v0.15.0): optional seeds delete their tiddlers
  // + markers; core seeds are protected; unknown ids are reported.
  await runSeedById(seedCtx, 'menubar-theme', true)
  await runSeedById(seedCtx, 'all-articles', true)
  await runSeedById(seedCtx, 'home-index', true)
  assert((await seedApi.get(MENUBAR_THEME_TIDDLER)) !== undefined, 'menubar-theme re-seeded for the remove test')
  const rmMenubar = await removeSeedById(seedCtx, 'menubar-theme')
  assert(rmMenubar.length === 1 && rmMenubar[0].ok && (rmMenubar[0].detail ?? '').includes('已移除'), 'remove menubar-theme reports the removed tiddlers')
  assert((await seedApi.get(MENUBAR_THEME_TIDDLER)) === undefined, 'menubar-theme tiddler removed')
  assert((await seedApi.get(MENUBAR_THEME_MARKER_TITLE)) === undefined, 'menubar-theme marker removed')
  const rmArticles = await removeSeedById(seedCtx, 'all-articles')
  assert(rmArticles.length === 1 && rmArticles[0].ok, 'remove all-articles ok')
  assert((await seedApi.get(ALL_ARTICLES_TITLE)) === undefined && (await seedApi.get('$:/plugins/dsh-tiddlywiki/seed-all-articles')) === undefined, 'all-articles page + marker removed')
  const rmHome = await removeSeedById(seedCtx, 'home-index')
  assert(rmHome.length === 1 && rmHome[0].ok, 'remove home-index ok')
  assert((await seedApi.get('🏠 主页')) === undefined && (await seedApi.get('所有标签')) === undefined && (await seedApi.get('标签笔记')) === undefined, 'home tiddlers removed')
  assert((await seedApi.get('$:/DefaultTiddlers'))?.text?.trim() === '[[GettingStarted]]', 'remove home-index restores $:/DefaultTiddlers to GettingStarted')
  // Core seeds are protected from removal.
  const rmCoreS2a = await removeSeedById(seedCtx, 'send-to-agent')
  assert(rmCoreS2a.length === 1 && !rmCoreS2a[0].ok && (rmCoreS2a[0].error ?? '').includes('核心'), 'core seed send-to-agent cannot be removed')
  assert((await seedApi.get(SEND_TO_AGENT_PLUGIN_TITLE)) !== undefined, 'send-to-agent bundle survives the rejected remove')
  const rmCoreHost = await removeSeedById(seedCtx, 'tw-web-host')
  assert(rmCoreHost.length === 1 && !rmCoreHost[0].ok, 'core seed tw-web-host cannot be removed')
  const rmCoreRender = await removeSeedById(seedCtx, 'render-route')
  assert(rmCoreRender.length === 1 && !rmCoreRender[0].ok && (rmCoreRender[0].error ?? '').includes('核心'), 'core seed render-route cannot be removed')
  assert((await seedApi.get(RENDER_PLUGIN_TITLE)) !== undefined, 'render-route bundle survives the rejected remove')
  // Unknown id → explicit error result, not thrown.
  const rmUnknown = await removeSeedById(seedCtx, 'nope')
  assert(rmUnknown.length === 1 && !rmUnknown[0].ok && (rmUnknown[0].error ?? '').includes('unknown seed'), 'remove unknown seed id is reported, not thrown')
  // Remove-all targets exactly the seven non-core seeds (5 optional + 2 starter),
  // keeps the core ones.
  await runSeedById(seedCtx, 'menubar-theme', true)
  await runSeedById(seedCtx, 'doc-note', true)
  await runSeedById(seedCtx, 'starter-docs', true)
  await runSeedById(seedCtx, 'ui-styles', true)
  await runSeedById(seedCtx, 'clip-bridge', true)
  const rmAll = await removeSeedById(seedCtx, undefined)
  assert(rmAll.length === 7, 'remove-all targets exactly the seven non-core seeds')
  assert(rmAll.every((r) => r.ok), 'remove-all all ok')
  assert((await seedApi.get(MENUBAR_THEME_TIDDLER)) === undefined && (await seedApi.get(DOC_NOTE_TITLE)) === undefined && (await seedApi.get(CLIP_BRIDGE_DOC_TITLE)) === undefined, 'remove-all cleaned optional tiddlers')
  assert((await seedApi.get(SEND_TO_AGENT_PLUGIN_TITLE)) !== undefined && (await seedApi.get(TW_WEB_HOST_TIDDLER)) !== undefined && (await seedApi.get(RENDER_PLUGIN_TITLE)) !== undefined, 'remove-all keeps the core seeds')

  // 5e. Active-palette flip round-trip (before the server stops; kept AFTER
  // the git-clean assertions on purpose — TW flushes filesystem saves
  // asynchronously after a REST PUT, so a palette write must never precede
  // them). The browser theme-sync flips `$:/palette` IN MEMORY with the
  // syncer's changeCount re-aligned, so it never reaches the disk; here we
  // only prove the REST surface can switch the active palette and read it back.
  {
    const origPalette = (await api.get('$:/palette'))?.text ?? ''
    await api.put({ title: '$:/palette', text: '$:/palettes/CupertinoDark' })
    assert((await api.get('$:/palette'))?.text === '$:/palettes/CupertinoDark', 'palette flip round-trips via TiddlyWeb')
    await api.put({ title: '$:/palette', text: origPalette })
    assert((await api.get('$:/palette'))?.text === origPalette, 'palette restore round-trips via TiddlyWeb')
    // Wait (bounded poll) for TW's async save queue to flush the restored
    // palette file before stop/cleanup (path-escaped title $:/palette).
    await waitFor(async () => {
      if (origPalette.length === 0) return false
      const dir = join(wikiDir, 'tiddlers')
      const files = await readdir(dir).catch(() => [])
      const file = files.find((name) => name.startsWith('$__palette'))
      if (file === undefined) return false
      return (await readFile(join(dir, file), 'utf8').catch(() => '')).includes(origPalette)
    })
  }

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

  // ensurePlugin (v0.19.0): `--init server` ships NO markdown plugin, yet every
  // note this plugin writes is text/markdown — without the bootstrap a fresh
  // install renders all of them as raw source.
  assert(!infoBefore.plugins.includes('tiddlywiki/markdown'), `fresh wiki has no markdown plugin (${infoBefore.plugins.join(',')})`)
  const markdownAdded = await ensurePlugin(wikiDir, twRoot, 'tiddlywiki/markdown')
  assert(markdownAdded === true, 'ensurePlugin adds tiddlywiki/markdown to a fresh wiki')
  assert((await readWikiInfo(wikiDir)).plugins.includes('tiddlywiki/markdown'), 'markdown plugin persisted to tiddlywiki.info')
  assert((await ensurePlugin(wikiDir, twRoot, 'tiddlywiki/markdown')) === false, 'ensurePlugin is idempotent')
  let unknownPluginThrew = false
  try { await ensurePlugin(wikiDir, twRoot, 'tiddlywiki/definitely-not-bundled') } catch { unknownPluginThrew = true }
  assert(unknownPluginThrew, 'ensurePlugin refuses a plugin that is not in the bundled catalog')
  await writeWikiInfo(wikiDir, infoBefore)

  // readWikiInfo error policy (v0.19.0): ONLY a missing file means "no config".
  // A malformed file must THROW — reporting an empty config there let a
  // settings-page save rewrite tiddlywiki.info without the real plugins.
  const brokenDir = await mkdtemp(join(tmpdir(), 'dsh-tw-broken-'))
  await writeFile(join(brokenDir, 'tiddlywiki.info'), '{ this is not json', 'utf8')
  let brokenThrew = false
  try { await readWikiInfo(brokenDir) } catch { brokenThrew = true }
  assert(brokenThrew, 'malformed tiddlywiki.info throws instead of reporting an empty config')
  const missingInfo = await readWikiInfo(join(brokenDir, 'no-such-wiki'))
  assert(Array.isArray(missingInfo.plugins) && missingInfo.plugins.length === 0, 'missing tiddlywiki.info still degrades to an empty config (first run)')
  // writeWikiInfo keeps a .bak and never leaves a truncated file behind.
  await writeWikiInfo(brokenDir, { plugins: ['tiddlywiki/markdown'], themes: [] })
  assert((await readFile(join(brokenDir, 'tiddlywiki.info.bak'), 'utf8')).startsWith('{ this is not json'), 'writeWikiInfo backs up the previous file')
  assert((await readWikiInfo(brokenDir)).plugins.includes('tiddlywiki/markdown'), 'writeWikiInfo wrote valid JSON over the broken file')

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
  // Always reap the TW child (idempotent), even when an assertion failed —
  // otherwise the port stays held and the temp tree cannot be removed.
  await server?.stop().catch(() => {})
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
}
process.exit(exitCode)

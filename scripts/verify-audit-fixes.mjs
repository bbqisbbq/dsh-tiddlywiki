#!/usr/bin/env node
/**
 * v0.19.5 审计修复的回归守门（真实 TW 子进程 + 真实 HTTP 路由）。
 *
 * 覆盖本轮修掉的数据安全 / 正确性缺陷，每一条都是「先复现旧行为会失败」的断言：
 *
 *   1. attach 不得静默覆盖同名笔记（旧实现不读旧条目直接 PUT：tags/自定义字段/正文全丢），
 *      且新建附件要补 agent-written；同名已存在时无令牌必须拒绝（explizit force 才覆盖）。
 *   2. /edit 必须保留条目的内容类型：wikitext 笔记进原生编辑器后草稿 type 仍是
 *      wikitext（旧实现写死 text/markdown，TW 保存草稿会把笔记降级成 markdown）。
 *   3. 回收站索引读失败 / JSON 损坏时必须中止并抛错，绝不重建为空索引（旧实现
 *      返回 [] 后全量覆盖，等于把之前所有回收站记录变成不可达孤儿）。
 *   4. rename 在「新标题已写入、旧标题删除失败」时必须把两份副本的事实报给调用方。
 *   5. 会话汇总对超出单次探测上限的条目必须显示「未探测」，不得谎报「已删除/不存在」。
 *   6. delete 支持乐观并发令牌：读后被改动必须 409 语义（抛 WriteConflictError），
 *      而不是无声地把人类的新改动丢进回收站。
 *
 * 需要先 `npm run build`（import lib/index.js），会 spawn 真实 TW。
 *
 *   node scripts/verify-audit-fixes.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-audit-fixes
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WikiServer,
  TiddlyWebClient,
  GitFace,
  registerTiddlywikiTools,
  registerRoutes,
  openInTwEditor,
  TRASH_PREFIX,
} from '../lib/index.js'

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures++
    console.error(`FAIL  ${name}\n      ${err && err.message ? err.message : err}`)
  }
}

const root = await mkdtemp(join(tmpdir(), 'dsh-tw-verify-audit-'))
const wikiDir = join(root, 'main')
console.log(`temp wiki root: ${root}`)

/** Minimal fake webserver face: capture exact/prefix handlers by path. */
function fakeWebServer() {
  const routes = new Map()
  return {
    routes,
    face: {
      register(route) {
        routes.set(`${route.kind}:${route.path}`, route.handler)
        return () => routes.delete(`${route.kind}:${route.path}`)
      },
    },
  }
}

/** Fake response recorder for route-handler calls. */
function recorder() {
  const state = { status: 0, headers: {}, body: '', ended: false }
  const res = {
    writeHead(status, headers) { state.status = status; Object.assign(state.headers, headers ?? {}) },
    end(chunk) { if (chunk !== undefined) state.body += String(chunk); state.ended = true },
    get headersSent() { return state.status !== 0 },
  }
  return { state, res }
}

function fakeReq({ method = 'GET', url = '/', body, headers = {} } = {}) {
  const listeners = new Map()
  return {
    method,
    url,
    headers,
    readableEnded: true,
    resume() {},
    destroy() {},
    on(event, fn) { listeners.set(event, fn); return this },
    emit(event, ...args) { listeners.get(event)?.(...args) },
  }
}

function parseJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

let server
try {
  server = new WikiServer({ wikiRoot: root, wiki: 'main', port: 0 })
  const view = await server.start()
  const api = new TiddlyWebClient(view.url)
  const git = new GitFace()

  // ── 工具层 ────────────────────────────────────────────────────────────────
  const tools = new Map()
  registerTiddlywikiTools(
    { tools: { register: (tool) => { tools.set(tool.name, tool); return () => {} } } },
    { wiki: () => api, git, wikiPath: () => wikiDir, autoCommit: () => {} },
  )
  const call = (name, args) => {
    const tool = tools.get(name)
    assert.ok(tool !== undefined, `工具 ${name} 未注册`)
    return tool.execute(args, undefined)
  }
  const fieldOf = (t, name) => (t === undefined ? undefined : (t[name] ?? t.fields?.[name]))

  // 1 ── attach 数据安全 ────────────────────────────────────────────────────
  await test('attach：同名笔记不得被静默覆盖（保留 tags/自定义字段/正文）', async () => {
    await api.put({ title: 'AttachClash', text: '人类写的正文', tags: ['human', 'keep-me'], q: 'q1', type: 'text/vnd.tiddlywiki' })
    const png = join(root, 'probe.png')
    await writeFile(png, Buffer.from('fake png bytes for attach probe 0123456789'))
    const before = await api.get('AttachClash')
    // 无令牌的同名覆盖必须被拒绝（旧实现直接覆盖）。
    await assert.rejects(
      () => call('tiddlywiki_attach', { title: 'AttachClash', path: png }),
      /已存在/,
      '同名已存在且未提供 force 时，attach 必须拒绝而不是覆盖',
    )
    // 并发令牌只证明「读过」，不等于「同意覆盖」——仍必须拒绝。
    await assert.rejects(
      () => call('tiddlywiki_attach', { title: 'AttachClash', path: png, expectedRevision: before.revision }),
      /已存在/,
      '并发令牌（expectedRevision）不应被当作覆盖许可',
    )
    const intact = await api.get('AttachClash')
    assert.equal(intact.text, '人类写的正文', '被拒绝后正文必须原样保留')
    assert.deepEqual(intact.tags, ['human', 'keep-me'], `tags 必须原样保留：${JSON.stringify(intact.tags)}`)
    assert.equal(fieldOf(intact, 'q'), 'q1', '自定义字段 q 必须原样保留')
    assert.equal(intact.type, 'text/vnd.tiddlywiki', `内容类型必须原样保留：${intact.type}`)
    // 显式 force 才允许覆盖，且仍保留基底字段。
    const forced = await call('tiddlywiki_attach', { title: 'AttachClash', path: png, force: true })
    assert.equal(forced.ok, true, `force 覆盖应成功：${JSON.stringify(forced)}`)
    const after = await api.get('AttachClash')
    assert.equal(after.type, 'image/png', `force 后类型应变为附件类型：${after.type}`)
    assert.ok((after.text ?? '').length > 0, 'force 后正文应是 base64 附件内容')
    assert.ok((after.tags ?? []).includes('keep-me'), `force 覆盖仍须保留原 tags：${JSON.stringify(after.tags)}`)
    assert.equal(fieldOf(after, 'q'), 'q1', 'force 覆盖仍须保留自定义字段 q')
  })

  await test('attach：新建附件补 agent-written 且不破坏同名判定', async () => {
    const png = join(root, 'fresh.png')
    await writeFile(png, Buffer.from('fresh png probe bytes 9876543210'))
    const r = await call('tiddlywiki_attach', { title: 'FreshAttach.png', path: png })
    assert.equal(r.ok, true, `新建附件应成功：${JSON.stringify(r)}`)
    const t = await api.get('FreshAttach.png')
    assert.equal(t.type, 'image/png', `附件类型应为 image/png：${t.type}`)
    assert.ok((t.tags ?? []).includes('agent-written'), `新建附件应补 agent-written：${JSON.stringify(t.tags)}`)
    assert.equal(fieldOf(t, 'attach-source'), png, '应记录 attach-source')
  })

  // 2 ── /edit 内容类型保留 ─────────────────────────────────────────────────
  await test('openInTwEditor：wikitext 笔记的草稿类型必须是 wikitext（不得降级成 markdown）', async () => {
    await api.put({ title: 'WikiEdit', text: "! 标题\n\n''粗体'' 与 [[链接]]", type: 'text/vnd.tiddlywiki', tags: ['human'] })
    const r = await openInTwEditor(api, 'WikiEdit', '', undefined, { defaultTags: ['inbox'] })
    const draft = await api.get(r.draftTitle)
    assert.ok(draft !== undefined, `草稿应存在：${r.draftTitle}`)
    assert.equal(draft.type, 'text/vnd.tiddlywiki', `草稿类型必须跟随原条目，实际 ${draft.type}（写死 markdown 会在 TW 保存草稿时把笔记降级）`)
    assert.equal(fieldOf(draft, 'draft.of'), 'WikiEdit', '草稿必须带 draft.of')
    const note = await api.get('WikiEdit')
    assert.equal(note.type, 'text/vnd.tiddlywiki', '原条目类型不得被 /edit 改动')
    assert.deepEqual(note.tags, ['human'], `原条目 tags 不得被 /edit 改动：${JSON.stringify(note.tags)}`)
  })

  await test('openInTwEditor：新笔记（无既有条目）草稿回落 text/markdown', async () => {
    const r = await openInTwEditor(api, 'BrandNewEdit', '', undefined, { defaultTags: ['inbox'] })
    const draft = await api.get(r.draftTitle)
    assert.equal(draft.type, 'text/markdown', `新笔记草稿应为 markdown，实际 ${draft.type}`)
  })

  // 2c ── 内容类型保留（v0.20.1）────────────────────────────────────────────
  // 旧实现把 `type` 当成「构造 PUT body 时跳过的字段」，于是 cleanTiddler() 丢掉
  // 既有条目的内容类型，finalTypeForWrite() 再补默认值：put 把 text/css 改成
  // text/markdown（CSS 被当 Markdown 渲染、样式静默失效），append 干脆不写 type
  // （TW 回落 text/vnd.tiddlywiki，磁盘上 .md+.meta 变 .tid，Markdown 全按 wikitext 解析）。
  await test('put：覆盖 text/css 条目不得重置内容类型', async () => {
    await api.put({ title: 'KeepCss', text: '.a { color: red; }', type: 'text/css', tags: ['$:/tags/Stylesheet'], q: 'keep' })
    const r = await call('tiddlywiki_put', { title: 'KeepCss', text: '.a { color: blue; }' })
    assert.equal(r.type, 'text/css', `回执类型应为 text/css，实际 ${r.type}`)
    assert.equal(r.typeChanged, undefined, `不该报类型变化：${JSON.stringify(r.typeChanged)}`)
    const t = await api.get('KeepCss')
    assert.equal(t.type, 'text/css', `类型必须保持 text/css，实际 ${t.type}（旧实现变成 text/markdown → 整篇 CSS 被当 Markdown 渲染）`)
    assert.deepEqual(t.tags, ['$:/tags/Stylesheet'], `tags 必须保留：${JSON.stringify(t.tags)}`)
    assert.equal(fieldOf(t, 'q'), 'keep', '自定义字段必须保留')
  })

  await test('put：覆盖 wikitext 笔记不得被默认成 markdown', async () => {
    await api.put({ title: 'KeepWiki', text: "! 标题\n\n''粗体''", type: 'text/vnd.tiddlywiki' })
    const r = await call('tiddlywiki_put', { title: 'KeepWiki', text: "!! 新标题\n\n''更粗''" })
    const t = await api.get('KeepWiki')
    assert.equal(t.type, 'text/vnd.tiddlywiki', `类型必须保持 wikitext，实际 ${t.type}`)
    assert.equal(r.typeDefaulted, undefined, '覆盖既有条目不属于「默认 markdown」场景')
    assert.equal(r.typeChanged, undefined, `类型没变就不该报变化：${JSON.stringify(r.typeChanged)}`)
  })

  await test('append：追加到 markdown 笔记不得把类型降级成 wikitext', async () => {
    await api.put({ title: 'KeepMd', text: '# 标题\n\n**粗体**', type: 'text/markdown', tags: ['human'], q: 'md' })
    const r = await call('tiddlywiki_append', { title: 'KeepMd', text: '追加的一行' })
    assert.equal(r.created, false, '应是追加而不是新建')
    const t = await api.get('KeepMd')
    assert.equal(t.type, 'text/markdown', `类型必须保持 text/markdown，实际 ${t.type}（旧实现在磁盘上把 .md + .meta 变成 .tid，## 与 ** 全按 wikitext 解析）`)
    assert.ok((t.text ?? '').includes('追加的一行'), '追加内容应写入正文')
    assert.deepEqual(t.tags, ['human'], `tags 必须保留：${JSON.stringify(t.tags)}`)
    assert.equal(fieldOf(t, 'q'), 'md', '自定义字段必须保留')
    assert.equal(r.typeChanged, undefined, `类型没变就不该报变化：${JSON.stringify(r.typeChanged)}`)
  })

  await test('append：新建条目仍默认 markdown 且补 agent-written', async () => {
    const r = await call('tiddlywiki_append', { title: 'AppendFresh', text: '第一条' })
    assert.equal(r.created, true, '条目不存在时应新建')
    assert.equal(r.typeDefaulted, true, '新建且未指定类型应标记 typeDefaulted')
    const t = await api.get('AppendFresh')
    assert.equal(t.type, 'text/markdown', `新建条目应默认 markdown，实际 ${t.type}`)
    assert.ok((t.tags ?? []).includes('agent-written'), `新建应补 agent-written：${JSON.stringify(t.tags)}`)
  })

  await test('append：fields.type 可显式改类型且回执报出变化', async () => {
    await api.put({ title: 'AppendType', text: '正文', type: 'text/vnd.tiddlywiki' })
    const r = await call('tiddlywiki_append', { title: 'AppendType', text: '追加', fields: { type: 'text/markdown' } })
    assert.deepEqual(r.typeChanged, { from: 'text/vnd.tiddlywiki', to: 'text/markdown' }, `回执必须报出类型变化：${JSON.stringify(r.typeChanged)}`)
    assert.equal((await api.get('AppendType')).type, 'text/markdown', 'fields.type 是改类型的正规入口')
  })

  await test('rename 与回收站恢复都不得丢掉内容类型', async () => {
    await api.put({ title: 'TypedRename', text: 'x', type: 'text/css' })
    await call('tiddlywiki_rename', { oldTitle: 'TypedRename', newTitle: 'TypedRenamed', updateRefs: false })
    assert.equal((await api.get('TypedRenamed')).type, 'text/css', 'rename 后类型必须保留')
    await api.put({ title: 'TypedTrash', text: 'y', type: 'text/css' })
    await call('tiddlywiki_delete', { title: 'TypedTrash' })
    await call('tiddlywiki_trash', { action: 'restore', title: 'TypedTrash' })
    assert.equal((await api.get('TypedTrash')).type, 'text/css', '回收站恢复后类型必须保留')
  })

  // 3 ── 回收站索引 ────────────────────────────────────────────────────────
  await test('delete：回收站索引损坏时必须中止，绝不重建为空索引', async () => {
    await api.put({ title: 'HumanTrashBase', text: 'base', tags: ['human'] })
    const first = await call('tiddlywiki_delete', { title: 'HumanTrashBase' })
    assert.equal(first.trashed, true, `首次软删除应成功：${JSON.stringify(first)}`)
    const indexBefore = await api.get('$:/dsh-tiddlywiki/trash-index')
    assert.ok(indexBefore !== undefined && JSON.parse(indexBefore.text).length === 1, `索引应有 1 条：${indexBefore?.text}`)
    // Corrupt the index, then try to trash another note.
    await api.put({ title: '$:/dsh-tiddlywiki/trash-index', text: '{ this is not json', type: 'application/json' })
    await api.put({ title: 'HumanTrashSecond', text: 'second', tags: ['human'] })
    await assert.rejects(
      () => call('tiddlywiki_delete', { title: 'HumanTrashSecond' }),
      /索引/,
      '索引损坏时 delete 必须显式失败（旧实现返回空索引后全量覆盖，之前的记录变成孤儿）',
    )
    const stillCorrupt = await api.get('$:/dsh-tiddlywiki/trash-index')
    assert.equal(stillCorrupt.text, '{ this is not json', '失败路径不得改写索引')
    // trash list 同样不得把损坏索引当「空回收站」。
    await assert.rejects(() => call('tiddlywiki_trash', { action: 'list' }), /索引/, 'trash list 遇到损坏索引必须报错')
    // Restore a valid index so the following tests exercise the normal path.
    await api.put({ title: '$:/dsh-tiddlywiki/trash-index', text: JSON.stringify([{ trash: `${TRASH_PREFIX}2026-01-01T00-00-00-000Z/HumanTrashBase`, of: 'HumanTrashBase', at: '2026-01-01T00:00:00.000Z' }]), type: 'application/json' })
  })

  await test('delete：回收站索引读失败（stub 抛错）时必须中止，不得写成空索引', async () => {
    await api.put({ title: 'IndexReadFailProbe', text: 'probe', tags: ['human'] })
    const realIndex = await api.get('$:/dsh-tiddlywiki/trash-index')
    const flaky = {
      get: async (t) => {
        if (t === '$:/dsh-tiddlywiki/trash-index') throw new Error('simulated transient read failure')
        return api.get(t)
      },
      put: (t) => api.put(t),
      list: (f, inc) => api.list(f, inc),
      render: (b) => api.render(b),
      delete: (t) => api.delete(t),
    }
    const localTools = new Map()
    registerTiddlywikiTools(
      { tools: { register: (tool) => { localTools.set(tool.name, tool); return () => {} } } },
      { wiki: () => flaky, git, wikiPath: () => wikiDir, autoCommit: () => {} },
    )
    await assert.rejects(
      () => localTools.get('tiddlywiki_delete').execute({ title: 'IndexReadFailProbe' }, undefined),
      /索引/,
      '索引读失败时 delete 必须中止（旧实现把它当空索引并全量覆盖）',
    )
    const after = await api.get('$:/dsh-tiddlywiki/trash-index')
    assert.equal(after.text, realIndex.text, '读失败路径不得改写索引内容')
  })

  // 4 ── delete 乐观并发 ───────────────────────────────────────────────────
  await test('delete：读后被改动（expectedRevision 不匹配）必须拒绝删除', async () => {
    await api.put({ title: 'ConcurrentDelete', text: 'v1', tags: ['human'] })
    const before = await api.get('ConcurrentDelete')
    const rev = before.revision
    assert.ok(rev !== undefined, '（前置条件）GET 应返回 revision')
    // 模拟「读之后人类在 TW 里改了」：直接写一次新内容。
    await api.put({ title: 'ConcurrentDelete', text: 'v2 人类改动', tags: ['human'] })
    await assert.rejects(
      () => call('tiddlywiki_delete', { title: 'ConcurrentDelete', expectedRevision: rev }),
      /写入冲突|已被改动/,
      'revision 已变化时必须拒绝删除',
    )
    assert.ok((await api.get('ConcurrentDelete')) !== undefined, '被拒绝后条目必须还在')
    // 重新读取后用新令牌删除 → 成功。
    const now = await api.get('ConcurrentDelete')
    const ok = await call('tiddlywiki_delete', { title: 'ConcurrentDelete', expectedRevision: now.revision })
    assert.equal(ok.trashed, true, `用最新令牌应能删除：${JSON.stringify(ok)}`)
    // v0.19.5: the index is read BEFORE the tiddler is trashed, so a delete that
    // reports success (trashed:true) must actually have recorded the entry —
    // otherwise the note is unreachable even though the tool said it worked.
    const index = await api.get('$:/dsh-tiddlywiki/trash-index')
    const entries = JSON.parse(index.text)
    assert.ok(entries.some((e) => e.of === 'ConcurrentDelete'), `索引必须记录本次删除：${index.text.slice(0, 300)}`)
    assert.ok((await api.get(ok.trashTitle)) !== undefined, `回收站条目应可读：${ok.trashTitle}`)
  })

  // 5 ── rename 部分失败上报 ───────────────────────────────────────────────
  await test('rename：新标题已写入而旧标题删除失败时必须回报两份副本', async () => {
    // 用一个「读得到、删不掉」的客户端包装：delete(oldTitle) 抛错。
    await api.put({ title: 'RenamePartialOld', text: 'payload', tags: ['rename-probe'] })
    const failing = {
      get: (t) => api.get(t),
      put: (t) => api.put(t),
      list: (f, inc) => api.list(f, inc),
      render: (b) => api.render(b),
      delete: async (t) => {
        if (t === 'RenamePartialOld') throw new Error('simulated delete failure')
        return api.delete(t)
      },
    }
    const localTools = new Map()
    const localDeps = { wiki: () => failing, git, wikiPath: () => wikiDir, autoCommit: () => {} }
    registerTiddlywikiTools({ tools: { register: (tool) => { localTools.set(tool.name, tool); return () => {} } } }, localDeps)
    const r = await localTools.get('tiddlywiki_rename').execute({ oldTitle: 'RenamePartialOld', newTitle: 'RenamePartialNew', updateRefs: false }, undefined)
    assert.equal(r.ok, true, `rename 主流程应成功：${JSON.stringify(r)}`)
    assert.ok(typeof r.warning === 'string' && r.warning.includes('删除失败') && r.warning.includes('RenamePartialOld'), `必须回报旧标题未删除：${JSON.stringify(r.warning)}`)
    assert.ok((await api.get('RenamePartialNew')) !== undefined, '新标题应已写入')
    assert.ok((await api.get('RenamePartialOld')) !== undefined, '旧标题仍在（这正是要如实汇报的状态）')
  })

  // 6 ── 会话汇总的未探测条目 ───────────────────────────────────────────────
  await test('session summary：超出探测上限的条目标「未探测」，不得谎报「已删除」', async () => {
    // 320 real tiddlers + 80 never-written titles, 400 «produced» events total.
    // The newest 320 are probed (≤ MAX_ENRICH_TITLES=300 of them exist) and the
    // oldest 80 fall past the probing budget → they must read「未探测」, while a
    // probed-but-missing title must still read「⚠️ 已删除/不存在」.
    const REAL = 320
    const TOTAL = 400
    const realItems = []
    for (let i = 0; i < REAL; i++) realItems.push({ title: `SumReal-${String(i).padStart(3, '0')}`, text: 'summary probe' })
    const seeded = await call('tiddlywiki_batch_put', { items: realItems })
    assert.equal(seeded.failed, 0, `（前置条件）应写入 ${REAL} 条真实条目：${JSON.stringify(seeded.items.filter((x) => x.failed).slice(0, 3))}`)
    const titles = []
    for (let i = 0; i < TOTAL; i++) titles.push(i < TOTAL - 80 ? `SumReal-${String(i).padStart(3, '0')}` : `SumGone-${String(i).padStart(3, '0')}`)
    const { routes, face } = fakeWebServer()
    registerRoutes({ webServer: face }, {
      server,
      getClient: () => api,
      git,
      autoCommit: () => {},
      noteDefaults: () => ({ tag: 'inbox' }),
      uiDefaults: () => ({
        showQuickNote: true, showQuickNoteDock: true, quickNoteMode: 'native', sidebarLabel: 'TiddlyWiki',
        showPanelStatus: true, showSyncButton: true, followDshTheme: true, darkPalette: '$:/palettes/CupertinoDark',
        tabLabel: '知识库', showSessionTab: true, showRightbarTab: true,
      }),
      getWikiPath: () => wikiDir,
      getSessionController: () => undefined,
      getWorkspaceRegistry: () => undefined,
      getAgentPresets: () => undefined,
      getSessionPersistence: () => undefined,
      getPermissionPresets: () => undefined,
      getSessions: () => undefined,
      getSessionQuery: () => ({
        readSession: async () => {
          const events = []
          for (let i = 0; i < titles.length; i++) {
            events.push({
              type: 'tool/call',
              seq: i,
              // Older index = older timestamp: titles[TOTAL-1] is the newest.
              time: 1_700_000_000_000 + i,
              data: { name: 'tiddlywiki_put', arguments: JSON.stringify({ title: titles[i], text: 'x' }) },
            })
          }
          return { session: { id: 'audit-session' }, events }
        },
        traceSession: async () => ({ descendants: [] }),
      }),
      sendToAgentEnabled: () => true,
      sendToAgentToken: () => '',
    })
    const handler = routes.get('exact:/dsh-tiddlywiki/session/summary')
    assert.ok(handler !== undefined, 'session/summary 路由未注册')
    const { state, res } = recorder()
    const req = fakeReq({ method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } })
    const body = JSON.stringify({ session: 'audit-session' })
    const out = new Promise((resolveP) => { const origEnd = res.end.bind(res); res.end = (c) => { origEnd(c); resolveP() } })
    handler(req, res)
    req.readableEnded = false
    req.emit('data', Buffer.from(body, 'utf8'))
    req.emit('end')
    await out
    const payload = parseJson(state.body)
    assert.ok(payload !== null && payload.ok === true, `summary 应生成成功：${state.body.slice(0, 300)}`)
    const summary = await api.get(payload.title)
    assert.ok(summary !== undefined, `汇总 tiddler 应存在：${payload.title}`)
    const lines = summary.text.split('\n')
    const unprobed = lines.filter((l) => l.includes('未探测'))
    const reportedDeleted = lines.filter((l) => l.includes('已删除/不存在'))
    assert.ok(unprobed.length > 0, `必须有「未探测」标记（400 条事件不可能全部探测完）：${summary.text.slice(0, 400)}`)
    // The unprobed ones are the OLDEST titles: SumReal-000… (written) and SumGone-000…
    assert.ok(unprobed.some((l) => l.includes('SumReal-000')), `最旧的已有条目应落在未探测区：${unprobed.slice(0, 3).join(' | ')}`)
    assert.ok(!reportedDeleted.some((l) => l.includes('SumReal-')), `真实存在的条目绝不能被标成已删除：${reportedDeleted.filter((l) => l.includes('SumReal-')).slice(0, 3).join(' | ')}`)
    assert.ok(reportedDeleted.length > 0 && reportedDeleted.every((l) => l.includes('SumGone-')), `只有真的不存在的标题能标已删除：${reportedDeleted.slice(0, 3).join(' | ')}`)
  })

  // 7 ── batch_put 并发后顺序与容错不变 ─────────────────────────────────────
  await test('batch_put：并发实现仍保持入参顺序与逐条容错', async () => {
    const items = []
    for (let i = 0; i < 60; i++) items.push({ title: `Conc-${String(i).padStart(2, '0')}`, text: `conc ${i}` })
    items.push({ title: '', text: 'no title' })
    items.push({ title: 'Conc-NoText' })
    const r = await call('tiddlywiki_batch_put', { items })
    assert.equal(r.items.length, items.length, `逐条结果数应等于入参数：${r.items.length}`)
    assert.equal(r.written, 60, `应写入 60 条，实际 ${r.written}`)
    assert.equal(r.failed, 2, `应有 2 条失败，实际 ${r.failed}`)
    for (let i = 0; i < 60; i++) {
      assert.equal(r.items[i].title, items[i].title, `第 ${i} 条结果必须对应入参顺序（并发不得打乱）：实际 ${r.items[i].title}`)
      assert.equal(r.items[i].written, true, `第 ${i} 条应写入`)
    }
    assert.equal(r.items[60].title, '(无标题)', `缺 title 的条目应如实回报：${JSON.stringify(r.items[60])}`)
    assert.ok(String(r.items[60].error).includes('title'), '缺 title 的失败原因应说明缺 title')
    assert.equal(r.items[61].title, 'Conc-NoText', '缺 text 的条目应回报原标题')
    assert.ok(r.items[61].failed === true, '缺 text 的条目应标记 failed')
    assert.equal(await api.get('Conc-00').then((t) => t.text), 'conc 0', '并发写入的条目内容应正确')
  })
} catch (err) {
  failures++
  console.error('FAIL  审计回归框架异常')
  console.error(err)
} finally {
  await server?.stop().catch(() => {})
  await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(failures === 0 ? '\nAUDIT FIX CHECKS OK' : `\nAUDIT FIX CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

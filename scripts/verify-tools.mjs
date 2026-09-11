#!/usr/bin/env node
/**
 * `tiddlywiki_*` 工具层断言（真实 TW 子进程 + 真实 git 仓库）。覆盖 v0.18.0 的
 * 10 个核心工具（新增工具不会让本脚本误报 —— 工具集只做子集断言）：
 *
 * 通过对 `registerTiddlywikiTools(ctx, deps)` 捕获注册对象、再逐个
 * `tool.execute(args, undefined)` 的**函数式**调用，覆盖工具层的契约（不是 HTTP
 * 层、也不是 TW 自身行为）：
 *   - put：fields 不得覆盖 title/text/tags/created/modified；fields.type 是合法
 *     的内容类型覆盖；新建自动补 agent-written；覆盖已存在的人类笔记不补；
 *     `$:/` 条目豁免 agent-written 与 markdown 默认；空 title 明确报错。
 *   - batch_put：空 title / 缺 text 的单条失败不影响其余（返回 failed 计数与逐条
 *     error）；overwrite:false 跳过已存在。
 *   - search / recent / list_tags：二进制 tiddler（type: image/png + base64 正文）
 *     不出现在结果里（含标题命中）；limit 上限被 clamp 到 200；since 过滤生效。
 *   - delete 幂等；rename 更新 `[[旧标题]]` / `{{旧标题}}` 引用；
 *     git_sync push 无 remote 必须 ok:false；git_resolve 空 files 必须显式失败。
 *
 * 需要先 `npm run build`（import lib/index.js），会 spawn 真实 TW（约 20-60s）。
 *
 *   node scripts/verify-tools.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-tools
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WikiServer,
  TiddlyWebClient,
  GitFace,
  registerTiddlywikiTools,
  TEXT_LIST_FILTER,
} from '../lib/index.js'

/** 新建条目自动补打的约定标签（tools.ts 导出，这里用字面量）。 */
const AGENT_TAG = 'agent-written'

/**
 * 全量工具集（v0.19.1 起 15 个，与 src/host/tools.ts 的注册表 / 提示词清单一一对应）。
 * 这里断言「一个都不能少」——v0.19.0 新增的 5 个工具（append/trash/backlinks/
 * attach/lint）当时只在 selftest 里各点了一下，工具层守门仍停在 10 个。
 */
const CORE_TOOL_NAMES = [
  'tiddlywiki_search', 'tiddlywiki_get', 'tiddlywiki_put', 'tiddlywiki_batch_put',
  'tiddlywiki_append', 'tiddlywiki_rename', 'tiddlywiki_delete', 'tiddlywiki_trash',
  'tiddlywiki_backlinks', 'tiddlywiki_attach', 'tiddlywiki_lint',
  'tiddlywiki_recent', 'tiddlywiki_list_tags', 'tiddlywiki_git_sync', 'tiddlywiki_git_resolve',
]

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

const root = await mkdtemp(join(tmpdir(), 'dsh-tw-verify-tools-'))
const wikiDir = join(root, 'main')
console.log(`temp wiki root: ${root}`)

let server
try {
  server = new WikiServer({ wikiRoot: root, wiki: 'main', port: 0 })
  const view = await server.start()
  const api = new TiddlyWebClient(view.url)
  const git = new GitFace()
  await git.init(wikiDir, 'main')
  await git.initialCommit(wikiDir)

  const tools = new Map()
  registerTiddlywikiTools(
    { tools: { register: (tool) => { tools.set(tool.name, tool); return () => {} } } },
    { wiki: () => api, git, wikiPath: () => wikiDir, noteTag: () => 'inbox', autoCommit: () => {} },
  )
  const call = (name, args) => {
    const tool = tools.get(name)
    assert.ok(tool !== undefined, `工具 ${name} 未注册`)
    return tool.execute(args, undefined)
  }
  /** 非标准字段在单条 GET 里被 TW 折进 `fields`（knownFields 之外），两处都要看。 */
  const fieldOf = (tiddler, name) => (tiddler === undefined ? undefined : (tiddler[name] ?? tiddler.fields?.[name]))

  // ── 工具集齐 ──────────────────────────────────────────────────────────────
  await test('registerTiddlywikiTools 注册了全部核心工具', () => {
    const missing = CORE_TOOL_NAMES.filter((n) => !tools.has(n))
    assert.deepEqual(missing, [], `以下核心工具未注册：${missing.join(', ')}（已注册：${[...tools.keys()].join(', ')}）`)
    console.log(`      （已注册 ${tools.size} 个：${[...tools.keys()].join(', ')}）`)
  })

  // ── put ──────────────────────────────────────────────────────────────────
  await test('put：新建自动补 agent-written + 默认 text/markdown', async () => {
    const r = await call('tiddlywiki_put', { title: 'ToolsNew', text: '# 标题\n\n正文' })
    assert.equal(r.ok, true, `put 应成功：${JSON.stringify(r)}`)
    assert.equal(r.type, 'text/markdown', `未指定内容类型应默认 markdown，实际 ${JSON.stringify(r.type)}`)
    assert.equal(r.typeDefaulted, true, '未指定 type 时应带 typeDefaulted 标记')
    assert.ok(r.tags.includes(AGENT_TAG), `新建应自动补 ${AGENT_TAG}，实际 ${JSON.stringify(r.tags)}`)
    const t = await api.get('ToolsNew')
    assert.equal(t.type, 'text/markdown', '落库的类型应为 text/markdown')
    assert.deepEqual(t.tags, [AGENT_TAG], `落库标签应为 [${AGENT_TAG}]，实际 ${JSON.stringify(t.tags)}`)
  })

  await test('put：fields 不得覆盖 title/text/tags/created/modified，自定义字段照写', async () => {
    const r = await call('tiddlywiki_put', {
      title: 'ToolsFields',
      text: '真实正文',
      tags: ['real-tag'],
      fields: {
        title: 'HACKED',
        text: 'HACKED',
        tags: ['hacked'],
        created: '1999-01-01T00:00:00.000Z',
        modified: '1999-01-01T00:00:00.000Z',
        custom: 'ok',
      },
    })
    assert.equal(r.ok, true)
    const t = await api.get('ToolsFields')
    assert.equal(t.title, 'ToolsFields', 'fields.title 不得改写标题')
    assert.equal(t.text, '真实正文', 'fields.text 不得覆盖 text 参数')
    assert.ok((t.tags ?? []).includes('real-tag') && !(t.tags ?? []).includes('hacked'), `fields.tags 不得覆盖 tags 参数（实际 ${JSON.stringify(t.tags)}）`)
    assert.equal(fieldOf(t, 'custom'), 'ok', `非保留字段应照常写入（实际 ${JSON.stringify({ custom: t.custom, fields: t.fields })}）`)
    assert.notEqual(t.created, '1999-01-01T00:00:00.000Z', 'fields.created 不得覆盖 created')
    assert.notEqual(t.modified, '1999-01-01T00:00:00.000Z', 'fields.modified 不得覆盖 modified')
    assert.equal(await api.get('HACKED'), undefined, '不得因为 fields.title 而写到别的标题下')
  })

  await test('put：fields.type 是合法的内容类型覆盖（不补 markdown 默认）', async () => {
    const r = await call('tiddlywiki_put', { title: 'ToolsWikitext', text: "''粗体''", fields: { type: 'text/vnd.tiddlywiki' } })
    assert.equal(r.type, 'text/vnd.tiddlywiki', `fields.type 应生效，实际 ${JSON.stringify(r.type)}`)
    assert.notEqual(r.typeDefaulted, true, '显式 type 不应被标记为 defaulted')
    assert.equal((await api.get('ToolsWikitext')).type, 'text/vnd.tiddlywiki', '落库类型应为显式指定的 text/vnd.tiddlywiki')
  })

  await test('put：覆盖已存在的人类笔记不补 agent-written', async () => {
    await api.put({ title: 'HumanNote', text: 'human body', tags: ['human'] })
    const first = await call('tiddlywiki_put', { title: 'HumanNote', text: 'human body 2', tags: ['human'] })
    assert.equal(first.ok, true)
    assert.deepEqual(first.tags, ['human'], `覆盖人类笔记不得补 ${AGENT_TAG}，实际 ${JSON.stringify(first.tags)}`)
    const second = await call('tiddlywiki_put', { title: 'HumanNote', text: 'human body 3' })
    assert.ok(!second.tags.includes(AGENT_TAG), '再次覆盖（tags 为空）仍不得补 agent-written')
    const t = await api.get('HumanNote')
    assert.ok(!(t.tags ?? []).includes(AGENT_TAG), `落库后不得出现 ${AGENT_TAG}：${JSON.stringify(t.tags)}`)
  })

  await test('put：$:/ 系统条目豁免 agent-written 与 markdown 默认', async () => {
    const r = await call('tiddlywiki_put', { title: '$:/ToolsTest/Config', text: 'yes' })
    assert.equal(r.ok, true, `$:/ 条目写入应成功：${JSON.stringify(r)}`)
    assert.deepEqual(r.tags, [], '$:/ 条目不得补 agent-written')
    assert.notEqual(r.type, 'text/markdown', '$:/ 条目不得被默认成 markdown')
    const t = await api.get('$:/ToolsTest/Config')
    assert.ok(!(t.tags ?? []).includes(AGENT_TAG), '$:/ 条目落库后不得有 agent-written')
    assert.notEqual(t.type, 'text/markdown', '$:/ 条目落库类型不得是 text/markdown')
  })

  await test('put：空 title 明确报错', async () => {
    await assert.rejects(() => call('tiddlywiki_put', { title: '   ', text: 'x' }), /title 不能为空/, '空 title 应抛出明确错误')
  })

  // ── batch_put ────────────────────────────────────────────────────────────
  await test('batch_put：单条失败不影响其余，返回 failed 计数与逐条 error', async () => {
    let r
    try {
      r = await call('tiddlywiki_batch_put', {
        items: [
          { title: 'BT-1', text: 'batch one' },
          { title: '', text: 'no title' },
          { title: 'BT-NoText' },
          { title: 'BT-2', text: 'batch two' },
        ],
      })
    } catch (err) {
      assert.fail(`batch_put 不得整批拒绝：items[2] 缺 text 应落到逐条 error（现在 defineTool 把 items[].text 声明为 required，参数预校验在进入逐条 try/catch 之前就整批抛错：${err && err.message}）`)
    }
    assert.equal(r.items.length, 4, `应返回 4 条逐条结果，实际 ${r.items.length}`)
    assert.equal(r.written, 2, `成功条数应为 2，实际 ${r.written}`)
    assert.equal(r.failed, 2, `失败条数应为 2，实际 ${r.failed}`)
    assert.equal(r.skipped, 0, `跳过条数应为 0，实际 ${r.skipped}`)
    assert.equal(r.ok, false, '有失败条目时 ok 应为 false')
    const bad = r.items.filter((i) => i.failed)
    assert.equal(bad.length, 2, '应有 2 条 failed:true')
    assert.ok(bad.every((i) => typeof i.error === 'string' && i.error.length > 0), `失败条目必须带可读 error：${JSON.stringify(bad)}`)
    assert.ok(String(r.items[1].error).includes('title'), `空 title 的逐条 error 应说明缺 title，实际 ${JSON.stringify(r.items[1].error)}`)
    assert.equal((await api.get('BT-1')).text, 'batch one', '合法条目仍应写入（单条失败不影响其余）')
    assert.equal((await api.get('BT-2')).text, 'batch two', '合法条目仍应写入')
    assert.equal(await api.get('BT-NoText'), undefined, '缺 text 的条目不得写入')
  })

  await test('batch_put：overwrite:false 跳过已存在，其余照写（新建仍补 agent-written）', async () => {
    // 不依赖上一条用例：显式保证 BT-1 存在，这样本用例失败与否只反映 overwrite 语义。
    await api.put({ title: 'BT-1', text: 'batch one', tags: ['batch-probe'] })
    const r = await call('tiddlywiki_batch_put', {
      overwrite: false,
      items: [
        { title: 'BT-1', text: 'should not overwrite' },
        { title: 'BT-3', text: 'brand new' },
      ],
    })
    assert.equal(r.skipped, 1, `应跳过 1 条，实际 ${r.skipped}（written=${r.written} failed=${r.failed}）`)
    assert.equal(r.written, 1, `应写入 1 条，实际 ${r.written}`)
    assert.equal(r.failed, 0, `不应有失败：${JSON.stringify(r.items)}`)
    assert.equal((await api.get('BT-1')).text, 'batch one', 'overwrite:false 不得覆盖已存在条目')
    const t3 = await api.get('BT-3')
    assert.equal(t3.text, 'brand new', '缺失条目应写入')
    assert.ok((t3.tags ?? []).includes(AGENT_TAG), `batch_put 新建同样应补 ${AGENT_TAG}`)
  })

  // ── 二进制 tiddler 排除 ───────────────────────────────────────────────────
  const BIN_TITLE = 'BinaryProbe.png'
  const BIN_B64 = Buffer.from('fake png payload binaryprobe 0123456789 abcdefghij').toString('base64')

  await test('search：二进制 tiddler 不出现在结果里（标题命中也不行）', async () => {
    await api.put({ title: BIN_TITLE, text: BIN_B64, type: 'image/png', tags: ['binary-only-tag'] })
    const byTitle = await call('tiddlywiki_search', { query: 'BinaryProbe' })
    assert.equal(byTitle.total, 0, '标题命中也必须排除二进制（防同名书页图刷屏）')
    assert.equal(byTitle.results.length, 0, '二进制不得出现在 results 里')
    const byBody = await call('tiddlywiki_search', { query: BIN_B64.slice(0, 24) })
    assert.equal(byBody.total, 0, 'base64 正文不得参与检索')
    const hit = await call('tiddlywiki_search', { query: '真实正文' })
    assert.ok(hit.results.some((x) => x.title === 'ToolsFields'), '文本 tiddler 仍应能被检索到')
  })

  await test('recent：二进制 tiddler 不出现在最近列表（刚写入也不行）', async () => {
    const r = await call('tiddlywiki_recent', { limit: 50 })
    assert.ok(!r.results.some((x) => x.title === BIN_TITLE), `二进制附件不得出现在 recent：${JSON.stringify(r.results.map((x) => x.title))}`)
    assert.ok(r.results.length > 0, 'recent 仍应返回文本笔记')
  })

  await test('list_tags：只挂在二进制附件上的标签不得被统计', async () => {
    const r = await call('tiddlywiki_list_tags', {})
    assert.ok(Array.isArray(r.tags) && r.tags.length > 0, `应返回标签列表：${JSON.stringify(r)}`)
    assert.ok(!r.tags.some((x) => x.tag === 'binary-only-tag'), 'binary-only-tag 只挂在 image/png 附件上，不应出现在标签统计里（listTags 走的是未过滤的精简列表）')
    assert.ok(r.tags.some((x) => x.tag === 'human'), '文本笔记的标签仍应被统计')
  })

  // ── get：自定义字段必须摊平（v0.19.1） ───────────────────────────────────
  await test('get：单条 GET 的嵌套 fields 被摊平给模型（不再 fields=[object Object]）', async () => {
    await api.put({ title: 'FlattenProbe', text: 'x', type: 'text/markdown', tags: ['human'], q: 'q1', due: '2026-12-31' })
    const r = await call('tiddlywiki_get', { title: 'FlattenProbe' })
    assert.equal(r.fields.q, 'q1', `自定义字段 q 应直接可见：${JSON.stringify(r.fields)}`)
    assert.equal(r.fields.due, '2026-12-31', `自定义字段 due 应直接可见：${JSON.stringify(r.fields)}`)
    assert.equal(r.fields.fields, undefined, '不得把嵌套的 fields 对象原样塞给模型')
    assert.equal(r.fields.bag, undefined, '传输字段 bag 不该出现在结果里')
  })

  // ── lint：死链与缺 type（v0.19.1 修的两个坏检查） ────────────────────────
  await test('lint：指向二进制附件的 [[链接]] 不得误报死链', async () => {
    await api.put({ title: 'LinkProbe', text: `见 [[${BIN_TITLE}]] 和 [[真正不存在的条目XYZ]]`, type: 'text/markdown', tags: ['human'] })
    const r = await call('tiddlywiki_lint', { checks: ['broken-links'], limit: 20 })
    const issue = r.issues.find((i) => i.kind === 'broken-links')
    assert.ok(issue !== undefined, `应报出真正的死链：${JSON.stringify(r.issues)}`)
    const joined = issue.samples.join('\n')
    assert.ok(!joined.includes(BIN_TITLE), `二进制附件的标题不该被当成死链：${joined}`)
    assert.ok(joined.includes('真正不存在的条目XYZ'), `真正缺失的标题应该被报出来：${joined}`)
  })

  await test('lint：真正没有 type 字段的 Markdown 笔记会被报出来', async () => {
    // 绕过工具直接 PUT，得到一个**没有 type 字段**的条目——TW 服务端在 listing
    // 里会替它补 text/vnd.tiddlywiki，所以只能靠 [!has[type]] 过滤器识别。
    await api.put({ title: 'TypelessProbe', text: '# 标题\n\n- 列表项\n' })
    const stored = await api.get('TypelessProbe')
    assert.equal(stored.type, 'text/vnd.tiddlywiki', '（前置条件）GET 会把缺省的 type 补成 wikitext')
    const r = await call('tiddlywiki_lint', { checks: ['missing-type'], limit: 20 })
    const issue = r.issues.find((i) => i.kind === 'missing-type')
    assert.ok(issue !== undefined, `应报出缺 type 的笔记：${JSON.stringify(r.issues)}`)
    assert.ok(issue.samples.some((s) => s.includes('TypelessProbe')), `样本里应有 TypelessProbe：${JSON.stringify(issue.samples)}`)
  })

  // ── limit clamp ──────────────────────────────────────────────────────────
  const CLAMP_COUNT = 205
  await test(`search/recent：limit 上限被 clamp 到 200（写 ${CLAMP_COUNT} 条探针）`, async () => {
    const items = Array.from({ length: CLAMP_COUNT }, (_, i) => ({
      title: `ClampProbe-${String(i).padStart(3, '0')}`,
      text: 'clamp probe payload',
      tags: ['clamp-probe'],
    }))
    const w = await call('tiddlywiki_batch_put', { items })
    assert.equal(w.failed, 0, `批量写探针失败：${JSON.stringify(w.items.filter((i) => i.failed).slice(0, 3))}`)
    assert.equal(w.written, CLAMP_COUNT, `应写入 ${CLAMP_COUNT} 条，实际 ${w.written}`)
    const rec = await call('tiddlywiki_recent', { limit: 9999 })
    assert.equal(rec.results.length, 200, `recent 的 limit 上限应为 200，实际 ${rec.results.length}`)
    const s = await call('tiddlywiki_search', { query: 'clamp probe payload', limit: 9999 })
    assert.ok(s.total >= CLAMP_COUNT, `探针应全部命中：total=${s.total}`)
    assert.ok(s.results.length <= 200, `search 的 limit 上限应为 200（工具描述承诺「最大 200」），实际返回 ${s.results.length} 条`)
    const s5 = await call('tiddlywiki_search', { query: 'clamp probe payload', limit: 5 })
    assert.equal(s5.results.length, 5, `limit:5 应生效，实际返回 ${s5.results.length} 条`)
  })

  // ── since ────────────────────────────────────────────────────────────────
  await test('search/recent：since 过滤生效（未来时间排除、过去时间保留）', async () => {
    // REST 写入的 tiddler 默认不带 modified，而 since 依赖它 —— 探针显式写入时间戳。
    // ⚠️ TW 会把 modified 存成 Date 并回吐**紧凑格式** `YYYYMMDDHHmmssSSS`
    // （实测 `2099-01-01T00:00:00.000Z` → `20990101000000000`），所以 since 的实现
    // 必须同时认 TW 紧凑格式与 ISO，否则 `new Date(t.modified)` = Invalid Date，
    // 任何带 since 的调用都会返回空。
    await api.put({ title: 'SinceProbeOld', text: 'since probe old', tags: ['since-probe'], modified: '2000-01-01T00:00:00.000Z' })
    await api.put({ title: 'SinceProbeNew', text: 'since probe new', tags: ['since-probe'], modified: '2099-01-01T00:00:00.000Z' })
    const rawModified = (await api.get('SinceProbeNew'))?.modified
    const future = await call('tiddlywiki_search', { query: 'since probe', since: '2099-06-01T00:00:00Z' })
    assert.equal(future.total, 0, `since 在未来时应无命中，实际 ${future.total}`)
    const past = await call('tiddlywiki_search', { query: 'since probe', tag: 'since-probe', since: '2020-01-01T00:00:00Z' })
    assert.deepEqual(
      past.results.map((x) => x.title),
      ['SinceProbeNew'],
      `since=2020 应只保留 modified 不早于该时刻的条目（实际 ${JSON.stringify(past.results.map((x) => x.title))}）——注：TW 返回的 modified 是紧凑格式（本次实测 ${JSON.stringify(rawModified)}），用 new Date() 会得到 Invalid Date 并把所有条目排除`,
    )
    const recFuture = await call('tiddlywiki_recent', { limit: 50, since: '2099-06-01T00:00:00Z' })
    assert.equal(recFuture.results.length, 0, `recent 的 since 过滤应生效，实际 ${recFuture.results.length} 条`)
    const recPast = await call('tiddlywiki_recent', { limit: 50, since: '2020-01-01T00:00:00Z' })
    assert.ok(recPast.results.some((x) => x.title === 'SinceProbeNew'), 'recent 的 since=2020 应保留未来的那条探针')
  })

  // ── delete / rename ──────────────────────────────────────────────────────
  await test('delete：幂等（重复删除与删除不存在都不报错）', async () => {
    const d1 = await call('tiddlywiki_delete', { title: 'ToolsNew' })
    assert.equal(d1.ok, true, `首次删除应成功：${JSON.stringify(d1)}`)
    assert.equal(await api.get('ToolsNew'), undefined, '删除后应读不到')
    const d2 = await call('tiddlywiki_delete', { title: 'ToolsNew' })
    assert.equal(d2.ok, true, '重复删除必须是幂等空操作')
    const d3 = await call('tiddlywiki_delete', { title: 'NeverExisted-xyz' })
    assert.equal(d3.ok, true, '删除不存在的 tiddler 必须是幂等空操作')
  })

  await test('rename：更新 [[旧标题]] / {{旧标题}} / [[显示名|旧标题]] 引用', async () => {
    await api.put({ title: 'ToolsOld', text: 'rename payload', tags: ['rename-probe'] })
    await api.put({ title: 'ToolsRefHolder', text: 'see [[ToolsOld]] and {{ToolsOld}} and [[显示名|ToolsOld]] here', tags: [] })
    const r = await call('tiddlywiki_rename', { oldTitle: 'ToolsOld', newTitle: 'ToolsRenamed' })
    assert.equal(r.ok, true, `rename 应成功：${JSON.stringify(r)}`)
    assert.equal(r.to, 'ToolsRenamed')
    assert.ok(r.refsTiddlers >= 1 && r.refsUpdated >= 3, `应更新 3 处引用（实际 tiddlers=${r.refsTiddlers} hits=${r.refsUpdated}）`)
    assert.equal(await api.get('ToolsOld'), undefined, '旧标题应被删除')
    assert.equal((await api.get('ToolsRenamed')).text, 'rename payload', '新标题应保留正文')
    const ref = await api.get('ToolsRefHolder')
    assert.ok(ref.text.includes('[[ToolsRenamed]]'), `[[旧标题]] 未迁移：${ref.text}`)
    assert.ok(ref.text.includes('{{ToolsRenamed}}'), `{{旧标题}} 未迁移：${ref.text}`)
    assert.ok(ref.text.includes('[[显示名|ToolsRenamed]]'), `[[显示名|旧标题]] 未迁移：${ref.text}`)
    const noop = await call('tiddlywiki_rename', { oldTitle: 'ToolsRenamed', newTitle: 'ToolsRenamed' })
    assert.equal(noop.ok, true, '同名 rename 应是安全 no-op')
    assert.ok((await api.get('ToolsRenamed')) !== undefined, '同名 rename 不得删掉条目')
  })

  // ── git 工具 ─────────────────────────────────────────────────────────────
  await test('git_sync：未配置 remote 时 push 必须 ok:false', async () => {
    const r = await call('tiddlywiki_git_sync', { action: 'push' })
    assert.equal(r.ok, false, `无 remote 时 push 不得报成功：${JSON.stringify(r)}`)
    assert.ok(typeof r.message === 'string' && r.message.length > 0, '失败必须带原因 message')
    assert.equal(r.action, 'push')
  })

  await test('git_resolve：空 files 必须显式失败；list 只读成功', async () => {
    const r = await call('tiddlywiki_git_resolve', { strategy: 'keep-remote' })
    assert.equal(r.ok, false, `空 files 必须显式失败（不能静默成功）：${JSON.stringify(r)}`)
    assert.ok(typeof r.message === 'string' && r.message.includes('conflictFiles'), `失败原因应提示需要 conflictFiles：${JSON.stringify(r.message)}`)
    const local = await call('tiddlywiki_git_resolve', { strategy: 'keep-local' })
    assert.equal(local.ok, false, 'keep-local 同样需要 files')
    const list = await call('tiddlywiki_git_resolve', { strategy: 'list' })
    assert.equal(list.ok, true, `list 是只读报告，应成功：${JSON.stringify(list)}`)
    assert.ok(list.status !== undefined && typeof list.status.branch === 'string', 'list 应返回 git status')
  })

  // ── 兜底：TEXT_LIST_FILTER 长度（Windows MAX_PATH 回归的另一处守门） ──────
  await test('TEXT_LIST_FILTER 长度 ≤ 100（Windows 白名单文件名不能撑爆 MAX_PATH）', () => {
    assert.ok(TEXT_LIST_FILTER.length <= 100, `TEXT_LIST_FILTER 长度 ${TEXT_LIST_FILTER.length} > 100：白名单 tiddler 的文件名 = 整个 filter 串，过长会让 git add 报 Filename too long`)
  })
} catch (err) {
  failures++
  console.error('FAIL  工具层验收框架异常')
  console.error(err)
} finally {
  await server?.stop().catch(() => {})
  await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(failures === 0 ? '\nTOOLS CHECKS OK' : `\nTOOLS CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

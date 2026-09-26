#!/usr/bin/env node
/**
 * `tiddlywiki_*` 工具层断言（真实 TW 子进程 + 真实 git 仓库）。覆盖 v0.18.0 的
 * 15 个核心工具（新增工具不会让本脚本误报 —— 工具集只做子集断言）：
 *
 * 通过对 `registerTiddlywikiTools(ctx, deps)` 捕获注册对象、再逐个
 * `tool.execute(args, undefined)` 的**函数式**调用，覆盖工具层的契约（不是 HTTP
 * 层、也不是 TW 自身行为）：
 *   - put：fields 不得覆盖 title/text/tags/created/modified；fields.type 是合法
 *     的内容类型覆盖；fields 的 schema 必须是 object 且按字符串发来也能写对
 *     （v0.26.5：字符串曾被 withWorkspaceMark 按字符拆成单字符垃圾字段）；
 *     新建自动补 agent-written；覆盖已存在的人类笔记不补；
 *     `$:/` 条目豁免 agent-written 与 markdown 默认；空 title 明确报错。
 *   - batch_put：空 title / 缺 text 的单条失败不影响其余（返回 failed 计数与逐条
 *     error）；overwrite:false 跳过已存在。
 *   - search / recent / list_tags：二进制 tiddler（type: image/png + base64 正文）
 *     不出现在结果里（含标题命中）；limit 上限被 clamp 到 200；since 过滤生效。
 *   - 工作区标记（v0.24.0）：新建自动补 `ws/<项目名>` 标签 + `workspace` 字段、
 *     调用方标签在前（附加式）、仅新建（覆盖不追打）、`$:/` 豁免、配置可关、
 *     显式 `fields.workspace` 优先，以及无 exec / 无 cwd / 未知会话的降级安全。
 *   - search（v0.24.0）：多词 AND（不是整串子串、更不是 OR）；先在工作区内查、
 *     命中即 `scope=workspace`，区内 0 条才扩到全库并如实报告 `fellBack`；
 *     调用方显式传 tag/field 时不自动收窄。
 *   - lint（v0.24.0）：`stale` 报 `valid-until` / `review-after` 过期，`stale-candidates`
 *     只把「版本号或 done 标签 + 长期未改动」当**候选**并自述「非判定」；
 *     报告全程只读（不删不改）。
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
  /**
   * 会话 → 工作目录（模拟宿主 `sessions.get(id).header.cwd`）。
   * v0.24.0 的新特性全靠这条链路：`exec.agent.id` → session → cwd → `ws/<名>`。
   * 这里用假映射，因为本脚本不启动 DSH 宿主；`session-nocwd` 覆盖「会话存在但
   * 没有 cwd」这一必须安全降级的真实情况。
   */
  const WORKSPACES = new Map([
    ['session-alpha', 'C:\\work\\alpha-project'],
    ['session-beta', 'C:\\work\\beta-project'],
    ['session-nocwd', undefined],
  ])
  /** 配置开关 `note.workspaceMark`（默认 true）的可变替身。 */
  let workspaceMarkEnabled = true
  registerTiddlywikiTools(
    { tools: { register: (tool) => { tools.set(tool.name, tool); return () => {} } } },
    {
      wiki: () => api,
      git,
      wikiPath: () => wikiDir,
      autoCommit: () => {},
      workspaceName: (sessionId) => WORKSPACES.get(sessionId),
      workspaceMarkEnabled: () => workspaceMarkEnabled,
    },
  )
  const call = (name, args) => {
    const tool = tools.get(name)
    assert.ok(tool !== undefined, `工具 ${name} 未注册`)
    return tool.execute(args, undefined)
  }
  /** 带「调用会话」的工具调用（`exec.agent.id` 是唯一的工作区线索）。 */
  const callAs = (name, args, sessionId) => {
    const tool = tools.get(name)
    assert.ok(tool !== undefined, `工具 ${name} 未注册`)
    return tool.execute(args, { agent: { id: sessionId } })
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

  // ── fields 参数形状（v0.26.5 修复）─────────────────────────────────────────
  // 真实事故（用户 2026-09-23 实测复现两次）：`fields` 的参数 schema 曾是
  // `{type:'json'}`——DSH 的 schema 里 `type:'json'` 是纯注解、编译后连 `type`
  // 都没有，模型不知道它是对象，把 `{"review-after":"2026-12-22"}` 当**字符串**
  // 发来。字符串在 `withWorkspaceMark` 的 `{ ...(fields ?? {}) }` 里被按字符展开成
  // `{0:'{',1:'"',2:'r',…}`，条目上出现几十个单字符垃圾字段，真正的自定义字段一个
  // 也没落。下面先钉 schema（模型看到什么），再钉行为（发成字符串也写对）。
  await test('schema：三个写工具的 fields 必须声明 type:object + additionalProperties:true', () => {
    const paths = [
      ['tiddlywiki_put', ['properties', 'fields']],
      ['tiddlywiki_append', ['properties', 'fields']],
      ['tiddlywiki_batch_put', ['properties', 'items', 'items', 'properties', 'fields']],
    ]
    for (const [name, path] of paths) {
      const label = `${name}.${path.join('.')}`
      let node = tools.get(name)?.parameters
      for (const key of path) node = node?.[key]
      assert.ok(node !== undefined, `${label} 的参数节点不存在`)
      assert.equal(node.type, 'object', `${label} 必须声明 type:object（type:json 编译后没有任何类型约束，模型会按字符串发参），实际 ${JSON.stringify(node)}`)
      assert.equal(node.additionalProperties, true, `${label} 必须 additionalProperties:true（自定义字段名不受限）`)
    }
  })

  await test('put：fields 以 JSON 字符串发来仍写对字段、不产生单字符垃圾', async () => {
    // 带会话 → 走 `withWorkspaceMark`（正是出事故的那条路径：新建 + 自动工作区标记）。
    const r = await callAs('tiddlywiki_put', { title: 'ToolsFieldsAsString', text: 'body', fields: '{"review-after":"2026-12-22"}' }, 'session-alpha')
    assert.equal(r.ok, true, `写入应成功：${JSON.stringify(r)}`)
    const t = await api.get('ToolsFieldsAsString')
    assert.equal(fieldOf(t, 'review-after'), '2026-12-22', `字符串 fields 必须被解析成对象写入，实际 ${JSON.stringify(t.fields)}`)
    assert.equal(t['0'], undefined, '不得出现 0= 这类单字符垃圾字段')
    assert.deepEqual(
      Object.keys(t.fields ?? {}).filter((k) => /^\d+$/.test(k)),
      [],
      `fields 里不得有索引键：${JSON.stringify(t.fields)}`,
    )
  })

  await test('put：fields 是不可解析的字符串/数组时明确报错，且不留下半成品条目', async () => {
    await assert.rejects(() => call('tiddlywiki_put', { title: 'ToolsFieldsBad', text: 'x', fields: 'not-json' }), /fields 必须是一个对象/)
    await assert.rejects(() => call('tiddlywiki_put', { title: 'ToolsFieldsBad', text: 'x', fields: ['a'] }), /fields 必须是一个对象/)
    assert.equal(await api.get('ToolsFieldsBad'), undefined, '报错的写入不得留下条目')
  })

  await test('append / batch_put：字符串 fields 走同一套归一化（三个入口一致）', async () => {
    await call('tiddlywiki_append', { title: 'ToolsAppendFields', text: 'body', fields: '{"valid-until":"2999-01-01"}' })
    assert.equal(fieldOf(await api.get('ToolsAppendFields'), 'valid-until'), '2999-01-01', 'append 必须解析字符串 fields')
    const br = await call('tiddlywiki_batch_put', { items: [{ title: 'ToolsBatchFields', text: 'body', fields: '{"review-after":"2026-12-22"}' }] })
    assert.equal(br.written, 1, `批量写入应成功：${JSON.stringify(br)}`)
    assert.equal(fieldOf(await api.get('ToolsBatchFields'), 'review-after'), '2026-12-22', 'batch_put 必须解析字符串 fields')
  })

  // ── 时间戳（v0.22.10）──────────────────────────────────────────────────────
  // 旧实现把 created/modified 列进 CLEAN_SKIP_FIELDS 并假设「TW 服务端会补」。
  // 服务端不补（put-tiddler.js 只 addTiddler），于是落盘条目缺 modified，
  // 而 TW 的 sortTiddlers 取值是 `fields[sortField] || ""` —— `+[!sort[modified]]`
  // 降序把它们**全部沉到最后一名**（用户现象：新日记在「主题页·日志」排 175/175）。
  // 这里用 TW 自己的 sort 过滤器（REST listing 的顺序就是过滤器结果顺序）做真实回归。
  await test('时间戳：新建条目落盘带 created/modified（TW 紧凑格式）', async () => {
    const r = await call('tiddlywiki_put', { title: 'StampNew', text: 'stamp probe', tags: ['stamp-probe'] })
    assert.equal(r.ok, true, `put 应成功：${JSON.stringify(r)}`)
    const t = await api.get('StampNew')
    const created = String(t.created ?? '')
    const modified = String(t.modified ?? '')
    assert.match(created, /^\d{17}$/, `新建必须落盘 created（TW 的 YYYYMMDDhhmmssSSS），实际 ${JSON.stringify(t.created)}——旧实现这里为空`)
    assert.match(modified, /^\d{17}$/, `新建必须落盘 modified，实际 ${JSON.stringify(t.modified)}——缺它就会在 !sort[modified] 里沉底`)
    assert.equal(created, modified, `新建时 created 应等于 modified（实际 ${created} vs ${modified}）`)
  })

  await test('时间戳：覆盖保留原 created、刷新 modified', async () => {
    const before = await api.get('StampNew')
    // 等过一个毫秒刻度，确保 modified 真的前进（不是「看起来一样」）。
    await new Promise((resolveP) => setTimeout(resolveP, 25))
    await call('tiddlywiki_put', { title: 'StampNew', text: 'stamp probe v2', tags: ['stamp-probe'] })
    const after = await api.get('StampNew')
    assert.equal(String(after.created), String(before.created), `覆盖必须保留基线 created（${before.created} → ${after.created}）`)
    assert.notEqual(String(after.modified), String(before.modified), '覆盖必须刷新 modified（否则页面显示成「没改过」）')
    assert.ok(Number(after.modified) > Number(before.modified), `modified 必须前进：${before.modified} → ${after.modified}`)
  })

  await test('时间戳：TW 的 !sort[modified] 不再把新写的笔记排到最后', async () => {
    // 一条「很久以前」的对照条目：显式写入旧 modified。
    await api.put({ title: 'StampAncient', text: 'ancient probe', tags: ['stamp-probe'], modified: '2000-01-01T00:00:00.000Z' })
    // 真实 TW 过滤器：listing 的返回顺序 = filterTiddlers 的结果顺序。
    // `!sort[modified]` 降序，最新在前；`[tag[stamp-probe]]` 只取本轮探针。
    const desc = (await api.list('[tag[stamp-probe]!has[draft.of]!sort[modified]]')).map((t) => t.title)
    assert.ok(desc.includes('StampNew'), `新写的条目必须出现在结果里：${JSON.stringify(desc)}`)
    assert.equal(desc[0], 'StampNew', `最新修改的笔记必须排第一，实际 ${JSON.stringify(desc)}——旧实现缺 modified 会沉到最后`)
    assert.equal(desc[desc.length - 1], 'StampAncient', `缺字段沉底的是那条显式旧时间的对照条目：${JSON.stringify(desc)}`)
    // 升序（正序）时，旧条目在前、新条目在最后。
    const asc = (await api.list('[tag[stamp-probe]!has[draft.of]sort[modified]]')).map((t) => t.title)
    assert.equal(asc[asc.length - 1], 'StampNew', `正序时新条目应在末位：${JSON.stringify(asc)}`)
  })

  await test('时间戳：append/rename 也刷新 modified 且保住 created', async () => {
    await call('tiddlywiki_append', { title: 'StampAppend', text: 'first' })
    const a1 = await api.get('StampAppend')
    assert.match(String(a1.created ?? ''), /^\d{17}$/, `append 新建也应带 created：${JSON.stringify(a1.created)}`)
    await new Promise((resolveP) => setTimeout(resolveP, 25))
    await call('tiddlywiki_append', { title: 'StampAppend', text: 'second' })
    const a2 = await api.get('StampAppend')
    assert.equal(String(a2.created), String(a1.created), 'append 覆盖必须保留 created')
    assert.ok(Number(a2.modified) > Number(a1.modified), `append 必须刷新 modified：${a1.modified} → ${a2.modified}`)
    await call('tiddlywiki_rename', { oldTitle: 'StampAppend', newTitle: 'StampAppendRenamed', updateRefs: false })
    const r = await api.get('StampAppendRenamed')
    assert.equal(String(r.created), String(a1.created), `rename 必须保留 created：${a1.created} → ${r.created}`)
    assert.match(String(r.modified ?? ''), /^\d{17}$/, `rename 后 modified 必须存在：${JSON.stringify(r.modified)}`)
  })

  // ── append + heading：CRLF 笔记必须能定位；未命中必须可机读（v0.26.6）──────
  // 这组是 v0.26.6 的回归：insertIntoSection 用 base.split('\n') 让 CRLF 文档每行
  // 结尾都留着 \r，而 JS 的 (.*) 不匹配 \r、$ 也不匹配 \r 之前 ⇒ 标题正则对**每个**
  // 标题都失败 ⇒ 带 heading 的 append 在 CRLF 笔记上**静默**落到文末，回执却照打
  // 「段落「X」」。纯 LF 笔记一切正常，所以过去看起来像偶发。
  await test('append/heading：CRLF 笔记也要能正确定位（回归）', async () => {
    const crlf = ['## SEC-A', 'a body', '', '## SEC-B', 'b body', '', '## SEC-C', 'c body', ''].join('\r\n')
    await call('tiddlywiki_put', { title: 'CrlfAppend', text: crlf })
    const before = await api.get('CrlfAppend')
    assert.ok(String(before.text).includes('\r\n'), `（前置条件）该条目正文必须是 CRLF，实际 ${JSON.stringify(String(before.text).slice(0, 40))}`)

    const r = await call('tiddlywiki_append', { title: 'CrlfAppend', text: 'MARK', heading: 'SEC-B' })
    assert.equal(r.headingMatched, true, `CRLF 笔记的标题必须定位成功：${JSON.stringify(r)}`)
    const text = String((await api.get('CrlfAppend')).text)
    const iB = text.indexOf('## SEC-B')
    const iM = text.indexOf('MARK')
    const iC = text.indexOf('## SEC-C')
    assert.ok(iB >= 0 && iM > iB && iM < iC, `MARK 必须落在 SEC-B 段内（B=${iB} M=${iM} C=${iC}）：${JSON.stringify(text)}`)
    // 新块跟随文档行尾：CRLF 笔记里不得混进裸 LF（否则行尾越写越乱）
    const segment = text.slice(iB, iC)
    assert.ok(!/[^\r]\n/.test(segment), `CRLF 笔记内不得混入裸 LF：${JSON.stringify(segment)}`)
  })

  await test('append/heading：未命中必须 headingMatched=false 且回执明说（回归）', async () => {
    await call('tiddlywiki_put', { title: 'HeadingMiss', text: '## ONLY\nbody\n' })
    const r = await call('tiddlywiki_append', { title: 'HeadingMiss', text: 'TAIL-MARK', heading: 'NO-SUCH-HEADING' })
    assert.equal(r.headingMatched, false, `未命中必须报告 headingMatched=false：${JSON.stringify(r)}`)
    const rendered = tools.get('tiddlywiki_append').output.render({}, r).map((b) => b.text).join('\n')
    assert.match(rendered, /未找到标题/, `回执必须明说没找到：${rendered}`)
    assert.ok(!rendered.includes('段落「NO-SUCH-HEADING」'), `未命中时不得再宣称写进了该段落：${rendered}`)
    const t = String((await api.get('HeadingMiss')).text)
    assert.ok(t.indexOf('TAIL-MARK') > t.indexOf('body'), `回退时应追加到文末：${JSON.stringify(t)}`)
  })

  await test('append/heading：命中时 headingMatched=true 且回执保留段落名（反向保护）', async () => {
    await call('tiddlywiki_put', { title: 'HeadingHit', text: '## SEC-A\na\n\n## SEC-B\nb\n\n## SEC-C\nc\n' })
    const r = await call('tiddlywiki_append', { title: 'HeadingHit', text: 'HIT-MARK', heading: 'SEC-B' })
    assert.equal(r.headingMatched, true, `命中应报告 true：${JSON.stringify(r)}`)
    const rendered = tools.get('tiddlywiki_append').output.render({}, r).map((b) => b.text).join('\n')
    assert.ok(rendered.includes('段落「SEC-B」'), `命中时回执仍要写段落名：${rendered}`)
    const t = String((await api.get('HeadingHit')).text)
    assert.ok(t.indexOf('HIT-MARK') > t.indexOf('b') && t.indexOf('HIT-MARK') < t.indexOf('## SEC-C'), `HIT-MARK 必须落在 SEC-B 段内：${JSON.stringify(t)}`)
  })

  await test('append/heading：wikitext（! 标题）也要能被定位', async () => {
    const base = '!WIKI-A\nalpha\n\n!WIKI-B\nbravo\n\n!WIKI-C\ncharlie\n'
    await call('tiddlywiki_put', { title: 'WikitextHeading', text: base, fields: { type: 'text/vnd.tiddlywiki' } })
    const r = await call('tiddlywiki_append', { title: 'WikitextHeading', text: 'WIKI-MARK', heading: 'WIKI-B' })
    assert.equal(r.headingMatched, true, `wikitext 标题必须定位成功：${JSON.stringify(r)}`)
    const t = String((await api.get('WikitextHeading')).text)
    assert.ok(t.indexOf('WIKI-MARK') > t.indexOf('bravo') && t.indexOf('WIKI-MARK') < t.indexOf('!WIKI-C'), `WIKI-MARK 必须落在 WIKI-B 段内：${JSON.stringify(t)}`)
  })

  await test('时间戳：fields 仍不得覆盖 created/modified', async () => {
    const r = await call('tiddlywiki_put', {
      title: 'StampReserved',
      text: 'reserved probe',
      fields: { created: '19990101000000000', modified: '19990101000000000' },
    })
    assert.equal(r.ok, true)
    const t = await api.get('StampReserved')
    assert.notEqual(String(t.created), '19990101000000000', `fields.created 不得覆盖（实际 ${t.created}）`)
    assert.notEqual(String(t.modified), '19990101000000000', `fields.modified 不得覆盖（实际 ${t.modified}）`)
  })

  // ── put：覆盖已存在的人类笔记不补 agent-written ──────────────────────────
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

  // ── list_tags：limit 有界（v0.19.4） ─────────────────────────────────────
  await test('list_tags：limit 截断但保留 total/truncated', async () => {
    const full = await call('tiddlywiki_list_tags', {})
    assert.equal(full.truncated, false, `默认限额内不应标记截断：${JSON.stringify({ total: full.total, count: full.count })}`)
    assert.equal(full.count, full.total, 'count 应等于 total（未截断时）')
    assert.ok(full.total >= 2, `测试 wiki 应有多个标签：${full.total}`)
    const one = await call('tiddlywiki_list_tags', { limit: 1 })
    assert.equal(one.tags.length, 1, `limit=1 只返回 1 个：${JSON.stringify(one.tags)}`)
    assert.equal(one.total, full.total, 'total 仍是全量标签数（截断不丢分母）')
    assert.equal(one.truncated, true, 'limit < total 时必须标记 truncated')
    assert.equal(one.tags[0].tag, full.tags[0].tag, '截断取的是使用最多的那个（排序不变）')
    const clamped = await call('tiddlywiki_list_tags', { limit: 99999 })
    assert.equal(clamped.truncated, false, 'limit 超过 1000 被夹到上限，仍不虚报截断')
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

  await test('lint：`{{{…}}}` 过滤器表达式不得被当成死链转写（v0.23.6）', async () => {
    // The old transclusion branch `\{\{([^}]+)\}\}` started at the FIRST two
    // braces of `{{{`, captured `{ [tag[todo]count[]] ` (target begins with `{`)
    // and reported it — flagging the home page and every counting page as broken.
    await api.put({
      title: 'FilterProbe',
      text: '共 {{{ [tag[todo]!tag[done]count[]] }}} 件；真正的死链 [[确实不存在ZZZ]]。',
      type: 'text/markdown',
      tags: ['human'],
    })
    const r = await call('tiddlywiki_lint', { checks: ['broken-links'], limit: 50 })
    const issue = r.issues.find((i) => i.kind === 'broken-links')
    assert.ok(issue !== undefined, `应报出真正的死链：${JSON.stringify(r.issues)}`)
    const joined = issue.samples.join('\n')
    assert.ok(
      !joined.includes('FilterProbe「') || !/\{\s*\[tag/.test(joined),
      `{{{…}}} 过滤器表达式不得被当成死链：${joined}`,
    )
    assert.ok(!/FilterProbe.*→.*\{/.test(joined), `捕获目标不得以 { 开头（那是三花括号）：${joined}`)
    assert.ok(joined.includes('确实不存在ZZZ'), `真正的死链仍须报出：${joined}`)
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

  // ── 工作区标记（v0.24.0：用户要求「默认添加时打上工作区/项目名」）──────────
  // 设计要点（写进断言，别只写在注释里）：
  //   · 附加式 —— 调用方标签在前，工作区标签在后，绝不替换；
  //   · 仅新建 —— 覆盖已有笔记不得追打，也不得改写它的 workspace 字段；
  //   · 降级安全 —— 无 exec / 无会话 / 会话无 cwd / 未知会话都不标记（而不是
  //     打成空标签或抛错）；
  //   · 可关 —— 配置 note.workspaceMark=false 时完全不出现；
  //   · 显式优先 —— 调用方自己写的 fields.workspace 不被自动值覆盖。
  await test('put：新建自动带 ws/<项目名> 标签 + workspace 字段（调用方标签在前）', async () => {
    const r = await callAs('tiddlywiki_put', { title: 'WsMarked', text: '工作区标记探针', tags: ['probe-tag'] }, 'session-alpha')
    assert.equal(r.ok, true, `put 应成功：${JSON.stringify(r)}`)
    assert.equal(r.workspace, 'alpha-project', `应报告工作区 id：${JSON.stringify(r.workspace)}`)
    assert.ok(r.tags.includes('ws/alpha-project'), `新建应补 ws/alpha-project，实际 ${JSON.stringify(r.tags)}`)
    assert.ok(r.tags.includes('probe-tag'), `调用方标签不得丢：${JSON.stringify(r.tags)}`)
    assert.ok(r.tags.includes(AGENT_TAG), `agent-written 仍须在场：${JSON.stringify(r.tags)}`)
    assert.ok(
      r.tags.indexOf('probe-tag') < r.tags.indexOf('ws/alpha-project'),
      `工作区标签必须是「附加」在调用方标签之后，实际 ${JSON.stringify(r.tags)}`,
    )
    const t = await api.get('WsMarked')
    assert.equal(fieldOf(t, 'workspace'), 'alpha-project', 'workspace 字段必须落库（供 field/value 过滤检索）')
    assert.ok((t.tags ?? []).includes('ws/alpha-project'), `标签必须落库：${JSON.stringify(t.tags)}`)
  })

  await test('put：覆盖已有笔记不得追打工作区标记（仅新建；含 workspace 字段）', async () => {
    await callAs('tiddlywiki_put', { title: 'WsOverwrite', text: '第一版' }, 'session-alpha')
    const second = await callAs('tiddlywiki_put', { title: 'WsOverwrite', text: '第二版' }, 'session-beta')
    assert.equal(second.ok, true, `覆盖应成功：${JSON.stringify(second)}`)
    assert.equal(second.workspace, undefined, '覆盖不是新建，不得报告工作区标记')
    const t = await api.get('WsOverwrite')
    assert.ok(
      !(t.tags ?? []).includes('ws/beta-project'),
      `覆盖不得追打第二个工作区的标签（否则一篇笔记会越挂越多项目）：${JSON.stringify(t.tags)}`,
    )
    assert.equal(fieldOf(t, 'workspace'), 'alpha-project', '覆盖不得改写已有的 workspace 字段')
  })

  await test('put：无 exec / 无会话 cwd / 未知会话都安全降级为不标记（不猜、不抛错）', async () => {
    const noExec = await call('tiddlywiki_put', { title: 'WsNoExec', text: 'x' })
    assert.equal(noExec.ok, true, '没有 exec 时工具本身必须照常工作')
    assert.equal(noExec.workspace, undefined, '没有 exec.agent 时不得猜工作区')
    const noAgent = await call('tiddlywiki_put', { title: 'WsNoAgent', text: 'x' })
    assert.equal(noAgent.workspace, undefined)
    const noCwd = await callAs('tiddlywiki_put', { title: 'WsNoCwd', text: 'x' }, 'session-nocwd')
    assert.equal(noCwd.ok, true, '会话没有 cwd 必须照常写入')
    assert.equal(noCwd.workspace, undefined, '会话无 cwd 时必须降级为不标记，而不是打成空标签')
    const unknown = await callAs('tiddlywiki_put', { title: 'WsUnknown', text: 'x' }, 'session-does-not-exist')
    assert.equal(unknown.ok, true)
    assert.equal(unknown.workspace, undefined, '未知会话不得猜工作区')
    for (const title of ['WsNoExec', 'WsNoAgent', 'WsNoCwd', 'WsUnknown']) {
      const t = await api.get(title)
      assert.ok(!(t.tags ?? []).some((tag) => tag.startsWith('ws/')), `${title} 不该带工作区标签：${JSON.stringify(t.tags)}`)
      assert.equal(fieldOf(t, 'workspace'), undefined, `${title} 不该带 workspace 字段`)
    }
  })

  await test('put：$:/ 系统条目豁免工作区标记（与 agent-written 同一条豁免）', async () => {
    const r = await callAs('tiddlywiki_put', { title: '$:/WsProbeConfig', text: 'x' }, 'session-alpha')
    assert.equal(r.ok, true, `$:/ 条目应写得进去：${JSON.stringify(r)}`)
    assert.equal(r.workspace, undefined, '$:/ 条目不得被当成「项目产出」')
    const t = await api.get('$:/WsProbeConfig')
    assert.ok(!(t.tags ?? []).some((tag) => tag.startsWith('ws/')), `${JSON.stringify(t.tags)}`)
  })

  await test('put：note.workspaceMark=false 时完全不标记（配置可关）', async () => {
    workspaceMarkEnabled = false
    try {
      const r = await callAs('tiddlywiki_put', { title: 'WsDisabled', text: 'x' }, 'session-alpha')
      assert.equal(r.ok, true)
      assert.equal(r.workspace, undefined, '开关关闭时必须完全不标记')
      const t = await api.get('WsDisabled')
      assert.ok(!(t.tags ?? []).some((tag) => tag.startsWith('ws/')), `${JSON.stringify(t.tags)}`)
      assert.equal(fieldOf(t, 'workspace'), undefined)
    } finally {
      workspaceMarkEnabled = true
    }
  })

  await test('put：调用方显式写的 fields.workspace 优先于自动值（不静默覆盖）', async () => {
    const r = await callAs('tiddlywiki_put', {
      title: 'WsExplicit',
      text: 'x',
      fields: { workspace: 'legacy-project' },
    }, 'session-alpha')
    assert.equal(r.ok, true, `显式字段应可写：${JSON.stringify(r)}`)
    const t = await api.get('WsExplicit')
    assert.equal(fieldOf(t, 'workspace'), 'legacy-project', '调用方显式归属不得被自动值改写')
  })

  await test('batch_put / append：新建时同样自动打工作区标记并逐条报告', async () => {
    const b = await callAs('tiddlywiki_batch_put', { items: [{ title: 'WsBatch', text: 'x' }] }, 'session-alpha')
    assert.equal(b.failed, 0, `批量写应成功：${JSON.stringify(b.items)}`)
    assert.equal(b.items[0].workspace, 'alpha-project', `逐条结果应报告工作区：${JSON.stringify(b.items[0])}`)
    assert.ok((await api.get('WsBatch')).tags.includes('ws/alpha-project'), 'batch_put 新建也应补标签')
    const a = await callAs('tiddlywiki_append', { title: 'WsAppendNew', text: '新条目增量' }, 'session-beta')
    assert.equal(a.ok, true, `append 应成功：${JSON.stringify(a)}`)
    assert.equal(a.created, true, '（前置条件）这次 append 应当是新建')
    assert.equal(a.workspace, 'beta-project', `append 新建也应报告工作区：${JSON.stringify(a)}`)
    assert.ok((await api.get('WsAppendNew')).tags.includes('ws/beta-project'), 'append 新建也应补标签')
    // 覆盖式 append 不得追打（与 put 同一规则）
    const a2 = await callAs('tiddlywiki_append', { title: 'WsAppendNew', text: '再追加' }, 'session-alpha')
    assert.equal(a2.created, false, '（前置条件）这次 append 应当是覆盖既有条目')
    assert.equal(a2.workspace, undefined, 'append 到已有条目不得追打工作区标记')
    assert.ok(
      !(await api.get('WsAppendNew')).tags.includes('ws/alpha-project'),
      'append 到已有条目不得追打第二个工作区的标签',
    )
  })

  // ── search：多词 AND + 先窄后宽（v0.24.0）────────────────────────────────
  await test('search：多词按 AND（全部词命中才算）——旧实现只做整串子串匹配', async () => {
    await api.put({ title: 'AndProbeBoth', text: 'alphaprobe 与 betaprobe 都在这里', type: 'text/markdown', tags: ['and-probe'] })
    await api.put({ title: 'AndProbeOnly', text: '这里只有 alphaprobe 一个词', type: 'text/markdown', tags: ['and-probe'] })
    // 整串子串（旧行为）永远匹配不到这条笔记 → 这是 AND 的判别器
    const both = await call('tiddlywiki_search', { query: 'alphaprobe betaprobe', tag: 'and-probe', limit: 50 })
    assert.ok(
      both.results.some((r) => r.title === 'AndProbeBoth'),
      `两个词都命中的笔记必须出现在结果里（AND 生效）：${JSON.stringify(both.results.map((r) => r.title))}`,
    )
    assert.ok(
      !both.results.some((r) => r.title === 'AndProbeOnly'),
      `只命中一个词的笔记不得出现（那会退化成 OR）：${JSON.stringify(both.results.map((r) => r.title))}`,
    )
    // 空查询保持旧的「空结果」语义（别把空串切成 '' 后匹配一切）
    const empty = await call('tiddlywiki_search', { query: '   ', tag: 'and-probe' })
    assert.equal(empty.total, 0, `空白查询必须返回 0 条，实际 ${empty.total}`)
  })

  await test('search：先在工作区内查，命中就报 scope=workspace 且不带出别的工作区', async () => {
    await callAs('tiddlywiki_put', { title: 'ScopeAlphaNote', text: 'scopeprobe 内容在 alpha', fields: {} }, 'session-alpha')
    await callAs('tiddlywiki_put', { title: 'ScopeBetaNote', text: 'scopeprobe 内容在 beta', fields: {} }, 'session-beta')
    const r = await callAs('tiddlywiki_search', { query: 'scopeprobe', limit: 50 }, 'session-alpha')
    assert.equal(r.workspace, 'alpha-project', `应识别出当前工作区：${JSON.stringify(r.workspace)}`)
    assert.equal(r.scope, 'workspace', `工作区内有命中就该缩在区内：${JSON.stringify(r)}`)
    assert.equal(r.fellBack, false, '没有扩大范围时 fellBack 必须为 false')
    const titles = r.results.map((x) => x.title)
    assert.ok(titles.includes('ScopeAlphaNote'), `本工作区的笔记必须在结果里：${JSON.stringify(titles)}`)
    assert.ok(!titles.includes('ScopeBetaNote'), `别的工作区的同名关键词笔记不得混进来：${JSON.stringify(titles)}`)
  })

  await test('search：工作区内 0 条时扩大到全库，并如实报告 fellBack（回执不许假装「库里没有」）', async () => {
    await callAs('tiddlywiki_put', { title: 'OnlyInBetaNote', text: 'betaonlyprobe 只在 beta', fields: {} }, 'session-beta')
    const r = await callAs('tiddlywiki_search', { query: 'betaonlyprobe', limit: 50 }, 'session-alpha')
    assert.equal(r.workspace, 'alpha-project', '仍应报告当前工作区')
    assert.equal(r.scope, 'all', `区内 0 条必须落到全库：${JSON.stringify({ scope: r.scope, total: r.total })}`)
    assert.equal(r.fellBack, true, '扩大范围必须标记 fellBack=true（回执据此提示「区内 0 条」）')
    assert.ok(
      r.results.some((x) => x.title === 'OnlyInBetaNote'),
      `扩大到全库后必须能找到别的工作区的笔记：${JSON.stringify(r.results.map((x) => x.title))}`,
    )
  })

  await test('search：调用方显式传 tag/field 时不自动收窄（显式范围不被二次猜测）', async () => {
    const r = await callAs('tiddlywiki_search', { query: 'scopeprobe', tag: 'and-probe', limit: 50 }, 'session-alpha')
    assert.equal(r.workspace, null, `显式传 tag 时不得启用工作区收窄：${JSON.stringify(r.workspace)}`)
    assert.equal(r.fellBack, false, '未启用收窄时 fellBack 必须为 false（它不是「搜不到」的同义词）')
    assert.equal(r.scope, 'all')
    const r2 = await callAs('tiddlywiki_search', { query: 'scopeprobe', field: 'workspace', limit: 50 }, 'session-alpha')
    assert.equal(r2.workspace, null, '显式传 field 时同样不得收窄')
  })

  // ── lint：时效性内容（v0.24.0，只读）────────────────────────────────────
  await test('lint：stale 报出 valid-until / review-after 过期，且不报未到期的（只读）', async () => {
    await call('tiddlywiki_put', { title: 'StaleExpired', text: '这张表 2020 年就失效了', fields: { 'valid-until': '2000-01-01' } })
    await call('tiddlywiki_put', { title: 'StaleReview', text: '该复查了', fields: { 'review-after': '2000-01-01' } })
    await call('tiddlywiki_put', { title: 'StaleFresh', text: '还早', fields: { 'valid-until': '2999-01-01' } })
    const r = await call('tiddlywiki_lint', { checks: ['stale'], limit: 50 })
    const expired = r.issues.find((i) => i.kind === 'stale-expired')
    const review = r.issues.find((i) => i.kind === 'stale-review')
    assert.ok(expired !== undefined, `valid-until 已过必须报 stale-expired：${JSON.stringify(r.issues)}`)
    assert.ok(review !== undefined, `review-after 已到必须报 stale-review：${JSON.stringify(r.issues)}`)
    const all = [...expired.samples, ...review.samples].join('\n')
    assert.ok(all.includes('StaleExpired'), `样本应含 StaleExpired：${all}`)
    assert.ok(all.includes('StaleReview'), `样本应含 StaleReview：${all}`)
    assert.ok(!all.includes('StaleFresh'), `未到期的笔记不得报出来：${all}`)
    // 只读：报告不得改动任何东西
    const still = await api.get('StaleExpired')
    assert.ok(still !== undefined, 'lint 绝不允许删除条目')
    assert.equal(fieldOf(still, 'valid-until'), '2000-01-01', 'lint 不得改写时效字段')
  })

  await test('lint：stale-candidates 只把「版本号/done 标签 + 长期未改动」当候选，并自述是候选', async () => {
    // 直接 PUT 带一个很久以前的 modified（TW 会沿用调用方给的时间戳），
    // 这才是「长期未改动」的真实形态；再挂一个版本号标签。
    await api.put({
      title: 'StaleVersioned',
      text: 'v0.1.0 的旧版本说明',
      type: 'text/markdown',
      tags: ['v0.1.0'],
      modified: '20200101120000000',
    })
    const stored = await api.get('StaleVersioned')
    assert.equal(stored.modified, '20200101120000000', '（前置条件）旧的 modified 必须落库，否则候选判定无从谈起')
    const r = await call('tiddlywiki_lint', { checks: ['stale'], limit: 50 })
    const cand = r.issues.find((i) => i.kind === 'stale-candidates')
    assert.ok(cand !== undefined, `带版本号标签 + 长期未改动应进入候选：${JSON.stringify(r.issues)}`)
    assert.ok(
      cand.samples.some((s) => s.includes('StaleVersioned')),
      `候选样本应含 StaleVersioned：${JSON.stringify(cand.samples)}`,
    )
    // 「候选」必须自述为候选 —— 这是「只提示、不判定」的唯一可见凭据
    assert.ok(/候选/.test(cand.hint), `候选类必须自述是候选而非判定：${cand.hint}`)
    assert.ok(/非判定/.test(cand.hint), `候选类必须写明「非判定」：${cand.hint}`)
    // …而且它只是一条 issue，绝不能顺手把笔记删了/改了
    assert.ok((await api.get('StaleVersioned')) !== undefined, 'lint 绝不允许删除条目')
    // 阈值可调：把窗口收到 1 天以内也不会把这条排除（它本来就是 2020 年的）
    const tight = await call('tiddlywiki_lint', { checks: ['stale'], staleAfterDays: 1, limit: 50 })
    const tightCand = tight.issues.find((i) => i.kind === 'stale-candidates')
    assert.ok(tightCand !== undefined, '阈值调小后这条仍应留在候选里')
  })

  await test('lint：默认体检（不传 checks）也包含时效检查', async () => {
    const full = await call('tiddlywiki_lint', { limit: 10 })
    const kinds = full.issues.map((i) => i.kind)
    assert.ok(kinds.includes('stale-expired'), `默认体检必须包含时效检查：${JSON.stringify(kinds)}`)
  })

  // ── v0.25.0：清空标签 / 并发令牌 / lint 检查名校验 ────────────────────────
  await test('put：显式 tags: [] 必须真的清空标签，不传 tags 仍是「保留」', async () => {
    await call('tiddlywiki_put', { title: 'ToolsTagClear', text: 'x', tags: ['keep-me', 'drop-me'] })
    const cleared = await call('tiddlywiki_put', { title: 'ToolsTagClear', text: 'x', tags: [] })
    assert.deepEqual(cleared.tags, [], `显式空数组应清空标签，回执实际 ${JSON.stringify(cleared.tags)}`)
    const t = await api.get('ToolsTagClear')
    assert.deepEqual(t.tags ?? [], [], `落库标签应为空，实际 ${JSON.stringify(t.tags)}`)
    // 未传 tags 的语义必须没变（否则「不传就保留原标签」这条契约被改坏了）。
    // 注意：新建时自动补的 agent-written 也在「原有标签」里，所以断言包含关系。
    await call('tiddlywiki_put', { title: 'ToolsTagKeep', text: 'x', tags: ['kept'] })
    const kept = await call('tiddlywiki_put', { title: 'ToolsTagKeep', text: 'y' })
    assert.ok(kept.tags.includes('kept'), `不传 tags 必须保留原标签，实际 ${JSON.stringify(kept.tags)}`)
  })

  await test('append：expectedModified 不匹配必须拒绝（append 是整篇回写）', async () => {
    await call('tiddlywiki_put', { title: 'ToolsAppendGuard', text: 'base' })
    const stale = await api.get('ToolsAppendGuard')
    // 模拟「人类在 TW 里改过」：再写一次，modified 必然前进（间隔 5ms 避免同毫秒）。
    await new Promise((resolve) => setTimeout(resolve, 5))
    await call('tiddlywiki_put', { title: 'ToolsAppendGuard', text: 'human edit' })
    await assert.rejects(
      () => call('tiddlywiki_append', { title: 'ToolsAppendGuard', text: 'agent add', expectedModified: stale.modified }),
      /写入冲突/,
      'append 带过期令牌必须报写入冲突',
    )
    assert.equal((await api.get('ToolsAppendGuard')).text, 'human edit', '被拒后正文必须仍是人类版本')
    // 令牌正确时照常写入（新参数不能把正常路径卡死）。
    const fresh = await api.get('ToolsAppendGuard')
    const okResult = await call('tiddlywiki_append', { title: 'ToolsAppendGuard', text: 'agent add', expectedModified: fresh.modified })
    assert.equal(okResult.ok, true, `令牌匹配时应写入成功：${JSON.stringify(okResult)}`)
    assert.ok((await api.get('ToolsAppendGuard')).text.includes('agent add'), '追加内容应落库')
  })

  await test('batch_put：单条 expectedModified 不匹配只让该条失败，其余照常写入', async () => {
    await call('tiddlywiki_put', { title: 'ToolsBatchA', text: 'a1' })
    const stale = await api.get('ToolsBatchA')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await call('tiddlywiki_put', { title: 'ToolsBatchA', text: 'a2' })
    const r = await call('tiddlywiki_batch_put', {
      items: [
        { title: 'ToolsBatchA', text: 'stale write', expectedModified: stale.modified },
        { title: 'ToolsBatchB', text: 'b1' },
      ],
    })
    assert.equal(r.failed, 1, `过期的那条应失败：${JSON.stringify(r)}`)
    assert.equal(r.written, 1, `另一条应写入成功：${JSON.stringify(r)}`)
    assert.equal((await api.get('ToolsBatchA')).text, 'a2', '过期条目不得被覆盖')
    assert.equal((await api.get('ToolsBatchB')).text, 'b1', '同一批次里的其余条目必须照常写入')
  })

  await test('lint：无法识别的 checks 必须报出来，且不得谎报「没有发现问题」', async () => {
    const bad = await call('tiddlywiki_lint', { checks: ['broken-link'], limit: 3 })
    assert.deepEqual(bad.checks, [], `拼错的检查名不该运行任何检查，实际 ${JSON.stringify(bad.checks)}`)
    assert.deepEqual(bad.unknownChecks, ['broken-link'], `应报出无法识别的名字，实际 ${JSON.stringify(bad.unknownChecks)}`)
    const rendered = tools.get('tiddlywiki_lint').output.render({}, bad).map((b) => b.text).join('\n')
    assert.ok(rendered.includes('无法识别'), `回执必须说明忽略了哪些检查名：${rendered}`)
    assert.ok(!rendered.includes('没有发现问题'), `没跑任何检查时不得谎报「没有发现问题」：${rendered}`)
    // 合法子集：回执要说清实际跑了哪些检查。
    const one = await call('tiddlywiki_lint', { checks: ['empty-notes'], limit: 3 })
    assert.deepEqual(one.checks, ['empty-notes'], `应只运行请求的检查，实际 ${JSON.stringify(one.checks)}`)
    assert.deepEqual(one.unknownChecks, [], '合法名字不该被当成未知')
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

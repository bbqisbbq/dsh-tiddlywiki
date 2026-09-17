#!/usr/bin/env node
/**
 * backfill-publish-state.mjs — 给「来源可辨的已发布文章」批量回填发布元数据
 *
 * 用途：把早于「发布元数据规范」、但确定已发过的笔记，补上 pub-state / pub-platform
 * 字段，让 agent 之后能判断「这篇发过没有」。规范见 wiki 的「发布元数据规范」。
 *
 * ── 为什么单独写脚本而不是用 tiddlywiki_batch_put ──────────────────────────
 * batch_put **要求每条都带 text**（源码里 `typeof item.text !== 'string'` 直接抛
 * 「缺少 text」）。它因此不会保留原正文——必须由调用方先读全文再写回。这个脚本
 * 就是做这件事的，而且：
 *   - 默认 **dry-run**（只打印将要改什么），`--write` 才落盘；
 *   - 每条都先 GET **完整** tiddler（含 text/tags/type/created），
 *     只**添加** pub-* 字段，正文/标签/类型/时间戳一律原样写回；
 *   - 逐条独立，一条失败不影响其余。
 *
 * ⚠️ 血的教训（2026-09-17）：曾用「只 PUT 一段文字」的方式标记状态，结果把笔记
 * 正文整个覆盖成空。**任何写路径都必须先读全文**。这个脚本按这个纪律写。
 *
 * 用法：
 *   node tools/wechat/backfill-publish-state.mjs                      # dry-run
 *   node tools/wechat/backfill-publish-state.mjs --write              # 真写
 *   node tools/wechat/backfill-publish-state.mjs --dsn http://127.0.0.1:3080/dsh-tiddlywiki
 *   node tools/wechat/backfill-publish-state.mjs --match 公众号 --platform wechat
 *   node tools/wechat/backfill-publish-state.mjs --title 打工记 --title 鱼
 *
 * 筛选逻辑：优先用 `--title`（精确标题）；否则用 `--match`（默认「公众号」）
 * 匹配 `source-path` 字段——Obsidian 导入的公众号文章路径形如
 * `Articles\公众号\杂七杂八\打工记.md`。
 */
import { parseArgs } from 'node:util'

const { values: opts } = parseArgs({
  options: {
    dsn: { type: 'string', default: 'http://127.0.0.1:3080/dsh-tiddlywiki' },
    match: { type: 'string', default: '公众号' },
    platform: { type: 'string', default: 'wechat' },
    title: { type: 'string', multiple: true, default: [] },
    write: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: true,
})

if (opts.help) {
  console.log(`用法：node tools/wechat/backfill-publish-state.mjs [选项]

  --dsn <url>        DSH 知识库地址（默认 http://127.0.0.1:3080/dsh-tiddlywiki）
  --match <子串>     匹配 source-path 的子串（默认「公众号」）
  --platform <名>    写入 pub-platform 的值（默认 wechat）
  --title <标题>     指定标题（可重复；给了就忽略 --match）
  --write            真写入（默认 dry-run）
  --help             显示本帮助`)
  process.exit(0)
}

const DSN = String(opts.dsn).replace(/\/+$/, '')
const PLATFORM = String(opts.platform).trim() || 'wechat'
const MATCH = String(opts.match)
const TITLES = Array.isArray(opts.title) ? opts.title.filter((t) => typeof t === 'string' && t.length > 0) : []
const WRITE = opts.write === true

/** 瘦列表（不含 text）——用来挑候选。 */
async function listTiddlers() {
  const resp = await fetch(`${DSN}/api/recipes/default/tiddlers.json`)
  if (!resp.ok) throw new Error(`列表请求失败：HTTP ${resp.status}（DSH 在运行吗？）`)
  return resp.json()
}

/** 单条的完整 JSON（含 text/tags/type）——写回必须基于它。 */
async function getTiddler(title) {
  const resp = await fetch(`${DSN}/api/recipes/default/tiddlers/${encodeURIComponent(title)}`, {
    headers: { Accept: 'application/json' },
  })
  if (!resp.ok) throw new Error(`读取「${title}」失败：HTTP ${resp.status}`)
  return resp.json()
}

/** 写回单条：只添加 pub-* 字段，其余原样。 */
async function putTiddler(tiddler) {
  const resp = await fetch(`${DSN}/api/recipes/default/tiddlers/${encodeURIComponent(tiddler.title)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tiddler),
  })
  if (!resp.ok && resp.status !== 204) {
    throw new Error(`写入「${tiddler.title}」失败：HTTP ${resp.status}`)
  }
}

async function main() {
  console.log(`DSN      : ${DSN}`)
  console.log(`模式     : ${WRITE ? '写入（--write）' : 'DRY-RUN（只打印，加 --write 才落盘）'}`)
  console.log(`平台     : ${PLATFORM}`)

  // ── 1. 挑候选 ──
  let candidates
  if (TITLES.length > 0) {
    candidates = TITLES.map((title) => ({ title }))
    console.log(`选择方式 : --title（${TITLES.length} 个）`)
  } else {
    const all = await listTiddlers()
    candidates = all.filter((t) => {
      const sp = t['source-path']
      return typeof sp === 'string' && sp.includes(MATCH)
    })
    console.log(`选择方式 : source-path 含「${MATCH}」`)
  }
  console.log(`候选     : ${candidates.length} 条\n`)

  if (candidates.length === 0) {
    console.log('没有候选，退出。')
    return
  }

  // ── 2. 逐条读全文 → 加字段 → 写回 ──
  let changed = 0
  let skipped = 0
  let failed = 0
  for (const cand of candidates) {
    const title = cand.title
    try {
      const full = await getTiddler(title)

      // 已有状态就不覆盖（幂等，可安全重复跑）
      if (full['pub-state']) {
        console.log(`  跳过「${title}」——已有 pub-state=${full['pub-state']}`)
        skipped++
        continue
      }

      const before = String(full.text || '').length
      if (before === 0) {
        console.log(`  ⚠️ 跳过「${title}」——正文为空（宁可不动）`)
        skipped++
        continue
      }

      // 只添加字段：正文/标签/type/created/modified 全部保留
      const next = {
        ...full,
        'pub-state': 'published',
        'pub-platform': PLATFORM,
        // 发表时间无法考证 → 留空，不编造（规范里明确要求）
      }

      console.log(`  ${WRITE ? '写入' : '将写'}「${title}」（正文 ${before} 字，保留原标签 ${(full.tags || []).length} 个）`)
      if (WRITE) await putTiddler(next)
      changed++
    } catch (err) {
      failed++
      console.error(`  ✖ 失败「${title}」：${err?.message || err}`)
    }
  }

  console.log(`\n完成：${WRITE ? '已写' : '将写'} ${changed} 条，跳过 ${skipped} 条，失败 ${failed} 条。`)
  if (!WRITE && changed > 0) {
    console.log('这是 dry-run。确认无误后加 --write 真正落盘。')
  }
}

main().catch((err) => {
  console.error(`\n出错：${err?.message || err}`)
  process.exit(1)
})

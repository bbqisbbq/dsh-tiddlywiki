#!/usr/bin/env node
/**
 * 把 `split-agents-to-wiki.mjs --emit` 导出的笔记推给**正在运行的** dsh web
 * （经插件的同源 `/api` 代理 → 回环 TW 子进程）。
 *
 * 为什么不直接写磁盘、也不再 spawn 一个 TW：TW 的 FileSystemAdaptor 会自己
 * 编码文件名，手写文件极易与它算出的名字不一致（留下重复 tiddler）；而面向同一个
 * wiki 目录再起一个 TW 会与 dsh web 那个争抢 syncer（本仓库反复记录的丢写入竞态）。
 * 走运行中的实例则顺带拿到 flush 与自动 commit。
 *
 * 用法：
 *   node scripts/push-notes-to-wiki.mjs <dir> [baseUrl]
 *     <dir>      --emit 的输出目录（含 index.json）
 *     baseUrl    默认 http://127.0.0.1:3080/dsh-tiddlywiki
 *
 * @module dsh-tiddlywiki/scripts/push-notes-to-wiki
 */
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
const base = (process.argv[3] ?? 'http://127.0.0.1:3080/dsh-tiddlywiki').replace(/\/+$/, '')
if (dir === undefined) {
  console.error('用法：node scripts/push-notes-to-wiki.mjs <emit-dir> [baseUrl]')
  process.exit(1)
}

const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
const TAGS = ['dsh-tiddlywiki', 'dev-doc']

let ok = 0
let failed = 0
for (const [i, item] of index.entries()) {
  const file = path.join(dir, `${String(i + 1).padStart(2, '0')}.md`)
  const text = fs.readFileSync(file, 'utf8')
  const url = `${base}/api/recipes/default/tiddlers/${encodeURIComponent(item.title)}`
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: item.title, text, tags: TAGS, type: 'text/markdown' }),
    })
    if (!res.ok) {
      console.error(`  FAIL ${item.title} → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
      failed += 1
      continue
    }
    console.log(`  ok   ${item.title}（${item.bytes} bytes）`)
    ok += 1
  } catch (err) {
    console.error(`  FAIL ${item.title} → ${err.message}`)
    failed += 1
  }
}
console.log(`\n推送完成：成功 ${ok}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)

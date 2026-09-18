#!/usr/bin/env node
/**
 * wechat-setup seed 的单一来源守门（v0.23.1）。
 *
 * seed 常量 `WECHAT_DOCS_TEXT` 由 `scripts/gen-seed-wechat-docs.mjs` 从
 * docs/wechat-publish-setup.md 生成。本脚本在构建/发布前重新读那份文档并断言：
 *
 *   1. seed 模块常量与文档**逐字节一致**（防两份漂移——doc-note 的工具清单曾
 *      手抄 rot 了四个版本，v0.21.0 才改成生成）；
 *   2. seed 模块与 seed 注册表源码里标题/标记/实现接线齐全；
 *   3. 注册表里 wechat-setup 与 publish-spec 同 gate 模式（gate: ctx.wechat === true）
 *      且为 startup 层；
 *   4. setup 文档自身也提到「微信公众号发布指南」这个 wiki 笔记名……不需要：
 *      文档是给 wiki 读者的，标题名只在 seed 侧定义。
 *
 * 纯文本/源码级检查，不 import lib/、不需要 build、不 spawn TW。
 *
 *   node scripts/verify-wechat-docs-seed.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-wechat-docs-seed
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const docText = fs.readFileSync(path.join(repoRoot, 'docs', 'wechat-publish-setup.md'), 'utf8').replace(/\r\n/g, '\n')
const seedSrc = fs.readFileSync(path.join(repoRoot, 'src', 'host', 'seed-wechat-docs.ts'), 'utf8').replace(/\r\n/g, '\n')
const seedsSrc = fs.readFileSync(path.join(repoRoot, 'src', 'host', 'seeds.ts'), 'utf8').replace(/\r\n/g, '\n')

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

/** Extract the JSON-string-literal assigned to WECHAT_DOCS_TEXT from the generated module. */
function extractLiteral(src) {
  const m = src.match(/export const WECHAT_DOCS_TEXT = ("(?:[^"\\]|\\.)*")/)
  if (m === null) throw new Error('seed-wechat-docs.ts 里找不到 WECHAT_DOCS_TEXT 字符串字面量（生成器输出变了？）')
  return JSON.parse(m[1])
}

await test('WECHAT_DOCS_TEXT 与 docs/wechat-publish-setup.md 逐字节一致', () => {
  const embedded = extractLiteral(seedSrc)
  assert.equal(embedded, docText, 'seed 常量与 setup 文档不一致——请运行 node scripts/gen-seed-wechat-docs.mjs 重新生成，不要手改常量')
})

await test('seed 模块导出齐全（标题/标记/写入/反初始化）', () => {
  for (const fragment of [
    "export const WECHAT_DOCS_TITLE = '微信公众号发布指南'",
    "export const WECHAT_DOCS_MARKER_TITLE = '$:/plugins/dsh-tiddlywiki/seed-wechat-docs'",
    'export async function seedWechatDocs',
    'export async function unseedWechatDocs',
    "type: 'text/markdown'",
    "tags: ['dsh-docs', 'dsh-tiddlywiki']",
  ]) {
    assert.ok(seedSrc.includes(fragment), `seed-wechat-docs.ts 缺少 ${JSON.stringify(fragment)}`)
  }
})

await test('seed 注册表：wechat-setup 已登记，与 publish-spec 同 gate 模式且为 startup 层', () => {
  assert.ok(seedsSrc.includes("id: 'wechat-setup'"), "seeds.ts 里没有 id: 'wechat-setup' 的注册项")
  assert.ok(seedsSrc.includes("from './seed-wechat-docs.ts'"), 'seeds.ts 没有导入 seed-wechat-docs')
  // gate 与 publish-spec 一致：同一个可选拨号（wechat.enabled）。三个 gated seed
  // 各自携带同一谓词——直接数出现次数（publish-spec + wechat-setup +
  // wechat-publish = 恰好 3 处）。
  const gateCount = seedsSrc.split('gate: (ctx) => ctx.wechat === true').length - 1
  assert.equal(gateCount, 3, `seeds.ts 里 gate 谓词应恰好出现 3 次（publish-spec + wechat-setup + wechat-publish），实际 ${gateCount}`)
  // marker 常量被注册表引用
  assert.ok(seedsSrc.includes('WECHAT_DOCS_MARKER_TITLE'), 'seeds.ts 必须引用 WECHAT_DOCS_MARKER_TITLE 作 markerTitle')
  assert.ok(seedsSrc.includes('seedWechatDocs'), 'seeds.ts 必须把 seedWechatDocs 接到 wechat-setup 的 write')
})

await test('src/index.ts 再导出 seed 模块（守门脚本与 selftest 从 lib/index.js 取常量）', () => {
  const idx = fs.readFileSync(path.join(repoRoot, 'src', 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
  assert.ok(
    idx.includes("from './host/seed-wechat-docs.ts'"),
    'src/index.ts 必须再导出 seed-wechat-docs 的常量（verify 里 lib/index.js 才拿得到）',
  )
})

console.log(failures === 0 ? '\nWECHAT DOCS SEED OK' : `\nWECHAT DOCS SEED FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

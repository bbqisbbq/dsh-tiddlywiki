#!/usr/bin/env node
/**
 * 版本一致性守门（发布流程 §6 的第 3/4 步）。
 *
 * 断言三处版本号完全一致：
 *   1. package.json 的 `version`
 *   2. AGENTS.md §1 易变清单「插件版本」行里的 `\`x.y.z\``
 *   3. docs/CHANGELOG.md **顶部第一条** `- **vx.y.z**（日期）：…`
 *
 * 第 3 处以前是 README.md 的「版本记录」小节。作者 2026-09-29 要求 README 只放
 * 最新最重要的信息、版本历史单独放一个文档 —— 于是历史全部收进 docs/CHANGELOG.md
 * （README 那边的内容本来就是它的副本），本脚本改成读那里，并**反向断言 README
 * 里不许再长出逐版本条目**（否则"精简过的 README"会随每次发布慢慢长回去）。
 *
 * 纯文本正则提取，不 import lib/（不需要 build）。
 *
 *   node scripts/verify-version-consistency.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-version-consistency
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
// 顺序执行 + await：断言失败只记为一条 FAIL（不静默、不中断后续检查）。
async function test(name, fn) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures++
    console.error(`FAIL  ${name}\n      ${err && err.message ? err.message : err}`)
  }
}

const pkgRaw = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
const agentsRaw = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8')
const readmeRaw = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8')
const changelogRaw = fs.readFileSync(path.join(repoRoot, 'docs/CHANGELOG.md'), 'utf8')

const pkg = JSON.parse(pkgRaw)
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

// AGENTS.md §1：| **插件版本** | `0.18.0`（npm latest = …） | … |
const agentsMatch = agentsRaw.match(/^\|\s*\*\*插件版本\*\*\s*\|\s*`([^`]+)`/m)
const agentsVersion = agentsMatch?.[1]?.trim()

// docs/CHANGELOG.md 顶部第一条 `- **v0.18.0**（2026-09-10）：…`
const changelogMatch = changelogRaw.match(/^-\s*\*\*v([0-9][0-9A-Za-z.+-]*)\*\*/m)
const changelogVersion = changelogMatch?.[1]?.trim()

/** README 里残留的逐版本条目（新规则下必须为空）。 */
const readmeVersionEntries = readmeRaw.match(/^\s*-\s*\*\*v\d+\.\d+\.\d+\*\*/gm) ?? []

console.log(`package.json version   : ${pkg.version}`)
console.log(`AGENTS.md §1 版本       : ${agentsVersion ?? '(未匹配)'}`)
console.log(`CHANGELOG 顶部         : ${changelogVersion ?? '(未匹配)'}`)

await test('package.json version 是合法 semver', () => {
  assert.ok(typeof pkg.version === 'string' && SEMVER.test(pkg.version), `package.json version 非法：${JSON.stringify(pkg.version)}`)
})

await test('AGENTS.md §1 易变清单能提取到版本号', () => {
  assert.ok(agentsVersion !== undefined, 'AGENTS.md §1 未匹配到「| **插件版本** | `x.y.z` …」这一行（结构变了？以实际文件为准修正本脚本）')
})

await test('docs/CHANGELOG.md 能提取到顶部条目版本号', () => {
  assert.ok(changelogVersion !== undefined, 'docs/CHANGELOG.md 里没有 `- **vX.Y.Z**` 形式的顶部条目（发布流程要求在顶部新增一条）')
})

await test('README 里不得再有逐版本条目（规则：历史只住在 docs/CHANGELOG.md）', () => {
  assert.deepEqual(
    readmeVersionEntries,
    [],
    `README.md 又出现了 ${readmeVersionEntries.length} 条版本条目（${readmeVersionEntries[0]?.trim() ?? ''} …）——README 只放最新最重要的信息，版本历史写进 docs/CHANGELOG.md`,
  )
})

await test('package.json version === AGENTS.md §1 版本', () => {
  assert.equal(agentsVersion, pkg.version, `AGENTS.md §1 的版本（${agentsVersion}）与 package.json（${pkg.version}）不一致——发布流程要求在同一个 commit 里同步 §1`)
})

await test('package.json version === docs/CHANGELOG.md 顶部版本', () => {
  assert.equal(changelogVersion, pkg.version, `docs/CHANGELOG.md 顶部条目（${changelogVersion}）与 package.json（${pkg.version}）不一致——发布流程要求在顶部新增 v${pkg.version} 条目`)
})

console.log(failures === 0 ? '\nVERSION CONSISTENCY OK' : `\nVERSION CONSISTENCY FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

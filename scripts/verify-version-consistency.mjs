#!/usr/bin/env node
/**
 * 版本一致性守门（发布流程 §6 的第 3/4 步）。
 *
 * 断言三处版本号完全一致：
 *   1. package.json 的 `version`
 *   2. AGENTS.md §1 易变清单「插件版本」行里的 `\`x.y.z\``
 *   3. README.md「版本记录」**顶部第一条** `- **vx.y.z**（日期）：…`
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

const pkg = JSON.parse(pkgRaw)
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

// AGENTS.md §1：| **插件版本** | `0.18.0`（npm latest = …） | … |
const agentsMatch = agentsRaw.match(/^\|\s*\*\*插件版本\*\*\s*\|\s*`([^`]+)`/m)
const agentsVersion = agentsMatch?.[1]?.trim()

// README「版本记录」小节里的第一条 `- **v0.18.0**（2026-09-10）：…`
const readmeSection = readmeRaw.indexOf('版本记录')
const readmeTail = readmeSection >= 0 ? readmeRaw.slice(readmeSection) : readmeRaw
const readmeMatch = readmeTail.match(/^-\s*\*\*v([0-9][0-9A-Za-z.+-]*)\*\*/m)
const readmeVersion = readmeMatch?.[1]?.trim()

console.log(`package.json version : ${pkg.version}`)
console.log(`AGENTS.md §1 版本     : ${agentsVersion ?? '(未匹配)'}`)
console.log(`README 版本记录顶部   : ${readmeVersion ?? '(未匹配)'}`)

await test('package.json version 是合法 semver', () => {
  assert.ok(typeof pkg.version === 'string' && SEMVER.test(pkg.version), `package.json version 非法：${JSON.stringify(pkg.version)}`)
})

await test('AGENTS.md §1 易变清单能提取到版本号', () => {
  assert.ok(agentsVersion !== undefined, 'AGENTS.md §1 未匹配到「| **插件版本** | `x.y.z` …」这一行（结构变了？以实际文件为准修正本脚本）')
})

await test('README.md「版本记录」能提取到顶部条目版本号', () => {
  assert.ok(readmeSection >= 0, 'README.md 里找不到「版本记录」小节')
  assert.ok(readmeVersion !== undefined, 'README「版本记录」里没有 `- **vX.Y.Z**` 形式的顶部条目')
})

await test('package.json version === AGENTS.md §1 版本', () => {
  assert.equal(agentsVersion, pkg.version, `AGENTS.md §1 的版本（${agentsVersion}）与 package.json（${pkg.version}）不一致——发布流程要求在同一个 commit 里同步 §1`)
})

await test('package.json version === README「版本记录」顶部版本', () => {
  assert.equal(readmeVersion, pkg.version, `README「版本记录」顶部条目（${readmeVersion}）与 package.json（${pkg.version}）不一致——发布流程要求在顶部新增 v${pkg.version} 条目`)
})

console.log(failures === 0 ? '\nVERSION CONSISTENCY OK' : `\nVERSION CONSISTENCY FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

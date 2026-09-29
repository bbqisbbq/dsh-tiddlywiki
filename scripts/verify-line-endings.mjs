#!/usr/bin/env node
/**
 * 行尾守门（v0.30.17）—— 仓库铁律「**行尾必须 LF**」的**唯一执行者**。
 *
 * 为什么需要它（真实事故，2026-09-29）：`src/host/routes-wechat.ts` 的工作区副本
 * 是 **CRLF**，而仓库 blob 是 LF（`.gitattributes` 在 commit 时把 CRLF 归一成 LF，
 * 于是 `git status` / `git diff` **什么都看不见** —— 这个状态可以一直躺着）。
 * 它造成的后果不是「难看」，而是**静默的**：
 *   · 用 `[IO.File]::WriteAllText` / `-replace` 做的批量改写**匹配不上**（模式里是
 *     `\n`，文件里是 `\r\n`）⇒ 改写变成空操作，而脚本不会报错。当天正是这样：一次
 *     「反向验证」注入没有落地，守门照样绿，差点被读成「断言不生效」。
 *   · 源码级守门里的 `/^…$/m` 锚点会带上尾部的 `\r` ⇒ 断言假红或**假绿**。
 *     （本仓库有前科：v0.26.6 的 CRLF 正文让 `heading` 正则全数失配、静默落文末。）
 *   · 这条铁律原本只由 CI 的 `git diff --exit-code -- lib/` 间接保护 —— 那只覆盖
 *     `lib/`，`src/` 里的 CRLF 一直没人管。
 *
 * 覆盖范围：仓库里**会进 git 的文本文件**（`src/` `scripts/` `tools/` `docs/` `lib/`
 * 与根目录文件）。跳过 `node_modules`、`.git` 与二进制扩展名。
 *
 *   node scripts/verify-line-endings.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-line-endings
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Text files we ship. Anything not listed here is assumed binary and skipped. */
const TEXT_EXT = new Set(['.ts', '.mts', '.cts', '.mjs', '.cjs', '.js', '.json', '.md', '.css', '.html', '.txt', '.tid', '.yml', '.yaml', '.map', '.info', '.sh', '.ps1'])
/** Extensionless files that are still text. */
const TEXT_NAMES = new Set(['.gitattributes', '.gitignore', '.npmignore', 'LICENSE'])
/** Directories walked recursively (only the first is walked shallowly). */
const DIRS = ['src', 'scripts', 'tools', 'docs', 'lib']
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.turbo'])

/** top-level files only (package.json / AGENTS.md / README.md / …). */
function topLevelFiles() {
  return fs.readdirSync(repoRoot, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
}

/** Every text file under `dir` (recursive). */
function walk(dir) {
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full)
      } else if (entry.isFile()) {
        out.push(full)
      }
    }
  }
  return out
}

const isText = (file) => TEXT_EXT.has(path.extname(file)) || TEXT_NAMES.has(path.basename(file))

const candidates = []
for (const dir of DIRS) {
  const full = path.join(repoRoot, dir)
  if (fs.existsSync(full)) candidates.push(...walk(full))
}
for (const name of topLevelFiles()) candidates.push(path.join(repoRoot, name))

const offenders = []
let scanned = 0
for (const file of candidates) {
  if (!isText(file)) continue
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    continue
  }
  scanned += 1
  if (text.includes('\r\n')) offenders.push(path.relative(repoRoot, file).replace(/\\/g, '/'))
}

// 反向保险：这条守门自己必须真的**扫到东西**。目录名写错 / 白名单写错时它会
// 「零文件、零违规、全绿」—— 本仓库把这种失效叫「守门在空转」。
if (scanned < 50) {
  console.error(`FAIL  只扫到 ${scanned} 个文本文件 —— 守门多半坏了（目录名/白名单写错？）`)
  process.exit(1)
}

if (offenders.length > 0) {
  console.error(`FAIL  这些文件的工作区副本是 CRLF（铁律：行尾必须 LF）：\n      ${offenders.join('\n      ')}`)
  console.error('\n  修法：把 CRLF 归一成 LF 再提交（例如 PowerShell：`[IO.File]::WriteAllText($p, $t.Replace("\r\n", "\n"))`；')
  console.error('  或者 `git add --renormalize .` 后重新 checkout）。**别只改一处就完事** ——')
  console.error('  整份仓库都扫一遍，因为 .gitattributes 会让 `git diff` 看不见这个状态。')
  process.exit(1)
}

console.log(`  ok  ${scanned} 个文本文件全部 LF 行尾`)
console.log('\nLINE ENDINGS OK')

#!/usr/bin/env node
/**
 * `lib/` 与 `src/` 同步守门（v0.30.52）—— 补上**唯一一个「本地全绿、CI 才红」**的类别。
 *
 * 为什么需要它
 * ------------
 * 仓库铁律 #10「改完 `src/` 必须 `npm run build` 并提交 `lib/`」此前**只由 CI** 的
 * `.github/workflows/ci.yml` 中那段 `git diff --exit-code -- lib/` 保护 —— 本地
 * `npm run verify`（static + unit + e2e + large 四档）**一次都不查它**。
 *
 * 后果是具体发生过的：v0.30.42 那次「改完 src、跑完全量 verify、差点带着**过期的
 * lib/** 提交」，当时靠手写的一句提醒才没出事；更早还有一次 `lib/index.js.map`
 * 内嵌源文的 CRLF 让 CI 的 `git diff` 必失败。**在本仓库里，四档全绿不等于可以提交。**
 *
 * 判据为什么可以这么硬
 * --------------------
 * 构建是**逐字节可复现**的（实测两次 `npm run build` 的 `lib/index.js` SHA256 相同）。
 * 所以判据不需要任何时间戳 / 哈希清单的花招：
 *
 *   1. `npm run build`（重新生成 lib/）；
 *   2. `git status --porcelain -- lib/` **必须为空** —— 否则说明「仓库里提交的 lib/」
 *      与「当前 src/ 生成出来的 lib/」不一致，也就是**漏跑 build 或忘了提交 lib/**；
 *   3. 另外单独钉住 CI 那条 `@deepseek-ai` 运行时 import 的检查（铁律 #8），
 *      免得它继续只存在于 CI。
 *
 * ⚠️ 本守门**会写 `lib/`**（它就是靠重建来判断的）。所以：
 *   · 它只应在「准备提交」时跑（`verify:sync`，不进 `verify`/`verify:static`——
 *     那两处必须保持只读，否则守门自己就成了「静默改写工作区」的东西）；
 *   · 跑完之后 `lib/` 要么干净、要么带着**正确的**新产物，两种都是想要的终态。
 *
 *   node scripts/verify-lib-sync.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-lib-sync
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 在仓库根跑一条命令，返回 { status, stdout, stderr }（不抛，便于自己报错）。 */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' })
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

// ── 1. 重建 lib/（只读守门做不到这件事，所以本脚本明确被排除在 verify 之外）────
console.log('verify-lib-sync: 重新构建 lib/（本守门会写 lib/，这是它唯一的副作用）…')
const build = run('npm', ['run', 'build'])
if (build.status !== 0) {
  console.error(build.stdout)
  console.error(build.stderr)
  assert.fail('`npm run build` 失败 —— 先修构建，再谈 lib/ 与 src/ 是否同步')
}

// ── 2. 提交的 lib/ 必须与刚生成的一致 ────────────────────────────────────────
const status = run('git', ['status', '--porcelain', '--', 'lib/'])
assert.equal(
  status.status,
  0,
  `git status --porcelain -- lib/ 执行失败（退出码 ${status.status}）：${status.stderr.trim()}`,
)

const dirty = status.stdout.trim()
if (dirty !== '') {
  console.error(dirty)
  assert.fail(
    'lib/ 与 src/ 不同步 —— 上面这些路径就是「仓库里提交的 lib/」与「当前 src/ 生成出来的 lib/」的差异。\n' +
    '两种情况都属于本守门要拦的事故：\n' +
    '  · 改了 src/ 但忘了 `npm run build`（或 build 之后忘了把 lib/ 一起提交）；\n' +
    '  · 构建产物本身不稳定（那更要立刻查，CI 的 static job 会因为同样的理由变红）。\n' +
    '修法：跑一次 `npm run build`，然后把 lib/ 与 src/ 放在**同一个 commit** 里。',
  )
}

// ── 3. 铁律 #8：lib/*.js 不得含真实的 @deepseek-ai 运行时 import ─────────────
// CI 里有一条等价的 grep（用 `from`/`require(` 前缀正则，避免命中文案里的字符串）。
// 这里用「同一判据、同一注释理由」，让它在本地也能被第一次跑出来。
const jsFiles = fs.readdirSync(path.join(repoRoot, 'lib')).filter((f) => f.endsWith('.js'))
assert.ok(jsFiles.length > 0, 'lib/ 下没有 .js 产物 —— 构建没有真的产出东西？')
const offenders = []
for (const file of jsFiles) {
  const text = fs.readFileSync(path.join(repoRoot, 'lib', file), 'utf8')
  for (const line of text.split('\n')) {
    // 只看真实的 import/require 语句；仓库里有注释提到 @deepseek-ai，纯字符串 grep 会误报。
    if (/(from|require\()\s*['"]@deepseek-ai/.test(line)) offenders.push(`${file}: ${line.trim()}`)
  }
}
assert.deepEqual(
  offenders,
  [],
  `lib/*.js 里出现真实的 @deepseek-ai 运行时 import —— npm 镜像的 dsh-tools 会遮蔽 CLI 内置实现、搞坏 agent 循环：\n${offenders.join('\n')}`,
)

console.log(`LIB SYNC OK（lib/ 与 src/ 一致；${jsFiles.length} 个 .js 产物无 @deepseek-ai 运行时 import）`)

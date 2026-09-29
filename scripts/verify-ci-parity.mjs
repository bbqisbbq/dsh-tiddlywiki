#!/usr/bin/env node
/**
 * 「CI 跑的，本地也得跑」守门（v0.30.53）—— 防止 `verify` 与 CI **再次**漂移。
 *
 * 为什么需要它（两起真实事故，同一根因）
 * -------------------------------------
 * 这个仓库的规则一直是「**本地全绿 = 可以提交**」，但那条等式两次被证明是假的，
 * 而且两次都不是靠读文档发现的：
 *
 *   1. v0.30.52 —— CI 的 `static` job 里有 `git diff --exit-code -- lib/`（铁律 #10
 *      「改了 src 必须 build 并提交 lib」），本地 `npm run verify` 四档**一次都不查**。
 *   2. v0.30.53 —— CI 的 `selftest` job 跑 `selftest` + `smoke:client`，
 *      本地 `npm run verify` **两个都不跑**。（`AGENTS.md` §4 只写了「改核心路径跑
 *      `npm run selftest`」—— 一句没有执行者的建议。）
 *
 * 共同点：**CI 里有一步，本地没有对应物**。这正是「本地全绿、CI 才红」的唯一来源。
 * 所以本守门就钉这一件事，而且不看文档、只看两份事实：
 *
 *   · `.github/workflows/ci.yml` 里所有 `run: npm run <x>` / `npm run <x>` 形式的命令；
 *   · `package.json` 的 `scripts`。
 *
 * 判据：**CI 里出现的每一个 npm script，都必须能从本地 `npm run verify`（或
 * `verify:all`）到达** —— 要么它是 `verify` 链条的一环，要么它明写在
 * `CI_ONLY_ALLOWED` 里并写明理由（目前是空表：这个仓库不打算有「只有 CI 才跑」的检查）。
 *
 * 判据刻意做成「**按脚本名可达**」而不是「按命令逐字相同」：本地可以用聚合脚本
 * （`verify:unit` 里串 34 个 verify-*.mjs）而 CI 直接调聚合脚本，两者形式不同、
 * 覆盖面相同 —— 逐字比较会天天误报，而**可达性**才是我们真正要的不变量。
 *
 *   node scripts/verify-ci-parity.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-ci-parity
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 允许「只在 CI 跑」的脚本 —— **目前是空的，这是有意的**。
 *
 * 每一项都要写清楚「为什么本地不需要它」。这个仓库的历史教训是：一条只在 CI 的
 * 检查会安静地活很久，直到某次本地全绿却提交不上去（v0.30.52 / v0.30.53）。
 * 所以新增例外应当被当作一个需要论证的决定，而不是随手加一行。
 */
const CI_ONLY_ALLOWED = new Map([])

/** 从 CI 工作流里取出所有 `npm run <script>` 的脚本名。 */
function ciScripts(workflow) {
  const names = new Set()
  for (const m of workflow.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) names.add(m[1])
  return names
}

/**
 * 展开一个聚合脚本：`a && b && c` / `npm run x` 都要能追进去。
 * 返回从该脚本出发**可达的全部脚本名**（含自身）。
 */
function expand(scripts, entry, seen = new Set()) {
  if (seen.has(entry)) return seen
  seen.add(entry)
  const body = scripts[entry]
  if (typeof body !== 'string') return seen
  for (const m of body.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) expand(scripts, m[1], seen)
  return seen
}

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const scripts = pkg.scripts ?? {}
const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8')

const wanted = ciScripts(workflow)
// 反空转保险：解析器坏掉时 wanted 会是空的，断言就「全过」了 —— 本仓库反复踩过这个。
assert.ok(wanted.size >= 5, `从 ci.yml 只解析出 ${wanted.size} 个 npm script —— 解析器坏了？`)

// 本地覆盖面：verify（CI 等价物）+ verify:all（提交前的完整扫一遍）。
const local = new Set([...expand(scripts, 'verify'), ...expand(scripts, 'verify:all')])
assert.ok(local.size >= 5, `从 package.json 只展开出 ${local.size} 个本地脚本 —— verify 链条坏了？`)

const missing = [...wanted].filter((name) => !local.has(name) && !CI_ONLY_ALLOWED.has(name)).sort()
assert.deepEqual(
  missing,
  [],
  'CI 里跑了这些 npm script，但本地 `npm run verify` / `npm run verify:all` 到不了它们：\n' +
  `  ${missing.join(', ')}\n` +
  '两种情况都属于本守门要拦的漂移：\n' +
  '  · 新加了一步 CI 检查却没接进本地 ⇒ **本地全绿不再等于可提交**（v0.30.52 / v0.30.53 各一次）；\n' +
  '  · 本地 verify 链条被改动时把某一步挤掉了。\n' +
  '修法：把它接进 `verify`（或 `verify:all`）；确实只能 CI 跑的，加进本脚本的 CI_ONLY_ALLOWED 并写明理由。',
)

// 反向：verify 里串的每个脚本都必须真实存在，且不得指向 CI_ONLY_ALLOWED 之外的死名。
const dangling = [...local].filter((name) => typeof scripts[name] !== 'string').sort()
assert.deepEqual(dangling, [], `本地 verify 链条引用了不存在的 script：${dangling.join(', ')}`)

console.log(
  `CI PARITY OK（CI 需要 ${wanted.size} 个 npm script，本地 verify/verify:all 覆盖面 ${local.size} 个，零缺口）`,
)

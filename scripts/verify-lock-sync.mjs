#!/usr/bin/env node
/**
 * `package-lock.json` 与 `package.json` 同步守门（v0.30.54）—— 铁律 #12 的执行者。
 *
 * 为什么需要它
 * ------------
 * 铁律 #12 原文：「**`package-lock.json` 必须与 `package.json` 同步** —— 用官方源
 * 重新生成后 `npm ci --dry-run` 自检；lock 脏会让 `npm ci` 秒红、**连带三个 job 不跑**。」
 *
 * 也就是说：这条规则**自己的文档里写明了**后果（CI 的其余三个 job 全被 `static`
 * 的 `npm ci` 挡死），但它的执行方式一直是「**记得手工跑一下**」——`npm ci --dry-run`
 * 既慢、又会碰网络，于是没人会在每次提交前跑。这与 v0.30.52（`lib/` 同步只有 CI）
 * 和 v0.30.53（`selftest` 只有 CI）是同一类：**规则是对的，但没有执行者**。
 *
 * 本脚本把**不需要网络也能查的部分**全部查掉，作为 `verify:static` 的第一道网。
 * 剩下的（「从零安装能否成功」）本来就只有 `npm ci` 能回答，交给 CI。
 *
 * 查什么（都只看两个 JSON，**零网络、零磁盘副作用**）
 * --------------------------------------------------
 *   1. **版本三处一致**：`package.json.version` == `package-lock.json.version`
 *      == `package-lock.json.packages[""].version`。发版时这三处要一起改，
 *      漏一处 `npm ci` 就会报 `lock file does not satisfy`。
 *   2. **lockfileVersion** 必须是 npm 当前支持的（3 / 2）；`1` 是 npm 6 的老格式。
 *   3. **名字一致**：`package-lock.name` == `package.json.name`。
 *   4. **声明的依赖集合与 lock 的根包记录一致**（dependencies / devDependencies /
 *      peerDependencies / optionalDependencies 四项逐个比）。
 *   5. **每个声明的依赖在 lock 的 `node_modules/<name>` 里都有实体条目**，
 *      而且 **locked 的版本满足声明的 range** —— 这一条是 `npm ci` 最容易当场炸的地方
 *      （改了 `package.json` 的范围却没重生成 lock ⇒ lock 里的版本已经不满足新范围）。
 *      range 满足性用 semver 判定；`*` / `latest` / git / file: 这类非 semver 范围跳过。
 *   6. **lock 里没有「幽灵根依赖」**：根包记录了依赖、但 `package.json` 里已删掉。
 *
 * ⚠️ 它**不**试图替代 `npm ci`：真正的「全量可解析性」只有 `npm ci` 能验（需要网络）。
 * 上面 6 条是「**改了 package.json 忘了重生成 lock**」这一类事故的完整形状。
 *
 *   node scripts/verify-lock-sync.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-lock-sync
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'))

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

/** 反空转保险：两个文件都解析失败时下面的断言会「全过」—— 先钉住基本形状。 */
assert.equal(typeof pkg.name, 'string', 'package.json 缺 name')
assert.equal(typeof pkg.version, 'string', 'package.json 缺 version')
assert.equal(typeof lock.packages, 'object', 'package-lock.json 缺 packages —— lockfileVersion 太老？')
const root = lock.packages['']
assert.equal(typeof root, 'object', 'package-lock.json 的 packages[""] 不存在')

// ── 1. 版本三处一致 ────────────────────────────────────────────────────────
assert.equal(
  lock.version,
  pkg.version,
  `package-lock.json 顶层 version（${lock.version}）与 package.json（${pkg.version}）不一致 —— 发版时三处要一起改`,
)
assert.equal(
  root.version,
  pkg.version,
  `package-lock.json 的 packages[""].version（${root.version}）与 package.json（${pkg.version}）不一致`,
)

// ── 2. lockfileVersion ────────────────────────────────────────────────────
assert.ok(
  typeof lock.lockfileVersion === 'number' && lock.lockfileVersion >= 2,
  `lockfileVersion 是 ${lock.lockfileVersion} —— 需要 2 或 3（npm 7+）。1 是 npm 6 的老格式`,
)

// ── 3. 名字一致 ───────────────────────────────────────────────────────────
assert.equal(lock.name, pkg.name, `package-lock.json 的 name（${lock.name}）与 package.json（${pkg.name}）不一致`)

// ── 4/6. 依赖集合一致（两个方向都查）─────────────────────────────────────
const problems = []
for (const field of DEP_FIELDS) {
  const declared = Object.keys(pkg[field] ?? {}).sort()
  const lockedKeys = Object.keys(root[field] ?? {}).sort()
  const onlyDeclared = declared.filter((n) => !lockedKeys.includes(n))
  const onlyLocked = lockedKeys.filter((n) => !declared.includes(n))
  if (onlyDeclared.length > 0) problems.push(`${field}: 只在 package.json 里（lock 漏了）：${onlyDeclared.join(', ')}`)
  if (onlyLocked.length > 0) problems.push(`${field}: 只在 lock 里（package.json 已删）：${onlyLocked.join(', ')}`)
  // 范围本身也应当一致 —— 同一个依赖写出两个范围，多半是手改了 lock
  for (const name of declared) {
    if (!lockedKeys.includes(name)) continue
    if (pkg[field][name] !== root[field][name]) {
      problems.push(`${field}.${name}: 范围不一致（package.json=${pkg[field][name]} / lock=${root[field][name]}）`)
    }
  }
}
assert.deepEqual(problems, [], `package.json 与 package-lock.json 的依赖记录不一致：\n  ${problems.join('\n  ')}`)

// ── 5. 每个依赖都有实体条目，且 locked 版本满足声明的 range ──────────────────
// semver 是 devDependency（transitive 也可）；拿不到就跳过这一条并**明说**，
// 而不是静默当成通过 —— 本仓库吃过「守门读空 = 断言全过」的亏。
let semver = null
try {
  semver = (await import('semver')).default ?? (await import('semver'))
} catch {
  console.warn('verify-lock-sync: 拿不到 semver，跳过「版本满足范围」这一条（其余检查照跑）')
}

const versionProblems = []
for (const field of DEP_FIELDS) {
  for (const [name, range] of Object.entries(pkg[field] ?? {})) {
    const entry = lock.packages[`node_modules/${name}`]
    if (entry === undefined) {
      versionProblems.push(`${name}: package.json 声明了（${field}），但 lock 的 node_modules 里没有实体条目`)
      continue
    }
    if (semver === null) continue
    // 非 semver 范围（git / file: / * / workspace: / npm: 别名）交给 npm 自己判断。
    if (!semver.validRange(range)) continue
    if (!semver.satisfies(entry.version, range, { includePrerelease: true })) {
      versionProblems.push(`${name}: lock 里的 ${entry.version} 不满足 package.json 的范围 ${range}（改了范围没重生成 lock）`)
    }
  }
}
assert.deepEqual(
  versionProblems,
  [],
  'lock 里的解析结果与 package.json 的声明对不上 —— `npm ci` 会当场报 lock file does not satisfy：\n' +
  `  ${versionProblems.join('\n  ')}`,
)

const checked = DEP_FIELDS.reduce((n, f) => n + Object.keys(pkg[f] ?? {}).length, 0)
console.log(
  `LOCK SYNC OK（版本三处一致 · lockfileVersion ${lock.lockfileVersion} · ${checked} 个依赖的集合/范围/实体条目全部对得上${semver === null ? ' · 版本满足性已跳过' : ''}）`,
)

#!/usr/bin/env node
/**
 * `lib/index.js` 公共面守门（v0.30.49）。
 *
 * WHY THIS EXISTS
 * ---------------
 * v0.30.42 与 v0.30.48 各踩过一次同一个坑：`src/index.ts` 的 **barrel 段里的
 * 再导出被误删**，而 `npm run typecheck` / `verify:unit` / `verify:static`
 * **全绿** —— 因为那些名字在本仓库内部（`src/` 下）没有任何消费者，它们是给
 * `lib/index.js` 的**外部**使用者（`scripts/*.mjs`、以及 npm 下游用户）准备的。
 *
 * 两次都是靠人肉 `git diff` / 跑 e2e 才发现的：
 *   - v0.30.42：误删 `export { MARKDOWN_PLUGIN }`（零消费者、零守门）；
 *   - v0.30.48：`noUnusedLocals` 驱动清理时删掉了 `writeLocationState` 的
 *     **import**，而 barrel 用 `export { … } from './host/wiki-location.ts'`
 *     写成了一条独立语句 —— 于是 `lib/index.js` 不再导出它，
 *     `scripts/verify-wiki-switch.mjs` 在 **e2e** 阶段才崩：
 *     `does not provide an export named 'writeLocationState'`。
 *
 * 这条守门把「公共面还在不在」变成机器可判的：**凡是本仓库的脚本从
 * `../lib/index.js` 具名导入的符号，`src/index.ts` 必须真的导出它。**
 * 字段/方法名不查（只查顶层具名导出），类型用 `import type` 的也一并要求 ——
 * 发布出去的 `src/` 也要能编译。
 *
 * 副作用（有意）：它同时挡住了「搬迁时把 barrel 行换成 import 行」——
 * 那种情况下名字还在、但**不再是导出**，而只看文本存在性的守门会放行，
 * 所以这里解析的是 `export { … }` / `export <decl>`，**不是**「出现过这个名字」。
 *
 *   node scripts/verify-index-barrel.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-index-barrel
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 具名导出的名字集合：`export { a, b as c }` + `export const/function/class/interface/type X`。
 *
 * ⚠️ **先剥注释**（v0.30.49 实测踩到）：本条守门的第一版直接按 `,` 切 export 列表，
 * 而列表里恰好有一段解释性注释，注释内的**逗号**把相邻的名字切碎、注释内的**右花括号**
 * 还会提前终止整个列表 —— 症状是「源码明明导出了，守门却报缺」。这与本仓库
 * v0.30.45（注释让断言假绿）是同一族：**对源码文本做结构断言，先剥注释**。
 * 顺序照旧：先剥行注释、再剥块注释（v0.30.14 写反过一次）。
 */
const stripComments = (src) =>
  src.replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '')

function exportedNames(rawSource) {
  const source = stripComments(rawSource)
  const names = new Set()
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      // `type Foo` / `Foo as Bar` — 取**对外可见**的那个名字（`as` 之后）。
      const bare = part.replace(/^\s*(?:type\s+)?/, '').trim()
      if (bare === '') continue
      const [first, second] = bare.split(/\s+as\s+/)
      names.add((second ?? first).trim())
    }
  }
  for (const m of source.matchAll(/export\s+(?:declare\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(m[1])
  }
  return names
}

/** 每个 `scripts/*.mjs` 从 `../lib/index.js` 具名导入的符号。 */
function importedFromLib(rawSource) {
  const source = stripComments(rawSource)
  const names = new Set()
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/lib\/index\.js'/g)) {
    for (const part of m[1].split(',')) {
      const bare = part.replace(/^\s*(?:type\s+)?/, '').trim()
      if (bare === '') continue
      const [first, second] = bare.split(/\s+as\s+/)
      names.add((first ?? '').trim() || (second ?? '').trim())
    }
  }
  return names
}

const indexSource = fs.readFileSync(path.join(repoRoot, 'src/index.ts'), 'utf8')
const exported = exportedNames(indexSource)

const scriptFiles = fs.readdirSync(path.join(repoRoot, 'scripts')).filter((f) => f.endsWith('.mjs'))
const needed = new Set()
for (const file of scriptFiles) {
  const source = fs.readFileSync(path.join(repoRoot, 'scripts', file), 'utf8')
  for (const name of importedFromLib(source)) needed.add(name)
}

// 反空转保险：解析器一旦坏掉，两条集合都会是空的，断言就「全过」了 ——
// 这正是本仓库反复踩的「守门读空 = 断言全过」。所以先钉住规模。
assert.ok(exported.size >= 100, `解析 src/index.ts 只得到 ${exported.size} 个导出 —— 解析器坏了？`)
assert.ok(needed.size >= 50, `解析 scripts/ 只得到 ${needed.size} 个具名导入 —— 解析器坏了？`)

const missing = [...needed].filter((name) => !exported.has(name)).sort()
assert.deepEqual(
  missing,
  [],
  `这些名字被 scripts 从 lib/index.js 导入，但 src/index.ts 已不再导出它们（barrel 缺口）：${missing.join(', ')}\n` +
  '搬迁时请把 barrel 的 `export { … } from \'./host/…\'` 行的名字搬迁也一并补上 —— ' +
  'typecheck / verify:unit / verify:static 都看不见这种丢失。',
)

// ── 第二道：**完整公共面的棘轮**（v0.30.51）──────────────────────────────────
//
// 上面那道只守「本仓库脚本用得到的」导出（175 个）。而 barrel 一共导出 ~290 个，
// 剩下的**没有任何消费者** —— 它们的存在意义是「npm 下游 / 未来的调用方」。
// v0.30.42 就是这么丢掉 `MARKDOWN_PLUGIN` 的：零消费者 ⇒ 零报错 ⇒ 只有人肉
// `git diff` 能发现。同一类事故在 v0.30.48 又发生一次（`writeLocationState`，
// 那次恰好在 scripts 里有消费者、被第一道守门逮住）。
//
// 所以这里再加一道**只增不减的棘轮**：把当前导出的完整名单快照进
// `scripts/index-barrel-surface.json`，之后
//   - **少了一个名字** ⇒ 红（并点名），这是我们要拦的事故；
//   - **多了一个名字** ⇒ 也红，提示把它加进快照 —— 因为「公共面悄悄变大」
//     同样应当是一次**有意识的**决定（否则 barrel 会慢慢长出没人负责的 API）。
//
// ⚠️ 只比**名字集合**，不比每个名字从哪里来 —— 搬迁（换来源模块）本来就是允许的。
const surfaceFile = path.join(repoRoot, 'scripts/index-barrel-surface.json')

// `--update-surface` 必须在「快照不存在」的检查**之前**处理 —— 否则首次生成会
// 被自己的存在性断言拦住（本版实测）。
if (process.argv.includes('--update-surface')) {
  const next = { note: 'src/index.ts 的具名导出公共面（只增不减的棘轮；由 scripts/verify-index-barrel.mjs 守门）', exports: [...exported].sort() }
  fs.writeFileSync(surfaceFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  console.log(`INDEX BARREL SURFACE UPDATED（写入 ${next.exports.length} 个名字）`)
  process.exit(0)
}

if (!fs.existsSync(surfaceFile)) {
  assert.fail(`缺少公共面快照 ${path.relative(repoRoot, surfaceFile)} —— 用 node scripts/verify-index-barrel.mjs --update-surface 生成`)
}
const snapshot = JSON.parse(fs.readFileSync(surfaceFile, 'utf8'))
assert.ok(Array.isArray(snapshot.exports) && snapshot.exports.length >= 100,
  '公共面快照格式不对或为空（应当是 { exports: [...] } 且至少 100 项）')

const previous = new Set(snapshot.exports)
const dropped = snapshot.exports.filter((name) => !exported.has(name)).sort()
const added = [...exported].filter((name) => !previous.has(name)).sort()
assert.deepEqual(
  dropped,
  [],
  `这些名字从 src/index.ts 的公共面上消失了：${dropped.join(', ')}\n` +
  '它们在本仓库里**没有消费者**（所以编译器和别的守门都不会响），但下游可能正在用。\n' +
  '如果这是有意的移除，请在同一个 commit 里跑 `node scripts/verify-index-barrel.mjs --update-surface` 更新快照。',
)
assert.deepEqual(
  added,
  [],
  `公共面上新增了这些名字：${added.join(', ')}\n` +
  '新增公共 API 应当是有意识的决定 —— 确认后跑 `node scripts/verify-index-barrel.mjs --update-surface`。',
)

console.log(`INDEX BARREL OK（scripts 需要 ${needed.size} 个具名导出；公共面快照 ${snapshot.exports.length} 个，当前导出 ${exported.size} 个）`)

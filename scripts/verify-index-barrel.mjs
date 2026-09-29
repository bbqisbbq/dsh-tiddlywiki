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

console.log(`INDEX BARREL OK（scripts 需要 ${needed.size} 个具名导出，src/index.ts 导出 ${exported.size} 个）`)

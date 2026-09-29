#!/usr/bin/env node
/**
 * 「共享写策略」的**调用点守门**（v0.30.32）。
 *
 * 铁律 #2：所有写路径必须「先读旧条目、再走共享写策略」（`get` → `buildWriteTiddler()`）。
 * `AGENTS.md` 与 `src/host/write-policy.ts` 的模块头都写了这条规则的**例外清单**，但
 * 规则只写在文档里 ⇒ 下一个人（或下一次审计）必然重新发现同一个「问题」。
 * 本脚本把那句话变成可执行断言。
 *
 * ## 判据是「这次 PUT 的 body 从哪来」，不是文件名或行数
 *
 * - `const { tiddler } = buildWriteTiddler(…)` 之后 `client.put(tiddler)` —— **合规**，
 *   这就是共享写策略本身（审计曾把它误算成「绕过」，于是「21 个文件绕过」那个数字大半是假的）。
 * - `client.put({ … })` —— **手拼 body**：TW 的 PUT 是整体替换，会静默丢掉自定义字段。
 *
 * 所以本脚本只钉这一种形态：**`client.put(` 后面直接跟一个对象字面量** `{`。
 * 变量、函数返回值（`tiddler`）、模板等都算合规。
 *
 * 例外清单是**自清洁**的：清单里列出的东西必须真的还在（否则说明它已经合规了，
 * 该删清单条目 —— 红），清单外出现新的手拼 body 也红。
 *
 *   node scripts/verify-write-call-sites.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-write-call-sites
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures++
    console.error(`  FAIL  ${name}\n        ${err instanceof Error ? err.message : err}`)
  }
}

/** 手拼 body 的形态：`client.put(` 紧跟对象字面量。 */
const HAND_BUILT = /client\.put\(\s*\{/g

function collectHandBuilt() {
  const found = new Map()
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      const rel = path.relative(repoRoot, full).split(path.sep).join('/')
      const src = fs.readFileSync(full, 'utf8')
      const hits = [...src.matchAll(HAND_BUILT)].length
      if (hits > 0) found.set(rel, hits)
    }
  }
  walk(path.join(repoRoot, 'src'))
  return found
}

/**
 * 例外**清单**。两类（与 `write-policy.ts` 模块头逐字对应）：
 *  (1) 我们完全拥有内容的条目 —— 读一遍没有信息量；
 *  (2) flush 探针 —— 它的用途就是给一次写入计时，读-改-写会改变时序语义。
 */
const ALLOWED = [
  {
    label: 'seed 家族（内置内容 / seed marker）',
    match: /^src\/host\/seeds?(-[a-z-]+)?\.ts$/,
    why: '例外类 ①：写的是模板自带 tags 的**内置内容**，或我们自己算好的 marker —— 不是「基于用户条目改写」',
  },
  {
    label: 'seeds-flush.ts 的 flush 探针',
    match: /^src\/host\/seeds?-flush\.ts$/,
    why: '例外类 ②：探针的唯一用途是给一次写入计时并轮询落盘，读-改-写会引入额外往返、改变时序语义',
  },
  {
    label: 'session-summary.ts 的 $:/temp 汇总',
    match: /^src\/host\/session-summary\.ts$/,
    why: '例外类 ①：volatile、内容完全由我们现算',
  },
  {
    label: 'routes-helpers.ts 的 TW 草稿写入',
    match: /^src\/host\/routes-helpers\.ts$/,
    why: '例外类 ①+特例：草稿是**编辑器缓冲**，必须显式构造（正文来自请求、`created` 继承原笔记），**不能**以原条目为基底 —— 以基底写会把笔记的 tags/自定义字段复制进草稿',
  },
  {
    label: 'config.ts 的配置 tiddler（ConfigStore）',
    match: /^src\/host\/config\.ts$/,
    why: '例外类 ①+特例：`ConfigStore` 有自己的合并语义（存的是补丁后的整份配置），改前需确认与「保留自定义字段」不冲突 —— 见 wiki 待办笔记',
  },
]

check('手拼 body 的调用点只出现在例外清单里', () => {
  const found = collectHandBuilt()
  const unexpected = [...found.entries()].filter(([rel]) => !ALLOWED.some((a) => a.match.test(rel)))
  if (unexpected.length > 0) {
    throw new Error(
      `清单外出现手拼 body（铁律 #2）：\n${unexpected
        .map(([rel, n]) => `          ${rel}（${n} 处）`)
        .join('\n')}\n        要么改成 get → buildWriteTiddler()，要么在例外清单里写明理由`,
    )
  }
})

check('例外清单自清洁（列了就必须真的还在）', () => {
  const found = collectHandBuilt()
  const stale = ALLOWED.filter((a) => ![...found.keys()].some((rel) => a.match.test(rel)))
  if (stale.length > 0) {
    throw new Error(
      `清单里有已经不成立的条目（那里已经合规了，请删掉清单项）：\n${stale
        .map((a) => `          ${a.label}`)
        .join('\n')}`,
    )
  }
})

check('例外清单的每一项都写明了理由', () => {
  for (const a of ALLOWED) {
    if (typeof a.why !== 'string' || a.why.trim().length < 10) throw new Error(`${a.label} 缺少 why`)
  }
})

if (failures > 0) {
  console.error(`\nWRITE CALL SITES FAILED (${failures})`)
  process.exit(1)
}
const summary = [...collectHandBuilt().entries()].map(([rel, n]) => `${rel}(${n})`).join(' · ')
console.log(`\nWRITE CALL SITES OK（手拼 body ${collectHandBuilt().size} 个文件，全部在例外清单内：${summary}）`)

#!/usr/bin/env node
/**
 * 数值配置项的「同一组数字只有一份」守门（v0.30.16）——**源码级**、秒级完成、不 spawn TW。
 *
 * 为什么需要它：每个数值配置项会用到**两到三组数字**，各自决定一件不同的事 ——
 *   ① 宿主 `config.ts` 的 `NUMBER_CONFIG_RANGES`：保存时**夹取**到哪里；
 *   ② 客户端设置页表单的 `min` / `max`：**允许填**什么；
 *   ③ 设置页在「还没配置过」时回显的默认值。
 * 只改一处就会重现本仓库反复记录的那个症状 —— **设置页显示的值 ≠ 真正生效的值**
 * （表单允许填到 1000、宿主静默夹到 200；或者默认回显 8618 而宿主默认已经换成了别的端口）。
 * 这类问题的难点在于**没有任何报错**：夹取是静默的，回显也是照抄的。
 *
 * 所以这里刻意只做「**比对数字**」，不做字符串匹配：
 *   1. 两侧的**键集合必须完全相同**（新加一个可夹取路径却没给表单字段，或者反过来）；
 *   2. 每个键的 `[min, max]` **数值**必须相同 —— 宿主侧允许写**导出常量**，
 *      守门会把常量解析成数值，所以 `READY_TIMEOUT_MIN_MS` 这种「只有一处定义」的
 *      写法不会被这条守门逼回字面量（那正是它要鼓励的方向）；
 *   3. 每个键的默认回显必须等于宿主 `DEFAULTS` 里的默认值（同样允许写常量）。
 *
 *   node scripts/verify-config-ranges.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-config-ranges
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFamily } from './lib/source-family.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 按**模块族**读（拆分/搬家不该让这条守门假红）。 */
const read = (rel) => readFamily(repoRoot, rel.replace(/\.ts$/, ''))

const CONFIG = read('src/host/config.ts') // ① 夹取表
const CLIENT = read('src/client/settings-page-config.ts') // ②③ 表单区间 + 默认回显
const CORE = read('src/index.ts') // DEFAULTS + 导出常量（CLIP_BRIDGE_DEFAULT_PORT）
const POLICY = read('src/host/ready-policy.ts') // READY_TIMEOUT_*

let failures = 0
function test(name, fn) {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures++
    console.error(`FAIL  ${name}\n      ${err && err.message ? err.message : err}`)
  }
}

const num = (text) => Number(String(text).replace(/_/g, ''))

/**
 * 取 `const <declaration>` 后面那个对象字面量的**体**（数花括号配对）。
 *
 * 不能靠「找第一个 `}`」：DEFAULTS 里有嵌套对象（`ui.sendToAgent`、`ui.allArticles`），
 * 更不能对整个文件跑正则 —— 同名的**类型声明**（`debounceMs: number`、
 * `port: number`）会先被匹配到，于是守门会拿「类型」当「默认值」比，还比得过。
 */
function objectBody(source, declaration) {
  const at = source.indexOf(declaration)
  assert.ok(at >= 0, `源码里找不到 ${declaration}`)
  const from = source.indexOf('{', at)
  assert.ok(from > at, `${declaration} 后面没有对象字面量`)
  let depth = 0
  let i = from
  for (; i < source.length; i++) {
    const c = source[i]
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) break
    }
  }
  assert.ok(depth === 0, `${declaration} 的花括号配对失败`)
  return source.slice(from + 1, i)
}

/** 宿主侧导出的数值常量（`export const X = 1234`），用于把常量名解析成数字。 */
const CONSTS = new Map()
for (const source of [CORE, POLICY]) {
  for (const m of source.matchAll(/export const ([A-Z][A-Z0-9_]*) = ([\d_]+)/g)) CONSTS.set(m[1], num(m[2]))
}

/** 宿主侧一个区间/默认值 token：数字字面量，或一个**能解析出**的导出常量。 */
function resolveToken(token, where) {
  const raw = String(token).trim()
  if (/^[\d_]+$/.test(raw)) return num(raw)
  assert.ok(CONSTS.has(raw), `${where} 里的 ${raw} 既不是数字也不是能解析的导出常量（把它的定义放进 src/index.ts 或 ready-policy.ts）`)
  return CONSTS.get(raw)
}

/** ① 宿主夹取表：`'path': [min, max]`（只取 NUMBER_CONFIG_RANGES 那一段）。 */
const RANGES_BLOCK = objectBody(CONFIG, 'NUMBER_CONFIG_RANGES')
const hostRanges = new Map()
for (const m of RANGES_BLOCK.matchAll(/'([\w.]+)':\s*\[([^\]]+)\]/g)) {
  const parts = m[2].split(',').map((s) => s.trim())
  assert.equal(parts.length, 2, `NUMBER_CONFIG_RANGES 里 ${m[1]} 必须写成 [min, max]`)
  hostRanges.set(m[1], [resolveToken(parts[0], `${m[1]} 下界`), resolveToken(parts[1], `${m[1]} 上界`)])
}

/** ② 设置页表单：`numField('path', …, { min: X, max: Y … })`。 */
const clientRanges = new Map()
for (const m of CLIENT.matchAll(/numField\('([\w.]+)'[\s\S]{0,400}?min:\s*([\d_]+),\s*max:\s*([\d_]+)/g)) {
  clientRanges.set(m[1], [num(m[2]), num(m[3])])
}

/** ③ 设置页的默认回显：`… ? <值> : <数字>, {`（该字段还没配置过时显示的默认值）。 */
const ECHO_SOURCE = {
  'bridge.port': /'bridge\.port'[\s\S]{0,300}?:\s*([\d_]+),\s*\{/,
  'git.debounceMs': /'git\.debounceMs'[\s\S]{0,300}?:\s*([\d_]+),\s*\{/,
  'startup.readyTimeoutMs': /'startup\.readyTimeoutMs'[\s\S]{0,300}?:\s*([\d_]+),\s*\{/,
  'ui.allArticles.pageSize': /'ui\.allArticles\.pageSize'[\s\S]{0,300}?:\s*([\d_]+),\s*\{/,
}

test(`宿主夹取表与设置页表单一一对应（${hostRanges.size} 个数值字段）`, () => {
  assert.ok(hostRanges.size >= 4, `只解析出 ${hostRanges.size} 个数值区间 —— 解析器多半坏了（少了就是「静默不检查」）`)
  const hostKeys = [...hostRanges.keys()].sort()
  const clientKeys = [...clientRanges.keys()].sort()
  assert.deepEqual(
    clientKeys,
    hostKeys,
    `两侧键集合不一致：只宿主有=${hostKeys.filter((k) => !clientRanges.has(k)).join(',') || '无'}；只表单有=${clientKeys.filter((k) => !hostRanges.has(k)).join(',') || '无'}`,
  )
})

test('每个数值字段的 min/max 两侧数值相同（夹取边界 == 表单边界）', () => {
  for (const [key, [hostMin, hostMax]] of hostRanges) {
    const pair = clientRanges.get(key)
    assert.ok(pair !== undefined, `设置页缺 ${key} 的数值字段`)
    const [clientMin, clientMax] = pair
    assert.equal(clientMin, hostMin, `${key}：表单 min=${clientMin} ≠ 宿主夹取下界=${hostMin}（表单会放行一个宿主随后静默改掉的数）`)
    assert.equal(clientMax, hostMax, `${key}：表单 max=${clientMax} ≠ 宿主夹取上界=${hostMax}（表单会拒绝一个宿主其实接受的数）`)
  }
})

test('设置页的默认回显 == 宿主 DEFAULTS 的默认值', () => {
  const defaults = objectBody(CORE, 'const DEFAULTS')
  const hostDefault = {
    'bridge.port': /bridge:\s*\{[^}]*\bport:\s*([A-Za-z_]\w*|[\d_]+)/,
    'git.debounceMs': /\bdebounceMs:\s*([A-Za-z_]\w*|[\d_]+)/,
    'startup.readyTimeoutMs': /startup:\s*\{[^}]*\breadyTimeoutMs:\s*([A-Za-z_]\w*|[\d_]+)/,
    'ui.allArticles.pageSize': /allArticles:\s*\{[^}]*\bpageSize:\s*([A-Za-z_]\w*|[\d_]+)/,
  }
  for (const [key, re] of Object.entries(hostDefault)) {
    const found = re.exec(defaults)
    assert.ok(found !== null, `宿主 DEFAULTS 里找不到 ${key} 的默认值`)
    const expected = resolveToken(found[1], `${key} 宿主默认值`)
    const echoRe = ECHO_SOURCE[key]
    assert.ok(echoRe !== undefined, `守门没为 ${key} 准备回显正则`)
    const echo = echoRe.exec(CLIENT)
    assert.ok(echo !== null, `设置页里找不到 ${key} 的默认回显（该字段还没配置时显示什么？）`)
    assert.equal(num(echo[1]), expected, `${key}：设置页回显=${num(echo[1])} ≠ 宿主默认=${expected}（用户看到的默认值不是真正会生效的那个）`)
  }
})

console.log(failures === 0 ? '\nCONFIG RANGES OK' : `\nCONFIG RANGES FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

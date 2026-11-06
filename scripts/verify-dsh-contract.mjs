#!/usr/bin/env node
/**
 * 宿主契约守门：我们注册的**每一个客户端座位**，都必须真的存在于当前 DSH 里（v0.31.0）。
 *
 * WHY THIS EXISTS
 * ---------------
 * v0.28.8 给「新会话选库」挂的座位叫 `conversation.input.selector.context`，抄自
 * 当时的一个第三方参考实现。它**在 DSH 0.2.1 里根本不存在** —— 宿主座位表里没有，
 * 随包 client bundle 里连这个字符串都搜不到（0.2.2-rc.1 复核：仍然没有）。于是那次
 * 改动一直是死代码：注册永远等不到声明，用户看不到任何报错，代码却安静地躺在仓库里
 * 跑了十几个版本。
 *
 * 这类事故的共性是：**宿主的座位表是外部契约，而我们的守门全是「读自己的源码」**。
 * 自己跟自己比永远绿。所以这里把宿主当成被测对象：读出宿主**自己**的座位目录，
 * 再反过来断言我们注册的每个 name 都在里面、kind 也对得上。
 *
 * 数据来源（宿主自带的座位契约目录，不是我们猜的）
 * ----------------------------------------------
 * `@deepseek-ai/dsh-cordis-client-runner/lib/client.js` 里内嵌了一张
 * `{ key, kind, scope, summary, doc, registerOptions, occupants, replaceRisk }`
 * 的座位表（DSH 自己用它做插件开发时的 Slots 内省）。`kind` 有
 * `single | list | keyed | chain | (原样)`，`scope` 有 `root | session | session-maybe`。
 * 同一个文件里 `tool.call.toolview` 的 `keyDomain` 还列出了**已被官方占用**的
 * 工具名 —— 我们那 17 个 `tool.call.toolview` key 一个都不能撞。
 *
 * 宿主在哪
 * --------
 * 1. `DSH_CONTRACT_SOURCE` 环境变量（asar 路径或 client.js 路径），调试用；
 * 2. 桌面版：`process.execPath` 旁边的 `resources/app.asar`（Win/Linux）或
 *    `../Resources/app.asar`（macOS）；
 * 3. 装了 profile 的 CLI：`$DSH_HOME/profiles/<name>/node_modules/@deepseek-ai/…`。
 *
 * 找不到宿主 ⇒ **打印 SKIPPED 并退出 0**。这条守门只在「本机装了 DSH」时才有意义，
 * 不能因为 npm 用户在别的机器上 clone 就跑红。
 *
 * 反向验证（修「常量间接传递漏采」时实测，两种破坏都必须变红）
 * -------------------------------------------------------------------
 * 注入在**镜像树**里做（把本脚本 + `src/client` + `package.json` 拷到临时目录，
 * 保持同样的相对布局跑），因为 `src/client/` 常有并发改动，不值得为验证去碰它。
 *
 *   ① 把一个座位名改成宿主没有的名字
 *      `src/client/index.ts` 的 `'conversation.input.dock'` → `'…dock.typo'`
 *      ⇒ FAIL「我们注册的每个座位都存在于宿主座位表里」，点名 `…dock.typo`，退出码 1
 *   ② 只改常量定义名、不改使用点（让常量解析路径失效）
 *      `src/client/tid-parse.ts` 的 `TID_PREVIEW_SLOT` → `TID_PREVIEW_SLOT_RENAMED`
 *      ⇒ FAIL「常量间接传递的座位也被采到（sidebar.right.tab.document）」，退出码 1
 *
 * ② 是这次修复的**真正判据**：在修之前，常量解析失效只会让采集结果少一个名字，而
 * 「座位存在于宿主」对它没采到的名字永远是绿的 —— 静默漏采正是这条守门存在的理由。
 * ① 证明断言本身仍然有效。
 *
 * ⚠️ 为什么②要有**点名断言**、不能只靠「座位数下限」：下限是 7，而座位数会随并行
 * 开发变成 8、9…… 一旦总数 ≥8，少掉一个正好落回 7、下限照样绿。实测过一次：队友
 * 并行加了 `settings.section.icon` 之后，只改常量定义名时只有点名断言变红、下限那条
 * 是绿的。所以两条都要，判据不能只有一个。
 *
 * 已知局限（写在这里免得下次当成 bug 查）：常量表只按「值里带点」筛，所以像
 * `dsh-tiddlywiki.session-wiki` 这种**带点的 id 常量**也会进表。它只有在被写成
 * `name: <该常量>` 时才会误采，而误采会被「座位存在于宿主」当场判红（宿主没有这个
 * 名字）—— 故障方向是**响亮**的，不是静默的，因此可以接受。
 *
 *   node scripts/verify-dsh-contract.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-dsh-contract
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNNER_SUFFIX = 'dsh-cordis-client-runner/lib/client.js'
/** 座位表至少这么多条 —— 少于它就是解析失败，宁可红也不要"看起来一切正常"。 */
const MIN_CATALOGUE_ENTRIES = 80

/**
 * 我们自己必须采集到的座位数下限 —— 防的是「采集器悄悄少采一个」。
 *
 * 少了它就是两种可能之一，两种都该红：① 真的删了一个座位（那是有意识的决定，
 * 请同步这个数字）；② 采集器又漏了一种引用形式（`sidebar.right.tab.document` 那次就是）。
 * 加座位时不用改；删座位时才改。
 *
 * ⚠️ 这个下限**只能抓住"少采"**，抓不住"少了一个恰好还能满足下限"——v0.35.0 实测：
 * 加上 `settings.section.icon` 后实际是 8 个，把常量解析路径打断会让它掉回 7，
 * 而下限 7 照样绿。所以真正的判据是下面那条**点名断言**
 * （「常量间接传递的座位也被采到」），下限只是兜底。
 */
const MIN_OUR_SLOTS = 8

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

// ── 1. 找宿主（asar 或散装 client.js）─────────────────────────────────────────

/** Read one file out of an asar archive by its archive-relative path. */
function readAsarEntry(asarPath, relPath) {
  const fd = fs.openSync(asarPath, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(12)
    const headerBuf = Buffer.alloc(headerSize)
    fs.readSync(fd, headerBuf, 0, headerSize, 16)
    const header = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/, ''))
    const base = 16 + headerSize
    let node = header
    for (const segment of relPath.split('/').filter(Boolean)) {
      node = node.files?.[segment]
      if (node === undefined) return undefined
    }
    if (node.files !== undefined || node.unpacked === true) return undefined
    const offset = Number(node.offset)
    if (!Number.isFinite(offset)) return undefined
    const buf = Buffer.alloc(node.size)
    fs.readSync(fd, buf, 0, node.size, base + offset)
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/** Find the runner bundle inside an asar (its prefix differs between builds). */
function findInAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  let header
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(12)
    const headerBuf = Buffer.alloc(headerSize)
    fs.readSync(fd, headerBuf, 0, headerSize, 16)
    header = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/, ''))
  } finally {
    fs.closeSync(fd)
  }
  const found = []
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const next = `${prefix}/${name}`
      if (child.files !== undefined) walk(child, next)
      else if (next.endsWith(`/${RUNNER_SUFFIX}`)) found.push(next.replace(/^\//, ''))
    }
  }
  walk(header, '')
  return found
}

function locateHost() {
  const override = process.env.DSH_CONTRACT_SOURCE
  if (typeof override === 'string' && override.length > 0) {
    if (!fs.existsSync(override)) return { skip: `DSH_CONTRACT_SOURCE 指向的路径不存在：${override}` }
    if (override.endsWith('.asar')) {
      const rels = findInAsar(override)
      if (rels.length === 0) return { skip: `${override} 里找不到 ${RUNNER_SUFFIX}` }
      return { source: `${override} → ${rels[0]}`, text: readAsarEntry(override, rels[0]) }
    }
    return { source: override, text: fs.readFileSync(override, 'utf8') }
  }
  const exeDir = path.dirname(process.execPath)
  const asarCandidates = [
    // Running INSIDE the desktop host (Electron sets resourcesPath).
    path.join(process.resourcesPath ?? '', 'app.asar'),
    path.join(exeDir, '..', 'Resources', 'app.asar'), // macOS desktop
    path.join(exeDir, 'resources', 'app.asar'), // Windows / Linux desktop
    // Running from a plain node shell next to an installed desktop app.
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
    path.join(process.env.PROGRAMFILES ?? '', 'DeepSeek Harness', 'resources', 'app.asar'),
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
    '/opt/DeepSeek Harness/resources/app.asar',
  ]
  for (const asarPath of asarCandidates) {
    if (!fs.existsSync(asarPath)) continue
    const rels = findInAsar(asarPath)
    if (rels.length === 0) continue
    const text = readAsarEntry(asarPath, rels[0])
    if (text !== undefined) return { source: `${asarPath} → ${rels[0]}`, text }
  }
  // A profile-installed CLI keeps the packages on disk.
  const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const profilesDir = path.join(dshHome, 'profiles')
  if (fs.existsSync(profilesDir)) {
    for (const profile of fs.readdirSync(profilesDir)) {
      const p = path.join(profilesDir, profile, 'node_modules', '@deepseek-ai', RUNNER_SUFFIX)
      if (fs.existsSync(p)) return { source: p, text: fs.readFileSync(p, 'utf8') }
    }
  }
  return { skip: '本机找不到 DSH 安装（桌面版 app.asar 与 profile node_modules 都没有）' }
}

const host = locateHost()
if (host.skip !== undefined) {
  console.log(`SKIPPED  ${host.skip}`)
  console.log('         （契约守门只在装了 DSH 的机器上有意义；其他平台 clone 后不影响发布）')
  process.exit(0)
}
console.log(`DSH 座位目录来源：${host.source}`)

// ── 2. 解析宿主的座位表 ───────────────────────────────────────────────────────

/** `{ key, kind, scope }` for every entry in the host's own slot catalogue. */
function parseCatalogue(text) {
  const entries = new Map()
  const re = /key:\s*"([A-Za-z][\w.\-/]*)",\s*kind:\s*"([a-z]+)",\s*scope:\s*"([\w-]+)"/g
  let match
  while ((match = re.exec(text)) !== null) entries.set(match[1], { kind: match[2], scope: match[3] })
  return entries
}

/**
 * Tool names already claimed by a shipped `tool.call.toolview` renderer.
 *
 * Anchored on the `tool.call.toolview` entry itself: "already taken:" also
 * appears in the keyDomain of other keyed seats (`conversation.chat.node` lists
 * turn kinds there), and reading the first occurrence yields a plausible-looking
 * but wrong list — a check that can never fail.
 */
function parseTakenToolKeys(text) {
  const entryAt = text.indexOf('key: "tool.call.toolview"')
  if (entryAt < 0) return new Set()
  const nextEntryAt = text.indexOf('key: "', entryAt + 10)
  const block = text.slice(entryAt, nextEntryAt < 0 ? text.length : nextEntryAt)
  const domainAt = block.indexOf('keyDomain:')
  if (domainAt < 0) return new Set()
  const at = block.indexOf('already taken:', domainAt)
  if (at < 0) return new Set()
  const tail = block.slice(at + 'already taken:'.length)
  const end = tail.search(/"/)
  return new Set(tail.slice(0, end < 0 ? tail.length : end).split(',').map((s) => s.trim()).filter(Boolean))
}

const catalogue = parseCatalogue(host.text)
const takenToolKeys = parseTakenToolKeys(host.text)

// ── 3. 我们注册了哪些座位 ─────────────────────────────────────────────────────
//
// 扫 `src/client` 的全部 `.ts`，两种引用形式都要认：
//   1. **字面量**：`name: 'sidebar.right.pane.tab'` / `slots.inject('…')`；
//   2. **目录内常量**：`name: TID_PREVIEW_SLOT`。
//
// 为什么第 2 条是必需的：`sidebar.right.tab.document` 这个名字
// 先被抽成常量（`src/client/tid-parse.ts` 的 `TID_PREVIEW_SLOT`）、再在
// `src/client/tid-preview.ts` 里传进 `register({ name: … })`。只认字面量的采集器
// 对此**完全沉默** —— 它不报错，只是少数一个座位，而「座位存在于宿主」这条断言
// 对没采集到的名字当然永远是绿的。整条守门的价值就在「不许静默」，所以这里宁可
// 多花二十行去解析常量，也不往白名单里加一行（白名单治的是症状：下次再抽一个
// 座位出来，同样的洞会再出现一次）。
//
// 常量表按**目录**聚合而非按文件：定义在 `tid-parse.ts`、使用在 `tid-preview.ts`
// 是真实形态，同文件解析照样漏。
//
// 两种形式都只收「像座位名的」（带点的）值：`name:` 在别处也有（React key、
// 事件名），`const X = 'dsh-tiddlywiki-tid'` 这类 id 常量不带点，自然被排除。

const CLIENT_DIR = path.join(repoRoot, 'src', 'client')

/** 注释里会写历史座位名（正是本模块头讲的那件事），断言只看代码。 */
function codeOf(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '')
}

/**
 * `src/client/**` 里所有「值带点」的字符串常量：`ident → { value, file }`。
 *
 * 同一 `ident` 被赋了两个不同值 → 视为不可解析（删掉），宁可漏采也不猜错：
 * 猜错会让一条真座位静默消失，而漏采会被下面的座位数下限抓住。
 */
function collectClientConstants() {
  const map = new Map()
  const conflicting = new Set()
  const re = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*'([^'\n]*)'/g
  for (const entry of fs.readdirSync(CLIENT_DIR)) {
    if (!entry.endsWith('.ts')) continue
    const code = codeOf(fs.readFileSync(path.join(CLIENT_DIR, entry), 'utf8'))
    let match
    while ((match = re.exec(code)) !== null) {
      const [, ident, value] = match
      if (!value.includes('.')) continue
      const prior = map.get(ident)
      if (prior !== undefined && prior.value !== value) {
        conflicting.add(ident)
        continue
      }
      map.set(ident, { value, file: entry })
    }
  }
  for (const ident of conflicting) map.delete(ident)
  return map
}

function collectClientSlots(constants) {
  const found = new Map() // slot -> Set(file 或 "file#CONST")
  // 一个 token 要么是带引号的字面量，要么是裸标识符（再由常量表解成值）。
  const re = /(?:name:\s*|(?:inject|register)\(\s*)('([a-z][\w.\-]*)'|([A-Za-z_$][\w$]*))/g
  for (const entry of fs.readdirSync(CLIENT_DIR)) {
    if (!entry.endsWith('.ts')) continue
    const code = codeOf(fs.readFileSync(path.join(CLIENT_DIR, entry), 'utf8'))
    let match
    while ((match = re.exec(code)) !== null) {
      const ident = match[3]
      const constant = ident === undefined ? undefined : constants.get(ident)
      const slot = match[2] ?? constant?.value
      if (slot === undefined || !slot.includes('.')) continue
      if (!found.has(slot)) found.set(slot, new Set())
      found.get(slot).add(entry)
      // 常量间接传递时把「定义在哪」也带上：报错时要能一眼看到断点。
      if (constant !== undefined) found.get(slot).add(`${constant.file}#${ident}`)
    }
  }
  return found
}

const ourSlots = collectClientSlots(collectClientConstants())

// ── 4. 断言 ──────────────────────────────────────────────────────────────────

test('宿主的座位目录解析成功（条目数下限，防止解析器悄悄失效）', () => {
  assert.ok(
    catalogue.size >= MIN_CATALOGUE_ENTRIES,
    `只解析出 ${catalogue.size} 条座位（下限 ${MIN_CATALOGUE_ENTRIES}）—— 宿主的契约目录格式变了，请更新本脚本的解析正则`,
  )
})

test('采集器没有静默漏采（我们自己座位数的下限）', () => {
  assert.ok(
    ourSlots.size >= MIN_OUR_SLOTS,
    `只采集到 ${ourSlots.size} 个座位（下限 ${MIN_OUR_SLOTS}）：` +
      `若确实删了座位就同步 MIN_OUR_SLOTS；若没有，就是采集器又漏了一种引用形式` +
      `（常量间接传递？见本脚本 §3）。已采到：${[...ourSlots.keys()].sort().join(', ')}`,
  )
})

test('常量间接传递的座位也被采到（sidebar.right.tab.document）', () => {
  // 上一条是「总数下限」，会随座位增减漂移；这一条钉的是**唯一经常量传递**的那个名字，
  // 所以即使将来座位总数变化，常量解析这条路径失效也一定红。
  assert.ok(
    ourSlots.has('sidebar.right.tab.document'),
    '座位名经常量传递时没被采集到（`src/client/tid-parse.ts` 的 TID_PREVIEW_SLOT → ' +
      '`src/client/tid-preview.ts` 的 `register({ name })`）—— 只认字面量的采集器会对它完全沉默。' +
      `已采到：${[...ourSlots.keys()].sort().join(', ')}`,
  )
})

test('我们注册的每个座位都存在于宿主座位表里', () => {
  const missing = [...ourSlots.keys()].filter((slot) => !catalogue.has(slot))
  assert.deepEqual(
    missing,
    [],
    `这些座位在 DSH 里不存在（注册了也永远不会渲染）：${missing.map((s) => `${s}（${[...ourSlots.get(s)].join(',')}）`).join('；')}`,
  )
})

test('座位 kind 对得上：列表/单值座位按 id 注册，键控座位按 key 注册', () => {
  // 这三个在宿主里是 keyed（宿主自己用 `register({ name, key })`），所以我们按 key 注册。
  // `sidebar.right.tab.document` 过去一直没被采集到（常量间接传递）：宿主 `kind: "keyed"`。
  const expectKeyed = new Set(['tool.call.toolview', 'sidebar.right.pane.tab', 'sidebar.right.tab.document'])
  for (const [slot, files] of ourSlots) {
    const entry = catalogue.get(slot)
    if (entry === undefined) continue // 上一条已经报过
    if (expectKeyed.has(slot)) {
      assert.equal(entry.kind, 'keyed', `${slot} 在宿主里是 ${entry.kind}，我们按 key 注册（${[...files].join(',')}）`)
    } else if (entry.kind === 'keyed') {
      assert.fail(`${slot} 在宿主里是 keyed，但我们是按 id 注册的 —— 需要改成 register({ name, key })`)
    }
  }
})

test('17 个 tiddlywiki_* 工具视图没有撞上官方已占用的 key', () => {
  const source = fs.readFileSync(path.join(CLIENT_DIR, 'tool-views.ts'), 'utf8')
  // 取数组**字面量本身**，两点都要当心：
  //   · 右界不能用 `'] as const'`：这个文件里根本没有（声明是 `: readonly string[] = [`），
  //     `indexOf` 返回 -1 ⇒ 切片一路吃到文件尾 ⇒ 计数把后面任何一处 `'snake_case'`
  //     也算进去。现在恰好还是 17，但那是巧合，不是判据；
  //   · 左界不能取「第一个 `[`」：类型标注 `string[]` 里就有一个。所以锚在 `= [` 上。
  const declAt = source.indexOf('const TOOL_VIEW_KEYS')
  assert.ok(declAt >= 0, '找不到 `const TOOL_VIEW_KEYS` 声明 —— 解析器要跟着改名')
  const assignAt = source.indexOf('= [', declAt)
  assert.ok(assignAt > declAt, '`const TOOL_VIEW_KEYS` 后面找不到 `= [` 赋值 —— 解析器要跟着改写')
  const openAt = assignAt + 2
  const closeAt = source.indexOf('\n]', openAt)
  assert.ok(closeAt > openAt, 'TOOL_VIEW_KEYS 的数组字面量没有按 `\\n]` 闭合')
  const block = source.slice(openAt, closeAt)
  const keys = [...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])
  // 17 = 注册表里的工具数（`src/host/tools.ts` 的注册顺序表）。少一个就说明解析
  // 正则没跟上 `TOOL_VIEW_KEYS` 的写法，而不是"工具变少了"。
  assert.ok(keys.length >= 17, `工具视图 key 只解析出 ${keys.length} 个（应 ≥17，与 TOOL_VIEW_KEYS 一致）`)
  const clashes = keys.filter((key) => takenToolKeys.has(key))
  assert.deepEqual(clashes, [], `这些 key 已被官方 toolview 占用，注册会顶掉内置卡片：${clashes.join(', ')}`)
})

test('engines.dsh 已声明（让「宿主太旧/太新」变成安装期可见的事实）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const range = pkg.engines?.dsh
  assert.equal(typeof range, 'string', 'package.json 的 engines.dsh 必须声明一个 semver 范围')
  assert.ok(range.length > 0, 'engines.dsh 不得为空串')
})

console.log(
  failures === 0
    ? `DSH CONTRACT OK（宿主座位 ${catalogue.size} 条 · 我们注册 ${ourSlots.size} 个 · 官方已占 toolview key ${takenToolKeys.size} 个）`
    : `DSH CONTRACT FAILED（${failures} 项）`,
)
process.exit(failures === 0 ? 0 : 1)

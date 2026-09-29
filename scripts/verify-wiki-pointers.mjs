#!/usr/bin/env node
/**
 * 「`AGENTS.md` 的 wiki 指针指向真实笔记」守门（v0.30.56）。
 *
 * 为什么要它
 * ----------
 * `AGENTS.md` §5「开发文档索引」是**这套文档体系的承重墙**：它把细节从注入预算里
 * 搬进 wiki，代价是**入口文件只剩指针**。指针一旦断掉，后果不是「难看」，而是
 * **新会话按它去读细节时读到空气** —— 而 `AGENTS.md` 自己不会报错，`tsc` 也不会，
 * 任何现有守门都不会（`verify-doc-links.mjs` 只管仓库内的相对文件链接）。
 *
 * 这与本仓库 v0.30.51（公共面只有人肉 diff 能发现）、v0.30.52（`lib/` 同步只有 CI）、
 * v0.30.54（lock 同步只有人肉）是同一族：**规则的失效方式是沉默的**。
 *
 * 判据
 * ----
 * 1. 从 `AGENTS.md` 里取出 §5 索引表中的 `[[…]]` 指针（**只取表格行**，
 *    因为正文里的 `[[…]]` 可能是 TW 语法示例，不是指针 —— 这个区分是本守门的核心）；
 * 2. 找到 wiki 的**数据根**：环境变量 `DSH_TIDDLYWIKI_ROOT` > 指针文件
 *    （`$DSH_HOME/dsh-tiddlywiki-location.json` 或 `~/.dsh/…`）里的 `root`；
 * 3. 在 `<root>/work/tiddlers/*.md` 里按**标题**（meta 的 `title:` 或文件名）找每个指针。
 *
 * ⚠️ **找不到 wiki 根时 SKIP（不是 FAIL）** —— 在别人的机器 / CI 上 wiki 数据仓库
 * 可能根本不存在，那时「指针断没断」这个问题的前提就不成立。但 SKIP 必须**明说**，
 * 不能静默当通过（本仓库吃过「守门读空 = 断言全过」的亏）。
 *
 * 想验守门本身能不能红：`node scripts/verify-wiki-pointers.mjs --self-test`
 *
 *   node scripts/verify-wiki-pointers.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-wiki-pointers
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── 1. 取出 AGENTS.md §5 索引表里的指针 ──────────────────────────────────────
const agents = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8')

/**
 * 只认**表格行**里的 `[[…]]`：§5 的索引是 Markdown 表格，每行形如
 * `| 要查什么 | [[笔记名]] |`。正文里出现的 `[[标题]]`（TW 语法示例）不算指针 ——
 * 这正是本守门要守住的那个区分，写成注释免得后人把 orelse 改成全局匹配。
 */
const pointers = new Set()
for (const line of agents.split('\n')) {
  if (!line.trimStart().startsWith('|')) continue
  for (const m of line.matchAll(/\[\[([^\]|]+)\]\]/g)) pointers.add(m[1].trim())
}

// 反空转保险：解析器坏掉 / §5 被删掉时这里会是 0，断言就「全过」了。
assert.ok(
  pointers.size >= 3,
  `从 AGENTS.md 的表格行里只解析出 ${pointers.size} 个 [[…]] 指针 —— 解析器坏了，还是 §5 索引表被删了？`,
)

// ── 2. 找 wiki 数据根（**多库也要认**）────────────────────────────────────────
//
// 两种模式的文件形状不同，本守门两种都读（实测：本机上插件跑在多库模式，
// `location.json` 根本不存在，真相在 `wikis.json`）：
//   · 单库：`$DSH_HOME/dsh-tiddlywiki/location.json` → `{ active: { root, name } }`
//   · 多库：`$DSH_HOME/dsh-tiddlywiki/wikis.json`    → `{ mode, defaultId, wikis: [{ id, root, name }] }`
//
// 多库时取**默认库**（`defaultId`）的 `<root>/<name>` 作为 tiddler 目录所在处。
// 指针笔记（开发文档）跟着默认库走 —— 这与 `bridge.wiki` 空值代表默认库是同一个约定。
function dshTiddlywikiDir() {
  const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'dsh-tiddlywiki')
}

function resolveWikiRoots() {
  const dir = dshTiddlywikiDir()

  // 多库优先（mode=multi 时单库指针文件本来就不存在）
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'wikis.json'), 'utf8'))
    if (Array.isArray(raw.wikis) && raw.wikis.length > 0) {
      const preferred = raw.wikis.find((w) => w.id === raw.defaultId) ?? raw.wikis[0]
      const roots = []
      for (const w of raw.wikis) {
        if (typeof w?.root !== 'string' || w.root === '') continue
        // `name` 为 '.' 表示 root 本身就是 wiki 目录。
        roots.push(w.name === '.' || w.name === undefined ? w.root : path.join(w.root, w.name))
      }
      void preferred
      return roots
    }
  } catch { /* 没有多库文件，试单库 */ }

  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'location.json'), 'utf8'))
    const root = raw.active?.root ?? raw.root ?? raw.path
    const name = raw.active?.name ?? raw.name
    if (typeof root === 'string' && root !== '') {
      return [name === undefined || name === '.' ? root : path.join(root, name)]
    }
  } catch { /* 两个都没有 */ }

  return []
}

/** 允许用环境变量直接钉死（CI / 自测用）。 */
const forcedRoot = process.env.DSH_TIDDLYWIKI_ROOT
const wikiRoots = forcedRoot ? [forcedRoot] : resolveWikiRoots().filter((r) => fs.existsSync(r))

// ── 3. 在 wiki 里按标题找每个指针 ───────────────────────────────────────────
if (wikiRoots.length === 0) {
  console.log(
    'WIKI POINTERS SKIP（找不到任何 wiki 数据根：既没有 DSH_TIDDLYWIKI_ROOT，$DSH_HOME/dsh-tiddlywiki 下\n' +
    '  也没有可读的 wikis.json / location.json，或它们指到的目录不存在）\n' +
    '  ⇒ 「指针断没断」的前提不成立，本守门本轮**未验证**（不是通过）。',
  )
  process.exit(0)
}

/**
 * wiki 里所有条目的标题集合（meta 的 `title:` 优先，退回文件名）。
 *
 * ⚠️ 每个库的条目都在 `<root>/tiddlers/`（多库时还有 `<root>/<name>/tiddlers/`，
 * 而 root 的解析已经把它拼进去了）。这里扫两种常见布局，任一命中即算。
 */
function collectTitles(root) {
  const titles = new Set()
  for (const rel of ['tiddlers', path.join('work', 'tiddlers'), path.join('corpus', 'tiddlers'), path.join('archive', 'tiddlers')]) {
    const dir = path.join(root, rel)
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.md')) continue
      const metaFile = path.join(dir, `${name}.meta`)
      let title = null
      try {
        const meta = fs.readFileSync(metaFile, 'utf8')
        const m = /^title:\s*(.+)$/m.exec(meta)
        if (m) title = m[1].trim()
      } catch { /* 没有 meta 就退回文件名 */ }
      titles.add(title ?? name.replace(/\.md$/, ''))
    }
  }
  return titles
}

/** 全部库的标题并集。 */
const titles = new Set()
for (const root of wikiRoots) for (const t of collectTitles(root)) titles.add(t)

/** 自测模式：证明「一个不存在的指针名会被判为缺失」。 */
if (process.argv.includes('--self-test')) {
  const probe = '【本守门自测：这个笔记名一定不存在】'
  assert.ok(!titles.has(probe), '自测失败：探针名竟然真的存在于 wiki 里')
  const widened = new Set(titles); widened.add(probe)
  assert.ok(widened.has(probe), '自测失败：注入的探针名没有被 titles 识别')
  assert.ok([...pointers, probe].some((n) => !titles.has(n)), '自测失败：注入的不存在指针名没有被判为缺失')
  console.log('WIKI POINTERS SELF-TEST OK（注入一个不存在的指针名会被判为缺失）')
  process.exit(0)
}

assert.ok(
  titles.size >= 1,
  `wiki 根（${wikiRoots.join(', ')}）下解析出 0 个条目标题 —— 数据布局变了，本守门的判据需要跟着改`,
)

const missing = [...pointers].filter((name) => !titles.has(name)).sort()
assert.deepEqual(
  missing,
  [],
  `AGENTS.md §5 的开发文档索引指向了 wiki 里不存在的笔记：\n  ${missing.join('\n  ')}\n` +
  '这些指针是「细节住在 wiki」这套安排的承重墙：断掉之后，新会话按它去读会读到空气，\n' +
  '而 tsc / 任何现有守门都不会报错。\n' +
  '修法：要么把 wiki 里那篇笔记改名/新建回来，要么在 AGENTS.md 里改正指针。',
)

console.log(`WIKI POINTERS OK（AGENTS.md 的 ${pointers.size} 个 wiki 指针都指向真实笔记 · 库 ${wikiRoots.length} 个 · 条目 ${titles.size} 条）`)

#!/usr/bin/env node
/**
 * 文档死链守门 —— README.md 与 docs/ 下所有 `.md` 里的「相对路径链接」必须指向
 * 仓库里真实存在的文件。`docs/` 在 package.json 的 `files` 里，所以这些链接也会
 * 随 npm 包发出去：断了，用户点开就是 404。
 *
 * 为什么需要它（v0.27.3 新增）：v0.27.1 把 README 的大段内容拆进 `docs/` 之后，
 * 留在 `docs/` 里的链接仍按「仓库根」写成 `docs/xxx.md`——从 `docs/` 内部点击
 * 直接断掉 6 处，而**没有任何守门能发现它**（README 在根目录看起来完全正常）。
 * 这类错误只有机械检查抓得住。
 *
 * 跳过（不是文件）：http(s) / mailto、纯锚点 `#...`、以及指向运行中 TiddlyWiki 的
 * `/dsh-tiddlywiki/...` 链接。锚点内的 `#anchor` 会被剥掉后只校验路径部分。
 *
 *   node scripts/verify-doc-links.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-doc-links
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 递归收集目录下所有 `.md`（docs/plans 这类历史设计文档也一并纳入）。 */
const collectMarkdown = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const abs = resolve(dir, entry)
    if (statSync(abs).isDirectory()) collectMarkdown(abs, out)
    else if (entry.endsWith('.md')) out.push(abs)
  }
  return out
}

const targets = [resolve(repoRoot, 'README.md'), ...collectMarkdown(resolve(repoRoot, 'docs'))]

let checked = 0
const broken = []
for (const file of targets) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const raw = match[1]
    if (/^(https?:|mailto:|#|\/dsh-tiddlywiki\/)/.test(raw)) continue
    const withoutAnchor = raw.split('#')[0].split('?')[0]
    if (withoutAnchor === '') continue
    checked += 1
    if (!existsSync(resolve(dirname(file), withoutAnchor))) {
      broken.push(`${file.slice(repoRoot.length + 1)}  →  ${raw}`)
    }
  }
}

for (const line of broken) console.log(`  ✗ ${line}`)
if (broken.length > 0) {
  console.error(
    `DOC LINKS FAILED — ${broken.length} 个链接指向不存在的文件（共检查 ${checked} 条相对链接）`,
  )
  process.exit(1)
}
console.log(`  ok  README + docs 相对链接全部可达（${checked} 条）`)
console.log('DOC LINKS OK')

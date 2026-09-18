#!/usr/bin/env node
/**
 * 用法：
 *   node scripts/split-agents-to-wiki.mjs            # dry-run，只打印计划
 *   node scripts/split-agents-to-wiki.mjs --emit <dir>   # 把每篇正文写成 <dir>/NN.md
 *
 * ⚠️ 本脚本**不直接写 wiki**：面向同一个 wiki 目录再 spawn 一个 TW 子进程，会与
 * dsh web 已在跑的那个 TW 争抢 syncer（正是本仓库反复记录的丢写入竞态）。
 * 正确的写入路径是 `--emit` 出正文，再用插件自己的 `tiddlywiki_put` 工具写
 * （走正在运行的 TW 实例，含 flush 与自动 commit）。
 *
 * @module dsh-tiddlywiki/scripts/split-agents-to-wiki
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const emitAt = args.indexOf('--emit')
const EMIT_DIR = emitAt >= 0 ? args[emitAt + 1] : undefined

const DEV_DOC_TAG = 'dev-doc'
const BASE_TAG = 'dsh-tiddlywiki'

/** Byte length (the injection budget is in BYTES, not characters). */
const bytes = (s) => Buffer.byteLength(s, 'utf8')

const raw = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8')

/** Split the markdown into `## ` sections, keeping the preamble. */
function splitSections(text) {
  const lines = text.split('\n')
  const cuts = []
  for (let i = 0; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) cuts.push(i)
  }
  const out = []
  const preamble = lines.slice(0, cuts[0] ?? lines.length).join('\n')
  if (preamble.trim().length > 0) out.push({ heading: '(preamble)', body: preamble })
  for (let k = 0; k < cuts.length; k += 1) {
    const from = cuts[k]
    const to = cuts[k + 1] ?? lines.length
    out.push({ heading: lines[from], body: lines.slice(from, to).join('\n') })
  }
  return out
}

const sections = splitSections(raw)
const byPrefix = (p) => sections.find((s) => s.heading.startsWith(p))

/** The wiki notes we create, and which AGENTS.md sections feed them. */
const NOTES = [
  {
    title: 'dsh-tiddlywiki 开发·常见坑（踩过别重踩）',
    sources: ['## 8.'],
    intro: '> 来源：原 `AGENTS.md` §8。**这些坑都真实发生过**，每条都配了守门脚本；'
      + '改相关代码前先读对应条目。\n>\n'
      + '> ⚠️ `AGENTS.md` 只放纯规则与指针，坑的细节在这里（可检索、且不占会话注入预算）。\n',
  },
  {
    title: 'dsh-tiddlywiki 开发·架构事实与约定',
    sources: ['## 5.'],
    intro: '> 来源：原 `AGENTS.md` §5。host/client 装配时机、工具写策略、seed 机制、'
      + '路由守卫、提示词注入等**实现层事实**。\n',
  },
  {
    title: 'dsh-tiddlywiki 开发·仓库布局 / 构建 / 校验',
    sources: ['## 2.', '## 3.', '## 4.'],
    intro: '> 来源：原 `AGENTS.md` §2–§4。文件布局、构建与校验脚本清单、'
      + 'bundle/seed 的**再生成流水线**（改了源件必须走，别手改生成常量）。\n',
  },
  {
    title: 'dsh-tiddlywiki 开发·易变清单（全量）',
    sources: ['## 1.'],
    intro: '> 来源：原 `AGENTS.md` §1 的**完整版**（含每个版本的演进说明）。\n'
      + '> 当前值/速查见 `AGENTS.md` §2 的精简表；本笔记保留全量以便追溯「为什么是这样」。\n'
      + '> 版本演进史本身也可以直接查 git log / README「版本记录」。\n',
  },
  {
    title: 'dsh-tiddlywiki 开发·发布流程与维护规则',
    sources: ['## 6.', '## 7.'],
    intro: '> 来源：原 `AGENTS.md` §6–§7。**发布流程是铁律**（功能开发完成 = 收尾发布），'
      + '但 `AGENTS.md` §4 已保留可执行的步骤清单，本笔记保留完整说明与维护规则。\n',
  },
]

/** Compose one note's body from its source sections. */
function composeNote(note) {
  const parts = [note.intro]
  for (const prefix of note.sources) {
    const section = byPrefix(prefix)
    if (section === undefined) {
      console.warn(`  (warn) 找不到章节 ${prefix} —— 跳过`)
      continue
    }
    parts.push(section.body.trimEnd())
  }
  return parts.join('\n\n') + '\n'
}

const planned = NOTES.map((n) => ({ ...n, text: composeNote(n) }))

console.log(`AGENTS.md: ${bytes(raw)} bytes / ${raw.split('\n').length} lines`)
console.log(`计划写入 ${planned.length} 篇 wiki 笔记：\n`)
for (const n of planned) {
  console.log(`  ${String(bytes(n.text)).padStart(6)} bytes  ${n.title}`)
}
const moved = planned.reduce((a, n) => a + bytes(n.text), 0)
console.log(`\n合计搬走约 ${moved} bytes；目标：AGENTS.md 降到 60KB 以内（当前注入预算 65536）`)

if (EMIT_DIR === undefined) {
  console.log('\n（dry-run；加 --emit <dir> 把每篇正文导出成文件）')
  process.exit(0)
}

fs.mkdirSync(EMIT_DIR, { recursive: true })
planned.forEach((n, i) => {
  const file = path.join(EMIT_DIR, `${String(i + 1).padStart(2, '0')}.md`)
  fs.writeFileSync(file, n.text, 'utf8')
  console.log(`  emit ${file}`)
})
fs.writeFileSync(
  path.join(EMIT_DIR, 'index.json'),
  JSON.stringify(planned.map((n) => ({ title: n.title, bytes: bytes(n.text) })), null, 2),
  'utf8',
)
console.log(`\n已导出到 ${EMIT_DIR}（用 tiddlywiki_put 逐篇写入 wiki）`)

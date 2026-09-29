#!/usr/bin/env node
/**
 * `AGENTS.md` 注入预算守门（v0.30.57）—— 这条纪律的**存在理由**就是它自己。
 *
 * 为什么需要它
 * ------------
 * `AGENTS.md` 是**每个会话**都会被注入的 workspace instructions，宿主给它 **65536 字节**
 * 的预算。本文件的第 5 行自己写着这段历史：
 *
 *   > 过去它长到 ~120KB，**截断正好砍掉最后几节（发布流程 / 维护规则 / 常见坑）**，
 *   > 等于新会话默认看不到最容易踩雷的部分。
 *
 * 也就是说：**这份文件当初被拆成「规则 + 指针」的原因，就是它撞过预算上限。** 而那条
 * 教训只写在正文里 —— **没有任何东西在量它**。`verify-doc-links` 管链接、`verify-wiki-pointers`
 * 管指针，都不管篇幅。
 *
 * 失效方式依然是**沉默的**：文件继续长，直到某天超过 65536，宿主从末尾截断 ——
 * 被砍掉的正好是最后几节（§3 铁律后半 / §4 发布流程 / §5 索引 / §7 维护规则），
 * 而这些恰恰是最该被看到的规则。**没有人会收到报错。**
 *
 * 判据（两级，都是**硬阈值**，不做百分比漂移）
 * ------------------------------------------
 *   · **HARD（65536）**：宿主预算本身。超过 ⇒ **红**。这是「注入会被截断」的事实边界。
 *   · **SOFT（45000）**：留出余量的自我警戒线。超过 ⇒ **红**，但报错文案不同 ——
 *     它要求在同一个 commit 里**把它拆进 wiki 或删掉过时内容**，而不是直接抬阈值。
 *
 * 为什么 SOFT 也要红（而不是只警告）：本仓库的教训是「警告会在几十个版本里被无视」。
 * 一条只打印 warning 的守门等于没有守门 —— 这正是 v0.30.52/53/54/56 反复发现的模式。
 * 想抬 SOFT，必须**明确改这个常量**，那是一次有意识的决定。
 *
 * ⚠️ 顺带守一件事：**第 5 行对自身体积的描述不得漂移**。它现在写着「约 12KB」，
 * 而实测已经 41.6KB（3.5 倍）—— **文件在撒谎，而没有人被冒犯**。本守门要求那句
 * 自述与实测同量级（±30%），否则红。这类「自述数字」在本仓库有前科（v0.30.43 的注释
 * 版本号、v0.30.51 的公共面计数）。
 *
 *   node scripts/verify-agents-budget.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-agents-budget
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = path.join(repoRoot, 'AGENTS.md')
const source = fs.readFileSync(file, 'utf8')

/** 宿主注入预算（字节）。**这是事实边界，不要为了让守门变绿而改它。** */
const HARD_LIMIT = 65536
/** 自我警戒线：留 ~30% 余量，超过就要在同一个 commit 里瘦身。 */
const SOFT_LIMIT = 45000

const bytes = Buffer.byteLength(source, 'utf8')

assert.ok(
  bytes > 1000,
  `AGENTS.md 只有 ${bytes} 字节 —— 文件读空了？守门读空 = 断言全过，所以这里先钉住下限`,
)

// ── 1. 两级阈值 ───────────────────────────────────────────────────────────
assert.ok(
  bytes <= HARD_LIMIT,
  `AGENTS.md 已经 ${bytes} 字节，超过宿主注入预算 ${HARD_LIMIT} 字节 —— ` +
  '**注入会被从末尾截断**，而被砍掉的正好是最后几节（§3 铁律后半 / §4 发布流程 / §5 索引 / §7 维护规则）。\n' +
  '这正是本文件当初被拆成「规则 + 指针」的原因。修法：把细节搬进 wiki 笔记（§5 索引在那里等），' +
  '或在指针里说明「为什么读」而不是复述内容。',
)

assert.ok(
  bytes <= SOFT_LIMIT,
  `AGENTS.md 已经 ${bytes} 字节，超过自我警戒线 ${SOFT_LIMIT} 字节（宿主预算是 ${HARD_LIMIT}）。\n` +
  '它离「注入被截断」只剩 ${HARD_LIMIT - bytes} 字节的余量，而这个文件是**每个会话**都会加载的。\n' +
  '修法（同一个 commit 里做完）：① 把还能搬的细节搬进 wiki 笔记；② 删掉已经过时的段落；\n' +
  '③ 只有在①②都做不到、且你**明确知道**为什么必须留在注入里时，才上调本脚本的 SOFT_LIMIT —— ' +
  '那是一次有意识的决定，不是为了让红变绿。',
)

// ── 2. 第 5 行对自身体积的自述不得漂移 ──────────────────────────────────────
// 只认「现在拆完约 XKB」那一句；X 的**存在**是必须的（自述可以改，但不能消失）。
const selfSize = /现在拆完约\s*([\d.]+)\s*KB/.exec(source)
assert.ok(
  selfSize !== null,
  'AGENTS.md 顶部那句「现在拆完约 XKB」不见了 —— 本守门靠它做「自述 vs 实测」的一致性检查。' +
  '要么把那句写回来，要么改成别的可被解析的自述并同步更新本脚本的判据。',
)

const claimedKb = Number(selfSize[1])
const actualKb = bytes / 1024
const drift = Math.abs(actualKb - claimedKb) / actualKb
assert.ok(
  drift <= 0.3,
  `AGENTS.md 顶部自述「约 ${claimedKb}KB」，实测 ${actualKb.toFixed(1)}KB（偏差 ${(drift * 100).toFixed(0)}%）。\n` +
  '**文件在对自己撒谎，而没有任何东西会因此报错** —— 这与 v0.30.43（注释里的版本号）、' +
  'v0.30.51（公共面自述的计数）是同一族：自述数字没有执行者。\n' +
  '修法：把那句改成实测值（或在瘦身之后再改）。',
)

console.log(
  `AGENTS BUDGET OK（${bytes} 字节 / 硬上限 ${HARD_LIMIT} = ${((bytes / HARD_LIMIT) * 100).toFixed(1)}%，` +
  `软上限 ${SOFT_LIMIT}；顶部自述 ${claimedKb}KB 与实测 ${actualKb.toFixed(1)}KB 一致）`,
)

#!/usr/bin/env node
/**
 * 「拆库 skill」的守门（v0.28.0）：安装行为 + 随包内容本身是否合法。
 *
 * 两件事都很容易**静默**出错：
 *   1. 安装器覆盖了用户自己写的 SKILL.md —— 那天用户正好用了同一个目录名，他的 skill 就
 *      没了，而且不会有任何提示。所以"没有我们的标记就不许碰"必须是可失败断言。
 *   2. 随包的 SKILL.md frontmatter 不合法（name 不是 kebab-case / description 空）——
 *      dsh-skill-filesystem 会**随警告丢掉整个 skill**，用户那边就是"说好的 skill 呢"。
 *
 *   node scripts/verify-skill-install.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-skill-install
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFamily } from './lib/source-family.mjs' // v0.28.8：按「模块族」读源码，拆分不断言路径
import {
  SKILL_FILE_NAME,
  SPLIT_SKILL_DIR,
  SPLIT_SKILL_MARKER,
  installSplitSkill,
  readBundledSkillText,
} from '../lib/index.js'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures++
    console.error(`FAIL  ${name}\n      ${err && err.message ? err.message : err}`)
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'dsh-tw-skill-'))
const root = join(scratch, 'skills')
const target = join(root, SPLIT_SKILL_DIR, SKILL_FILE_NAME)

try {
  await test('随包的 SKILL.md：frontmatter 合法（name kebab-case + description 非空）', async () => {
    const text = await readBundledSkillText()
    assert.ok(typeof text === 'string' && text.length > 0, '必须能找到并读到随包的 SKILL.md')
    assert.ok(text.startsWith('---\n'), '必须以 YAML frontmatter 开头（否则 skill 提供方会整条丢掉）')
    const end = text.indexOf('\n---', 4)
    assert.ok(end > 0, 'frontmatter 必须有结束的 ---')
    const front = text.slice(4, end)
    const name = /^name:\s*(\S+)\s*$/m.exec(front)?.[1]
    const description = /^description:\s*(.+)$/m.exec(front)?.[1]
    assert.match(name ?? '', /^[a-z0-9]+(-[a-z0-9]+)*$/, `name 必须是 kebab-case：${name}`)
    assert.ok((description ?? '').trim().length >= 20, 'description 必须有实质内容（它是模型唯一的挑选依据）')
    assert.ok(text.includes(SPLIT_SKILL_MARKER), '随包文件必须带插件标记（安装器靠它区分"我们的"与"用户的"）')
  })

  await test('安装：缺失时写入，并把标记写进文件', async () => {
    const result = await installSplitSkill({ root })
    assert.equal(result.action, 'written')
    assert.equal(result.path, target)
    const written = await readFile(target, 'utf8')
    assert.ok(written.includes(SPLIT_SKILL_MARKER))
  })

  await test('安装：内容一致时不动（幂等，不制造 diff）', async () => {
    const result = await installSplitSkill({ root })
    assert.equal(result.action, 'kept')
    assert.match(result.detail ?? '', /最新/)
  })

  await test('安装：带标记的旧版本会被更新到随包版本', async () => {
    await writeFile(target, `---\nname: dsh-tiddlywiki-wiki-split\ndescription: 旧版本旧的说明文字，够长了\n---\n\n<!-- ${SPLIT_SKILL_MARKER} v0 -->\n旧内容\n`, 'utf8')
    const result = await installSplitSkill({ root })
    assert.equal(result.action, 'updated', '带标记 = 我们的，可以覆盖')
    const now = await readFile(target, 'utf8')
    assert.ok(now.includes('拆分知识库'), '必须换成随包版本的内容')
  })

  await test('安装：**用户自己写的** SKILL.md 绝不被覆盖（本脚本存在的首要理由）', async () => {
    const mine = '---\nname: dsh-tiddlywiki-wiki-split\ndescription: 我自己写的，别动我\n---\n\n我自己的内容\n'
    await writeFile(target, mine, 'utf8')
    const result = await installSplitSkill({ root })
    assert.equal(result.action, 'kept')
    assert.match(result.detail ?? '', /你自己的文件/)
    assert.equal(await readFile(target, 'utf8'), mine, '一个字节都不许变')
  })

  await test('安装：找不到随包内容时报失败而不是抛错（不许拖垮插件启动）', async () => {
    const result = await installSplitSkill({ root, text: '' })
    assert.equal(result.action, 'failed')
    assert.match(result.error ?? '', /SKILL\.md/)
  })

  await test('接线：技能安装必须排在 farm.startAll() **之前**', async () => {
    const index = readFamily(repoRoot, 'src/index')
    const installAt = index.indexOf('await installSplitSkill()')
    const startAt = index.indexOf('await farm.startAll()')
    assert.ok(installAt > 0, 'index.ts 必须调用 installSplitSkill（否则技能永远不会被安装）')
    assert.ok(startAt > 0, '找不到 farm.startAll()')
    // 真实事故（2026-09-28 作者重启宿主时发现）：安装写在 startAll() 之后，而那个 wiki 很大、
    // 启动要几十秒 —— 于是"技能装没装"取决于"wiki 起得快不快"。它跟 wiki 毫无关系，必须在
    // 最前面：wiki 慢、起不来、甚至配置坏了，技能都照装。
    assert.ok(installAt < startAt, '技能安装必须早于 farm.startAll()，否则 wiki 起不来时技能永远装不上')
  })

  await test('两边不漂移：五个问题在 skill 与 docs/wiki-split.md 里都在', async () => {
    const skill = await readBundledSkillText()
    const doc = await readFile(join(repoRoot, 'docs', 'wiki-split.md'), 'utf8')
    // 这些是给用户的"会被问到什么"清单：文档里的承诺与 skill 实际会问的必须一致。
    for (const question of ['拆成几个库', '每个库收什么', 'git 怎么分', '对 Agent 可见', '先出报告']) {
      assert.ok((skill ?? '').includes(question), `skill 里缺少问题「${question}」`)
      assert.ok(doc.includes(question), `docs/wiki-split.md 里缺少问题「${question}」`)
    }
  })
} finally {
  // 清理：只删我们自己造的临时根（installSplitSkill 的 root 是传进去的）。
  await rm(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nSKILL INSTALL CHECKS OK' : `\nSKILL INSTALL CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

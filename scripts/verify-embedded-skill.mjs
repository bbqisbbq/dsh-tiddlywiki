#!/usr/bin/env node
/**
 * 嵌入式 skill 守门（v0.30.66）。
 *
 * 背景：拆库 skill 过去只能靠**往用户目录写文件**（`$DSH_HOME/skills/<dir>/SKILL.md`），
 * 因为"插件无法注册 skill 根"。DSH 0.2.1 提供了 `ctx.skills.register()` ——
 * skill 可以只存在于内存里：随插件卸载消失、不碰用户 home、卸载后不会留残骸。
 *
 * 这条守门钉三件事：
 *   1. 随包 SKILL.md 能被解析成注册表要的形状（name 合 kebab、description/content 非空）；
 *   2. 解析器容忍坏输入（缺 frontmatter → undefined，而不是抛）；
 *   3. 启动**优先**走注册表，只有宿主没有 skill 服务时才回落写文件 ——
 *      回落的顺序反过来就会静默退回"写用户目录"。
 *
 *   node scripts/verify-embedded-skill.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-embedded-skill
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSkillText, readBundledSkillText, registerSplitSkill } from '../lib/index.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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

const text = await readBundledSkillText()

test('随包 SKILL.md 解析出注册表需要的四个字段', () => {
  assert.ok(typeof text === 'string' && text.length > 0, '读不到随包 skills/wiki-split/SKILL.md')
  const parsed = parseSkillText(text)
  assert.ok(parsed !== undefined, 'SKILL.md 必须能解析（frontmatter + 正文）')
  assert.match(parsed.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, `skill 名字必须是 kebab-case，实际 ${JSON.stringify(parsed.name)}`)
  assert.ok(parsed.description.length > 0, 'description 不能为空（注册表会拒）')
  assert.ok(parsed.content.length > 200, `正文太短（${parsed.content.length}）—— 是不是把 frontmatter 也切进去了？`)
  assert.ok(!parsed.content.startsWith('---'), '正文不得包含 frontmatter 围栏')
  assert.ok(parsed.whenToUse !== undefined && parsed.whenToUse.length > 0, 'whenToUse 应该被解析出来')
})

test('解析器容忍坏输入：缺 frontmatter / 空正文 → undefined（不抛）', () => {
  assert.equal(parseSkillText('就是一段普通 markdown，没有 frontmatter'), undefined)
  assert.equal(parseSkillText('---\nname: x\n---\n\n'), undefined, '只有 name、正文为空 → 不可注册')
  assert.equal(parseSkillText('---\ndescription: 有描述没名字\n---\n正文'), undefined, '缺 name → 不可注册')
  assert.equal(parseSkillText('---\nname: Bad_Name\ndescription: d\n---\n正文'), undefined, '不是 kebab-case 的名字由注册表拒；解析阶段应回 undefined 走回落')
})

test('registerSplitSkill 把解析结果原样交给注册表，并打开两种调用策略', () => {
  const calls = []
  const dispose = () => { calls.push('dispose') }
  const fake = { register: (skill) => { calls.push(skill); return dispose } }
  const returned = registerSplitSkill(fake, text)
  assert.equal(returned, dispose, '必须把注册表的 disposer 原样返回（卸载时要用它）')
  const skill = calls[0]
  assert.equal(skill.name, 'dsh-tiddlywiki-wiki-split')
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true }, '模型和用户都应能用（`/` 菜单也要出现）')
  assert.ok(skill.content.length > 0 && skill.description.length > 0)
})

test('注册表抛错时返回 undefined（由调用方回落到文件安装），绝不冒泡', () => {
  const fake = { register: () => { throw new Error('registry boom') } }
  assert.equal(registerSplitSkill(fake, text), undefined)
})

test('启动顺序：先注册表、后文件回落（反过来等于静默退回写用户目录）', () => {
  const startup = fs.readFileSync(path.join(repoRoot, 'src/index-startup.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '')
  const registryAt = startup.indexOf('registerSplitSkill(')
  const fileAt = startup.indexOf('installSplitSkill()')
  assert.ok(registryAt > 0, 'startup 必须尝试 registerSplitSkill')
  assert.ok(fileAt > 0, '文件安装必须保留为回落')
  assert.ok(registryAt < fileAt, 'registerSplitSkill 必须排在 installSplitSkill 之前（拿到 disposer 就不再写文件）')
  assert.match(startup, /deps\.pushDisposer\(dispose\)/, '注册成功必须把 disposer 交给插件（否则卸载后注册残留）')
  assert.match(startup, /deps\.skills\?\.\(\)/, '必须从 deps 拿宿主 skill 注册表（可为空 → 回落）')
})

console.log(failures === 0 ? 'EMBEDDED SKILL OK' : `EMBEDDED SKILL FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

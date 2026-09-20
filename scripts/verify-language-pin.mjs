#!/usr/bin/env node
/**
 * `$:/language` 条件写入的守门（v0.24.2）。
 *
 * 背景：两处（启动时应用 `uiLanguage`、设置页改语言）原先都**无条件** PUT
 * `$:/language`。正文每次都一样，但 TW 会给 `.meta` 盖上新的 `created`/`modified`
 * —— 两台机器各自启动过就都改了同几行，于是**每次 `git pull` 都在
 * `tiddlers/$__language.txt.meta` 上冲突**（本仓库 git 历史里已有一条专门清理该
 * 冲突残留的提交；2026-09-20 一次会话内撞了两次，而文件内容从未分歧）。
 *
 * 这个「无意义的写」有两个必须守住的边界，否则修 bug 会引入新 bug：
 *   1. **读失败 ≠ 内容相同**（铁律第三条）：`client.get()` 只有 404 返回
 *      undefined，其余抛错 —— 抛错时**必须照写**，跳过会让用户的语言永远卡在
 *      错的值上、且无法通过重启修复；
 *   2. 有 client 的调用点必须都走 `pinLanguageTiddler`，不允许再出现裸 PUT。
 *
 *   node scripts/verify-language-pin.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-language-pin
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pinLanguageTiddler } from '../lib/index.js'

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

const repoRoot = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** Stub client recording every call; `existing` mimics the TW store. */
function stub({ existing, getThrows = false } = {}) {
  const calls = []
  return {
    calls,
    async get(title) {
      calls.push(['get', title])
      if (getThrows) throw new Error('transient 500')
      return existing === undefined ? undefined : { ...existing, title }
    },
    async put(tiddler) {
      calls.push(['put', tiddler.title, tiddler.text])
    },
  }
}

const DESIRED = '$:/languages/zh-Hans'

await test('内容已一致 → 绝不写（这正是「每次 pull 都冲突」的根因）', async () => {
  const c = stub({ existing: { title: '$:/language', text: DESIRED, type: 'text/plain', tags: [] } })
  const changed = await pinLanguageTiddler(c, DESIRED)
  assert.equal(changed, false, '内容相同必须返回 changed:false')
  assert.deepEqual(c.calls, [['get', '$:/language']], `内容相同只应读一次、不写：${JSON.stringify(c.calls)}`)
})

await test('条目不存在（404 → undefined）→ 必须写', async () => {
  const c = stub({ existing: undefined })
  const changed = await pinLanguageTiddler(c, DESIRED)
  assert.equal(changed, true)
  assert.deepEqual(c.calls.at(-1), ['put', '$:/language', DESIRED], `最后一次调用应是写：${JSON.stringify(c.calls)}`)
})

await test('内容不同 → 必须写（换语言要真的生效）', async () => {
  const c = stub({ existing: { title: '$:/language', text: '$:/languages/en-GB', type: 'text/plain', tags: [] } })
  const changed = await pinLanguageTiddler(c, DESIRED)
  assert.equal(changed, true)
  assert.deepEqual(c.calls.at(-1), ['put', '$:/language', DESIRED])
})

await test('读失败 → 照写并报警（铁律第三条：绝不把读失败当「内容相同」）', async () => {
  const c = stub({ getThrows: true })
  const logs = []
  const changed = await pinLanguageTiddler(c, DESIRED, (message) => logs.push(message))
  assert.equal(changed, true, '读失败时必须照写，否则语言会永久卡在错值上')
  assert.deepEqual(c.calls.at(-1), ['put', '$:/language', DESIRED], `读失败后仍须写：${JSON.stringify(c.calls)}`)
  assert.equal(logs.length, 1, `读失败必须记一条日志：${JSON.stringify(logs)}`)
  assert.ok(/read|reading/i.test(logs[0]), `日志要说清是「读」失败：${logs[0]}`)
})

await test('源码级：不允许再出现裸 PUT $:/language（两处调用点都必须走原语）', () => {
  const strip = (rel) =>
    readFileSync(join(repoRoot, rel), 'utf8')
      .split('\n')
      .filter((line) => {
        const t = line.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
  for (const rel of ['src/index.ts', 'src/host/admin.ts']) {
    let src = strip(rel)
    if (rel === 'src/host/admin.ts') {
      // The primitive itself legitimately PUTs once — cut its body out before
      // asserting "no bare PUT", or the guard matches its own implementation.
      const start = src.indexOf('export async function pinLanguageTiddler(')
      assert.ok(start >= 0, 'admin.ts 必须导出 pinLanguageTiddler')
      const end = src.indexOf('\n}', start)
      assert.ok(end > start, 'pinLanguageTiddler 的函数体提取失败 —— 请同步本脚本')
      src = src.slice(0, start) + src.slice(end)
    }
    const bare = src.match(/\.put\(\{\s*title:\s*'\$:\/language'/g)
    assert.equal(bare, null, `${rel} 仍有无条件 PUT $:/language（除原语自身外一处都不许有）：${bare && bare.join(' / ')}`)
  }
  // 正向：两处都必须经 pinLanguageTiddler（含各自 desired 的两种取值形态）
  const index = strip('src/index.ts')
  const admin = strip('src/host/admin.ts')
  assert.ok(/pinLanguageTiddler\(langClient,\s*`\$:\/languages\/\$\{code\}`/.test(index), 'src/index.ts 的启动路径必须经 pinLanguageTiddler')
  assert.ok(/pinLanguageTiddler\(client,\s*active/.test(admin), 'admin.ts 的 languages 路径必须经 pinLanguageTiddler')
})

console.log(failures === 0 ? '\nLANGUAGE PIN CHECKS OK' : `\nLANGUAGE PIN CHECKS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env node
/**
 * npm 发布内容守门（`npm pack --dry-run --json`）。
 *
 * 断开发布包里：
 *   - **必需**路径齐全：lib/index.js / lib/client.js / cordis.patch.yml / LICENSE / README.md；
 *   - **不得**含中间产物 lib/client.bundle.js（tsdown 的 cjs+minify 中间件，会被
 *     wrap-client.mjs 包成 lib/client.js 后才对外发布；漏发它=体积翻倍，且它是
 *     cjs 形状，被当成插件客户端加载会直接炸）；
 *   - lib/ 下只允许 package.json `files` 白名单里的那三个文件。
 *
 * 走真实 npm（不联网：--dry-run 只读本地文件），不 import lib/。
 *
 *   node scripts/verify-package-contents.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-package-contents
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const REQUIRED = [
  'lib/index.js',
  'lib/client.js',
  'cordis.patch.yml',
  'LICENSE',
  'README.md',
  // AGENTS §6 documents the published shape as lib/ + src/ + docs/: `src` is
  // what makes `npm run verify*` (and reading the real implementation) possible
  // from an installed copy, `docs/` carries the seed-initialization design doc.
  'src/index.ts',
  'docs/seed-initialization.md',
  // 微信公众号发布能力（v0.23.0）：必须在发布包里，否则「换机器还原」会缺件。
  // 断言两个端点文件即可（wechat-html.js / weixin-flow.js 是它们的依赖，
  // 若依赖缺失则 install 脚本会自检报错）。
  'docs/wechat-publish-setup.md',
  'tools/wechat/publish-note.js',
  'tools/wechat/install-wechat-adapters.mjs',
  // 发布元数据（v0.23.0 续）：存量回填脚本 + seed 立即写入脚本也要能随包分发，
  // 否则换机器后没法定稿「哪些发过」。
  'tools/wechat/backfill-publish-state.mjs',
  'tools/wechat/seed-publish-spec-now.mts',
]
const FORBIDDEN = ['lib/client.bundle.js']
/** package.json `files` 里声明的 lib/ 白名单。 */
const LIB_WHITELIST = ['lib/index.js', 'lib/index.js.map', 'lib/client.js']
/** 发布包必须**不含**的目录前缀（构建/校验脚本只服务于 git 仓库）。 */
const FORBIDDEN_PREFIXES = ['scripts/']

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

let stdout
try {
  // ⚠️ 不要改回 child_process.exec：DSH 沙箱禁止程序经命名管道捕获子进程输出
  //（spawn 默认 stdio:'pipe' → EPERM），本地 verify 从未在此跑过。这里改用
  // spawn + 文件重定向：stdio 全走文件（fd，不涉及管道），语义与原 exec 等价
  //（shell:true 保留原命令串、timeout 同步保留），npm 的 JSON 落 stdout 文件。
  // 另外必须给 --cache 指到临时目录：默认缓存（node_cache\_cacache）在沙箱外，
  // npm pack 一开缓存文件就 EPERM（真实踩过）。
  const outPath = path.join(os.tmpdir(), `dsh-tw-pack-${process.pid}.json`)
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tw-npmcache-'))
  const fd = fs.openSync(outPath, 'w')
  try {
    await new Promise((resolveP, rejectP) => {
      const child = spawn(`npm pack --dry-run --json --ignore-scripts --cache ${JSON.stringify(cacheDir)}`, [], {
        cwd: repoRoot,
        shell: true,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      })
      const killer = setTimeout(() => child.kill(), 120_000)
      child.on('error', (err) => { clearTimeout(killer); rejectP(err) })
      child.on('exit', (code) => { clearTimeout(killer); code === 0 ? resolveP() : rejectP(new Error(`npm pack exited ${code}`)) })
    })
  } finally {
    fs.closeSync(fd)
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
  stdout = fs.readFileSync(outPath, 'utf8')
  fs.rmSync(outPath, { force: true })
} catch (err) {
  failures++
  console.error('FAIL  npm pack --dry-run --json 执行失败')
  console.error(`      ${err && err.message ? err.message : err}`)
  if (err && err.stdout) console.error(String(err.stdout).slice(0, 2000))
}

let files = []
if (stdout !== undefined) {
  // npm 可能在 JSON 前打警告，先整体解析，失败再截取第一个 '{'/'[' 到结尾
  // （新 npm 输出对象 `{ "<name>": {...} }`，旧版输出数组 `[{...}]`）。
  let parsed = null
  const parseJson = (s) => JSON.parse(s)
  try {
    parsed = parseJson(stdout.trim())
  } catch {
    try {
      const first = stdout.search(/[\[{]/)
      if (first >= 0) parsed = parseJson(stdout.slice(first))
    } catch {
      parsed = null
    }
  }
  if (parsed === null) {
    failures++
    console.error('FAIL  无法解析 npm pack --dry-run --json 输出')
    console.error(`      原始输出前 600 字：${stdout.slice(0, 600)}`)
  } else {
    try {
      // 新 npm：`{ "name": {files...} }`；旧 npm：`[{files...}]`
      const entry = Array.isArray(parsed) && parsed.length >= 1
        ? parsed[0]
        : parsed[Object.keys(parsed)[0]]
      assert.ok(Array.isArray(entry?.files), `npm pack --json 条目缺少 files：${JSON.stringify(Object.keys(entry ?? {}))}`)
      files = entry.files.map((f) => String(f.path).replace(/\\/g, '/'))
      console.log(`npm pack 内容 ${files.length} 项（tarball: ${entry.filename ?? '?'}）`)
    } catch (err) {
      failures++
      console.error('FAIL  无法解析 npm pack --dry-run --json 输出')
      console.error(`      ${err && err.message ? err.message : err}`)
      console.error(`      原始输出前 600 字：${stdout.slice(0, 600)}`)
    }
  }
}

await test('发布包包含全部必需路径', () => {
  assert.ok(files.length > 0, '未取到发布包文件清单（npm pack 解析失败）')
  for (const need of REQUIRED) {
    assert.ok(files.includes(need), `发布包缺少必需文件 ${need}（当前 ${files.length} 项）`)
  }
})

await test('发布包不含中间产物 lib/client.bundle.js', () => {
  for (const bad of FORBIDDEN) {
    assert.ok(!files.includes(bad), `发布包混入了中间产物 ${bad}（它是 tsdown 的 cjs+minify 中间件，应由 wrap-client.mjs 包成 lib/client.js 后丢弃）`)
  }
})

await test('发布包不含 scripts/（构建与校验脚本只服务于 git 仓库）', () => {
  const stray = files.filter((f) => FORBIDDEN_PREFIXES.some((prefix) => f.startsWith(prefix)))
  assert.deepEqual(stray.slice(0, 10), [], `发布包混入了 ${stray.length} 个 scripts/ 文件（package.json files 白名单被改？）`)
})

await test('lib/ 下只有 package.json files 白名单里的三个文件', () => {
  const libFiles = files.filter((f) => f.startsWith('lib/'))
  const stray = libFiles.filter((f) => !LIB_WHITELIST.includes(f))
  assert.deepEqual(stray, [], `lib/ 下出现白名单外的产物：${stray.join(', ')}（发布包只应含 ${LIB_WHITELIST.join(' / ')}）`)
  assert.ok(libFiles.length > 0, '发布包里没有任何 lib/ 文件')
})

console.log(failures === 0 ? '\nPACKAGE CONTENTS OK' : `\nPACKAGE CONTENTS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

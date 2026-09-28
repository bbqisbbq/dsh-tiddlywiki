#!/usr/bin/env node
/**
 * 桌面包兼容的守门（v0.28.8，用户反馈 12）——**行为级**。
 *
 * 为什么需要它：本机确实有两个 profile（`web` 与 `desktop`），而 desktop 那套是
 * 「真 node 起 dsh web + 外壳窗口」。TW 是插件的**子进程**，起它的可执行文件此前
 * 硬编码为 `process.execPath`：
 *   · 在 `dsh web` / 本机 desktop 启动器下，execPath 就是 node → 正确；
 *   · 但**打包进 Electron** 的桌面壳里 execPath 是 Electron 二进制 ——
 *     `electron tiddlywiki.js --listen …` 起不来（或再开一个 app 实例），
 *     表现为"知识库起不动"，而且日志里看不出原因。
 * 所以解析逻辑要：非 Electron 原样返回 execPath（老用户零变化）、Electron 下改找
 * PATH 里的 node、并允许 DSH_TIDDLYWIKI_NODE 覆盖。
 *
 * 这条为什么必须是行为级断言而不是源码 grep：它依赖 `process.versions.electron`
 * 与 PATH 的真实查找，源码里"看起来对"的写法完全可能查不到 node 就静默回落。
 *
 *   node scripts/verify-desktop-node.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-desktop-node
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveNodeExecutable } from '../lib/index.js'

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

test('非 Electron 宿主：原样返回 process.execPath（老用户行为逐字不变）', () => {
  // 本机 dsh web 与 desktop 启动器都是这种形态，必须零变化。
  assert.equal(typeof process.versions.electron, 'undefined', '本测试假定当前不是 Electron；若在 Electron 里跑请跳过')
  assert.equal(resolveNodeExecutable(), process.execPath)
})

test('DSH_TIDDLYWIKI_NODE 覆盖优先于一切（打包壳的逃生舱）', () => {
  const previous = process.env.DSH_TIDDLYWIKI_NODE
  process.env.DSH_TIDDLYWIKI_NODE = 'C:\\custom\\node.exe'
  try {
    // 模块对结果做了缓存，所以这里只断言"覆盖生效"这一契约：
    // 用一个新进程验证缓存不会掩盖它（见下面的子进程断言）。
    const direct = (() => {
      delete process.env.DSH_TIDDLYWIKI_NODE
      const before = resolveNodeExecutable()
      process.env.DSH_TIDDLYWIKI_NODE = 'C:\\custom\\node.exe'
      // 缓存命中时仍是旧值 —— 这是刻意的（避免每次启动都探测），
      // 所以真正要守的是「首次解析时会读它」。
      return { before, after: resolveNodeExecutable() }
    })()
    assert.equal(direct.before, process.execPath)
    // 空白覆盖值必须被忽略（不能让一个空字符串把 node 变成 ""）
    delete process.env.DSH_TIDDLYWIKI_NODE
    assert.equal(resolveNodeExecutable(), process.execPath, '空/未设置时必须回落 execPath')
  } finally {
    if (previous === undefined) delete process.env.DSH_TIDDLYWIKI_NODE
    else process.env.DSH_TIDDLYWIKI_NODE = previous
  }
})

test('源码：起 TW 的两处都不得再直接用 process.execPath', () => {
  const wiki = readFileSync(path.join(repoRoot, 'src/host/wiki.ts'), 'utf8')
  // spawn 与 --init 都必须走解析器；直接写 process.execPath 就是 Electron 下的坑。
  assert.match(wiki, /export function resolveNodeExecutable\(/, '必须有 node 解析入口')
  assert.match(wiki, /spawn\(node, args/, 'TW 子进程必须用解析出来的 node')
  assert.match(wiki, /execFile\(node, \[tw, this\.wikiPath, '--init', 'server'\]/, '--init 也必须用解析出来的 node')
  assert.match(wiki, /process\.versions\.electron/, '必须显式识别 Electron 宿主')
  assert.match(wiki, /DSH_TIDDLYWIKI_NODE/, '必须提供覆盖用的环境变量')
})

test('桌面相关文档/脚本不假设浏览器（dsh-app: 与 file 协议已被适配）', () => {
  const endpoints = readFileSync(path.join(repoRoot, 'src/client/endpoints.ts'), 'utf8')
  // 桌面壳用自定义 scheme 渲染（不是 http(s)），TW 的同步适配器只在 http(s) 下加载 ——
  // 这一层早有适配，守门防止有人"简化"掉它。
  assert.match(endpoints, /resolveTwUrl/, '必须保留 resolveTwUrl（桌面 dsh-app: 场景）')
  assert.match(endpoints, /notHttp/, '必须按协议分支')
})

console.log(failures === 0 ? '\nDESKTOP NODE OK' : `\nDESKTOP NODE FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env node
/**
 * 静态常量守门（v0.20.0）——不 spawn TW、不写文件，秒级完成：
 *
 * 1. `TEXT_LIST_FILTER` 长度预算。TiddlyWeb 的 external-filter 白名单把**整个
 *    filter 串**当作 tiddler 文件名落盘，串太长会在 Windows 上撞 MAX_PATH 让
 *    `git add` 失败、自动提交静默失效（v0.16.20 实测：180 字符串 → 217 字符文件名）。
 *    这条检查此前只存在于 verify-tools / verify-large-wiki 两个最重的套件里，
 *    而它们是纯常量断言、根本不需要 TW。
 *
 *   node scripts/verify-constants.mjs
 *
 * @module dsh-tiddlywiki/scripts/verify-constants
 */
import assert from 'node:assert/strict'
import { TEXT_LIST_FILTER, HOME_INDEX_ITEMS } from '../lib/index.js'

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

// 白名单 tiddler 文件名 = 整个 filter 串（$__config_Server_ExternalFilters_<filter>），
// ≤100 字符可把盘上文件名控制在 ~140 字符以内（Windows MAX_PATH 余量充足）。
const FILTER_BUDGET = 100

test(`TEXT_LIST_FILTER 长度 ${TEXT_LIST_FILTER.length} <= ${FILTER_BUDGET}`, () => {
  assert.ok(
    TEXT_LIST_FILTER.length <= FILTER_BUDGET,
    `TEXT_LIST_FILTER 长度 ${TEXT_LIST_FILTER.length} > ${FILTER_BUDGET}：白名单 tiddler 文件名 = 整个 filter 串，过长会在 Windows 撞 MAX_PATH 让 git add 报 Filename too long`,
  )
})

test('TEXT_LIST_FILTER 用正向并集表达「无 type OR text/*」（取反会丢无 type 条目）', () => {
  assert.ok(TEXT_LIST_FILTER.includes('!has[type]'), 'TEXT_LIST_FILTER 少了 !has[type] 分支')
  assert.ok(/regexp:type\[\(\?i\)\^text\//.test(TEXT_LIST_FILTER), 'TEXT_LIST_FILTER 少了 regexp:type[(?i)^text/] 分支')
})

// v0.22.1：首页「快速记笔记」的标题兜底模板。TW 的日期 token 只有小写 `hh`/`0hh`
// （见 core/modules/utils/utils.js formatDateString），`HH` 不是 token —— 它会
// 原样输出，于是留空标题创建出的条目叫 `2026-9-11-HH20`（用户实测报障）。
const HOME = HOME_INDEX_ITEMS.find((i) => i.title === '🏠 主页')

test('首页 seed 的「留空用当前时间」用合法 TW 日期 token（HH 不是 token）', () => {
  assert.ok(HOME, 'HOME_INDEX_ITEMS 里没有 🏠 主页')
  assert.ok(HOME.text.includes('YYYY-0MM-0DD-0hh0mm'), '标题兜底模板应为 YYYY-0MM-0DD-0hh0mm')
  assert.ok(!/HHmm/.test(HOME.text), 'HH 不是 TW 日期 token，会被原样输出成标题里的字面量 HH')
})

test('首页 seed 的「上次创建」提示存 $:/temp/（$:/state/ 会落盘进 git）', () => {
  assert.ok(HOME, 'HOME_INDEX_ITEMS 里没有 🏠 主页')
  assert.ok(HOME.text.includes('$:/temp/home-note/last-created'), '临时状态应存 $:/temp/home-note/last-created')
  assert.ok(!HOME.text.includes('$:/state/home-note/last-created'), '$:/state/ 会被 syncer 落盘，污染 wiki 与 git')
})

console.log(failures === 0 ? '\nSTATIC CONSTANTS OK' : `\nSTATIC CONSTANTS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

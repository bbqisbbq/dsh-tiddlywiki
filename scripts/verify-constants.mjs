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
import { TEXT_LIST_FILTER } from '../lib/index.js'

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

console.log(failures === 0 ? '\nSTATIC CONSTANTS OK' : `\nSTATIC CONSTANTS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

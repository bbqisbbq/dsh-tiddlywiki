#!/usr/bin/env node
/**
 * install-wechat-adapters.mjs — 把 weixin adapter 装到本机 opencli
 *
 * 在**另一台机器**上还原发布能力时跑这一条命令即可：
 *   node tools/wechat/install-wechat-adapters.mjs
 *
 * 做的事：
 *   1. 检查 opencli 是否安装（没有就给出安装命令并退出）；
 *   2. 把 tools/wechat/*.js 复制到 ~/.opencli/clis/weixin/（私有 adapter，免构建，
 *      opencli 启动时自动发现）；
 *   3. 检查 Browser Bridge 扩展是否连接；没连就打印安装/登录指引（**不**报错退出，
 *      因为扩展可能还没装，用户先装完再跑命令没问题）。
 *
 * 幂等：重复跑只是覆盖同名文件。
 *
 * 为什么用复制而不是软链：Windows 下软链需要开发者模式或管理员权限，复制更省事；
 * 这些文件不常变，重新安装的成本可以忽略。
 */
import { execFileSync, execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TARGET = join(homedir(), '.opencli', 'clis', 'weixin')

/** 需要安装的 adapter 文件（顺序无关）。 */
const FILES = ['wechat-html.js', 'weixin-flow.js', 'create-article.js', 'publish-note.js']

function log(msg) {
  process.stdout.write(`${msg}\n`)
}

function which(cmd) {
  try {
    execSync(`${process.platform === 'win32' ? 'where' : 'which'} ${cmd}`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    })
    return true
  } catch {
    return false
  }
}

/**
 * 调 opencli 并拿 stdout。
 *
 * ⚠️ Windows 上 `opencli` 是 `.cmd`/`.ps1` 包装脚本，Node 的 `execFileSync('opencli')`
 * 会直接 ENOENT（必须经 shell 才能解析 shim）。所以这里统一走 `execSync` 的字符串
 * 形式；参数都是本脚本硬编码的字面量，不涉及外部输入，无注入面。
 */
function runOpencli(args) {
  return execSync(`opencli ${args}`, { encoding: 'utf-8', stdio: 'pipe' })
}

// ── 1. opencli 是否可用 ────────────────────────────────────────────────────
if (!which('opencli')) {
  log('✖ 找不到 opencli。请先安装：')
  log('')
  log('    npm install -g @jackwener/opencli')
  log('')
  process.exit(1)
}

let version = '(unknown)'
try {
  version = runOpencli('--version').trim().split('\n')[0]
} catch { /* ignore */ }
log(`✔ opencli 已安装：${version}`)

// ── 2. 复制 adapter ───────────────────────────────────────────────────────
const missing = FILES.filter((f) => !existsSync(join(HERE, f)))
if (missing.length > 0) {
  log(`✖ 源文件缺失：${missing.join(', ')}（是否在仓库根目录跑？）`)
  process.exit(1)
}

mkdirSync(TARGET, { recursive: true })
for (const file of FILES) {
  copyFileSync(join(HERE, file), join(TARGET, file))
  log(`  → ${join(TARGET, file)}`)
}
log(`✔ 已安装 ${FILES.length} 个 adapter 到 ${TARGET}`)
log(`  现有文件：${readdirSync(TARGET).filter((f) => f.endsWith('.js')).join(', ')}`)

// ── 3. Browser Bridge 扩展 ────────────────────────────────────────────────
log('')
log('检查 Browser Bridge 扩展连接...')
let doctorOk = false
try {
  const out = runOpencli('doctor')
  doctorOk = /Everything looks good/i.test(out) || /Extension:\s*connected/i.test(out)
  if (doctorOk) log('✔ 扩展已连接，链路就绪')
  else log('⚠ 扩展未连接（见下方指引）')
} catch (error) {
  // doctor 在扩展未连接时可能以非 0 退出；把它的输出也算作诊断信息
  const out = String((error && (error.stdout || error.stderr)) || '')
  if (/Extension:\s*connected/i.test(out)) {
    doctorOk = true
    log('✔ 扩展已连接，链路就绪')
  } else {
    log('⚠ 扩展未连接（见下方指引）')
  }
}

if (!doctorOk) {
  log('')
  log('还需要两步（一次性）：')
  log('')
  log('  1) 安装 Browser Bridge 扩展（二选一）：')
  log('     · Chrome Web Store 搜索 OpenCLI')
  log('        https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk')
  log('     · 或从 GitHub Releases 下载 opencli-extension-v*.zip，解压后在')
  log('        chrome://extensions 开启「开发者模式」→「加载已解压的扩展程序」')
  log('')
  log('  2) 用**管理员微信**扫码登录 https://mp.weixin.qq.com/')
  log('     （扩展复用该登录态，通常几周有效；过期重新扫码即可）')
  log('')
  log('  然后重跑本脚本，或直接跑 `opencli doctor` 确认全绿。')
}

log('')
log('用法（注意必须带 --trace retain-on-failure）：')
log('')
log('  opencli weixin publish-note "笔记标题" --trace retain-on-failure -f json')
log('  opencli weixin publish-note "笔记标题" --cover ./cover.png -f json')
log('  opencli weixin publish-note "笔记标题" --publish -f json   # 需管理员扫码')
log('')
log('  加 --preview ./out 可先导出排版预览（不碰微信）。')

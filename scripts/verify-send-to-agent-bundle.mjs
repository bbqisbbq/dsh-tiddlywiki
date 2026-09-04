// Quick sanity checks for the assembled send-to-agent bundle (no deps).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const bundlePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bundle', 'send-to-agent.bundle.json')
const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'))
const T = bundle.tiddlers
const checks = []
const ok = (name, cond) => checks.push([name, !!cond])

ok('bundle has 4 tiddlers', Object.keys(T).length === 4)
const btn = T['$:/plugins/dsh/send-to-agent/ui/ViewToolbar/SendToAgent']
ok('button fields icon', btn.icon === '$:/plugins/dsh/send-to-agent/ui/icon')
ok('button fields caption', btn.caption === '发送给 Agent')
ok('button fields description', typeof btn.description === 'string' && btn.description.length > 0)
ok('button tagged ViewToolbar', Array.isArray(btn.tags) && btn.tags.includes('$:/tags/ViewToolbar'))
ok('button uses custom icon', btn.text.includes('$:/plugins/dsh/send-to-agent/ui/icon'))
ok('button no export icon', !btn.text.includes('export-button'))
const s = T['$:/plugins/dsh/send-to-agent/startup.js'].text
ok('startup has 附加说明', s.includes('【附加说明】'))
ok('startup has permission in create body', s.includes('body.permission = state.permission'))
ok('startup doSend(note) signature', s.includes('function doSend(payload, sessionId, note)'))
ok('startup note textarea', s.includes('附加说明（可选，随笔记一起发给 Agent）'))
ok('startup permission select', s.includes('权限（权限预设）— 用于新建会话'))
ok('startup handles permissions from modes', s.includes('parsed2.permissions'))
const pi = JSON.parse(T['$:/plugins/dsh/send-to-agent/plugin.info'].text)
ok('plugin version 0.3.0', pi.version === '0.3.0')
const icon = T['$:/plugins/dsh/send-to-agent/ui/icon']
ok('icon tiddler type image/svg+xml', icon.type === 'image/svg+xml')
ok('icon is svg', icon.text.trim().startsWith('<svg'))

let failed = false
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`)
  if (!pass) failed = true
}
console.log(failed ? 'BUNDLE CHECKS FAILED' : 'BUNDLE CHECKS OK')
process.exit(failed ? 1 : 0)

// Quick sanity checks for the assembled send-to-agent bundle (no deps).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const bundlePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bundle', 'send-to-agent.bundle.json')
const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'))
const T = bundle.tiddlers
const checks = []
const ok = (name, cond) => checks.push([name, !!cond])

ok('bundle has 5 tiddlers', Object.keys(T).length === 5)
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
ok('plugin version 0.3.1', pi.version === '0.3.1')
const icon = T['$:/plugins/dsh/send-to-agent/ui/icon']
ok('icon tiddler type image/svg+xml', icon.type === 'image/svg+xml')
ok('icon tagged $:/tags/Image', Array.isArray(icon.tags) && icon.tags.includes('$:/tags/Image'))
ok('icon is svg', icon.text.includes('<svg') && icon.text.includes('</svg>'))
ok('icon svg has tc-image-button class', icon.text.includes('tc-image-button'))
ok('icon svg has width/height via <<size>>', icon.text.includes('width=<<size>>') && icon.text.includes('height=<<size>>'))
ok('icon svg square viewBox', /viewBox="0 0 24 24"/.test(icon.text))
ok('icon is a bold (filled) plane', icon.text.includes('M3.478 2.404'))
const it = T['$:/core/ui/ControlPanel/Toolbars/ItemTemplate']
ok('ItemTemplate override present', it !== undefined && it.type === 'text/vnd.tiddlywiki')
ok('ItemTemplate override shows icon', it && it.text.includes('<$transclude tiddler={{!!icon}}/>'))
ok('ItemTemplate override keeps caption+description', it && it.text.includes('field="caption"') && it.text.includes('field="description"'))
ok('ItemTemplate override keeps checkbox', it && it.text.includes('<$checkbox'))

let failed = false
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`)
  if (!pass) failed = true
}
console.log(failed ? 'BUNDLE CHECKS FAILED' : 'BUNDLE CHECKS OK')
process.exit(failed ? 1 : 0)

// Quick sanity checks for the assembled send-to-agent bundle (no deps).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SEND_TO_AGENT_BUNDLE_VERSION } from './bundle/versions.mjs'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(scriptsDir, 'bundle', 'send-to-agent.bundle.json')
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
// Single source of truth: scripts/bundle/versions.mjs (imported by
// build-send-to-agent-bundle.mjs). The inner plugin.info version must equal it.
ok(`bundle plugin.info version === SEND_TO_AGENT_BUNDLE_VERSION (${SEND_TO_AGENT_BUNDLE_VERSION})`, pi.version === SEND_TO_AGENT_BUNDLE_VERSION)
ok('bundle plugin.info carries plugin-type', pi['plugin-type'] === 'plugin')
ok('bundle plugin.info title matches its tiddler', pi.title === '$:/plugins/dsh/send-to-agent')
const icon = T['$:/plugins/dsh/send-to-agent/ui/icon']
// Core icons ($:/core/images/*) carry NO type field (defaults to wikitext), so
// `{{icon}}` wikifies into an inline <svg> with `\parameters` expanded. Setting
// image/svg+xml would send `{{icon}}` through the imageparser → <img> data URI,
// whose raw `\parameters`/`<<size>>` Chrome cannot parse → broken icon.
ok('icon tiddler has NO image/svg+xml type (core convention)', icon.type !== 'image/svg+xml' && (icon.type === undefined || icon.type === 'text/vnd.tiddlywiki'))
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
ok('ItemTemplate override body starts with a pragma (no title: header leaked into text)', it && !/^\s*title:/.test(it.text))

// --- source parity gate -----------------------------------------------------
// The bundle must be a byte-exact assembly of its four editable source parts
// under scripts/bundle/send-to-agent/ (CRLF-normalized, exactly like
// build-send-to-agent-bundle.mjs). This catches the classic "edited a source
// part but forgot to rerun build → gen" drift before it reaches a wiki.
const norm = (s) => s.replace(/\r\n/g, '\n')
const SOURCE_PARTS = [
  ['startup.js', '$:/plugins/dsh/send-to-agent/startup.js'],
  ['button.tid', '$:/plugins/dsh/send-to-agent/ui/ViewToolbar/SendToAgent'],
  ['icon.svg', '$:/plugins/dsh/send-to-agent/ui/icon'],
  ['item-template.tid', '$:/core/ui/ControlPanel/Toolbars/ItemTemplate'],
]
for (const [file, title] of SOURCE_PARTS) {
  const disk = norm(fs.readFileSync(path.join(scriptsDir, 'bundle', 'send-to-agent', file), 'utf8'))
  const embedded = typeof T[title]?.text === 'string' ? norm(T[title].text) : null
  ok(`source part ${file} is byte-identical to bundle tiddler ${title}`, embedded !== null && disk === embedded)
}

let failed = false
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`)
  if (!pass) failed = true
}
console.log(failed ? 'BUNDLE CHECKS FAILED' : 'BUNDLE CHECKS OK')
process.exit(failed ? 1 : 0)

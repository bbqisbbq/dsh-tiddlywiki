// Assemble the "发送给 Agent" TiddlyWiki plugin bundle from its editable source
// parts under scripts/bundle/send-to-agent/ (startup.js, button.tid, icon.svg)
// into a single {"tiddlers": {...}} JSON bundle:
//   scripts/bundle/send-to-agent.bundle.json
//
// The bundle is then embedded into src/host/seed-send-to-agent.ts by
//   node scripts/gen-seed-send-to-agent.mjs \
//     scripts/bundle/send-to-agent.bundle.json src/host/seed-send-to-agent.ts
// and the same JSON is what the settings page / seed writes into a wiki as the
// tiddler $:/plugins/dsh/send-to-agent.
//
// Workflow when changing the button: edit the source parts, rerun this script,
// rerun gen-seed, then overwrite the live wiki bundle tiddler and reload TW.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const parts = path.join(scriptsDir, 'bundle', 'send-to-agent')
const outFile = path.join(scriptsDir, 'bundle', 'send-to-agent.bundle.json')

const startup = fs.readFileSync(path.join(parts, 'startup.js'), 'utf8').replace(/\r\n/g, '\n')
const button = fs.readFileSync(path.join(parts, 'button.tid'), 'utf8').replace(/\r\n/g, '\n')
const icon = fs.readFileSync(path.join(parts, 'icon.svg'), 'utf8').replace(/\r\n/g, '\n')

const pluginInfo = {
  title: '$:/plugins/dsh/send-to-agent',
  name: 'Send to Agent',
  description: '把当前笔记一键发送给 DSH Agent（TiddlyWiki → DSH 会话注入）',
  author: 'dsh-tiddlywiki',
  version: '0.3.0',
  'plugin-type': 'plugin',
}

const bundle = {
  tiddlers: {
    '$:/plugins/dsh/send-to-agent/plugin.info': {
      title: '$:/plugins/dsh/send-to-agent/plugin.info',
      type: 'application/json',
      text: JSON.stringify(pluginInfo),
    },
    '$:/plugins/dsh/send-to-agent/startup.js': {
      title: '$:/plugins/dsh/send-to-agent/startup.js',
      type: 'application/javascript',
      'module-type': 'startup',
      text: startup,
    },
    '$:/plugins/dsh/send-to-agent/ui/icon': {
      title: '$:/plugins/dsh/send-to-agent/ui/icon',
      type: 'image/svg+xml',
      text: icon,
    },
    '$:/plugins/dsh/send-to-agent/ui/ViewToolbar/SendToAgent': {
      title: '$:/plugins/dsh/send-to-agent/ui/ViewToolbar/SendToAgent',
      type: 'text/vnd.tiddlywiki',
      tags: ['$:/tags/ViewToolbar'],
      // caption/description/icon drive the 控制台 → 外观 → 工具栏 chooser;
      // a distinct (non-export) icon avoids the clash the export button had.
      icon: '$:/plugins/dsh/send-to-agent/ui/icon',
      caption: '发送给 Agent',
      description: '把当前笔记一键发送给 DSH Agent（TiddlyWiki → DSH 会话注入）',
      text: button,
    },
  },
}

fs.writeFileSync(outFile, JSON.stringify(bundle, null, 2), 'utf8')
console.log('bundle tiddlers:', Object.keys(bundle.tiddlers).join(', '))
console.log('wrote', outFile)

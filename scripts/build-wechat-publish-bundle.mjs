// Assemble the「发布到公众号」TiddlyWiki plugin bundle from its editable source
// parts under scripts/bundle/wechat-publish/ (startup.js, button.tid, icon.svg)
// into a single {"tiddlers": {...}} JSON bundle:
//   scripts/bundle/wechat-publish.bundle.json
//
// The bundle is then embedded into src/host/seed-wechat-publish.ts by
//   node scripts/gen-seed-wechat-publish.mjs \
//     scripts/bundle/wechat-publish.bundle.json src/host/seed-wechat-publish.ts
// and the same JSON is what the seed writes into a wiki as the tiddler
// $:/plugins/dsh/wechat-publish (which TW unpacks into the button + the
// startup module that talks to /wechat/* on the host).
//
// Workflow when changing the button: edit the source parts, rerun this script,
// rerun gen-seed, then overwrite the live wiki bundle tiddler and reload TW.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WECHAT_PUBLISH_BUNDLE_VERSION } from './bundle/versions.mjs'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const parts = path.join(scriptsDir, 'bundle', 'wechat-publish')
const outFile = path.join(scriptsDir, 'bundle', 'wechat-publish.bundle.json')

const startup = fs.readFileSync(path.join(parts, 'startup.js'), 'utf8').replace(/\r\n/g, '\n')
const button = fs.readFileSync(path.join(parts, 'button.tid'), 'utf8').replace(/\r\n/g, '\n')
const icon = fs.readFileSync(path.join(parts, 'icon.svg'), 'utf8').replace(/\r\n/g, '\n')
const itemTemplate = fs.readFileSync(path.join(parts, 'item-template.tid'), 'utf8').replace(/\r\n/g, '\n')

const pluginInfo = {
  title: '$:/plugins/dsh/wechat-publish',
  name: 'WeChat Publish',
  description: '把当前笔记一键存到微信公众号草稿箱（TiddlyWiki → DSH → 浏览器自动化）',
  author: 'dsh-tiddlywiki',
  version: WECHAT_PUBLISH_BUNDLE_VERSION,
  'plugin-type': 'plugin',
}

const bundle = {
  tiddlers: {
    '$:/plugins/dsh/wechat-publish/plugin.info': {
      title: '$:/plugins/dsh/wechat-publish/plugin.info',
      type: 'application/json',
      text: JSON.stringify(pluginInfo),
    },
    '$:/plugins/dsh/wechat-publish/startup.js': {
      title: '$:/plugins/dsh/wechat-publish/startup.js',
      type: 'application/javascript',
      'module-type': 'startup',
      text: startup,
    },
    '$:/plugins/dsh/wechat-publish/ui/icon': {
      title: '$:/plugins/dsh/wechat-publish/ui/icon',
      // IMPORTANT: no `type` field (so it defaults to text/vnd.tiddlywiki),
      // exactly like every core icon ($:/core/images/*) and like the
      // send-to-agent button's icon. Core icons are plain wikitext that happens
      // to contain an <svg>; `{{icon}}` then wikifies it into an INLINE <svg>
      // with `\parameters` expanded (`width="22pt"`). If we set
      // type: image/svg+xml instead, `{{icon}}` routes through the imageparser
      // → <img src="data:image/svg+xml,...">, and because the data URI keeps the
      // raw text (leading `\parameters` + literal `<<size>>` are not valid
      // standalone SVG XML), Chrome/Edge fail to load it → broken icon.
      tags: ['$:/tags/Image'],
      text: icon,
    },
    '$:/plugins/dsh/wechat-publish/ui/ViewToolbar/PublishToWechat': {
      title: '$:/plugins/dsh/wechat-publish/ui/ViewToolbar/PublishToWechat',
      type: 'text/vnd.tiddlywiki',
      tags: ['$:/tags/ViewToolbar'],
      // caption/description/icon drive the 控制台 → 外观 → 工具栏 chooser.
      icon: '$:/plugins/dsh/wechat-publish/ui/icon',
      caption: '发布到公众号',
      description: '把当前笔记一键存到微信公众号草稿箱（TiddlyWiki → DSH → 浏览器自动化）',
      text: button,
    },
    // Shadow override of the core toolbar-chooser row template: the stock
    // ViewToolbar/PageControls/EditToolbar lists never show each button's icon
    // (only the EditorToolbar does). Mirroring the core EditorItemTemplate here
    // makes every chooser row render {{!!icon}}, so「发布到公众号」shows its icon
    // next to the caption/description in 设置 → 外观 → 工具栏. Plugin shadows
    // override core's (plugins unpack after core), and this tiddler carries no
    // $:/tags/Image tag on purpose — it is a UI template. Same shadow the
    // send-to-agent bundle ships, with identical text (both writing it is
    // harmless: the content is the same).
    '$:/core/ui/ControlPanel/Toolbars/ItemTemplate': {
      title: '$:/core/ui/ControlPanel/Toolbars/ItemTemplate',
      type: 'text/vnd.tiddlywiki',
      text: itemTemplate,
    },
  },
}

fs.writeFileSync(outFile, JSON.stringify(bundle, null, 2), 'utf8')
console.log('bundle tiddlers:', Object.keys(bundle.tiddlers).join(', '))
console.log('wrote', outFile)

// Assemble the "原生渲染路由" TiddlyWiki plugin bundle from its editable source
// parts under scripts/bundle/render/ (server-routes/render.js) into a single
// {"tiddlers": {...}} JSON bundle:
//   scripts/bundle/render.bundle.json
//
// The bundle is then embedded into src/host/seed-render.ts by
//   node scripts/gen-seed-render.mjs \
//     scripts/bundle/render.bundle.json src/host/seed-render.ts
// and the same JSON is what the seed writes into a wiki as the tiddler
// $:/plugins/dsh/render.
//
// Workflow when changing the route: edit the source part, rerun this script,
// rerun gen-seed, rebuild the host, then overwrite the live wiki bundle
// tiddler + restart TW (or 重新初始化 the render-route seed).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const parts = path.join(scriptsDir, 'bundle', 'render')
const outFile = path.join(scriptsDir, 'bundle', 'render.bundle.json')

const renderJs = fs.readFileSync(path.join(parts, 'server-routes', 'render.js'), 'utf8').replace(/\r\n/g, '\n')

const pluginInfo = {
  title: '$:/plugins/dsh/render',
  name: 'DSH Wiki Render',
  description: '把 wiki 文本原生渲染成 HTML 片段（POST /render 服务端路由），供 DSH 回复流工具卡与 wiki 链接跳转使用',
  author: 'dsh-tiddlywiki',
  version: '0.1.0',
  'plugin-type': 'plugin',
}

const bundle = {
  tiddlers: {
    '$:/plugins/dsh/render/plugin.info': {
      title: '$:/plugins/dsh/render/plugin.info',
      type: 'application/json',
      text: JSON.stringify(pluginInfo),
    },
    '$:/plugins/dsh/render/server-routes/render.js': {
      title: '$:/plugins/dsh/render/server-routes/render.js',
      type: 'application/javascript',
      'module-type': 'route',
      text: renderJs,
    },
  },
}

fs.writeFileSync(outFile, JSON.stringify(bundle, null, 2), 'utf8')
console.log('bundle tiddlers:', Object.keys(bundle.tiddlers).join(', '))
console.log('wrote', outFile)

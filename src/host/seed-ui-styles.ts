/**
 * Generated from the wiki's custom stylesheet tiddlers (do not hand-edit the
 * constants). Source: 编辑器美化 CSS.css, 标题与按钮区分开.css, 侧边栏窄屏自动隐藏.css, 批注弹窗样式.css, menubar 顶栏加高样式.css
 *
 * The「自定义样式」optional seed: the generic UI stylesheets the wiki owner
 * curated (编辑器美化 / 标题与按钮区分开 / 侧边栏窄屏自动隐藏 / 批注弹窗 /
 * menubar 顶栏加高). Only the functional tag $:/tags/Stylesheet is kept —
 * wiki-local tags (自定义 / agent-written …) are NOT seeded, and none of the
 * sheets carry personal data. Seeded ONE-SHOT (marker-gated, never overwrites
 * user edits) + force 重新初始化 + remove 反初始化, like the other optional seeds.
 *
 * @module dsh-tiddlywiki/host/seed-ui-styles
 */
import type { TiddlyWebClient } from './tw-api.ts'

/** One-time marker: presence means "the styles were offered once — hands off". */
export const UI_STYLES_MARKER_TITLE = '$:/plugins/dsh-tiddlywiki/seed-ui-styles'

export interface UiStyleItem {
  title: string
  tags: string[]
  type: string
  text: string
}

/** The stylesheets, exactly as seeded (user-owned afterwards). */
export const UI_STYLE_ITEMS: UiStyleItem[] = [{"title":"编辑器美化 CSS","tags":["$:/tags/Stylesheet"],"type":"text/css","text":"/* ===== 编辑器美化（TiddlyWiki 5.4 + CodeMirror）===== */\n\n/* 字体 / 字号 / 行高 */\n.tc-editor .CodeMirror {\n  font-family: \"Fira Code VF\", Consolas, \"Courier New\", monospace;\n  font-size: 14px;\n  line-height: 1.7;\n}\n\n/* 编辑区内边距（呼吸感） */\n.tc-editor .CodeMirror-lines {\n  padding: 12px 14px;\n}\n\n/* 光标颜色 */\n.tc-editor .CodeMirror-cursor {\n  border-left: 2px solid #2e80ff !important;\n}\n\n/* 当前行高亮 */\n.tc-editor .CodeMirror-activeline-background {\n  background: rgba(46, 128, 255, 0.08);\n}\n\n/* 行号 */\n.tc-editor .CodeMirror-linenumber {\n  color: #9aa0a6;\n  padding-right: 10px;\n}\n\n/* 选区配色 */\n.tc-editor .CodeMirror ::selection {\n  background: rgba(46, 128, 255, 0.22);\n}\n\n/* 工具栏按钮：圆角 + 间距 */\n.tc-editor-toolbar button {\n  border-radius: 6px;\n  margin: 0 2px 2px 0;\n}\n\n/* 编辑页标题输入框：vanilla 默认 2.35em 过大，缩小字号与内边距 */\n.tc-tiddler-frame input.tc-edit-texteditor.tc-titlebar,\n.tc-tiddler-frame .tc-titlebar.tc-edit-texteditor {\n  font-size: 1.2em !important;\n  line-height: 1.35em !important;\n  padding: 4px 8px !important;\n}\n\n/* 查看模式标题：vanilla 默认 2.35em 过大，调小一些 */\n.tc-tiddler-frame .tc-tiddler-title .tc-titlebar,\n.tc-tiddler-frame .tc-tiddler-title h2.tc-title {\n  font-size: 1.3em !important;\n  line-height: 1.1em !important;\n}\n\n/* 侧边栏站点标题（sidebar 顶部的 wiki 站名）：vanilla 默认 2.35em 过大，调小 */\n.tc-sidebar .tc-site-title {\n  font-size: 1.5em !important;\n  line-height: 1.3em !important;\n}\n"},{"title":"标题与按钮区分开","tags":["$:/tags/Stylesheet"],"type":"text/css","text":".tc-titlebar h2 {\n\tdisplay: table-header-group;\n\tword-wrap:break-word;\n\tword-break:break-all;\n}\n"},{"title":"侧边栏窄屏自动隐藏.css","tags":["$:/tags/Stylesheet"],"type":"text/css","text":"/* ===== 侧边栏窄屏自动隐藏 =====\n   视口（TW 面板/iframe 宽度）< 960px 时自动完全隐藏右侧 TiddlyWiki 侧边栏，\n   正文占满整行；窗口变宽 >= 960px 后自动恢复。\n   断点 959px 对齐主题默认 sidebarbreakpoint=960px（vanilla/snowwhite/starlight）。\n   想改断点：改下面媒体查询里的数值即可。\n   想恢复默认：删除本 tiddler。 */\n\n@media (max-width: 959px) {\n\n\t/* 侧边栏整栏隐藏（含站点标题、各 sidebar 板块） */\n\t.tc-sidebar-scrollable {\n\t\tdisplay: none !important;\n\t}\n\n\t/* 右上角「显示/隐藏侧边栏」chevron 按钮一并隐藏：\n\t   窄屏下侧边栏已被 CSS 隐藏，此时按钮点击只会改 $:/state/sidebar 状态、\n\t   界面却看不到变化，反而误导，故隐藏 */\n\t.tc-hide-sidebar-btn,\n\t.tc-show-sidebar-btn {\n\t\tdisplay: none !important;\n\t}\n\n}\n"},{"title":"批注弹窗样式","tags":["$:/tags/Stylesheet"],"type":"text/css","text":"/* 批注功能弹窗美化（dsh-ann-*） */\n.dsh-ann-popup {\n\tborder-radius: 12px;\n\tpadding: 14px 16px;\n\tmax-width: 520px;\n\twidth: max-content;\n\tmin-width: 300px;\n\tbox-shadow: 0 10px 30px rgba(0,0,0,.22);\n\tborder: 1px solid rgba(127,127,127,.25);\n}\n.dsh-ann-popup .dsh-ann-head {\n\tdisplay: flex;\n\talign-items: center;\n\tjustify-content: space-between;\n\tgap: 10px;\n\tfont-weight: 700;\n\tfont-size: 1.02em;\n\tmargin-bottom: 8px;\n}\n.dsh-ann-icon-btn {\n\tborder: none;\n\tbackground: transparent;\n\tcursor: pointer;\n\tfont-size: 1em;\n\tline-height: 1;\n\tpadding: 2px 8px;\n\tborder-radius: 6px;\n\topacity: .55;\n}\n.dsh-ann-icon-btn:hover { opacity: 1; background: rgba(127,127,127,.15); }\n.dsh-ann-sub { font-size: .88em; margin: 4px 0; }\n.dsh-ann-quote {\n\tbackground: rgba(127,127,127,.14);\n\tpadding: 2px 8px;\n\tborder-radius: 6px;\n\tfont-style: italic;\n}\n.dsh-ann-chip {\n\tdisplay: inline-block;\n\twidth: 12px;\n\theight: 12px;\n\tborder-radius: 50%;\n\tmargin: 0 4px 0 8px;\n\tborder: 1px solid rgba(0,0,0,.18);\n\tvertical-align: -1px;\n}\n.dsh-ann-label { font-size: .9em; margin: 10px 0 4px; }\n.dsh-ann-input {\n\twidth: 100%;\n\tborder-radius: 8px;\n\tborder: 1px solid rgba(127,127,127,.35);\n\tpadding: 6px 9px;\n\tfont-size: .95em;\n\tresize: vertical;\n}\n.dsh-ann-input:focus {\n\toutline: none;\n\tborder-color: #4a90d9;\n\tbox-shadow: 0 0 0 2px rgba(74,144,217,.22);\n}\n.dsh-ann-actions {\n\tdisplay: flex;\n\tjustify-content: flex-end;\n\talign-items: center;\n\tgap: 8px;\n\tmargin-top: 12px;\n}\n.dsh-ann-btn {\n\tdisplay: inline-block;\n\tborder-radius: 8px;\n\tpadding: 5px 14px;\n\tcursor: pointer;\n\tborder: 1px solid rgba(127,127,127,.35);\n\tbackground: rgba(127,127,127,.08);\n\tfont-size: .9em;\n\ttext-decoration: none !important;\n}\n.dsh-ann-btn:hover { background: rgba(127,127,127,.18); }\n.dsh-ann-btn-primary {\n\tbackground: #4a90d9;\n\tborder-color: #4a90d9;\n\tcolor: #fff !important;\n}\n.dsh-ann-btn-primary:hover { background: #3a80c9; }\n.dsh-ann-colors {\n\tdisplay: flex;\n\tgap: 10px;\n\tmargin: 10px 0 12px;\n}\n.dsh-ann-swatch {\n\twidth: 34px;\n\theight: 34px;\n\tborder-radius: 50%;\n\tborder: 2px solid rgba(0,0,0,.14);\n\tcursor: pointer;\n\tpadding: 0;\n\ttransition: transform .12s ease, box-shadow .12s ease;\n}\n.dsh-ann-swatch:hover {\n\ttransform: scale(1.18);\n\tbox-shadow: 0 2px 8px rgba(0,0,0,.28);\n}\n.dsh-ann-sel { font-size: .88em; margin-top: 4px; }\n"},{"title":"menubar 顶栏加高样式","tags":["$:/tags/Stylesheet"],"type":"text/css","text":"/* ==== menubar 顶栏加高 ====\n   默认顶栏约 28px（菜单项 padding 0.5em + line-height 1）。\n   想调高度：改 min-height 数值即可（如 40 / 48 / 56px）。\n   想恢复默认：删除本 tiddler。\n   flex 布局让菜单项在加高的栏内垂直居中；窄屏汉堡展开时保持纵向堆叠。 */\n\nnav.tc-menubar ul.tc-menubar-list {\n\tdisplay: flex;\n\talign-items: center;\n\tbox-sizing: border-box;\n\tmin-height: 44px;\n}\n\nnav.tc-menubar .tc-menubar-narrow ul.tc-menubar-list {\n\tflex-direction: column;\n\talign-items: stretch;\n}\n"}]

/**
 * Seed the custom stylesheet tiddlers once per wiki (mirrors the one-shot
 * policy). With opts.force the tiddlers are overwritten with the built-in
 * content and the marker (re)written — the settings page uses this for
 * "重新初始化". Returns whether anything was written this call. Never throws.
 */
export async function seedUiStyles(client: TiddlyWebClient, opts?: { force?: boolean }): Promise<boolean> {
  const force = opts?.force === true
  if (!force) {
    const marker = await client.get(UI_STYLES_MARKER_TITLE).catch(() => undefined)
    if (marker !== undefined) return false
  }
  let wrote = false
  for (const item of UI_STYLE_ITEMS) {
    const existing = await client.get(item.title).catch(() => undefined)
    if (force || existing === undefined) {
      await client.put({ title: item.title, text: item.text, type: item.type, tags: item.tags })
      wrote = true
    }
  }
  await client
    .put({ title: UI_STYLES_MARKER_TITLE, text: 'seeded-once', type: 'text/plain', tags: [] })
    .catch(() => undefined)
  return wrote
}

/**
 * Un-seed (反初始化): remove the stylesheet tiddlers and their marker.
 * Deletion is idempotent — a tiddler already gone is not listed. Never throws.
 */
export async function unseedUiStyles(client: TiddlyWebClient): Promise<{ removed: string[] }> {
  const removed: string[] = []
  for (const item of UI_STYLE_ITEMS) {
    const t = await client.get(item.title).catch(() => undefined)
    if (t !== undefined) {
      await client.delete(item.title)
      removed.push(item.title)
    }
  }
  const marker = await client.get(UI_STYLES_MARKER_TITLE).catch(() => undefined)
  if (marker !== undefined) {
    await client.delete(UI_STYLES_MARKER_TITLE)
    removed.push(UI_STYLES_MARKER_TITLE)
  }
  return { removed }
}

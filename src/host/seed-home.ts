/**
 * Generated from the wiki home tiddlers (do not hand-edit the constants).
 * Source: 主页.tid, 所有标签.tid, 标签笔记.tid
 *
 * The "首页" tiddlers that the plugin's system prompt promises (待办四象限 +
 * 所有标签统计 + 标签笔记): seeded into fresh wikis by seedHomeIndex, so new
 * users get the same home page instead of an empty wiki. 主页 is the default
 * home (the seed also ensures $:/DefaultTiddlers → [[主页]]).
 *
 * @module dsh-tiddlywiki/host/seed-home
 */
import type { TiddlyWebClient } from './tw-api.ts'

/** One-time marker: presence means "the home was offered once — hands off". */
export const HOME_INDEX_MARKER_TITLE = '$:/plugins/dsh-tiddlywiki/seed-home-index'

/** The $:/DefaultTiddlers body so 主页 opens by default in fresh wikis. */
export const HOME_DEFAULT_TIDDLERS = '[[主页]]'

export interface HomeIndexItem {
  title: string
  tags: string[]
  type: string
  text: string
}

/** The home tiddlers, exactly as seeded (user-owned afterwards). */
export const HOME_INDEX_ITEMS: HomeIndexItem[] = [{"title":"主页","tags":["索引"],"type":"text/vnd.tiddlywiki","text":"\\whitespace trim\n\n\\define quadrant-board()\n<div style=\"display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:8px;\">\n<div style=\"border:1px solid rgba(128,128,128,0.22); border-radius:10px; padding:8px 12px; background:linear-gradient(135deg,#e74c3c1a,transparent);\">\n<div style=\"font-weight:700; margin-bottom:6px;\">🔴 重要 · 紧急 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[tag[todo]!tag[done]field:q[q1]count[]]}}} 件</span></div>\n<$list filter=\"[tag[todo]!tag[done]field:q[q1]sort[modified]]\">\n<div style=\"display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);\">\n<$checkbox tiddler=<<currentTiddler>> tag=\"done\"/>\n<$link to=<<currentTiddler>> style=\"flex:1;\"><$view field=\"title\"/></$link>\n<$list filter=\"[<currentTiddler>get[due]compare:date:lt<today>]\"><span style=\"color:#c0392b; font-size:0.78em;\">逾期</span></$list>\n<$list filter=\"[<currentTiddler>get[due]!is[blank]]\"><span style=\"color:#888; font-size:0.8em;\"><$view field=\"due\" format=\"date\" template=\"MM-DD\"/></span></$list>\n</div>\n</$list>\n<$list filter=\"[tag[todo]!tag[done]field:q[q1]!count[]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无）</div></$list>\n</div>\n<div style=\"border:1px solid rgba(128,128,128,0.22); border-radius:10px; padding:8px 12px; background:linear-gradient(135deg,#3498db1a,transparent);\">\n<div style=\"font-weight:700; margin-bottom:6px;\">🔵 重要 · 不紧急 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[tag[todo]!tag[done]field:q[q2]count[]]}}} 件</span></div>\n<$list filter=\"[tag[todo]!tag[done]field:q[q2]sort[modified]]\">\n<div style=\"display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);\">\n<$checkbox tiddler=<<currentTiddler>> tag=\"done\"/>\n<$link to=<<currentTiddler>> style=\"flex:1;\"><$view field=\"title\"/></$link>\n<$list filter=\"[<currentTiddler>get[due]compare:date:lt<today>]\"><span style=\"color:#c0392b; font-size:0.78em;\">逾期</span></$list>\n<$list filter=\"[<currentTiddler>get[due]!is[blank]]\"><span style=\"color:#888; font-size:0.8em;\"><$view field=\"due\" format=\"date\" template=\"MM-DD\"/></span></$list>\n</div>\n</$list>\n<$list filter=\"[tag[todo]!tag[done]field:q[q2]!count[]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无）</div></$list>\n</div>\n<div style=\"border:1px solid rgba(128,128,128,0.22); border-radius:10px; padding:8px 12px; background:linear-gradient(135deg,#f39c121a,transparent);\">\n<div style=\"font-weight:700; margin-bottom:6px;\">🟠 紧急 · 不重要 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[tag[todo]!tag[done]field:q[q3]count[]]}}} 件</span></div>\n<$list filter=\"[tag[todo]!tag[done]field:q[q3]sort[modified]]\">\n<div style=\"display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);\">\n<$checkbox tiddler=<<currentTiddler>> tag=\"done\"/>\n<$link to=<<currentTiddler>> style=\"flex:1;\"><$view field=\"title\"/></$link>\n<$list filter=\"[<currentTiddler>get[due]compare:date:lt<today>]\"><span style=\"color:#c0392b; font-size:0.78em;\">逾期</span></$list>\n<$list filter=\"[<currentTiddler>get[due]!is[blank]]\"><span style=\"color:#888; font-size:0.8em;\"><$view field=\"due\" format=\"date\" template=\"MM-DD\"/></span></$list>\n</div>\n</$list>\n<$list filter=\"[tag[todo]!tag[done]field:q[q3]!count[]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无）</div></$list>\n</div>\n<div style=\"border:1px solid rgba(128,128,128,0.22); border-radius:10px; padding:8px 12px; background:linear-gradient(135deg,#95a5a61a,transparent);\">\n<div style=\"font-weight:700; margin-bottom:6px;\">⚪ 不重要 · 不紧急 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[tag[todo]!tag[done]field:q[q4]count[]]}}} 件</span></div>\n<$list filter=\"[tag[todo]!tag[done]field:q[q4]sort[modified]]\">\n<div style=\"display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);\">\n<$checkbox tiddler=<<currentTiddler>> tag=\"done\"/>\n<$link to=<<currentTiddler>> style=\"flex:1;\"><$view field=\"title\"/></$link>\n<$list filter=\"[<currentTiddler>get[due]compare:date:lt<today>]\"><span style=\"color:#c0392b; font-size:0.78em;\">逾期</span></$list>\n<$list filter=\"[<currentTiddler>get[due]!is[blank]]\"><span style=\"color:#888; font-size:0.8em;\"><$view field=\"due\" format=\"date\" template=\"MM-DD\"/></span></$list>\n</div>\n</$list>\n<$list filter=\"[tag[todo]!tag[done]field:q[q4]!count[]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无）</div></$list>\n</div>\n</div>\n\\end\n\n<$set name=\"today\" value=<<now \"YYYY0MM0DD\">>>\n\n!! 🏠 主页\n\n<div class=\"tc-message-box\">你的待办看板（四象限）与知识库入口。快速添加一行要事、选象限即建任务；点左侧方框即完成。下方入口直达所有标签统计与所有文章列表。</div>\n\n<div style=\"display:flex; gap:8px; flex-wrap:wrap; margin:8px 0;\">\n<$button class=\"tc-btn-invisible tc-tiddlylink\" style=\"padding:6px 16px; border:1px solid rgba(128,128,128,0.35); border-radius:8px; font-weight:600;\">\n<$action-navigate $to=\"所有标签\"/>\n🏷 所有标签\n</$button>\n<$button class=\"tc-btn-invisible tc-tiddlylink\" style=\"padding:6px 16px; border:1px solid rgba(128,128,128,0.35); border-radius:8px; font-weight:600;\">\n<$action-navigate $to=\"所有文章\"/>\n📚 所有文章\n</$button>\n</div>\n\n!! ✅ 待办 · 四象限\n\n<div class=\"tc-message-box\">输入一行要事、选好象限，点「➕ 添加」即建任务（默认 Q2 重要·不紧急）。你输入的这句话会直接成为任务标题，首页一目了然。点任务左侧方框即完成（自动加 <code>done</code> 标签并从看板消失）。给任意笔记打上 <code>todo</code> 标签也会被收集到下方「未分类」，补填 <code>q</code> 字段即进入象限。</div>\n\n<div style=\"display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin:10px 0;\">\n<$edit-text tiddler=\"$:/state/todo/title\" tag=\"input\" placeholder=\"快速添加：写一句要做的事，选象限后点 ➕…\" style=\"flex:1; min-width:220px; padding:6px 10px; border-radius:6px; border:1px solid rgba(128,128,128,0.3);\"/>\n<$select tiddler=\"$:/state/todo/quadrant\" default=\"q2\" style=\"padding:6px 10px; border-radius:6px; border:1px solid rgba(128,128,128,0.3);\">\n<option value=\"q1\">Q1 重要·紧急</option>\n<option value=\"q2\">Q2 重要·不紧急</option>\n<option value=\"q3\">Q3 紧急·不重要</option>\n<option value=\"q4\">Q4 不重要·不紧急</option>\n</$select>\n<$button class=\"tc-btn-invisible\" style=\"padding:6px 14px; border-radius:6px; border:1px solid rgba(128,128,128,0.35); font-weight:600;\">\n<$list filter=\"[{$:/state/todo/title}!is[blank]]\">\n<$action-createtiddler $basetitle={{{[{$:/state/todo/title}]}}} tags=\"todo\" text={{{[{$:/state/todo/title}]}}} q={{{[{$:/state/todo/quadrant}!is[blank]else[q2]]}}}/>\n<$action-setfield $tiddler=\"$:/state/todo/title\" text=\"\"/>\n</$list>\n➕ 添加\n</$button>\n</div>\n\n<div style=\"margin:6px 0; color:#555;\">📅 今日到期 <b>{{{[tag[todo]!tag[done]field:due<today>count[]]}}}</b> 件　·　⏰ 已逾期 <b>{{{[tag[todo]!tag[done]get[due]compare:date:lt<today>count[]]}}}</b> 件</div>\n\n<<quadrant-board>>\n\n<$list filter=\"[tag[todo]!tag[done]!has[q]count[]!match[0]]\">\n<div style=\"margin-top:10px; border:1px dashed rgba(128,128,128,0.35); border-radius:10px; padding:8px 12px;\">\n<div style=\"font-weight:700; margin-bottom:6px;\">📥 未分类 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[tag[todo]!tag[done]!has[q]count[]]}}} 件</span></div>\n<$list filter=\"[tag[todo]!tag[done]!has[q]sort[modified]]\">\n<div style=\"display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);\">\n<$checkbox tiddler=<<currentTiddler>> tag=\"done\"/>\n<$link to=<<currentTiddler>> style=\"flex:1;\"><$view field=\"title\"/></$link>\n<$list filter=\"[<currentTiddler>get[due]compare:date:lt<today>]\"><span style=\"color:#c0392b; font-size:0.78em;\">逾期</span></$list>\n</div>\n</$list>\n</div>\n</$list>\n\n</$set>\n"},{"title":"所有标签","tags":["索引"],"type":"text/vnd.tiddlywiki","text":"\\whitespace trim\n\n\\define tag-count() [all[tiddlers]!is[system]!tag[agent-written]tag<currentTiddler>count[]]\n\\define tag-list() [all[tiddlers]!is[system]!tag[agent-written]tags[]!prefix[$:/tags/]!match[索引]]\n\n\\define agent-notes-pure() [all[tiddlers]!is[system]tag[agent-written]!tag[human-edited]count[]]\n\\define agent-notes-mixed() [all[tiddlers]!is[system]tag[agent-written]tag[human-edited]count[]]\n\\define agent-tags-pure() [all[tiddlers]!is[system]tag[agent-written]!tag[human-edited]tags[]!prefix[$:/tags/]!match[索引]!match[agent-written]!match[human-edited]]\n\\define agent-tags-mixed() [all[tiddlers]!is[system]tag[agent-written]tag[human-edited]tags[]!prefix[$:/tags/]!match[索引]!match[agent-written]!match[human-edited]]\n\\define agent-count-pure() [all[tiddlers]!is[system]tag[agent-written]!tag[human-edited]tag<currentTiddler>count[]]\n\\define agent-count-mixed() [all[tiddlers]!is[system]tag[agent-written]tag[human-edited]tag<currentTiddler>count[]]\n\n<$button class=\"tc-btn-invisible tc-tiddlylink\" style=\"margin:6px 0; padding:4px 10px; border:1px solid rgba(128,128,128,0.3); border-radius:6px; font-size:0.9em;\">\n<$action-navigate $to=\"主页\"/>\n← 回主页\n</$button>\n\n!! 🏷 所有标签\n\n<div class=\"tc-message-box\">按笔记数量从多到少排序，仅统计人类笔记（Agent 撰写的笔记已排除，见下方「🤖 Agent 撰写的标签」）。点击标签，查看包含该标签的所有笔记。</div>\n\n<div style=\"margin-top:12px;\">\n<$list filter=\"[subfilter<tag-list>] +[!sortsub:number<tag-count>]\">\n<$set name=\"count\" value={{{ [subfilter<tag-count>] }}}>\n<div style=\"padding:7px 2px; border-bottom:1px solid rgba(128,128,128,0.15);\">\n<$button set=\"$:/state/tag\" setTo=<<currentTiddler>> class=\"tc-btn-invisible tc-tiddlylink\" style=\"width:100%; text-align:left;\">\n<$action-navigate $to=\"标签笔记\"/>\n<span style=\"font-weight:600; font-size:1.05em;\"><<currentTiddler>></span>\n<span style=\"color:#888; font-size:0.85em; margin-left:8px;\"><<count>> 篇</span>\n</$button>\n</div>\n</$set>\n</$list>\n</div>\n\n!! 🤖 Agent 撰写的标签\n\n<div class=\"tc-message-box\">以下标签来自带有 <code>agent-written</code> 标签（由 Agent 撰写）的笔记，与上方主列表分开统计。若某篇 Agent 笔记又被人类编辑过，请给它补打 <code>human-edited</code> 标签，即归入下方「Agent + 人工」档。</div>\n\n<div style=\"font-weight:700; margin:8px 0 4px;\">🦾 纯 Agent <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[subfilter<agent-notes-pure>]}}} 篇</span></div>\n<div style=\"margin-left:10px;\">\n<$list filter=\"[subfilter<agent-tags-pure>] +[!sortsub:number<agent-count-pure>]\">\n<$set name=\"count\" value={{{ [subfilter<agent-count-pure>] }}}>\n<div style=\"padding:7px 2px; border-bottom:1px solid rgba(128,128,128,0.15);\">\n<$button set=\"$:/state/tag\" setTo=<<currentTiddler>> class=\"tc-btn-invisible tc-tiddlylink\" style=\"width:100%; text-align:left;\">\n<$action-navigate $to=\"标签笔记\"/>\n<span style=\"font-weight:600; font-size:1.05em;\"><<currentTiddler>></span>\n<span style=\"color:#888; font-size:0.85em; margin-left:8px;\"><<count>> 篇</span>\n</$button>\n</div>\n</$set>\n</$list>\n<$list filter=\"[subfilter<agent-tags-pure>!count[]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无纯 Agent 笔记）</div></$list>\n</div>\n\n<div style=\"font-weight:700; margin:10px 0 4px;\">🤝 Agent + 人工 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[subfilter<agent-notes-mixed>]}}} 篇</span></div>\n<div style=\"margin-left:10px;\">\n<$list filter=\"[subfilter<agent-tags-mixed>] +[!sortsub:number<agent-count-mixed>]\">\n<$set name=\"count\" value={{{ [subfilter<agent-count-mixed>] }}}>\n<div style=\"padding:7px 2px; border-bottom:1px solid rgba(128,128,128,0.15);\">\n<$button set=\"$:/state/tag\" setTo=<<currentTiddler>> class=\"tc-btn-invisible tc-tiddlylink\" style=\"width:100%; text-align:left;\">\n<$action-navigate $to=\"标签笔记\"/>\n<span style=\"font-weight:600; font-size:1.05em;\"><<currentTiddler>></span>\n<span style=\"color:#888; font-size:0.85em; margin-left:8px;\"><<count>> 篇</span>\n</$button>\n</div>\n</$set>\n</$list>\n<$list filter=\"[subfilter<agent-tags-mixed>!count[]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无「Agent + 人工」笔记）</div></$list>\n</div>\n"},{"title":"标签笔记","tags":["索引"],"type":"text/vnd.tiddlywiki","text":"\\whitespace trim\n\n<$set name=\"sel\" value={{{ [{$:/state/tag}] }}}>\n\n!! 标签：<<sel>>\n\n<div class=\"tc-message-box\">包含标签 <strong><<sel>></strong> 的所有笔记（自动收集，按最近修改排序）。</div>\n\n<ul>\n<$list filter=\"[all[tiddlers]!is[system]!has[draft.of]tag<sel>] +[!sort[modified]]\">\n<li><$link to=<<currentTiddler>>><$view field=\"title\"/></$link><span style=\"color:#aaa; font-size:0.85em;\"> · <$view field=\"modified\" format=\"relativedate\"/></span></li>\n</$list>\n</ul>\n\n</$set>\n"}]

/**
 * Seed the home/index tiddlers exactly once per wiki (mirrors the doc-note
 * one-shot policy). Also writes $:/DefaultTiddlers → [[主页]] so the new home
 * opens by default. With `force` the tiddlers are overwritten with the
 * built-in content and the marker is (re)written — the settings page uses this
 * for "重新初始化". Returns whether anything was written this call. Never throws.
 */
export async function seedHomeIndex(client: TiddlyWebClient, opts?: { force?: boolean }): Promise<boolean> {
  const force = opts?.force === true
  if (!force) {
    const marker = await client.get(HOME_INDEX_MARKER_TITLE).catch(() => undefined)
    if (marker !== undefined) return false
  }
  let wrote = false
  for (const item of HOME_INDEX_ITEMS) {
    const existing = await client.get(item.title).catch(() => undefined)
    if (force || existing === undefined) {
      await client.put({ title: item.title, text: item.text, type: item.type, tags: item.tags })
      wrote = true
    }
  }
  // Ensure the default home page is 主页. A fresh wiki's $:/DefaultTiddlers is
  // the core shadow "GettingStarted" (or absent), so a first seed writes it;
  // a user-customised DefaultTiddlers is left alone unless force.
  const dt = await client.get('$:/DefaultTiddlers').catch(() => undefined)
  const dtText = typeof dt?.text === 'string' ? dt.text.trim() : ''
  if (force || dt === undefined || dtText === 'GettingStarted' || dtText === '[[GettingStarted]]') {
    await client.put({ title: '$:/DefaultTiddlers', text: HOME_DEFAULT_TIDDLERS, type: 'text/vnd.tiddlywiki', tags: [] })
    wrote = true
  }
  await client
    .put({ title: HOME_INDEX_MARKER_TITLE, text: 'seeded-once', type: 'text/plain', tags: [] })
    .catch(() => undefined)
  return wrote
}

/**
 * Un-seed (反初始化): remove the home tiddlers (主页 / 所有标签 / 标签笔记) and
 * their marker, restoring the wiki's default home only when it still points
 * at the seeded 主页 (a user-customised $:/DefaultTiddlers is left alone).
 * Deletion is idempotent — a tiddler already gone is not listed. Never throws.
 */
export async function unseedHomeIndex(client: TiddlyWebClient): Promise<{ removed: string[] }> {
  const removed: string[] = []
  for (const item of HOME_INDEX_ITEMS) {
    const t = await client.get(item.title).catch(() => undefined)
    if (t !== undefined) {
      await client.delete(item.title)
      removed.push(item.title)
    }
  }
  const marker = await client.get(HOME_INDEX_MARKER_TITLE).catch(() => undefined)
  if (marker !== undefined) {
    await client.delete(HOME_INDEX_MARKER_TITLE)
    removed.push(HOME_INDEX_MARKER_TITLE)
  }
  const dt = await client.get('$:/DefaultTiddlers').catch(() => undefined)
  if (dt !== undefined && typeof dt.text === 'string' && dt.text.trim() === '[[主页]]') {
    await client.put({ title: '$:/DefaultTiddlers', text: '[[GettingStarted]]', type: 'text/vnd.tiddlywiki', tags: [] })
    removed.push('$:/DefaultTiddlers')
  }
  return { removed }
}

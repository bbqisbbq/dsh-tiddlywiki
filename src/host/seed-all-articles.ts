/**
 * The "所有文章" two-column paginated index page, seeded into wikis by
 * seedAllArticles. Source: 所有文章.tid (the wiki's live tiddler).
 *
 * The page lists every non-system, non-draft tiddler in two independently
 * paginated columns:
 *  - 🤖 Agent 撰写: agent-written and not human-edited
 *  - 👤 人工 / 人类: not agent-written, OR agent-written + human-edited
 * Page size comes live from the plugin config tiddler
 * ($:/plugins/dsh-tiddlywiki/config → ui.allArticles.pageSize, default 10).
 *
 * @module dsh-tiddlywiki/host/seed-all-articles
 */
import type { TiddlyWebClient } from './tw-api.ts'

/** One-time marker: presence means "the page was offered once — hands off". */
export const ALL_ARTICLES_MARKER_TITLE = '$:/plugins/dsh-tiddlywiki/seed-all-articles'

/** The 所有文章 page title. */
export const ALL_ARTICLES_TITLE = '所有文章'

/** The page body, exactly as seeded (user-owned afterwards). */
export const ALL_ARTICLES_TEXT = `\\whitespace trim

\\define page-size() [{$:/plugins/dsh-tiddlywiki/config}jsonget[ui],[allArticles],[pageSize]else[10]]
\\define agent-list() [all[tiddlers]!is[system]!has[draft.of]!tag[索引]tag[agent-written]!tag[human-edited]!sort[modified]]
\\define human-list() [all[tiddlers]!is[system]!has[draft.of]!tag[索引]!tag[agent-written]] [all[tiddlers]!is[system]!has[draft.of]!tag[索引]tag[agent-written]tag[human-edited]] +[!sort[modified]]

<$button class="tc-btn-invisible tc-tiddlylink" style="margin:6px 0; padding:4px 10px; border:1px solid rgba(128,128,128,0.3); border-radius:6px; font-size:0.9em;">
<$action-navigate $to="主页"/>
← 回主页
</$button>

!! 📚 所有文章

<div class="tc-message-box">分两列汇总全部 wiki 条目（不含系统页、草稿与带 <code>索引</code> 标签的导航页）：左列 🤖 Agent 撰写（带 <code>agent-written</code> 且未被人工编辑）；右列 👤 人工 / 人类（不含 <code>agent-written</code> 的人类笔记 ＋ 被人工编辑过的 <code>human-edited</code> 条目，即使带 <code>agent-written</code>）。两列各自分页，每页条数可在插件设置里调整。</div>

<div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:8px;">
<div style="border:1px solid rgba(128,128,128,0.22); border-radius:10px; padding:10px 12px;">
<div style="font-weight:700; margin-bottom:6px;">🤖 Agent 撰写 <span style="color:#888; font-weight:400; font-size:0.82em;">{{{[subfilter<agent-list>count[]]}}} 篇</span></div>
<$set name="page" tiddler="$:/state/dsh/all-articles/page/agent" emptyValue="0">
<$set name="ps" value={{{ [subfilter<page-size>] }}}>
<$set name="total" value={{{ [subfilter<agent-list>count[]] }}}>
<$set name="last" value={{{ [<total>] +[divide<ps>] +[ceil[0]] +[subtract[1]] +[max[0]] }}}>
<$set name="pagec" value={{{ [<page>] +[min<last>] +[max[0]] }}}>
<$set name="offset" value={{{ [<pagec>] +[multiply<ps>] }}}>
<div>
<$list filter="[subfilter<agent-list>] +[rest<offset>] +[first<ps>]">
<div style="display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);">
<$link to=<<currentTiddler>> style="flex:1;"><$view field="title"/></$link>
<span style="color:#aaa; font-size:0.82em;"><$view field="modified" format="relativedate"/></span>
</div>
</$list>
<$list filter="[subfilter<agent-list>count[]] +[match[0]]"><div style="color:#aaa; font-size:0.85em;">（暂无）</div></$list>
</div>
<$list filter="[<total>!match[0]]">
<div style="display:flex; gap:8px; align-items:center; margin-top:8px;">
<$list filter="[<pagec>compare:number:gt[0]]">
<$button class="tc-btn-invisible" style="padding:2px 10px; border:1px solid rgba(128,128,128,0.35); border-radius:6px;">
<$action-setfield $tiddler="$:/state/dsh/all-articles/page/agent" $field="text" $value={{{ [<pagec>] +[subtract[1]] +[max[0]] }}}/>
◀ 上一页
</$button>
</$list>
<span style="color:#888; font-size:0.85em;">第 {{{ [<pagec>] +[add[1]] }}} / {{{ [<total>] +[divide<ps>] +[ceil[0]] }}} 页</span>
<$list filter="[<pagec>compare:number:lt<last>]">
<$button class="tc-btn-invisible" style="padding:2px 10px; border:1px solid rgba(128,128,128,0.35); border-radius:6px;">
<$action-setfield $tiddler="$:/state/dsh/all-articles/page/agent" $field="text" $value={{{ [<pagec>] +[add[1]] +[min<last>] }}}/>
下一页 ▶
</$button>
</$list>
</div>
</$list>
</$set>
</$set>
</$set>
</$set>
</$set>
</$set>
</div>
<div style="border:1px solid rgba(128,128,128,0.22); border-radius:10px; padding:10px 12px;">
<div style="font-weight:700; margin-bottom:6px;">👤 人工 / 人类 <span style="color:#888; font-weight:400; font-size:0.82em;">{{{[subfilter<human-list>count[]]}}} 篇</span></div>
<$set name="page" tiddler="$:/state/dsh/all-articles/page/human" emptyValue="0">
<$set name="ps" value={{{ [subfilter<page-size>] }}}>
<$set name="total" value={{{ [subfilter<human-list>count[]] }}}>
<$set name="last" value={{{ [<total>] +[divide<ps>] +[ceil[0]] +[subtract[1]] +[max[0]] }}}>
<$set name="pagec" value={{{ [<page>] +[min<last>] +[max[0]] }}}>
<$set name="offset" value={{{ [<pagec>] +[multiply<ps>] }}}>
<div>
<$list filter="[subfilter<human-list>] +[rest<offset>] +[first<ps>]">
<div style="display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);">
<$link to=<<currentTiddler>> style="flex:1;"><$view field="title"/></$link>
<span style="color:#aaa; font-size:0.82em;"><$view field="modified" format="relativedate"/></span>
</div>
</$list>
<$list filter="[subfilter<human-list>count[]] +[match[0]]"><div style="color:#aaa; font-size:0.85em;">（暂无）</div></$list>
</div>
<$list filter="[<total>!match[0]]">
<div style="display:flex; gap:8px; align-items:center; margin-top:8px;">
<$list filter="[<pagec>compare:number:gt[0]]">
<$button class="tc-btn-invisible" style="padding:2px 10px; border:1px solid rgba(128,128,128,0.35); border-radius:6px;">
<$action-setfield $tiddler="$:/state/dsh/all-articles/page/human" $field="text" $value={{{ [<pagec>] +[subtract[1]] +[max[0]] }}}/>
◀ 上一页
</$button>
</$list>
<span style="color:#888; font-size:0.85em;">第 {{{ [<pagec>] +[add[1]] }}} / {{{ [<total>] +[divide<ps>] +[ceil[0]] }}} 页</span>
<$list filter="[<pagec>compare:number:lt<last>]">
<$button class="tc-btn-invisible" style="padding:2px 10px; border:1px solid rgba(128,128,128,0.35); border-radius:6px;">
<$action-setfield $tiddler="$:/state/dsh/all-articles/page/human" $field="text" $value={{{ [<pagec>] +[add[1]] +[min<last>] }}}/>
下一页 ▶
</$button>
</$list>
</div>
</$list>
</$set>
</$set>
</$set>
</$set>
</$set>
</$set>
</div>
</div>
`

/**
 * Seed the 所有文章 page exactly once per wiki (mirrors the doc-note one-shot
 * policy). With `opts.force` the page is overwritten with the built-in content
 * and the marker is (re)written — the settings page uses this for
 * "重新初始化". Returns whether the page was written this call. Never throws.
 */
export async function seedAllArticles(client: TiddlyWebClient, opts?: { force?: boolean }): Promise<boolean> {
  const force = opts?.force === true
  if (!force) {
    const marker = await client.get(ALL_ARTICLES_MARKER_TITLE).catch(() => undefined)
    if (marker !== undefined) return false
  }
  const existing = await client.get(ALL_ARTICLES_TITLE).catch(() => undefined)
  let wrote = false
  if (force || existing === undefined) {
    await client.put({ title: ALL_ARTICLES_TITLE, text: ALL_ARTICLES_TEXT, type: 'text/vnd.tiddlywiki', tags: ['索引'] })
    wrote = true
  }
  await client
    .put({ title: ALL_ARTICLES_MARKER_TITLE, text: 'seeded-once', type: 'text/plain', tags: [] })
    .catch(() => undefined)
  return wrote
}

/**
 * Un-seed (反初始化): remove the 所有文章 page and its one-shot marker.
 * Deletion is idempotent — a tiddler that was already gone is not listed.
 * Never throws.
 */
export async function unseedAllArticles(client: TiddlyWebClient): Promise<{ removed: string[] }> {
  const removed: string[] = []
  for (const title of [ALL_ARTICLES_TITLE, ALL_ARTICLES_MARKER_TITLE]) {
    const t = await client.get(title).catch(() => undefined)
    if (t !== undefined) {
      await client.delete(title)
      removed.push(title)
    }
  }
  return { removed }
}

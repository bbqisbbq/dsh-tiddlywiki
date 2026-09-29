/**
 * Settings-page half (design doc §13, config panel): a pure-DOM page mounted
 * inside a `settings.section` React wrapper. Everything talks to the host
 * admin routes — same-origin JSON, no client services beyond `slots`:
 *
 *   GET  /dsh-tiddlywiki/admin/state    current info + catalog + config
 *   POST /dsh-tiddlywiki/admin/info     { plugins?, themes? } → restart TW
 *   POST /dsh-tiddlywiki/admin/config   { ...patch }           → persist
 *   POST /dsh-tiddlywiki/admin/restart  restart the TW child
 *   GET  /dsh-tiddlywiki/admin/seeds    one-time seed statuses
 *   POST /dsh-tiddlywiki/admin/seeds/run { id?, force? } → run one/all seeds
 *
 * Sections:
 *   1. 状态/重启      TW 运行状态 + git 概览 + 重启按钮
 *   2. 常规配置       note.tag / git.* / ui.*（含会话「知识库」Tab 名称、sendToAgent
 *                     开关/token/endpoint；改了什么保存什么）
 *   3. 插件管理       自带官方插件勾选（可搜索）→ 应用并重启 TW
 *   4. 主题管理       自带主题单选 → 应用并重启 TW
 *   5. 初始化         一次性预置（doc-note/send-to-agent/home-index/all-articles/menubar-theme/tw-web-host）
 *                     状态 + 手动「重新初始化」（force）
 *
 * v0.28.8 split: this file is the ASSEMBLY POINT — the page shell (mount, status
 * row, mount-level state, Tab bar, scope bar, render order). The sections live
 * next door and are re-exported at the bottom, so the public surface
 * (`index.ts` imports `SettingsSection`) is unchanged:
 *   - settings-page-runtime.ts  fetchJson / banners / roster shape / ?wiki= scope
 *   - settings-page-wikis.ts    知识库列表 + 知识库位置
 *   - settings-page-config.ts   常规配置（含系统提示词 / 微信 / 剪藏桥）
 *   - settings-page-catalog.ts  插件 / 主题 / 语言 / 初始化
 *
 * @module dsh-tiddlywiki/client/settings-page
 */
import * as React from 'react'
import { toast } from './toast.ts'
import { make } from './dom.ts'
import { t } from './i18n.ts'
import {
  ADMIN_RESTART_ENDPOINT as RESTART_ENDPOINT,
  ADMIN_STATE_ENDPOINT as STATE_ENDPOINT,
  ADMIN_WIKIS_ENDPOINT as WIKI_LIST_ENDPOINT,
  SYNC_ENDPOINT,
  describeSyncResult,
  type SyncResultPayload,
} from './endpoints.ts'
import { activeTab, editingWiki, fetchJson, makeErrorBanner, setEditingWiki, setActiveTab, withWiki } from './settings-page-runtime.ts'
import type { SettingsTab, WikisView } from './settings-page-runtime.ts'
import { renderWikiListSection, renderWikiLocationSection } from './settings-page-wikis.ts'
import { renderConfigSection } from './settings-page-config.ts'
import type { ConfigRenderState } from './settings-page-config.ts'
import { renderCatalogSection, renderSeedsSection } from './settings-page-catalog.ts'
import type { CatalogEntry, CatalogPending } from './settings-page-catalog.ts'

interface AdminState {
  ok?: boolean
  server?: { status?: string; url?: string; wikiPath?: string; error?: string }
  info?: { plugins?: string[]; themes?: string[]; languages?: string[]; themeActive?: string }
  catalog?: { plugins?: CatalogEntry[]; themes?: CatalogEntry[]; languages?: CatalogEntry[] }
  /**
   * Runtime plugin truth of the wiki folder (v0.26.0): plugins installed as
   * tiddlers via TW's own plugin library / import (they live in the wiki, NOT
   * in tiddlywiki.info) and the plugin titles currently disabled via TW's
   * Control Panel. `null`/absent = the host could not scan the tiddlers dir;
   * renderers must treat that as "unknown" (hide the section, no badges),
   * never as "none".
   */
  runtimePlugins?: { wikiPlugins?: Array<{ title: string; name?: string; description?: string; version?: string }>; disabled?: string[] } | null
  config?: Record<string, unknown>
  /**
   * Set when the stored config tiddler exists but cannot be parsed (v0.23.4):
   * every override in `config` is then IGNORED by the host, and saving is
   * refused. Rendered as a red banner so the user learns why their settings
   * "don't stick" instead of guessing.
   */
  configError?: string | null
  git?: { exists?: boolean; branch?: string; dirty?: boolean; lastCommit?: string; remote?: string; conflict?: { reason: string; files: string[] } } | null
  error?: string
}

/** Mount the settings page into `container`; returns the disposer.
 *  Module-private (v0.22.8) — only the `SettingsSection` slot component mounts it. */
function mountSettingsPage(container: HTMLElement): () => void {
  let disposed = false
  container.classList.add('dsh-tw-settings')

  // 加载失败横幅独立于 statusRow/body（v0.24.x）：刷新失败（宿主重启中、网络抖动）
  // 不该把用户已经填了一半、还没保存的表单从文档里摘掉，所以错误与重试只动这一块。
  const loadError = make('div', 'dsh-tw-settings-error')
  loadError.hidden = true
  const statusRow = make('div', 'dsh-tw-settings-row dsh-tw-settings-status')
  const body = make('div', 'dsh-tw-settings-body')
  container.append(loadError, statusRow, body)

  const disposers: Array<() => void> = []
  /** Config-section DOM + the server signature it was built from (see renderMain). */
  const configState: ConfigRenderState = {}
  /**
   * 插件/主题/语言的「未应用勾选」（见 CatalogPending）。
   *
   * ⚠️ 必须是**空对象**，绝不能预置空 Set（v0.26.1 修 P0；回归由 v0.25.0 的
   * commit 883196f 引入）：契约是 `undefined` = 用户还没碰过、完全跟随服务器，
   * 而 `desiredPlugins()` 等用 `??` 回退 —— **空 Set 不是 undefined**，预置成
   * 空 Set 会让「没碰过」被读成「用户期望集合为空」，后果有两层：
   *   ① 设置页所有插件/主题/语言勾选框**全部显示为未勾选**（用户看到「装了却没勾」）；
   *   ② 更严重——什么都没改就点「应用插件」，会 POST 一个**空数组**，把
   *      `tiddlywiki.info` 的插件清单整个清空（主题清单、语言同理）。
   * 守门：`scripts/verify-plugin-runtime.mjs` 的「未碰过 ≠ 空集合」一节。
   */
  const catalogPending: CatalogPending = {}
  /**
   * 这份「未应用勾选」属于哪个库（v0.29.0）。
   *
   * 它是**要写进那个库 `tiddlywiki.info` 的清单**，所以只在同一个库内有意义：
   * 在 A 库勾了几个插件、再点 B 库的「配置」，此前会把 A 的期望集合显示成 B 的，
   * 点「应用」就把 A 的插件清单写进 B（并重启 B）。切库即作废。
   */
  let catalogScope: string | undefined
  /** 首屏是否已成功渲染过内容：决定占位提示与失败时能不能清 body。 */
  let rendered = false
  /**
   * 当前是单库还是多库（v0.28.7）。
   *
   * 为什么要在比 `/status` 更早的地方拿到它：有些配置项**只在单库模式下有意义**
   * （「侧边栏 TW 入口显示名称」是最典型的一个——多库时侧边栏是每个库各占一行、
   * 各用自己 `wikis.json` 里的 label，这个字段改不动任何东西）。`renderConfigSection`
   * 是同步的、按顺序 append 字段，没法在中间 await，所以这里先把模式探好，
   * 再交给它决定要不要渲染那个字段。
   *
   * `undefined` = 还没探测 / 探测失败 —— 按**单库**处理（保守：宁可多显示一个
   * "确实存在且能用"的字段，也不要因为一次请求失败把它藏了，否则单库用户会
   * 莫名其妙找不到设置项）。多库时才显式 'multi'。
   */
  let rosterMode: string | undefined
  /**
   * 名册原件（v0.30.6）：作用域条要说出**正在配置的那个库的显示名**，而
   * `/admin/state` 只回那个库的路径/git/配置，**没有名字**。这一份来自上面那次
   * **本来就有的** `/admin/wikis` 模式探测（见 modePromise）—— 复用，不发新请求。
   */
  let roster: WikisView | undefined

  const refresh = async (): Promise<void> => {
    // 首屏先给占位（v0.24.x）：以前 await 期间什么都不画，整块白屏看起来像插件坏了。
    if (!rendered) body.replaceChildren(make('div', 'dsh-tw-settings-muted', t('settings.loading')))
    try {
      // 与 /status 并行探模式：失败/超时不阻塞配置页渲染（回落成单库的保守视图）。
      const modePromise = fetchJson<WikisView>(WIKI_LIST_ENDPOINT)
        .then((v) => { rosterMode = typeof v?.mode === 'string' ? v.mode : undefined; roster = v })
        .catch(() => { rosterMode = undefined })
      const state = await fetchJson<AdminState>(withWiki(STATE_ENDPOINT))
      await modePromise
      if (disposed) return
      rendered = true
      loadError.hidden = true
      loadError.replaceChildren()
      renderStatus(statusRow, state, refresh)
      renderMain(body, state, refresh, () => disposed, configState, catalogPending, rosterMode, () => {
        // 库作用域变了：上一个库的「未应用勾选」立刻作废（见 catalogScope）。
        if (catalogScope !== editingWiki) {
          delete catalogPending.plugins
          delete catalogPending.themes
          delete catalogPending.languages
          delete catalogPending.themeActive
          catalogScope = editingWiki
        }
      }, scopeWikiLabel(roster, editingWiki))
    } catch (err) {
      if (disposed) return
      // 不再 body.replaceChildren() / statusRow.replaceChildren()：那会把已经渲染出来的
      // 表单节点连同用户的输入一起摘掉。首屏（还没有任何内容）时把「加载中…」换成实话。
      if (!rendered) body.replaceChildren(make('div', 'dsh-tw-settings-muted', t('settings.notLoaded')))
      const retry = make('button', 'dsh-tw-settings-btn', t('settings.retry'))
      retry.type = 'button'
      retry.addEventListener('click', () => { void refresh() })
      loadError.replaceChildren(
        make('span', undefined, `${t('settings.loadFailed', { message: err instanceof Error ? err.message : String(err) })} `),
        retry,
      )
      loadError.hidden = false
    }
  }

  void refresh()
  disposers.push(() => {
    disposed = true
    container.replaceChildren()
    container.classList.remove('dsh-tw-settings')
  })
  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}

function renderStatus(row: HTMLElement, state: AdminState, refresh: () => Promise<void>): void {
  row.replaceChildren()
  const server = state.server ?? {}
  const status = server.status ?? 'unknown'
  const chip = make('span', `dsh-tw-settings-chip`, status)
  chip.dataset.state = status
  const info = [
    server.url !== undefined ? `TW ${server.url}` : '',
    state.git?.branch !== undefined ? `git ${state.git.branch}` : '',
    state.git?.lastCommit !== undefined ? state.git.lastCommit : '',
    // An unresolved conflict is the one git state that blocks commits (v0.23.4):
    // say so instead of the generic「有未提交改动」.
    state.git?.conflict !== undefined
      ? t('settings.gitConflict', { count: state.git.conflict.files.length })
      : (state.git?.dirty === true ? t('settings.gitDirty') : ''),
  ].filter(Boolean).join(' · ')
  const label = make('span', 'dsh-tw-settings-muted', info)
  const sync = make('button', 'dsh-tw-settings-btn', t('settings.sync'))
  sync.type = 'button'
  sync.title = t('settings.syncTitle')
  sync.addEventListener('click', () => {
    sync.disabled = true
    sync.textContent = t('settings.syncing')
    void (async () => {
      try {
        // ⚠️ 必须带作用域（v0.29.0）：这两个按钮在同一行显示的是**正在配置的那个库**
        // 的 git 概览/TW 状态，却不带 `?wiki=` —— 于是作用域条写着「正在配置：books」，
        // 点下去 pull/commit/push（或重启）的是**默认库**，而且看起来一切正常。
        const res = await fetch(withWiki(SYNC_ENDPOINT), { method: 'POST', signal: AbortSignal.timeout(120_000) })
        const payload = (await res.json().catch(() => null)) as SyncResultPayload | null
        const result = describeSyncResult(payload, res.status)
        toast(result.ok
          ? t('settings.syncDone', { message: result.message })
          : t('settings.syncFailed', { message: result.message }))
      } catch (err) {
        toast(t('settings.syncFailed', { message: err instanceof Error ? err.message : String(err) }))
      } finally {
        sync.disabled = false
        sync.textContent = t('settings.sync')
        void refresh()
      }
    })()
  })
  const restart = make('button', 'dsh-tw-settings-btn', t('settings.restart'))
  restart.type = 'button'
  restart.addEventListener('click', () => {
    restart.disabled = true
    restart.textContent = t('settings.restarting')
    void (async () => {
      try {
        // 120s 是显式的：宿主 /admin/restart 会等 TW 就绪才回包，软窗口默认 60s
        // （大知识库冷启动更久，v0.22.5 记录过 44s+），而 fetchJson 默认只给 15s ——
        // 于是宿主重启成功、前端却报「重启失败」。同一原因也命中过知识库切换。
        await fetchJson(withWiki(RESTART_ENDPOINT), { method: 'POST', signal: AbortSignal.timeout(120_000) })
        toast(t('settings.restarted'))
      } catch (err) {
        toast(t('settings.restartFailed', { message: err instanceof Error ? err.message : String(err) }))
      } finally {
        restart.disabled = false
        restart.textContent = t('settings.restart')
        void refresh()
      }
    })()
  })
  row.append(chip, label, sync, restart)
}

/**
 * 设置页的分页（v0.28.8，反馈 11）。
 *
 * 为什么要有 Tab：多库之后页面上的东西分成了三类，混在一起平铺就出现了作者报的
 * 那个问题——「多库时这些配置项应该隐藏，点配置某个库时才展示」以及「不知道在改
 * 哪个库」。分类本身就是答案：
 *   · overview：状态 + 知识库列表（唯一的「全局」入口）
 *   · library ：**被选中那个库**的配置（含插件/主题/语言/初始化），多库时必须先选库
 *   · global  ：插件级、与具体库无关的开关（git 策略/注入提示词/UI/剪藏桥/公众号）
 *
 * 单库模式下不显示 Tab 栏（DOM 与以前逐字相同），直接按 overview+library+global
 * 的顺序平铺——单库用户不需要为「哪个库」这个概念付任何认知成本。
 *
 * v0.28.8 拆分：`SettingsTab` 类型与「当前 Tab」的值住在 `settings-page-runtime.ts`
 * ——「知识库列表」里的「配置」按钮也要切 Tab，而它由 section 模块渲染，不能反过来
 * import 本文件（那就成环了）。这里只重新导出类型，保持公开面不变。
 */

/**
 * Tab 栏文案（v0.30.6）：label 是**函数**，渲染时才取值 —— 模块级常量只求值一次，
 * 写死 `t(...)` 会让「切语言后设置页立即重画」失效（见 i18n.ts 的说明）。
 */
const TAB_LABELS: Array<{ id: SettingsTab; label: () => string }> = [
  { id: 'overview', label: () => t('settings.tabOverview') },
  { id: 'library', label: () => t('settings.tabLibrary') },
  { id: 'global', label: () => t('settings.tabGlobal') },
]

/**
 * 作用域条要显示的那个库的**显示名**（v0.30.6）。
 *
 * `/admin/state` 只回路径/git/配置，没有名字；名字只有 `/admin/wikis` 的名册里有，
 * 而那份名册本来就被 mountSettingsPage 取过一次（探模式）—— 复用，绝不新发请求。
 * `id` 为空 = 没显式选库（配置的就是默认那个库），此时取名册的 `defaultId`。
 * 名册里查不到时回落 id（**显示名优先，但绝不把 id 说成「默认库」**）。
 */
function scopeWikiLabel(roster: WikisView | undefined, id: string | undefined): string | undefined {
  const wikis = roster?.wikis ?? []
  const target = id ?? roster?.defaultId
  const label = target === undefined ? undefined : wikis.find((wiki) => wiki.id === target)?.label
  if (label !== undefined && label.length > 0) return label
  return id
}

/**
 * 顶部配置作用域条（v0.28.8，反馈 4）。
 *
 * 症状：「多库时点击配置，按钮变为正在配置，改了配置之后，没有保存配置以及退出的
 * 配置的入口」。原文有两层意思，这里都要解决：
 *   1. **看得见**在配置哪个库（此前只有一行灰字，且列表在页面下方，得往回滚）；
 *   2. **退得出去**——`editingWiki` 是模块级变量，以前没有任何路径把它清回默认库，
 *      连关掉设置页再打开都还在那个库上（作者就是因此找不到出口）。
 *
 * 所以这条是 sticky 的，且**只有多库模式**才渲染（单库没有"作用域"可言）。
 */
function renderScopeBar(body: HTMLElement, mode: string | undefined, refresh: () => Promise<void>, scopeLabel?: string): void {
  if (mode !== 'multi') return
  const bar = make('div', 'dsh-tw-settings-scopebar')
  // 只说**那个库的显示名**（v0.28.12）：没显式选库时配置的就是「跟随默认」的那个库，
  // 名字给得出就带上「（默认）」身份标记；名册没回来（名字读不到）才用中性说法。
  const label = scopeLabel === undefined || scopeLabel.length === 0
    ? t('settings.scopeFollowDefault')
    : (editingWiki === undefined
      ? t('settings.scopeEditingDefault', { name: scopeLabel })
      : t('settings.scopeEditing', { name: scopeLabel }))
  bar.append(make('span', 'dsh-tw-settings-scopebar-label', label))
  bar.append(make('span', 'dsh-tw-settings-muted', editingWiki === undefined
    ? t('settings.scopeHintPick')
    : t('settings.scopeHintEditing')))
  if (editingWiki !== undefined) {
    const exit = make('button', 'dsh-tw-settings-btn dsh-tw-settings-chipbtn dsh-tw-settings-scopebar-exit', t('settings.exitConfig'))
    exit.type = 'button'
    exit.title = t('settings.scopeExitTitle')
    exit.addEventListener('click', () => {
      // 清回默认库 —— 写入口只有 setEditingWiki 一处（值住在 settings-page-runtime.ts，
      // 多处直接赋值正是反馈 4 里"退不出去"的成因）。
      // 守门按源码断言这一步，见 scripts/verify-wiki-focus.mjs。
      setEditingWiki(undefined) // editingWiki = undefined
      void refresh()
    })
    bar.append(exit)
  }
  body.append(bar)
}

/** Tab 栏：只在多库模式下出现（单库平铺，见 SettingsTab 注释）。 */
function renderTabBar(body: HTMLElement, mode: string | undefined, refresh: () => Promise<void>): void {
  if (mode !== 'multi') return
  const bar = make('div', 'dsh-tw-settings-tabs')
  bar.setAttribute('role', 'tablist')
  for (const tab of TAB_LABELS) {
    const active = activeTab === tab.id
    const btn = make('button', `dsh-tw-settings-tab${active ? ' dsh-tw-settings-tab-active' : ''}`, tab.label())
    btn.type = 'button'
    btn.setAttribute('role', 'tab')
    btn.setAttribute('aria-selected', active ? 'true' : 'false')
    btn.addEventListener('click', () => {
      if (activeTab === tab.id) return
      setActiveTab(tab.id)
      void refresh()
    })
    bar.append(btn)
  }
  body.append(bar)
}

/**
 * 多库模式下「本库配置」必须有明确的库；没有就提示先选一个（v0.28.8，反馈 3）。
 *
 * 这正是需求原文：「下方的插件管理/主题管理/语言管理/初始化等等这些配置项目在多库
 * 的情况下应该隐藏，点击配置相应的库的时候才展示出来让人配置」。
 */
function renderPickLibraryHint(body: HTMLElement): void {
  body.append(make('div', 'dsh-tw-settings-muted', t('settings.pickLibraryHint')))
}

function renderMain(body: HTMLElement, state: AdminState, refresh: () => Promise<void>, isDisposed: () => boolean, configState: ConfigRenderState, catalogPending: CatalogPending, rosterMode?: string, dropCatalogPendingOnScopeChange?: () => void, scopeLabel?: string): void {
  body.replaceChildren()
  // 库作用域变了 → 先作废上一个库的「未应用勾选」（v0.29.0），再渲染任何东西：
  // 否则渲染出来的复选框是 A 库的期望集合，而页面说的是 B 库（点应用就写错库）。
  dropCatalogPendingOnScopeChange?.()
  // Loud, above everything else: an unparseable config tiddler means the config
  // block below shows DEFAULTS that are not actually in effect, and saving is
  // refused until it is fixed (v0.23.4 — that is how a user's prompt.extra /
  // git.remote were silently wiped on 2026-09-18).
  if (typeof state.configError === 'string' && state.configError.length > 0) {
    body.append(makeErrorBanner(t('settings.configInactive', { message: state.configError })))
  }
  // Config section: only rebuild when the server-side config actually changed.
  // Otherwise the status row's 同步/重启 buttons (and the catalog apply buttons)
  // call refresh() and would silently discard whatever the user had typed into
  // a field (v0.20.0). The host element is re-appended as-is, so its inputs and
  // their pending values survive.
  const signature = JSON.stringify(state.config ?? {})
  // 库作用域也是「要不要重建」的一部分（v0.29.0）：两个库的配置内容可能**逐字相同**，
  // 只比 config 就会把上一个库的表单（连同它的未保存改动）留给新库，保存时写错库。
  const scopeChanged = configState.wiki !== editingWiki
  const serverChanged = configState.host !== undefined && (scopeChanged || configState.signature !== signature)
  // 有未保存改动时**不重建**（v0.25.0）：重建会静默丢掉用户刚敲的内容（典型触发
  // 路径：另一个标签页保存了配置，或语言管理顺带写 uiLanguage → 本页 refresh()）。
  // 保留旧表单 + 显式提示，用户可以选择保存（覆盖别处的改动）或自己改回来。
  // 例外：切库（scopeChanged）时那条提示是错的 —— 用户要的就是另一个库的表单，
  // 上一个库的脏值本来就不该带过去。
  const dirty = configState.isDirty?.() === true
  if (serverChanged && dirty && !scopeChanged) {
    body.append(makeErrorBanner(t('settings.configStale')))
  }
  // 重建的三种情况（v0.29.0：把"切库"单独加进来，但**不能**顺手改掉 v0.25.0 的保护）：
  //   ① 还没有表单；② 用户切了库（他就是要另一个库的表单，旧库的脏值不该带过去）；
  //   ③ 服务器变了且表单没有未保存改动。离开 ③ 的后半句就会静默丢掉用户刚敲的内容。
  if (configState.host === undefined || scopeChanged || (serverChanged && !dirty)) {
    const host = make('div', 'dsh-tw-settings-confighost')
    renderConfigSection(host, state.config ?? {}, refresh, configState, rosterMode, isDisposed)
    configState.host = host
    configState.signature = signature
    configState.wiki = editingWiki
  }
  // Tab 栏 + 作用域条（v0.28.8）：多库时页面按「总览 / 本库配置 / 全局」分开，
  // 并在最上方 sticky 地说明正在配置哪个库、随时可以退出。单库两者都不渲染，
  // 于是下面的渲染顺序就是以前那一条平铺（DOM 逐字不变）。
  renderTabBar(body, rosterMode, refresh)
  renderScopeBar(body, rosterMode, refresh, scopeLabel)
  const multi = rosterMode === 'multi'
  // 单库：全部平铺（与以前一致）。多库：按当前 Tab 只渲染对应的一组。
  const showOverview = !multi || activeTab === 'overview'
  const showLibrary = !multi || activeTab === 'library'
  const showGlobal = !multi || activeTab === 'global'
  // 多库 + 「本库配置」但还没选库：只给一句「先去总览选一个」，不渲染按库生效的面板
  // （需求 3：多库时这些项目应当隐藏，选中某个库后才出现）。
  const libraryPicked = !multi || editingWiki !== undefined

  if (showGlobal) body.append(configState.host)
  if (showOverview) {
    renderWikiListSection(body, isDisposed, refresh)
    renderWikiLocationSection(body, isDisposed, refresh)
  }
  if (showLibrary && libraryPicked) {
    renderCatalogSection(body, state.info, state.catalog, state.runtimePlugins, refresh, catalogPending)
    renderSeedsSection(body, isDisposed)
  } else if (showLibrary) {
    renderPickLibraryHint(body)
  }
}

/** React wrapper consumed by the shell's settings.section slot. */
export function SettingsSection(): React.ReactElement {
  const ref = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    const el = ref.current
    return el === null ? undefined : mountSettingsPage(el)
  }, [])
  return React.createElement('div', { ref })
}

// ── public surface of the settings-page family (v0.28.8 split) ─────────────
// The sections above were extracted out of THIS file; re-export their parts so
// every existing import path (`./settings-page.ts`) keeps working unchanged.
export { makeErrorBanner, fetchJson, withWiki } from './settings-page-runtime.ts'
export type { WikiListItemView, WikisView } from './settings-page-runtime.ts'
export { renderWikiListSection, renderWikiLocationSection } from './settings-page-wikis.ts'
export type { WikiLocationView } from './settings-page-wikis.ts'
export { renderConfigSection } from './settings-page-config.ts'
export type { ConfigField, ConfigRenderState } from './settings-page-config.ts'
export { renderCatalogSection, renderSeedsSection } from './settings-page-catalog.ts'
export type { CatalogEntry, CatalogPending, SeedItem } from './settings-page-catalog.ts'

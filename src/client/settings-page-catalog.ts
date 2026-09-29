/**
 * 插件 / 主题 / 语言 / 初始化 sections of the settings page (v0.28.8 split).
 *
 * Everything that configures the CONTENT of ONE wiki: which bundled plugins and
 * themes it loads, which language packs are enabled, and the one-time seeds.
 * All four are per-wiki and reach the host through per-wiki admin routes, and
 * all four keep "not touched yet" in a mount-level `CatalogPending` (see below)
 * so an unrelated refresh cannot silently discard an unapplied checkbox.
 *
 * @module dsh-tiddlywiki/client/settings-page-catalog
 */
import { toast } from './toast.ts'
import { make } from './dom.ts'
import { t } from './i18n.ts'
import {
  ADMIN_INFO_ENDPOINT as INFO_ENDPOINT,
  ADMIN_SEEDS_ENDPOINT as SEEDS_ENDPOINT,
  ADMIN_SEEDS_REMOVE_ENDPOINT as SEEDS_REMOVE_ENDPOINT,
  ADMIN_SEEDS_RUN_ENDPOINT as SEEDS_RUN_ENDPOINT,
} from './endpoints.ts'
import { fetchJson, withWiki } from './settings-page-runtime.ts'
// v0.30.14: 三个「应用…（重启 TW）」按钮同样会就地重启 TW 子进程，所以它们也必须在
// 成功之后让面板重载 —— 与状态行的「重启 TW」按钮同一条理由（作者 2026-09-29）。
import { invalidateStatus } from './status-cache.ts'
import { reloadTwSurfaces } from './tw-frame.ts'

/** One bundled plugin/theme/language, as the host catalog reports it. */
export interface CatalogEntry {
  name: string
  title: string
  label: string
  description: string
}

/**
 * `state.info` as `GET /admin/state` reports it (the loaded/bundled sets).
 *
 * Named rather than inlined as an object type: this parameter list used to spell
 * the shape out inline, and a guard that locates a function body by scanning for
 * the first `{` would then stop at the TYPE instead of the body (v0.28.8 split —
 * see `bodyOf()` in scripts/verify-frame-guards.mjs).
 */
export interface AdminInfoView {
  plugins?: string[]
  themes?: string[]
  languages?: string[]
  themeActive?: string
}

/** `state.catalog` — the bundled, offline-usable plugin/theme/language list. */
export interface CatalogView {
  plugins?: CatalogEntry[]
  themes?: CatalogEntry[]
  languages?: CatalogEntry[]
}

/**
 * Runtime plugin truth of the wiki folder (v0.26.0). `null`/absent = the host
 * could not scan the tiddlers dir; renderers must treat that as "unknown".
 */
export interface RuntimePluginsView {
  wikiPlugins?: Array<{ title: string; name?: string; description?: string; version?: string }>
  disabled?: string[]
}

/** One one-time seed, as `GET /admin/seeds` reports it. */
export interface SeedItem {
  id: string
  title: string
  description: string
  present: boolean
  /** true = 可选 seed（非功能必需），可「反初始化」移除。 */
  removable?: boolean
  detail?: string
  /** v0.22.0：内置内容比本 wiki 预置时更新（可重新初始化拿来）。 */
  updateAvailable?: boolean
  /** true=本地改过；false=没动过；undefined=旧格式标记，无法判断。 */
  userModified?: boolean
}

/**
 * 未应用的勾选（插件管理 / 主题管理 / 语言管理）。
 *
 * `renderCatalogSection` 每次 refresh() 都从 `state.info` 重建勾选态，而 refresh()
 * 由「同步 / 重启 TW / 保存」触发 —— 用户勾完插件顺手点状态行的「同步」，勾选就被
 * 静默丢掉（勾选当时只活在这一次渲染的 DOM 里）。所以把「用户期望的集合」提升到
 * mount 级：
 *   - `undefined` = 用户还没碰过，完全跟随服务器；
 *   - 有值 = 用户的完整期望集合（不是增量 —— 「取消勾选」也必须活过 refresh）。
 * 点「应用」成功后清回 undefined，重新跟随服务器。
 */
export interface CatalogPending {
  plugins?: Set<string>
  themes?: Set<string>
  languages?: Set<string>
  themeActive?: string
}

/** Plugin/theme manager: checkboxes/radios + apply (writes info, restarts). */
export function renderCatalogSection(
  body: HTMLElement,
  info: AdminInfoView | undefined,
  catalog: CatalogView | undefined,
  runtimePlugins: RuntimePluginsView | null | undefined,
  refresh: () => Promise<void>,
  pending: CatalogPending,
): void {
  const plugins = catalog?.plugins ?? []
  const themes = catalog?.themes ?? []
  const languages = catalog?.languages ?? []
  const serverPlugins = info?.plugins ?? []
  const serverLoadedThemes = new Set(info?.themes ?? [])
  const serverLanguages = info?.languages ?? []
  // 期望集合（见 CatalogPending）：没有被用户碰过时纯跟随服务器。
  const desiredPlugins = (): Set<string> => pending.plugins ?? new Set(serverPlugins)
  const desiredThemes = (): Set<string> => pending.themes ?? new Set(serverLoadedThemes)
  const desiredLanguages = (): Set<string> => pending.languages ?? new Set(serverLanguages)
  // 运行时真相（v0.26.0）：被 TW 禁用的插件标题集合 + wiki 内插件 tiddler 的标题集合。
  // `runtimePlugins == null` = 宿主扫不出（tiddlers 目录读失败）→ 一律当「未知」，
  // 不显示徽标也不显示只读小节，绝不显示「空的假象」（读失败 ≠ 不存在）。
  const disabledTitles = new Set(runtimePlugins?.disabled ?? [])
  const wikiTitles = new Set((runtimePlugins?.wikiPlugins ?? []).map((p) => p.title))

  // ── plugins ──────────────────────────────────────────────────────────────
  const pluginSection = make('section', 'dsh-tw-settings-section')
  pluginSection.append(make('h3', 'dsh-tw-settings-h', t('settings.plugin.title')))
  const pluginHint = make('div', 'dsh-tw-settings-muted', t('settings.plugin.hint'))
  pluginSection.append(pluginHint)
  const search = make('input', 'dsh-tw-settings-input dsh-tw-settings-search')
  search.placeholder = t('settings.plugin.searchPlaceholder')
  const listWrap = make('div', 'dsh-tw-settings-list')
  const applyPlugins = make('button', 'dsh-tw-settings-btn dsh-tw-settings-primary', t('settings.plugin.apply'))
  applyPlugins.type = 'button'
  /**
   * 没碰过勾选时禁用「应用」（v0.26.1）：`pending.plugins === undefined` = 跟随服务器，
   * 提交没有意义；把它当成「空期望集合」误提交就是清空整个启动清单。勾选变化时重算。
   */
  const syncApplyPlugins = (): void => {
    applyPlugins.disabled = pending.plugins === undefined
  }

  const renderPluginList = (needle: string): void => {
    listWrap.replaceChildren()
    const q = needle.toLowerCase()
    for (const plugin of plugins) {
      if (q.length > 0 && !`${plugin.label} ${plugin.name} ${plugin.description}`.toLowerCase().includes(q)) continue
      const input = make('input', 'dsh-tw-settings-check')
      input.type = 'checkbox'
      input.checked = desiredPlugins().has(plugin.name)
      input.addEventListener('change', () => {
        const next = desiredPlugins()
        if (input.checked) next.add(plugin.name)
        else next.delete(plugin.name)
        pending.plugins = next
        syncApplyPlugins()
      })
      const label = make('label', 'dsh-tw-settings-row dsh-tw-settings-plugin')
      const name = make('span', 'dsh-tw-settings-name', plugin.label)
      name.title = plugin.name
      const desc = make('span', 'dsh-tw-settings-muted', plugin.description || plugin.name)
      label.append(input, name)
      // 状态徽标（v0.26.0）：勾选只反映 tiddlywiki.info，运行时真相反映在这里。
      // ① 已在启动清单（勾选）但被 TW 禁用；② 不在启动清单但 wiki 内有同名 tiddler
      // 版本（TW 原生装的）。两种都常见，且不显示就会让用户误判「没装成功」。
      // 判据取**服务器集合**而不是 desiredPlugins()：徽标描述的是当前事实，
      // 不该随「还没应用的勾选」抖动（v0.26.1）。
      if (runtimePlugins != null && disabledTitles.has(plugin.title)) {
        const badge = make('span', 'dsh-tw-settings-chip', t('settings.plugin.badgeDisabled'))
        badge.dataset.state = 'disabled'
        badge.title = t('settings.plugin.badgeDisabledTitle')
        label.append(badge)
      } else if (runtimePlugins != null && !serverPlugins.includes(plugin.name) && wikiTitles.has(plugin.title)) {
        const badge = make('span', 'dsh-tw-settings-chip', t('settings.plugin.badgeInstalled'))
        badge.dataset.state = 'update'
        badge.title = t('settings.plugin.badgeInstalledTitle')
        label.append(badge)
      }
      label.append(desc)
      listWrap.append(label)
    }
  }
  search.addEventListener('input', () => renderPluginList(search.value))
  applyPlugins.addEventListener('click', () => {
    if (pending.plugins === undefined) return
    applyPlugins.disabled = true
    void (async () => {
      try {
        await fetchJson(withWiki(INFO_ENDPOINT), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plugins: [...desiredPlugins()] }) })
        // 应用成功才清 pending：之后重新跟随服务器（TW 重启后 info 会给出真实集合）。
        pending.plugins = undefined
        toast(t('settings.plugin.applied'))
        reloadTwSurfaces()
        invalidateStatus()
        void refresh()
      } catch (err) {
        toast(t('settings.catalog.applyFailed', { message: err instanceof Error ? err.message : String(err) }))
        syncApplyPlugins()
      }
    })()
  })
  renderPluginList('')
  syncApplyPlugins()
  pluginSection.append(search, listWrap, applyPlugins)
  body.append(pluginSection)

  // ── wiki-installed plugins (read-only mirror of TW's own management) ─────
  // v0.26.0：这些插件以 tiddler 形式存在 wiki 里（TW 原生插件库/导入装的），
  // tiddlywiki.info 与上面的勾选都不覆盖它们——不列出来，用户就会像作者本人
  // 一样疑惑「TW 里明明启用着，这里怎么没有」。只读：启停/卸载去 TW 控制面板。
  if (runtimePlugins != null) {
    const catalogTitles = new Set(plugins.map((p) => p.title))
    const externals = (runtimePlugins.wikiPlugins ?? []).filter((p) => !catalogTitles.has(p.title) || disabledTitles.has(p.title))
    if (externals.length > 0) {
      const wikiSection = make('section', 'dsh-tw-settings-section')
      wikiSection.append(make('h3', 'dsh-tw-settings-h', t('settings.wikiPlugins.title')))
      wikiSection.append(
        make(
          'div',
          'dsh-tw-settings-muted',
          t('settings.wikiPlugins.hint'),
        ),
      )
      const wikiWrap = make('div', 'dsh-tw-settings-list')
      for (const plugin of externals) {
        const row = make('div', 'dsh-tw-settings-row dsh-tw-settings-plugin')
        const name = make('span', 'dsh-tw-settings-name', plugin.name || plugin.title)
        name.title = plugin.title
        row.append(name)
        if (disabledTitles.has(plugin.title)) {
          const badge = make('span', 'dsh-tw-settings-chip', t('settings.wikiPlugins.disabled'))
          badge.dataset.state = 'disabled'
          badge.title = t('settings.wikiPlugins.disabledTitle')
          row.append(badge)
        } else if (plugin.version) {
          const ver = make('span', 'dsh-tw-settings-chip', `v${plugin.version}`)
          ver.dataset.state = 'ok'
          row.append(ver)
        }
        const desc = make('span', 'dsh-tw-settings-muted', plugin.description || plugin.title)
        desc.title = plugin.title
        row.append(desc)
        wikiWrap.append(row)
      }
      wikiSection.append(wikiWrap)
      body.append(wikiSection)
    }
  }

  // ── themes ───────────────────────────────────────────────────────────────
  // `info.themes` = WHICH theme plugins are LOADED (multi-select; TW's own
  // default is [vanilla, snowwhite]); `$:/theme` = the ACTIVE one (single).
  // Two controls per theme: ☑ 加载 (multi) + ◉ 活动 (single, auto-added to the
  // loaded set on apply). The host computes the dependency closure (heavier →
  // vanilla+snowwhite+heavier) and writes $:/theme.
  const themeSection = make('section', 'dsh-tw-settings-section')
  themeSection.append(make('h3', 'dsh-tw-settings-h', t('settings.themes.title')))
  const themeHint = make('div', 'dsh-tw-settings-muted', t('settings.themes.hint'))
  const themeHead = make('div', 'dsh-tw-settings-row dsh-tw-settings-head')
  themeHead.append(
    make('span', 'dsh-tw-settings-col', t('settings.themes.colLoad')),
    make('span', 'dsh-tw-settings-col', t('settings.themes.colActive')),
    make('span', 'dsh-tw-settings-name', t('settings.themes.colTheme')),
  )
  const themeList = info?.themes ?? []
  // The ACTIVE theme comes from the host (`$:/theme`, v0.22.3). Deriving it from
  // the last loaded entry was a guess: with an explicitly activated non-last
  // theme the wrong radio showed up checked, and one click on 应用主题 (without
  // touching the radios) rewrote `$:/theme` to that wrong pick. Guessing stays
  // as the fallback only when the host cannot tell (wiki down / no `$:/theme`).
  const activeFromServer = info?.themeActive
  const lastLoadedTheme = themeList[themeList.length - 1]
  const serverActiveThemeName =
    typeof activeFromServer === 'string' && themes.some((theme) => theme.name === activeFromServer)
      ? activeFromServer
      : lastLoadedTheme ?? 'tiddlywiki/vanilla'
  /** 活动主题同样走 pending：单选按钮的未应用选择也要活过 refresh（见 CatalogPending）。 */
  const activeThemeName = (): string => pending.themeActive ?? serverActiveThemeName
  const applyThemes = make('button', 'dsh-tw-settings-btn dsh-tw-settings-primary', t('settings.themes.apply'))
  applyThemes.type = 'button'
  /**
   * 没碰过主题的任何控件时禁用「应用」（v0.26.1，同插件管理）：`pending.* === undefined`
   * 才是「跟随服务器」；未碰过就提交会把「空期望集合」写成 `themes: []`，把主题清空。
   */
  const syncApplyThemes = (): void => {
    applyThemes.disabled = pending.themes === undefined && pending.themeActive === undefined
  }
  const themeWrap = make('div', 'dsh-tw-settings-list')
  for (const theme of themes) {
    const load = make('input', 'dsh-tw-settings-check')
    load.type = 'checkbox'
    load.checked = desiredThemes().has(theme.name)
    load.title = t('settings.themes.loadTitle')
    load.addEventListener('change', () => {
      const next = desiredThemes()
      if (load.checked) next.add(theme.name)
      else next.delete(theme.name)
      pending.themes = next
      syncApplyThemes()
    })
    const act = make('input', 'dsh-tw-settings-check')
    act.type = 'radio'
    act.name = 'dsh-tw-active-theme'
    act.checked = theme.name === activeThemeName()
    act.title = t('settings.themes.activeTitle')
    act.addEventListener('change', () => {
      if (act.checked) pending.themeActive = theme.name
      syncApplyThemes()
    })
    const name = make('span', 'dsh-tw-settings-name', theme.label)
    name.title = theme.name
    const desc = make('span', 'dsh-tw-settings-muted', theme.description || theme.name)
    const row = make('div', 'dsh-tw-settings-row dsh-tw-settings-plugin')
    row.append(load, act, name, desc)
    themeWrap.append(row)
  }
  applyThemes.addEventListener('click', () => {
    if (pending.themes === undefined && pending.themeActive === undefined) return
    applyThemes.disabled = true
    void (async () => {
      try {
        await fetchJson(withWiki(INFO_ENDPOINT), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ themes: [...desiredThemes()], themeActive: activeThemeName() }),
        })
        // 应用成功才清 pending（同插件管理）。
        pending.themes = undefined
        pending.themeActive = undefined
        toast(t('settings.themes.applied'))
        reloadTwSurfaces()
        invalidateStatus()
        void refresh()
      } catch (err) {
        toast(t('settings.catalog.applyFailed', { message: err instanceof Error ? err.message : String(err) }))
        syncApplyThemes()
      }
    })()
  })
  syncApplyThemes()
  themeSection.append(themeHint, themeHead, themeWrap, applyThemes)
  body.append(themeSection)

  // ── languages (bundled, offline — enable → restart TW) ──────────────────
  const langSection = make('section', 'dsh-tw-settings-section')
  langSection.append(make('h3', 'dsh-tw-settings-h', t('settings.langs.title')))
  const langHint = make('div', 'dsh-tw-settings-muted', t('settings.langs.hint'))
  const langWrap = make('div', 'dsh-tw-settings-list')
  const applyLangs = make('button', 'dsh-tw-settings-btn dsh-tw-settings-primary', t('settings.langs.apply'))
  applyLangs.type = 'button'
  /** 没碰过语言勾选时禁用「应用」（v0.26.1，同插件管理）：未碰过 ≠ 期望集合为空。 */
  const syncApplyLangs = (): void => {
    applyLangs.disabled = pending.languages === undefined
  }
  for (const lang of languages) {
    const input = make('input', 'dsh-tw-settings-check')
    input.type = 'checkbox'
    input.checked = desiredLanguages().has(lang.name)
    input.addEventListener('change', () => {
      const next = desiredLanguages()
      if (input.checked) next.add(lang.name)
      else next.delete(lang.name)
      pending.languages = next
      syncApplyLangs()
    })
    const label = make('label', 'dsh-tw-settings-row dsh-tw-settings-plugin')
    const name = make('span', 'dsh-tw-settings-name', lang.label)
    name.title = lang.name
    const desc = make('span', 'dsh-tw-settings-muted', lang.description || lang.name)
    label.append(input, name, desc)
    langWrap.append(label)
  }
  applyLangs.addEventListener('click', () => {
    if (pending.languages === undefined) return
    applyLangs.disabled = true
    void (async () => {
      try {
        await fetchJson(withWiki(INFO_ENDPOINT), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ languages: [...desiredLanguages()] }) })
        pending.languages = undefined
        toast(t('settings.langs.applied'))
        reloadTwSurfaces()
        invalidateStatus()
        void refresh()
      } catch (err) {
        toast(t('settings.catalog.applyFailed', { message: err instanceof Error ? err.message : String(err) }))
        syncApplyLangs()
      }
    })()
  })
  syncApplyLangs()
  langSection.append(langHint, langWrap, applyLangs)
  body.append(langSection)
}

/**
 * 初始化 section: lists every one-time seed with its live status and offers
 * per item (and for all):
 *   - 「重新初始化」(force) — write/restore the built-in content;
 *   - 「反初始化」(remove, optional seeds only) — delete the seeded
 *     tiddlers + markers, returning the wiki to the "never seeded" state.
 * Core seeds (发送给 Agent 按钮 / TW 前端 API 基址) are 功能必需: auto-seeded
 * on startup and never removable. Optional seeds are opt-in — never forced.
 */
export function renderSeedsSection(body: HTMLElement, isDisposed: () => boolean): void {
  const section = make('section', 'dsh-tw-settings-section')
  section.append(make('h3', 'dsh-tw-settings-h', t('settings.seeds.title')))
  const hint = make('div', 'dsh-tw-settings-muted', t('settings.seeds.hint'))
  const wrap = make('div', 'dsh-tw-settings-list')
  const statusLine = make('div', 'dsh-tw-settings-muted')

  const load = async (): Promise<void> => {
    // 与 refresh() 相同的卸载守卫：本函数由组件挂载时触发、也可能在卸载后由
    // 按钮回调的 await 之后调用，晚到的响应不得再 wrap.replaceChildren()。
    if (isDisposed()) return
    try {
      const data = await fetchJson<{ ok?: boolean; items?: SeedItem[]; error?: string }>(withWiki(SEEDS_ENDPOINT))
      if (isDisposed()) return
      if (data.ok !== true || !Array.isArray(data.items)) throw new Error(data.error ?? t('settings.seeds.fetchFailed'))
      wrap.replaceChildren()
      let presentCount = 0
      let removableCount = 0
      for (const item of data.items) {
        if (item.present) presentCount += 1
        if (item.removable) removableCount += 1
        const dot = make('span', 'dsh-tw-settings-chip', item.present ? '✓' : '✗')
        dot.dataset.state = item.present ? 'ok' : 'missing'
        dot.title = item.present ? t('settings.seeds.present') : t('settings.seeds.missing')
        const title = make('span', 'dsh-tw-settings-name', item.title)
        title.title = item.id
        const desc = make('span', 'dsh-tw-settings-muted', item.detail ?? item.description)
        // v0.22.0: the marker records content hashes, so we can say whether the
        // BUILT-IN moved on and whether the user edited their copy — and warn
        // before a 「重新初始化」 overwrites local edits.
        const updateChip = item.updateAvailable === true
          ? make('span', 'dsh-tw-settings-chip', t('settings.seeds.updateChip'))
          : undefined
        if (updateChip !== undefined) {
          updateChip.dataset.state = 'update'
          updateChip.title = t('settings.seeds.updateTitle')
        }
        const modifiedChip = item.userModified === true
          ? make('span', 'dsh-tw-settings-chip', t('settings.seeds.modifiedChip'))
          : undefined
        if (modifiedChip !== undefined) {
          modifiedChip.dataset.state = 'missing'
          modifiedChip.title = t('settings.seeds.modifiedTitle')
        }
        const btn = make('button', 'dsh-tw-settings-btn', item.updateAvailable === true ? t('settings.seeds.updateToBuiltin') : t('settings.seeds.reinit'))
        btn.type = 'button'
        btn.title = t('settings.seeds.rewriteTitle', { title: item.title })
        btn.addEventListener('click', () => {
          if (item.updateAvailable === true) {
            const warning = item.userModified === true
              ? t('settings.seeds.overwriteModified', { title: item.title })
              : item.userModified === undefined
                ? t('settings.seeds.overwriteUnknown', { title: item.title })
                : ''
            if (!window.confirm(t('settings.seeds.overwriteConfirm', { warning: warning.length > 0 ? `${warning}\n\n` : '' }))) return
          }
          btn.disabled = true
          btn.textContent = t('settings.seeds.running')
          void (async () => {
            try {
              const res = await fetch(withWiki(SEEDS_RUN_ENDPOINT), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: item.id, force: true }),
                signal: AbortSignal.timeout(30_000),
              })
              const payload = (await res.json().catch(() => null)) as { ok?: boolean; results?: Array<{ id?: string; detail?: string; error?: string }>; error?: string } | null
              if (!res.ok || payload?.ok !== true) {
                toast(t('settings.seeds.reinitFailed', { message: payload?.error ?? payload?.results?.[0]?.error ?? `HTTP ${res.status}` }))
              } else {
                toast(t('settings.seeds.reinitDone', { title: item.title }))
              }
              void load()
            } catch (err) {
              toast(t('settings.seeds.reinitFailed', { message: err instanceof Error ? err.message : String(err) }))
            } finally {
              btn.disabled = false
              btn.textContent = item.updateAvailable === true ? t('settings.seeds.updateToBuiltin') : t('settings.seeds.reinit')
            }
          })()
        })
        const row = make('div', 'dsh-tw-settings-row dsh-tw-settings-plugin')
        row.append(dot, title)
        if (updateChip !== undefined) row.append(updateChip)
        if (modifiedChip !== undefined) row.append(modifiedChip)
        row.append(desc, btn)
        if (item.removable) {
          const rm = make('button', 'dsh-tw-settings-btn dsh-tw-settings-danger', t('settings.seeds.remove'))
          rm.type = 'button'
          rm.title = t('settings.seeds.removeTitle', { title: item.title })
          rm.addEventListener('click', () => {
            if (!window.confirm(t('settings.seeds.removeConfirm', { title: item.title }))) return
            rm.disabled = true
            rm.textContent = t('settings.seeds.removing')
            void (async () => {
              try {
                const res = await fetch(withWiki(SEEDS_REMOVE_ENDPOINT), {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ id: item.id }),
                  signal: AbortSignal.timeout(30_000),
                })
                const payload = (await res.json().catch(() => null)) as { ok?: boolean; results?: Array<{ id?: string; detail?: string; error?: string }>; error?: string } | null
                if (!res.ok || payload?.ok !== true) {
                  toast(t('settings.seeds.removeFailed', { message: payload?.error ?? payload?.results?.[0]?.error ?? `HTTP ${res.status}` }))
                } else {
                  toast(t('settings.seeds.removeDone', { title: item.title }))
                }
                void load()
              } catch (err) {
                toast(t('settings.seeds.removeFailed', { message: err instanceof Error ? err.message : String(err) }))
              } finally {
                rm.disabled = false
                rm.textContent = t('settings.seeds.remove')
              }
            })()
          })
          row.append(rm)
        }
        wrap.append(row)
      }
      statusLine.textContent = t('settings.seeds.statusLine', { total: data.items.length, present: presentCount, removable: removableCount })
    } catch (err) {
      if (isDisposed()) return
      statusLine.textContent = t('settings.seeds.loadStatusFailed', { message: err instanceof Error ? err.message : String(err) })
    }
  }

  const runAll = make('button', 'dsh-tw-settings-btn dsh-tw-settings-primary', t('settings.seeds.runAll'))
  runAll.type = 'button'
  runAll.title = t('settings.seeds.runAllTitle')
  runAll.addEventListener('click', () => {
    runAll.disabled = true
    runAll.textContent = t('settings.seeds.running')
    void (async () => {
      try {
        const res = await fetch(withWiki(SEEDS_RUN_ENDPOINT), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ force: true }),
          signal: AbortSignal.timeout(60_000),
        })
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
        if (!res.ok || payload?.ok !== true) toast(t('settings.seeds.reinitFailed', { message: payload?.error ?? `HTTP ${res.status}` }))
        else toast(t('settings.seeds.allReinitDone'))
        void load()
      } catch (err) {
        toast(t('settings.seeds.reinitFailed', { message: err instanceof Error ? err.message : String(err) }))
      } finally {
        runAll.disabled = false
        runAll.textContent = t('settings.seeds.runAll')
      }
    })()
  })

  const removeAll = make('button', 'dsh-tw-settings-btn dsh-tw-settings-danger', t('settings.seeds.removeAll'))
  removeAll.type = 'button'
  removeAll.title = t('settings.seeds.removeAllTitle')
  removeAll.addEventListener('click', () => {
    if (!window.confirm(t('settings.seeds.removeAllConfirm'))) return
    removeAll.disabled = true
    removeAll.textContent = t('settings.seeds.removing')
    void (async () => {
      try {
        const res = await fetch(withWiki(SEEDS_REMOVE_ENDPOINT), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(60_000),
        })
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
        if (!res.ok || payload?.ok !== true) toast(t('settings.seeds.removeFailed', { message: payload?.error ?? `HTTP ${res.status}` }))
        else toast(t('settings.seeds.allRemoved'))
        void load()
      } catch (err) {
        toast(t('settings.seeds.removeFailed', { message: err instanceof Error ? err.message : String(err) }))
      } finally {
        removeAll.disabled = false
        removeAll.textContent = t('settings.seeds.removeAll')
      }
    })()
  })

  section.append(hint, statusLine, wrap, runAll, removeAll)
  body.append(section)
  void load()
}

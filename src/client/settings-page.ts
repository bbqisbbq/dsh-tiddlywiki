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
 * @module dsh-tiddlywiki/client/settings-page
 */
import * as React from 'react'
import { toast } from './toast.ts'
import { invalidateUiConfig } from './ui-config.ts'
import {
  ADMIN_CONFIG_ENDPOINT as CONFIG_ENDPOINT,
  ADMIN_INFO_ENDPOINT as INFO_ENDPOINT,
  ADMIN_PROMPT_ENDPOINT as PROMPT_ENDPOINT,
  ADMIN_RESTART_ENDPOINT as RESTART_ENDPOINT,
  ADMIN_SEEDS_ENDPOINT as SEEDS_ENDPOINT,
  ADMIN_SEEDS_REMOVE_ENDPOINT as SEEDS_REMOVE_ENDPOINT,
  ADMIN_SEEDS_RUN_ENDPOINT as SEEDS_RUN_ENDPOINT,
  ADMIN_STATE_ENDPOINT as STATE_ENDPOINT,
  ADMIN_WIKI_LOCATION_ENDPOINT as WIKI_LOCATION_ENDPOINT,
  ADMIN_WIKI_RESET_ENDPOINT as WIKI_RESET_ENDPOINT,
  ADMIN_WIKI_SWITCH_ENDPOINT as WIKI_SWITCH_ENDPOINT,
  SYNC_ENDPOINT,
} from './endpoints.ts'

interface CatalogEntry {
  name: string
  title: string
  label: string
  description: string
}

interface AdminState {
  ok?: boolean
  server?: { status?: string; url?: string; wikiPath?: string; error?: string }
  info?: { plugins?: string[]; themes?: string[]; languages?: string[] }
  catalog?: { plugins?: CatalogEntry[]; themes?: CatalogEntry[]; languages?: CatalogEntry[] }
  config?: Record<string, unknown>
  git?: { exists?: boolean; branch?: string; dirty?: boolean; lastCommit?: string; remote?: string } | null
  error?: string
}

interface SeedItem {
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
  legacyMarker?: boolean
}

/** Payload of GET /admin/wiki/location (v0.22.0 runtime wiki switch). */
interface WikiLocationView {
  ok?: boolean
  current?: { root?: string; name?: string; path?: string; source?: string }
  default?: { root?: string; name?: string; path?: string }
  stateFile?: string
  candidates?: string[]
  error?: string
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
  const data = (await res.json().catch(() => ({}))) as T
  if (!res.ok) {
    const err = (data as { error?: string }).error ?? `HTTP ${res.status}`
    throw new Error(err)
  }
  return data
}

/** Form controls registry for the config section (changed-only patch). */
interface ConfigField {
  key: string
  input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  initial: string | boolean | number
  read: () => string | boolean | number
  changed: () => boolean
}

export function mountSettingsPage(container: HTMLElement): () => void {
  let disposed = false
  container.classList.add('dsh-tw-settings')

  const statusRow = make('div', 'dsh-tw-settings-row dsh-tw-settings-status')
  const body = make('div', 'dsh-tw-settings-body')
  container.append(statusRow, body)

  const disposers: Array<() => void> = []
  /** Config-section DOM + the server signature it was built from (see renderMain). */
  const configState: ConfigRenderState = {}

  const refresh = async (): Promise<void> => {
    try {
      const state = await fetchJson<AdminState>(STATE_ENDPOINT)
      if (disposed) return
      renderStatus(statusRow, state, refresh)
      renderMain(body, state, refresh, () => disposed, configState)
    } catch (err) {
      if (disposed) return
      body.replaceChildren()
      statusRow.replaceChildren()
      const msg = make('div', 'dsh-tw-settings-error', `加载配置失败：${err instanceof Error ? err.message : String(err)}`)
      const retry = make('button', 'dsh-tw-settings-btn', '重试')
      retry.type = 'button'
      retry.addEventListener('click', () => { void refresh() })
      body.append(msg, retry)
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
    state.git?.dirty === true ? '有未提交改动' : '',
  ].filter(Boolean).join(' · ')
  const label = make('span', 'dsh-tw-settings-muted', info)
  const sync = make('button', 'dsh-tw-settings-btn', '同步')
  sync.type = 'button'
  sync.title = 'git 同步（pull → commit → push）'
  sync.addEventListener('click', () => {
    sync.disabled = true
    sync.textContent = '同步中…'
    void (async () => {
      try {
        const res = await fetch(SYNC_ENDPOINT, { method: 'POST', signal: AbortSignal.timeout(120_000) })
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; message?: string; error?: string; changed?: boolean; restarted?: boolean; restartError?: string } | null
        if (!res.ok || payload?.ok !== true) toast(`同步失败：${payload?.error ?? payload?.message ?? `HTTP ${res.status}`}`)
        else {
          let detail = ''
          if (payload.changed === true) {
            detail += payload.restarted === true ? '，TW 已重启' : '，TW 未自动重启'
            if (payload.restartError) detail += `（${payload.restartError}）`
          }
          toast(`同步完成：${payload.message ?? 'OK'}${detail}`)
        }
      } catch (err) {
        toast(`同步失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        sync.disabled = false
        sync.textContent = '同步'
        void refresh()
      }
    })()
  })
  const restart = make('button', 'dsh-tw-settings-btn', '重启 TW')
  restart.type = 'button'
  restart.addEventListener('click', () => {
    restart.disabled = true
    restart.textContent = '重启中…'
    void (async () => {
      try {
        await fetchJson(RESTART_ENDPOINT, { method: 'POST' })
        toast('TW 已重启')
      } catch (err) {
        toast(`重启失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        restart.disabled = false
        restart.textContent = '重启 TW'
        void refresh()
      }
    })()
  })
  row.append(chip, label, sync, restart)
}

/** Config section: fields bound to effective config, changed-only save. */
function renderConfigSection(body: HTMLElement, config: Record<string, unknown>, refresh: () => Promise<void>): void {
  const section = make('section', 'dsh-tw-settings-section')
  section.append(make('h3', 'dsh-tw-settings-h', '常规配置'))
  const note = (config.note ?? {}) as Record<string, unknown>
  const git = (config.git ?? {}) as Record<string, unknown>
  const ui = (config.ui ?? {}) as Record<string, unknown>
  const fields: ConfigField[] = []

  const textField = (key: string, label: string, initial: string): void => {
    const input = make('input', 'dsh-tw-settings-input')
    input.value = initial
    const wrap = make('label', 'dsh-tw-settings-field')
    wrap.append(make('span', 'dsh-tw-settings-label', label), input)
    fields.push({ key, input, initial, read: () => input.value.trim(), changed: () => input.value.trim() !== initial })
    section.append(wrap)
  }
  const checkField = (key: string, label: string, initial: boolean): void => {
    const input = make('input', 'dsh-tw-settings-check')
    input.type = 'checkbox'
    input.checked = initial
    const wrap = make('label', 'dsh-tw-settings-field dsh-tw-settings-field-check')
    wrap.append(input, make('span', 'dsh-tw-settings-label', label))
    fields.push({ key, input, initial, read: () => input.checked, changed: () => input.checked !== initial })
    section.append(wrap)
  }
  const numField = (key: string, label: string, initial: number): void => {
    const input = make('input', 'dsh-tw-settings-input')
    input.type = 'number'
    input.value = String(initial)
    // 显式区分「空串/非法输入」与合法的 0：旧写法 `Number(v) || initial` 会把 0
    // 当成 initial，changed() 变成 false —— 用户输入 0 以为保存了，其实没提交。
    const read = (): number => {
      const raw = input.value.trim()
      if (raw.length === 0) return initial
      const parsed = Number(raw)
      return Number.isFinite(parsed) ? parsed : initial
    }
    const wrap = make('label', 'dsh-tw-settings-field')
    wrap.append(make('span', 'dsh-tw-settings-label', label), input)
    fields.push({ key, input, initial, read, changed: () => read() !== initial })
    section.append(wrap)
  }
  const selectField = (key: string, label: string, initial: string, options: Array<{ value: string; label: string }>): void => {
    const select = make('select', 'dsh-tw-settings-input')
    for (const opt of options) {
      const option = document.createElement('option')
      option.value = opt.value
      option.textContent = opt.label
      if (opt.value === initial) option.selected = true
      select.append(option)
    }
    const wrap = make('label', 'dsh-tw-settings-field')
    wrap.append(make('span', 'dsh-tw-settings-label', label), select)
    fields.push({ key, input: select, initial, read: () => select.value, changed: () => select.value !== initial })
    section.append(wrap)
  }
  /**
   * Multi-line free text (v0.21.0: `prompt.extra` / `prompt.override`).
   * The DOM value keeps the user's newlines; only the OUTER whitespace is
   * trimmed by `read()` (that is what the host stores), so "unchanged" stays
   * stable across a refresh that re-renders from the server round-trip.
   */
  const areaField = (key: string, label: string, initial: string, rows: number): HTMLTextAreaElement => {
    const input = make('textarea', 'dsh-tw-settings-input dsh-tw-settings-area')
    input.rows = rows
    input.value = initial
    const wrap = make('label', 'dsh-tw-settings-field dsh-tw-settings-field-area')
    wrap.append(make('span', 'dsh-tw-settings-label', label), input)
    fields.push({ key, input, initial, read: () => input.value.trim(), changed: () => input.value.trim() !== initial })
    section.append(wrap)
    return input
  }

  textField('note.tag', '快速笔记默认 tag', typeof note.tag === 'string' ? note.tag : 'inbox')
  checkField('git.autoCommit', '自动 commit（防抖）', git.autoCommit !== false)
  numField('git.debounceMs', '自动 commit 防抖(ms)', typeof git.debounceMs === 'number' ? git.debounceMs : 60_000)
  textField('git.remote', 'git 远端（空=仅本地）', typeof git.remote === 'string' ? git.remote : '')
  textField('git.branch', 'git 分支', typeof git.branch === 'string' ? git.branch : 'main')
  checkField('ui.showQuickNote', '显示「知识库」按钮里的「快速笔记」入口', ui.showQuickNote !== false)
  checkField('ui.showQuickNoteDock', '显示聊天输入框上方的「快速笔记」快捷按钮', ui.showQuickNoteDock !== false)
  selectField('ui.quickNoteMode', '点击「快速笔记」的打开方式', typeof ui.quickNoteMode === 'string' && ui.quickNoteMode === 'card' ? 'card' : 'native', [
    { value: 'native', label: '原生编辑器：直接弹出 TW 原生编辑页（新建/恢复草稿）' },
    { value: 'card', label: 'Markdown 卡片：弹出现有快速笔记卡片（CodeMirror 编辑器）' },
  ])
  textField('ui.sidebarLabel', '侧边栏 TW 入口显示名称', typeof ui.sidebarLabel === 'string' && ui.sidebarLabel.trim().length > 0 ? ui.sidebarLabel.trim() : 'TiddlyWiki')
  checkField('ui.showPanelStatus', '显示「知识库」按钮里的 TW 面板/重载入口与状态行', ui.showPanelStatus !== false)
  checkField('ui.showSyncButton', '显示「知识库」按钮里的「同步」入口与 git 状态点', ui.showSyncButton !== false)
  checkField('ui.followDshTheme', '嵌入式 TW 跟随 DSH 深浅主题（暗色时自动切深色 palette，不写回 wiki）', ui.followDshTheme !== false)
  textField('ui.darkPalette', '暗色时 TW palette（tiddler 标题）', typeof ui.darkPalette === 'string' && ui.darkPalette.trim().length > 0 ? ui.darkPalette.trim() : '$:/palettes/CupertinoDark')
  textField('ui.tabLabel', '会话顶部「知识库」Tab 名称', typeof ui.tabLabel === 'string' && ui.tabLabel.trim().length > 0 ? ui.tabLabel.trim() : '知识库')
  checkField('ui.showSessionTab', '显示会话顶部「知识库」Tab（本会话相关 wiki 笔记汇总）', ui.showSessionTab !== false)
  checkField('ui.showRightbarTab', '在 DSH 右侧边栏提供 TiddlyWiki 入口/Tab（与聊天并排）', ui.showRightbarTab !== false)
  const sendToAgent = (ui.sendToAgent ?? {}) as Record<string, unknown>
  checkField('ui.sendToAgent.enabled', '启用「发送给 Agent」（TW 笔记 → DSH 会话注入）', sendToAgent.enabled !== false)
  textField('ui.sendToAgent.endpoint', 'TW 端请求基址（空=自动取当前 DSH origin）', typeof sendToAgent.endpoint === 'string' ? sendToAgent.endpoint : '')
  textField('ui.sendToAgent.token', '共享 token（非空时路由校验 x-send-to-agent-token 头；已设置时显示为 ********，原样保存=不改，清空=删除）', typeof sendToAgent.token === 'string' ? sendToAgent.token : '')
  const allArticles = (ui.allArticles ?? {}) as Record<string, unknown>
  numField('ui.allArticles.pageSize', '「所有文章」每页条数', typeof allArticles.pageSize === 'number' ? allArticles.pageSize : 10)

  // ── 系统提示词（v0.21.0）────────────────────────────────────────────────
  const prompt = (config.prompt ?? {}) as Record<string, unknown>
  section.append(make('h3', 'dsh-tw-settings-h', '系统提示词（注入每个会话）'))
  section.append(make('div', 'dsh-tw-settings-muted', '插件把自己的约定（同步纪律 / 标签约定 / 链接格式等）注入每个会话的系统提示词。保存后**无需重启 dsh web**：section 会即时重新注册，当前会话从下一步起就使用新文本。'))
  checkField('prompt.enabled', '注入 TiddlyWiki 提示词（关闭后本插件不再注入任何文本）', prompt.enabled !== false)
  selectField('prompt.mode', '内置文本形态', prompt.mode === 'full' ? 'full' : 'slim', [
    { value: 'slim', label: '精简（默认）：只保留工具 schema 表达不了的约定' },
    { value: 'full', label: '完整：额外附一份由工具注册表实时生成的参数索引' },
  ])
  areaField('prompt.extra', '附加说明（永远追加在末尾，可放团队/个人规范）', typeof prompt.extra === 'string' ? prompt.extra : '', 5)
  areaField('prompt.override', '整段替换（非空时取代上面的内置文本，附加说明仍会追加）', typeof prompt.override === 'string' ? prompt.override : '', 8)
  const preview = make('button', 'dsh-tw-settings-btn', '查看当前注入文本')
  preview.type = 'button'
  preview.title = '读取 host 端实时生成的提示词全文（保存后即为下一步注入的内容）'
  const previewOut = make('pre', 'dsh-tw-settings-prompt-preview')
  previewOut.hidden = true
  preview.addEventListener('click', () => {
    if (!previewOut.hidden) {
      previewOut.hidden = true
      previewOut.textContent = ''
      return
    }
    preview.disabled = true
    void (async () => {
      try {
        const data = await fetchJson<{ ok?: boolean; enabled?: boolean; mode?: string; length?: number; text?: string; error?: string }>(PROMPT_ENDPOINT)
        if (data.ok !== true) throw new Error(data.error ?? '获取失败')
        previewOut.textContent = data.enabled === false
          ? '（已关闭：不会注入任何提示词）'
          : `# 形态 ${data.mode ?? ''} · ${data.length ?? 0} 字符\n\n${data.text ?? ''}`
        previewOut.hidden = false
      } catch (err) {
        toast(`读取提示词失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        preview.disabled = false
      }
    })()
  })
  section.append(preview, previewOut)

  const bridge = (config.bridge ?? {}) as Record<string, unknown>
  checkField('bridge.enabled', '启用「本地剪藏桥」（书签小工具后端监听 127.0.0.1 端口，保存后立即生效）', bridge.enabled === true)
  numField('bridge.port', '剪藏桥端口（改端口需重启 dsh web 生效）', typeof bridge.port === 'number' && bridge.port > 0 ? bridge.port : 8618)
  textField('bridge.token', '剪藏桥 token（非空时校验书签的 x-clip-token 头；强烈建议设置。已设置时显示为 ********，原样保存=不改，清空=删除）', typeof bridge.token === 'string' ? bridge.token : '')
  textField('bridge.tag', '剪藏笔记默认 tag', typeof bridge.tag === 'string' && bridge.tag.trim().length > 0 ? bridge.tag.trim() : 'clip')
  // 界面语言在下方「语言管理」区块设置（config 的 uiLanguage 仅供启动时自动应用）。
  // 注意：uiLanguage 目前只影响 TW 侧语言，客户端插件文案（FAB/快速笔记/侧边栏/本页）
  // 暂为中文，尚无 i18n 分支。

  const save = make('button', 'dsh-tw-settings-btn dsh-tw-settings-primary', '保存配置')
  save.type = 'button'
  save.addEventListener('click', () => {
    save.disabled = true
    void (async () => {
      const patch: Record<string, unknown> = {}
      for (const field of fields) {
        if (!field.changed()) continue
        // Build nested paths like note.tag → {note:{tag}} and
        // ui.allArticles.pageSize → {ui:{allArticles:{pageSize}}}.
        const parts = field.key.split('.')
        let node = patch
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i]
          if (part === undefined) break
          if (i === parts.length - 1) {
            node[part] = field.read()
          } else {
            const child = (node[part] ?? {}) as Record<string, unknown>
            node[part] = child
            node = child
          }
        }
      }
      try {
        await fetchJson(CONFIG_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
        // ui.* 已落盘：清掉客户端缓存，下一次读取立即拿到新值（否则最长 15s 才生效）。
        invalidateUiConfig()
        toast('配置已保存')
        void refresh()
      } catch (err) {
        toast(`保存失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        save.disabled = false
      }
    })()
  })
  section.append(save)
  body.append(section)
}

/** Plugin/theme manager: checkboxes/radios + apply (writes info, restarts). */
function renderCatalogSection(
  body: HTMLElement,
  info: AdminState['info'],
  catalog: AdminState['catalog'],
  refresh: () => Promise<void>,
): void {
  const plugins = catalog?.plugins ?? []
  const themes = catalog?.themes ?? []
  const languages = catalog?.languages ?? []
  const activePlugins = new Set(info?.plugins ?? [])
  const loadedThemes = new Set(info?.themes ?? [])
  const activeLanguages = new Set(info?.languages ?? [])

  // ── plugins ──────────────────────────────────────────────────────────────
  const pluginSection = make('section', 'dsh-tw-settings-section')
  pluginSection.append(make('h3', 'dsh-tw-settings-h', '插件管理（自带官方插件）'))
  const search = make('input', 'dsh-tw-settings-input dsh-tw-settings-search')
  search.placeholder = '搜索插件…'
  const listWrap = make('div', 'dsh-tw-settings-list')
  const applyPlugins = make('button', 'dsh-tw-settings-btn dsh-tw-settings-primary', '应用插件（重启 TW）')
  applyPlugins.type = 'button'

  const renderPluginList = (needle: string): void => {
    listWrap.replaceChildren()
    const q = needle.toLowerCase()
    for (const plugin of plugins) {
      if (q.length > 0 && !`${plugin.label} ${plugin.name} ${plugin.description}`.toLowerCase().includes(q)) continue
      const input = make('input', 'dsh-tw-settings-check')
      input.type = 'checkbox'
      input.checked = activePlugins.has(plugin.name)
      input.addEventListener('change', () => {
        if (input.checked) activePlugins.add(plugin.name)
        else activePlugins.delete(plugin.name)
      })
      const label = make('label', 'dsh-tw-settings-row dsh-tw-settings-plugin')
      const name = make('span', 'dsh-tw-settings-name', plugin.label)
      name.title = plugin.name
      const desc = make('span', 'dsh-tw-settings-muted', plugin.description || plugin.name)
      label.append(input, name, desc)
      listWrap.append(label)
    }
  }
  search.addEventListener('input', () => renderPluginList(search.value))
  applyPlugins.addEventListener('click', () => {
    applyPlugins.disabled = true
    void (async () => {
      try {
        await fetchJson(INFO_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plugins: [...activePlugins] }) })
        toast('插件已应用，TW 已重启')
        void refresh()
      } catch (err) {
        toast(`应用失败：${err instanceof Error ? err.message : String(err)}`)
        applyPlugins.disabled = false
      }
    })()
  })
  renderPluginList('')
  pluginSection.append(search, listWrap, applyPlugins)
  body.append(pluginSection)

  // ── themes ───────────────────────────────────────────────────────────────
  // `info.themes` = WHICH theme plugins are LOADED (multi-select; TW's own
  // default is [vanilla, snowwhite]); `$:/theme` = the ACTIVE one (single).
  // Two controls per theme: ☑ 加载 (multi) + ◉ 活动 (single, auto-added to the
  // loaded set on apply). The host computes the dependency closure (heavier →
  // vanilla+snowwhite+heavier) and writes $:/theme.
  const themeSection = make('section', 'dsh-tw-settings-section')
  themeSection.append(make('h3', 'dsh-tw-settings-h', '主题管理（自带主题）'))
  const themeHint = make('div', 'dsh-tw-settings-muted', '「加载」= TW 里可用的主题（可多选，依赖链自动带上，如 heavier 会带 snowwhite+vanilla）；「活动」= 当前视觉主题（单选，自动加入加载集）。应用后重启 TW。')
  const themeHead = make('div', 'dsh-tw-settings-row dsh-tw-settings-head')
  themeHead.append(
    make('span', 'dsh-tw-settings-col', '加载'),
    make('span', 'dsh-tw-settings-col', '活动'),
    make('span', 'dsh-tw-settings-name', '主题'),
  )
  const themeList = info?.themes ?? []
  let activeThemeName = themeList.length > 0 ? themeList[themeList.length - 1] : 'tiddlywiki/vanilla'
  const themeWrap = make('div', 'dsh-tw-settings-list')
  for (const theme of themes) {
    const load = make('input', 'dsh-tw-settings-check')
    load.type = 'checkbox'
    load.checked = loadedThemes.has(theme.name)
    load.title = '加载该主题'
    load.addEventListener('change', () => {
      if (load.checked) loadedThemes.add(theme.name)
      else loadedThemes.delete(theme.name)
    })
    const act = make('input', 'dsh-tw-settings-check')
    act.type = 'radio'
    act.name = 'dsh-tw-active-theme'
    act.checked = theme.name === activeThemeName
    act.title = '设为活动主题'
    act.addEventListener('change', () => {
      if (act.checked) activeThemeName = theme.name
    })
    const name = make('span', 'dsh-tw-settings-name', theme.label)
    name.title = theme.name
    const desc = make('span', 'dsh-tw-settings-muted', theme.description || theme.name)
    const row = make('div', 'dsh-tw-settings-row dsh-tw-settings-plugin')
    row.append(load, act, name, desc)
    themeWrap.append(row)
  }
  const applyThemes = make('button', 'dsh-tw-settings-btn dsh-tw-settings-primary', '应用主题（重启 TW）')
  applyThemes.type = 'button'
  applyThemes.addEventListener('click', () => {
    applyThemes.disabled = true
    void (async () => {
      try {
        await fetchJson(INFO_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ themes: [...loadedThemes], themeActive: activeThemeName }),
        })
        toast('主题已应用，TW 已重启')
        void refresh()
      } catch (err) {
        toast(`应用失败：${err instanceof Error ? err.message : String(err)}`)
        applyThemes.disabled = false
      }
    })()
  })
  themeSection.append(themeHint, themeHead, themeWrap, applyThemes)
  body.append(themeSection)

  // ── languages (bundled, offline — enable → restart TW) ──────────────────
  const langSection = make('section', 'dsh-tw-settings-section')
  langSection.append(make('h3', 'dsh-tw-settings-h', '语言管理（自带官方语言包）'))
  const langHint = make('div', 'dsh-tw-settings-muted', '勾选启用语言插件并重启 TW；如中文请选 zh-Hans（简体）或 zh-CN。')
  const langWrap = make('div', 'dsh-tw-settings-list')
  for (const lang of languages) {
    const input = make('input', 'dsh-tw-settings-check')
    input.type = 'checkbox'
    input.checked = activeLanguages.has(lang.name)
    input.addEventListener('change', () => {
      if (input.checked) activeLanguages.add(lang.name)
      else activeLanguages.delete(lang.name)
    })
    const label = make('label', 'dsh-tw-settings-row dsh-tw-settings-plugin')
    const name = make('span', 'dsh-tw-settings-name', lang.label)
    name.title = lang.name
    const desc = make('span', 'dsh-tw-settings-muted', lang.description || lang.name)
    label.append(input, name, desc)
    langWrap.append(label)
  }
  const applyLangs = make('button', 'dsh-tw-settings-btn dsh-tw-settings-primary', '应用语言（重启 TW）')
  applyLangs.type = 'button'
  applyLangs.addEventListener('click', () => {
    applyLangs.disabled = true
    void (async () => {
      try {
        await fetchJson(INFO_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ languages: [...activeLanguages] }) })
        toast('语言已应用，TW 已重启')
        void refresh()
      } catch (err) {
        toast(`应用失败：${err instanceof Error ? err.message : String(err)}`)
        applyLangs.disabled = false
      }
    })()
  })
  langSection.append(langHint, langWrap, applyLangs)
  body.append(langSection)
}

/**
 * 知识库位置 section (v0.22.0): show the folder the plugin is serving, how that
 * was decided, and let the user switch to another folder at runtime.
 *
 * The choice lives in a pointer file OUTSIDE every wiki (host/wiki-location.ts
 * explains why it cannot live in the wiki's own config tiddler). Switching
 * stops and restarts the TW child in place — a few seconds, and it can fail
 * (in which case the host rolls back and says so).
 */
function renderWikiLocationSection(body: HTMLElement, isDisposed: () => boolean, refresh: () => Promise<void>): void {
  const section = make('section', 'dsh-tw-settings-section')
  section.append(make('h3', 'dsh-tw-settings-h', '知识库位置（可切换）'))
  const status = make('div', 'dsh-tw-settings-muted', '读取中…')
  const sourceLine = make('div', 'dsh-tw-settings-muted')
  const stateLine = make('div', 'dsh-tw-settings-muted')
  const warn = make('div', 'dsh-tw-settings-muted')
  const rootInput = make('input', 'dsh-tw-settings-input')
  const nameInput = make('input', 'dsh-tw-settings-input')
  rootInput.placeholder = '绝对路径，如 D:\\notes 或 $DSH_HOME/tiddlywiki'
  nameInput.placeholder = '文件夹名（默认 main；填 . 表示直接用上面这个目录）'
  const rootWrap = make('label', 'dsh-tw-settings-field')
  rootWrap.append(make('span', 'dsh-tw-settings-label', '根目录（wikiRoot）'), rootInput)
  const nameWrap = make('label', 'dsh-tw-settings-field')
  nameWrap.append(make('span', 'dsh-tw-settings-label', '文件夹名（wiki）'), nameInput)
  const switchBtn = make('button', 'dsh-tw-settings-btn dsh-tw-settings-primary', '切换到这个位置')
  switchBtn.type = 'button'
  const resetBtn = make('button', 'dsh-tw-settings-btn', '恢复为配置默认')
  resetBtn.type = 'button'
  const row = make('div', 'dsh-tw-settings-row')
  row.append(switchBtn, resetBtn)
  const candidates = make('div', 'dsh-tw-settings-row dsh-tw-settings-candidates')
  const hint = make('div', 'dsh-tw-settings-muted', '切换会停掉并就地重启 TW 子进程（几秒）；新目录若还没有 tiddlywiki.info，插件会自动 `--init server` 初始化一个全新知识库。选中的位置会记在 $DSH_HOME 下的指针文件里（不进 wiki），可用「恢复为配置默认」清除。')

  const setBusy = (busy: boolean, label: string): void => {
    switchBtn.disabled = busy
    resetBtn.disabled = busy
    switchBtn.textContent = busy ? label : '切换到这个位置'
  }

  const load = async (): Promise<void> => {
    if (isDisposed()) return
    try {
      const data = await fetchJson<WikiLocationView>(WIKI_LOCATION_ENDPOINT)
      if (isDisposed()) return
      if (data.ok !== true) throw new Error(data.error ?? '获取失败')
      const current = data.current ?? {}
      status.textContent = `当前：${current.path ?? '(未知)'}`
      const sourceText = current.source === 'state'
        ? '来源：指针文件（在设置页切换过）'
        : current.source === 'config'
          ? '来源：cordis 配置（config.wikiRoot / config.wiki）'
          : '来源：默认值（$DSH_HOME/tiddlywiki + main）'
      sourceLine.textContent = `${sourceText} · 配置默认：${data.default?.path ?? '(未知)'}`
      stateLine.textContent = data.stateFile !== undefined ? `指针文件：${data.stateFile}（不存在＝使用配置默认）` : ''
      warn.textContent = data.error !== undefined ? `⚠️ ${data.error}` : ''
      if (rootInput.value.length === 0 && typeof current.root === 'string') rootInput.value = current.root
      if (nameInput.value.length === 0 && typeof current.name === 'string') nameInput.value = current.name
      candidates.replaceChildren()
      const names = data.candidates ?? []
      if (names.length > 0) {
        candidates.append(make('span', 'dsh-tw-settings-label', '同目录下可选的 wiki：'))
        for (const name of names) {
          const chip = make('button', 'dsh-tw-settings-btn dsh-tw-settings-chipbtn', name === '.' ? '(根目录本身)' : name)
          chip.type = 'button'
          chip.title = `填入文件夹名「${name}」`
          chip.addEventListener('click', () => { nameInput.value = name })
          candidates.append(chip)
        }
      }
    } catch (err) {
      if (isDisposed()) return
      status.textContent = `读取位置失败：${err instanceof Error ? err.message : String(err)}`
    }
  }

  switchBtn.addEventListener('click', () => {
    const root = rootInput.value.trim()
    const name = nameInput.value.trim().length > 0 ? nameInput.value.trim() : 'main'
    if (root.length === 0) {
      toast('请先填写根目录（绝对路径）')
      return
    }
    if (!window.confirm(`切换知识库到：\n${root}\\${name}\n\n会停止并重启 TW 子进程；当前对话/工具随后读写的是新知识库。确定继续？`)) return
    setBusy(true, '切换中…（重启 TW）')
    void (async () => {
      try {
        const data = await fetchJson<{ ok?: boolean; error?: string; warning?: string; path?: string; rolledBack?: boolean }>(WIKI_SWITCH_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ root, name }),
          signal: AbortSignal.timeout(120_000),
        })
        if (data.warning !== undefined) toast(`已切换到 ${data.path ?? ''}（注意：${data.warning}）`)
        else toast(`已切换到 ${data.path ?? ''}`)
        invalidateUiConfig()
        await load()
        await refresh()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast(`切换失败：${message}`)
        await load()
      } finally {
        setBusy(false, '')
      }
    })()
  })

  resetBtn.addEventListener('click', () => {
    if (!window.confirm('恢复为配置默认位置？会删除位置指针文件，并（必要时）切回配置里的知识库。')) return
    setBusy(true, '切换中…（重启 TW）')
    void (async () => {
      try {
        const data = await fetchJson<{ ok?: boolean; error?: string; warning?: string; path?: string }>(WIKI_RESET_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(120_000),
        })
        toast(data.warning !== undefined ? `已恢复默认（注意：${data.warning}）` : `已恢复为配置默认：${data.path ?? ''}`)
        invalidateUiConfig()
        await load()
        await refresh()
      } catch (err) {
        toast(`恢复失败：${err instanceof Error ? err.message : String(err)}`)
        await load()
      } finally {
        setBusy(false, '')
      }
    })()
  })

  section.append(status, sourceLine, stateLine, rootWrap, nameWrap, row, candidates, warn, hint)
  body.append(section)
  void load()
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
function renderSeedsSection(body: HTMLElement, isDisposed: () => boolean): void {
  const section = make('section', 'dsh-tw-settings-section')
  section.append(make('h3', 'dsh-tw-settings-h', '初始化（一次性预置）'))
  const hint = make('div', 'dsh-tw-settings-muted', '这些是插件与 dsh 联动、需要在 wiki 里预置的 tiddler/配置。「发送给 Agent 按钮」和「TW 前端 API 基址」是功能必需项，启动时自动写入（只写缺失，不覆盖你的改动）；其余为可选项，默认不自动写入、也不会强绑定——需要时点「重新初始化」写入，不想要了可随时「反初始化」移除。')
  const wrap = make('div', 'dsh-tw-settings-list')
  const statusLine = make('div', 'dsh-tw-settings-muted')

  const load = async (): Promise<void> => {
    // 与 refresh() 相同的卸载守卫：本函数由组件挂载时触发、也可能在卸载后由
    // 按钮回调的 await 之后调用，晚到的响应不得再 wrap.replaceChildren()。
    if (isDisposed()) return
    try {
      const data = await fetchJson<{ ok?: boolean; items?: SeedItem[]; error?: string }>(SEEDS_ENDPOINT)
      if (isDisposed()) return
      if (data.ok !== true || !Array.isArray(data.items)) throw new Error(data.error ?? '获取失败')
      wrap.replaceChildren()
      let presentCount = 0
      let removableCount = 0
      for (const item of data.items) {
        if (item.present) presentCount += 1
        if (item.removable) removableCount += 1
        const dot = make('span', 'dsh-tw-settings-chip', item.present ? '✓' : '✗')
        dot.dataset.state = item.present ? 'ok' : 'missing'
        dot.title = item.present ? '已存在' : '缺失'
        const title = make('span', 'dsh-tw-settings-name', item.title)
        title.title = item.id
        const desc = make('span', 'dsh-tw-settings-muted', item.detail ?? item.description)
        // v0.22.0: the marker records content hashes, so we can say whether the
        // BUILT-IN moved on and whether the user edited their copy — and warn
        // before a 「重新初始化」 overwrites local edits.
        const updateChip = item.updateAvailable === true
          ? make('span', 'dsh-tw-settings-chip', '⬆ 有更新')
          : undefined
        if (updateChip !== undefined) {
          updateChip.dataset.state = 'update'
          updateChip.title = '内置内容在本 wiki 预置之后更新过，可点「重新初始化」取用'
        }
        const modifiedChip = item.userModified === true
          ? make('span', 'dsh-tw-settings-chip', '✏️ 本地已修改')
          : undefined
        if (modifiedChip !== undefined) {
          modifiedChip.dataset.state = 'missing'
          modifiedChip.title = '这篇是你的内容：重新初始化会覆盖它'
        }
        const btn = make('button', 'dsh-tw-settings-btn', item.updateAvailable === true ? '更新到内置版本' : '重新初始化')
        btn.type = 'button'
        btn.title = `强制重写「${item.title}」的内置内容（会覆盖当前 tiddler）`
        btn.addEventListener('click', () => {
          if (item.updateAvailable === true) {
            const warning = item.userModified === true
              ? `「${item.title}」有你的本地修改，更新会覆盖它。`
              : item.userModified === undefined
                ? `无法确认「${item.title}」是否被你编辑过（旧格式标记），更新可能覆盖你的改动。`
                : ''
            if (!window.confirm(`${warning}${warning.length > 0 ? '\n\n' : ''}用内置版本覆盖？`)) return
          }
          btn.disabled = true
          btn.textContent = '执行中…'
          void (async () => {
            try {
              const res = await fetch(SEEDS_RUN_ENDPOINT, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: item.id, force: true }),
                signal: AbortSignal.timeout(30_000),
              })
              const payload = (await res.json().catch(() => null)) as { ok?: boolean; results?: Array<{ id?: string; detail?: string; error?: string }>; error?: string } | null
              if (!res.ok || payload?.ok !== true) {
                toast(`重新初始化失败：${payload?.error ?? payload?.results?.[0]?.error ?? `HTTP ${res.status}`}`)
              } else {
                toast(`已重新初始化「${item.title}」`)
              }
              void load()
            } catch (err) {
              toast(`重新初始化失败：${err instanceof Error ? err.message : String(err)}`)
            } finally {
              btn.disabled = false
              btn.textContent = item.updateAvailable === true ? '更新到内置版本' : '重新初始化'
            }
          })()
        })
        const row = make('div', 'dsh-tw-settings-row dsh-tw-settings-plugin')
        row.append(dot, title)
        if (updateChip !== undefined) row.append(updateChip)
        if (modifiedChip !== undefined) row.append(modifiedChip)
        row.append(desc, btn)
        if (item.removable) {
          const rm = make('button', 'dsh-tw-settings-btn dsh-tw-settings-danger', '反初始化')
          rm.type = 'button'
          rm.title = `移除「${item.title}」写入的 tiddler 与 marker（恢复未初始化状态）`
          rm.addEventListener('click', () => {
            if (!window.confirm(`确定反初始化「${item.title}」？将删除它写入的 tiddler（含其一次性 marker），需要时可用「重新初始化」恢复。`)) return
            rm.disabled = true
            rm.textContent = '移除中…'
            void (async () => {
              try {
                const res = await fetch(SEEDS_REMOVE_ENDPOINT, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ id: item.id }),
                  signal: AbortSignal.timeout(30_000),
                })
                const payload = (await res.json().catch(() => null)) as { ok?: boolean; results?: Array<{ id?: string; detail?: string; error?: string }>; error?: string } | null
                if (!res.ok || payload?.ok !== true) {
                  toast(`反初始化失败：${payload?.error ?? payload?.results?.[0]?.error ?? `HTTP ${res.status}`}`)
                } else {
                  toast(`已反初始化「${item.title}」`)
                }
                void load()
              } catch (err) {
                toast(`反初始化失败：${err instanceof Error ? err.message : String(err)}`)
              } finally {
                rm.disabled = false
                rm.textContent = '反初始化'
              }
            })()
          })
          row.append(rm)
        }
        wrap.append(row)
      }
      statusLine.textContent = `共 ${data.items.length} 项，${presentCount} 项已就绪；可移除 ${removableCount} 项`
    } catch (err) {
      if (isDisposed()) return
      statusLine.textContent = `加载初始化状态失败：${err instanceof Error ? err.message : String(err)}`
    }
  }

  const runAll = make('button', 'dsh-tw-settings-btn dsh-tw-settings-primary', '全部重新初始化')
  runAll.type = 'button'
  runAll.title = '强制重写所有一次性预置内容（含可选 seed，会覆盖当前 tiddler/配置）'
  runAll.addEventListener('click', () => {
    runAll.disabled = true
    runAll.textContent = '执行中…'
    void (async () => {
      try {
        const res = await fetch(SEEDS_RUN_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ force: true }),
          signal: AbortSignal.timeout(60_000),
        })
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
        if (!res.ok || payload?.ok !== true) toast(`重新初始化失败：${payload?.error ?? `HTTP ${res.status}`}`)
        else toast('全部已重新初始化')
        void load()
      } catch (err) {
        toast(`重新初始化失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        runAll.disabled = false
        runAll.textContent = '全部重新初始化'
      }
    })()
  })

  const removeAll = make('button', 'dsh-tw-settings-btn dsh-tw-settings-danger', '全部反初始化')
  removeAll.type = 'button'
  removeAll.title = '移除所有可选 seed 写入的 tiddler 与 marker（功能必需项保留）'
  removeAll.addEventListener('click', () => {
    if (!window.confirm('确定全部反初始化？将删除所有可选 seed 写入的 tiddler（含一次性 marker）。功能必需项（发送给 Agent 按钮 / TW 前端 API 基址）会保留。')) return
    removeAll.disabled = true
    removeAll.textContent = '移除中…'
    void (async () => {
      try {
        const res = await fetch(SEEDS_REMOVE_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(60_000),
        })
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
        if (!res.ok || payload?.ok !== true) toast(`反初始化失败：${payload?.error ?? `HTTP ${res.status}`}`)
        else toast('全部可选 seed 已反初始化')
        void load()
      } catch (err) {
        toast(`反初始化失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        removeAll.disabled = false
        removeAll.textContent = '全部反初始化'
      }
    })()
  })

  section.append(hint, statusLine, wrap, runAll, removeAll)
  body.append(section)
  void load()
}

/** Per-mount memory of the config section: the DOM plus the server-side config
 *  signature it was built from, so an unchanged refresh never rebuilds the
 *  inputs (and never discards the user's unsaved edits). */
interface ConfigRenderState {
  signature?: string
  host?: HTMLElement
}

function renderMain(body: HTMLElement, state: AdminState, refresh: () => Promise<void>, isDisposed: () => boolean, configState: ConfigRenderState): void {
  body.replaceChildren()
  // Config section: only rebuild when the server-side config actually changed.
  // Otherwise the status row's 同步/重启 buttons (and the catalog apply buttons)
  // call refresh() and would silently discard whatever the user had typed into
  // a field (v0.20.0). The host element is re-appended as-is, so its inputs and
  // their pending values survive.
  const signature = JSON.stringify(state.config ?? {})
  if (configState.host === undefined || configState.signature !== signature) {
    const host = make('div', 'dsh-tw-settings-confighost')
    renderConfigSection(host, state.config ?? {}, refresh)
    configState.host = host
    configState.signature = signature
  }
  body.append(configState.host)
  renderWikiLocationSection(body, isDisposed, refresh)
  renderCatalogSection(body, state.info, state.catalog, refresh)
  renderSeedsSection(body, isDisposed)
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

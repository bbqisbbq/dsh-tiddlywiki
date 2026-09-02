/**
 * Settings-page half (design doc §13, config panel): a pure-DOM page mounted
 * inside a `settings.section` React wrapper. Everything talks to the host
 * admin routes — same-origin JSON, no client services beyond `slots`:
 *
 *   GET  /dsh-tiddlywiki/admin/state    current info + catalog + config
 *   POST /dsh-tiddlywiki/admin/info     { plugins?, themes? } → restart TW
 *   POST /dsh-tiddlywiki/admin/config   { ...patch }           → persist
 *   POST /dsh-tiddlywiki/admin/restart  restart the TW child
 *
 * Sections:
 *   1. 状态/重启      TW 运行状态 + git 概览 + 重启按钮
 *   2. 常规配置       note.tag / git.* / uiLanguage（改了什么保存什么）
 *   3. 插件管理       自带官方插件勾选（可搜索）→ 应用并重启 TW
 *   4. 主题管理       自带主题单选 → 应用并重启 TW
 *
 * @module dsh-tiddlywiki/client/settings-page
 */
import * as React from 'react'
import { toast } from './toast.ts'

const STATE_ENDPOINT = '/dsh-tiddlywiki/admin/state'
const INFO_ENDPOINT = '/dsh-tiddlywiki/admin/info'
const CONFIG_ENDPOINT = '/dsh-tiddlywiki/admin/config'
const RESTART_ENDPOINT = '/dsh-tiddlywiki/admin/restart'

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
  input: HTMLInputElement
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

  const refresh = async (): Promise<void> => {
    try {
      const state = await fetchJson<AdminState>(STATE_ENDPOINT)
      if (disposed) return
      renderStatus(statusRow, state, refresh)
      renderMain(body, state, refresh)
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
  row.append(chip, label, restart)
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
    const wrap = make('label', 'dsh-tw-settings-field')
    wrap.append(make('span', 'dsh-tw-settings-label', label), input)
    fields.push({ key, input, initial, read: () => Number(input.value) || initial, changed: () => (Number(input.value) || initial) !== initial })
    section.append(wrap)
  }

  textField('note.tag', '快速笔记默认 tag', typeof note.tag === 'string' ? note.tag : 'inbox')
  checkField('git.autoCommit', '自动 commit（防抖）', git.autoCommit !== false)
  numField('git.debounceMs', '自动 commit 防抖(ms)', typeof git.debounceMs === 'number' ? git.debounceMs : 60_000)
  textField('git.remote', 'git 远端（空=仅本地）', typeof git.remote === 'string' ? git.remote : '')
  textField('git.branch', 'git 分支', typeof git.branch === 'string' ? git.branch : 'main')
  checkField('ui.showQuickNote', '显示「快速笔记」悬浮按钮', ui.showQuickNote !== false)
  checkField('ui.sidebarLeftCss', '侧边栏移左 CSS（随启动补丁还原被删除的样式）', ui.sidebarLeftCss !== false)
  // 界面语言在下方「语言管理」区块设置（config 的 uiLanguage 仅供启动时自动应用）。

  const save = make('button', 'dsh-tw-settings-btn dsh-tw-settings-primary', '保存配置')
  save.type = 'button'
  save.addEventListener('click', () => {
    save.disabled = true
    void (async () => {
      const patch: Record<string, unknown> = {}
      for (const field of fields) {
        if (!field.changed()) continue
        const parts = field.key.split('.')
        if (parts.length === 1) {
          const key = parts[0]
          if (key !== undefined) patch[key] = field.read()
        } else {
          const [top, rest] = parts as [string, string]
          const obj = (patch[top] ?? {}) as Record<string, unknown>
          obj[rest] = field.read()
          patch[top] = obj
        }
      }
      try {
        await fetchJson(CONFIG_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
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

function renderMain(body: HTMLElement, state: AdminState, refresh: () => Promise<void>): void {
  body.replaceChildren()
  renderConfigSection(body, state.config ?? {}, refresh)
  renderCatalogSection(body, state.info, state.catalog, refresh)
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

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
  describeSyncResult,
  type SyncResultPayload,
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

/**
 * 红色解释横幅。页面里没有对应 CSS 类（host 注入的样式表不归本文件管），内联样式
 * 是与宿主既定的视觉约定；抽成函数是为了两处横幅（配置未生效 / 保存被拒）长得一致。
 */
function makeErrorBanner(text: string): HTMLDivElement {
  const banner = make('div', 'dsh-tw-settings-banner')
  banner.dataset.tone = 'error'
  banner.setAttribute('style', 'border:1px solid #c0392b;background:#fdecea;color:#8c1c13;border-radius:6px;padding:10px 12px;margin:0 0 12px;font-size:12px;line-height:1.6;white-space:pre-wrap;')
  banner.textContent = text
  return banner
}

/**
 * Same-origin JSON fetch with a default timeout and a JSON error body.
 *
 * ⚠️ The caller's `signal` must WIN (v0.22.8). This used to be
 * `fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })` — spreading
 * `init` first and then hardcoding the signal, so every caller-supplied budget
 * was silently discarded. 知识库切换 / 恢复默认 pass 120s (the host stops TW,
 * may `--init server`, bootstraps and restarts it — v0.22.5 documents 44s+
 * cold starts), so the browser aborted at 15s and toasted「切换失败」 while the
 * host kept going and DID switch; the same 15s cap hit the 重启 TW button.
 */
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) })
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
  initial: string | boolean | number
  read: () => string | boolean | number
  changed: () => boolean
  /**
   * 数值字段专用：返回「当前输入不能提交」的原因，`undefined` = 可用。
   * 保存前用它拦截 —— 宿主对越界/非数字是静默回落（bridge.port 掉回 8618、
   * readyTimeoutMs 夹到 5000–600000），提交等于让页面显示值与真正生效值分家。
   */
  invalid?: () => string | undefined
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
  /** 首屏是否已成功渲染过内容：决定占位提示与失败时能不能清 body。 */
  let rendered = false

  const refresh = async (): Promise<void> => {
    // 首屏先给占位（v0.24.x）：以前 await 期间什么都不画，整块白屏看起来像插件坏了。
    if (!rendered) body.replaceChildren(make('div', 'dsh-tw-settings-muted', '加载中…'))
    try {
      const state = await fetchJson<AdminState>(STATE_ENDPOINT)
      if (disposed) return
      rendered = true
      loadError.hidden = true
      loadError.replaceChildren()
      renderStatus(statusRow, state, refresh)
      renderMain(body, state, refresh, () => disposed, configState, catalogPending)
    } catch (err) {
      if (disposed) return
      // 不再 body.replaceChildren() / statusRow.replaceChildren()：那会把已经渲染出来的
      // 表单节点连同用户的输入一起摘掉。首屏（还没有任何内容）时把「加载中…」换成实话。
      if (!rendered) body.replaceChildren(make('div', 'dsh-tw-settings-muted', '配置尚未加载。'))
      const retry = make('button', 'dsh-tw-settings-btn', '重试')
      retry.type = 'button'
      retry.addEventListener('click', () => { void refresh() })
      loadError.replaceChildren(
        make('span', undefined, `加载配置失败：${err instanceof Error ? err.message : String(err)} `),
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
      ? `⚠️ 冲突未解决（${state.git.conflict.files.length} 个文件，已阻止提交）`
      : (state.git?.dirty === true ? '有未提交改动' : ''),
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
        const payload = (await res.json().catch(() => null)) as SyncResultPayload | null
        const result = describeSyncResult(payload, res.status)
        toast(result.ok ? `同步完成：${result.message}` : `同步失败：${result.message}`)
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
        // 120s 是显式的：宿主 /admin/restart 会等 TW 就绪才回包，软窗口默认 60s
        // （大知识库冷启动更久，v0.22.5 记录过 44s+），而 fetchJson 默认只给 15s ——
        // 于是宿主重启成功、前端却报「重启失败」。同一原因也命中过知识库切换。
        await fetchJson(RESTART_ENDPOINT, { method: 'POST', signal: AbortSignal.timeout(120_000) })
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
function renderConfigSection(body: HTMLElement, config: Record<string, unknown>, refresh: () => Promise<void>, configState: ConfigRenderState): void {
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
    fields.push({ key, initial, read: () => input.value.trim(), changed: () => input.value.trim() !== initial })
    section.append(wrap)
  }
  /**
   * 共享口令输入（v0.24.x）：`type=password` + 👁 显隐切换。
   * 为什么不能沿用 textField：token 的 ******** mask 只防「保存时把密文覆盖成星号」，
   * 不防「屏幕共享 / 录屏 / 背后有人时明文可见」—— 掩码值本身仍然是个可见的明文输入框。
   */
  const tokenField = (key: string, label: string, initial: string): void => {
    const input = make('input', 'dsh-tw-settings-input')
    input.type = 'password'
    input.value = initial
    input.autocomplete = 'off'
    const toggle = make('button', 'dsh-tw-settings-btn dsh-tw-settings-chipbtn', '👁')
    toggle.type = 'button'
    toggle.title = '显示 / 隐藏'
    toggle.setAttribute('aria-label', '显示 / 隐藏')
    toggle.addEventListener('click', (event) => {
      // 按钮位于 <label> 内：阻断 label 的默认「转发点击给控件」，避免切明文时输入框被重聚焦。
      event.preventDefault()
      const hidden = input.type === 'password'
      input.type = hidden ? 'text' : 'password'
      toggle.textContent = hidden ? '🙈' : '👁'
    })
    const wrap = make('label', 'dsh-tw-settings-field')
    wrap.append(make('span', 'dsh-tw-settings-label', label), input, toggle)
    fields.push({ key, initial, read: () => input.value.trim(), changed: () => input.value.trim() !== initial })
    section.append(wrap)
  }
  const checkField = (key: string, label: string, initial: boolean): HTMLInputElement => {
    const input = make('input', 'dsh-tw-settings-check')
    input.type = 'checkbox'
    input.checked = initial
    const wrap = make('label', 'dsh-tw-settings-field dsh-tw-settings-field-check')
    wrap.append(input, make('span', 'dsh-tw-settings-label', label))
    fields.push({ key, initial, read: () => input.checked, changed: () => input.checked !== initial })
    section.append(wrap)
    return input
  }
  /**
   * 数值字段（v0.24.x：加范围校验 + 字段旁提示）。
   *
   * 旧写法把非法输入静默回落成 `initial`，于是 `changed()` 变 false —— 用户看到自己填的
   * 值还在框里，以为保存了，其实一个字节都没提交；而越界值（宿主只做夹取/回落：bridge.port
   * 掉回 8618、readyTimeoutMs 夹到 5000–600000）即使提交了，页面回显也与真正生效值不符。
   * 现在：非法输入原样留着 + 红字提示，`invalid` 让保存直接拒绝（见保存按钮）。
   */
  const numField = (key: string, label: string, initial: number, range?: { min?: number; max?: number; step?: number; integer?: boolean }): void => {
    const input = make('input', 'dsh-tw-settings-input')
    input.type = 'number'
    input.value = String(initial)
    // 与下面校验同一组边界的浏览器侧约束：数字框的上下箭头不会越界。
    if (range?.min !== undefined) input.min = String(range.min)
    if (range?.max !== undefined) input.max = String(range.max)
    if (range?.step !== undefined) input.step = String(range.step)
    const hint = make('div', 'dsh-tw-settings-error')
    hint.hidden = true
    const violation = (): string | undefined => {
      const raw = input.value.trim()
      if (raw.length === 0) return '不能为空'
      const parsed = Number(raw)
      if (!Number.isFinite(parsed)) return '请输入数字'
      if (range?.integer === true && !Number.isInteger(parsed)) return '必须是整数'
      if (range?.min !== undefined && parsed < range.min) return `不能小于 ${range.min}`
      if (range?.max !== undefined && parsed > range.max) return `不能大于 ${range.max}`
      return undefined
    }
    const sync = (): void => {
      const bad = violation()
      hint.textContent = bad === undefined ? '' : `⚠️ ${bad}（保存会被拒绝）`
      hint.hidden = bad === undefined
      if (bad === undefined) input.removeAttribute('aria-invalid')
      else input.setAttribute('aria-invalid', 'true')
    }
    input.addEventListener('input', sync)
    // 非法时原样回传字符串（而不是 initial）：不静默改掉用户在框里看到的东西；
    // 真要落盘也会先被 invalid() 拦下，不会发出去。
    const read = (): number | string => {
      const raw = input.value.trim()
      const parsed = Number(raw)
      return raw.length === 0 || !Number.isFinite(parsed) ? raw : parsed
    }
    const wrap = make('label', 'dsh-tw-settings-field')
    wrap.append(make('span', 'dsh-tw-settings-label', label), input, hint)
    fields.push({ key, initial, read, changed: () => read() !== initial, invalid: violation })
    // 先跑一次：config tiddler 里本来就存着越界值（宿主已静默夹取）时，进页面就该看见
    // 提示，而不是等用户改动过才亮。
    sync()
    section.append(wrap)
  }
  const selectField = (key: string, label: string, initial: string, options: Array<{ value: string; label: string }>): HTMLSelectElement => {
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
    fields.push({ key, initial, read: () => select.value, changed: () => select.value !== initial })
    section.append(wrap)
    return select
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
    fields.push({ key, initial, read: () => input.value.trim(), changed: () => input.value.trim() !== initial })
    section.append(wrap)
    return input
  }

  textField('note.tag', '快速笔记默认 tag', typeof note.tag === 'string' ? note.tag : 'inbox')
  // 工作区标记（v0.24.0）：新建笔记自动带 ws/<项目名> 标签 + workspace 字段，
  // 项目名取自会话工作目录。关掉只是不做标记，不影响任何写入。
  checkField('note.workspaceMark', '新建笔记自动标工作区（ws/<项目名> 标签 + workspace 字段，取自当前会话工作目录）', note.workspaceMark !== false)
  checkField('git.autoCommit', '自动 commit（防抖）', git.autoCommit !== false)
  // v0.25.0：范围与宿主 config.ts 的 NUMBER_CONFIG_RANGES 对齐（超范围的补丁会被
  // 宿主夹取，页面必须让用户看见真实边界，别再出现「回显 ≠ 生效」）。
  numField('git.debounceMs', '自动 commit 防抖(ms；范围 0–3600000)', typeof git.debounceMs === 'number' ? git.debounceMs : 60_000, { min: 0, max: 3_600_000, step: 1_000, integer: true })
  textField('git.remote', 'git 远端（空=仅本地；保存后即时生效，但**清空不会删除已配置的 origin**，需要时请用 git 命令处理）', typeof git.remote === 'string' ? git.remote : '')
  textField('git.branch', 'git 分支（**只在仓库首次初始化时生效**；已有仓库请用 git 命令改分支——上面的状态行显示的是真实分支）', typeof git.branch === 'string' ? git.branch : 'main')
  // 启动就绪窗口（v0.22.5）：大知识库冷启动（数千条目）可能 40s+。窗口内只等，
  // 超过它只写日志，硬上限 = 3× 仍无响应才判失败。改动对下一次启动/重启生效。
  const startup = (config.startup ?? {}) as Record<string, unknown>
  numField('startup.readyTimeoutMs', 'TW 启动就绪等待(ms；默认 60000，范围 5000–600000，超时上限为其 3 倍，对下次启动/重启生效)', typeof startup.readyTimeoutMs === 'number' && startup.readyTimeoutMs > 0 ? startup.readyTimeoutMs : 60_000, { min: 5_000, max: 600_000, step: 1_000 })
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
  tokenField('ui.sendToAgent.token', '共享 token（非空时路由校验 x-send-to-agent-token 头；已设置时显示为 ********，原样保存=不改，清空=删除）', typeof sendToAgent.token === 'string' ? sendToAgent.token : '')
  const allArticles = (ui.allArticles ?? {}) as Record<string, unknown>
  // 1–200 是「所有文章」分页的有效范围（超出后分页会失序），宿主不会替我们夹取，所以在这里挡住。
  numField('ui.allArticles.pageSize', '「所有文章」每页条数（1–200）', typeof allArticles.pageSize === 'number' ? allArticles.pageSize : 10, { min: 1, max: 200, step: 1, integer: true })

  // ── 可选功能：微信公众号发布（v0.23.0）────────────────────────────────────
  // 默认关闭：这项能力需要**额外安装**（opencli + 浏览器扩展，见
  // docs/wechat-publish-setup.md），插件本体不含它。关闭时不注入任何发布相关
  // 提示词、也不自动写「发布元数据规范」文档，避免打扰不用它的用户。
  section.append(make('h3', 'dsh-tw-settings-h', '可选功能：微信公众号发布'))
  section.append(make(
    'div',
    'dsh-tw-settings-muted',
    '把 wiki 笔记一键发到公众号草稿箱（可选点发表）。**需要额外安装**：opencli 与 Browser Bridge 浏览器扩展，'
    + '并让浏览器登录 mp.weixin.qq.com；adapter 在本仓库 tools/wechat/，安装与排错见 docs/wechat-publish-setup.md。'
    + '不安装／不开启它，插件其他功能完全不受影响。开启后：注入提示词会多一条「发布前先读发布元数据规范」的约定，'
    + '并在启动时把「发布元数据规范」与「微信公众号发布指南」（安装/换机还原步骤，等于仓库 docs/wechat-publish-setup.md）'
    + '两篇文档写进 wiki（同名不覆盖）。',
  ))
  const wechat = (config.wechat ?? {}) as Record<string, unknown>
  const wechatEnabled = checkField('wechat.enabled', '启用微信公众号发布（默认关；需先按 docs/wechat-publish-setup.md 安装 opencli + 浏览器扩展）', wechat.enabled === true)
  // 以下四项 v0.23.3 宿主就支持，但设置页此前只暴露了 enabled —— 于是 token 这个安全开关
  // 只能手改 wiki 里的 config tiddler。token 非空时 `/wechat/*` 要求 x-wechat-publish-token
  // 头，防的是「任何能打开 DSH Web UI 的人都能用你本机 Chrome 对外发文」。
  textField('wechat.command', 'opencli 命令（默认 opencli；用别名或绝对路径时填这里。仅在启用微信发布时生效）', typeof wechat.command === 'string' && wechat.command.trim().length > 0 ? wechat.command.trim() : 'opencli')
  selectField('wechat.adapter', '发布适配器（仅在启用微信发布时生效）', wechat.adapter === 'publish-note-imgs' ? 'publish-note-imgs' : 'publish-note', [
    { value: 'publish-note', label: 'publish-note（默认）：图文排版，封面单图' },
    { value: 'publish-note-imgs', label: 'publish-note-imgs：正文内嵌图全部上传 CDN（需先重跑 install-wechat-adapters.mjs）' },
  ])
  tokenField('wechat.token', '发布 token（非空时 /wechat/* 校验 x-wechat-publish-token 头，强烈建议设置，否则任何能打开本页的人都能替你发文；已设置时显示为 ********，原样保存=不改，清空=删除。仅在启用微信发布时生效）', typeof wechat.token === 'string' ? wechat.token : '')
  textField('wechat.dsn', '渲染基址 dsn（adapter 回连 DSH 用，形如 http://127.0.0.1:<端口>/dsh-tiddlywiki；留空=按请求自动推导。仅在启用微信发布时生效）', typeof wechat.dsn === 'string' ? wechat.dsn : '')

  // ── 系统提示词（v0.21.0；草稿预览 v0.22.7）────────────────────────────────
  const prompt = (config.prompt ?? {}) as Record<string, unknown>
  section.append(make('h3', 'dsh-tw-settings-h', '系统提示词（注入每个会话）'))
  section.append(make('div', 'dsh-tw-settings-muted', '插件把自己的约定（同步纪律 / 标签约定 / 链接格式等）注入每个会话的系统提示词。保存后**无需重启 dsh web**：section 会即时重新注册，当前会话从下一步起就使用新文本。'))
  const promptEnabled = checkField('prompt.enabled', '注入 TiddlyWiki 提示词（关闭后本插件不再注入任何文本）', prompt.enabled !== false)
  const promptMode = selectField('prompt.mode', '内置文本形态', prompt.mode === 'full' ? 'full' : 'slim', [
    { value: 'slim', label: '精简（默认）：只保留工具 schema 表达不了的约定' },
    { value: 'full', label: '完整：额外附一份由工具注册表实时生成的参数索引' },
  ])
  const promptExtra = areaField('prompt.extra', '附加说明（永远追加在末尾，可放团队/个人规范）', typeof prompt.extra === 'string' ? prompt.extra : '', 5)
  const promptOverride = areaField('prompt.override', '整段替换（非空时取代上面的内置文本，附加说明仍会追加）', typeof prompt.override === 'string' ? prompt.override : '', 8)
  /** Any prompt.* field (or the gating wechat.enabled) differs from saved. */
  const promptDirty = (): boolean =>
    fields.some((f) => (f.key.startsWith('prompt.') || f.key === 'wechat.enabled') && f.changed())
  const preview = make('button', 'dsh-tw-settings-btn', '预览注入文本（按表单当前值）')
  preview.type = 'button'
  preview.title = '按表单当前值渲染注入文本（不用先保存）；点「保存配置」后这就是实际注入的内容'
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
        // Send the DRAFT (v0.22.7): the host builds the text from these values
        // without saving them, so the preview follows the dropdown immediately
        // instead of showing the still-saved mode until 保存配置 is clicked.
        const data = await fetchJson<{ ok?: boolean; draft?: boolean; enabled?: boolean; mode?: string; length?: number; text?: string; error?: string }>(PROMPT_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            enabled: promptEnabled.checked,
            mode: promptMode.value,
            extra: promptExtra.value,
            override: promptOverride.value,
            // 可选功能的开关也会改变注入文本（是否含发布约定），所以一并送草稿
            // （v0.23.0；否则勾选它再预览会看到旧文本）。
            wechat: wechatEnabled.checked,
          }),
        })
        if (data.ok !== true) throw new Error(data.error ?? '获取失败')
        previewOut.textContent = data.enabled === false
          ? '（已关闭：不会注入任何提示词）'
          : `# 形态 ${data.mode ?? ''} · ${data.length ?? 0} 字符${promptDirty() ? '（含未保存的修改，保存后才真正注入）' : ''}\n\n${data.text ?? ''}`
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
  // 宿主的真实规则（index.ts effectiveBridge）：必须是 1–65535 的整数，否则静默用默认 8618 ——
  // 这里不拦，用户会以为端口改了，其实监听还在 8618。
  numField('bridge.port', '剪藏桥端口（整数 1–65535；改端口需重启 dsh web 生效）', typeof bridge.port === 'number' && bridge.port > 0 ? bridge.port : 8618, { min: 1, max: 65_535, step: 1, integer: true })
  tokenField('bridge.token', '剪藏桥 token（非空时校验书签的 x-clip-token 头；强烈建议设置。已设置时显示为 ********，原样保存=不改，清空=删除）', typeof bridge.token === 'string' ? bridge.token : '')
  textField('bridge.tag', '剪藏笔记默认 tag', typeof bridge.tag === 'string' && bridge.tag.trim().length > 0 ? bridge.tag.trim() : 'clip')
  // 界面语言在下方「语言管理」区块设置（config 的 uiLanguage 仅供启动时自动应用）。
  // 注意：uiLanguage 目前只影响 TW 侧语言，客户端插件文案（FAB/快速笔记/侧边栏/本页）
  // 暂为中文，尚无 i18n 分支。

  // 保存失败的解释性横幅（v0.24.x）：文案存在 mount 级 configState 里，因为 refresh()
  // 可能按新签名重建整个配置区 —— 局部 DOM 连同这里刚写的节点会一起消失，重建后要从
  // configState 里把「最近一次保存错误」再渲染回来。
  const saveErrorBanner = makeErrorBanner(configState.saveError ?? '')
  saveErrorBanner.hidden = configState.saveError === undefined

  const save = make('button', 'dsh-tw-settings-btn dsh-tw-settings-primary', '保存配置')
  save.type = 'button'
  save.addEventListener('click', () => {
    save.disabled = true
    void (async () => {
      // 数值字段非法就直接拒绝提交：宿主对越界值只会静默夹取/回落，提交它等于把
      // 「页面显示的值」和「真正生效的值」再次分开 —— 那正是这轮要修的 bug。
      const invalidFields = fields.filter((field) => field.invalid?.() !== undefined)
      if (invalidFields.length > 0) {
        toast(`有 ${invalidFields.length} 个字段填得不对（见字段旁的红色提示），未保存`)
        save.disabled = false
        return
      }
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
      // 没有任何改动就别发请求：宿主收到空 patch 也会整体重写 config tiddler 并刷新
      // modified —— 白白给 git 造 diff（两台机器各点一次「保存」就会在 .meta 上冲突）。
      if (Object.keys(patch).length === 0) {
        toast('没有改动')
        save.disabled = false
        return
      }
      try {
        await fetchJson(CONFIG_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
        // ui.* 已落盘：清掉客户端缓存，下一次读取立即拿到新值（否则最长 15s 才生效）。
        invalidateUiConfig()
        configState.saveError = undefined
        saveErrorBanner.hidden = true
        saveErrorBanner.textContent = ''
        toast('配置已保存')
        void refresh()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // 不能只 toast：失败原因（典型是 409「配置 tiddler 不是合法 JSON，保存已被拒绝」）
        // 需要持久可见，否则用户看到的就是「点了保存但什么都没发生」。
        configState.saveError = `保存失败：${message}`
        saveErrorBanner.textContent = configState.saveError
        saveErrorBanner.hidden = false
        // 顺带刷一次：宿主可能因此在顶部给出「配置未生效」横幅（state.configError）。
        void refresh()
      } finally {
        save.disabled = false
      }
    })()
  })
  // 暴露「有未保存改动」给 renderMain：签名变化时据此决定要不要重建表单（见
  // ConfigRenderState.isDirty）。
  configState.isDirty = () => fields.some((field) => field.changed())
  section.append(saveErrorBanner, save)
  body.append(section)
}

/** Plugin/theme manager: checkboxes/radios + apply (writes info, restarts). */
function renderCatalogSection(
  body: HTMLElement,
  info: AdminState['info'],
  catalog: AdminState['catalog'],
  runtimePlugins: AdminState['runtimePlugins'],
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
  pluginSection.append(make('h3', 'dsh-tw-settings-h', '插件管理（自带官方插件）'))
  const pluginHint = make('div', 'dsh-tw-settings-muted', '勾选 = 写入 tiddlywiki.info 的启动安装清单（离线、与引擎版本配套），应用后重启 TW。这里只管引擎自带插件；在 TW 控制面板里安装/禁用/卸载的插件见下方「wiki 内插件」。')
  pluginSection.append(pluginHint)
  const search = make('input', 'dsh-tw-settings-input dsh-tw-settings-search')
  search.placeholder = '搜索插件…'
  const listWrap = make('div', 'dsh-tw-settings-list')
  const applyPlugins = make('button', 'dsh-tw-settings-btn dsh-tw-settings-primary', '应用插件（重启 TW）')
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
        const badge = make('span', 'dsh-tw-settings-chip', 'TW 内已禁用')
        badge.dataset.state = 'disabled'
        badge.title = '该插件在 tiddlywiki.info 里，但已在 TW 控制面板被禁用（$:/config/Plugins/Disabled）——去 TW 面板重新启用'
        label.append(badge)
      } else if (runtimePlugins != null && !serverPlugins.includes(plugin.name) && wikiTitles.has(plugin.title)) {
        const badge = make('span', 'dsh-tw-settings-chip', 'wiki 内已装')
        badge.dataset.state = 'update'
        badge.title = '不在启动清单，但 wiki 里存在同名插件 tiddler（经 TW 原生安装），TW 运行时已在用'
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
        await fetchJson(INFO_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plugins: [...desiredPlugins()] }) })
        // 应用成功才清 pending：之后重新跟随服务器（TW 重启后 info 会给出真实集合）。
        pending.plugins = undefined
        toast('插件已应用，TW 已重启')
        void refresh()
      } catch (err) {
        toast(`应用失败：${err instanceof Error ? err.message : String(err)}`)
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
      wikiSection.append(make('h3', 'dsh-tw-settings-h', 'wiki 内插件（经 TW 原生安装，只读）'))
      wikiSection.append(
        make(
          'div',
          'dsh-tw-settings-muted',
          '下列插件以 tiddler 形式随 wiki 文件保存（TW 控制面板 → 插件 安装/导入），不受上面勾选影响。启用 / 禁用 / 卸载请到 TW 控制面板操作。',
        ),
      )
      const wikiWrap = make('div', 'dsh-tw-settings-list')
      for (const plugin of externals) {
        const row = make('div', 'dsh-tw-settings-row dsh-tw-settings-plugin')
        const name = make('span', 'dsh-tw-settings-name', plugin.name || plugin.title)
        name.title = plugin.title
        row.append(name)
        if (disabledTitles.has(plugin.title)) {
          const badge = make('span', 'dsh-tw-settings-chip', '已禁用')
          badge.dataset.state = 'disabled'
          badge.title = '该插件已在 TW 控制面板被禁用'
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
  themeSection.append(make('h3', 'dsh-tw-settings-h', '主题管理（自带主题）'))
  const themeHint = make('div', 'dsh-tw-settings-muted', '「加载」= TW 里可用的主题（可多选，依赖链自动带上，如 heavier 会带 snowwhite+vanilla）；「活动」= 当前视觉主题（单选，自动加入加载集）。应用后重启 TW。')
  const themeHead = make('div', 'dsh-tw-settings-row dsh-tw-settings-head')
  themeHead.append(
    make('span', 'dsh-tw-settings-col', '加载'),
    make('span', 'dsh-tw-settings-col', '活动'),
    make('span', 'dsh-tw-settings-name', '主题'),
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
  const applyThemes = make('button', 'dsh-tw-settings-btn dsh-tw-settings-primary', '应用主题（重启 TW）')
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
    load.title = '加载该主题'
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
    act.title = '设为活动主题'
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
        await fetchJson(INFO_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ themes: [...desiredThemes()], themeActive: activeThemeName() }),
        })
        // 应用成功才清 pending（同插件管理）。
        pending.themes = undefined
        pending.themeActive = undefined
        toast('主题已应用，TW 已重启')
        void refresh()
      } catch (err) {
        toast(`应用失败：${err instanceof Error ? err.message : String(err)}`)
        syncApplyThemes()
      }
    })()
  })
  syncApplyThemes()
  themeSection.append(themeHint, themeHead, themeWrap, applyThemes)
  body.append(themeSection)

  // ── languages (bundled, offline — enable → restart TW) ──────────────────
  const langSection = make('section', 'dsh-tw-settings-section')
  langSection.append(make('h3', 'dsh-tw-settings-h', '语言管理（自带官方语言包）'))
  const langHint = make('div', 'dsh-tw-settings-muted', '勾选启用语言插件并重启 TW；如中文请选 zh-Hans（简体）或 zh-CN。')
  const langWrap = make('div', 'dsh-tw-settings-list')
  const applyLangs = make('button', 'dsh-tw-settings-btn dsh-tw-settings-primary', '应用语言（重启 TW）')
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
        await fetchJson(INFO_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ languages: [...desiredLanguages()] }) })
        pending.languages = undefined
        toast('语言已应用，TW 已重启')
        void refresh()
      } catch (err) {
        toast(`应用失败：${err instanceof Error ? err.message : String(err)}`)
        syncApplyLangs()
      }
    })()
  })
  syncApplyLangs()
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
  /**
   * 最近一次保存失败的文案。保存失败后要 refresh()（顶部可能因此出现 configError
   * 横幅），而 refresh() 可能按新签名重建配置区 —— 错误提示存在这里才不会随局部
   * DOM 一起消失；保存成功时清空。
   */
  saveError?: string
  /**
   * 「表单里有未保存的改动」（v0.25.0）。用于防另一种静默丢改动：配置在**别处**
   * 被改过（另一个标签页保存、语言管理顺带写 uiLanguage）时 refresh() 会让签名
   * 变化 → 重建表单 → 用户刚敲的内容消失。有脏值就保留表单并给出显式提示。
   */
  isDirty?: () => boolean
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
interface CatalogPending {
  plugins?: Set<string>
  themes?: Set<string>
  languages?: Set<string>
  themeActive?: string
}

function renderMain(body: HTMLElement, state: AdminState, refresh: () => Promise<void>, isDisposed: () => boolean, configState: ConfigRenderState, catalogPending: CatalogPending): void {
  body.replaceChildren()
  // Loud, above everything else: an unparseable config tiddler means the config
  // block below shows DEFAULTS that are not actually in effect, and saving is
  // refused until it is fixed (v0.23.4 — that is how a user's prompt.extra /
  // git.remote were silently wiped on 2026-09-18).
  if (typeof state.configError === 'string' && state.configError.length > 0) {
    body.append(makeErrorBanner(`⚠️ 配置未生效：${state.configError}`))
  }
  // Config section: only rebuild when the server-side config actually changed.
  // Otherwise the status row's 同步/重启 buttons (and the catalog apply buttons)
  // call refresh() and would silently discard whatever the user had typed into
  // a field (v0.20.0). The host element is re-appended as-is, so its inputs and
  // their pending values survive.
  const signature = JSON.stringify(state.config ?? {})
  const serverChanged = configState.host !== undefined && configState.signature !== signature
  // 有未保存改动时**不重建**（v0.25.0）：重建会静默丢掉用户刚敲的内容（典型触发
  // 路径：另一个标签页保存了配置，或语言管理顺带写 uiLanguage → 本页 refresh()）。
  // 保留旧表单 + 显式提示，用户可以选择保存（覆盖别处的改动）或自己改回来。
  const dirty = configState.isDirty?.() === true
  if (serverChanged && dirty) {
    body.append(makeErrorBanner('⚠️ 服务器上的配置在别处被改动过（另一个标签页保存 / 语言管理等），当前表单仍是旧值：直接点「保存配置」会以本页内容覆盖那些改动。'))
  }
  if (configState.host === undefined || (serverChanged && !dirty)) {
    const host = make('div', 'dsh-tw-settings-confighost')
    renderConfigSection(host, state.config ?? {}, refresh, configState)
    configState.host = host
    configState.signature = signature
  }
  body.append(configState.host)
  renderWikiLocationSection(body, isDisposed, refresh)
  renderCatalogSection(body, state.info, state.catalog, state.runtimePlugins, refresh, catalogPending)
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

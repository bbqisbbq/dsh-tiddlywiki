/**
 * 常规配置 + 系统提示词 section of the settings page (v0.28.8 split).
 *
 * One concern, one very long function: the form that reads the effective config
 * and saves only what changed. The field builders (text / token / check / num /
 * select / area) stay next to the fields they build, because they encode rules
 * that only make sense together with the save path:
 *   - numeric fields keep the user's illegal input and REFUSE to submit it
 *     (the host silently clamps out-of-range values, so submitting would make
 *     "what the page shows" and "what is in effect" diverge again);
 *   - `ui.sidebarLabel` is rendered ONLY in single-wiki mode (multi mode gives
 *     every wiki its own label in the registry, so the field would be a fake
 *     setting that "saves but does nothing").
 *
 * @module dsh-tiddlywiki/client/settings-page-config
 */
import { toast } from './toast.ts'
import { invalidateUiConfig } from './ui-config.ts'
import { make } from './dom.ts'
import { t } from './i18n.ts'
import {
  ADMIN_CONFIG_ENDPOINT as CONFIG_ENDPOINT,
  ADMIN_PROMPT_ENDPOINT as PROMPT_ENDPOINT,
  ADMIN_WIKIS_ENDPOINT as WIKI_LIST_ENDPOINT,
} from './endpoints.ts'
import { editingWiki, fetchJson, makeErrorBanner, withWiki } from './settings-page-runtime.ts'
import type { WikisView } from './settings-page-runtime.ts'

/** Form controls registry for the config section (changed-only patch). */
export interface ConfigField {
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

/** Per-mount memory of the config section: the DOM plus the server-side config
 *  signature it was built from, so an unchanged refresh never rebuilds the
 *  inputs (and never discards the user's unsaved edits). */
export interface ConfigRenderState {
  signature?: string
  /**
   * The knowledge base this form was built for (v0.29.0).
   *
   * `signature` alone was not enough: two wikis can hold IDENTICAL config JSON, so
   * switching 「配置」 from one to the other looked like "nothing changed" and kept
   * the previous wiki's form — including its unsaved edits — which the next 保存配置
   * then wrote into the NEW wiki (with a misleading 「配置在别处被改动过」 banner).
   */
  wiki?: string
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

/** Config section: fields bound to effective config, changed-only save. */
export function renderConfigSection(body: HTMLElement, config: Record<string, unknown>, refresh: () => Promise<void>, configState: ConfigRenderState, rosterMode?: string, isDisposed: () => boolean = () => false): void {
  const section = make('section', 'dsh-tw-settings-section')
  section.append(make('h3', 'dsh-tw-settings-h', t('config.title')))
  const note = (config.note ?? {}) as Record<string, unknown>
  const git = (config.git ?? {}) as Record<string, unknown>
  const ui = (config.ui ?? {}) as Record<string, unknown>
  const fields: ConfigField[] = []
  /**
   * Where the field helpers attach their DOM (v0.30.62).
   *
   * `target` starts at the section and is temporarily pointed at a DETACHED box by
   * blocks that are only shown in some scopes (the clip bridge — see below). The
   * fields are always REGISTERED (so 保存配置 / 未保存改动 still sees them), only
   * their nodes are attached conditionally.
   */
  let target = section

  const textField = (key: string, label: string, initial: string): void => {
    const input = make('input', 'dsh-tw-settings-input')
    // autocomplete=off（v0.26.4）：浏览器常把 URL 类配置框（ui.sendToAgent.endpoint、
    // git.remote、wechat.dsn 等）当账号/URL 字段自动填充，用户一保存就把垃圾值写进 config
    // （实测 ui.sendToAgent.endpoint 被填成 /dsh-tiddlywiki/tw/root，send-to-agent 请求拼成
    // /tw/root/agent/sessions → 404）。tokenField 已有此属性，这里补到所有普通文本框。
    input.autocomplete = 'off'
    input.value = initial
    const wrap = make('label', 'dsh-tw-settings-field')
    wrap.append(make('span', 'dsh-tw-settings-label', label), input)
    fields.push({ key, initial, read: () => input.value.trim(), changed: () => input.value.trim() !== initial })
    target.append(wrap)
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
    toggle.title = t('config.token.showHide')
    toggle.setAttribute('aria-label', t('config.token.showHide'))
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
    target.append(wrap)
  }
  const checkField = (key: string, label: string, initial: boolean): HTMLInputElement => {
    const input = make('input', 'dsh-tw-settings-check')
    input.type = 'checkbox'
    input.checked = initial
    const wrap = make('label', 'dsh-tw-settings-field dsh-tw-settings-field-check')
    wrap.append(input, make('span', 'dsh-tw-settings-label', label))
    fields.push({ key, initial, read: () => input.checked, changed: () => input.checked !== initial })
    target.append(wrap)
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
      if (raw.length === 0) return t('config.num.empty')
      const parsed = Number(raw)
      if (!Number.isFinite(parsed)) return t('config.num.nan')
      if (range?.integer === true && !Number.isInteger(parsed)) return t('config.num.integer')
      if (range?.min !== undefined && parsed < range.min) return t('config.num.belowMin', { min: range.min })
      if (range?.max !== undefined && parsed > range.max) return t('config.num.aboveMax', { max: range.max })
      return undefined
    }
    const sync = (): void => {
      const bad = violation()
      hint.textContent = bad === undefined ? '' : t('config.num.invalidHint', { message: bad })
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
    target.append(wrap)
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
    target.append(wrap)
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
    target.append(wrap)
    return input
  }

  textField('note.tag', t('config.note.tag'), typeof note.tag === 'string' ? note.tag : 'inbox')
  // 工作区标记（v0.24.0）：新建笔记自动带 ws/<项目名> 标签 + workspace 字段，
  // 项目名取自会话工作目录。关掉只是不做标记，不影响任何写入。
  checkField('note.workspaceMark', t('config.note.workspaceMark'), note.workspaceMark !== false)
  checkField('git.autoCommit', t('config.git.autoCommit'), git.autoCommit !== false)
  // v0.25.0：范围与宿主 config.ts 的 NUMBER_CONFIG_RANGES 对齐（超范围的补丁会被
  // 宿主夹取，页面必须让用户看见真实边界，别再出现「回显 ≠ 生效」）。
  numField('git.debounceMs', t('config.git.debounceMs'), typeof git.debounceMs === 'number' ? git.debounceMs : 60_000, { min: 0, max: 3_600_000, step: 1_000, integer: true })
  textField('git.remote', t('config.git.remote'), typeof git.remote === 'string' ? git.remote : '')
  textField('git.branch', t('config.git.branch'), typeof git.branch === 'string' ? git.branch : 'main')
  // 启动就绪窗口（v0.22.5）：大知识库冷启动（数千条目）可能 40s+。窗口内只等，
  // 超过它只写日志，硬上限 = 3× 仍无响应才判失败。改动对下一次启动/重启生效。
  const startup = (config.startup ?? {}) as Record<string, unknown>
  numField('startup.readyTimeoutMs', t('config.startup.readyTimeoutMs'), typeof startup.readyTimeoutMs === 'number' && startup.readyTimeoutMs > 0 ? startup.readyTimeoutMs : 60_000, { min: 5_000, max: 600_000, step: 1_000 })
  checkField('ui.showQuickNote', t('config.ui.showQuickNote'), ui.showQuickNote !== false)
  checkField('ui.showQuickNoteDock', t('config.ui.showQuickNoteDock'), ui.showQuickNoteDock !== false)
  selectField('ui.quickNoteMode', t('config.ui.quickNoteMode'), typeof ui.quickNoteMode === 'string' && ui.quickNoteMode === 'card' ? 'card' : 'native', [
    { value: 'native', label: t('config.ui.quickNoteModeNative') },
    { value: 'card', label: t('config.ui.quickNoteModeCard') },
  ])
  // 「侧边栏 TW 入口显示名称」只在**单库**模式有意义（v0.28.7）。多库时侧边栏是每个库
  // 各占一行、各用自己 `wikis.json` 里的 label，这个字段改不动任何东西——留着只会让人
  // 「改了没生效」。所以多库时**不渲染这个字段**（连字段带保存都不参与），只留一行说明
  // 该去哪儿改。判定用的模式来自 mountSettingsPage 的探测（读不到按单库，见那里的注释）。
  if (rosterMode === 'multi') {
    section.append(make('div', 'dsh-tw-settings-muted', t('config.ui.multiWikiSidebarHint')))
  } else {
    textField('ui.sidebarLabel', t('config.ui.sidebarLabel'), typeof ui.sidebarLabel === 'string' && ui.sidebarLabel.trim().length > 0 ? ui.sidebarLabel.trim() : 'TiddlyWiki')
  }
  checkField('ui.showPanelStatus', t('config.ui.showPanelStatus'), ui.showPanelStatus !== false)
  checkField('ui.showSyncButton', t('config.ui.showSyncButton'), ui.showSyncButton !== false)
  checkField('ui.followDshTheme', t('config.ui.followDshTheme'), ui.followDshTheme !== false)
  textField('ui.darkPalette', t('config.ui.darkPalette'), typeof ui.darkPalette === 'string' && ui.darkPalette.trim().length > 0 ? ui.darkPalette.trim() : '$:/palettes/CupertinoDark')
  textField('ui.tabLabel', t('config.ui.tabLabel'), typeof ui.tabLabel === 'string' && ui.tabLabel.trim().length > 0 ? ui.tabLabel.trim() : t('frame.tabLabelDefault'))
  checkField('ui.showSessionTab', t('config.ui.showSessionTab'), ui.showSessionTab !== false)
  checkField('ui.showRightbarTab', t('config.ui.showRightbarTab'), ui.showRightbarTab !== false)
  const sendToAgent = (ui.sendToAgent ?? {}) as Record<string, unknown>
  checkField('ui.sendToAgent.enabled', t('config.ui.sendToAgent.enabled'), sendToAgent.enabled !== false)
  textField('ui.sendToAgent.endpoint', t('config.ui.sendToAgent.endpoint'), typeof sendToAgent.endpoint === 'string' ? sendToAgent.endpoint : '')
  tokenField('ui.sendToAgent.token', t('config.ui.sendToAgent.token'), typeof sendToAgent.token === 'string' ? sendToAgent.token : '')
  const allArticles = (ui.allArticles ?? {}) as Record<string, unknown>
  // 1–200 是「所有文章」分页的有效范围（超出后分页会失序），宿主不会替我们夹取，所以在这里挡住。
  numField('ui.allArticles.pageSize', t('config.ui.allArticles.pageSize'), typeof allArticles.pageSize === 'number' ? allArticles.pageSize : 10, { min: 1, max: 200, step: 1, integer: true })

  // ── 可选功能：微信公众号发布（v0.23.0）────────────────────────────────────
  // 默认关闭：这项能力需要**额外安装**（opencli + 浏览器扩展，见
  // docs/wechat-publish-setup.md），插件本体不含它。关闭时不注入任何发布相关
  // 提示词、也不自动写「发布元数据规范」文档，避免打扰不用它的用户。
  section.append(make('h3', 'dsh-tw-settings-h', t('config.wechat.title')))
  section.append(make('div', 'dsh-tw-settings-muted', t('config.wechat.hint')))
  const wechat = (config.wechat ?? {}) as Record<string, unknown>
  const wechatEnabled = checkField('wechat.enabled', t('config.wechat.enabled'), wechat.enabled === true)
  // 以下四项 v0.23.3 宿主就支持，但设置页此前只暴露了 enabled —— 于是 token 这个安全开关
  // 只能手改 wiki 里的 config tiddler。token 非空时 /wechat/ 下的路由要求 x-wechat-publish-token
  // 头，防的是「任何能打开 DSH Web UI 的人都能用你本机 Chrome 对外发文」。
  textField('wechat.command', t('config.wechat.command'), typeof wechat.command === 'string' && wechat.command.trim().length > 0 ? wechat.command.trim() : 'opencli')
  selectField('wechat.adapter', t('config.wechat.adapter'), wechat.adapter === 'publish-note-imgs' ? 'publish-note-imgs' : 'publish-note', [
    { value: 'publish-note', label: t('config.wechat.adapterDefault') },
    { value: 'publish-note-imgs', label: t('config.wechat.adapterImgs') },
  ])
  tokenField('wechat.token', t('config.wechat.token'), typeof wechat.token === 'string' ? wechat.token : '')
  textField('wechat.dsn', t('config.wechat.dsn'), typeof wechat.dsn === 'string' ? wechat.dsn : '')

  // ── 系统提示词（v0.21.0；草稿预览 v0.22.7）────────────────────────────────
  const prompt = (config.prompt ?? {}) as Record<string, unknown>
  section.append(make('h3', 'dsh-tw-settings-h', t('config.prompt.title')))
  section.append(make('div', 'dsh-tw-settings-muted', t('config.prompt.hint')))
  const promptEnabled = checkField('prompt.enabled', t('config.prompt.enabled'), prompt.enabled !== false)
  const promptMode = selectField('prompt.mode', t('config.prompt.mode'), prompt.mode === 'full' ? 'full' : 'slim', [
    { value: 'slim', label: t('config.prompt.modeSlim') },
    { value: 'full', label: t('config.prompt.modeFull') },
  ])
  const promptExtra = areaField('prompt.extra', t('config.prompt.extra'), typeof prompt.extra === 'string' ? prompt.extra : '', 5)
  const promptOverride = areaField('prompt.override', t('config.prompt.override'), typeof prompt.override === 'string' ? prompt.override : '', 8)
  /** Any prompt.* field (or the gating wechat.enabled) differs from saved. */
  const promptDirty = (): boolean =>
    fields.some((f) => (f.key.startsWith('prompt.') || f.key === 'wechat.enabled') && f.changed())
  const preview = make('button', 'dsh-tw-settings-btn', t('config.prompt.preview'))
  preview.type = 'button'
  preview.title = t('config.prompt.previewTitle')
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
        const data = await fetchJson<{ ok?: boolean; draft?: boolean; enabled?: boolean; mode?: string; length?: number; text?: string; error?: string }>(withWiki(PROMPT_ENDPOINT), {
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
        if (data.ok !== true) throw new Error(data.error ?? t('config.prompt.fetchFailed'))
        previewOut.textContent = data.enabled === false
          ? t('config.prompt.previewDisabled')
          : t('config.prompt.previewHeader', {
            mode: data.mode ?? '',
            length: data.length ?? 0,
            dirty: promptDirty() ? t('config.prompt.previewDirty') : '',
            text: data.text ?? '',
          })
        previewOut.hidden = false
      } catch (err) {
        toast(t('config.prompt.readFailed', { message: err instanceof Error ? err.message : String(err) }))
      } finally {
        preview.disabled = false
      }
    })()
  })
  section.append(preview, previewOut)

  // ── 本地剪藏桥 ──────────────────────────────────────────────────────────
  // 这一组是**插件级**设置（见下面 append 处的说明），所以先建在一个脱离文档的盒子里，
  // 最后由作用域决定是把它挂上去、还是只挂一句说明。
  const bridgeBox = make('div', 'dsh-tw-settings-bridge')
  target = bridgeBox
  const bridge = (config.bridge ?? {}) as Record<string, unknown>
  checkField('bridge.enabled', t('config.bridge.enabled'), bridge.enabled === true)
  // 宿主的真实规则（index-git.ts effectiveBridge）：必须是 1–65535 的整数，否则静默用默认 8618 ——
  // 这里不拦，用户会以为端口改了，其实监听还在 8618。
  numField('bridge.port', t('config.bridge.port'), typeof bridge.port === 'number' && bridge.port > 0 ? bridge.port : 8618, { min: 1, max: 65_535, step: 1, integer: true })
  tokenField('bridge.token', t('config.bridge.token'), typeof bridge.token === 'string' ? bridge.token : '')
  textField('bridge.tag', t('config.bridge.tag'), typeof bridge.tag === 'string' && bridge.tag.trim().length > 0 ? bridge.tag.trim() : 'clip')
  // 剪藏目标库（v0.28.8）：剪藏桥自建 loopback 服务，请求走不到宿主的 `?wiki=` 解析，
  // 所以多库下**必须**在这里显式选一次，否则永远剪进默认库。选项要等 /admin/wikis
  // 回来才知道，所以先渲染一个占位 select，拿到列表后补全；用户已选的值若不在列表里
  // （库被移出清单）也保留一行。
  //
  // 空值 = 「不指定，写进默认的那个库」，但这一项的**名字**不再是「默认库」（v0.28.12，
  // 作者 2026-09-29 要求：设置过默认库之后，界面上不该再出现「默认库」这个字样，应当
  // 直接给出真实库名）——清单回来后把这一项就地改名成默认库自己的显示名 +「（默认）」，
  // 并且**跳过**它自己那一行，免得同一个库在下拉里出现两次。
  const clipWiki = selectField('bridge.wiki', t('config.bridge.wiki'), typeof bridge.wiki === 'string' ? bridge.wiki.trim() : '', [{ value: '', label: t('config.clipWiki.followDefault') }])
  void (async () => {
    try {
      const view = await fetchJson<WikisView>(WIKI_LIST_ENDPOINT)
      if (isDisposed()) return
      const items = Array.isArray(view.wikis) ? view.wikis : []
      const current = clipWiki.value
      const defaultEntry = items.find((wiki) => wiki.id === view.defaultId)
      const defaultLabel = defaultEntry?.label ?? undefined
      // 空值那一项的**名字**：默认库的显示名 + 身份标记。读不到清单/没有默认库时保持
      // 中性说法（绝不退回「默认库」这三个字）。
      const placeholder = clipWiki.options.item(0)
      if (placeholder !== null && defaultLabel !== undefined) placeholder.textContent = t('config.clipWiki.defaultSuffix', { label: defaultLabel })
      for (const wiki of items) {
        // 默认库由空值那一项代表；再列一遍就是同一个库出现两次。
        if (wiki.id === view.defaultId) continue
        const option = document.createElement('option')
        option.value = wiki.id
        option.textContent = t('config.clipWiki.option', { label: wiki.label, id: wiki.id, suffix: wiki.running ? '' : t('config.clipWiki.notRunning') })
        clipWiki.append(option)
      }
      // 当前值不在清单里（已移出）：补一行，避免下拉静默把它抹成另一个库。
      if (current.length > 0 && !items.some((wiki) => wiki.id === current)) {
        const option = document.createElement('option')
        option.value = current
        option.textContent = defaultLabel !== undefined
          ? t('config.clipWiki.notInListWithDefault', { current, label: defaultLabel })
          : t('config.clipWiki.notInList', { current })
        clipWiki.append(option)
      }
      clipWiki.value = current
    } catch {
      /* 读不到清单：保留中性占位项（单库安装本来就是这种形态） */
    }
  })()
  target = section
  // 剪藏桥是**插件级**设置（整插件一个监听端口、一个写入目标），而读取它的是**默认库**
  // 那份 config（index-git.ts 的 effectiveBridge）。多库下在别的库的配置里改它并保存，
  // 插件永远不会读 ⇒ 静默无效（v0.30.62）。所以只在「未选中具体库」的作用域里渲染它，
  // 否则只给一句说明 —— 口径与 `ui.sidebarLabel`（只在单库露出）一致。
  if (rosterMode !== 'multi' || editingWiki === undefined) section.append(bridgeBox)
  else section.append(make('div', 'dsh-tw-settings-muted', t('config.bridge.pluginScopeOnly')))
  // 界面语言在「本库配置」的「语言管理」区块设置（这里读到的 uiLanguage 只是当前库那份，
  // 用于回显）；客户端文案已全量 i18n（v0.30.6，见 src/client/i18n.ts），语言来自插件
  // 配置 → /status 的 lang，改后其余界面下次刷新生效。

  // 保存失败的解释性横幅（v0.24.x）：文案存在 mount 级 configState 里，因为 refresh()
  // 可能按新签名重建整个配置区 —— 局部 DOM 连同这里刚写的节点会一起消失，重建后要从
  // configState 里把「最近一次保存错误」再渲染回来。
  const saveErrorBanner = makeErrorBanner(configState.saveError ?? '')
  saveErrorBanner.hidden = configState.saveError === undefined

  const save = make('button', 'dsh-tw-settings-btn dsh-tw-settings-primary', t('config.save'))
  save.type = 'button'
  save.addEventListener('click', () => {
    save.disabled = true
    void (async () => {
      // 数值字段非法就直接拒绝提交：宿主对越界值只会静默夹取/回落，提交它等于把
      // 「页面显示的值」和「真正生效的值」再次分开 —— 那正是这轮要修的 bug。
      const invalidFields = fields.filter((field) => field.invalid?.() !== undefined)
      if (invalidFields.length > 0) {
        toast(t('config.invalidFields', { count: invalidFields.length }))
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
        toast(t('config.noChanges'))
        save.disabled = false
        return
      }
      try {
        await fetchJson(withWiki(CONFIG_ENDPOINT), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
        // ui.* 已落盘：清掉客户端缓存，下一次读取立即拿到新值（否则最长 15s 才生效）。
        invalidateUiConfig()
        configState.saveError = undefined
        saveErrorBanner.hidden = true
        saveErrorBanner.textContent = ''
        toast(t('config.saved'))
        void refresh()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // 不能只 toast：失败原因（典型是 409「配置 tiddler 不是合法 JSON，保存已被拒绝」）
        // 需要持久可见，否则用户看到的就是「点了保存但什么都没发生」。
        configState.saveError = t('config.saveFailed', { message })
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

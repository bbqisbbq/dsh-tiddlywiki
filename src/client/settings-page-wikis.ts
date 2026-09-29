/**
 * Knowledge-base list + location sections of the settings page (v0.28.8 split).
 *
 * The two sections that own "which wiki(s) does this plugin serve at all":
 *   - `renderWikiListSection` — the registry (`/admin/wikis`): mode, per-wiki
 *     start/stop, default, agent visibility, autostart, icon, folder, remove;
 *   - `renderWikiLocationSection` — the SINGLE-wiki folder switch (pointer file
 *     outside every wiki), which is deliberately NOT rendered in multi mode.
 *
 * They are one file because they are two halves of the same question and share
 * the same payload shape and admin calls; the config/catalog/seeds sections next
 * door are about the CONTENT of a wiki, not about the farm.
 *
 * @module dsh-tiddlywiki/client/settings-page-wikis
 */
import { toast } from './toast.ts'
import { invalidateUiConfig } from './ui-config.ts'
import { makeIconButton, openIconPicker } from './settings-icon-picker.ts'
import { make } from './dom.ts'
import { t } from './i18n.ts'
import {
  ADMIN_WIKI_LOCATION_ENDPOINT as WIKI_LOCATION_ENDPOINT,
  ADMIN_WIKI_RESET_ENDPOINT as WIKI_RESET_ENDPOINT,
  ADMIN_WIKI_SWITCH_ENDPOINT as WIKI_SWITCH_ENDPOINT,
  ADMIN_WIKIS_ENDPOINT as WIKI_LIST_ENDPOINT,
} from './endpoints.ts'
import { enterWikiScope, exitWikiScope, fetchJson, editingWiki } from './settings-page-runtime.ts'
import type { WikisView } from './settings-page-runtime.ts'

/**
 * Payload of GET /admin/wiki/location (v0.22.0 runtime wiki switch).
 */
export interface WikiLocationView {
  ok?: boolean
  current?: { root?: string; name?: string; path?: string; source?: string }
  default?: { root?: string; name?: string; path?: string }
  stateFile?: string
  candidates?: string[]
  error?: string
}

/**
 * 知识库列表（v0.28.0）—— 设置页的**第一块**。
 *
 * 为什么排在最前：多库的其余一切都要先有第二个库才能用，而在此之前多库模式只能靠
 * 手写 `$DSH_HOME/dsh-tiddlywiki/wikis.json` 打开。
 *
 * 它显示的是**控制文件**（用户编辑的那份），与"现在跑着什么"是两件事：single 模式下
 * farm 跑的是从旧指针合成的单条清单，而文件里可能已经列了好几个候选。所以每行同时给出
 * 「在不在清单里」与「现在跑没跑」。
 *
 * 关于「编辑哪个库的配置」：常规配置区作用于**默认库**（★ 那一行）——多库时这是刻意的
 * 简化，`git.*` 实际按仓库生效（见下），其余字段各库自己一份。
 */
export function renderWikiListSection(body: HTMLElement, isDisposed: () => boolean, refresh: () => Promise<void>): void {
  const section = make('section', 'dsh-tw-settings-section')
  section.append(make('h3', 'dsh-tw-settings-h', t('settings.wikis.title')))
  const status = make('div', 'dsh-tw-settings-muted', t('settings.wikis.loading'))
  const modeRow = make('div', 'dsh-tw-settings-row')
  const list = make('div')
  const addRoot = make('input', 'dsh-tw-settings-input')
  addRoot.placeholder = t('settings.wikis.rootPlaceholder')
  const addName = make('input', 'dsh-tw-settings-input')
  addName.placeholder = t('settings.wikis.namePlaceholder')
  const addLabel = make('input', 'dsh-tw-settings-input')
  addLabel.placeholder = t('settings.wikis.labelPlaceholder')
  const addBtn = make('button', 'dsh-tw-settings-btn dsh-tw-settings-primary', t('settings.wikis.add'))
  addBtn.type = 'button'
  const addRow = make('div', 'dsh-tw-settings-row dsh-tw-settings-field')
  addRow.append(addRoot, addName, addLabel, addBtn)
  const hint = make('div', 'dsh-tw-settings-muted', t('settings.wikis.hint'))
  section.append(status, modeRow, list, addRow, hint)
  body.append(section)

  /** One action, then re-read (the response already carries the new state). */
  const post = async (payload: Record<string, unknown>, busyLabel: string): Promise<void> => {
    status.textContent = busyLabel
    try {
      const data = await fetchJson<WikisView>(WIKI_LIST_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        // 新增/启动一个库可能要 `--init server` 并冷启动 TW（实测大库 40s+）。
        signal: AbortSignal.timeout(180_000),
      })
      if (isDisposed()) return
      const failures = data.change?.errors ?? []
      if (failures.length > 0) toast(t('settings.wikis.partialFailure', {
        message: failures
          .map((item) => t('settings.wikis.failureItem', { id: item.id, message: item.message }))
          .join(t('settings.wikis.failureJoin')),
      }))
      render(data)
      await refresh()
    } catch (err) {
      if (isDisposed()) return
      toast(t('settings.wikis.actionFailed', { message: err instanceof Error ? err.message : String(err) }))
      await load()
    }
  }

  /**
   * The DEFAULT wiki's folder change goes through `/admin/wiki/switch`, which is
   * already mode-aware host-side (single → pointer file + restart with rollback;
   * multi → edit the registry and let the farm reconcile) and refuses a location
   * that collides with / nests inside another registered wiki.
   */
  const postLocation = async (url: string, body: unknown, busyLabel: string): Promise<void> => {
    status.textContent = busyLabel
    try {
      const data = await fetchJson<{ ok?: boolean; error?: string }>(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      })
      if (isDisposed()) return
      if (data.ok !== true) toast(t('settings.wikis.failed', { message: data.error ?? t('settings.wikis.unknownError') }))
      await load()
      await refresh()
    } catch (err) {
      if (isDisposed()) return
      toast(t('settings.wikis.failed', { message: err instanceof Error ? err.message : String(err) }))
      await load()
    }
  }

  const render = (view: WikisView): void => {
    status.textContent = view.error !== undefined && view.error.length > 0 ? `⚠️ ${view.error}` : ''
    // 「默认库」这个字样不再出现在界面上（v0.28.12，作者 2026-09-29）：直接说**那个库的名字**，
    // 读不到清单时用中性说法兜底，绝不退回「默认库」。
    const defaultLabel = (view.wikis ?? []).find((wiki) => wiki.id === view.defaultId)?.label
    const defaultName = defaultLabel !== undefined && defaultLabel.length > 0 ? defaultLabel : t('settings.wikis.unknownName')
    modeRow.replaceChildren(make('span', 'dsh-tw-settings-label', t('settings.wikis.modeLabel')))
    const modes: Array<[string, string]> = [
      ['single', t('settings.wikis.modeSingle', { name: defaultName })],
      ['multi', t('settings.wikis.modeMulti')],
    ]
    for (const [value, text] of modes) {
      const active = view.mode === value
      const chip = make('button', `dsh-tw-settings-btn dsh-tw-settings-chipbtn${active ? ' dsh-tw-settings-primary' : ''}`, text)
      chip.type = 'button'
      chip.disabled = active
      chip.addEventListener('click', () => {
        const ok = window.confirm(value === 'multi'
          ? t('settings.wikis.switchToMulti')
          : t('settings.wikis.switchToSingle', { name: defaultName }))
        if (ok) void post({ action: 'set-mode', mode: value }, t('settings.wikis.switchingMode'))
      })
      modeRow.append(chip)
    }

    list.replaceChildren()
    const wikis = view.wikis ?? []
    for (const wiki of wikis) {
      const row = make('div', 'dsh-tw-settings-kbrow')
      const isDefault = wiki.id === view.defaultId
      row.append(make('div', 'dsh-tw-settings-label', t('settings.wikis.rowTitle', {
        mark: isDefault ? '★ ' : '',
        label: wiki.label,
        id: wiki.id,
      })))
      row.append(make('div', 'dsh-tw-settings-muted', [
        wiki.running ? t('settings.wikis.running') : t('settings.wikis.stopped'),
        wiki.agentVisible ? t('settings.wikis.agentVisible') : t('settings.wikis.agentHidden'),
        wiki.autostart ? t('settings.wikis.autostart') : t('settings.wikis.onDemand'),
        wiki.path,
      ].join(' · ')))

      const actions = make('div', 'dsh-tw-settings-row')
      // 「配置」把常规配置区切到这个库（每个库的配置存在它自己的 config tiddler 里，
      // 不说清楚就会出现"改了但不生效"）。
      //
      // v0.28.8（反馈 4）：从前这里一旦点过就被 disable 成「正在配置」，且没有任何
      // 反向操作 —— `editingWiki` 是模块级变量，连关掉设置页再打开都退不出去，作者
      // 因此找不到出口。现在它是个**开关**：已在配置中就显示「退出配置」并可点击。
      const configuring = editingWiki === wiki.id
      const configure = make(
        'button',
        `dsh-tw-settings-btn dsh-tw-settings-chipbtn${configuring ? ' dsh-tw-settings-primary' : ''}`,
        configuring ? t('settings.exitConfig') : t('settings.wikis.configure'),
      )
      configure.type = 'button'
      configure.title = configuring
        ? t('settings.wikis.exitConfigTitle', { label: wiki.label })
        : t('settings.wikis.configureTitle', { label: wiki.label })
      configure.addEventListener('click', () => {
        // 选库就切到「本库配置」那一页：用户点「配置」想看的就是按库生效的那几块
        // （插件/主题/语言/初始化），停在「总览」会让这次点击看起来没反应。
        // 两个动作是一件事，收在 enterWikiScope/exitWikiScope 里（作用域与 Tab 的值都住在
        // settings-page-runtime.ts —— section 模块不能反向 import 组装文件）。
        if (configuring) exitWikiScope()
        else enterWikiScope(wiki.id, configuring)
        void refresh()
      })
      const power = make('button', 'dsh-tw-settings-btn dsh-tw-settings-chipbtn', wiki.running ? t('settings.wikis.stop') : t('settings.wikis.start'))
      power.type = 'button'
      power.addEventListener('click', () => {
        void post(
          { action: wiki.running ? 'stop' : 'start', id: wiki.id },
          wiki.running ? t('settings.wikis.stopping') : t('settings.wikis.starting'),
        )
      })
      const makeDefault = make('button', 'dsh-tw-settings-btn dsh-tw-settings-chipbtn', t('settings.wikis.setDefault'))
      makeDefault.type = 'button'
      makeDefault.disabled = isDefault
      makeDefault.addEventListener('click', () => { void post({ action: 'set-default', id: wiki.id }, t('settings.wikis.saving')) })
      const visibility = make('button', 'dsh-tw-settings-btn dsh-tw-settings-chipbtn', wiki.agentVisible ? t('settings.wikis.hideFromAgent') : t('settings.wikis.showToAgent'))
      visibility.type = 'button'
      visibility.addEventListener('click', () => {
        void post({ action: 'update', wiki: { ...wiki, agentVisible: !wiki.agentVisible } }, t('settings.wikis.saving'))
      })
      const autostart = make('button', 'dsh-tw-settings-btn dsh-tw-settings-chipbtn', wiki.autostart ? t('settings.wikis.disableAutostart') : t('settings.wikis.autostart'))
      autostart.type = 'button'
      autostart.addEventListener('click', () => {
        void post({ action: 'update', wiki: { ...wiki, autostart: !wiki.autostart } }, t('settings.wikis.saving'))
      })
      const remove = make('button', 'dsh-tw-settings-btn dsh-tw-settings-chipbtn', t('settings.wikis.removeFromList'))
      remove.type = 'button'
      remove.disabled = wikis.length <= 1
      remove.addEventListener('click', () => {
        const ok = window.confirm(t('settings.wikis.removeConfirm', { label: wiki.label, path: wiki.path }))
        if (ok) void post({ action: 'remove', id: wiki.id }, t('settings.wikis.removing'))
      })
      // 图标选择（v0.28.4；v0.28.8 改成弹出式网格 + 分页）：它和 label 一样属于
      // "库的身份"，所以在列表里改，而不是塞进常规配置区。
      //
      // 为什么不再是 <select>：官方图标集有 36 个，加上自绘与 emoji 共 50+ 项 ——
      // 原生下拉既扫不过来，也**画不出图标本身**（option 只能显示文字）。作者要的
      // 是"一个弹出框可以弹出展示系统中所有的图标，太多的话可以考虑分页展示"。
      const currentIcon = typeof wiki.icon === 'string' ? wiki.icon : ''
      const iconPicker = makeIconButton(currentIcon, t('settings.wikis.iconAria', { label: wiki.label }))
      iconPicker.addEventListener('click', () => {
        openIconPicker(iconPicker, currentIcon, (next) => {
          void post(next.length > 0
            ? { action: 'update', wiki: { ...wiki, icon: next } }
            : { action: 'update', wiki: { ...wiki, icon: '' } }, t('settings.wikis.saving'))
        })
      })
      // 「改目录」只在多库模式出现（v0.28.1）：单库模式下这件事由「知识库位置」负责
      // （它写 wiki 之外的指针文件），两处并存会让用户不知道以哪个为准。
      if (view.mode === 'multi') {
        const move = make('button', 'dsh-tw-settings-btn dsh-tw-settings-chipbtn', t('settings.wikis.moveDir'))
        move.type = 'button'
        move.addEventListener('click', () => {
          const root = window.prompt(t('settings.wikis.moveRootPrompt', { label: wiki.label, root: wiki.root }), wiki.root)
          if (root === null) return
          if (root.trim().length === 0) {
            toast(t('settings.wikis.rootRequired'))
            return
          }
          const name = window.prompt(t('settings.wikis.moveNamePrompt', { name: wiki.name }), wiki.name)
          if (name === null) return
          const target = { root: root.trim(), name: name.trim().length > 0 ? name.trim() : wiki.name }
          void (isDefault
            ? postLocation(WIKI_SWITCH_ENDPOINT, target, t('settings.wikis.moving'))
            : post({ action: 'update', wiki: { ...wiki, ...target } }, t('settings.wikis.saving')))
        })
        actions.append(move)
      }
      actions.append(configure, power, makeDefault, visibility, autostart, iconPicker, remove)
      row.append(actions)
      list.append(row)
    }
    // 新增时默认沿用第一个库的根目录（多数情况就是同一个父目录）。
    if (addRoot.value.length === 0 && typeof wikis[0]?.root === 'string') addRoot.value = wikis[0].root
  }

  addBtn.addEventListener('click', () => {
    const root = addRoot.value.trim()
    const name = addName.value.trim()
    if (root.length === 0 || name.length === 0) {
      toast(t('settings.wikis.needRootAndName'))
      return
    }
    const wiki: Record<string, unknown> = { root, name }
    const label = addLabel.value.trim()
    if (label.length > 0) wiki.label = label
    void post({ action: 'add', wiki }, t('settings.wikis.adding'))
  })

  const load = async (): Promise<void> => {
    if (isDisposed()) return
    try {
      const view = await fetchJson<WikisView>(WIKI_LIST_ENDPOINT)
      if (isDisposed()) return
      render(view)
    } catch (err) {
      if (isDisposed()) return
      status.textContent = t('settings.wikis.listFailed', { message: err instanceof Error ? err.message : String(err) })
    }
  }
  void load()
}

/**
 * 「知识库位置」只在**单库模式**下渲染（v0.28.1）。
 *
 * 为什么按模式二选一，而不是两处并存：这一块的语义是「把唯一的那个库换到别处」——
 * 它写的是 wiki 之外的指针文件 `location.json`，措辞也是单库时代的（"切换到这个位置" /
 * "恢复为配置默认"）。多库模式下每个库的目录属于「知识库列表」里那一行（`改目录`），
 * 两处都能改同一件事 = 重复，而且这一块读起来像旧时代残留（作者 2026-09-28 反馈）。
 *
 * 宿主侧**没有**冲突：`/admin/wiki/switch` 早就按模式分派（single → 指针文件 + 带回滚的
 * 重启；multi → 改清单 + 让 farm 收敛）。所以这里只是把**界面**收敃到一处，不动接口。
 *
 * 读不到模式时按单库渲染（保守：宁可多显示一个"确实能用"的区块，也不要什么都不给）。
 */
export function renderWikiLocationSection(body: HTMLElement, isDisposed: () => boolean, refresh: () => Promise<void>): void {
  void (async () => {
    try {
      const view = await fetchJson<WikisView>(WIKI_LIST_ENDPOINT)
      if (isDisposed()) return
      if (view.mode === 'multi') return
    } catch {
      /* 读不到模式：按单库渲染 */
    }
    if (isDisposed()) return
    renderWikiLocationSectionBody(body, isDisposed, refresh)
  })()
}

function renderWikiLocationSectionBody(body: HTMLElement, isDisposed: () => boolean, refresh: () => Promise<void>): void {
  const section = make('section', 'dsh-tw-settings-section')
  section.append(make('h3', 'dsh-tw-settings-h', t('settings.wikis.locationTitle')))
  const status = make('div', 'dsh-tw-settings-muted', t('settings.wikis.loading'))
  const sourceLine = make('div', 'dsh-tw-settings-muted')
  const stateLine = make('div', 'dsh-tw-settings-muted')
  const warn = make('div', 'dsh-tw-settings-muted')
  const rootInput = make('input', 'dsh-tw-settings-input')
  const nameInput = make('input', 'dsh-tw-settings-input')
  rootInput.placeholder = t('settings.wikis.rootPlaceholderSingle')
  nameInput.placeholder = t('settings.wikis.folderPlaceholderSingle')
  const rootWrap = make('label', 'dsh-tw-settings-field')
  rootWrap.append(make('span', 'dsh-tw-settings-label', t('settings.wikis.rootField')), rootInput)
  const nameWrap = make('label', 'dsh-tw-settings-field')
  nameWrap.append(make('span', 'dsh-tw-settings-label', t('settings.wikis.folderField')), nameInput)
  const switchBtn = make('button', 'dsh-tw-settings-btn dsh-tw-settings-primary', t('settings.wikis.switchHere'))
  switchBtn.type = 'button'
  const resetBtn = make('button', 'dsh-tw-settings-btn', t('settings.wikis.resetToConfig'))
  resetBtn.type = 'button'
  const row = make('div', 'dsh-tw-settings-row')
  row.append(switchBtn, resetBtn)
  const candidates = make('div', 'dsh-tw-settings-row dsh-tw-settings-candidates')
  const hint = make('div', 'dsh-tw-settings-muted', t('settings.wikis.locationHint'))

  const setBusy = (busy: boolean, label: string): void => {
    switchBtn.disabled = busy
    resetBtn.disabled = busy
    switchBtn.textContent = busy ? label : t('settings.wikis.switchHere')
  }

  const load = async (): Promise<void> => {
    if (isDisposed()) return
    try {
      const data = await fetchJson<WikiLocationView>(WIKI_LOCATION_ENDPOINT)
      if (isDisposed()) return
      if (data.ok !== true) throw new Error(data.error ?? t('settings.wikis.locationUnavailable'))
      const current = data.current ?? {}
      status.textContent = t('settings.wikis.current', { path: current.path ?? t('settings.wikis.unknownPath') })
      const sourceText = current.source === 'state'
        ? t('settings.wikis.sourceState')
        : current.source === 'config'
          ? t('settings.wikis.sourceConfig')
          : t('settings.wikis.sourceDefault')
      sourceLine.textContent = t('settings.wikis.sourceLine', {
        source: sourceText,
        path: data.default?.path ?? t('settings.wikis.unknownPath'),
      })
      stateLine.textContent = data.stateFile !== undefined ? t('settings.wikis.stateFile', { path: data.stateFile }) : ''
      warn.textContent = data.error !== undefined ? `⚠️ ${data.error}` : ''
      if (rootInput.value.length === 0 && typeof current.root === 'string') rootInput.value = current.root
      if (nameInput.value.length === 0 && typeof current.name === 'string') nameInput.value = current.name
      candidates.replaceChildren()
      const names = data.candidates ?? []
      if (names.length > 0) {
        candidates.append(make('span', 'dsh-tw-settings-label', t('settings.wikis.candidatesLabel')))
        for (const name of names) {
          const chip = make('button', 'dsh-tw-settings-btn dsh-tw-settings-chipbtn', name === '.' ? t('settings.wikis.rootItself') : name)
          chip.type = 'button'
          chip.title = t('settings.wikis.candidateTitle', { name })
          chip.addEventListener('click', () => { nameInput.value = name })
          candidates.append(chip)
        }
      }
    } catch (err) {
      if (isDisposed()) return
      status.textContent = t('settings.wikis.locationFailed', { message: err instanceof Error ? err.message : String(err) })
    }
  }

  switchBtn.addEventListener('click', () => {
    const root = rootInput.value.trim()
    const name = nameInput.value.trim().length > 0 ? nameInput.value.trim() : 'main'
    if (root.length === 0) {
      toast(t('settings.wikis.needRoot'))
      return
    }
    if (!window.confirm(t('settings.wikis.switchConfirm', { path: `${root}\\${name}` }))) return
    setBusy(true, t('settings.wikis.switching'))
    void (async () => {
      try {
        const data = await fetchJson<{ ok?: boolean; error?: string; warning?: string; path?: string; rolledBack?: boolean }>(WIKI_SWITCH_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ root, name }),
          signal: AbortSignal.timeout(120_000),
        })
        if (data.warning !== undefined) toast(t('settings.wikis.switchedWarn', { path: data.path ?? '', warning: data.warning }))
        else toast(t('settings.wikis.switched', { path: data.path ?? '' }))
        invalidateUiConfig()
        await load()
        await refresh()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast(t('settings.wikis.switchFailed', { message }))
        await load()
      } finally {
        setBusy(false, '')
      }
    })()
  })

  resetBtn.addEventListener('click', () => {
    if (!window.confirm(t('settings.wikis.resetConfirm'))) return
    setBusy(true, t('settings.wikis.switching'))
    void (async () => {
      try {
        const data = await fetchJson<{ ok?: boolean; error?: string; warning?: string; path?: string }>(WIKI_RESET_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(120_000),
        })
        toast(data.warning !== undefined
          ? t('settings.wikis.resetWarn', { warning: data.warning })
          : t('settings.wikis.resetDone', { path: data.path ?? '' }))
        invalidateUiConfig()
        await load()
        await refresh()
      } catch (err) {
        toast(t('settings.wikis.resetFailed', { message: err instanceof Error ? err.message : String(err) }))
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

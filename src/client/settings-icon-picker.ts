/**
 * Per-wiki icon picker: the button + the paginated popup grid (v0.28.8).
 *
 * WHY IT IS ITS OWN MODULE: this is a self-contained widget (no settings-page
 * state, no admin endpoints — the CALLER owns persisting the choice), and it
 * started life inline in `settings-page.ts`, which was already the second-largest
 * file in the repo. Splitting it keeps the settings page about settings.
 *
 * The set offered is exactly what `wiki-icon.ts` can render (the official DSH
 * icon artwork, inlined, plus our own few glyphs) and exactly what the host
 * accepts (`WIKI_ICON_NAMES`) — `scripts/verify-wiki-focus.mjs` asserts that
 * three-way agreement, because a mismatch shows up as the silent, confusing
 * "选了图标之后立刻变回默认".
 *
 * @module dsh-tiddlywiki/client/settings-icon-picker
 */
import { make } from './dom.ts'
import { DEFAULT_ICON_SVG, ICON_NAMES, ICON_SVG } from './wiki-icon.ts'
/**
 * Icon picker labels. The NAMES come from `wiki-icon.ts`, so the set the picker
 * offers is exactly the set the sidebar can render.
 *
 * v0.28.8 (feedback item 1): the set is now the official DSH icon set (36 slugs,
 * inlined from upstream artwork) plus our own 6 glyphs, so the picker can no
 * longer be a `<select>` of ~8 emoji-ish options — long lists in a native select
 * are hard to scan and cannot show the actual drawing. It is a POPUP GRID with
 * pagination, where each cell renders the REAL icon (see `openIconPicker`).
 */
const ICON_LABELS: Record<string, string> = {
  // ── 官方 DSH 图标集（与上游组件一一对应，见 scripts/gen-wiki-icons.mjs）──
  archive: '归档',
  'archive-check': '归档（已完成）',
  'archive-off': '取消归档',
  unarchive: '取出归档',
  database: '数据库',
  data: '数据',
  folder: '文件夹',
  globe: '地球 / 公开',
  branch: '分支',
  list: '清单',
  checklist: '核对清单',
  'flat-list': '平铺列表',
  skill: '技能',
  goal: '目标',
  compact: '紧凑',
  clock: '时钟 / 历史',
  alarm: '提醒',
  pin: '置顶',
  shield: '安全 / 私密',
  api: '接口',
  code: '代码',
  users: '团队',
  user: '个人',
  plugin: '插件',
  pinwheel: '插件风车',
  gauge: '仪表 / 用量',
  tree: '工作区树',
  personalization: '个性化',
  link: '链接',
  search: '检索',
  settings: '设置',
  sparkle: '灵感',
  think: '思考',
  light: '浅色',
  dark: '深色',
  refresh: '刷新',
  // ── 自绘（上游没有对应图标）──
  book: '书',
  briefcase: '公文包',
  home: '房子',
  notebook: '笔记本',
  flask: '实验',
  star: '星标',
}

/** A few emoji that read well at sidebar size and are easy to tell apart. */
const EMOJI_CHOICES = ['📚', '💼', '🏠', '✍️', '🧪', '🌱', '🎯', '🗂️']

/**
 * How many icons one page of the picker shows.
 *
 * 48 = 8 columns × 6 rows, which fits the popup without scrolling on a normal
 * window while keeping the grid scannable. The set is 50+ entries, so pagination
 * is what the author explicitly asked for ("太多的话可以考虑分页展示") rather
 * than an endless scroll.
 */
const ICON_PAGE_SIZE = 48

/** One selectable entry in the picker grid. */
interface IconChoice { value: string; label: string; kind: 'default' | 'name' | 'emoji' | 'custom' }

/**
 * Every choice the picker offers, in display order: the default first (so
 * "undo" is always the first cell), then the official/hand-drawn names, then a
 * small emoji palette, and finally the user's own value when it is not already
 * in the list (a hand-edited `wikis.json` emoji must never be silently dropped —
 * that was an explicit rule of the original `<select>` implementation).
 */
function iconChoices(current: string): IconChoice[] {
  const choices: IconChoice[] = [{ value: '', label: '默认图标', kind: 'default' }]
  for (const name of ICON_NAMES) choices.push({ value: name, label: ICON_LABELS[name] ?? name, kind: 'name' })
  for (const emoji of EMOJI_CHOICES) choices.push({ value: emoji, label: emoji, kind: 'emoji' })
  if (current.length > 0 && !choices.some((c) => c.value === current)) {
    choices.push({ value: current, label: current, kind: 'custom' })
  }
  return choices
}

/**
 * Render one icon value into an element, whatever KIND it is.
 *
 * Three cases, and the distinction matters: an empty value draws the built-in
 * default; a built-in NAME draws our SVG (the only case where `innerHTML` is
 * safe — the markup is ours); anything else is user text and must go through
 * `textContent` (see applyWikiIcon's note about the control file being editable).
 */
function paintIconValue(el: HTMLElement, value: string): void {
  el.replaceChildren()
  if (value.length === 0) {
    el.innerHTML = DEFAULT_ICON_SVG
    return
  }
  const svg = ICON_SVG[value]
  if (svg !== undefined) {
    el.innerHTML = svg
    return
  }
  el.textContent = value
}

/** The row button that shows the current icon and opens the picker. */
export function makeIconButton(current: string, ariaLabel: string): HTMLButtonElement {
  const btn = make('button', 'dsh-tw-settings-btn dsh-tw-settings-chipbtn dsh-tw-settings-iconbtn')
  btn.type = 'button'
  btn.setAttribute('aria-label', ariaLabel)
  btn.title = current.length === 0 ? '选择入口图标（默认）' : `选择入口图标（当前：${current}）`
  const face = make('span', 'dsh-tw-settings-iconbtn-face')
  paintIconValue(face, current)
  btn.append(face, make('span', 'dsh-tw-settings-iconbtn-label', '图标'))
  return btn
}

/**
 * Open the paginated icon grid as a popup.
 *
 * Plain DOM (not React): the settings page is a vanilla-DOM tree, and DSH's own
 * `Modal` primitive is a React component from a seed module we do not require.
 * The popup closes on select, on Escape, and on an outside click; it is appended
 * to `document.body` so no ancestor's `overflow` can clip it.
 *
 * @param anchor - the button the popup is positioned under.
 * @param current - the wiki's current icon value.
 * @param onPick - called with the new value (the caller persists + re-renders).
 */
export function openIconPicker(anchor: HTMLElement, current: string, onPick: (next: string) => void): void {
  // Only one popup at a time: clicking a second row's 图标 must move it, not
  // stack another layer on top of the first.
  document.querySelector('.dsh-tw-iconpicker')?.remove()

  const choices = iconChoices(current)
  const pages = Math.max(1, Math.ceil(choices.length / ICON_PAGE_SIZE))
  let page = Math.max(0, Math.floor(choices.findIndex((c) => c.value === current) / ICON_PAGE_SIZE))

  const popup = make('div', 'dsh-tw-iconpicker')
  popup.setAttribute('role', 'dialog')
  popup.setAttribute('aria-label', '选择入口图标')
  const grid = make('div', 'dsh-tw-iconpicker-grid')
  const pager = make('div', 'dsh-tw-iconpicker-pager')
  popup.append(grid, pager)

  const close = (): void => {
    popup.remove()
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('mousedown', onOutside, true)
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
    }
  }
  const onOutside = (event: MouseEvent): void => {
    const target = event.target
    if (target instanceof Node && !popup.contains(target) && !anchor.contains(target)) close()
  }

  const paintPage = (): void => {
    grid.replaceChildren()
    const slice = choices.slice(page * ICON_PAGE_SIZE, (page + 1) * ICON_PAGE_SIZE)
    for (const choice of slice) {
      const cell = make('button', 'dsh-tw-iconpicker-cell')
      cell.type = 'button'
      cell.title = choice.label
      cell.setAttribute('aria-label', choice.label)
      if (choice.value === current) cell.dataset.current = 'true'
      const face = make('span', 'dsh-tw-iconpicker-face')
      paintIconValue(face, choice.value)
      cell.append(face, make('span', 'dsh-tw-iconpicker-name', choice.label))
      cell.addEventListener('click', () => {
        close()
        onPick(choice.value)
      })
      grid.append(cell)
    }
    pager.replaceChildren()
    if (pages > 1) {
      const prev = make('button', 'dsh-tw-settings-btn dsh-tw-settings-chipbtn', '‹ 上一页')
      prev.type = 'button'
      prev.disabled = page === 0
      prev.addEventListener('click', () => { page -= 1; paintPage() })
      const info = make('span', 'dsh-tw-settings-muted', `第 ${page + 1} / ${pages} 页 · 共 ${choices.length} 个`)
      const next = make('button', 'dsh-tw-settings-btn dsh-tw-settings-chipbtn', '下一页 ›')
      next.type = 'button'
      next.disabled = page >= pages - 1
      next.addEventListener('click', () => { page += 1; paintPage() })
      pager.append(prev, info, next)
    } else {
      pager.append(make('span', 'dsh-tw-settings-muted', `共 ${choices.length} 个图标`))
    }
  }
  paintPage()

  document.body.append(popup)
  // Position under the button, clamped into the viewport, and FLIP upward when
  // there is not enough room below (the wiki list can sit near the page bottom).
  const rect = anchor.getBoundingClientRect()
  const height = popup.offsetHeight
  const spaceBelow = window.innerHeight - rect.bottom
  const top = spaceBelow < height + 12 && rect.top > height + 12
    ? rect.top - height - 6
    : rect.bottom + 6
  popup.style.top = `${Math.max(6, Math.min(top, window.innerHeight - 12))}px`
  popup.style.left = `${Math.max(6, Math.min(rect.left, window.innerWidth - popup.offsetWidth - 6))}px`

  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('mousedown', onOutside, true)
}


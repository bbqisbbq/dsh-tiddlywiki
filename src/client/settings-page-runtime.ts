/**
 * Shared runtime of the settings page (v0.28.8 split).
 *
 * Everything the settings sections have in common and that is NOT itself a
 * section: the same-origin JSON fetch with its caller-wins timeout, the red
 * explanation banner, the knowledge-base roster shape (`GET /admin/wikis`) and
 * the "which wiki am I editing" scope every per-wiki admin call must carry.
 *
 * Keeping these four together is deliberate: they are the rules a section can
 * get WRONG in a way nobody notices (a dropped `?wiki=` silently edits the
 * default wiki; a hardcoded timeout reports failure while the host kept going).
 * They live here, once, and the sections import them.
 *
 * @module dsh-tiddlywiki/client/settings-page-runtime
 */
import { make } from './dom.ts'

/**
 * 红色解释横幅。页面里没有对应 CSS 类（host 注入的样式表不归本文件管），内联样式
 * 是与宿主既定的视觉约定；抽成函数是为了两处横幅（配置未生效 / 保存被拒）长得一致。
 */
export function makeErrorBanner(text: string): HTMLDivElement {
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
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) })
  const data = (await res.json().catch(() => ({}))) as T
  if (!res.ok) {
    const err = (data as { error?: string }).error ?? `HTTP ${res.status}`
    throw new Error(err)
  }
  return data
}

/** One knowledge base as `GET /admin/wikis` reports it (v0.28.0). */
export interface WikiListItemView {
  id: string
  label: string
  root: string
  name: string
  path: string
  agentVisible: boolean
  autostart: boolean
  running: boolean
  status: string
  /** Per-wiki entry icon (v0.28.4): a curated name or a short emoji. */
  icon?: string
}


/** `GET`/`POST` /dsh-tiddlywiki/admin/wikis` payload (v0.28.0). */
export interface WikisView {
  ok?: boolean
  error?: string
  mode?: string
  defaultId?: string
  source?: string
  registryFile?: string
  warnings?: string[]
  wikis?: WikiListItemView[]
  change?: { started?: string[]; stopped?: string[]; updated?: string[]; errors?: Array<{ id: string; message: string }> }
}

/**
 * WHICH knowledge base the config block is editing (v0.28.0).
 *
 * Every per-wiki setting lives in that wiki's OWN
 * `$:/plugins/dsh-tiddlywiki/config` tiddler, so `/admin/state`, `/admin/config`
 * and `/admin/prompt` must be told which one. Without this, configuring the books
 * wiki would silently edit the DEFAULT wiki — a user would set `git.remote`, see
 * it saved, and never learn why pushes still went to the other repository.
 *
 * `undefined` = the default wiki, which is exactly what every route did before
 * this existed (and what a single-wiki install always gets).
 */
export let editingWiki: string | undefined

/** Set the wiki the per-wiki sections edit (the wiki list's 「配置」 toggle). */
export function setEditingWiki(id: string | undefined): void {
  editingWiki = id
}

/**
 * 当前设置页分页（`overview` / `library` / `global`，v0.28.8）。
 *
 * It lives here rather than in `settings-page.ts` for the same reason
 * `editingWiki` does: the wiki list's 「配置」 button must ALSO switch the tab
 * ("点配置就看本库配置"), and that button is rendered by a section module — which
 * must not import the assembly file back (that would be a cycle).
 *
 * It is `let` and exported directly (not only through the setter) because
 * `renderMain` reads it as the same `activeTab` name the pre-split file used;
 * a rename here would silently change what the guards assert on.
 */
export type SettingsTab = 'overview' | 'library' | 'global'

/** 当前 Tab（模块级，与 editingWiki 同级）：切换 Tab 不重建配置表单。 */
export let activeTab: SettingsTab = 'overview'

/** Switch the tab WITHOUT re-rendering (callers `refresh()` themselves). */
export function setActiveTab(tab: SettingsTab): void {
  activeTab = tab
}

/**
 * 「点某个库的『配置』」= 把作用域切到那个库 + 跳到「本库配置」那一页（v0.28.8）。
 *
 * The two halves are ONE user action and must stay together: the wiki list lives
 * in a section module and cannot assign the imported `activeTab` binding, so the
 * pair is applied here, in the module that owns both variables. The `if` guard
 * (rather than an unconditional assignment) mirrors the button's own toggle —
 * the caller only reaches this path when the wiki is NOT already being
 * configured, and keeping the condition visible is what the guard script reads.
 */
export function enterWikiScope(id: string, configuring: boolean): void {
  editingWiki = id
  if (!configuring) activeTab = 'library'
}

/** 退出配置 = 回到默认库的作用域（不改 Tab：用户可能仍在「本库配置」页看别的）。 */
export function exitWikiScope(): void {
  editingWiki = undefined
}

/** Append the editing scope to a per-wiki admin URL. */
export function withWiki(url: string): string {
  return editingWiki === undefined ? url : `${url}?wiki=${encodeURIComponent(editingWiki)}`
}

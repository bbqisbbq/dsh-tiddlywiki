/**
 * Draft persistence + small pure helpers of the quick-note card (v0.28.8 split).
 *
 * WHY IT IS ITS OWN MODULE: the card's draft layer is a self-contained concern —
 * one window-scoped localStorage namespace, one JSON shape, one signature rule —
 * and it is the part with the most accumulated history (per-window keys, the
 * one-time legacy migration, the "already persisted" signature). Keeping it in
 * `note-widget.ts` buried it under the DOM building; it now reads on its own.
 *
 * Nothing here touches the DOM or the card's state machine: the widget owns the
 * debounce timer and the "is this content already in the wiki" decision, this
 * module owns only how a draft is stored, read, migrated and compared.
 *
 * @module dsh-tiddlywiki/client/note-widget-draft
 */
import { getLang, t } from './i18n.ts'
import { fetchStatus } from './status-cache.ts'
import { pad2 } from './format.ts'

/**
 * 旧版全局草稿 key（v0.18.0 及以前）。多标签页会互相覆盖，现在只作为一次性
 * 迁移来源读取：读到且本窗口还没有草稿 → 迁移到本窗口的 key 并删除它。
 */
const LEGACY_DRAFT_KEY = 'dsh-tw-note-draft-v1'
/** 本窗口草稿 key 前缀（`<前缀><窗口 id>`），窗口之间互不覆盖。 */
const DRAFT_KEY_PREFIX = 'dsh-tw-note-draft-v1:'
/** sessionStorage 里保存本标签页窗口 id 的 key（刷新后仍是同一个窗口）。 */
const DRAFT_WINDOW_ID_KEY = 'dsh-tw-note-window-id'
/** Draft auto-save debounce. */
export const DRAFT_DEBOUNCE_MS = 500

/**
 * 本窗口的草稿命名空间 id：优先取 sessionStorage 里的随机 id（同一标签页刷新后
 * 仍是同一个窗口 → 自己的草稿静默恢复）；sessionStorage 不可用时退化为「本次
 * 加载一个随机 id」（刷新后会被当成「其它窗口的草稿」，恢复时给出提示而不是
 * 静默覆盖）。
 */
const DRAFT_WINDOW_ID: string = (() => {
  try {
    const existing = sessionStorage.getItem(DRAFT_WINDOW_ID_KEY)
    if (existing !== null && existing.length > 0) return existing
    const created = Math.random().toString(36).slice(2, 10)
    sessionStorage.setItem(DRAFT_WINDOW_ID_KEY, created)
    return created
  } catch {
    return Math.random().toString(36).slice(2, 10)
  }
})()

export interface Draft { text: string; title: string; tags: string[]; savedAt: number; windowId?: string }

/** 读取结果：draft = 草稿本体；foreign = 不是本窗口写的（迁移/跨窗口）。 */
export interface DraftHit { draft: Draft; foreign: boolean }

function draftKey(): string {
  return `${DRAFT_KEY_PREFIX}${DRAFT_WINDOW_ID}`
}

function parseDraft(raw: string | null): Draft | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Partial<Draft>
    if (typeof parsed.text !== 'string' || typeof parsed.title !== 'string') return null
    return {
      text: parsed.text,
      title: parsed.title,
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === 'string') : [],
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      windowId: typeof parsed.windowId === 'string' ? parsed.windowId : undefined,
    }
  } catch {
    return null
  }
}

function readDraftFrom(key: string): Draft | null {
  try {
    return parseDraft(localStorage.getItem(key))
  } catch {
    return null
  }
}

/**
 * 读取本窗口草稿。本窗口 key 为空时尝试迁移旧全局 key（一次性：迁移后删除旧
 * key）。返回 null = 没有任何草稿；foreign=true = 草稿来源不是本窗口（旧 key
 * 迁移过来，或 sessionStorage 不可用时窗口 id 变了），调用方需要给出可见提示。
 */
export function loadDraft(): DraftHit | null {
  const own = readDraftFrom(draftKey())
  if (own !== null) {
    return { draft: own, foreign: own.windowId !== undefined && own.windowId !== DRAFT_WINDOW_ID }
  }
  const legacy = readDraftFrom(LEGACY_DRAFT_KEY)
  if (legacy === null) return null
  // 旧 key 一次性迁移：补上本窗口标记写进本窗口 key，然后删除旧 key。
  const migrated: Draft = { ...legacy, windowId: DRAFT_WINDOW_ID }
  persistDraft(migrated)
  try { localStorage.removeItem(LEGACY_DRAFT_KEY) } catch { /* ignore */ }
  return { draft: migrated, foreign: true }
}

/** 采纳草稿（标记为本窗口所有），避免每次打开都重复提示「来自其它窗口」。 */
export function adoptDraft(draft: Draft): void {
  persistDraft({ ...draft, windowId: DRAFT_WINDOW_ID })
}

export function persistDraft(draft: Draft): void {
  try { localStorage.setItem(draftKey(), JSON.stringify({ ...draft, windowId: DRAFT_WINDOW_ID })) } catch { /* storage unavailable */ }
}

export function clearDraft(): void {
  try { localStorage.removeItem(draftKey()) } catch { /* ignore */ }
}

/**
 * 内容签名（标题 + 正文 + 标签）：用来判断「这份内容是不是已经写进 wiki 了」。
 * 只做相等比较，不是哈希——不做安全用途（v0.19.1）。
 */
export function draftSignature(title: string, text: string, tags: string[]): string {
  return `${title}\u0000${text}\u0000${tags.join('\u0001')}`
}

/** Default note title: `YYYY-MM-DD HH:mm`. */
export function timestampTitle(date = new Date()): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/**
 * Compact relative time for the recent picker (zh: "3小时前" / en: "3 h ago").
 *
 * 日期兜底（≥30 天）也走当前语言（v0.30.13）：此前硬编码 `zh-CN`，英文界面下
 * 最近列表会出现两种语言混排。 */
export function relativeTime(iso: string | null): string {
  if (iso === null) return ''
  const ms = new Date(iso).getTime()
  if (Number.isNaN(ms)) return ''
  const diff = Date.now() - ms
  const min = Math.floor(diff / 60_000)
  if (min < 1) return t('note.relJustNow')
  if (min < 60) return t('note.relMinutes', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('note.relHours', { n: hr })
  const day = Math.floor(hr / 24)
  if (day < 30) return t('note.relDays', { n: day })
  return new Date(ms).toLocaleDateString(getLang() === 'zh' ? 'zh-CN' : 'en-US')
}

/** The default tag for a new note (settings `note.tag`).
 *
 *  Reads the shared, TTL-cached `/status` projection rather than a private copy
 *  of the `ui.*` shape (v0.22.8 — this was one of three duplicates). */
export async function fetchDefaultTag(): Promise<string> {
  const status = await fetchStatus()
  return typeof status?.note?.tag === 'string' && status.note.tag.length > 0 ? status.note.tag : 'inbox'
}

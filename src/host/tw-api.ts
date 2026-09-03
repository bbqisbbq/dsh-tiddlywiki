/**
 * TiddlyWeb REST client (design doc §5) — the ONLY way every writer reaches
 * the wiki (quick notes, agent tools, editor saves all go through the TW
 * service, D1), so there is never a second write path.
 *
 * ROUTES ARE EMPIRICALLY VERIFIED against tiddlywiki 5.4.1's core-server
 * (`core-server/server/routes/`):
 *   GET    /recipes/default/tiddlers.json[?exclude=...]  list (skinny)
 *   GET    /recipes/default/tiddlers/<title>             read one (404 absent)
 *   PUT    /recipes/default/tiddlers/<title>             write one (204)
 *   DELETE /bags/default/tiddlers/<title>                delete one (204)
 * Writes require the `X-Requested-With: TiddlyWiki` header (TW CSRF), which
 * this client always sends. Tags arrive as a whitespace-joined STRING and are
 * normalized to arrays here.
 *
 * SEARCH (R2): the server blocks arbitrary `filter=` queries with 403 unless
 * the exact filter is whitelisted in $:/config/Server/ExternalFilters. So
 * `search()` fetches the default listing WITH text (`?exclude=` a sentinel)
 * and matches locally — one request, no 403, no per-tiddler round-trips.
 *
 * @module dsh-tiddlywiki/host/tw-api
 */

/** A tiddler's readable fields (loose on purpose). */
export interface Tiddler {
  title: string
  text?: string
  tags?: string[]
  type?: string
  created?: string
  modified?: string
  /** Extra custom fields returned by the server are folded under `fields`. */
  fields?: Record<string, unknown>
  [key: string]: unknown
}

const REQUEST_TIMEOUT_MS = 10_000

/** TW's CSRF gate: writes must carry this header (TW's own UI always does). */
const CSRF_HEADER = { 'x-requested-with': 'TiddlyWiki' }

/** Sentinel `exclude` value: excludes nothing, so `text` stays in the list. */
const LIST_WITH_TEXT_EXCLUDE = '__dsh_tw_none__'

/** Split TW's whitespace-joined tags string into an array. */
function normalizeTags(tags: unknown): string[] | undefined {
  if (tags === undefined) return undefined
  if (Array.isArray(tags)) return tags.map(String)
  if (typeof tags === 'string') {
    const parts = tags.trim().split(/\s+/).filter(Boolean)
    return parts.length > 0 ? parts : []
  }
  return []
}

/** Normalize a raw server tiddler (tags string → array, unknown fields nested). */
function normalizeTiddler(raw: Record<string, unknown>): Tiddler {
  const out = { ...raw } as Tiddler
  const tags = normalizeTags(raw.tags)
  if (tags !== undefined) out.tags = tags
  return out
}

export class TiddlyWebClient {
  constructor(private readonly baseUrl: string) {}

  private async request(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  }

  /** GET /status → { username, anonymous, space, tiddlywiki_version, ... }. */
  async status(): Promise<Record<string, unknown>> {
    const res = await this.request('/status')
    if (!res.ok) throw new Error(`TiddlyWeb /status HTTP ${res.status}`)
    return res.json() as Promise<Record<string, unknown>>
  }

  /** Read one tiddler; undefined when it does not exist (404). */
  async get(title: string): Promise<Tiddler | undefined> {
    const res = await this.request(`/recipes/default/tiddlers/${encodeURIComponent(title)}`)
    if (res.status === 404) return undefined
    if (!res.ok) throw new Error(`TiddlyWeb GET /recipes/default/tiddlers/${title} HTTP ${res.status}`)
    return normalizeTiddler((await res.json()) as Record<string, unknown>)
  }

  /** Write (create or overwrite) one tiddler via PUT (204 on success). */
  async put(tiddler: Tiddler): Promise<Tiddler> {
    const title = tiddler.title
    const res = await this.request(`/recipes/default/tiddlers/${encodeURIComponent(title)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...CSRF_HEADER },
      body: JSON.stringify(tiddler),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`TiddlyWeb PUT /recipes/default/tiddlers/${title} HTTP ${res.status}: ${detail.slice(0, 300)}`)
    }
    return tiddler
  }

  /** Delete one tiddler via the bags route (204); a missing one is a no-op. */
  async delete(title: string): Promise<void> {
    const res = await this.request(`/bags/default/tiddlers/${encodeURIComponent(title)}`, {
      method: 'DELETE',
      headers: CSRF_HEADER,
    })
    if (res.status === 404) return
    if (!res.ok) throw new Error(`TiddlyWeb DELETE /bags/default/tiddlers/${title} HTTP ${res.status}`)
  }

  /**
   * List tiddlers via the default server filter. Arbitrary `filter=` queries
   * are blocked by the server (403) unless whitelisted, so callers needing a
   * subset should use search(); a supplied filter that is 403-blocked falls
   * back to the default listing.
   */
  async list(filter?: string, includeText = false): Promise<Tiddler[]> {
    const params = new URLSearchParams()
    if (includeText) params.set('exclude', LIST_WITH_TEXT_EXCLUDE)
    if (filter !== undefined && filter.length > 0) params.set('filter', filter)
    const query = params.toString()
    let res = await this.request(`/recipes/default/tiddlers.json${query.length > 0 ? `?${query}` : ''}`)
    if (!res.ok && res.status === 403 && filter !== undefined && filter.length > 0) {
      // Filter not whitelisted → refetch with the default filter.
      const retry = new URLSearchParams()
      if (includeText) retry.set('exclude', LIST_WITH_TEXT_EXCLUDE)
      const retryQuery = retry.toString()
      res = await this.request(`/recipes/default/tiddlers.json${retryQuery.length > 0 ? `?${retryQuery}` : ''}`)
    }
    if (!res.ok) throw new Error(`TiddlyWeb recipe list HTTP ${res.status}`)
    const data = (await res.json()) as Array<Record<string, unknown>> | { tiddlers?: Array<Record<string, unknown>> }
    const items = Array.isArray(data) ? data : (data.tiddlers ?? [])
    return items.map(normalizeTiddler)
  }

  /**
   * Search non-system tiddlers: one request (default listing with text) plus
   * local case-insensitive substring matching on title + text, optional exact
   * tags (AND), a `since` modified-time floor, an exact `type`, capped at
   * `limit`. Robust against the server's external-filter 403.
   */
  async search(query: string, options: SearchOptions = {}): Promise<{ items: Tiddler[]; total: number }> {
    const items = await this.list(undefined, true)
    const needle = query.toLowerCase()
    const sinceTime = parseSince(options.since)
    const wantedTags = [...(options.tags ?? []), options.tag].filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    const limit = options.limit ?? 30
    const matched = items.filter((t) => {
      if (t.title.startsWith('$:/')) return false
      if (!t.title.toLowerCase().includes(needle) && !(t.text ?? '').toLowerCase().includes(needle)) return false
      if (sinceTime !== undefined) {
        const modified = typeof t.modified === 'string' ? new Date(t.modified).getTime() : NaN
        if (Number.isNaN(modified) || modified < sinceTime) return false
      }
      if (options.type !== undefined && options.type.length > 0 && (t.type ?? 'text/vnd.tiddlywiki') !== options.type) return false
      if (wantedTags.length > 0) {
        const tags = (t.tags ?? []).map((tag) => tag.toLowerCase())
        if (!wantedTags.every((w) => tags.includes(w.toLowerCase()))) return false
      }
      return true
    })
    return { items: matched.slice(0, limit), total: matched.length }
  }

  /**
   * List the most recently modified NON-SYSTEM tiddlers, newest first
   * (missing/modified-less tiddlers sort to the tail). `since` keeps only
   * tiddlers modified at/after that instant.
   */
  async recent(limit = 15, since?: string): Promise<Tiddler[]> {
    const items = await this.list(undefined, true)
    const sinceTime = parseSince(since)
    const filtered = items.filter((t) => {
      if (t.title.startsWith('$:/')) return false
      if (sinceTime !== undefined) {
        const modified = typeof t.modified === 'string' ? new Date(t.modified).getTime() : NaN
        if (Number.isNaN(modified) || modified < sinceTime) return false
      }
      return true
    })
    filtered.sort((a, b) => {
      const am = typeof a.modified === 'string' ? new Date(a.modified).getTime() : 0
      const bm = typeof b.modified === 'string' ? new Date(b.modified).getTime() : 0
      return bm - am
    })
    return filtered.slice(0, Math.max(1, Math.min(limit, 200)))
  }

  /**
   * Distinct non-system tags with their tiddler counts, most-used first then
   * zh-locale. One skinny listing request (no text payloads).
   */
  async listTags(): Promise<Array<{ tag: string; count: number }>> {
    const items = await this.list(undefined, false)
    const map = new Map<string, number>()
    for (const t of items) {
      if (t.title.startsWith('$:/')) continue
      for (const tag of t.tags ?? []) {
        if (tag.startsWith('$:/')) continue
        map.set(tag, (map.get(tag) ?? 0) + 1)
      }
    }
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
      .map(([tag, count]) => ({ tag, count }))
  }
}

/** Optional search / recent filters. */
export interface SearchOptions {
  /** Every tag in this list must be present (AND semantics). */
  tags?: string[]
  /** Legacy single exact tag (AND with `tags`). */
  tag?: string
  /** ISO 8601 instant; keep only tiddlers modified at/after it. */
  since?: string
  /** Exact tiddler type (default type is "text/vnd.tiddlywiki"). */
  type?: string
  /** Max results (search default 30, capped 200). */
  limit?: number
}

/** Parse a `since` value into an epoch ms, or undefined when absent/invalid. */
function parseSince(since: string | undefined): number | undefined {
  if (typeof since !== 'string' || since.trim().length === 0) return undefined
  const ms = new Date(since.trim()).getTime()
  return Number.isNaN(ms) ? undefined : ms
}

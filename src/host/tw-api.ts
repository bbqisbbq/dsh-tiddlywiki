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
 * `search()` fetches the TEXT-BEARING listing WITH text (TEXT_LIST_FILTER +
 * `?exclude=` a sentinel, whitelist self-healed on first 403) and matches
 * locally — one request, no 403, no per-tiddler round-trips, and binary
 * tiddlers (images etc.) never ship their base64 payload (v0.16.20).
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

/**
 * Recipe-list filter that keeps ONLY text-bearing tiddlers (notes): no `type`
 * field at all, or a `text/*` type. Binary tiddlers (images/audio/video/fonts/
 * PDF/zip…) carry their payload as a base64 `text` field — on a big wiki (e.g.
 * thousands of scanned book pages) the full listing serializes 500+MB of base64
 * and times every agent read out. This filter drops them SERVER-SIDE so the
 * listing stays ~6MB (v0.16.20, verified on a 2418-tiddler wiki:
 * 515MB/17s → 6MB/0.3s).
 *
 * TW 5.4.1 filter facts that matter here (all verified empirically):
 * - `prefix`/`match` operators match the TITLE only — field matching needs
 *   `regexp:<field>` / `field:<field>`.
 * - `[has[type]]` = "has a non-empty type field"; `[has:type[]]` is a DIFFERENT
 *   call (suffix "type" + empty operand) that matches everything.
 * - space-separated operations UNION (no prefix = "or"); `+` means
 *   intersection.
 * - negated `regexp:type`/`field:type` DROP type-less tiddlers (their field
 *   string is null), so "exclude binary" must be written as the positive
 *   "no type OR text-ish" union below.
 *
 * FILENAME BUDGET (Windows, verified): the whitelist tiddler below is stored
 * as a .tid file whose name contains the ENTIRE filter string, so the filter
 * must stay short — a ~180-char filter produced a ~217-char filename that
 * broke `git add` on Windows ("Filename too long", MAX_PATH) and killed the
 * auto-committer. 86 chars keeps the file at ~123 chars even on a deep wiki
 * path. (Consequence: application/json tiddlers are not searchable — on this
 * wiki there are none, and they are config/data tiddlers, not notes.)
 */
export const TEXT_LIST_FILTER = [
  '[all[tiddlers]!is[system]!has[type]]',
  '[all[tiddlers]!is[system]regexp:type[(?i)^text/]]',
].join(' ')

/**
 * 真正「没有 type 字段」的条目（v0.19.1）。
 *
 * 必须靠过滤器判定：TW 服务端在 listing 与单条 GET 里都会给无 type 的条目
 * **补上** `text/vnd.tiddlywiki`（`tiddlerFields.type = tiddlerFields.type ||
 * "text/vnd.tiddlywiki"`），所以响应里的 `type` 永远非空，客户端无法区分
 * 「本来是 wikitext」与「压根没有 type」。过滤器在服务端按真实字段求值，返回
 * 的标题就是真的没有 type 的那些。串长 36 字符（白名单 tiddler 文件名 = 整个
 * filter，必须短）。
 */
export const MISSING_TYPE_FILTER = '[all[tiddlers]!is[system]!has[type]]'

/** TiddlyWeb blocks every non-default filter with 403 unless the EXACT filter
 *  string is whitelisted at `$:/config/Server/ExternalFilters/<filter>` = "yes".
 *  This client writes that tiddler once on 403 (self-heal, idempotent) and
 *  retries; the tiddler lives in the wiki and travels with its git history. */
function externalFilterWhitelistTitle(filter: string): string {
  return `$:/config/Server/ExternalFilters/${filter}`
}

/** Binary MIME type prefixes — their `text` field is base64 payload, not content. */
const BINARY_TYPE_PREFIXES = ['image/', 'audio/', 'video/', 'font/']
const BINARY_TYPE_EXACT = new Set([
  'application/octet-stream', 'application/pdf', 'application/zip', 'application/gzip',
  'application/x-gzip', 'application/x-7z-compressed', 'application/x-rar-compressed',
  'application/epub+zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

/** True when a tiddler's `type` marks it as binary (base64 in `text`). */
export function isBinaryType(type: string | undefined): boolean {
  if (typeof type !== 'string' || type.length === 0) return false
  return BINARY_TYPE_PREFIXES.some((p) => type.startsWith(p)) || BINARY_TYPE_EXACT.has(type)
}

/**
 * Parse a tiddler date field. TW's REST listing returns dates in the COMPACT
 * form (`20260101000000000` = YYYYMMDDhhmmssSSS, UTC), NOT ISO — the old code
 * fed that to `new Date()`, got Invalid Date, and therefore made every
 * `since`-filtered search/recent return nothing (v0.19.0). Both forms are
 * accepted here; undefined = absent/unparseable.
 */
export function parseTiddlerDate(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})$/.exec(value.trim())
  if (compact !== null) {
    return Date.UTC(
      Number(compact[1]), Number(compact[2]) - 1, Number(compact[3]),
      Number(compact[4]), Number(compact[5]), Number(compact[6]), Number(compact[7]),
    )
  }
  const ms = new Date(value.trim()).getTime()
  return Number.isNaN(ms) ? undefined : ms
}

/** Normalize a tiddler date field to ISO-8601 (for display), or null. */
export function toIsoDateString(value: unknown): string | null {
  const ms = parseTiddlerDate(value)
  return ms === undefined ? null : new Date(ms).toISOString()
}

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
  /** Preemptive Basic credentials, when the wiki runs in locked-down mode. */
  private readonly authHeader: string | undefined

  /**
   * Short-TTL cache for the TEXT-bearing listing. `search` / `recent` /
   * `listTags`-style calls each pull the whole listing (≈6MB on a 5k-tiddler
   * wiki); a burst of tool calls re-downloaded and re-parsed it every time.
   * Cached as a PROMISE so concurrent callers share one request, invalidated by
   * every write this client performs (v0.19.0).
   */
  private textListing: { at: number; value: Promise<Tiddler[]> } | undefined
  /**
   * Same short-TTL + in-flight-merge cache for the SKINNY listings (v0.19.1):
   * `/tags` (`list(TEXT_LIST_FILTER, false)`) and the lint title/dedup listings
   * each pull the whole title list; without a cache every `/status`-adjacent
   * poll and every lint re-downloaded + re-parsed it. Keyed by filter string
   * ('' = server default listing).
   */
  private readonly skinnyListings = new Map<string, { at: number; value: Promise<Tiddler[]> }>()
  private static readonly TEXT_LISTING_TTL_MS = 2_000

  /** Drop the listing caches — called after any write so reads never go stale. */
  private invalidateListing(): void {
    this.textListing = undefined
    this.skinnyListings.clear()
  }

  constructor(private readonly baseUrl: string, auth?: { username?: string; password?: string }) {
    const username = typeof auth?.username === 'string' ? auth.username : ''
    if (username.length > 0) {
      const password = typeof auth?.password === 'string' ? auth.password : ''
      this.authHeader = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
    }
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const headers: Record<string, string> = { ...((init?.headers as Record<string, string> | undefined) ?? {}) }
    // The plugin spawns TW with `readers`/`writers` whenever auth.username is
    // configured, so EVERY request (reads included) needs the credentials —
    // otherwise the whole client 401s. TW's BasicAuthenticator accepts a
    // preemptive Authorization header (no challenge round-trip needed).
    if (this.authHeader !== undefined) headers.authorization = this.authHeader
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
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

  /**
   * Render a tiddler (or raw wiki text) to an HTML fragment through TW's own
   * `/render` server route — the bundle the `render-route` seed installs.
   *
   * READ-ONLY, but the route is a POST (handler contract) and TW's server gates
   * POST behind the writer CSRF header, so the CSRF header is sent like a write.
   * Throws on 404 (`notFound`) so callers can distinguish "no such tiddler".
   */
  async render(body: { title?: string; text?: string; type?: string; contextTitle?: string; parseAsInline?: boolean }): Promise<string> {
    const res = await this.request('/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CSRF_HEADER },
      body: JSON.stringify(body),
    })
    if (res.status === 404) throw new Error('TiddlyWeb POST /render HTTP 404: tiddler not found')
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`TiddlyWeb POST /render HTTP ${res.status}: ${detail.slice(0, 200)}`)
    }
    return res.text()
  }

  /** Write (create or overwrite) one tiddler via PUT (204 on success). */
  async put(tiddler: Tiddler): Promise<Tiddler> {
    const title = tiddler.title
    const res = await this.request(`/recipes/default/tiddlers/${encodeURIComponent(title)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...CSRF_HEADER },
      body: JSON.stringify(tiddler),
    })
    this.invalidateListing()
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
    this.invalidateListing()
    if (res.status === 404) return
    if (!res.ok) throw new Error(`TiddlyWeb DELETE /bags/default/tiddlers/${title} HTTP ${res.status}`)
  }

  /**
   * List tiddlers via the default server filter. Arbitrary `filter=` queries
   * are blocked by the server (403) unless whitelisted, so callers needing a
   * subset should use search(); a supplied filter that is 403-blocked falls
   * back to the text-bearing filter.
   *
   * `includeText=true` returns only TEXT-BEARING tiddlers WITH their `text`
   * (never the base64 payloads of binary tiddlers): on 403 the whitelist
   * tiddler for TEXT_LIST_FILTER is written once and the request retried
   * (self-heal); if that write fails (read-only wiki) it degrades to the
   * skinny listing (title/tags matchable, empty snippets).
   */
  async list(filter?: string, includeText = false): Promise<Tiddler[]> {
    if (!includeText) {
      // Skinny listings share the short-TTL promise cache (v0.19.1): `/tags` and
      // the lint title listings are re-requested by every poll/lint, and each
      // miss transferred + parsed the whole title list.
      const key = filter ?? ''
      const cached = this.skinnyListings.get(key)
      if (cached !== undefined && Date.now() - cached.at < TiddlyWebClient.TEXT_LISTING_TTL_MS) return cached.value
      const pending = this.fetchListing(filter)
      this.skinnyListings.set(key, { at: Date.now(), value: pending })
      pending.catch(() => { if (this.skinnyListings.get(key)?.value === pending) this.skinnyListings.delete(key) })
      return pending
    }
    const explicit = filter !== undefined && filter.length > 0
    // Explicit filter: the caller asked for a SPECIFIC set — never silently
    // answer with a different one (the old code fell back to TEXT_LIST_FILTER,
    // i.e. it returned set B for a request of set A).
    if (explicit) return this.fetchTextListing(filter as string, false)
    const cached = this.textListing
    if (cached !== undefined && Date.now() - cached.at < TiddlyWebClient.TEXT_LISTING_TTL_MS) return cached.value
    const pending = this.fetchTextListing(TEXT_LIST_FILTER, true)
    this.textListing = { at: Date.now(), value: pending }
    // Never cache a rejection: the next call must retry the network.
    pending.catch(() => { if (this.textListing?.value === pending) this.textListing = undefined })
    return pending
  }

  /**
   * Fetch a text-bearing listing for `filter`, self-healing the external-filter
   * whitelist on 403. `allowSkinnyFallback` is true only for the plugin's OWN
   * default filter (TEXT_LIST_FILTER), where degrading to the skinny listing is
   * a documented last resort on a read-only wiki; an explicit caller filter
   * propagates the 403 instead.
   */
  private async fetchTextListing(filter: string, allowSkinnyFallback: boolean): Promise<Tiddler[]> {
    let res = await this.requestListWithText(filter)
    if (res.status === 403) {
      await this.ensureExternalFilterWhitelist(filter).catch(() => undefined)
      res = await this.requestListWithText(filter)
    }
    if (res.status === 403) {
      if (allowSkinnyFallback) return this.fetchListing(undefined)
      throw new Error(`TiddlyWeb 拒绝该 filter（未在 $:/config/Server/ExternalFilters 白名单中）：${filter.slice(0, 100)}`)
    }
    if (!res.ok) throw new Error(`TiddlyWeb recipe list HTTP ${res.status}`)
    return this.parseList(res)
  }

  /** GET the recipe listing WITHOUT text payloads (server default excludes `text`). */
  private async fetchListing(filter?: string): Promise<Tiddler[]> {
    const params = new URLSearchParams()
    if (filter !== undefined && filter.length > 0) params.set('filter', filter)
    const query = params.toString()
    let res = await this.request(`/recipes/default/tiddlers.json${query.length > 0 ? `?${query}` : ''}`)
    if (!res.ok && res.status === 403 && filter !== undefined && filter.length > 0) {
      // Not whitelisted: write the whitelist tiddler once and retry the SAME
      // filter. (The old code silently refetched the DEFAULT listing — the
      // caller asked for set A and got set B.)
      await this.ensureExternalFilterWhitelist(filter).catch(() => undefined)
      res = await this.request(`/recipes/default/tiddlers.json?${query}`)
      if (!res.ok && res.status === 403) {
        throw new Error(`TiddlyWeb 拒绝该 filter（未在 $:/config/Server/ExternalFilters 白名单中）：${filter.slice(0, 100)}`)
      }
    }
    if (!res.ok) throw new Error(`TiddlyWeb recipe list HTTP ${res.status}`)
    return this.parseList(res)
  }

  /** GET the recipe listing WITH text for a specific (whitelisted) filter. */
  private async requestListWithText(filter: string): Promise<Response> {
    return this.request(`/recipes/default/tiddlers.json?filter=${encodeURIComponent(filter)}&exclude=${LIST_WITH_TEXT_EXCLUDE}`)
  }

  /** Write `$:/config/Server/ExternalFilters/<filter>` = "yes" (idempotent). */
  private async ensureExternalFilterWhitelist(filter: string): Promise<void> {
    await this.put({ title: externalFilterWhitelistTitle(filter), text: 'yes' })
  }

  private async parseList(res: Response): Promise<Tiddler[]> {
    const data = (await res.json()) as Array<Record<string, unknown>> | { tiddlers?: Array<Record<string, unknown>> }
    const items = Array.isArray(data) ? data : (data.tiddlers ?? [])
    return items.map(normalizeTiddler)
  }

  /**
   * Search text-bearing tiddlers: one request (text-bearing listing with text)
   * plus local case-insensitive substring matching on title + text, optional
   * exact tags (AND), a `since` modified-time floor, an exact `type`, capped at
   * `limit`. Robust against the server's external-filter 403 (whitelist is
   * self-healed). Binary tiddlers (images/audio/…) are NOT in the listing, so
   * they can never match — a deliberate flood guard on big wikis.
   */
  /**
   * Search text-bearing tiddlers: one request (text-bearing listing with text,
   * short-TTL cached) plus local case-insensitive substring matching on title,
   * tags and text, optional exact tags (AND), a `since` modified-time floor, an
   * exact `type`, an exact custom `field`+`value` pair, and a `limit`.
   *
   * Results are RANKED (title hit > tag hit > body hit count, then newest
   * first) rather than returned in listing order, and `limit` is clamped to
   * 1…200 like the HTTP route always did (v0.19.0). Binary tiddlers are not in
   * the listing at all, so they can never flood the results.
   */
  async search(query: string, options: SearchOptions = {}): Promise<{ items: Tiddler[]; total: number }> {
    const items = await this.list(undefined, true)
    const needle = query.toLowerCase()
    const sinceTime = parseSince(options.since)
    const wantedTags = [...(options.tags ?? []), options.tag].filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    const limit = clampLimit(options.limit, 30)
    const fieldName = typeof options.field === 'string' && options.field.length > 0 ? options.field : undefined
    const fieldValue = typeof options.value === 'string' ? options.value : undefined
    const matched: Array<{ t: Tiddler; score: number }> = []
    for (const t of items) {
      if (t.title.startsWith('$:/')) continue
      const titleHit = needle.length > 0 && t.title.toLowerCase().includes(needle)
      const text = t.text ?? ''
      const textHit = needle.length > 0 && text.toLowerCase().includes(needle)
      const tagHit = needle.length > 0 && (t.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
      if (!titleHit && !textHit && !tagHit) continue
      if (sinceTime !== undefined) {
        const modified = parseTiddlerDate(t.modified)
        if (modified === undefined || modified < sinceTime) continue
      }
      if (options.type !== undefined && options.type.length > 0 && (t.type ?? 'text/vnd.tiddlywiki') !== options.type) continue
      if (wantedTags.length > 0) {
        const tags = (t.tags ?? []).map((tag) => tag.toLowerCase())
        if (!wantedTags.every((w) => tags.includes(w.toLowerCase()))) continue
      }
      // Custom-field match: exact value comparison on any field (note metadata
      // such as `q`, `due`, `clip-url` is not part of title/text, so it used to
      // be unsearchable).
      if (fieldName !== undefined) {
        const actual = t[fieldName]
        if (typeof actual !== 'string') continue
        if (fieldValue !== undefined && actual !== fieldValue) continue
      }
      let score = 0
      if (titleHit) score += 6
      if (tagHit) score += 3
      if (needle.length > 0) score += Math.min(countOccurrences(text.toLowerCase(), needle), 5)
      matched.push({ t, score })
    }
    matched.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return modifiedAt(b.t) - modifiedAt(a.t)
    })
    return { items: matched.slice(0, limit).map((entry) => entry.t), total: matched.length }
  }

  /**
   * List the most recently modified TEXT-BEARING (non-system, non-binary)
   * tiddlers, newest first (missing/modified-less tiddlers sort to the tail).
   * `since` keeps only tiddlers modified at/after that instant. Binary
   * attachments never appear — a book import touching hundreds of images must
   * not crowd the "最近修改" list.
   */
  async recent(limit = 15, since?: string): Promise<Tiddler[]> {
    const items = await this.list(undefined, true)
    const sinceTime = parseSince(since)
    const filtered = items.filter((t) => {
      if (t.title.startsWith('$:/')) return false
      if (sinceTime !== undefined) {
        const modified = parseTiddlerDate(t.modified)
        if (modified === undefined || modified < sinceTime) return false
      }
      return true
    })
    filtered.sort((a, b) => modifiedAt(b) - modifiedAt(a))
    return filtered.slice(0, Math.max(1, Math.min(limit, 200)))
  }

  /**
   * Distinct non-system tags with their tiddler counts, most-used first then
   * zh-locale. One skinny listing request (no text payloads).
   */
  async listTags(): Promise<Array<{ tag: string; count: number }>> {
    // TEXT_LIST_FILTER (server-side, whitelist self-healed) so a tag that only
    // hangs off binary attachments is not counted as a knowledge-base tag
    // (v0.19.0 — the unfiltered skinny listing included image/book-page tags).
    const items = await this.list(TEXT_LIST_FILTER, false)
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
  /** Custom field name to filter on (exact match on the field's string value). */
  field?: string
  /** Required value for `field` (omit to require only that the field exists). */
  value?: string
  /** Max results (default 30, capped 200). */
  limit?: number
}

/** Clamp a caller-supplied limit into 1…200 (default when absent/invalid). */
export function clampLimit(limit: unknown, fallback: number): number {
  const value = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : fallback
  return Math.max(1, Math.min(value, 200))
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/** `modified` as epoch ms (0 when absent/unparseable) — for result ranking. */
function modifiedAt(tiddler: Tiddler): number {
  return parseTiddlerDate(tiddler.modified) ?? 0
}

/** Parse a `since` value into an epoch ms, or undefined when absent/invalid. */
function parseSince(since: string | undefined): number | undefined {
  if (typeof since !== 'string' || since.trim().length === 0) return undefined
  const ms = new Date(since.trim()).getTime()
  return Number.isNaN(ms) ? undefined : ms
}

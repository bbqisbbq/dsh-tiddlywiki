/**
 * Pure helpers shared by the DSH routes (v0.30.9: **pure code move** out of
 * `routes.ts`, bodies unchanged).
 *
 * WHY: `routes.ts` had grown to ~1400 lines because the seven note-area
 * handlers, the wechat/session/agent handlers AND a dozen module-level helpers
 * all lived in one file. The helpers have no dependency on `registerRoutes`'s
 * closure (only on `write-policy` / `tw-api` / `text-util`), so they move out
 * first — and `routes.ts` re-exports the public three
 * (`redactRemoteUrl`, `redactLogLines`, `openInTwEditor`) verbatim, because
 * `admin-secrets.ts`, `index.ts`, the selftest and the guards import them from
 * there.
 *
 * @module dsh-tiddlywiki/host/routes-helpers
 */
import { basename } from 'node:path'
import type { TiddlyWebClient } from './tw-api.ts'
import { formatTiddlerDate } from './tw-api.ts'
import { formatLocalMinute } from './text-util.ts'
import { assertNoConflict, buildWriteTiddler } from './write-policy.ts'

/** Tiddler type for quick-notes: Markdown, so the uploaded images/links and
 *  any Markdown in the note actually render in TW (a type-less tiddler is
 *  treated as plain wiki text and shows raw `![..]`/`[..]` instead). */
export const NOTE_TYPE = 'text/markdown'

export const DANGEROUS_UPLOAD_EXTENSIONS = new Set([
  '.html', '.htm', '.xhtml', '.shtml', '.hta', '.svg', '.xml', '.xsl', '.xslt',
  '.js', '.mjs', '.cjs', '.swf', '.htc',
])

/** Windows device names: `NUL.txt` cannot be created and makes the route 500. */
export const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * Sanitize an uploaded filename into a safe bare name (no path separators,
 * no `..`, no control characters). Returns '' when nothing usable remains.
 */
export function sanitizeUploadName(input: unknown): string {
  if (typeof input !== 'string') return ''
  let name = basename(input.trim().replace(/[\\/]+/g, '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  if (name.length === 0 || name === '.' || name === '..') return ''
  // Windows stores a trailing dot/space verbatim but never strips it, and
  // `extname('evil.html.')` is just `.` — so the extension denylist was
  // bypassable with `evil.html.` (v0.19.3). Canonicalize before the check.
  name = name.replace(/[. ]+$/, '')
  if (name.length === 0) return ''
  // `CON`, `NUL`, `COM1…` are not creatable on Windows — prefix instead of 500.
  if (WINDOWS_RESERVED_NAMES.test(name)) name = `_${name}`
  if (name.length > 160) name = name.slice(0, 160)
  return name
}

/**
 * Strip credentials embedded in a git remote URL (`https://user:token@host/x`)
 * before it reaches an unauthenticated HTTP response (v0.19.0). The token in a
 * remote URL is a real secret and `/status` is reachable without credentials.
 */
export function redactRemoteUrl(remote: string): string {
  return remote.replace(/\/\/[^/@\s]+@/g, '//***@')
}

/**
 * Redact secrets that can appear in the TW child's captured stdout/stderr log
 * (the spawn line carries `password=…`). Belt-and-braces on top of the
 * redaction in wiki.ts, because `/status` is unauthenticated.
 */
export function redactLogLines(logs: readonly string[]): string[] {
  return logs.map((line) => line
    .replace(/(password=)\S+/gi, '$1***')
    .replace(/(authorization:\s*basic\s+)[A-Za-z0-9+/=]+/gi, '$1***'))
}

/** Max `limit` accepted by the list routes (bounded payloads, v0.19.4). */const MAX_LIST_LIMIT = 200

/** Max `limit` accepted by `/tags` — the tag list is a small wrapper around one
 *  full listing, so a larger cap is fine while still bounding the payload. */
export const MAX_TAGS_LIMIT = 500

/** Clamp a `limit` query param. `fallback` covers absent/unparsable values. */
export function readLimit(url: URL, fallback: number, max = MAX_LIST_LIMIT): number {
  const raw = url.searchParams.get('limit')
  // An EMPTY value (`?limit=`) means "not specified", not 0 (v0.23.5):
  // `Number('' ?? fallback)` is 0, which clamped up to 1 — `/recent?limit=`
  // returned a single tiddler instead of the default 15. `readOptionalLimit`
  // already treated empty as absent; the two now agree.
  if (raw === null || raw.trim().length === 0) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? Math.max(1, Math.min(Math.floor(parsed), max)) : fallback
}

/** Optional `limit` query param: `undefined` when absent/unparsable (= no cap). */
export function readOptionalLimit(url: URL, max: number): number | undefined {
  const raw = url.searchParams.get('limit')
  if (raw === null || raw.trim().length === 0) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return undefined
  return Math.max(1, Math.min(Math.floor(parsed), max))
}

/** Default note title: `YYYY-MM-DD HH:mm` (design doc D6). Shared formatter —
 *  session-summary.ts used to carry a second, byte-identical copy (v0.22.8). */
export function timestampTitle(date = new Date()): string {
  return formatLocalMinute(date)
}

/**
 * Open a tiddler in TW's NATIVE editor: save the tiddler (when text is
 * non-empty) as Markdown, reuse or create a DRAFT tiddler carrying
 * `draft.of`/`draft.title` (TW's story view renders drafts with the
 * EditTemplate — list.js: `isDraft && editTemplate`), and return the draft
 * title so the client can navigate the panel iframe to `#<draftTitle>`.
 * The draft carries the same `text/markdown` type as the note so saving it in
 * TW keeps Markdown (a draft without a matching type would overwrite the
 * note's type back to plain wiki text).
 */
export async function openInTwEditor(
  client: TiddlyWebClient,
  title: string,
  text: string,
  tags: string[] | undefined,
  options: { defaultTags?: string[]; expectedModified?: string; expectedRevision?: string | number; force?: boolean } = {},
): Promise<{ title: string; draftTitle: string }> {
  // One read drives everything: the write base (tags/custom fields/type), the
  // conflict check, and — when the body carried no text — the draft content.
  const existing = await client.get(title)
  assertNoConflict(title, existing, options)
  if (text.trim().length > 0) {
    // PRESERVE, do not blind-replace (v0.19.1): the old code PUT
    // `{title, text, tags, type}` with no read, wiping the note's custom fields
    // and (because `tags` defaulted to the note tag) its tags too.
    const { tiddler } = buildWriteTiddler(title, text, {
      existing,
      tags,
      defaultTags: options.defaultTags,
      agentTag: false,
    })
    await client.put(tiddler)
  }
  // Draft content: the provided text, else the existing tiddler's content.
  const draftText = text.trim().length > 0 ? text : (existing?.text ?? '')
  // Draft TYPE (v0.19.5): must match the note's real content type. Hardcoding
  // `text/markdown` meant that editing a wikitext note through the quick-note
  // surface downgraded it — TW's save copies the draft's fields back onto the
  // original, so `fields.type` flipped to markdown and the body started
  // rendering as source (`!` headings, `<$list>`, `[[links]]` all broke).
  const draftType = typeof existing?.type === 'string' && existing.type.length > 0 ? existing.type : NOTE_TYPE
  // Draft lookup. The canonical TW name is probed with a single GET first — the
  // old code always pulled the ENTIRE listing (megabytes on a big wiki) just to
  // find a draft; the listing stays as the fallback for a differently-named one.
  //
  // NEVER CLOBBER AN EXISTING DRAFT (v0.20.0): the v0.19.5 refactor inverted
  // this branch — when the canonical `Draft of "X"` already existed it wrote
  // straight into it, destroying whatever the user had typed in TW's editor,
  // and when it found a differently-named draft it discarded that title and
  // minted a fresh timestamped one (leaving an orphan). The pre-refactor code
  // was `free ? canonical : canonical+timestamp`; that is restored below, plus
  // reuse of any existing draft title found in the fallback listing.
  const canonical = `Draft of "${title}"`
  let draftTitle: string | undefined
  /** true = the draft tiddler already existed and owns unsaved user content. */
  let draftExists = false
  let canonicalFree: boolean | undefined
  try {
    canonicalFree = (await client.get(canonical)) === undefined
  } catch {
    canonicalFree = undefined
  }
  if (canonicalFree === true) {
    // Free canonical name → use it, so TW's own "save draft" bookkeeping lines up.
    draftTitle = canonical
  } else {
    // Canonical draft exists (or the probe failed): reuse an existing draft of
    // this note when there is one, otherwise take a timestamped name so the
    // existing draft is preserved.
    try {
      const items = await client.list(undefined, false)
      for (const item of items) {
        if (item['draft.of'] === title && typeof item.title === 'string') {
          draftTitle = item.title
          draftExists = true
          break
        }
      }
    } catch {
      /* fall back to a fresh draft */
    }
    if (draftTitle === undefined) draftTitle = `${canonical} ${Date.now()}`
  }
  // WRITE THE BODY ONLY WHEN IT IS OURS TO WRITE (v0.22.8).
  //
  // The v0.20.0 fix stopped the code from minting a fresh draft title over an
  // existing one — but it still PUT `draftText` into whatever draft it had just
  // REUSED, and that is the destructive half. `draftText` is the caller's text
  // or the note's SAVED body, while a reused draft holds whatever the user has
  // typed into TW's native editor and not yet saved; overwriting it silently
  // discards that. Reachable without any exotic setup: open 快速笔记 (a
  // minute-precision title), type, close the popup, reopen within the same
  // minute — same title, empty caller text, and the draft is blanked.
  //
  // So: a draft we are CREATING is ours to fill; a draft we are REUSING is only
  // overwritten when the caller explicitly supplied text (the quick-note card's
  // content is the source of truth then, and it was just saved to the note
  // above). With no text, the existing draft is left exactly as the user left it.
  //
  // Draft TIMESTAMPS (v0.22.10): TW's save rebuilds the note as
  // `new $tw.Tiddler(getCreationFields(), draft, {title}, getModificationFields())`
  // — the DRAFT's fields win over the freshly generated creation fields, so
  // whatever `created` the draft carries becomes the note's `created` after the
  // user saves. A draft without it therefore resets the note's creation instant
  // to "now"; carrying the note's own `created` keeps it. This mirrors TW's own
  // draft seeding (`handleNewTiddlerEvent` merges `getCreationFields()`,
  // `existingTiddler`, then `getModificationFields()`), so the draft ends up with
  // the NOTE's created and a fresh modified.
  if (!draftExists || text.trim().length > 0) {
    const draftCreated = typeof existing?.created === 'string' && existing.created.trim().length > 0
      ? existing.created
      : undefined
    await client.put({
      title: draftTitle,
      text: draftText,
      'draft.of': title,
      'draft.title': title,
      type: draftType,
      ...(draftCreated !== undefined ? { created: draftCreated } : {}),
      // Written "now" — the draft IS new content. `put()` would otherwise fall
      // back to copying `created`, labelling a just-written draft with the note's age.
      modified: formatTiddlerDate(new Date()),
    })
  }
  return { title, draftTitle }
}

/**
 * Resolve note tags from the request body: `tags` array wins, then the legacy
 * single `tag` string. Returns **undefined** when the body asks for nothing —
 * the caller (`buildWriteTiddler`) then preserves the existing note's tags
 * (v0.19.1 data safety) or falls back to the configured default for new notes.
 * The old version always returned `[defaultTag]`, so re-saving an existing note
 * under its own title silently replaced its tags with the default.
 */
export function resolveTags(body: { tag?: unknown; tags?: unknown }): string[] | undefined {
  if (Array.isArray(body.tags)) {
    const tags = body.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim())
    if (tags.length > 0) return tags
  }
  if (typeof body.tag === 'string' && body.tag.trim().length > 0) {
    return body.tag.trim().split(/\s+/).filter(Boolean)
  }
  return undefined
}

/** Body fields accepted by the note routes for optimistic concurrency. */
export function conflictTokens(body: { expectedModified?: unknown; expectedRevision?: unknown; force?: unknown }): {
  expectedModified?: string
  expectedRevision?: string | number
  force?: boolean
} {
  return {
    ...(typeof body.expectedModified === 'string' && body.expectedModified.length > 0 ? { expectedModified: body.expectedModified } : {}),
    ...(typeof body.expectedRevision === 'string' || typeof body.expectedRevision === 'number'
      ? { expectedRevision: body.expectedRevision }
      : {}),
    ...(body.force === true ? { force: true } : {}),
  }
}


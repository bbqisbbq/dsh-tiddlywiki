/**
 * Workspace / project marking for agent-created notes (v0.24.0).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The injected prompt has always ASKED the model to tag new notes with the
 * current workspace name, and that is exactly the kind of housekeeping a model
 * stops doing after a few turns. The plugin can do it itself: a tool's
 * `execute(args, exec)` receives a `ToolRunContext`, whose `agent.id` is the
 * calling session, and `sessions.get(id).header.cwd` is that session's working
 * directory. So the project name is knowable at write time without asking
 * anyone — see `ToolsDeps.workspaceName`.
 *
 * TWO CARRIERS, ON PURPOSE (user decision 2026-09-20)
 * ---------------------------------------------------
 *   - tag `ws/<id>`     — clickable and groupable inside the TiddlyWiki UI;
 *   - field `workspace` — exact filtering through `tiddlywiki_search`'s existing
 *     `field`/`value` parameters, with zero tag-list pollution.
 * `id` is the canonical, sanitised project name and is identical in both.
 *
 * ⚠️ THE `ws/` PREFIX IS LOAD-BEARING. A bare `<name>` collides with real
 * business tags: on the author's wiki the workspace `dsh-tiddlywiki` already
 * names 2510 notes (imported book chapters), so an unprefixed workspace tag
 * would make "search inside my workspace" return those 2510 chapters — the
 * feature would be worse than useless. Do not "simplify" the prefix away.
 *
 * @module dsh-tiddlywiki/host/workspace
 */

/** Tag prefix for the workspace marker (`ws/<id>`). */
export const WORKSPACE_TAG_PREFIX = 'ws/'

/** Custom field carrying the canonical workspace id. */
export const WORKSPACE_FIELD = 'workspace'

/**
 * Directory basenames that are never a "project".
 *
 * Tagging every note `tmp` (or `users`) is pure noise AND useless for narrowing —
 * the tag would carry no information. Kept deliberately short and
 * lowercase-compared.
 *
 * KNOWN LIMITATION (documented, not a bug): these are *container* directory
 * names only. A session whose cwd IS the home directory ends with the login name
 * (`C:\Users\bbq` → `bbq`, `/home/me` → `me`), which is NOT matched here and
 * therefore yields `ws/<login>`. That bucket is coarse but truthful — it is
 * exactly where those notes were written, and the alternative (comparing against
 * `os.homedir()`) would drag a filesystem dependency into this pure module and
 * still miss a symlinked or volume-mounted home.
 */
const GENERIC_DIRS = new Set([
  '', 'home', 'users', 'tmp', 'temp', 'root', 'desktop', 'documents', 'downloads',
])

/**
 * Last path segment of a session cwd — the raw project name.
 * Undefined when there is nothing to take (missing, empty, or a bare root).
 *
 * ⚠️ A DRIVE ROOT MUST YIELD NOTHING (v0.24.0, found by
 * `scripts/verify-workspace.mjs`): stripping the trailing separator turns
 * `C:\` into the segment `C:`, which is a valid-looking name that would tag
 * every note in a drive-root session `ws/C:`. There is no project there, so the
 * only correct answer is undefined.
 */
export function workspaceNameFromCwd(cwd: unknown): string | undefined {
  if (typeof cwd !== 'string') return undefined
  const trimmed = cwd.trim().replace(/[\\/]+$/, '')
  if (trimmed.length === 0) return undefined
  const segments = trimmed.split(/[\\/]/).filter((s) => s.length > 0)
  const base = segments.length > 0 ? segments[segments.length - 1] ?? '' : ''
  if (base.length === 0) return undefined
  if (/^[A-Za-z]:$/.test(base)) return undefined // `C:` / `D:` — a bare drive root
  return base
}

/**
 * Canonicalise a raw project name into the workspace id, or undefined when it
 * cannot carry meaning.
 *
 * TiddlyWiki tags are whitespace-separated, and `[ ] { } | < > "` break tag and
 * filter syntax (the same set `isJunkTag()` treats as a write accident). Those
 * become `-`; everything else — CJK included — is left alone so the tag stays
 * recognisable in the UI.
 */
export function normalizeWorkspaceName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const cleaned = raw.trim()
    .replace(/[\s[\]{}|<>"$]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  if (cleaned.length === 0) return undefined
  if (GENERIC_DIRS.has(cleaned.toLowerCase())) return undefined
  return cleaned
}

/** The tag for a canonical workspace id. */
export function workspaceTagName(id: string): string {
  return `${WORKSPACE_TAG_PREFIX}${id}`
}

/** The `{id, tag}` marker for a session cwd, or undefined when unusable. */
export function workspaceMarkFromCwd(cwd: unknown): { id: string; tag: string } | undefined {
  const id = normalizeWorkspaceName(workspaceNameFromCwd(cwd))
  if (id === undefined) return undefined
  return { id, tag: workspaceTagName(id) }
}

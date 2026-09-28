/**
 * Path comparison keys (v0.28.0).
 *
 * WHY THIS IS ITS OWN MODULE: three places must agree on "is this the same
 * folder?" — the wiki registry (duplicate/nested entries), the repo grouping
 * (two wikis sharing one repository) and the farm's path-change detection. A
 * second copy of this rule is exactly the drift this repository keeps paying
 * for, so there is one function and everybody imports it.
 *
 * THE RULES
 * ---------
 *   - separators normalised to `/` (git prints forward slashes on Windows);
 *   - trailing separators dropped (`D:/notes/` === `D:/notes`);
 *   - **case-insensitive everywhere**, deliberately: on Windows and default
 *     macOS two paths differing only in case ARE the same folder, and no honest
 *     setup has two knowledge bases there.
 *
 * @module dsh-tiddlywiki/host/path-key
 */

/**
 * The comparison key for a path. NOT a path: never hand it to the filesystem —
 * on a case-sensitive filesystem a lowercased path may not exist.
 */
export function pathComparisonKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** True when `candidate` is strictly inside `parent` (both are absolute paths). */
export function isInsidePath(parent: string, candidate: string): boolean {
  const from = pathComparisonKey(parent)
  const to = pathComparisonKey(candidate)
  if (from.length === 0 || to.length === 0) return false
  return to.startsWith(`${from}/`)
}

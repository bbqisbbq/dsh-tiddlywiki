/**
 * Read a source module FAMILY as one text blob.
 *
 * Guards assert on source text (「接线」断言): "the route must still call X".
 * A pure file move would otherwise break them for no real reason, so a family
 * read — `<base>.ts` plus every `<base>-*.ts` sibling, concatenated in name
 * order — keeps the assertion about the RULE instead of about the PATH.
 *
 * Added in v0.28.8, when the big host/client modules were split (tools.ts →
 * tools*.ts, admin.ts → admin*.ts, …) and eight guards had to stop pinning
 * single filenames.
 *
 * @module scripts/lib/source-family
 */
import fs from 'node:fs'
import path from 'node:path'

/** Normalize CRLF so every guard regex sees one line-ending convention. */
const normalize = (text) => text.replace(/\r\n/g, '\n')

/**
 * Concatenate `<relBase>.ts` and `<relBase>-*.ts` (sorted) into one string.
 *
 * `relBase` is repo-relative and WITHOUT the extension, e.g. `src/host/admin`.
 * Missing files are skipped silently — a guard that needs a file to exist must
 * assert on its content, not on this helper.
 */
export function readFamily(repoRoot, relBase) {
  const base = path.basename(relBase)
  const dir = path.dirname(path.join(repoRoot, relBase))
  const names = fs.readdirSync(dir)
    .filter((n) => n === `${base}.ts` || (n.startsWith(`${base}-`) && n.endsWith('.ts')))
    .sort()
  return names
    .map((n) => `// ---- ${path.join(relBase, n).replace(/\\/g, '/')} ----\n${normalize(fs.readFileSync(path.join(dir, n), 'utf8'))}`)
    .join('\n')
}

/** Names of the files a `readFamily()` call covers (for error messages). */
export function familyFiles(repoRoot, relBase) {
  const base = path.basename(relBase)
  const dir = path.dirname(path.join(repoRoot, relBase))
  return fs.readdirSync(dir)
    .filter((n) => n === `${base}.ts` || (n.startsWith(`${base}-`) && n.endsWith('.ts')))
    .sort()
}

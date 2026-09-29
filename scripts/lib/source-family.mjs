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
  // ⚠️ 读空 = 断言静默全过（v0.30.4 硬化）。`<base>.ts` 被改名/误删时族文本会退化
  // 成空串，于是**反向断言**（`!family.includes(x)`）与 `assertNo(…)` 全部自动成立 ——
  // 那是本仓库最危险的失效模式（见常见坑「按文件位置锚定的守门」）。正向断言会红，
  // 所以只有一半方向会假绿，而那一半往往正是安全网。这里直接抛错：把静默变成红灯。
  if (!names.includes(`${base}.ts`)) {
    throw new Error(
      `readFamily: ${relBase}.ts 不存在（目录 ${dir}，候选 ${names.join(', ') || '(空)'}）` +
      ' —— 基名写错或文件被改名会让族读读空、让断言静默通过',
    )
  }
  return names
    .map((n) => `// ---- ${path.join(relBase, n).replace(/\\/g, '/')} ----\n${normalize(fs.readFileSync(path.join(dir, n), 'utf8'))}`)
    .join('\n')
}

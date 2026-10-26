/**
 * Ship the "split my wiki" skill into the user's skill root (v0.28.0).
 *
 * WHY A SKILL, AND WHY HERE
 * -------------------------
 * The feature the plugin needs to explain — "how do I split my existing wiki into
 * several" — is a multi-step conversation with a human, not a setting. DSH's
 * container for exactly that is a skill: the agent loads it on demand, it costs
 * nothing in the prompt budget when unused, and it lives in a directory the skill
 * provider already scans (`$DSH_HOME/skills`).
 *
 * The plugin CANNOT register a skill root (a cordis patch cannot compute install
 * paths), so the only zero-config path is writing the file into the user's root.
 *
 * NEVER CLOBBER ANYTHING THAT IS NOT OURS
 * ---------------------------------------
 * The shipped file carries a marker line (`dsh-tiddlywiki-skill:wiki-split`). This
 * installer writes only when the target is MISSING, IDENTICAL (no-op), or OURS
 * (marker present → update it). A file without the marker is left alone and the
 * result says so — the alternative (overwriting whatever is at that path) would
 * silently destroy a user's own skill the day they happen to pick our name.
 *
 * @module dsh-tiddlywiki/host/skill-install
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHomePath } from '../sdk.ts'

/** Directory name under the skill root (also the skill's stable identity). */
export const SPLIT_SKILL_DIR = 'dsh-tiddlywiki-wiki-split'

/** File name inside that directory (the skill provider's discovery contract). */
export const SKILL_FILE_NAME = 'SKILL.md'

/**
 * Marker proving a file at our target path is OURS. Present in the shipped
 * SKILL.md; a user who edits the skill can delete the line to take ownership
 * (and then the installer will never touch it again).
 */
export const SPLIT_SKILL_MARKER = 'dsh-tiddlywiki-skill:wiki-split'

/** Where the file lives once installed: `$DSH_HOME/skills/<dir>/SKILL.md`. */
export function defaultSkillRoot(): string {
  return dshHomePath('skills')
}

/**
 * Structural face over DSH's skill registry (v0.30.66) — no `@deepseek-ai` import.
 *
 * `ctx.skills.register()` keeps the skill **in memory**: it disappears when the
 * plugin unloads, it never touches the user's `$DSH_HOME`, and uninstalling
 * cannot leave a stale copy behind. That is strictly better than writing a file,
 * which is why the file path below is now only a FALLBACK for hosts that have no
 * skill registry.
 */
export interface SkillRegistryFace {
  register(skill: {
    name: string
    description: string
    whenToUse?: string
    content: string
    invocation?: { modelInvocable: boolean; userInvocable: boolean }
  }): () => void
}

/** A SKILL.md split into its frontmatter fields and body. */
export interface ParsedSkill {
  name: string
  description: string
  whenToUse?: string
  content: string
}

/**
 * Split a `SKILL.md` into `{name, description, whenToUse?, content}`.
 *
 * Hand-rolled on purpose: the only structured part we need is the four-line
 * frontmatter at the top, and pulling a YAML parser in for that would add a
 * runtime dependency to a plugin whose pitch is "no build surprises".
 * Tolerant by design — anything unexpected returns `undefined` and the caller
 * falls back to the file installer.
 */
export function parseSkillText(text: string): ParsedSkill | undefined {
  const normalised = text.replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalised)
  if (match === null) return undefined
  const front = match[1] ?? ''
  const field = (key: string): string | undefined => {
    const found = new RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(front)
    const value = found?.[1]
    return value === undefined ? undefined : value.trim()
  }
  const name = field('name')
  const description = field('description')
  if (name === undefined || name.length === 0 || description === undefined || description.length === 0) return undefined
  // 名字语法在这一步就拒：注册表的 `validateRuntimeSkill()` 也会抛，但那时已经
  // 进了 register() —— 我们宁可在解析阶段返回 undefined，让调用方回落，
  // 而不是把一个语法错误的名字送进去、再靠 try/catch 兜住。
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return undefined
  const content = normalised.slice(match[0].length).trim()
  if (content.length === 0) return undefined
  const whenToUse = field('whenToUse')
  return { name, description, ...(whenToUse !== undefined && whenToUse.length > 0 ? { whenToUse } : {}), content }
}

/**
 * Register the split-wiki skill **in memory** through the host's skill registry.
 *
 * Returns the registry's disposer, or `undefined` when the shipped text cannot be
 * parsed (the caller then falls back to writing the file). Never throws: a skill
 * that fails to register must not take startup down.
 */
export function registerSplitSkill(skills: SkillRegistryFace, text: string): (() => void) | undefined {
  const parsed = parseSkillText(text)
  if (parsed === undefined) return undefined
  try {
    return skills.register({ ...parsed, invocation: { modelInvocable: true, userInvocable: true } })
  } catch (err) {
    console.warn('[dsh-tiddlywiki] 拆库 skill 注册失败（改用文件安装）：', err)
    return undefined
  }
}

export interface SkillInstallResult {
  path: string
  /** `written` = created, `updated` = ours and changed, `kept` = left alone. */
  action: 'written' | 'updated' | 'kept' | 'failed'
  detail?: string
  error?: string
}

/**
 * Read the skill that ships inside this package.
 *
 * Two candidates because the same module runs from two places: `lib/index.js`
 * (published / loaded) has `skills/` as a SIBLING, while `src/host/*.ts` (tests
 * via tsx) sits two levels down. Returns undefined when neither exists.
 */
export async function readBundledSkillText(): Promise<string | undefined> {
  for (const url of [
    new URL('../skills/wiki-split/SKILL.md', import.meta.url),
    new URL('../../skills/wiki-split/SKILL.md', import.meta.url),
  ]) {
    try {
      return await readFile(fileURLToPath(url), 'utf8')
    } catch {
      /* try the next candidate */
    }
  }
  return undefined
}

/**
 * Install (or refresh) the split-wiki skill. Never throws: every problem comes
 * back as `action: 'failed'` with a message, because a skill that could not be
 * written must not take the plugin's startup down with it.
 */
export async function installSplitSkill(options: {
  /** Skill root (defaults to `$DSH_HOME/skills`). */
  root?: string
  /** The text to install (defaults to the file shipped in this package). */
  text?: string
} = {}): Promise<SkillInstallResult> {
  const root = options.root ?? defaultSkillRoot()
  const path = join(root, SPLIT_SKILL_DIR, SKILL_FILE_NAME)
  const text = options.text ?? await readBundledSkillText()
  if (text === undefined || text.trim().length === 0) {
    return { path, action: 'failed', error: '找不到随包提供的 SKILL.md（package 里缺 skills/wiki-split/SKILL.md）' }
  }
  let existing: string | undefined
  try {
    existing = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { path, action: 'failed', error: `读不到 ${path}：${err instanceof Error ? err.message : String(err)}` }
    }
  }

  if (existing !== undefined) {
    if (existing === text) return { path, action: 'kept', detail: '已是最新' }
    if (!existing.includes(SPLIT_SKILL_MARKER)) {
      return { path, action: 'kept', detail: '该路径已有你自己的文件（没有插件标记），未覆盖' }
    }
  }

  try {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, path)
  } catch (err) {
    return { path, action: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
  return existing === undefined
    ? { path, action: 'written', detail: '已安装「拆分知识库」skill' }
    : { path, action: 'updated', detail: '已更新到随包版本' }
}

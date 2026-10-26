/**
 * `.tid` 预览的**纯**部分：常量与解析（v0.32.0）。
 *
 * 为什么单独一个文件：`src/index.ts`（宿主 barrel）也要导出它们，而宿主包里绝不能
 * 出现 `react` 的导入 —— 所以把「不碰 UI 的半边」放在这里，`tid-preview.ts` 再引它。
 *
 * @module dsh-tiddlywiki/client/tid-parse
 */

/** 预览实现的稳定 id（元数据与正文必须用同一个 —— 宿主按 id 配对）。 */
export const TID_PREVIEW_ID = 'dsh-tiddlywiki-tid'

/** 认这两个后缀。`.tiddler` 是 TiddlyDesktop 的导出名，内容格式与 `.tid` 一致。 */
export const TID_EXTENSIONS = ['tid', 'tiddler'] as const

/** 正文要注入的 keyed 子槽（宿主约定，见 docs/development.md）。 */
export const TID_PREVIEW_SLOT = 'sidebar.right.tab.document'

export interface ParsedTid {
  /** frontmatter 里的 `title:`（没有就 undefined）。 */
  title?: string
  /** frontmatter 里的其它字段，按原顺序（`tags`、`created`、`modified`、自定义字段）。 */
  fields: Array<[string, string]>
  /** 空行之后的正文（wikitext）。 */
  text: string
}

/**
 * 内部/机械性字段：对「人看这个文件」没有信息量，摘要里折到一行小字里。
 *
 * `ws/*` 与 `agent-written` 其实是**标签值里的标记**，不是字段名 —— 见 `summarizeTid`。
 */
export const INTERNAL_FIELD_KEYS = ['revision', 'workspace', 'human-edited', 'agent-written', 'bag', 'list']

/** 摘要里单列出来的字段（其余进「另外 N 个字段」那一行）。 */
export const SUMMARY_FIELD_KEYS = ['created', 'modified', 'creator', 'modifier', 'type']

export interface TidSummary {
  /** 展示标题：`title:` 字段优先。 */
  title?: string
  /** 去掉内部标记后的标签。 */
  tags: string[]
  /** 人类可读的时间（优先 `modified`，其次 `created`）。 */
  time?: string
  /** 单列出来的字段（`created`/`modified`/`creator`/`modifier`/`type`），时间字段已格式化。 */
  known: Array<[string, string]>
  /** 折进「另外 N 个字段」的那些（内部字段 + 其余自定义字段）。 */
  other: Array<[string, string]>
}

/**
 * 把 TiddlyWiki 的 17 位时间戳（`YYYYMMDDHHmmssSSS`，UTC）变成 `YYYY-MM-DD HH:mm`。
 *
 * 不是 17 位数字就原样返回 —— 宁可显示原文，也不要把一个看不懂的值装作看懂了。
 */
export function formatTidStamp(value: string): string {
  const raw = value.trim()
  if (!/^\d{17}$/.test(raw)) return raw
  const [y, mo, d, h, mi] = [raw.slice(0, 4), raw.slice(4, 6), raw.slice(6, 8), raw.slice(8, 10), raw.slice(10, 12)]
  return `${y}-${mo}-${d} ${h}:${mi}`
}

/**
 * 把解析结果压成**给人看**的摘要。
 *
 * 规则（作者 2026-10-26 要求）：只单列 `title` / `tags` / 时间，其余（`revision`、`workspace`、
 * `human-edited`、`ws/*` 这类机械字段）折进一行小字 —— 预览器的第一眼应该看到**内容**，
 * 不是一堆元数据。
 */
export function summarizeTid(parsed: ParsedTid): TidSummary {
  const known: Array<[string, string]> = []
  const other: Array<[string, string]> = []
  let tags: string[] = []
  let created: string | undefined
  let modified: string | undefined
  for (const [key, value] of parsed.fields) {
    if (key === 'tags') {
      tags = value.split(/[\s,]+/).filter((tag) => tag.length > 0)
      continue
    }
    if (key === 'created') created = value
    if (key === 'modified') modified = value
    if (SUMMARY_FIELD_KEYS.includes(key)) {
      known.push([key, key === 'created' || key === 'modified' ? formatTidStamp(value) : value])
      continue
    }
    other.push([key, key === 'created' || key === 'modified' ? formatTidStamp(value) : value])
  }
  // 系统/机械标记不占版面：`ws/<项目>` 与 `agent-written` 只在「另外 N 个」里留个影子。
  const visibleTags = tags.filter((tag) => !tag.startsWith('ws/') && tag !== 'agent-written')
  const hiddenTags = tags.filter((tag) => !visibleTags.includes(tag))
  // 键名走英文：这是开发者可见的折叠行标签，客户端守门禁止中文字面量。
  if (hiddenTags.length > 0) other.push(['tags(hidden)', hiddenTags.join(' ')])
  const stamp = modified ?? created
  const time = stamp === undefined ? undefined : formatTidStamp(stamp)
  return {
    ...(parsed.title !== undefined && parsed.title.length > 0 ? { title: parsed.title } : {}),
    tags: visibleTags,
    ...(time !== undefined ? { time } : {}),
    known: known.filter(([key]) => key !== 'created' && key !== 'modified'),
    other,
  }
}

/**
 * 把一份 `.tid` 文件拆成「字段 + 正文」。
 *
 * `.tid` 格式：若干 `key: value` 行 → **一个空行** → 正文。没有空行时整份都当字段
 * （TW 自己也是这么判的）。**宽容**：解析不出任何字段就整份当正文，绝不因为格式怪
 * 就丢内容 —— 预览器丢内容比显示得难看严重得多。
 */
export function parseTidText(raw: unknown): ParsedTid {
  // BOM 先剥掉（v0.33.4）：带 BOM 的文件首行是 `\uFEFFtitle: X`，`^([^\s:][^:]*):` 匹配不上，
  // 于是"字段一条都没认出来"却被当成"全是字段"，整段内容被丢掉。
  const normalised = String(raw ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const splitAt = normalised.indexOf('\n\n')
  const head = splitAt < 0 ? normalised : normalised.slice(0, splitAt)
  const body = splitAt < 0 ? '' : normalised.slice(splitAt + 2)
  const fields: Array<[string, string]> = []
  let title: string | undefined
  let allLinesAreFields = head.trim().length > 0
  for (const line of head.split('\n')) {
    if (line.trim().length === 0) continue
    const match = /^([^\s:][^:]*):\s?(.*)$/.exec(line)
    if (match === null) {
      allLinesAreFields = false
      continue
    }
    const key = (match[1] ?? '').trim()
    const value = (match[2] ?? '').trim()
    if (key.length === 0) continue
    if (key === 'title') title = value
    else fields.push([key, value])
  }
  // 字段行一条都没认出来、也没有 `title:` ⇒ **整份**当正文，**不看 splitAt**（v0.33.4）：
  // 文件里有空行、但空行之前不是字段时（正文开头的 `.tiddler`、或 BOM 让 `title:` 失配），
  // 先前只按 `splitAt >= 0` 判，空行之前的整段内容被当成"字段"丢掉。
  if (fields.length === 0 && title === undefined) {
    return { fields: [], text: normalised }
  }
  // 没有空行、而且头段也不是"全是 `key: value`"的样子 ⇒ 同样整份当正文。
  if (splitAt < 0 && !allLinesAreFields) {
    return { fields: [], text: normalised }
  }
  return { ...(title !== undefined ? { title } : {}), fields, text: body }
}

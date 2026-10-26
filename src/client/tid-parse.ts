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
 * 把一份 `.tid` 文件拆成「字段 + 正文」。
 *
 * `.tid` 格式：若干 `key: value` 行 → **一个空行** → 正文。没有空行时整份都当字段
 * （TW 自己也是这么判的）。**宽容**：解析不出任何字段就整份当正文，绝不因为格式怪
 * 就丢内容 —— 预览器丢内容比显示得难看严重得多。
 */
export function parseTidText(raw: unknown): ParsedTid {
  const normalised = String(raw ?? '').replace(/\r\n/g, '\n')
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
  // 字段行一条都没认出来、或根本不是"全是字段"的样子 ⇒ 整份当正文。
  if (splitAt < 0 && (!allLinesAreFields || (title === undefined && fields.length === 0))) {
    return { fields: [], text: normalised }
  }
  return { ...(title !== undefined ? { title } : {}), fields, text: body }
}

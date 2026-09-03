/**
 * Lightweight Markdown syntax highlighter for the quick-note editor.
 *
 * The editor is the classic "highlighted textarea": a `<pre>` rendered BEHIND
 * a transparent-text `<textarea>` with identical metrics. To keep the two
 * layers perfectly aligned we NEVER change the user's text — every token is
 * only wrapped in a colored `<span class="md-*">`, so each line keeps its
 * exact characters and column widths. Leading whitespace (indentation) is
 * preserved as-is so list/heading/quote alignment survives.
 *
 * Coverage is deliberately pragmatic (a scratch-note editor, not CommonMark):
 * ATX headings, fenced code blocks, blockquotes, bullet + ordered + task
 * lists, horizontal rules, inline code, bold, italic, strikethrough, links
 * and images. HTML is escaped first, so the output is always safe to set as
 * `innerHTML` (no raw HTML from the user is ever executed).
 *
 * @module dsh-tiddlywiki/client/markdown
 */

/** Escape a raw source fragment for safe insertion into the overlay HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Inline token highlighting on ALREADY-ESCAPED text. Inline code spans are
 * first pulled out into placeholders so later passes (links/bold/italic) can
 * never reach inside them, then restored.
 */
function highlightInline(escaped: string): string {
  // Inline code spans are pulled out first so later passes never reach inside.
  const codeTokens: string[] = []
  let s = escaped.replace(/(`+)([^`]+?)\1/g, (_all, t: string, code: string) => {
    codeTokens.push(`<span class="md-code">${t}${code}${t}</span>`)
    return `\u0000${codeTokens.length - 1}\u0000`
  })

  // Images and links: keep the literal markdown text, color the pieces.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_a, alt: string, url: string) =>
    `<span class="md-image">![${alt}](</span><span class="md-url">${url}</span><span class="md-image">)</span>`)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_a, text: string, url: string) =>
    `<span class="md-link">[${text}](</span><span class="md-url">${url}</span><span class="md-link">)</span>`)

  // Bold spans are also protected (placeholders) so the later italic pass
  // cannot chew into their `**` delimiters (which are also single `*`).
  const boldTokens: string[] = []
  s = s.replace(/(\*\*|__)([^*_]+?)\1/g, (_a, d: string, text: string) => {
    boldTokens.push(`<span class="md-bold">${d}${text}${d}</span>`)
    return `\u0001${boldTokens.length - 1}\u0001`
  })

  s = s.replace(/(\*|_)([^*_]+?)\1/g, '<span class="md-italic">$1$2$1</span>')
  s = s.replace(/~~([^~]+?)~~/g, '<span class="md-strike">~~$1~~</span>')

  return s
    .replace(/\u0001(\d+)\u0001/g, (_a, i: string) => boldTokens[Number(i)] ?? '')
    .replace(/\u0000(\d+)\u0000/g, (_a, i: string) => codeTokens[Number(i)] ?? '')
}

/**
 * Match and return groups as a plain string array ('' for absent groups), or
 * null when the pattern does not match. Avoids noUncheckedIndexedAccess
 * friction on RegExpMatchArray indexing.
 */
function groups(re: RegExp, value: string): string[] | null {
  const m = value.match(re)
  if (m === null) return null
  return Array.from(m, (g) => g ?? '')
}

/** Highlight one non-fence line (leading whitespace preserved verbatim). */
function highlightLine(raw: string): string {
  const leadMatch = groups(/^(\s*)(.*)$/, raw)
  const lead = leadMatch === null ? '' : leadMatch[1]!
  const body = leadMatch === null ? raw : leadMatch[2]!
  if (body.length === 0) return raw

  // ATX heading: ## 标题
  const heading = groups(/^(#{1,6})(\s+)(.*)$/, body)
  if (heading !== null) {
    return `${lead}<span class="md-heading">${escapeHtml(heading[1]!)}${escapeHtml(heading[2]!)}</span>${highlightInline(escapeHtml(heading[3]!))}`
  }
  // Horizontal rule
  if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(body)) {
    return `${lead}<span class="md-hr">${escapeHtml(body)}</span>`
  }
  // Blockquote: > 内容
  const quote = groups(/^(>)( ?)(.*)$/, body)
  if (quote !== null) {
    return `${lead}<span class="md-quote">${escapeHtml(quote[1]!)}</span>${escapeHtml(quote[2]!)}${highlightInline(escapeHtml(quote[3]!))}`
  }
  // Task list item: - [x] 内容 / - [ ] 内容
  const task = groups(/^([-*+])(\s+)(\[[ xX]\])(\s+)(.*)$/, body)
  if (task !== null) {
    const checked = /\[[xX]\]/.test(task[3]!)
    return `${lead}<span class="md-bullet">${escapeHtml(task[1]!)}</span>${escapeHtml(task[2]!)}<span class="md-task${checked ? ' md-task-checked' : ''}">${escapeHtml(task[3]!)}</span>${escapeHtml(task[4]!)}${highlightInline(escapeHtml(task[5]!))}`
  }
  // Bullet list item
  const bullet = groups(/^([-*+])(\s+)(.*)$/, body)
  if (bullet !== null) {
    return `${lead}<span class="md-bullet">${escapeHtml(bullet[1]!)}</span>${escapeHtml(bullet[2]!)}${highlightInline(escapeHtml(bullet[3]!))}`
  }
  // Ordered list item: 1. 内容
  const ordered = groups(/^(\d+)([.)])(\s+)(.*)$/, body)
  if (ordered !== null) {
    return `${lead}<span class="md-number">${escapeHtml(ordered[1]!)}${escapeHtml(ordered[2]!)}</span>${escapeHtml(ordered[3]!)}${highlightInline(escapeHtml(ordered[4]!))}`
  }
  // Plain inline line
  return `${lead}${highlightInline(escapeHtml(body))}`
}

/**
 * Highlight full Markdown source into safe `<span>`-wrapped HTML. Line count
 * and per-line text (including whitespace) are preserved exactly.
 */
export function highlightMarkdown(src: string): string {
  const lines = src.split('\n')
  const out: string[] = []
  let inFence = false
  for (const rawLine of lines) {
    const fence = rawLine.match(/^\s*(```|~~~)\s*([\w-]*)\s*$/)
    if (fence !== null) {
      inFence = !inFence
      out.push(`<span class="md-fence">${escapeHtml(rawLine)}</span>`)
      continue
    }
    if (inFence) {
      out.push(`<span class="md-code-block">${escapeHtml(rawLine)}</span>`)
      continue
    }
    out.push(highlightLine(rawLine))
  }
  return out.join('\n')
}

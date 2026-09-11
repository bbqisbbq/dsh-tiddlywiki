/**
 * TiddlyWiki 渲染片段的白名单净化器（v0.19.1，安全）。
 *
 * 背景：`/render` 把 tiddler 正文渲染成 HTML 片段，客户端（回复流工具卡 +
 * 会话「知识库」Tab）用 `dangerouslySetInnerHTML` 注入 **DSH 同源页面**。
 * TW 的 wikitext/markdown 解析器只剥 `on*` 事件属性（`<script>` 会变成
 * `<safe-script>`），但 `<iframe src="javascript:…">`、`<a href="javascript:…">`、
 * `<form action="javascript:…">` 之类会**原样通过**（headless 实测）——一段
 * 写进 wiki 的正文就能在 DSH 页面里执行脚本（可调 `/dsh-tiddlywiki/*` 管理路由）。
 *
 * 因此所有要注入 DSH 页面的 TW 片段都必须先过这里。策略是**白名单 + 丢弃**，
 * 不是黑名单补丁：
 *   - 丢掉整棵子树：script/style/iframe/frame/frameset/object/applet/form/
 *     base/meta/link/noscript/template/svg/math/xmp/plaintext/listing/
 *     basefont/bgsound/title；
 *   - 丢掉任何 `on*` 属性、`srcdoc`、`srcset`；
 *   - URL 属性（href/src/xlink:href/action/poster/data/…）只允许
 *     http/https/mailto/tel、相对路径/锚点，以及栅格 `data:image/*`
 *     （`data:image/svg+xml` 与 `data:text/html` 一律拒绝）；
 *   - 属性值先做实体解码 + 去控制符再判 scheme，挡住 `&#106;avascript:`、
 *     `java\tscript:` 这类混淆；
 *   - 其它未知标签/属性原样保留（TW 片段大量使用 `tc-*`/`$`/`data-*`）。
 *
 * 纯字符串实现（不依赖 DOM）：host 侧在返回给浏览器之前净化，且能被
 * `scripts/verify-render-sanitizer.mjs` 在 Node 里逐条断言。
 *
 * @module dsh-tiddlywiki/host/sanitize
 */

/** 连内容一起丢掉的元素（其 innerText 也不可信，直接跳过到闭合标签之后）。 */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form',
  'base', 'meta', 'link', 'noscript', 'template', 'svg', 'math',
  'xmp', 'plaintext', 'listing', 'basefont', 'bgsound', 'title',
])

/** 自闭合（void）元素——不需要闭合标签。 */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
])

/** 需要做 scheme 检查的 URL 属性。 */
const URL_ATTRIBUTES = new Set([
  'href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'data',
  'dynsrc', 'lowsrc', 'background', 'cite', 'longdesc', 'usemap', 'manifest',
])

/** 直接丢弃的属性（不参与 URL 检查）。 */
const DROP_ATTRIBUTES = new Set(['srcdoc', 'srcset', 'formaction', 'action', 'ping'])

/** 允许的 URL scheme（其余带 scheme 的值一律拒绝）。 */
const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto', 'tel'])

/** 允许的 data: 图片 MIME（栅格；SVG 可携带脚本，拒绝）。 */
const ALLOWED_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)[;,]/i

/** HTML 实体解码（只覆盖判定 scheme 需要的那些；数字实体 + 关键命名实体）。 */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ''
    })
    .replace(/&#(\d+);?/g, (_m, dec: string) => {
      const code = Number.parseInt(dec, 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ''
    })
    .replace(/&(colon|tab|newline|sol|period);/gi, (m) => {
      const key = m.slice(1, -1).toLowerCase()
      return key === 'colon' ? ':' : key === 'tab' ? '\t' : key === 'newline' ? '\n' : key === 'sol' ? '/' : '.'
    })
    .replace(/&amp;/gi, '&')
}

/** 该属性值是否是安全的 URL（相对路径/锚点/白名单 scheme/栅格 data 图片）。 */
export function isSafeUrl(rawValue: string): boolean {
  // 去实体 + 去控制符/空白（浏览器解析 URL 时会丢弃这些，故先归一）。
  const value = decodeEntities(rawValue).replace(/[\u0000-\u0020\u007f\u00a0]+/g, '').trim()
  if (value.length === 0) return true
  if (value.startsWith('#') || value.startsWith('/') || value.startsWith('?') || value.startsWith('.')) return true
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(value)
  if (schemeMatch === null) return true // 相对 URL
  const scheme = (schemeMatch[1] ?? '').toLowerCase()
  if (scheme === 'data') return ALLOWED_DATA_IMAGE.test(value)
  return ALLOWED_SCHEMES.has(scheme)
}

/** 属性名是否允许保留。 */
function isSafeAttributeName(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower.startsWith('on')) return false // onclick / onerror / onload …
  if (DROP_ATTRIBUTES.has(lower)) return false
  return /^[a-z_:][a-z0-9_:.-]*$/i.test(name)
}

/**
 * 重新输出属性值时的转义：只去控制符、只转义双引号。
 *
 * ⚠️ 不要转义 `&`：源值里的 `&amp;` 是**已经实体化**的文本（TW 渲染输出），
 * 再转一次会变成 `&amp;amp;`，浏览器解码后 URL 里就多了一个字面 `&amp;`
 * （实测踩过：`?b=1&amp;c=2` 被改成 `?b=1&amp;amp;c=2`）。`"` 必须转义，
 * 否则单引号形式的属性值里的引号会逃出双引号上下文。
 */
function escapeAttr(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/"/g, '&quot;')
}

interface ParsedTag {
  /** 标签结束位置（`>` 之后）。 */
  end: number
  name: string
  closing: boolean
  selfClosing: boolean
  attrs: Array<{ name: string; value: string }>
}

/**
 * 解析 `<` 起始处的一个标签。返回 null 表示不是标签（当普通文本处理）。
 * 严格性重要：属性值支持双引号/单引号/无引号三种写法，未闭合的属性值
 * （例如 `<img src=x onerror="…>` 里带引号却没闭合）会被吞到 `>` 或字符串末尾，
 * 后续照样被丢弃，不会漏出可执行内容。
 */
function parseTag(html: string, start: number): ParsedTag | null {
  let i = start + 1
  if (i >= html.length) return null
  let closing = false
  if (html[i] === '/') {
    closing = true
    i++
  }
  const nameStart = i
  while (i < html.length && /[a-zA-Z0-9:_-]/.test(html[i] as string)) i++
  const name = html.slice(nameStart, i)
  if (name.length === 0) return null

  const attrs: Array<{ name: string; value: string }> = []
  for (;;) {
    while (i < html.length && /\s/.test(html[i] as string)) i++
    if (i >= html.length) return null
    const ch = html[i]
    if (ch === '>') return { end: i + 1, name, closing, selfClosing: false, attrs }
    if (ch === '/') {
      // `/` 只可能是自闭合标记
      i++
      while (i < html.length && /\s/.test(html[i] as string)) i++
      if (i < html.length && html[i] === '>') return { end: i + 1, name, closing, selfClosing: true, attrs }
      continue
    }
    const nameStart2 = i
    while (i < html.length && !/[\s=/>]/.test(html[i] as string)) i++
    const attrName = html.slice(nameStart2, i)
    if (attrName.length === 0) return null
    while (i < html.length && /\s/.test(html[i] as string)) i++
    let value = ''
    if (i < html.length && html[i] === '=') {
      i++
      while (i < html.length && /\s/.test(html[i] as string)) i++
      const quote = html[i]
      if (quote === '"' || quote === "'") {
        i++
        const valueStart = i
        while (i < html.length && html[i] !== quote) i++
        value = html.slice(valueStart, i)
        if (i < html.length) i++ // 吃掉收尾引号
      } else {
        const valueStart = i
        while (i < html.length && !/[\s>]/.test(html[i] as string)) i++
        value = html.slice(valueStart, i)
      }
    }
    attrs.push({ name: attrName, value })
  }
}

/** 从 `from` 起找到 `</name` 之后的位置（找不到 → 字符串末尾）。 */
function skipElement(html: string, from: number, name: string): number {
  const lower = html.toLowerCase()
  const needle = `</${name.toLowerCase()}`
  const close = lower.indexOf(needle, from)
  if (close < 0) return html.length
  const gt = html.indexOf('>', close + needle.length)
  return gt < 0 ? html.length : gt + 1
}

/**
 * 净化一个 TW 渲染片段：返回可以安全 `innerHTML` 的 HTML 字符串。
 * 未知标签/属性保留；危险元素整棵丢掉；危险属性丢掉；危险 URL 丢掉。
 */
export function sanitizeTwFragment(html: string): string {
  if (typeof html !== 'string' || html.length === 0) return ''
  const out: string[] = []
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) {
      out.push(html.slice(i))
      break
    }
    out.push(html.slice(i, lt))
    // 注释 / doctype / 处理指令：整体丢弃。
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end < 0 ? html.length : end + 3
      continue
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt)
      i = end < 0 ? html.length : end + 1
      continue
    }
    const tag = parseTag(html, lt)
    if (tag === null) {
      // 不是标签（例如 `a < b`）：按文本输出 `<`，继续扫描。
      out.push('&lt;')
      i = lt + 1
      continue
    }
    const name = tag.name.toLowerCase()
    if (DROP_WITH_CONTENT.has(name)) {
      i = tag.closing || tag.selfClosing || VOID_ELEMENTS.has(name)
        ? tag.end
        : skipElement(html, tag.end, name)
      continue
    }
    if (tag.closing) {
      if (!VOID_ELEMENTS.has(name)) out.push(`</${name}>`)
      i = tag.end
      continue
    }
    const safeAttrs: string[] = []
    for (const attr of tag.attrs) {
      if (!isSafeAttributeName(attr.name)) continue
      const lower = attr.name.toLowerCase()
      if (URL_ATTRIBUTES.has(lower) && !isSafeUrl(attr.value)) continue
      safeAttrs.push(`${attr.name}="${escapeAttr(attr.value)}"`)
    }
    const attrText = safeAttrs.length > 0 ? ` ${safeAttrs.join(' ')}` : ''
    out.push(VOID_ELEMENTS.has(name) || tag.selfClosing ? `<${name}${attrText}>` : `<${name}${attrText}>`)
    i = tag.end
  }
  return out.join('')
}

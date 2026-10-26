/**
 * `tiddlywiki_export` —— 把一篇笔记落成本地文件（v0.31.1）。
 *
 * WHY IT EXISTS
 * -------------
 * 「把这条笔记给我」是高频请求，此前只有两条路：助手把正文贴进回复（长笔记会撑爆
 * 回执预算，`get` 还得分页），或者让人类自己去 TW 里复制。DSH 有 `present` 工具
 * 可以把**文件**作为交付物给用户，但它需要一个真实文件 —— 于是中间这一步一直缺着。
 *
 * 这个工具就补这一步：读一篇笔记 → 按 `format` 落盘 → 回一条 `{path, bytes}`，
 * 助手紧接着 `present([{ path, description }])` 即可。
 *
 * 三条纪律（都不是可选项）
 * ------------------------
 * 1. **绝不覆盖**：同名文件已存在就报错。导出是**旁路产物**，静默覆盖等于毁掉人
 *    上一次导出的东西（与仓库的写策略同源：宁可报错，也不静默替换）。
 * 2. **系统条目拒绝**：`$:/plugins/dsh-tiddlywiki/` 里可能有密钥，走共享原语
 *    `isBlockedProxyTitle()`（铁律 #6 覆盖「所有把标题变成输出的路径」）。
 * 3. **读失败 ≠ 不存在**：`wiki.get()` 只有 404 回 undefined，其余抛错（铁律 #3）。
 *
 * @module dsh-tiddlywiki/host/tools-export
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { defineTool, dshHomePath } from '../sdk.ts'
import { isBlockedProxyTitle } from './proxy-guard.ts'
import { EXPORT_RESULT } from './tool-output-schemas.ts'
import { sessionIdOf } from './tools-support.ts'
import type { ExportResult, ToolEnv } from './tools-support.ts'
import type { Tiddler } from './tw-api.ts'

/** 支持的落盘格式。`md` 带 YAML frontmatter，`tid` 是 TiddlyWiki 原生格式。 */
const FORMATS = ['md', 'tid', 'json'] as const
type ExportFormat = (typeof FORMATS)[number]

/** 标题里不能进文件名的字符（Windows 更严，按它的规矩来）。 */
const FILENAME_UNSAFE = /[\\/:*?"<>|\u0000-\u001f]/g

/** 从 tiddler 的顶层键里挑出「字段」（TW REST 的字段就是顶层键）。 */
const RESERVED_KEYS = new Set(['title', 'text', 'created', 'modified', 'tags'])

function normalizeFormat(value: unknown): ExportFormat | undefined {
  if (value === undefined) return 'md'
  const raw = String(value).trim().toLowerCase()
  return (FORMATS as readonly string[]).includes(raw) ? (raw as ExportFormat) : undefined
}

/** 标题 → 安全的文件名主干（保留中文与空格以外的可读性）。 */
export function exportFileStem(title: string): string {
  const cleaned = title.replace(FILENAME_UNSAFE, '-').replace(/\s+/g, ' ').trim()
  const clipped = cleaned.length > 80 ? cleaned.slice(0, 80).trim() : cleaned
  return clipped.length === 0 ? 'note' : clipped
}

/** 把一篇 tiddler 渲染成目标格式的文本。 */
export function renderExport(tiddler: Tiddler, format: ExportFormat): string {
  // 自定义字段有两种存放形态：我们写进去的走**顶层键**，`wiki.get()` 读回来的可能
  // 折进 `fields`（工具层的 `pickFields()` 也是这个顺序：`t[name] ?? t.fields?.[name]`）。
  // 两处都收，顶层优先 —— 只收顶层会让「导出丢自定义字段」，只收 fields 会丢刚写入的。
  const merged: Record<string, string> = {}
  const nested = (tiddler as { fields?: Record<string, unknown> }).fields
  if (nested !== undefined && nested !== null) {
    for (const [key, value] of Object.entries(nested)) {
      if (!RESERVED_KEYS.has(key) && typeof value === 'string') merged[key] = value
    }
  }
  for (const [key, value] of Object.entries(tiddler)) {
    if (!RESERVED_KEYS.has(key) && typeof value === 'string') merged[key] = value
  }
  const fields = Object.entries(merged)
  const tags = (tiddler.tags ?? []).join(' ')
  if (format === 'json') return `${JSON.stringify(tiddler, null, 2)}\n`
  if (format === 'tid') {
    // TW 原生格式：字段行（`key: value`）→ 空行 → 正文。tags 用空格分隔。
    const lines = [`title: ${tiddler.title}`]
    if (tags.length > 0) lines.push(`tags: ${tags}`)
    if (typeof tiddler.created === 'string') lines.push(`created: ${tiddler.created}`)
    if (typeof tiddler.modified === 'string') lines.push(`modified: ${tiddler.modified}`)
    for (const [key, value] of fields) lines.push(`${key}: ${value}`)
    return `${lines.join('\n')}\n\n${tiddler.text ?? ''}`
  }
  // md：YAML frontmatter + 正文。tags 写成 YAML 列表，人和工具都好读。
  const fm = [`title: ${JSON.stringify(tiddler.title)}`]
  if ((tiddler.tags ?? []).length > 0) fm.push(`tags: [${(tiddler.tags ?? []).map((t) => JSON.stringify(t)).join(', ')}]`)
  if (typeof tiddler.created === 'string') fm.push(`created: ${JSON.stringify(tiddler.created)}`)
  if (typeof tiddler.modified === 'string') fm.push(`modified: ${JSON.stringify(tiddler.modified)}`)
  for (const [key, value] of fields) fm.push(`${key}: ${JSON.stringify(value)}`)
  return `---\n${fm.join('\n')}\n---\n\n${tiddler.text ?? ''}`
}

export function exportTool(env: ToolEnv) {
  const { requireWiki } = env
  return defineTool({
    name: 'tiddlywiki_export',
    description:
      '把一篇笔记导出成本地文件（md / tid / json），拿到路径后用 present 作为交付物给用户。同名文件已存在时拒绝（不覆盖）。',
    parameters: {
      title: { type: 'string', description: '笔记标题', required: true },
      format: { type: 'string', description: `落盘格式：${FORMATS.join(' / ')}（默认 md）` },
      dir: { type: 'string', description: '输出目录（绝对路径；默认会话工作目录，其次 $DSH_HOME/dsh-tiddlywiki/exports）' },
    },
    output: {
      schema: EXPORT_RESULT,
      render: (_args, value: ExportResult) => {
        if (value.notFound === true) return [{ type: 'text' as const, text: `没有叫「${value.title}」的笔记（${value.reason}）` }]
        const lines = [
          `已导出「${value.title}」→ ${value.path}`,
          `  格式 ${value.format} · ${value.bytes} 字节${value.wiki === undefined ? '' : ` · 知识库 ${value.wiki.label}（${value.wiki.id}）`}`,
          '  想把它交给用户：present([{ path: 上面这个路径, description: "…" }])',
        ]
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const title = String(args.title ?? '')
      const format = normalizeFormat(args.format)
      if (format === undefined) throw new Error(`tiddlywiki_export: format 只能是 ${FORMATS.join(' / ')}`)
      if (isBlockedProxyTitle(title)) {
        throw new Error(`tiddlywiki_export: 「${title}」属于插件自身命名空间（$:/plugins/dsh-tiddlywiki/），可能含密钥，工具层拒绝导出。`)
      }
      const sessionId = sessionIdOf(exec)
      const wiki = requireWiki(sessionId)
      const tiddler = await wiki.get(title)
      if (tiddler === undefined) {
        return { ok: false, title, path: '', format, bytes: 0, notFound: true, reason: `没有叫「${title}」的笔记` } satisfies ExportResult
      }
      const explicitDir = typeof args.dir === 'string' ? args.dir.trim() : ''
      let dir: string
      if (explicitDir.length > 0) {
        if (!isAbsolute(explicitDir)) throw new Error('tiddlywiki_export: dir 必须是绝对路径')
        dir = explicitDir
      } else {
        const cwd = sessionId === undefined ? undefined : env.deps.workspaceName?.(sessionId)
        dir = cwd !== undefined && cwd.length > 0 ? cwd : dshHomePath(join('dsh-tiddlywiki', 'exports'))
      }
      const path = join(dir, `${exportFileStem(title)}.${format}`)
      // 绝不覆盖（见模块头第 1 条）。
      if (existsSync(path)) {
        throw new Error(`tiddlywiki_export: ${path} 已经存在，未覆盖。换一个 dir、或先自己删掉/改名再导出。`)
      }
      const content = renderExport(tiddler, format)
      await mkdir(dir, { recursive: true })
      await writeFile(path, content, 'utf8')
      return { ok: true, title, path, format, bytes: Buffer.byteLength(content, 'utf8') } satisfies ExportResult
    },
  })
}

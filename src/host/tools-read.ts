/**
 * Read-side `tiddlywiki_*` tools: search / recent / list_tags / backlinks / lint.
 *
 * Split out of `tools.ts` in v0.28.8 — pure code move, bodies unchanged.
 *
 * @module dsh-tiddlywiki/host/tools-read
 */
import { defineTool } from '../sdk.ts'
import { MISSING_TYPE_FILTER, isBinaryType, parseTiddlerDate, toIsoDateString } from './tw-api.ts'
import type { Tiddler } from './tw-api.ts'
import { snippetOf } from './text-util.ts'
import { WORKSPACE_TAG_PREFIX } from './workspace.ts'
import {
  LINT_CHECKS,
  countRefsTo,
  expiryOf,
  isJunkTag,
  sessionIdOf,
  snippetAround,
  workspaceMarkFor,
} from './tools-support.ts'
import type {
  BacklinkResult,
  LintIssue,
  LintResult,
  RecentResult,
  SearchResult,
  TagListResult,
  ToolEnv,
} from './tools-support.ts'

export function searchTool(env: ToolEnv) {
  const { deps, requireWiki } = env
  // ── tiddlywiki_search ────────────────────────────────────────────────────
  return defineTool({
    name: 'tiddlywiki_search',
    description: '检索 TiddlyWiki 持久知识库：按关键词（可选 tags 数组 / since 修改时间 / type / field+value / limit）搜索非系统 tiddler，按相关度排序返回标题、标签、修改时间与命中处上下文片段。二进制 tiddler（图片等附件，正文为 base64）不参与检索。查询按空白切词、**所有词都必须命中**（AND）。若当前会话属于某个工作区，会**先在该工作区内检索、命中为空才自动扩大到全库**，回执会写明用了哪个范围（传了 tags / tag / field / value 时视为调用方已给出明确范围，不再自动收窄）。',
    parameters: {
      query: { type: 'string', description: '搜索关键词（大小写不敏感，子串匹配；命中标题/标签/正文，标题命中权重最高）。多词按空白切分，**全部词都要命中**才算（AND）——例如「部署 步骤」只返回同时含这两词的笔记' },
      tags: { type: 'array', items: { type: 'string' }, description: '可选：要求同时包含的标签（AND）' },
      tag: { type: 'string', description: '可选：单个精确标签（与 tags 同为 AND）' },
      since: { type: 'string', description: '可选：ISO 时间（如 2026-09-01 或 2026-09-01T00:00:00Z），只返回修改时间不早于它的 tiddler' },
      type: { type: 'string', description: '可选：精确 tiddler 类型。⚠️ 不传则不限类型（推荐）；插件默认把笔记写成 text/markdown，传 "text/vnd.tiddlywiki" 会把 Markdown 笔记全部排除' },
      field: { type: 'string', description: '可选：按自定义字段过滤（如 "q"、"clip-url"、"workspace"）' },
      value: { type: 'string', description: '可选：field 必须等于该值（不传则只要求该字段存在）' },
      limit: { type: 'integer', description: '可选：返回条数上限（默认 30，最大 200）' },
    },
    output: {
      render: (_args, value: SearchResult) => {
        const filters: string[] = []
        if (value.tags.length > 0) filters.push(`tags=${value.tags.join(',')}`)
        if (value.since !== null) filters.push(`since=${value.since}`)
        if (value.type !== null) filters.push(`type=${value.type}`)
        if (value.field !== null) filters.push(`field=${value.field}${value.value !== null ? `=${value.value}` : ''}`)
        // Say WHICH scope produced these hits (v0.24.0). Without this a narrowed
        // search that fell back reads exactly like an unnarrowed one, and a
        // workspace-only empty result reads as "the library has nothing".
        let scope = ''
        if (value.workspace !== null && value.scope === 'workspace') {
          scope = ` · 已在工作区 ${WORKSPACE_TAG_PREFIX}${value.workspace} 内缩小范围`
        } else if (value.workspace !== null && value.fellBack) {
          scope = ` · 工作区 ${WORKSPACE_TAG_PREFIX}${value.workspace} 内 0 条，已扩大到全库`
        }
        const head = `TiddlyWiki 搜索「${value.query}」${filters.length > 0 ? ` (${filters.join(' · ')})` : ''}：命中 ${value.total} 条${scope}（按相关度排序）。`
        const lines = [head]
        if (value.results.length === 0) lines.push('没有匹配的 tiddler。')
        for (const r of value.results) {
          const tags = r.tags.length > 0 ? ` [${r.tags.join(', ')}]` : ''
          const modified = r.modified !== null ? ` (${r.modified})` : ''
          lines.push(`- ${r.title}${tags}${modified}`)
          if (r.snippet.length > 0) lines.push(`  ${r.snippet}`)
        }
        if (value.total > value.results.length) lines.push(`（另有 ${value.total - value.results.length} 条未展开，可用 tiddlywiki_get 读取具体标题，或提高 limit）`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { query: string; tags?: string[]; tag?: string; since?: string; type?: string; field?: string; value?: string; limit?: number }, exec: unknown): Promise<SearchResult> => {
      const wiki = requireWiki(sessionIdOf(exec))
      const options = {
        tags: args.tags,
        tag: args.tag,
        since: args.since,
        type: args.type,
        field: args.field,
        value: args.value,
        limit: args.limit,
      }
      // Automatic workspace narrowing (v0.24.0, user request): look inside the
      // session's own project first, widen only when that finds nothing.
      // Skipped when the caller passed its own tag/field filter — those are an
      // explicit scope and must not be second-guessed.
      const explicitScope = (args.tags?.length ?? 0) > 0 || args.tag !== undefined
        || args.field !== undefined || args.value !== undefined
      const mark = explicitScope ? undefined : workspaceMarkFor(deps, exec)
      let narrowed: { items: Tiddler[]; total: number } | undefined
      if (mark !== undefined) {
        narrowed = await wiki.search(args.query, { ...options, tags: [mark.tag] })
      }
      const usedWorkspace = narrowed !== undefined && narrowed.total > 0
      const { items, total } = usedWorkspace ? narrowed as { items: Tiddler[]; total: number } : await wiki.search(args.query, options)
      return {
        query: args.query,
        tags: args.tags ?? [],
        since: args.since ?? null,
        type: args.type ?? null,
        field: args.field ?? null,
        value: args.value ?? null,
        total,
        workspace: mark?.id ?? null,
        scope: usedWorkspace ? 'workspace' : 'all',
        fellBack: mark !== undefined && !usedWorkspace,
        results: items.map((t) => ({ title: t.title, tags: t.tags ?? [], modified: toIsoDateString(t.modified), snippet: snippetAround(t.text ?? '', args.query) })),
      }
    },
  })
}

export function recentTool(env: ToolEnv) {
  const { requireWiki } = env
  // ── tiddlywiki_recent ────────────────────────────────────────────────────
  return defineTool({
    name: 'tiddlywiki_recent',
    description: '查看 TiddlyWiki 知识库最近修改的笔记（按修改时间倒序，排除系统 tiddler 与图片等二进制附件），返回标题、标签、修改时间与摘要。适合开工时快速了解近期动态。',
    parameters: {
      limit: { type: 'integer', description: '可选：返回条数（默认 15，最大 200）' },
      since: { type: 'string', description: '可选：只返回修改时间不早于该 ISO 时间的 tiddler' },
    },
    output: {
      render: (_args, value: RecentResult) => {
        const lines = [`TiddlyWiki 最近修改（最近 ${value.results.length} 条${value.since !== null ? `，since=${value.since}` : ''}）：`]
        if (value.results.length === 0) lines.push('暂无笔记。')
        for (const r of value.results) {
          const tags = r.tags.length > 0 ? ` [${r.tags.join(', ')}]` : ''
          lines.push(`- ${r.title}${tags} (${r.modified ?? '?'})`)
          if (r.snippet.length > 0) lines.push(`  ${r.snippet}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { limit?: number; since?: string }, exec: unknown): Promise<RecentResult> => {
      const wiki = requireWiki(sessionIdOf(exec))
      const items = await wiki.recent(args.limit ?? 15, args.since)
      return {
        since: args.since ?? null,
        results: items.map((t) => ({ title: t.title, tags: t.tags ?? [], modified: toIsoDateString(t.modified), snippet: snippetOf(t.text ?? '') })),
      }
    },
  })
}

export function listTagsTool(env: ToolEnv) {
  const { requireWiki } = env
  // ── tiddlywiki_list_tags ─────────────────────────────────────────────────
  return defineTool({
    name: 'tiddlywiki_list_tags',
    description: '列出 TiddlyWiki 知识库现有的非系统标签及各自计数（按使用次数降序），方便决定给笔记打什么 tag。默认最多返回 200 个（`limit` 可调，上限 1000），被截断时结果里会带 total/truncated。',
    parameters: {
      limit: { type: 'integer', description: '可选：最多返回多少个标签（按使用次数降序），默认 200，上限 1000。' },
    },
    output: {
      render: (_args, value: TagListResult) => {
        if (value.tags.length === 0) return [{ type: 'text', text: '知识库暂无标签。' }]
        const lines = [
          value.truncated
            ? `现有标签（共 ${value.total} 个，仅列出使用最多的 ${value.tags.length} 个，按使用次数降序）：`
            : `现有标签（${value.total} 个，按使用次数降序）：`,
        ]
        for (const t of value.tags) lines.push(`- ${t.tag} × ${t.count}`)
        if (value.truncated) lines.push(`（其余 ${value.total - value.tags.length} 个较少使用的标签未列出；需要时可提高 limit 重试）`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { limit?: number }, exec: unknown): Promise<TagListResult> => {
      const wiki = requireWiki(sessionIdOf(exec))
      const stats = await wiki.tagStats()
      const limit = typeof args.limit === 'number' && Number.isFinite(args.limit)
        ? Math.max(1, Math.min(Math.floor(args.limit), 1000))
        : 200
      const tags = stats.tags.slice(0, limit)
      return { count: tags.length, total: stats.total, truncated: tags.length < stats.total, tags }
    },
  })
}

export function backlinksTool(env: ToolEnv) {
  const { requireWiki } = env
  // ── tiddlywiki_backlinks ─────────────────────────────────────────────────
  return defineTool({
    name: 'tiddlywiki_backlinks',
    description: '查反向链接：哪些笔记引用了目标 tiddler（[[标题]] / [[显示|标题]] / {{标题}}），以及哪些笔记把它当作标签。用于知识图谱导航、改动前评估影响面。',
    parameters: {
      title: { type: 'string', description: '目标 tiddler 标题', required: true },
      includeTags: { type: 'boolean', description: '可选：是否把「以该标题为标签」的笔记也算作反向链接（默认 true）' },
      limit: { type: 'integer', description: '可选：最多返回多少条（默认 30，最大 200）' },
    },
    output: {
      render: (_args, value: BacklinkResult) => {
        const lines = [`「${value.title}」的反向链接：${value.total} 条（引用 ${value.linkCount} · 标签 ${value.tagCount}）`]
        if (value.items.length === 0) lines.push('没有任何笔记引用它。')
        for (const item of value.items) {
          lines.push(`- ${item.title}（${item.via === 'tag' ? '标签' : `${item.refs} 处引用`}）`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { title: string; includeTags?: boolean; limit?: number }, exec: unknown): Promise<BacklinkResult> => {
      const wiki = requireWiki(sessionIdOf(exec))
      const target = args.title.trim()
      if (target.length === 0) throw new Error('tiddlywiki_backlinks: title 不能为空')
      const includeTags = args.includeTags !== false
      const limit = Math.max(1, Math.min(args.limit ?? 30, 200))
      const items = await wiki.list(undefined, true)
      const hits: Array<{ title: string; refs: number; via: 'link' | 'tag'; modified: string | null }> = []
      let linkCount = 0
      let tagCount = 0
      for (const t of items) {
        if (t.title === target || t.title.startsWith('$:/')) continue
        const refs = countRefsTo(t.text ?? '', target)
        const tagged = includeTags && (t.tags ?? []).includes(target)
        if (refs === 0 && !tagged) continue
        if (refs > 0) linkCount++
        if (tagged) tagCount++
        hits.push({ title: t.title, refs, via: refs > 0 ? 'link' : 'tag', modified: toIsoDateString(t.modified) })
      }
      hits.sort((a, b) => b.refs - a.refs || a.title.localeCompare(b.title, 'zh'))
      return { title: target, total: hits.length, linkCount, tagCount, items: hits.slice(0, limit) }
    },
  })
}

export function lintTool(env: ToolEnv) {
  const { requireWiki } = env
  // ── tiddlywiki_lint ──────────────────────────────────────────────────────
  return defineTool({
    name: 'tiddlywiki_lint',
    description: '知识库体检（**只读，绝不改动任何笔记**）：找出垃圾/异常标签、指向不存在条目的死链、空笔记、疑似 Markdown 却缺 type 的笔记，以及**时效性内容**（已过期 / 待复查 / 建议复查的候选）。返回按类别分组的问题清单与建议；淘汰与否完全由你决定。',
    parameters: {
      limit: { type: 'integer', description: '可选：每类最多返回多少条示例（默认 10，最大 100）' },
      checks: { type: 'array', items: { type: 'string' }, description: '可选：只跑指定检查。合法值只有 junk-tags / broken-links / empty-notes / missing-type / stale；回执会列出**实际运行**的检查，无法识别的名字会被明确报出来（不会静默当成「库很干净」）' },
      staleAfterDays: { type: 'integer', description: '可选：`stale` 检查里「长期未改动」的阈值天数（默认 180）。只影响候选的判定，不影响 valid-until / review-after 的硬判定' },
    },
    output: {
      render: (_args, value: LintResult) => {
        const ran = value.checks.length > 0 ? value.checks.join(', ') : '（无）'
        const lines = [`知识库体检：扫描 ${value.scanned} 条文本笔记，已检查 ${ran}，发现 ${value.issues.reduce((sum, i) => sum + i.count, 0)} 个问题。`]
        if (value.unknownChecks.length > 0) {
          lines.push(`⚠️ 忽略了无法识别的检查名：${value.unknownChecks.join(', ')}——合法值只有 ${LINT_CHECKS.join(' / ')}`)
        }
        if (value.issues.length === 0) {
          lines.push(value.checks.length === 0
            ? '没有运行任何检查（请求的检查名全部无法识别）。'
            : '没有发现问题。')
        }
        for (const issue of value.issues) {
          lines.push(`- ${issue.kind}：${issue.count} 处 — ${issue.hint}`)
          for (const sample of issue.samples) lines.push(`    · ${sample}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { limit?: number; checks?: string[]; staleAfterDays?: number }, exec: unknown): Promise<LintResult> => {
      const wiki = requireWiki(sessionIdOf(exec))
      const limit = Math.max(1, Math.min(args.limit ?? 10, 100))
      // Validate `checks` against the real list (v0.25.0). The old `new Set(checks)`
      // silently ignored an unknown name, so a typo ('broken-link') ran NO checks
      // and the receipt still read「发现 0 个问题 / 没有发现问题」—— a false clean
      // bill of health, measured on a 2933-note wiki.
      const requested = Array.isArray(args.checks)
        ? args.checks.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim())
        : []
      const unknownChecks = requested.filter((c) => !(LINT_CHECKS as readonly string[]).includes(c))
      const checks: string[] = requested.length > 0
        ? LINT_CHECKS.filter((c) => requested.includes(c))
        : [...LINT_CHECKS]
      const want = (kind: string): boolean => checks.includes(kind)
      const items = await wiki.list(undefined, true)
      // 死链检查需要**全部**标题（含图片/PDF 等二进制附件）——只拿文本列表会
      // 把每一条 `[[图.png]]` / `{{附件}}` 都误报成死链（v0.19.1 修复）。
      // 瘦列表（不带正文）一次请求就能拿到全部标题。
      const titles = want('broken-links')
        ? new Set((await wiki.list()).map((t) => t.title))
        : new Set(items.map((t) => t.title))
      // 缺 type 判定要走 `[!has[type]]` 过滤器：TW 服务端会给 listing 里**每条**
      // 无 type 的条目补 `text/vnd.tiddlywiki`，靠响应里的 type 永远认不出来
      // （v0.19.1 修复：旧实现里这个检查永远不触发）。过滤器在服务端按真实字段
      // 求值，返回的标题就是真正没有 type 的那些。
      const typelessTitles = want('missing-type')
        ? new Set((await wiki.list(MISSING_TYPE_FILTER)).map((t) => t.title))
        : new Set<string>()
      const issues: LintIssue[] = []

      if (want('junk-tags')) {
        const samples: string[] = []
        let count = 0
        for (const t of items) {
          for (const tag of t.tags ?? []) {
            if (!isJunkTag(tag)) continue
            count++
            if (samples.length < limit) samples.push(`「${t.title}」的标签「${tag}」`)
          }
        }
        if (count > 0) issues.push({ kind: 'junk-tags', count, hint: '明显是写入事故产生的标签（如筛选器错误文本）；用 tiddlywiki_put 重写该条目的 tags 清理', samples })
      }

      if (want('broken-links')) {
        const samples: string[] = []
        let count = 0
        // v0.23.6: the transclusion branch must NOT match a `{{{…}}}` filtered
        // transclusion expression. The old `/…|\{\{([^}]+)\}\}/` began at the
        // first two braces of `{{{`, captured `{ [tag[todo]count[]] ` — so the
        // "target" started with `{` — and reported it as a broken link, flagging
        // every page that counts with `{{{[…count[]]}}}` (the home page, the
        // session docs, …). The lookarounds say "not part of a triple brace"
        // directly; the `startsWith('{')` guard is defence in depth.
        const linkRe = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|(?<!\{)\{\{(?!\{)([^}]+)\}\}/g
        for (const t of items) {
          const text = t.text ?? ''
          let match: RegExpExecArray | null
          while ((match = linkRe.exec(text)) !== null) {
            const target = (match[3] ?? match[2] ?? match[1] ?? '').trim()
            if (target.length === 0 || target.startsWith('$:/') || /^(https?|mailto|file):/.test(target)) continue
            if (target.includes('$') || target.includes('<')) continue // variable/macro, not a tiddler link
            if (target.startsWith('{')) continue // inside a `{{{…}}}` filtered transclusion
            if (titles.has(target)) continue
            count++
            if (samples.length < limit) samples.push(`「${t.title}」→「${target}」`)
          }
        }
        if (count > 0) issues.push({ kind: 'broken-links', count, hint: '被引用条目标题不存在；确认是笔误还是应新建该条目', samples })
      }

      if (want('empty-notes')) {
        const samples: string[] = []
        let count = 0
        for (const t of items) {
          if (t.title.startsWith('$:/')) continue
          if (isBinaryType(typeof t.type === 'string' ? t.type : undefined)) continue
          if ((t.text ?? '').trim().length === 0) {
            count++
            if (samples.length < limit) samples.push(`「${t.title}」`)
          }
        }
        if (count > 0) issues.push({ kind: 'empty-notes', count, hint: '正文为空的笔记；补内容或删除', samples })
      }

      if (want('missing-type')) {
        const samples: string[] = []
        let count = 0
        for (const t of items) {
          if (t.title.startsWith('$:/')) continue
          if (!typelessTitles.has(t.title)) continue
          const text = t.text ?? ''
          if (/^#{1,6}\s|\n#{1,6}\s|^\s*[-*]\s|\*\*[^*]+\*\*/m.test(text)) {
            count++
            if (samples.length < limit) samples.push(`「${t.title}」（无 type 字段，当前按 wikitext 渲染）`)
          }
        }
        if (count > 0) issues.push({ kind: 'missing-type', count, hint: '正文像 Markdown 但条目没有 type 字段，TW 会按 wikitext 渲染；用 tiddlywiki_put 的 fields.type 明确内容类型', samples })
      }

      // ── 时效性内容（v0.24.0）────────────────────────────────────────────
      // READ-ONLY BY DESIGN. The user's rule: the report may say "this looks
      // expired", never "I removed it". Deleting a knowledge-base note is the
      // user's call — the wiki is a git repo, so keeping something costs almost
      // nothing while a wrong deletion costs a lot.
      //
      // Two HARD judgements (explicit fields) and one HEURISTIC bucket that is
      // labelled as a candidate, not a verdict.
      if (want('stale')) {
        const now = Date.now()
        const staleAfterDays = Math.max(1, Math.min(args.staleAfterDays ?? 180, 3650))
        const staleAfterMs = staleAfterDays * 24 * 60 * 60 * 1000
        const expired: string[] = []
        const review: string[] = []
        const candidates: string[] = []
        let expiredCount = 0
        let reviewCount = 0
        let candidateCount = 0
        for (const t of items) {
          if (t.title.startsWith('$:/')) continue
          const validUntil = expiryOf(t['valid-until'])
          if (validUntil !== undefined && validUntil < now) {
            expiredCount++
            if (expired.length < limit) expired.push(`「${t.title}」（valid-until 已过）`)
          }
          const reviewAfter = expiryOf(t['review-after'])
          if (reviewAfter !== undefined && reviewAfter < now) {
            reviewCount++
            if (review.length < limit) review.push(`「${t.title}」（review-after 已到）`)
          }
          if (validUntil !== undefined || reviewAfter !== undefined) continue // already reported above
          const modified = parseTiddlerDate(t.modified)
          const old = modified === undefined || now - modified > staleAfterMs
          if (!old) continue
          const tags = t.tags ?? []
          // 版本号标签（v2.1.1 / 1.2.3）天然是阶段性内容；`done` 是很久以前
          // 完成的任务，其上下文很可能已经过期。
          const versionTag = tags.find((tag) => /^v?\d+\.\d+(\.\d+)?$/.test(tag.trim()))
          const doneTag = tags.some((tag) => tag.trim() === 'done')
          if (versionTag !== undefined || doneTag) {
            candidateCount++
            if (candidates.length < limit) {
              candidates.push(`「${t.title}」（${versionTag !== undefined ? `版本标签 ${versionTag}` : 'done 标签'}，${staleAfterDays} 天未改动）`)
            }
          }
        }
        if (expiredCount > 0) {
          issues.push({ kind: 'stale-expired', count: expiredCount, hint: '`valid-until` 已过期——内容按声明已失效。建议：确认后改成新内容、或打 归档 / superseded 标签、或（确认无用再）tiddlywiki_delete（默认进回收站，可恢复）', samples: expired })
        }
        if (reviewCount > 0) {
          issues.push({ kind: 'stale-review', count: reviewCount, hint: '`review-after` 到期——该复查是否仍然适用。建议：复查后更新 `review-after`，或把结论写进正文', samples: review })
        }
        if (candidateCount > 0) {
          issues.push({ kind: 'stale-candidates', count: candidateCount, hint: `**候选，非判定**：带版本号或 done 标签且 ${staleAfterDays} 天未改动，值得人工扫一眼。建议：确认过期的加 valid-until / superseded-by 字段或归档标签；仍有效的更新一下 modified 即可`, samples: candidates })
        }
      }

      return { scanned: items.length, checks, unknownChecks, issues }
    },
  })
}

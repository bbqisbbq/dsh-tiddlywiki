/**
 * System-prompt section for the plugin (v0.21.0).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Until v0.20.1 the section text was a hand-written template literal inside
 * `src/index.ts` that **duplicated the tool schemas in prose**. It drifted
 * exactly as expected: the signature catalogue was last touched in v0.19.0,
 * while v0.19.4 (list_tags limit), v0.19.5 (delete/attach/batch_put
 * concurrency tokens + attach's refuse-to-overwrite) and v0.20.1 (append
 * `fields`) all changed the tools — so the injected prompt advertised 6 stale
 * signatures for four releases.
 *
 * The fix has two halves:
 *   1. `slim` (default) drops the parameter catalogue entirely — the model
 *      already receives every tool's schema, so the section only carries the
 *      conventions the schemas CANNOT express (sync discipline, workspace
 *      tags, agent-written/human-edited, clickable wiki links). Nothing left
 *      to drift.
 *   2. `full` still offers a signature index, but it is **generated from the
 *      live tool registry** (`tiddlywikiToolSummary()`), so it can never go
 *      stale again.
 *
 * Both modes are composed from the same governance blocks; the verify script
 * asserts every block survives in both (a re-write may not silently drop a
 * rule the user relies on).
 *
 * v0.22.7 — DRAFT PREVIEW: `normalizePromptPreview()` + `describePrompt()`
 * let the settings page render the text for the values currently in its form
 * (before 保存配置). Until then the preview could only read the SAVED config, so
 * switching 形态 and hitting 预览 showed the old text — byte-identical, which
 * read as "the two modes are the same".
 *
 * @module dsh-tiddlywiki/host/prompt
 */

/**
 * The scope banner prepended to the injected prompt when MORE THAN ONE knowledge
 * base is visible to the agent (v0.28.0).
 *
 * Why a banner at all: with several wikis the model has no way to know which one
 * its `tiddlywiki_*` calls act on, and the failure mode (writing a note into the
 * wrong knowledge base) is silent. The banner names the scope, and every tool
 * result repeats it. With a single visible wiki this returns `''`, so existing
 * installs keep exactly the text they had.
 */
export function scopeBanner(scope: { id?: string; label?: string; reason?: string; ambiguous: boolean }): string {
  if (!scope.ambiguous || scope.id === undefined) return ''
  const why = scope.reason === undefined ? '' : `（${scope.reason}）`
  return `> **本会话作用域：${scope.label ?? scope.id}（${scope.id}）**${why}\n`
    + '> 本会话所有 `tiddlywiki_*` 工具都只作用于这个知识库，每条工具回执也会标明它。'
}

/** Built prompt text plus the optional scope banner (the section's final text). */
export function withScopeBanner(text: string, scope: { id?: string; label?: string; reason?: string; ambiguous: boolean }): string {
  if (text.length === 0) return ''
  const banner = scopeBanner(scope)
  return banner.length === 0 ? text : `${banner}\n\n${text}`
}

/** Prompt section name (stable id; a re-registration replaces the old one). */
export const PROMPT_SECTION_NAME = 'dsh-tiddlywiki'

/** Prompt section order (the plugin's section sits before plan/team policy). */
export const PROMPT_SECTION_ORDER = 100

/** Selectable prompt shapes. `slim` is the default since v0.21.0. */
export const PROMPT_MODES = ['slim', 'full'] as const

/** One selectable prompt shape. */
export type PromptMode = (typeof PROMPT_MODES)[number]

/** Default prompt shape (config `prompt.mode`; v0.21.0 switched to `slim`). */
export const DEFAULT_PROMPT_MODE: PromptMode = 'slim'

/**
 * System-prompt configuration (config tiddler overlay `prompt.*`, editable on
 * the settings page; re-applied live — see `applyPrompt()` in src/index.ts).
 */
export interface PromptConfig {
  /** false = register no section at all (no prompt text is injected). */
  enabled?: boolean
  /** Shape of the built-in text. `override` (when set) wins over this. */
  mode?: PromptMode
  /** Free-form text always APPENDED after the built-in/override body. */
  extra?: string
  /** Replaces the built-in body entirely (`extra` is still appended). */
  override?: string
}

/** One registered tool, as summarised for the `full` catalogue. */
export interface PromptToolSummary {
  name: string
  /** Parameter names in declaration order, with their required flag. */
  params: Array<{ name: string; required: boolean }>
}

/**
 * The four fields the settings page can preview BEFORE saving (v0.22.7).
 *
 * The same shape describes a saved `prompt.*` block, so one builder serves both
 * the live section and the preview — see `describePrompt()`.
 */
export interface PromptPreviewConfig {
  enabled?: boolean
  mode?: PromptMode
  extra?: string
  override?: string
  /**
   * config `wechat.enabled` — NOT a `prompt.*` field, but a legitimate input to
   * the built text (it gates the publish rule), so the draft preview carries it
   * too. Otherwise toggling 可选功能 in the form and previewing would show stale
   * text — the exact class of bug v0.22.7 fixed for `mode` (v0.23.0).
   */
  wechat?: boolean
  /**
   * Scope's proxy base for the link convention (v0.30.62).
   *
   * NOT part of the untrusted `POST /admin/prompt` draft (the preview always
   * describes the DEFAULT scope), but `promptTextFor()` passes the session's own
   * base so a scoped session is told to write id-bearing links.
   */
  linkBase?: string
}

/**
 * Whitelist an untrusted preview body (`POST /admin/prompt`) down to the five
 * rendering inputs, with type checks. Unknown keys and wrong types are DROPPED
 * (so a malformed body degrades to the built-in defaults instead of throwing),
 * and `mode` is only accepted when it is a known value — the same
 * "unknown falls back to slim" rule `normalizePromptMode()` applies later.
 */
export function normalizePromptPreview(input: unknown): PromptPreviewConfig {
  const src = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const out: PromptPreviewConfig = {}
  if (typeof src.enabled === 'boolean') out.enabled = src.enabled
  if (src.mode === 'slim' || src.mode === 'full') out.mode = src.mode
  if (typeof src.extra === 'string') out.extra = src.extra
  if (typeof src.override === 'string') out.override = src.override
  if (typeof src.wechat === 'boolean') out.wechat = src.wechat
  return out
}

/** What the preview endpoint (and `applyPrompt()`) reports for one config. */
export interface PromptDescription {
  enabled: boolean
  mode: PromptMode
  text: string
}

/**
 * Describe ONE prompt configuration: the built text plus the effective
 * `enabled`/`mode` the settings page labels it with.
 *
 * Both the saved config (`GET /admin/prompt`, `applyPrompt()`) and the settings
 * form's unsaved draft (`POST /admin/prompt`) go through here, so a preview can
 * never disagree with what a save would inject (v0.22.7).
 */
export function describePrompt(config: PromptPreviewConfig, tools: readonly PromptToolSummary[]): PromptDescription {
  const enabled = config.enabled !== false
  return {
    enabled,
    mode: normalizePromptMode(config.mode),
    text: buildPromptText({ enabled, mode: config.mode, extra: config.extra, override: config.override, tools, wechat: config.wechat, linkBase: config.linkBase }),
  }
}

/** Normalise a config value to a known mode (unknown values fall back to slim). */
export function normalizePromptMode(value: unknown): PromptMode {
  return value === 'full' ? 'full' : DEFAULT_PROMPT_MODE
}

/**
 * Neutralise `{{…}}` groups in USER-provided prompt text.
 *
 * DSH interpolates `{{name}}` in every section before delivery and **throws**
 * on an unknown or malformed name — one `{{cwd}}` typed into `prompt.extra`
 * would break system-prompt assembly for every session. A zero-width space
 * between the braces keeps the text readable while making it literal prose
 * (the interpolation scanner no longer sees a `{{` group).
 */
export function escapePromptBraces(text: string): string {
  // `{{{name}}}` used to survive: `replace(/\{\{/g)` only matches
  // NON-OVERLAPPING occurrences, so the 2nd+3rd braces stayed adjacent as `{{`
  // after the first substitution and DSH's scanner still saw a variable group
  // (v0.23.5). Inserting a ZWSP between EVERY adjacent brace pair makes any run
  // of `{` literal, which is the only thing that actually removes the hazard.
  return text.replace(/\{(?=\{)/g, '{\u200B')
}

/**
 * Governance block: how to write without clobbering human edits.
 *
 * v0.29.0 — TRIMMED TO THE PART THE SCHEMAS CANNOT SAY.
 *
 * This block used to restate `tiddlywiki_put` / `append` / `batch_put` / `attach`
 * nearly sentence for sentence: tags/fields/type preservation, `tags: []` meaning
 * "clear", the markdown default for new notes, `fields.type` being TW's content
 * type. All of that is ALREADY in those tools' descriptions — which the model
 * receives on every request — and this section's own intro tells it that the
 * schemas are the contract. Two copies of one rule is not redundancy insurance,
 * it is a second thing to keep in sync (the exact drift that v0.21.0 removed).
 *
 * What is left is the one thing no schema states: after a refused write, read
 * again instead of forcing. `scripts/verify-prompt.mjs` now asserts the delegated
 * rules on the SCHEMA side, so deleting them here can never lose them silently.
 */
const WRITE_RULES = `### 写入约定
- 写入被拒（说明刚有人（在 TW 编辑器里）改过）时**重读一遍再决定**，不要用 \`force\` 硬覆盖。`

/** Governance block: the three-step git discipline + conflict recovery. */
const SYNC_RULES = `### 同步纪律
- 开工先 \`tiddlywiki_git_sync action=pull\`，收工 \`action=sync\`。
- pull 冲突：先 \`tiddlywiki_git_resolve files=[冲突文件] strategy=keep-local\`（保留本地）或 \`keep-remote\`，再重新 pull/sync 整合其余改动。`

/**
 * Same-origin TW proxy base the agent writes into `[标题](…)` links.
 *
 * In SINGLE mode this bare path IS the only wiki (the default-wiki alias). In a
 * MULTI-wiki install the caller passes `/dsh-tiddlywiki/tw/<id>/` instead — see
 * `noteRules()` for why that matters (v0.30.62).
 */
export const TW_LINK_BASE = '/dsh-tiddlywiki/tw/'

/**
 * Governance block: knowledge-base conventions (tags, memory, links).
 *
 * v0.29.0 — the 「工作区标记自动打」 bullet and the 「检索先窄后宽 / 多词 AND」
 * bullet were REMOVED here because `tiddlywiki_put` and `tiddlywiki_search` already
 * document them verbatim (see verify-prompt.mjs, which now asserts them on the
 * schema side). What stays is what only this section can say: what a note IS for
 * (long-term memory), the todo convention, time-boxing/supersession fields, the
 * `human-edited` counterpart to the automatic `agent-written`, and the clickable
 * link format.
 *
 * v0.30.62 — the link format takes the SCOPE's proxy base. With several wikis the
 * bare `/tw/` is the DEFAULT-wiki alias: a link in the assistant's prose then
 * follows whatever library happens to be focused, and the same link inside a NOTE
 * navigates the embedded TW iframe to another library entirely. Multi-wiki links
 * therefore have to carry the id the banner names.
 */
function noteRules(linkBase: string): string {
  const link = linkBase === TW_LINK_BASE
    ? `\`[标题](${linkBase}#标题)\`（空格等特殊字符做 URL 编码；中文可直写）——优先用它代替纯文本标题。`
    : `\`[标题](${linkBase}#标题)\`——**多库：必须写上面横幅里那个库 id**（否则会开到别的库）；空格等特殊字符做 URL 编码（中文可直写）。`
  return `### 笔记约定
- wiki 是长期记忆：会议纪要、决策记录、调研笔记、随手的想法都存成独立 tiddler（tag 用 inbox/meeting/decision 等便于检索）。
- **值得做但不在当前范围内的想法**：写成独立 tiddler、打 \`todo\`，正文简述来源（会话 / 工作区 / 项目背景），由用户决定是否继续。
- **阶段性内容标时效**：会过期的笔记带 \`valid-until: YYYY-MM-DD\`（硬过期）或 \`review-after: YYYY-MM-DD\`（该复查）；被取代时写 \`superseded-by: [[新笔记]]\` 并打 \`superseded\` 标签、**保留旧笔记**。**淘汰只由人决定**，不要自行删除。
- \`agent-written\` 由工具自动补打，别手动加或删；人类编辑过 Agent 笔记后补 \`human-edited\`。
- **引用笔记用可点击链接**：${link}`
}

/**
 * Publish-metadata rule, appended ONLY when `wechat.enabled` is on (v0.23.0).
 *
 * The WeChat publishing feature is opt-in and needs its own install (opencli +
 * a browser extension — see docs/wechat-publish-setup.md), so users who never
 * enabled it must not see this line: the slim prompt had ~5 characters of
 * headroom left and every line costs context in EVERY session.
 */
const PUBLISH_RULE = `- **对外发布前**：先读 [[发布元数据规范]]（\`pub-state\`/\`no-publish\`），别重发或误发。`

/**
 * Governance blocks that MUST survive in every mode — exported so
 * `scripts/verify-prompt.mjs` can assert a re-write never silently drops one.
 */
export const PROMPT_GOVERNANCE_BLOCKS: readonly string[] = [WRITE_RULES, SYNC_RULES, noteRules(TW_LINK_BASE)]

/**
 * One line per tool: `bullet \`name\`（p1, p2?, …）`; `?` marks an optional
 * parameter. Shared by the `full` prompt catalogue and by the TW-side doc seed
 * (which reuses it as wikitext bullets), so both stay generated (v0.22.0).
 */
export function toolSignatureLines(tools: readonly PromptToolSummary[], bullet = '-'): string[] {
  return tools.map((tool) => {
    if (tool.params.length === 0) return `${bullet} \`${tool.name}\``
    const params = tool.params.map((p) => (p.required ? p.name : `${p.name}?`)).join(', ')
    return `${bullet} \`${tool.name}\`（${params}）`
  })
}

/**
 * Heading + a one-line capability pointer (slim intro).
 *
 * v0.29.0 — the hand-written CATEGORY LIST ("检索/读写/批量/增量追加/重命名…") is
 * gone. Only the COUNT was derived from the live registry, so adding or renaming a
 * tool silently made that sentence wrong, and `verify-prompt.mjs` could not see it
 * (it asserts there is no signature catalogue, not that this list is current). The
 * tools themselves are described in full by their schemas, which the model always
 * has; a second, unmaintainable summary of them is exactly what v0.21.0 removed.
 */
function slimIntro(count: number): string {
  return `## TiddlyWiki 持久知识库

本机的 TiddlyWiki 5 知识库（wiki 文件夹即 git 仓库）由 ${count} 个 \`tiddlywiki_*\` 工具读写：**参数与返回契约见各工具 schema**，本段只写 schema 表达不了的约定。`
}

/** Heading + the generated signature catalogue (full intro). */
function fullIntro(tools: readonly PromptToolSummary[]): string {
  const lines = toolSignatureLines(tools).join('\n')
  return `## TiddlyWiki 持久知识库

本机的 TiddlyWiki 5 知识库（wiki 文件夹即 git 仓库）。可用工具（${tools.length} 个，\`?\` 表示可选参数；详细契约以各工具的 description 为准）：

${lines}`
}

/**
 * Build the section text.
 *
 * Composition order: body → `extra`. The body is `override` when non-empty,
 * otherwise the built-in text for `mode`. User text is brace-escaped (see
 * `escapePromptBraces`); the built-in text is not (it never contains `{{`).
 * Returns `''` when `enabled === false` — callers must then register no
 * section at all rather than an empty one.
 */
export function buildPromptText(options: {
  mode?: PromptMode
  extra?: string
  override?: string
  tools?: readonly PromptToolSummary[]
  enabled?: boolean
  /**
   * Append the publish-metadata rule (config `wechat.enabled`, v0.23.0).
   * The WeChat feature is opt-in + separately installed, so this defaults to
   * FALSE: a user who never enabled it gets no publishing text at all.
   */
  wechat?: boolean
  /**
   * Proxy base for the clickable-link convention (v0.30.62).
   *
   * Defaults to `TW_LINK_BASE` (single mode / the default-wiki alias). A session
   * scoped to another library must pass `/dsh-tiddlywiki/tw/<id>/`, otherwise the
   * link opens whatever library happens to be focused (assistant prose) or sends
   * the embedded TW iframe to the DEFAULT wiki (a link inside a note).
   */
  linkBase?: string
}): string {
  if (options.enabled === false) return ''
  const tools = options.tools ?? []
  const override = typeof options.override === 'string' ? options.override.trim() : ''
  const intro = normalizePromptMode(options.mode) === 'full' ? fullIntro(tools) : slimIntro(tools.length)
  // The publish rule rides with noteRules() so it reads as part of 笔记约定;
  // `override` replaces the whole body, so the rule is dropped there too (an
  // override means "I'll say it myself").
  const notes = noteRules(options.linkBase ?? TW_LINK_BASE)
  const body = override.length > 0
    ? escapePromptBraces(override)
    : [intro, WRITE_RULES, SYNC_RULES, options.wechat === true ? `${notes}\n${PUBLISH_RULE}` : notes].join('\n\n')
  const extra = typeof options.extra === 'string' ? escapePromptBraces(options.extra.trim()) : ''
  return extra.length > 0 ? `${body}\n\n${extra}` : body
}

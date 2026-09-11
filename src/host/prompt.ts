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
 * @module dsh-tiddlywiki/host/prompt
 */

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
  return text.replace(/\{\{/g, '{\u200B{')
}

/** Governance block: how to write without clobbering human edits. */
const WRITE_RULES = `### 写入与并发
- 覆盖或删除已有笔记前先 \`tiddlywiki_get\` 读一次，把读到的 \`modified\`（或 \`revision\`）作为 \`expectedModified\`（或 \`expectedRevision\`）传回去；若期间有人（在 TW 编辑器里）改过，写入会被拒绝并告诉你当前值——此时重新读一遍再决定，**不要用 \`force\` 硬覆盖**。\`tiddlywiki_attach\` 对同名已有条目默认拒绝写入，理由相同（要覆盖得显式 \`force: true\`）。
- 纯增量内容（日志、批注、清单）优先用 \`tiddlywiki_append\`，不必读全文。
- 覆盖既有条目时**不传 \`tags\` 就保留原有标签、自定义字段与内容类型**（只改正文）；显式传 \`tags\` 才整体替换标签，要改内容类型用 \`fields.type\`。
- 内容类型：新笔记默认写成 Markdown（工具自动补 \`text/markdown\`，\`$:/\` 系统条目除外）；覆盖或追加既有条目时保留它原有的 \`type\`。要写 TW 原生 wikitext 才显式传 \`fields: {"type":"text/vnd.tiddlywiki"}\`。⚠️ \`fields.type\` 是 TW 的**内容类型**保留字段，业务分类请放 \`tags\`。`

/** Governance block: the three-step git discipline + conflict recovery. */
const SYNC_RULES = `### 同步纪律（三条）
1. 开工先 pull：\`tiddlywiki_git_sync action=pull\`（rebase + autostash；真冲突会自动 abort 并报冲突文件）。
2. 收工 commit + push：\`tiddlywiki_git_sync action=sync\`（pull → commit → push）。
3. 插件会自动防抖 commit（默认 60s），需要立刻同步时用上面的工具。
pull 冲突后：先 \`tiddlywiki_git_resolve files=[冲突文件] strategy=keep-local\`（保留本地）或 \`strategy=keep-remote\`（改用远端版本），再重新 pull/sync 整合其余改动。`

/** Governance block: knowledge-base conventions (tags, memory, links). */
const NOTE_RULES = `### 笔记约定
- 把 wiki 当作长期记忆与知识沉淀的地方：会议纪要、决策记录、调研笔记、随手的想法都可存成独立 tiddler（tag 建议用 inbox/meeting/decision 等便于检索）。
- **把有价值但不在当前执行范围内的想法沉淀进 wiki**：遇到「未来可能有用 / 值得做」的想法，用 \`tiddlywiki_put\` 写成独立 tiddler，打上 \`todo\` + \`agent-written\` 标签（并附当前工作区名），正文简要说明来源（会话 / 工作区 / 项目背景），由用户决定是否继续。
- 自动创建笔记时，除了业务性 tag 外，请把**当前工作区（项目）的名字**也作为标签之一，方便按项目归集与检索。
- \`agent-written\`：\`put\`/\`batch_put\` 新建条目时工具自动补打，无需手动添加、也不要手动移除（除非用户明确要求）；若某篇 Agent 笔记之后被人类编辑过，请补打 \`human-edited\`。
- **引用 wiki 笔记用可点击链接**：在回复流中引用笔记时用 \`[标题](/dsh-tiddlywiki/tw/#标题)\`（标题含空格/特殊字符时做 URL 编码，如 \`A%20B\`；中文可直接写）。点击会打开中央 TW 面板并跳转到该笔记，请优先用它代替纯文本标题。`

/**
 * Governance blocks that MUST survive in every mode — exported so
 * `scripts/verify-prompt.mjs` can assert a re-write never silently drops one.
 */
export const PROMPT_GOVERNANCE_BLOCKS: readonly string[] = [WRITE_RULES, SYNC_RULES, NOTE_RULES]

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

/** Heading + a one-line capability pointer (slim intro). */
function slimIntro(count: number): string {
  return `## TiddlyWiki 持久知识库

本机有一个 TiddlyWiki 5 持久知识库（wiki 文件夹即 git 仓库）。插件提供 ${count} 个 \`tiddlywiki_*\` 工具：检索与读取、写入与批量写入、增量追加、重命名、删除与回收站、反向链接、二进制附件、知识库体检、git 同步与冲突解决。**每个工具的参数与返回契约以工具 schema 的 description 为准**，本段只补充 schema 之外仍需知道的规则。`
}

/** Heading + the generated signature catalogue (full intro). */
function fullIntro(tools: readonly PromptToolSummary[]): string {
  const lines = toolSignatureLines(tools).join('\n')
  return `## TiddlyWiki 持久知识库

本机有一个 TiddlyWiki 5 持久知识库（wiki 文件夹即 git 仓库）。可用工具（${tools.length} 个，\`?\` 表示可选参数；详细契约以各工具的 description 为准）：

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
}): string {
  if (options.enabled === false) return ''
  const tools = options.tools ?? []
  const override = typeof options.override === 'string' ? options.override.trim() : ''
  const body = override.length > 0
    ? escapePromptBraces(override)
    : [normalizePromptMode(options.mode) === 'full' ? fullIntro(tools) : slimIntro(tools.length), WRITE_RULES, SYNC_RULES, NOTE_RULES].join('\n\n')
  const extra = typeof options.extra === 'string' ? escapePromptBraces(options.extra.trim()) : ''
  return extra.length > 0 ? `${body}\n\n${extra}` : body
}

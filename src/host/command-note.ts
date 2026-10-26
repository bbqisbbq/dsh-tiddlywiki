/**
 * `/note <标题>\n<正文>` —— 把一条笔记直接写进当前会话的知识库（v0.30.66）。
 *
 * WHY A SLASH COMMAND
 * -------------------
 * 快速笔记卡是"打开一张卡、填三四个字段、保存"的三步流程；用户真正想要记一句话时，
 * 那三步全是摩擦。DSH 的 `ctx.commands.register()` 提供的正是这个形态：命令**直接
 * 作用于 agent**、不产生模型消息、不进上下文（`recordInput` 语义），所以"随手记"
 * 不必先跟模型说一句话、也就不会污染对话。
 *
 * WHY IT REFUSES TO OVERWRITE
 * ---------------------------
 * 作者 2026-10-26 的核心抱怨之一是「同样的事情写了多个内容有差异的东西」。一个
 * `/note` 命令最容易造成的正是这个：同一标题再写一次。所以同名笔记**已存在就拒绝**
 * 并指路（让用户用编辑器改、或让 agent 用 `tiddlywiki_replace`/`put` 按并发令牌改），
 * 而不是第二次静默覆盖第一版。
 *
 * @module dsh-tiddlywiki/host/command-note
 */
import { buildWriteTiddler } from './write-policy.ts'
import { WORKSPACE_FIELD, workspaceMarkFromCwd } from './workspace.ts'
import type { Tiddler } from './tw-api.ts'

/** Structural face over DSH's command registry (no `@deepseek-ai` import). */
export interface CommandRegistryFace {
  register(definition: {
    name: string
    description: string
    input?: { hint?: string }
    definitionId?: string
    handler: (invocation: { agent?: { id?: unknown }; rawInput?: unknown }) => unknown
  }): () => void
}

/** What the command needs from the host (a narrow face, not the whole ToolsDeps). */
export interface NoteCommandDeps {
  scope: (sessionId: string | undefined) => {
    client?: { get(title: string): Promise<Tiddler | undefined>; put(tiddler: Tiddler): Promise<unknown> }
    label?: string
    reason?: string
  }
  /** Project cwd of the session (the same accessor the write tools use). */
  workspaceName?: (sessionId: string) => string | undefined
  workspaceMarkEnabled?: () => boolean
  /** Debounced auto-commit ping (the same one the write tools fire). */
  autoCommit: (sessionId?: string) => void
}

/** The command's stable identity (also what `/help` lists). */
export const NOTE_COMMAND_NAME = 'note'

/** Longest title we derive from a single-line invocation. */
const DERIVED_TITLE_CHARS = 30

export interface ParsedNoteInput {
  title: string
  body: string
}

/**
 * Split `/note` input into `{title, body}`.
 *
 * 规则（刻意简单，写在 `/help` 的 hint 里）：
 *   · 第一行 = 标题，其余行 = 正文；
 *   · 只有一行时，把这一行同时当标题（截到 30 字符）与正文 —— 记一句话不该被
 *     "标题必填"挡回去，但也不该产生一个空正文的笔记。
 *
 * @returns `undefined` when the input carries no text at all.
 */
export function parseNoteInput(rawInput: string): ParsedNoteInput | undefined {
  const text = rawInput.replace(/\r\n/g, '\n').trim()
  if (text.length === 0) return undefined
  const lines = text.split('\n')
  const firstLine = (lines[0] ?? '').trim()
  const rest = lines.slice(1).join('\n').trim()
  if (rest.length === 0) {
    const title = firstLine.length > DERIVED_TITLE_CHARS ? `${firstLine.slice(0, DERIVED_TITLE_CHARS)}…` : firstLine
    return { title, body: firstLine }
  }
  return { title: firstLine.length === 0 ? (rest.split('\n')[0] ?? '').slice(0, DERIVED_TITLE_CHARS) : firstLine, body: rest }
}

/**
 * Register `/note` on the host's command registry.
 *
 * Returns the registry's disposer. Never throws at registration time: a host
 * without a command registry simply gets no command.
 */
export function registerNoteCommand(commands: CommandRegistryFace, deps: NoteCommandDeps): () => void {
  return commands.register({
    name: NOTE_COMMAND_NAME,
    description: '把一条笔记写进当前会话的知识库（第一行当标题，其余行当正文）',
    input: { hint: '<标题>\n<正文>' },
    definitionId: 'dsh-tiddlywiki/note',
    handler: async ({ agent, rawInput }) => {
      const parsed = parseNoteInput(typeof rawInput === 'string' ? rawInput : '')
      if (parsed === undefined) {
        return { kind: 'error', text: '用法：/note <标题>\n<正文>（至少要有一行文字）' }
      }
      const sessionId = typeof agent?.id === 'string' && agent.id.length > 0 ? agent.id : undefined
      const scope = deps.scope(sessionId)
      if (scope.client === undefined) {
        return { kind: 'error', text: `这条命令用不了：${scope.reason ?? '当前会话没有可用的知识库'}` }
      }
      // 已存在就拒绝（见模块头）：静默覆盖正是"同一件事多份说法"的来源之一。
      const existing = await scope.client.get(parsed.title)
      if (existing !== undefined) {
        return {
          kind: 'error',
          text: `「${parsed.title}」已经存在（${scope.label ?? '当前知识库'}）。要改请用编辑器，或让 Agent 用 tiddlywiki_get + tiddlywiki_put 按并发令牌更新；换标题再加一次也可以。`,
        }
      }
      // 默认开启（与 put/append 同一口径：只有显式 `=== false` 才关）。旧写法是
      // `=== true`，于是 deps 未注入（headless / 宿主换实现）时 `/note` 写出的笔记
      // 静默缺 `ws/<项目>` 标记与 `workspace` 字段，而同一篇笔记用 put 写就有。
      const mark = deps.workspaceMarkEnabled?.() !== false && sessionId !== undefined
        ? workspaceMarkFromCwd(deps.workspaceName?.(sessionId))
        : undefined
      const fields: Record<string, unknown> = {}
      const tags = ['inbox']
      if (mark !== undefined) {
        tags.push(mark.tag)
        fields[WORKSPACE_FIELD] = mark.id
      }
      // `agentTag: false`：这是**人**写的笔记（命令由用户发起），不该被标成
      // `agent-written` —— 那个标签的含义是"Agent 写的，人可以放心改"。
      const { tiddler } = buildWriteTiddler(parsed.title, parsed.body, { tags, fields, agentTag: false })
      await scope.client.put(tiddler)
      deps.autoCommit(sessionId)
      const where = scope.label !== undefined ? `（${scope.label}）` : ''
      return { kind: 'success', text: `已写入「${parsed.title}」${where}` }
    },
  })
}

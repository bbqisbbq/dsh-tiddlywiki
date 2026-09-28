/**
 * The `tiddlywiki_*` agent tools (design doc §11, D8) plus the extension
 * point: `registerTiddlywikiTools(ctx, deps)` registers tools list-style, so a
 * new tool is just one more `defineTool` in the array — index.ts never changes.
 *
 * Toolset (v0.19):
 *   search / get / put / batch_put / append / rename / delete / trash /
 *   backlinks / attach / lint / recent / list_tags / git_sync / git_resolve
 *
 * RENDER CONTRACT (design doc §4.3): the registry feeds `output.render(args,
 * value)` into the loop — the model sees ONLY the rendered text, never the raw
 * JSON `value`. Every render must carry the complete facts an agent needs to
 * act (titles, tags, snippets, git state); a terse UI summary starves it.
 *
 * @module dsh-tiddlywiki/host/tools
 */

import { requireWiki, sessionIdOf } from './tools-support.ts'
import type { RegistrableTool, ToolEnv, ToolScope, ToolsCtx, ToolsDeps } from './tools-support.ts'
import { backlinksTool, lintTool, listTagsTool, recentTool, searchTool } from './tools-read.ts'
import { appendTool, batchPutTool, deleteTool, getTool, putTool, renameTool, trashTool } from './tools-notes.ts'
import { attachTool } from './tools-attach.ts'
import { gitResolveTool, gitSyncTool } from './tools-git.ts'

export { AGENT_WRITTEN_TAG, DEFAULT_NOTE_TYPE, HUMAN_EDITED_TAG } from './write-policy.ts'

// Re-exported from their new homes so this path keeps the exact public surface
// it had before the split: src/index.ts and the verify-*.mjs guards import
// these from here.
export { MAX_ATTACH_BYTES, TRASH_INDEX_TITLE, TRASH_PREFIX, TrashIndexUnavailableError, isJunkTag } from './tools-support.ts'
export { type ToolScope, type ToolsCtx, type ToolsDeps }

import type { PromptToolSummary } from './prompt.ts'

/**
 * Summaries of the tools registered by the LAST `registerTiddlywikiTools()`
 * pass — the single source for the `full` prompt catalogue and for
 * `scripts/verify-prompt.mjs` (v0.21.0).
 *
 * History: the prompt carried a HAND-WRITTEN parameter catalogue that was last
 * updated in v0.19.0 and silently drifted 6 signatures behind the tools by
 * v0.20.1. Collecting them here from the same definitions that reach the model
 * makes that class of drift impossible.
 */
const REGISTERED_TOOL_SUMMARY: PromptToolSummary[] = []

/** Tool summaries of the last registration pass (empty before one has run). */
export function tiddlywikiToolSummary(): readonly PromptToolSummary[] {
  return REGISTERED_TOOL_SUMMARY
}

export function registerTiddlywikiTools(ctx: ToolsCtx, deps: ToolsDeps): Array<() => void> {
  const disposers: Array<() => void> = []
  // Re-collect on every pass: a hot reload re-registers the whole toolset, and
  // a stale entry must never linger in the prompt catalogue.
  REGISTERED_TOOL_SUMMARY.length = 0

  /** A registered tool plus the two members the scope wrapper needs. */
  interface WrappableTool extends RegistrableTool {
    execute?: (args: unknown, exec: unknown) => Promise<unknown>
    output?: { render?: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }> }
  }

  /**
   * Give EVERY tool result a 「知识库：…」 header — but only when more than one
   * knowledge base is visible to the agent (v0.28.0).
   *
   * Done HERE, once, instead of inside 15 renders: a tool result is the only
   * place the model can learn WHICH knowledge base it just wrote to, and "wrote
   * into the wrong wiki" is the failure this feature most needs to make visible.
   * With a single visible wiki (`ambiguous === false`) the output stays
   * byte-identical to before, so existing installs see no change at all.
   */
  const withScopeHeader = (tool: WrappableTool): WrappableTool => {
    const render = tool.output?.render
    const execute = tool.execute
    if (render === undefined || execute === undefined) return tool
    return {
      ...tool,
      async execute(args: unknown, exec: unknown): Promise<unknown> {
        const scope = deps.scope(sessionIdOf(exec))
        const value = await execute(args, exec)
        if (!scope.ambiguous || scope.id === undefined) return value
        if (value === null || typeof value !== 'object') return value
        return { ...(value as Record<string, unknown>), wiki: { id: scope.id, label: scope.label ?? scope.id } }
      },
      output: {
        ...tool.output,
        render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
          const lines = render(args, value)
          const wiki = (value as { wiki?: { id: string; label: string } } | null)?.wiki
          if (wiki === undefined || lines.length === 0) return lines
          const [first, ...rest] = lines
          return [{ ...(first as { type: 'text'; text: string }), text: `【知识库：${wiki.label}（${wiki.id}）】\n${(first as { text: string }).text}` }, ...rest]
        },
      },
    }
  }

  const register = (tool: RegistrableTool): void => {
    const properties = (tool.parameters.properties ?? {}) as Record<string, unknown>
    const required = Array.isArray(tool.parameters.required) ? (tool.parameters.required as string[]) : []
    REGISTERED_TOOL_SUMMARY.push({
      name: tool.name,
      params: Object.keys(properties).map((name) => ({ name, required: required.includes(name) })),
    })
    disposers.push(ctx.tools.register(withScopeHeader(tool) as never))
  }

  // Registration ORDER is load-bearing (v0.28.8): REGISTERED_TOOL_SUMMARY is the
  // catalogue the `full` prompt mode prints and scripts/verify-prompt.mjs asserts
  // its order. This is the original v0.19 order — do not reshuffle.
  const env: ToolEnv = { register, deps, requireWiki: (sessionId) => requireWiki(deps, sessionId) }

  register(searchTool(env))
  register(recentTool(env))
  register(listTagsTool(env))
  register(getTool(env))
  register(putTool(env))
  register(batchPutTool(env))
  register(appendTool(env))
  register(renameTool(env))
  register(deleteTool(env))
  register(trashTool(env))
  register(backlinksTool(env))
  register(attachTool(env))
  register(lintTool(env))
  register(gitSyncTool(env))
  register(gitResolveTool(env))

  return disposers
}

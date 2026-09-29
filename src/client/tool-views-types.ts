/**
 * Structural types + argument helpers of the reply-stream tool cards (v0.30.14
 * split of `tool-views.ts`).
 *
 * The card tree renders records owned by the DSH conversation shell, and the
 * client bundle is never transpiled together with the shell's types — so the
 * shapes the cards read are declared HERE, structurally, as the subset they
 * actually consume. Nothing in this module touches React: it is the pure
 * "decode what the shell handed us" layer that every card shares.
 *
 * @module dsh-tiddlywiki/client/tool-views-types
 */

export interface CallHead {
  name: string
  argsRaw: string
}

export interface RunningCallLike {
  name?: string
  argsRaw?: string
}

export interface SettledLike {
  kind?: string
  call?: CallHead | null
  content?: readonly ContentBlockLike[]
  isError?: boolean
}

export interface ContentBlockLike {
  kind?: string
  text?: unknown
}

/** Owner props the shell passes to a keyed tool view (verified via Inspect).
 *  `block` + `toolName` drive the card; `sessionId` (v0.28.8) is what lets the
 *  card ask for the RIGHT knowledge base — the slot is session-scoped and the
 *  shell passes the session it is rendering for. */
export interface ToolCallOwnerProps {
  toolName: string
  block: RunningCallLike | SettledLike
  /** The session this card belongs to (absent on shells that do not pass it). */
  sessionId?: string
}

export function isSettled(block: RunningCallLike | SettledLike): block is SettledLike {
  return typeof block === 'object' && block !== null && (block as SettledLike).kind === 'tool-result'
}

/** The call identity: settled nodes carry it under `call`, running nodes top-level. */
export function callArgs(block: RunningCallLike | SettledLike): CallHead | null {
  if (typeof block !== 'object' || block === null) return null
  const settled = block as SettledLike
  if (typeof settled.call === 'object' && settled.call !== null) {
    const c = settled.call as CallHead
    if (typeof c.name === 'string' && typeof c.argsRaw === 'string') return c
  }
  const running = block as RunningCallLike
  if (typeof running.name === 'string' && typeof running.argsRaw === 'string') {
    return { name: running.name, argsRaw: running.argsRaw }
  }
  return null
}

export function parseArgs(argsRaw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsRaw) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Model-visible rendered text of a settled node (fallback when service is down). */
export function contentText(content: readonly ContentBlockLike[] | undefined): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is ContentBlockLike & { text: string } => typeof b?.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

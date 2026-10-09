/**
 * dsh-tiddlywiki — host half: the system-prompt section wiring (v0.21.0).
 *
 * WHY THIS IS ITS OWN MODULE (v0.28.8)
 * ------------------------------------
 * The section has one subtle property that makes it easy to break from a
 * distance: it is registered ONCE but its text is a FUNCTION evaluated per
 * ASSEMBLY, so a session scoped to wiki B is told it is working on wiki B
 * without any re-registration. Every hop that produced that text used to be a
 * closure inside apply(); they are now explicit deps so there is exactly one
 * place that decides which wiki a session's prompt describes.
 *
 * index.ts still owns the two mutable cells (`disposePromptSection` /
 * `currentPromptText`) and the disposer list — they are handed in.
 *
 * @module dsh-tiddlywiki/index-prompt
 */
import { describePrompt, withScopeBanner, TW_LINK_BASE, PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER, type PromptConfig } from './host/prompt.ts'
import { tiddlywikiToolSummary } from './host/tools.ts'
import type { PluginConfigShape } from './host/config.ts'
import type { ToolScope } from './host/tools.ts'

/** The host surfaces this wiring needs (subset of index.ts's HostCtx). */
export interface PromptCtx {
  systemPrompt: {
    section(opts: { name: string; order: number; text: string | ((context: unknown) => string) }): () => void
  }
}

export interface PromptDeps {
  /** The plugin context; only `systemPrompt.section` is used. */
  ctx: PromptCtx
  /**
   * The EFFECTIVE config of the session's SCOPE wiki (cordis base + that wiki's
   * config tiddler overlay). Resolved per assembly, so 「每库定制提示词」 takes
   * effect.
   */
  effectiveConfigFor: (sessionId: string | undefined) => PluginConfigShape
  /** What the agent may act on for one session (drives the scope banner). */
  toolScope: (sessionId: string | undefined) => ToolScope
  /** The disposer list is owned by index.ts (teardown order matters). */
  pushDisposer: (dispose: () => void) => void
}

export interface PromptSurface {
  /** The prompt section's text for ONE session. */
  promptTextFor: (sessionId: string | undefined) => string
  /** Built text for the DEFAULT scope (the saved-state preview / re-registration key). */
  promptText: () => string
  /** (Re-)register the section; see the long note below. */
  applyPrompt: () => void
}

export function createPromptSurface(deps: PromptDeps): PromptSurface {
  const { ctx, effectiveConfigFor, toolScope } = deps

  let disposePromptSection: (() => void) | undefined
  let currentPromptText: string | undefined
  /**
   * The prompt section's text for ONE session.
   *
   * It is a FUNCTION (v0.28.0): the section is registered once, but the text is
   * evaluated per assembly with that assembly's agent, so a session scoped to
   * wiki B is told it is working on wiki B. Single-wiki installs get exactly the
   * previous text — the scope line appears only when more than one knowledge
   * base is visible.
   *
   * Per-wiki `prompt.*` is honoured too: the config read is the SCOPE wiki's, so
   * the 「每库定制提示词」decision from the design doc actually takes effect.
   */
  const promptTextFor = (sessionId: string | undefined): string => {
    const scope = toolScope(sessionId)
    const cfg = effectiveConfigFor(sessionId)
    // `wechat.enabled` (v0.23.0) is NOT a `prompt.*` field but it gates the
    // publish rule, and the feature is opt-in + separately installed — users who
    // never enabled it must see no publishing text.
    //
    // `linkBase` (v0.30.62) is this session's own proxy base: with several wikis a
    // bare `/tw/` link opens the FOCUSED library (assistant prose) or sends the
    // embedded TW iframe to the DEFAULT one (a link inside a note), so a scoped
    // session must be told to write `/tw/<its id>/`.
    const linkBase = scope.ambiguous && typeof scope.id === 'string' && scope.id.length > 0
      ? `${TW_LINK_BASE}${scope.id}/`
      : TW_LINK_BASE
    const built = withScopeBanner(describePrompt(
      { ...((cfg.prompt ?? {}) as PromptConfig), wechat: (cfg.wechat ?? {}).enabled === true, linkBase },
      tiddlywikiToolSummary(),
    ).text, scope)
    return built
  }

  /**
   * Built text for the DEFAULT scope (also the saved-state preview / the
   * re-registration key). The signature catalogue for `full` mode comes from the
   * live tool registry, never from hand-written prose (v0.21.0 — the old copy had
   * drifted).
   */
  const promptText = (): string => promptTextFor(undefined)

  /**
   * (Re-)register the section. The text is a function, so a scope change needs
   * no re-registration at all; this still runs on config saves so the
   * `system-prompt/change` signal (and the history re-render) fires, and the
   * skip-if-unchanged check keeps an unrelated save from churning anything.
   */
  const applyPrompt = (): void => {
    const next = promptText()
    if (next === currentPromptText) return
    currentPromptText = next
    disposePromptSection?.()
    disposePromptSection = undefined
    if (next.length === 0) return
    disposePromptSection = ctx.systemPrompt.section({
      name: PROMPT_SECTION_NAME,
      order: PROMPT_SECTION_ORDER,
      text: (context: unknown) => {
        // `AssembleContext.scope` IS the agent (see assembleContextFor in
        // @deepseek-ai/dsh-agent), and Agent.id is the session id — the documented
        // way a section learns whose prompt it is building.
        const agent = (context as { scope?: { id?: unknown } } | undefined)?.scope
        return promptTextFor(typeof agent?.id === 'string' ? agent.id : undefined)
      },
    })
  }
  deps.pushDisposer(() => {
    disposePromptSection?.()
    disposePromptSection = undefined
  })

  return { promptTextFor, promptText, applyPrompt }
}

/**
 * Readiness window from the EFFECTIVE config (v0.22.5): the settings page saves
 * `startup.readyTimeoutMs`, and this re-applies it to EVERY running wiki — it
 * takes effect on the next start()/restart() without a dsh web restart. Values
 * are clamped by host/ready-policy.ts.
 *
 * Kept next to the other "a settings save must reach the RUNNING plugin" hop
 * (`reapplyGitConfig`) rather than inside index.ts, because a save that only
 * half-applies is exactly the class of bug both of them exist to prevent.
 */
export function createServerTuning(deps: { farm: () => { allRuntimes(): Array<{ applyServerTuning(): void }> } | undefined }): () => void {
  return (): void => {
    for (const runtime of deps.farm()?.allRuntimes() ?? []) runtime.applyServerTuning()
  }
}

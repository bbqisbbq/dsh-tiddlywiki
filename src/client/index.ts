/**
 * Browser half entry for dsh-tiddlywiki (design doc §12, D5): injects the
 * stylesheet, mounts the sidebar entry, the center-column TiddlyWiki panel,
 * the floating quick-note widget, and registers the plugin's settings page
 * (config panel, §13) into the shell's Settings.
 *
 * Failure policy: DOM mounting problems are logged, never thrown — the web
 * shell fails the whole boot when a plugin apply throws.
 *
 * Export shape: `name` / `inject` / `apply`, no default.
 *
 * @module dsh-tiddlywiki/client
 */
import { injectStyles } from './styles.ts'
import { PanelState } from './state.ts'
import { mountSidebarEntry } from './sidebar-entry.ts'
import { mountPanel } from './panel.ts'
import { mountNoteWidget } from './note-widget.ts'
import { disposeEditorPopup } from './editor-popup.ts'
import { SettingsSection } from './settings-page.ts'

/** Client plugin name. */
export const name = 'dsh-tiddlywiki/client'

/** Required client services: the slots registry (settings.section seat). */
export const inject: string[] = ['slots']

/** Effect-hook face the runner provides on the client context. */
interface ClientContextFace {
  slots?: {
    inject(name: string, register: () => unknown): (() => void) | undefined
    register(
      opts: { name: string; id: string; order?: number; label?: string | (() => string) },
      component: unknown,
    ): () => void
  }
  effect?(fn: () => unknown, label?: string): void
}

/**
 * Client entry: installs styles and mounts the DOM seats + settings page.
 * @param ctx - the cordis client context.
 */
export function apply(ctx: ClientContextFace): void {
  try {
    injectStyles()
    const state = new PanelState()
    const disposers: Array<() => void> = []
    try {
      disposers.push(mountSidebarEntry(state))
      disposers.push(mountPanel(state))
      disposers.push(mountNoteWidget())
      disposers.push(disposeEditorPopup)
    } catch (error) {
      // DOM failures degrade the plugin, never the GUI.
      console.error('[dsh-tiddlywiki] mount failed:', error)
    }
    try {
      // Settings page → Settings → 「TiddlyWiki 知识库」(config panel §13).
      const removeSettings = ctx.slots?.inject('settings.section', () =>
        ctx.slots?.register(
          { name: 'settings.section', id: 'dsh-tiddlywiki', order: 50, label: 'TiddlyWiki 知识库' },
          SettingsSection,
        ),
      )
      if (removeSettings !== undefined) disposers.push(removeSettings)
    } catch (error) {
      console.error('[dsh-tiddlywiki] settings section failed:', error)
    }
    ctx.effect?.(() => () => {
      for (const dispose of disposers.splice(0)) dispose()
    }, 'dsh-tiddlywiki: client mount')
  } catch (error) {
    console.error('[dsh-tiddlywiki] client half failed to start:', error)
  }
}

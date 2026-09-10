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
import { createNoteWidget } from './note-widget.ts'
import { createSyncController } from './sync-button.ts'
import { mountKnowledgeFab } from './knowledge-fab.ts'
import { createQuickNoteDock } from './quick-note-dock.ts'
import { fetchUiConfig } from './ui-config.ts'
import { mountSessionSummaryView } from './session-summary.ts'
import { disposeEditorPopup } from './editor-popup.ts'
import { SettingsSection } from './settings-page.ts'
import { registerToolViews, installWikiLinkInterceptor } from './tool-views.ts'
import { mountRightbarTab, type RightbarSlotsFace } from './rightbar-tab.ts'

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
  /** Optional service read without the inject requirement (cordis ctx.get). */
  get?: (name: string) => unknown
  effect?(fn: () => unknown, label?: string): void
}

/** Structural face over the rightbar tab registry (dsh-client-ui-sidebar-right). */
interface SidebarRightTabsFace {
  register(definition: unknown): () => void
}

/**
 * Client entry: installs styles and mounts the DOM seats + settings page.
 * @param ctx - the cordis client context.
 */
export function apply(ctx: ClientContextFace): void {
  try {
    const disposers: Array<() => void> = []
    let clientDisposed = false
    const disposeAll = (): void => {
      clientDisposed = true
      for (const dispose of disposers.splice(0)) dispose()
    }
    /**
     * 每个挂载点一个 try/catch：任一处 DOM 失败只记日志并跳过自身，其余功能与
     * 已注册的 disposer 不受影响（此前 6 个 mount 共用一个 try，前面一抛后面
     * 全被跳过，且抛错方已创建的 observer/interval 失去回收路径）。
     */
    const safeMount = (label: string, fn: () => void): void => {
      try {
        fn()
      } catch (error) {
        console.error(`[dsh-tiddlywiki] ${label} failed:`, error)
      }
    }

    // 样式表：injectStyles 返回移除该 <style> 的 disposer（卸载可回收、HMR 可更新）。
    safeMount('styles', () => disposers.push(injectStyles()))

    const state = new PanelState()
    // v0.5: the quick-note card and the sync logic are owned by controllers;
    // the single "知识库" FAB drives them (three old floating controls merged).
    let note: ReturnType<typeof createNoteWidget> | undefined
    let sync: ReturnType<typeof createSyncController> | undefined
    safeMount('quick-note widget', () => {
      note = createNoteWidget()
      disposers.push(() => note?.dispose())
    })
    safeMount('sync controller', () => {
      sync = createSyncController()
      disposers.push(() => sync?.dispose())
    })
    safeMount('sidebar entry', () => disposers.push(mountSidebarEntry(state)))
    safeMount('center panel', () => disposers.push(mountPanel(state)))
    if (note !== undefined && sync !== undefined) {
      // Narrow the captured mutables into consts for the closure below.
      const widget = note
      const syncController = sync
      safeMount('knowledge FAB', () => disposers.push(mountKnowledgeFab(state, widget, syncController)))
    }
    safeMount('editor popup', () => disposers.push(disposeEditorPopup))
    // 输入框上方「快速笔记」快捷按钮（conversation.input.dock 槽位）。该槽位
    // 是官方为「输入框上方的全宽条目」预留的挂载点，todo/cost-meter/goal/
    // queue/git-graph 等插件内容都渲染在这里、按纵向 flex 排列，天然不重叠。
    // 由 ui.showQuickNoteDock 配置控制（默认开）。
    if (ctx.slots !== undefined) {
      void fetchUiConfig().then((cfg) => {
        if (clientDisposed) return
        const widget = note
        if (cfg.showQuickNoteDock && widget !== undefined) {
          safeMount('quick-note dock', () => {
            const removeDock = ctx.slots?.inject('conversation.input.dock', () =>
              ctx.slots?.register(
                { name: 'conversation.input.dock', id: 'quick-note', order: 8, label: '快速笔记' },
                createQuickNoteDock(widget),
              ),
            )
            if (removeDock !== undefined) disposers.push(removeDock)
          })
        }
        // 会话顶部「知识库」Tab（conversation.view 槽位）：显示本会话产生/读取/
        // 检索过的 wiki 笔记汇总（TW 原生渲染）。由 ui.showSessionTab 控制（默认
        // 开），tab 名跟随 ui.tabLabel（默认「知识库」）。
        safeMount('session summary tab', () => {
          const removeSummary = mountSessionSummaryView(ctx.slots, cfg)
          if (removeSummary !== undefined) disposers.push(removeSummary)
        })
      }).catch((error) => {
        console.error('[dsh-tiddlywiki] ui config load failed:', error)
      })
    }
    // 右侧边栏（DSH new rightbar）集成：可选挂载——仅当
    // dsh-client-ui-sidebar-right 提供了 sidebarRightTabs 服务时才启用
    // （老版本 DSH / 无右侧栏时静默跳过，插件其余功能不受影响）。注册 TW
    // tab 类型 + guide 首页入口盒；由 ui.showRightbarTab 控制（默认开）。
    safeMount('rightbar mount', () => {
      let retryTimer: number | undefined
      const tryMountRightbar = (attempt: number): void => {
        const tabs = ctx.get?.('sidebarRightTabs') as SidebarRightTabsFace | undefined
        if (tabs === undefined) {
          // rightbar 插件可能在本次 apply 之后才就绪：有限重试几次即可。
          if (attempt < 6 && !clientDisposed) {
            retryTimer = window.setTimeout(() => tryMountRightbar(attempt + 1), 500 * (attempt + 1))
          }
          return
        }
        void fetchUiConfig().then((cfg) => {
          if (clientDisposed) return
          if (!cfg.showRightbarTab) return
          const removeRightbar = mountRightbarTab(tabs, ctx.slots as unknown as RightbarSlotsFace)
          if (removeRightbar !== undefined) disposers.push(removeRightbar)
        }).catch((error) => {
          console.error('[dsh-tiddlywiki] rightbar config load failed:', error)
        })
      }
      // Register the timer recycler BEFORE the first attempt (it may throw).
      disposers.push(() => { if (retryTimer !== undefined) window.clearTimeout(retryTimer) })
      tryMountRightbar(0)
    })
    // Reply-stream native tool cards: keyed `tool.call.toolview` slots for
    // every tiddlywiki_* tool (additive — our keys are unclaimed).
    safeMount('tool views', () => {
      if (ctx.slots !== undefined) disposers.push(...registerToolViews(ctx.slots))
    })
    // Clickable wiki links in the reply stream → open the TW panel.
    safeMount('wiki link interceptor', () => disposers.push(installWikiLinkInterceptor()))
    // Settings page → Settings → 「TiddlyWiki 知识库」(config panel §13).
    safeMount('settings section', () => {
      const removeSettings = ctx.slots?.inject('settings.section', () =>
        ctx.slots?.register(
          { name: 'settings.section', id: 'dsh-tiddlywiki', order: 50, label: 'TiddlyWiki 知识库' },
          SettingsSection,
        ),
      )
      if (removeSettings !== undefined) disposers.push(removeSettings)
    })
    if (ctx.effect !== undefined) {
      ctx.effect(() => disposeAll, 'dsh-tiddlywiki: client mount')
    } else {
      // 宿主不提供 effect 钩子时的兜底回收点：整页卸载（pagehide）即回收全部
      // side effect，绝不因为缺少注册点而全量泄漏。
      window.addEventListener('pagehide', disposeAll, { once: true })
    }
  } catch (error) {
    console.error('[dsh-tiddlywiki] client half failed to start:', error)
  }
}

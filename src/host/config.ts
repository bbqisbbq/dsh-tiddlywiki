/**
 * Extensible plugin config (design doc §13, config panel).
 *
 * Two layers:
 *   base      — the cordis `config:` block (profile composition, defaults);
 *   overrides — a user-editable config tiddler ($:/plugins/dsh-tiddlywiki/config,
 *               a JSON string) written by the settings page.
 * The tiddler overlays the base (tiddler wins), so future config fields just
 * extend the shape — no schema, no @deepseek-ai dependency, and the config
 * travels with the wiki's git history.
 *
 * @module dsh-tiddlywiki/host/config
 */
import type { TiddlyWebClient } from './tw-api.ts'

/** Config tiddler (JSON string) where the settings page stores overrides. */
export const CONFIG_TIDDLER = '$:/plugins/dsh-tiddlywiki/config'

/** TW frontend API base tiddler, pointed at the same-origin DSH proxy. */
export const TW_WEB_HOST_TIDDLER = '$:/config/tiddlyweb/host'

/** The legacy default TW host value this plugin replaces with the proxy. */
export const TW_WEB_HOST_DEFAULT = '$protocol$//$host$/'

/**
 * Default dark palette the embedded TW switches to when DSH is dark
 * (mirrored in src/client/theme-sync.ts — the two bundles cannot share code).
 */
export const DARK_PALETTE_DEFAULT = '$:/palettes/CupertinoDark'

/** Extensible, loose plugin config shape (future fields just appear here). */
export interface PluginConfigShape {
  note?: { tag?: string }
  git?: { autoCommit?: boolean; debounceMs?: number; remote?: string; branch?: string }
  ui?: {
    /** 是否在界面右下角显示「快速笔记」悬浮按钮（默认 true）。 */
    showQuickNote?: boolean
    /** 是否显示 TW 面板右下角的「状态/重载」悬浮按钮（默认 true）。 */
    showPanelStatus?: boolean
    /** 是否在界面右下角显示「同步」悬浮按钮（默认 true）。 */
    showSyncButton?: boolean
    /**
     * 嵌入式 TW 是否跟随 DSH 深浅主题（默认 true）：DSH 暗色时把 TW 活动
     * palette 临时切到 `darkPalette`，浅色时恢复用户原 palette；仅内存生效，
     * 不会写回 wiki。
     */
    followDshTheme?: boolean
    /** DSH 暗色时 TW 使用的 palette tiddler 标题（默认 CupertinoDark）。 */
    darkPalette?: string
    /**
     * 一键发送给 Agent（TW 笔记 → DSH 会话注入）。
     * `enabled: false` 时路由 403、TW 端按钮点击提示未启用；`token` 非空时
     * 路由要求请求头 `x-send-to-agent-token` 与之匹配；`endpoint` 可覆盖
     * TW 端默认的 `location.origin + /dsh-tiddlywiki`。
     */
    sendToAgent?: { enabled?: boolean; endpoint?: string; token?: string }
    /**
     * 「所有文章」两列分页页面的每页条数（默认 10）。页面在渲染时实时读取
     * 该值（见 seed-all-articles），改后无需重新初始化。
     */
    allArticles?: { pageSize?: number }
  }
  uiLanguage?: string
  [key: string]: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deep-merge: `over` wins; nested plain objects merge recursively. */
export function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key] as Record<string, unknown>, value)
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * Runtime config store: caches the override tiddler and exposes the effective
 * (merged) config. `load` runs at startup and after every write/restart.
 */
export class ConfigStore {
  private overrides: PluginConfigShape = {}

  constructor(private readonly base: PluginConfigShape) {}

  /** Effective config = cordis base overlaid with the user override tiddler. */
  get(): PluginConfigShape {
    return deepMerge(this.base, this.overrides) as PluginConfigShape
  }

  /** Reload the override tiddler (no-op when the wiki is unavailable). */
  async load(client: TiddlyWebClient | undefined): Promise<void> {
    this.overrides = {}
    if (client === undefined) return
    try {
      const tiddler = await client.get(CONFIG_TIDDLER)
      if (tiddler !== undefined && typeof tiddler.text === 'string') {
        const parsed = JSON.parse(tiddler.text) as unknown
        if (isPlainObject(parsed)) this.overrides = parsed as PluginConfigShape
      }
    } catch {
      // Wiki not ready or config tiddler unreadable → keep empty overrides.
      this.overrides = {}
    }
  }

  /** Merge a patch into the overrides and persist the tiddler. */
  async set(client: TiddlyWebClient, patch: PluginConfigShape): Promise<PluginConfigShape> {
    this.overrides = deepMerge(this.overrides, patch) as PluginConfigShape
    await client.put({
      title: CONFIG_TIDDLER,
      text: JSON.stringify(this.overrides, null, 2),
      type: 'application/json',
      tags: [],
    })
    return this.get()
  }
}

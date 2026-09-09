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
  /**
   * 本地剪藏桥（书签小工具）：DSH 进程内监听 127.0.0.1 的 HTTP 桥，接收
   * 书签 POST 的 {title,url,text} 并写入 wiki。`enabled` 保存后立即生效
   * （每个请求实时判定）；`token` 非空时校验 `x-clip-token` 头；`tag` 为
   * 剪藏笔记默认 tag；`port` 改动需重启 dsh web（监听只在启动时绑定一次）。
   */
  bridge?: { enabled?: boolean; port?: number; token?: string; tag?: string }
  note?: { tag?: string }
  git?: { autoCommit?: boolean; debounceMs?: number; remote?: string; branch?: string }
  ui?: {
    /** 是否在界面右下角显示「快速笔记」悬浮按钮（默认 true）。 */
    showQuickNote?: boolean
    /**
     * 是否在聊天输入框上方（conversation.input.dock 槽位）显示「快速笔记」
     * 快捷按钮（默认 true）。与其它插件（todo/cost-meter/goal/queue/git-graph
     * 等）注入的内容同处一个纵向排列的 dock 区，天然不重叠。
     */
    showQuickNoteDock?: boolean
    /**
     * 点击「快速笔记」后的打开方式（默认 `native`）：
     * `native` = 直接弹出 TW 原生编辑器（新建/恢复草稿）；`card` = 弹出现有
     * 的 Markdown 快速笔记卡片。设置页可切换。
     */
    quickNoteMode?: 'native' | 'card'
    /** 左侧侧边栏 TW 入口的显示名称（默认「TiddlyWiki」，可自定义）。 */
    sidebarLabel?: string
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
    /**
     * 会话顶部「知识库」Tab 的显示名称（默认「知识库」）。该 Tab 显示本会话
     * 产生/读取/检索过的 wiki 笔记汇总（conversation.view 槽位，见
     * src/client/session-summary.ts）。
     */
    tabLabel?: string
    /** 是否在会话顶部显示「知识库」Tab（会话相关 wiki 汇总，默认 true）。 */
    showSessionTab?: boolean
    /**
     * 是否在 DSH 右侧边栏（new rightbar）提供 TiddlyWiki 入口/Tab（默认
     * true）：在 rightbar 首页（guide 页）注册「TiddlyWiki 知识库」入口盒，
     * 点击即在右侧栏以 tab 形式打开完整 TW 编辑器（与聊天并排）。老版本
     * DSH 无 rightbar 时该配置不生效（客户端自动跳过）。
     */
    showRightbarTab?: boolean
    /**
     * 是否在 DSH Better Sidebar（dsh-better-sidebar 插件）侧边栏提供
     * TiddlyWiki tab（默认 true）：通过其 client 服务 `ctx.betterSidebar`
     * 注册 tab 类型，+ 菜单可打开完整 TW 编辑器（与聊天并排）。未安装
     * Better Sidebar 时该配置不生效（客户端自动跳过）；该插件自己的设置页
     * 也为本 tab 提供独立的启用开关。
     */
    showBetterSidebarTab?: boolean
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

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
  note?: {
    tag?: string
    /**
     * 自动给 **Agent 新建**的笔记打工作区标记（默认 true，v0.24.0）：
     * 标签 `ws/<项目名>` + 字段 `workspace: <项目名>`。
     *
     * 「项目名」取调用方会话的 cwd 末段（`sessions.get(id).header.cwd`），
     * 由插件自己解析——不再依赖提示词里那句「记得带上工作区名」。
     * ⚠️ `ws/` 前缀是承重的：裸项目名会与业务标签撞车（本机 `dsh-tiddlywiki`
     * 已被 2510 条书章节占用），撞了以后「按工作区检索」就失去意义。
     */
    workspaceMark?: boolean
  }
  /**
   * TW 子进程启动策略（v0.22.5）。`readyTimeoutMs` 是**软就绪窗口**（默认 60000，
   * 夹在 5s–600s）：超过它只写一条「slow start」日志并继续等，硬上限 = 3×，
   * 仍未就绪才判失败（失败后还会挂一个有界「迟到就绪」后台探测，TW 真起来时
   * 立刻把状态改回 running）。大知识库冷启动（数千条目、5000+ 文件）实测可达
   * 40s+，旧代码 20s 的硬超时会误报 `wiki server did not become ready in time`
   * 并连带跳过播种/配置/剪藏桥。保存后对**下一次**启动/重启生效（无需重启 dsh web）。
   */
  startup?: { readyTimeoutMs?: number }
  /**
   * 注入给每个会话的系统提示词（v0.21.0）。默认 `slim`：只保留工具 schema
   * 表达不了的治理约定（同步纪律 / 标签 / 链接格式），不再手抄工具参数；
   * `full` 额外附一份**由工具注册表实时生成**的参数索引（永不过期）。
   * `override` 整段替换内置正文，`extra` 永远追加在最后。
   * 设置页保存后无需重启 dsh web：section 会重新注册，当前会话下一步即生效。
   */
  prompt?: { enabled?: boolean; mode?: 'slim' | 'full'; extra?: string; override?: string }
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
  }
  uiLanguage?: string
  /**
   * 微信公众号发布（**可选功能，默认关闭**，v0.23.0）。
   *
   * 这是一项**需要额外安装**的能力：真正干活的是仓库 `tools/wechat/` 下的
   * opencli adapter + Browser Bridge 浏览器扩展（见 docs/wechat-publish-setup.md），
   * 插件本体不含它、不装也不影响任何其他功能。
   *
   * 因此本开关默认 `false`——关闭时：
   *   - 注入提示词**不含**发布相关的约定（不打扰不用该功能的用户）；
   *   - 启动 seed **不写**「发布元数据规范」与「微信公众号发布指南」文档；
   *   - `/wechat/*` 三条路由一律 403（TW 工具栏按钮也不会出现）。
   * 打开后：提示词多一行发布前检查约定，并在启动时把这两篇文档写进 wiki。
   * 保存后即时生效（提示词 section 会重注册），无需重启 dsh web。
   *
   * v0.23.3 新增三个可选字段，服务「TW 工具栏一键发布」：
   *   - `command`：opencli 可执行文件（默认 `opencli`；装了别名/绝对路径时用）；
   *   - `adapter`：`publish-note`（默认，支持 --cover 单图）或 `publish-note-imgs`
   *     （正文内嵌图全部上传 CDN，需先重跑 install-wechat-adapters.mjs）；
   *   - `token`：非空时 `/wechat/*` 要求请求头 `x-wechat-publish-token` 匹配
   *     （按钮会把 token 带上；与 sendToAgent.token 同思路，防的是「任何能打开
   *     DSH Web UI 的人都能用你本机 Chrome 对外发文」）；
   *   - `dsn`：adapter 回连 DSH 的基址，留空 = 按请求端口自动推导
   *     （`http://127.0.0.1:<端口>/dsh-tiddlywiki`）。
   *   - `endpoint`（**只被 TW 侧读**，host 不用）：覆盖按钮自己的请求基址，
   *     默认 `location.origin + /dsh-tiddlywiki`（同 sendToAgent.endpoint 的用途，
   *     反向代理/远程访问场景）。
   */
  wechat?: { enabled?: boolean; command?: string; token?: string; adapter?: 'publish-note' | 'publish-note-imgs'; dsn?: string; endpoint?: string }
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
 * The config tiddler EXISTS but cannot be understood (v0.23.4).
 *
 * `set()` used to fall back to the in-memory cache when the stored text failed
 * to parse — and right after a failed `load()` that cache is EMPTY, so a single
 * settings-page save silently replaced the whole config with just the fields
 * the form happened to send. That is exactly what happened on 2026-09-18 after
 * a leftover `<<<<<<<` conflict block (committed by the auto-committer) made
 * the tiddler unparseable: `prompt.extra` / `git.remote` / `ui.*` were wiped.
 * Saving is now REFUSED instead, and the reason is surfaced to the user.
 */
export class ConfigUnreadableError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message)
    this.name = 'ConfigUnreadableError'
  }
}

/** User-facing explanation for a refused save (kept next to the config tiddler name). */
export function describeUnreadableConfig(): string {
  return `配置 tiddler ${CONFIG_TIDDLER} 存在但不是合法 JSON（常见原因：git 冲突标记 <<<<<<< 残留，或手工编辑出错）。`
    + '为避免抹掉其它设置，本次保存已被拒绝。请先修好该 tiddler（或删除它、回落到 cordis config 块）再保存。'
}

/**
 * Runtime config store: caches the override tiddler and exposes the effective
 * (merged) config. `load` runs at startup and after every write/restart.
 */
export class ConfigStore {
  private overrides: PluginConfigShape = {}
  /** Set when the stored tiddler exists but cannot be parsed (v0.23.4). */
  private lastParseError: string | undefined

  constructor(private readonly base: PluginConfigShape) {}

  /** Effective config = cordis base overlaid with the user override tiddler. */
  get(): PluginConfigShape {
    return deepMerge(this.base, this.overrides) as PluginConfigShape
  }

  /**
   * Why the stored config is unusable, or undefined when everything is fine.
   * `/admin/state` exposes this so the settings page can show a banner instead
   * of pretending the (ignored) overrides are in effect.
   */
  parseError(): string | undefined {
    return this.lastParseError
  }

  /**
   * Reload the override tiddler (no-op when the wiki is unavailable).
   *
   * A MISSING tiddler (404) legitimately means "no overrides" and clears the
   * cache. A transient FAILURE (wiki restarting, timeout, 5xx) must NOT: wiping
   * the cache on error silently reverted every user setting for the rest of the
   * session, and the next `set()` then persisted a config tiddler without the
   * user's other overrides.
   *
   * A tiddler that exists but does not PARSE is a third case (v0.23.4): the
   * cache is kept (writes are refused, so nothing can be lost) and the failure
   * is recorded for the UI — see ConfigUnreadableError.
   */
  async load(client: TiddlyWebClient | undefined): Promise<void> {
    if (client === undefined) {
      this.overrides = {}
      this.lastParseError = undefined
      return
    }
    let tiddler
    try {
      tiddler = await client.get(CONFIG_TIDDLER)
    } catch (err) {
      // Keep whatever we already have (usually the previous overrides).
      console.warn('[dsh-tiddlywiki] config tiddler unreadable, keeping cached overrides:', err instanceof Error ? err.message : err)
      return
    }
    if (tiddler === undefined) {
      this.overrides = {}
      this.lastParseError = undefined
      return
    }
    const raw = typeof tiddler.text === 'string' ? tiddler.text : ''
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!isPlainObject(parsed)) throw new Error('config tiddler is not a JSON object')
      this.overrides = parsed as PluginConfigShape
      this.lastParseError = undefined
    } catch {
      // Malformed/unparseable: keep the cache (never revert to the base) and
      // remember WHY so the UI can say it out loud.
      this.lastParseError = describeUnreadableConfig()
      console.warn('[dsh-tiddlywiki] config tiddler is not valid JSON, keeping cached overrides; saving is blocked until it is fixed')
    }
  }

  /**
   * Merge a patch into the overrides and persist the tiddler.
   *
   * The patch is merged onto the STORED overrides (re-read here), not just the
   * in-memory cache: if the startup `load()` failed transiently, saving one
   * setting must not drop every other override the user had stored.
   *
   * ⚠️ When the stored tiddler exists but is UNPARSEABLE this THROWS
   * (v0.23.4) instead of merging onto an empty cache — see ConfigUnreadableError.
   */
  async set(client: TiddlyWebClient, patch: PluginConfigShape): Promise<PluginConfigShape> {
    let stored: PluginConfigShape = this.overrides
    // The existing tiddler is read to merge onto (not just the cache), and its
    // `created` is carried over (v0.22.10): the config tiddler is re-PUT on every
    // settings save, and `put()`'s safety net would otherwise re-stamp it each
    // time — `created` must stay at the first write, `modified` tracks edits.
    let existingCreated: string | undefined
    let storedText: string | undefined
    try {
      const tiddler = await client.get(CONFIG_TIDDLER)
      if (tiddler !== undefined && typeof tiddler.text === 'string') {
        storedText = tiddler.text
        const parsed = JSON.parse(tiddler.text) as unknown
        if (!isPlainObject(parsed)) throw new Error('config tiddler is not a JSON object')
        stored = parsed as PluginConfigShape
      }
      if (tiddler !== undefined && typeof tiddler.created === 'string' && tiddler.created.trim().length > 0) {
        existingCreated = tiddler.created
      }
    } catch (err) {
      // Read succeeded (we have the raw text) but the content is unusable:
      // refuse — writing would drop every key the caller did not send. A READ
      // failure (no raw text) keeps the old "merge onto the cache" behaviour.
      if (storedText !== undefined) {
        this.lastParseError = describeUnreadableConfig()
        throw new ConfigUnreadableError(describeUnreadableConfig(), storedText)
      }
      // Unreadable config tiddler → merge onto the in-memory cache.
      void err
    }
    this.overrides = deepMerge(stored, patch) as PluginConfigShape
    await client.put({
      title: CONFIG_TIDDLER,
      text: JSON.stringify(this.overrides, null, 2),
      type: 'application/json',
      tags: [],
      ...(existingCreated !== undefined ? { created: existingCreated } : {}),
    })
    return this.get()
  }
}

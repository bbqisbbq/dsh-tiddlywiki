/**
 * The plugin's `config:` surface: its shape, its defaults, and the merge.
 *
 * Extracted from `src/index.ts` (v0.30.42). The handoff's step B asked to tell
 * "**配置常量**" apart from "**阶段产物**" before touching `apply()`'s lifecycle
 * stages — this is the whole 配置常量 half. It is **pure** (no ctx, no side
 * effects, no ordering), which is exactly why it can leave the entry point
 * without disturbing the assembly order that IS semantic.
 *
 * ⚠️ `DEFAULTS` is cross-checked by `scripts/verify-config-ranges.mjs` against
 * the host clamp table and the settings-page form (same numbers in three
 * places). That guard reads the `src/index` **module family**, so this file is
 * covered — but if you ever rename the base, the family read goes blind (see
 * `scripts/lib/source-family.mjs`).
 *
 * @module dsh-tiddlywiki/index-config
 */
import { DARK_PALETTE_DEFAULT } from './host/config.ts'
import { READY_TIMEOUT_DEFAULT_MS } from './host/ready-policy.ts'
import { resolveWikiRoot } from './index-wikis.ts'

/** Plugin config (design doc §13). Defaults are applied in apply().
 *  Mirrors PluginConfigShape (src/host/config.ts) — the cordis `config:` block;
 *  keep the two shapes in lockstep when adding a config field. */
export interface TiddlywikiConfig {
  wikiRoot?: string
  wiki?: string
  port?: number
  git?: { autoCommit?: boolean; debounceMs?: number; remote?: string; branch?: string }
  note?: {
    tag?: string
    /**
     * 自动给 **Agent 新建**的笔记打工作区标记（默认 true，v0.24.0；v0.25.0 补上
     * 这里漏掉的字段——它与 PluginConfigShape/DEFAULTS 三处形状必须同步）。
     */
    workspaceMark?: boolean
  }
  /** 本地剪藏桥（书签小工具）：见 host/clip-bridge.ts 与 seed-clip-bridge.ts 文档。 */
  bridge?: { enabled?: boolean; port?: number; token?: string; tag?: string; wiki?: string }
  /** 注入给每个会话的系统提示词（v0.21.0，见 host/prompt.ts）。 */
  prompt?: { enabled?: boolean; mode?: 'slim' | 'full'; extra?: string; override?: string }
  /** TW 子进程启动策略（v0.22.5，见 host/ready-policy.ts）：软就绪窗口 ms。 */
  startup?: { readyTimeoutMs?: number }
  /**
   * 可选功能：微信公众号发布（v0.23.0，**默认关闭**）。该能力需额外安装
   * opencli + Browser Bridge 浏览器扩展（见 docs/wechat-publish-setup.md），
   * 插件本体不含它；关闭时不影响任何其他功能。
   * v0.23.3 起 `command`/`adapter`/`token`/`dsn` 服务于 TW 工具栏「发布到公众号」
   * 按钮（见 host/wechat-publish.ts）。
   */
  wechat?: { enabled?: boolean; command?: string; token?: string; adapter?: 'publish-note' | 'publish-note-imgs'; dsn?: string; endpoint?: string }
  ui?: { showQuickNote?: boolean; showQuickNoteDock?: boolean; quickNoteMode?: 'native' | 'card'; sidebarLabel?: string; showPanelStatus?: boolean; showSyncButton?: boolean; followDshTheme?: boolean; darkPalette?: string; tabLabel?: string; showSessionTab?: boolean; showRightbarTab?: boolean; sendToAgent?: { enabled?: boolean; endpoint?: string; token?: string }; allArticles?: { pageSize?: number } }
  /** 启动时自动启用的 TW 语言代码（如 "zh-Hans"），也受配置 tiddler 覆盖。 */
  uiLanguage?: string
  auth?: { username?: string; password?: string }
}

/** Resolved plugin config (defaults merged with the `config:` block). */
export interface ResolvedConfig {
  wikiRoot: string
  wiki: string
  port: number
  git: { autoCommit: boolean; debounceMs: number; remote: string; branch: string }
  note: { tag: string; workspaceMark: boolean }
  bridge: { enabled: boolean; port: number; token: string; tag: string; wiki: string }
  ui: { showQuickNote: boolean; showQuickNoteDock: boolean; quickNoteMode: 'native' | 'card'; sidebarLabel: string; showPanelStatus: boolean; showSyncButton: boolean; followDshTheme: boolean; darkPalette: string; tabLabel: string; showSessionTab: boolean; showRightbarTab: boolean; sendToAgent: { enabled: boolean; endpoint?: string; token?: string }; allArticles: { pageSize: number } }
  startup: { readyTimeoutMs: number }
  /**
   * 可选功能：微信公众号发布（v0.23.0）。默认 `enabled: false`——该能力需要额外
   * 安装（opencli + 浏览器扩展，见 docs/wechat-publish-setup.md），插件本体不含它。
   * 关闭时不注入发布相关提示词、不写两个 gated seed，`/wechat/*` 三条路由也一律
   * 403（v0.23.3）。`command`/`adapter`/`token`/`dsn` 供 TW 工具栏按钮使用。
   */
  wechat: { enabled: boolean; command: string; token: string; adapter: 'publish-note' | 'publish-note-imgs'; dsn: string; /** TW 侧读的请求基址覆盖（host 不用，同 ui.sendToAgent.endpoint） */ endpoint?: string }
  uiLanguage: string
  auth: { username?: string; password?: string }
}

/** 剪藏桥默认端口（与 seed 文档书签代码里的地址保持一致）。 */
export const CLIP_BRIDGE_DEFAULT_PORT = 8618

/** Every default, in the exact shape `resolveConfig()` returns. */
export const DEFAULTS: ResolvedConfig = {
  wikiRoot: '',
  wiki: 'main',
  port: 0,
  git: { autoCommit: true, debounceMs: 60_000, remote: '', branch: 'main' },
  note: { tag: 'inbox', workspaceMark: true },
  bridge: { enabled: false, port: CLIP_BRIDGE_DEFAULT_PORT, token: '', tag: 'clip', wiki: '' },
  ui: { showQuickNote: true, showQuickNoteDock: true, quickNoteMode: 'native', sidebarLabel: 'TiddlyWiki', showPanelStatus: true, showSyncButton: true, followDshTheme: true, darkPalette: DARK_PALETTE_DEFAULT, tabLabel: '知识库', showSessionTab: true, showRightbarTab: true, sendToAgent: { enabled: true }, allArticles: { pageSize: 10 } },
  startup: { readyTimeoutMs: READY_TIMEOUT_DEFAULT_MS },
  // 可选功能默认关闭（v0.23.0）：需额外安装 opencli + 浏览器扩展才可用。
  // v0.23.3：command/adapter/token/dsn 是 TW 工具栏「发布到公众号」按钮的旋钮。
  wechat: { enabled: false, command: 'opencli', token: '', adapter: 'publish-note', dsn: '' },
  uiLanguage: '',
  auth: { username: '', password: '' },
}

/**
 * Merge the cordis `config:` block over `DEFAULTS`.
 *
 * `wikiRoot` goes through `resolveWikiRoot()` (env-expanded, else
 * `$DSH_HOME/tiddlywiki`); the runtime pointer file can still override it — see
 * `readLocationState()` in host/wiki-location.ts.
 */
export function resolveConfig(rawConfig: TiddlywikiConfig): ResolvedConfig {
  return {
    wikiRoot: resolveWikiRoot(rawConfig),
    wiki: rawConfig.wiki ?? DEFAULTS.wiki,
    port: rawConfig.port ?? DEFAULTS.port,
    git: { ...DEFAULTS.git, ...(rawConfig.git ?? {}) },
    note: { ...DEFAULTS.note, ...(rawConfig.note ?? {}) },
    bridge: { ...DEFAULTS.bridge, ...(rawConfig.bridge ?? {}) },
    ui: {
      ...DEFAULTS.ui,
      ...(rawConfig.ui ?? {}),
      // Merge nested ui.* groups explicitly so defaults stay required (a plain
      // spread of the lax cordis shape would widen them to optional).
      sendToAgent: { ...DEFAULTS.ui.sendToAgent, ...(rawConfig.ui?.sendToAgent ?? {}) },
      allArticles: { ...DEFAULTS.ui.allArticles, ...(rawConfig.ui?.allArticles ?? {}) },
    },
    uiLanguage: typeof rawConfig.uiLanguage === 'string' ? rawConfig.uiLanguage.trim() : DEFAULTS.uiLanguage,
    auth: { ...DEFAULTS.auth, ...(rawConfig.auth ?? {}) },
    startup: { ...DEFAULTS.startup, ...(rawConfig.startup ?? {}) },
    wechat: { ...DEFAULTS.wechat, ...(rawConfig.wechat ?? {}) },
  }
}

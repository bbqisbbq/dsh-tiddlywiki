/**
 * dsh-tiddlywiki — host half.
 *
 * TiddlyWiki 5 as the DSH persistent knowledge base. Wiring:
 * - WikiServer spawns/kills/self-heals the TW 5 child process (loopback, auto
 *   port) and scaffolds the wiki folder on first run;
 * - the git face bootstraps the wiki folder as a repository and wires the
 *   debounced auto-committer;
 * - `tiddlywiki_*` agent tools + a system-prompt section;
 * - /dsh-tiddlywiki routes when a webServer is present.
 *
 * Export shape follows dsh-taskboard: a function/namespace plugin —
 * `name` / `inject` / `apply`, NO default export. Config arrives as the
 * second apply() argument (Cordis `runtime.callback(ctx, config)`).
 *
 * Extra exports (WikiServer / TiddlyWebClient / GitFace / ...) exist for the
 * headless selftest and future reuse; the loader only reads name/inject/apply.
 *
 * @module dsh-tiddlywiki
 */
import type { IncomingMessage } from 'node:http'
import { AutoCommitter, GitFace } from './host/git.ts'
import { registerRoutes, type AgentPresetsFace, type PermissionPresetsFace, type SessionControllerFace, type SessionPersistenceFace, type SessionsFace, type SessionQueryFace, type WebServerFace, type WorkspaceRegistryFace } from './host/routes.ts'
import { ConfigStore, DARK_PALETTE_DEFAULT, type PluginConfigShape } from './host/config.ts'
import { registerAdminRoutes, resolveTwRoot, type AdminDeps, type AdminWikisApplyResult, type AdminWikisView } from './host/admin.ts'
import { checkAllSeeds, runSeedById, removeSeedById } from './host/seeds.ts'
import { TiddlyWebClient, isBinaryType, TEXT_LIST_FILTER } from './host/tw-api.ts'
import { ClipBridge, downloadClipImage, type BridgeConfig, type ClipImageDownload } from './host/clip-bridge.ts'
import { WechatPublishRunner, checkWechatReady, normalizeWechatConfig } from './host/wechat-publish.ts'
import { registerTiddlywikiTools, tiddlywikiToolSummary, type ToolsDeps, type ToolScope } from './host/tools.ts'
import { describePrompt, withScopeBanner, PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER, type PromptConfig } from './host/prompt.ts'
import {
  clearLocationState,
  defaultLocationStateFile,
  expandEnvPath,
  listWikiCandidates,
  locationPath,
  normalizeLocation,
  readLocationState,
  writeLocationState,
  type WikiLocation,
  type WikiLocationInfo,
  type WikiLocationSource,
} from './host/wiki-location.ts'
import { switchWiki, type WikiSwitchResult } from './host/wiki-switch.ts'
import { WikiInstance } from './host/wiki-instance.ts'
import { WikiFarm, resolveAgentScope, targetRuntimeFor } from './host/wiki-farm.ts'
import { defaultSessionScopeFile, isSafeSessionId, readSessionScopes, setSessionScope } from './host/session-scope.ts'
import { RepoCommitters } from './host/repo-committers.ts'
import { isInsidePath, pathComparisonKey } from './host/path-key.ts'
import {
  DEFAULT_WIKI_ID,
  DEFAULT_WIKI_MODE,
  applyWikiAction,
  defaultEntry,
  defaultRegistryFile,
  entryPath,
  readRegistry,
  singleEntryRegistry,
  validateRegistry,
  writeRegistry,
  type WikiEntry,
  type WikiRegistry,
} from './host/wiki-registry.ts'
import { READY_TIMEOUT_DEFAULT_MS } from './host/ready-policy.ts'
import { ANON_USERNAME, PATH_PREFIX, TW_PROXY_PATH, TW_PROXY_PREFIX, WikiServer, proxyBaseFor } from './host/wiki.ts'
import { dshHomePath, defineTool } from './sdk.ts'

/** Cordis plugin name (also the client loader id / profile row id). */
export const name = 'dsh-tiddlywiki'

/** Required host services (tool registry + prompt assembly). */
export const inject = ['tools', 'systemPrompt']

/** Re-exports for the headless selftest and future consumers. */
export { ANON_USERNAME, AutoCommitter, GitFace, PATH_PREFIX, TW_PROXY_PATH, TW_PROXY_PREFIX, TiddlyWebClient, isBinaryType, TEXT_LIST_FILTER, WikiServer, dshHomePath, defineTool, proxyBaseFor }
export { ConfigStore, ConfigPatchError, deepMerge, normalizeConfigPatch, ConfigUnreadableError, describeUnreadableConfig } from './host/config.ts'
export { describeConflict, GitConflictStateError } from './host/git.ts'
export { sanitizeTwFragment, isSafeUrl } from './host/sanitize.ts'
export { MISSING_TYPE_FILTER, ensureTiddlerTimestamps, formatTiddlerDate, parseTiddlerDate, toIsoDateString } from './host/tw-api.ts'
export { WORKSPACE_FIELD, WORKSPACE_TAG_PREFIX, normalizeWorkspaceName, workspaceMarkFromCwd, workspaceNameFromCwd, workspaceTagName } from './host/workspace.ts'
export {
  AGENT_WRITTEN_TAG,
  DEFAULT_NOTE_TYPE,
  HUMAN_EDITED_TAG,
  WriteConflictError,
  assertNoConflict,
  buildWriteTiddler,
  cleanTiddler,
  flattenTiddlerFields,
  normalizeFieldsArg,
} from './host/write-policy.ts'
export { openInTwEditor, registerRoutes } from './host/routes.ts'
export { writeSessionSummary, SESSION_SUMMARY_PREFIX } from './host/routes.ts'
export type { SessionQueryFace, SessionSummaryResult } from './host/routes.ts'
export { registerAdminRoutes, resolveTwRoot, readWikiInfo, writeWikiInfo, ensurePlugin, bundledCatalog, ensureLanguage, pinLanguageTiddler, normalizeThemes, readActiveThemeName, MASKED_SECRET, maskConfigSecrets, stripMaskedSecrets } from './host/admin.ts'
export { escapeInline } from './host/session-summary.ts'
export { seedDocNote, docNoteText, DOC_NOTE_TITLE, DOC_NOTE_TAG, DOC_NOTE_TEXT } from './host/seed-notes.ts'
export { hashText, parseSeedMarker, readSeedMarker, writeSeedMarker, SEED_MARKER_VERSION } from './host/seed-util.ts'
export { seedStarterDocs, STARTER_DOCS_ITEMS, STARTER_DOCS_MARKER_TITLE, DSH_DOCS_TAG } from './host/seed-starter-docs.ts'
export { seedSendToAgent, SEND_TO_AGENT_PLUGIN_TITLE, SEND_TO_AGENT_MARKER_TITLE, SEND_TO_AGENT_BUNDLE_TEXT } from './host/seed-send-to-agent.ts'
export { seedRenderRoute, RENDER_PLUGIN_TITLE, RENDER_MARKER_TITLE, RENDER_PLUGIN_FILE, RENDER_BUNDLE_TEXT } from './host/seed-render.ts'
export { seedHomeIndex, HOME_INDEX_ITEMS, HOME_INDEX_MARKER_TITLE, HOME_DEFAULT_TIDDLERS } from './host/seed-home.ts'
export { seedAllArticles, ALL_ARTICLES_TITLE, ALL_ARTICLES_MARKER_TITLE, ALL_ARTICLES_TEXT } from './host/seed-all-articles.ts'
export { seedUiStyles, UI_STYLE_ITEMS, UI_STYLES_MARKER_TITLE } from './host/seed-ui-styles.ts'
export { seedMenubarTheme, MENUBAR_THEME_TIDDLER, MENUBAR_THEME_MARKER_TITLE, MENUBAR_THEME_TEXT } from './host/seed-menubar-theme.ts'
export { seedClipBridge, unseedClipBridge, CLIP_BRIDGE_DOC_TITLE, CLIP_BRIDGE_MARKER_TITLE, CLIP_BRIDGE_DOC_TEXT, CLIP_BRIDGE_BOOKMARKLET, CLIP_BRIDGE_DRAG_HREF } from './host/seed-clip-bridge.ts'
export { seedWechatDocs, unseedWechatDocs, WECHAT_DOCS_TITLE, WECHAT_DOCS_MARKER_TITLE, WECHAT_DOCS_TEXT } from './host/seed-wechat-docs.ts'
export { seedWechatPublish, unseedWechatPublish, WECHAT_PUBLISH_PLUGIN_TITLE, WECHAT_PUBLISH_MARKER_TITLE, WECHAT_PUBLISH_BUNDLE_TEXT } from './host/seed-wechat-publish.ts'
export {
  WechatPublishRunner,
  checkWechatReady,
  normalizeWechatConfig,
  buildPublishInvocation,
  buildVersionInvocation,
  interpretPublishOutcome,
  scanAdapterDir,
  defaultAdaptersDir,
  defaultWechatJobDir,
  capOutput,
  tailOf,
  isSafeCliValue,
  isSafeDsn,
  WECHAT_ADAPTERS,
  WECHAT_ADAPTER_FILES,
  WECHAT_ADAPTER_MARKER,
  DEFAULT_WECHAT_ADAPTER,
  DEFAULT_WECHAT_COMMAND,
  type WechatAdapter,
  type WechatAdapterScan,
  type WechatPublishConfig,
  type WechatPublishJobView,
  type WechatReadyView,
} from './host/wechat-publish.ts'
export { runAllSeeds, checkAllSeeds, runSeedById, removeSeedById, waitForFileWrite, flushPendingWrites, needsRestartAfterSeeds, drainThenStop, SEED_DEFS, type SeedStatus, type SeedRunResult } from './host/seeds.ts'
export { registerTiddlywikiTools, TRASH_PREFIX, TRASH_INDEX_TITLE, TrashIndexUnavailableError, isJunkTag } from './host/tools.ts'
export { tiddlywikiToolSummary } from './host/tools.ts'
export {
  buildPromptText,
  describePrompt,
  escapePromptBraces,
  normalizePromptMode,
  normalizePromptPreview,
  scopeBanner,
  toolSignatureLines,
  withScopeBanner,
  PROMPT_GOVERNANCE_BLOCKS,
  PROMPT_MODES,
  PROMPT_SECTION_NAME,
  PROMPT_SECTION_ORDER,
  DEFAULT_PROMPT_MODE,
  type PromptConfig,
  type PromptDescription,
  type PromptMode,
  type PromptPreviewConfig,
  type PromptToolSummary,
} from './host/prompt.ts'
export {
  clearLocationState,
  defaultLocationStateFile,
  expandEnvPath,
  listWikiCandidates,
  locationPath,
  normalizeLocation,
  readLocationState,
  writeLocationState,
  LOCATION_STATE_VERSION,
  type WikiLocation,
  type WikiLocationInfo,
  type WikiLocationSource,
  type WikiLocationState,
} from './host/wiki-location.ts'
export { switchWiki, type WikiSwitchResult, type WikiSwitchDeps } from './host/wiki-switch.ts'
export {
  DEFAULT_WIKI_ID,
  DEFAULT_WIKI_MODE,
  RESERVED_WIKI_IDS,
  WIKI_MODES,
  WIKI_REGISTRY_VERSION,
  applyWikiAction,
  defaultEntry,
  defaultRegistryFile,
  deriveWikiId,
  entryLocation,
  entryPath,
  findEntry,
  findPathConflicts,
  normalizeEntry,
  normalizeWikiId,
  readRegistry,
  removeWiki,
  singleEntryRegistry,
  upsertWiki,
  validateRegistry,
  writeRegistry,
  type RegistryReadResult,
  type RegistryValidation,
  type WikiEntry,
  type WikiMode,
  type WikiAction,
  type WikiRegistry,
} from './host/wiki-registry.ts'
export { WikiInstance, type WikiInstanceBase, type WikiInstanceOptions } from './host/wiki-instance.ts'
export { isInsidePath, pathComparisonKey } from './host/path-key.ts'
export { WikiFarm, targetRuntimeFor, wikiIdFromRequest, resolveAgentScope, type AgentScope, type FarmChange, type WikiFarmOptions, type WikiRuntime } from './host/wiki-farm.ts'
export {
  SESSION_SCOPE_MAX_AGE_MS,
  SESSION_SCOPE_VERSION,
  defaultSessionScopeFile,
  isSafeSessionId,
  pruneScopes,
  readSessionScopes,
  setSessionScope,
  writeSessionScopes,
  type SessionScopeReadResult,
  type SessionScopeState,
} from './host/session-scope.ts'
export { RepoCommitters, type RepoCommitSettings, type RepoCommittersOptions } from './host/repo-committers.ts'
export {
  READY_TIMEOUT_DEFAULT_MS,
  READY_TIMEOUT_MAX_MS,
  READY_TIMEOUT_MIN_MS,
  READY_HARD_FACTOR,
  READY_POLL_MS,
  READY_SLOW_POLL_MS,
  awaitReady,
  normalizeReadyTimeoutMs,
  readyHardTimeoutMs,
  type ReadyOutcome,
  type ReadyProbeDeps,
} from './host/ready-policy.ts'
export { ClipBridge, buildClipTiddler, buildImageNoteTiddler, buildBinaryTiddler, downloadClipImage, hostAllowed, parseClipPayload, pickImageMime, imageExtensionForMime, isPrivateAddress, assertPublicImageUrl, resolveClipTitle, type BridgeConfig, type ClipBridgeDeps, type ClipImageDownload, type ClipImageResult } from './host/clip-bridge.ts'
export type { PluginConfigShape } from './host/config.ts'
export type { GitStatusView } from './host/git.ts'
export type { Tiddler } from './host/tw-api.ts'
export type { WikiServerOptions, WikiStatusView } from './host/wiki.ts'

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
  bridge?: { enabled?: boolean; port?: number; token?: string; tag?: string }
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

/** Structural host context (subset of the dsh host + cordis surfaces). */
export interface HostCtx {
  tools: { register(tool: unknown): () => void }
  systemPrompt: {
    /**
     * `text` may be a function: DSH evaluates it per ASSEMBLY with the assembly's
     * context (`{ scope: agent }`), which is how a section can differ per session
     * (v0.28.0 — see host/prompt.ts and the multi-wiki design note).
     */
    section(opts: { name: string; order: number; text: string | ((context: unknown) => string) }): () => void
  }
  inject<T = unknown>(names: string | string[], callback: (ctx: HostCtx) => T, config?: unknown): unknown
  effect(fn: () => unknown, label?: string): void
  get(name: string): unknown
  [key: string]: unknown
}

/** Resolved plugin config (defaults merged with the `config:` block). */
interface ResolvedConfig {
  wikiRoot: string
  wiki: string
  port: number
  git: { autoCommit: boolean; debounceMs: number; remote: string; branch: string }
  note: { tag: string; workspaceMark: boolean }
  bridge: { enabled: boolean; port: number; token: string; tag: string }
  ui: { showQuickNote: boolean; showQuickNoteDock: boolean; quickNoteMode: 'native' | 'card'; sidebarLabel: string; showPanelStatus: boolean; showSyncButton: boolean; followDshTheme: boolean; darkPalette: string; tabLabel: string; showSessionTab: boolean; showRightbarTab: boolean; sendToAgent: { enabled: boolean; endpoint?: string; token?: string }; allArticles: { pageSize: number } }
  startup: { readyTimeoutMs: number }
  /**
   * 可选功能：微信公众号发布（v0.23.0）。默认 `enabled: false`——该能力需要额外
   * 安装（opencli + 浏览器扩展，见 docs/wechat-publish-setup.md），插件本体不含它。
   * 关闭时不注入发布相关提示词、不写两个 gated seed，`/wechat/*` 三条路由也一律
   * 403（v0.23.3）。`command`/`adapter`/`token`/`dsn` 供 TW 工具栏按钮使用。
   */
  wechat: { enabled: boolean; command: string; token: string; adapter: 'publish-note' | 'publish-note-imgs'; dsn: string }
  uiLanguage: string
  auth: { username?: string; password?: string }
}

/** 剪藏桥默认端口（与 seed 文档书签代码里的地址保持一致）。 */
export const CLIP_BRIDGE_DEFAULT_PORT = 8618

/**
 * Official plugin whose parser every note this plugin writes depends on
 * (`text/markdown`). `--init server` does NOT include it — see ensurePlugin().
 *
 * v0.28.0: the constant moved to host/wiki-instance.ts, because applying it is
 * a PER-WIKI operation (each knowledge base carries its own tiddlywiki.info).
 */
export { MARKDOWN_PLUGIN } from './host/wiki-instance.ts'

const DEFAULTS: ResolvedConfig = {
  wikiRoot: '',
  wiki: 'main',
  port: 0,
  git: { autoCommit: true, debounceMs: 60_000, remote: '', branch: 'main' },
  note: { tag: 'inbox', workspaceMark: true },
  bridge: { enabled: false, port: CLIP_BRIDGE_DEFAULT_PORT, token: '', tag: 'clip' },
  ui: { showQuickNote: true, showQuickNoteDock: true, quickNoteMode: 'native', sidebarLabel: 'TiddlyWiki', showPanelStatus: true, showSyncButton: true, followDshTheme: true, darkPalette: DARK_PALETTE_DEFAULT, tabLabel: '知识库', showSessionTab: true, showRightbarTab: true, sendToAgent: { enabled: true }, allArticles: { pageSize: 10 } },
  startup: { readyTimeoutMs: READY_TIMEOUT_DEFAULT_MS },
  // 可选功能默认关闭（v0.23.0）：需额外安装 opencli + 浏览器扩展才可用。
  // v0.23.3：command/adapter/token/dsn 是 TW 工具栏「发布到公众号」按钮的旋钮。
  wechat: { enabled: false, command: 'opencli', token: '', adapter: 'publish-note', dsn: '' },
  uiLanguage: '',
  auth: { username: '', password: '' },
}

/** Config tiddler steering TW's frontend API base (tiddlywebadaptor). */
export { TW_WEB_HOST_TIDDLER, TW_WEB_HOST_DEFAULT } from './host/config.ts'

/*
 * `ensureTwWebHost()` used to live here and described the same contract as the
 * `tw-web-host` SEED in host/seeds.ts, which `bootstrapWiki()` actually runs at
 * startup and after a wiki switch — and which the settings page can re-run with
 * 「重新初始化」. Two implementations of "$:/config/tiddlyweb/host" (one of them
 * unreachable from production code) is exactly the drift this repo keeps
 * paying for, so v0.22.8 deleted the dead one and left the seed as the single
 * implementation. Its behaviour (write only when the tiddler is missing or still
 * the legacy default; never touch a user's custom base) is unchanged and is
 * covered by scripts/selftest.mjs through `runSeedById(..., 'tw-web-host')`.
 */

/**
 * Resolve the DEFAULT wikiRoot: explicit config (env-expanded) else
 * $DSH_HOME/tiddlywiki. The runtime pointer file can override it — see
 * `readLocationState()` in host/wiki-location.ts.
 */
function resolveWikiRoot(config: TiddlywikiConfig): string {
  if (config.wikiRoot !== undefined && config.wikiRoot.trim().length > 0) {
    return expandEnvPath(config.wikiRoot.trim())
  }
  return dshHomePath('tiddlywiki')
}

/*
 * `MANAGED_GITIGNORE_LINES` / `writeGitignore()` / `watchWiki()` moved to
 * host/wiki-instance.ts (v0.28.0). They hold a wiki FOLDER, so they belong to
 * the per-wiki runtime instead of the plugin's single closure — the policy
 * itself (only touch `.gitignore` when a managed line is missing; never kill
 * `dsh web` because `fs.watch` reported an async error) is unchanged.
 */


/**
 * Mount the host half.
 * @param ctx - the plugin context (tools + systemPrompt injected).
 * @param rawConfig - the plugin row's `config:` block (Cordis second arg).
 */
export function apply(ctx: HostCtx, rawConfig: TiddlywikiConfig = {}): void {
  const config: ResolvedConfig = {
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
  // ── The knowledge-base farm ────────────────────────────────────────────────
  // v0.28.0 split this into three parts, so each has exactly ONE implementation:
  //   host/wiki-instance.ts  ONE wiki's runtime (child + REST client + config +
  //                          committer + fs watcher + its own bootstrap)
  //   host/wiki-farm.ts      WHICH wikis should be running (the reconcile rules)
  //   host/wiki-registry.ts  WHERE the mode / list / default come from (wikis.json)
  // index.ts only wires them together. Everything below resolves through the
  // farm's DEFAULT runtime, which is why single-wiki behaviour is unchanged.
  /** Pointer file the LEGACY single-wiki switch persists (wiki-location.ts). */
  const locationStateFile = defaultLocationStateFile()
  /** The multi-wiki control file: mode + the wiki list + the default id. */
  const registryFile = defaultRegistryFile()
  /** The cordis `config:` block, as the base layer of every wiki's config. */
  const baseShape: PluginConfigShape = { note: config.note, git: config.git, ui: config.ui, uiLanguage: config.uiLanguage, bridge: config.bridge, startup: config.startup, wechat: config.wechat }
  /** The cordis-level default location (last resort in the registry chain). */
  const defaultLocation: WikiLocation = { root: config.wikiRoot, name: config.wiki }
  const git = new GitFace()
  /**
   * Auto-commit is keyed by REPOSITORY, not by wiki (v0.28.0): several knowledge
   * bases may be subfolders of one repository, and only one `git add -A` per
   * repository may run (see host/repo-committers.ts).
   */
  const repos = new RepoCommitters({
    git,
    /**
     * Per REPOSITORY (v0.28.0): several knowledge bases may share one repository,
     * so the setting is resolved from the first wiki INSIDE that repository (in
     * list order — deterministic), falling back to the default wiki and then to
     * the cordis base.
     *
     * Wikis in one repository disagreeing about `git.*` is almost always a
     * mistake (a repository has ONE remote, ONE branch, ONE index), so it is
     * called out rather than silently resolved.
     */
    settings: (repoRoot) => {
      const members = (farm?.registry.wikis ?? []).filter((entry) => entryIsInRepo(entry, repoRoot))
      const chosen = members[0]
      const runtimeConfig = (entry: WikiEntry | undefined): PluginConfigShape | undefined =>
        entry === undefined ? undefined : farm?.runtime(entry.id)?.eff()
      const g = (runtimeConfig(chosen) ?? eff()).git ?? {}
      if (members.length > 1) {
        const fingerprints = new Set(members.map((entry) => JSON.stringify(runtimeConfig(entry)?.git ?? {})))
        if (fingerprints.size > 1) {
          console.warn(`[dsh-tiddlywiki] 知识库 ${members.map((entry) => entry.id).join('、')} 共用同一个仓库（${repoRoot}），但各自配了不同的 git.* —— 一个仓库只有一份 git 设置，本次以「${chosen?.id ?? '默认库'}」为准`)
        }
      }
      return {
        autoCommit: g.autoCommit ?? config.git.autoCommit,
        debounceMs: g.debounceMs ?? config.git.debounceMs,
      }
    },
    message: () => `wiki autocommit ${new Date().toISOString()}`,
    log: (message) => console.warn('[dsh-tiddlywiki]', message),
  })
  /** Created by the startup task, once the control file has been read. */
  let farm: WikiFarm<WikiInstance> | undefined
  /** The runtime legacy/agent traffic falls back to (undefined = nothing up). */
  const defaultInstance = (): WikiInstance | undefined => farm?.defaultRuntime()
  const eff = (): PluginConfigShape => defaultInstance()?.eff() ?? baseShape
  const effectiveWorkspaceMark = (): boolean => defaultInstance()?.workspaceMark() ?? config.note.workspaceMark
  const effectiveBridge = (): BridgeConfig => defaultInstance()?.bridgeConfig() ?? config.bridge

  /** sessionId → wikiId (v0.28.0). Loaded at boot, written by the GUI selector. */
  let sessionScopes: Record<string, string> = {}
  /** File the session scopes live in (outside every wiki, see session-scope.ts). */
  const sessionScopeFile = defaultSessionScopeFile()
  /**
   * What the AGENT may act on for one session: the client, the wiki's identity
   * and — when there is none — an actionable reason.
   *
   * `ambiguous` is true when more than one knowledge base is visible; that is
   * what makes every tool result (and the injected prompt) name the wiki. With a
   * single visible wiki nothing changes, so existing installs see no difference.
   */
  const toolScope = (sessionId: string | undefined): ToolScope => {
    const resolution = resolveAgentScope(farm, sessionScopes, sessionId)
    const visible = farm?.registry.wikis.filter((entry) => entry.agentVisible).length ?? 0
    const client = resolution.runtime?.client()
    return {
      ...(client !== undefined ? { client } : {}),
      ...(resolution.entry !== undefined ? { id: resolution.entry.id, label: resolution.entry.label } : {}),
      // No client ⇒ say WHY (the resolver's sentence is actionable); a bare
      // "service not running" would send the user looking in the wrong place.
      ...(client === undefined ? { reason: resolution.reason ?? '知识库服务尚未就绪，请稍后重试' } : {}),
      ambiguous: visible > 1,
    }
  }

  const disposers: Array<() => void> = []
  const disposeAll = (): void => {
    for (const dispose of disposers.splice(0)) dispose()
  }

  /**
   * Effective 公众号发布 config (cordis base + settings-page overlay), read PER
   * REQUEST: enabling the feature, switching the adapter or rotating the token
   * applies without a dsh web restart. `normalizeWechatConfig` is the single
   * place that turns the loose config-tiddler JSON into the typed shape — a
   * garbage `adapter`/`command` falls back to the defaults instead of reaching
   * the spawned command line.
   */
  const effectiveWechat = (): ReturnType<typeof normalizeWechatConfig> => normalizeWechatConfig(eff().wechat)

  /**
   * WeChat publish runner (v0.23.3): owns the opencli child process behind the
   * TW toolbar button. Construction spawns nothing (the CLI is resolved per
   * run), and it is disposed with the plugin so a running publish never
   * outlives dsh web and leaves an orphan browser tab.
   */
  const wechatRunner = new WechatPublishRunner({
    command: () => effectiveWechat().command,
    adapter: () => effectiveWechat().adapter,
    log: (message) => console.warn(message),
  })
  disposers.push(() => wechatRunner.dispose())

  // ── System prompt section (v0.21.0: configurable + live) ──────────────────
  // The section text is built from the EFFECTIVE config (cordis base + config
  // tiddler overlay), so the settings page controls it. DSH emits
  // `system-prompt/change` on registration/disposal and re-renders the section
  // in history, so a settings save applies to the CURRENT session from its next
  // model step — no dsh web restart, no new session (the pre-v0.21 behaviour).
  //
  // `applyPrompt()` is called (a) after the wiki is up and the config tiddler
  // has been loaded, and (b) after every settings-page save (admin route →
  // `onConfigChanged`). Re-registration is skipped when the built text is
  // unchanged, so saving an unrelated setting never churns the prompt.
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
    const cfg = resolveAgentScope(farm, sessionScopes, sessionId).runtime?.eff() ?? baseShape
    // `wechat.enabled` (v0.23.0) is NOT a `prompt.*` field but it gates the
    // publish rule, and the feature is opt-in + separately installed — users who
    // never enabled it must see no publishing text.
    const built = withScopeBanner(describePrompt(
      { ...((cfg.prompt ?? {}) as PromptConfig), wechat: (cfg.wechat ?? {}).enabled === true },
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
  disposers.push(() => {
    disposePromptSection?.()
    disposePromptSection = undefined
  })

  /**
   * Readiness window from the EFFECTIVE config (v0.22.5): the settings page
   * saves `startup.readyTimeoutMs`, and this re-applies it to EVERY running
   * wiki — it takes effect on the next start()/restart() without a dsh web
   * restart. Values are clamped by host/ready-policy.ts.
   */
  const applyServerTuning = (): void => {
    for (const runtime of farm?.allRuntimes() ?? []) runtime.applyServerTuning()
  }

  /**
   * Lazy TW client. host/wiki-instance.ts owns both the port-change invalidation
   * (a crash before readiness makes the child re-probe a free port, so a cached
   * client must not stay pinned to a dead one) and the preemptive Basic
   * credentials (`auth.username` puts the child behind `readers`/`writers`, so
   * EVERY request — reads included — needs auth).
   */
  const client = (): TiddlyWebClient | undefined => defaultInstance()?.client()

  // 本地剪藏桥（书签小工具后端）：只监听 127.0.0.1，per-request 读 effective
  // config —— enabled/token/tag 在设置页保存后立即生效；port 只在启动时绑定
  // 一次（改端口需重启 dsh web，seed 文档已说明）。写入走唯一的 TiddlyWebClient
  // 通道（D1），不存在第二条写路径。
  const clipBridge = new ClipBridge({
    getConfig: effectiveBridge,
    write: async (tiddler) => {
      const c = client()
      if (c === undefined) throw new Error('wiki not ready')
      await c.put(tiddler)
    },
    exists: async (title) => {
      const c = client()
      if (c === undefined) throw new Error('wiki not ready')
      return (await c.get(title)) !== undefined
    },
    // Server-side image download: no browser CORS; a browser-ish UA + the clip
    // source page as Referer get past most hotlink-protected CDNs. The whole
    // SSRF posture (public http(s) only, per-hop validation with the resolved
    // address PINNED so DNS cannot rebind between check and connect, manual
    // redirects, streaming 15MB cap, no transparent decompression) lives in
    // downloadClipImage (v0.19.0).
    download: async (imageUrl, referer): Promise<ClipImageDownload> => {
      const result = await downloadClipImage(imageUrl, referer)
      return { buffer: result.buffer, type: result.type ?? null }
    },
    log: (m) => console.info('[dsh-tiddlywiki] clip bridge:', m),
  })
  ctx.effect(() => () => clipBridge.stop(), 'dsh-tiddlywiki: clip bridge')

  // Auto-committer + filesystem watcher live on the instance (v0.28.0). They are
  // still set up/torn down SEPARATELY: a runtime wiki switch has to release both
  // (they hold the OLD folder) and re-arm them for the new one. The teardown is
  // registered exactly ONCE below — a per-switch `disposers.push()` would leak a
  // disposer per switch.
  /**
   * Release every running wiki's fs watcher AND flush every repository's pending
   * commit (plugin teardown / a wiki switch). The COMMITTERS themselves are
   * plugin-wide — one per repository — so they are NOT dropped here: a switch
   * must not throw away the debounce window of unrelated wikis that share the
   * same repository.
   */
  const teardownCommitter = async (): Promise<void> => {
    for (const runtime of farm?.allRuntimes() ?? []) await runtime.teardownExtras()
    await repos.flush()
  }
  disposers.push(() => { void teardownCommitter() })

  /**
   * Re-apply the EFFECTIVE git config to the running instance (v0.25.0).
   *
   * Until then, `git.*` was read ONCE: `AutoCommitter` snapshots
   * `enabled`/`debounceMs` into immutable options at construction, and the remote
   * only reached the repo through `bootstrapGit()` at startup. The settings page
   * happily saved + echoed new values that changed nothing until a dsh web
   * restart — turning 自动提交 off kept committing, changing the remote kept
   * pushing to the old one. Rebuilding the committer closes that gap; the guard
   * flag (plus teardownExtras' own idempotence) keeps a burst of saves from
   * leaving two committers or a dangling fs watcher.
   *
   * Not covered on purpose: an already-initialised repository keeps its branch
   * (`git.branch` is only consulted by `git.init`), and clearing the remote
   * field does not delete `origin` (that is a destructive repo change the UI
   * never promised). Both are documented in the settings page + README.
   */
  const reapplyGitConfig = async (): Promise<void> => {
    await teardownCommitter()
    const g = eff().git ?? {}
    const remote = (typeof g.remote === 'string' && g.remote.trim().length > 0 ? g.remote : config.git.remote).trim()
    if (remote.length > 0) {
      // Repo-level operation: running it inside any wiki folder of that
      // repository sets the repository's `origin` (there is only one).
      const ensured = await git.ensureRemote(defaultPath(), remote)
      if (!ensured.ok) console.warn('[dsh-tiddlywiki] git remote update:', ensured.message)
    }
    repos.rebuild()
    for (const runtime of farm?.allRuntimes() ?? []) runtime.setupExtras()
  }

  /**
   * The same-origin proxy base a wiki's TW frontend must use (v0.28.0).
   * The rule itself lives in host/wiki.ts (`proxyBaseFor`) so the harness and the
   * host cannot disagree about it — see that function for why it matters.
   */
  const proxyBaseForEntry = (entry: WikiEntry): string => proxyBaseFor((farm?.registry.mode ?? 'single'), entry.id)

  /** Does this wiki live inside that repository (or is it the repository root)? */
  const entryIsInRepo = (entry: WikiEntry, repoRoot: string): boolean => {
    const path = entryPath(entry)
    return pathComparisonKey(path) === pathComparisonKey(repoRoot) || isInsidePath(repoRoot, path)
  }

  // Tools (works even while the wiki is down; the scope resolves lazily).
  const toolsDeps: ToolsDeps = {
    // Per SESSION (v0.28.0): the session's scope decides which knowledge base a
    // call acts on, filtered by `agentVisible`. A refusal carries a REASON, so a
    // hidden or stopped wiki fails loudly instead of writing somewhere else.
    scope: toolScope,
    git,
    // ⚠️ The GIT tools still act on the DEFAULT wiki's repository: a sync is a
    // repository-level operation (see host/repo-committers.ts), and per-session
    // git is not something the user asked for.
    wikiPath: () => defaultInstance()?.path ?? locationPath(defaultLocation),
    autoCommit: () => defaultInstance()?.touchAutoCommit(),
    // After a pull that changed the working tree, restart the wikis whose content
    // ACTUALLY changed (v0.28.0). The syncer drain happens inside the runtime's
    // restart (rule #1); here we only pick the right targets — several knowledge
    // bases may share one repository, so "something changed" is NOT the same
    // question as "this wiki is stale".
    restartAffected: async (dir: string, changedFiles: readonly string[]) => restartAffectedWikis(dir, changedFiles),
    // Workspace (project) marking for agent-created notes (v0.24.0): a tool call
    // carries its session id, and the session header carries the cwd — so the
    // plugin can tag new notes with the project all by itself instead of asking
    // the model to remember. Resolved lazily per call; every hop is optional.
    workspaceName: (sessionId: string) => {
      const sessions = ctx.get('sessions') as SessionsFace | undefined
      const header = (sessions?.get(sessionId) as { header?: { cwd?: unknown } } | undefined)?.header
      return typeof header?.cwd === 'string' ? header.cwd : undefined
    },
    workspaceMarkEnabled: () => effectiveWorkspaceMark(),
  }
  disposers.push(...registerTiddlywikiTools(ctx, toolsDeps))
  // Register the prompt section only AFTER the tools: `full` mode's signature
  // catalogue is generated from the registry filled by that call (v0.21.0).
  applyPrompt()

  // Bring the wiki up, load the override config, then bootstrap git + committer.
  //
  // DISPOSAL-AWARE (v0.19.1): this task is fire-and-forget, but teardown can run
  // while it is still awaiting (plugin hot-reload / disable / dsh web exit
  // within the first seconds). Without the flag the disposer finished first and
  // the startup task then spawned the TW child / bound the clip-bridge port —
  // an orphan process and a leaked listener. Every await below is followed by a
  // `disposed` check, and the task stops the child itself when it notices.
  let disposed = false

  /** single 模式的位置：旧指针文件 > cordis 默认（v0.22.0 的优先级，逐字保留）。 */
  const singleModeLocation = async (): Promise<WikiLocation> => {
    const state = await readLocationState(locationStateFile)
    if (state.error !== undefined) console.warn('[dsh-tiddlywiki]', state.error)
    return state.active ?? defaultLocation
  }

  /**
   * The CONTROL FILE as the settings page edits it — deliberately NOT the
   * registry the farm reconciles. In single mode they differ: the farm runs a
   * one-entry registry synthesized from the legacy pointer, while the file may
   * already list several candidates the user is about to switch to.
   */
  let controlRegistry: WikiRegistry | undefined
  let controlSource: 'file' | 'legacy' | 'default' = 'default'
  let controlWarnings: string[] = []
  let controlError: string | undefined
  /** What the control file says right now (synthesized when it does not exist yet). */
  const controlRegistryNow = (): WikiRegistry =>
    controlRegistry ?? singleEntryRegistry(defaultCurrentLocation(), DEFAULT_WIKI_ID, DEFAULT_WIKI_MODE)

  const startupTask = (async () => {
    try {
      // THE CONTROL FILE FIRST (v0.28.0): it carries the mode (single/multi), the
      // wiki list and the default id, and it must be read before anything starts
      // — which is exactly why it lives OUTSIDE every wiki (wiki-registry.ts).
      // The control file decides: mode + the wiki list.
      const read = await readRegistry({ file: registryFile, legacyFile: locationStateFile, fallback: defaultLocation })
      // Per-session scopes are a PREFERENCE: an unreadable file just means "no
      // explicit scope" and every session falls back to the default wiki.
      const scopes = await readSessionScopes(sessionScopeFile)
      if (scopes.error !== undefined) console.warn('[dsh-tiddlywiki]', scopes.error)
      sessionScopes = scopes.scopes
      controlRegistry = read.registry
      controlSource = read.source
      controlWarnings = read.warnings
      controlError = read.error
      if (read.error !== undefined) console.warn('[dsh-tiddlywiki]', read.error)
      for (const warning of read.warnings) console.warn('[dsh-tiddlywiki]', warning)
      console.info(`[dsh-tiddlywiki] ${read.registry.mode} 模式 · ${read.registry.wikis.length} 个知识库（来源：${read.source}）`)
      // single 模式 = 今天的行为，逐字保留：位置仍由旧指针文件（其次 cordis 默认）
      // 决定，registry 此时只记住 `mode` 与候选列表 —— 所以这里合成一份单条清单。
      const runRegistry = read.registry.mode === 'multi'
        ? read.registry
        : singleEntryRegistry(await singleModeLocation(), DEFAULT_WIKI_ID, 'single')
      farm = new WikiFarm<WikiInstance>(runRegistry, {
        createRuntime: (entry) => new WikiInstance({
          entry,
          base: config,
          git,
          twRoot: resolveTwRoot,
          touchCommit: (dir) => { void repos.touch(dir) },
          flushCommits: (dir) => repos.flush(dir),
          proxyBase: () => proxyBaseForEntry(entry),
        }),
        log: (message) => console.warn('[dsh-tiddlywiki]', message),
      })
      // Every instance brings ITSELF up (child → its config tiddler → seeds →
      // git → committer), so this one call replaces the old step-by-step startup.
      // One wiki failing never stops the others (the farm reports it).
      const change = await farm.startAll()
      if (change.started.length > 0) console.info(`[dsh-tiddlywiki] 已启动：${change.started.join(', ')}`)
      // The prompt section is a plugin-level singleton: rebuild it now that the
      // default wiki's config tiddler has been loaded.
      applyPrompt()
      if (disposed) {
        await farm.disposeAll()
        return
      }
      // Clip bridge: bind once on the DEFAULT wiki's configured port (works even
      // while disabled — every request re-checks the effective enabled flag, so
      // the settings-page toggle applies without a dsh web restart).
      try {
        await clipBridge.start(effectiveBridge().port)
        console.info(`[dsh-tiddlywiki] clip bridge listening on 127.0.0.1:${clipBridge.port} (enabled=${effectiveBridge().enabled})`)
      } catch (err) {
        console.warn('[dsh-tiddlywiki] clip bridge start:', err)
      }
      if (disposed) {
        try { await clipBridge.stop() } catch { /* already closing */ }
        await farm.disposeAll()
        return
      }
    } catch (err) {
      console.warn('[dsh-tiddlywiki] startup issue (self-healing is armed):', err)
    }
  })()

  // ── Runtime wiki location (v0.22.0, extended v0.28.0) ──────────────────────
  // TWO paths, because the two modes genuinely differ:
  //   single → legacy behaviour, verbatim: a pointer file OUTSIDE every wiki
  //            records the choice and `switchWiki()` moves the ONE running wiki
  //            with rollback (stop → repoint → start → bootstrap, and restore the
  //            old folder on failure). Covered by verify-wiki-switch.mjs.
  //   multi  → "move the DEFAULT wiki's folder": edit the registry and let the
  //            farm reconcile (stop → recycle → start). No whole-plugin rollback
  //            is needed there — the other knowledge bases keep serving.
  /** The folder the default wiki occupies, running or not. */
  const defaultPath = (): string => {
    const running = defaultInstance()
    if (running !== undefined) return running.path
    const entry = farm === undefined ? undefined : defaultEntry(farm.registry)
    return entry === undefined ? locationPath(defaultLocation) : entryPath(entry)
  }
  /** The `{root,name}` the default wiki currently occupies (running or not). */
  const defaultCurrentLocation = (): WikiLocation => {
    const running = defaultInstance()
    if (running !== undefined) return running.server.currentLocation
    const entry = farm === undefined ? undefined : defaultEntry(farm.registry)
    return entry === undefined ? defaultLocation : { root: entry.root, name: entry.name }
  }
  /** Source of the CURRENT location, for the settings page. */
  const locationSource = async (): Promise<WikiLocationSource> => {
    const state = await readLocationState(locationStateFile)
    if (state.active !== undefined && locationPath(state.active) === defaultPath()) return 'state'
    return typeof rawConfig.wikiRoot === 'string' && rawConfig.wikiRoot.trim().length > 0 ? 'config' : 'default'
  }
  const locationInfo = async (): Promise<WikiLocationInfo> => {
    const state = await readLocationState(locationStateFile)
    const current = defaultCurrentLocation()
    return {
      current: { ...current, path: defaultPath(), source: await locationSource() },
      default: { ...defaultLocation, path: locationPath(defaultLocation) },
      stateFile: locationStateFile,
      candidates: await listWikiCandidates(current.root),
      ...(state.error !== undefined ? { error: state.error } : {}),
    }
  }
  /** Single-flight guard: two concurrent switches would fight over the child. */
  let switching = false
  /** SINGLE mode: the legacy orchestrator, on the farm's default runtime. */
  const runSwitch = async (target: { root?: unknown; name?: unknown }, persist: (t: WikiLocation) => Promise<void>): Promise<WikiSwitchResult> => {
    if (switching) return { ok: false, error: '正在切换知识库，请稍候再试', rolledBack: true }
    // A switch in flight while the plugin is being disposed (hot reload / dsh web
    // shutdown) would re-arm the committer + fs watcher AFTER teardown ran, and
    // could even spawn a fresh TW child after `stop()` (v0.23.5).
    if (disposed) return { ok: false, error: '插件正在卸载，已取消切换', rolledBack: false }
    const runtime = defaultInstance()
    if (runtime === undefined) return { ok: false, error: '默认知识库当前没有运行，无法切换位置', rolledBack: false }
    switching = true
    try {
      const result = await switchWiki({
        currentLocation: () => runtime.server.currentLocation,
        currentPath: () => runtime.path,
        // v0.24.1: ironclad rule #1 lists the knowledge-base switch as a path
        // that MUST drain first; writes still in the OLD wiki's syncer queue were
        // otherwise killed with the child. `drainThenStop` is the shared primitive
        // (owned by the instance since v0.28.0); the rollback path reuses it, and a
        // missing client (child already down) is a no-op.
        stopServer: async () => { await runtime.drainStop() },
        applyLocation: (nextLocation) => {
          // Repoints the server AND drops the cached REST client (whose 2s list
          // cache belongs to the OLD wiki).
          runtime.updateEntry({ ...runtime.entry, root: nextLocation.root, name: nextLocation.name })
        },
        startServer: async () => { await runtime.server.start() },
        teardownExtras: () => runtime.teardownExtras(),
        setupExtras: () => { runtime.setupExtras() },
        reloadConfig: async () => {
          await runtime.config.load(runtime.client())
          // The new wiki carries its own config tiddler → its own prompt.*.
          applyPrompt()
        },
        bootstrap: async () => {
          await runtime.bootstrapWiki()
          await runtime.bootstrapGit()
        },
        savePointer: persist,
        log: (message) => console.warn('[dsh-tiddlywiki]', message),
      }, target)
      // Teardown may have run while the switch was awaiting: the switch itself
      // succeeded, but the extras it re-armed must be released again so we do not
      // leak a committer/watcher past dispose (v0.23.5).
      if (disposed) await runtime.teardownExtras()
      // The farm must agree with the runtime the orchestrator just moved — its
      // registry is what a later `apply()` (add/remove an entry) diffs against.
      if (result.ok && farm !== undefined) {
        const moved = runtime.entry
        farm.syncRegistry({ ...farm.registry, wikis: farm.registry.wikis.map((entry) => (entry.id === moved.id ? moved : entry)) })
      }
      return result
    } finally {
      switching = false
    }
  }
  /**
   * MULTI mode: move the DEFAULT wiki to another folder. The farm's reconcile
   * stops the old child, recycles the runtime and starts it on the new folder;
   * the registry is persisted LAST (a failed write costs restart-survival, not
   * the running wiki — same trade-off the pointer file already makes).
   */
  const repointDefault = async (target: { root?: unknown; name?: unknown }): Promise<WikiSwitchResult> => {
    if (disposed) return { ok: false, error: '插件正在卸载，已取消切换', rolledBack: false }
    if (farm === undefined) return { ok: false, error: '插件尚未就绪，请稍后再试', rolledBack: true }
    if (switching) return { ok: false, error: '正在切换知识库，请稍候再试', rolledBack: true }
    const normalized = normalizeLocation(target)
    if (normalized.location === undefined) return { ok: false, error: normalized.error ?? '位置非法', rolledBack: true }
    const next = normalized.location
    const current = defaultEntry(farm.registry)
    if (current === undefined) return { ok: false, error: '清单里没有默认知识库', rolledBack: true }
    const moved: WikiEntry = { ...current, root: next.root, name: next.name }
    const nextRegistry: WikiRegistry = { ...farm.registry, wikis: farm.registry.wikis.map((entry) => (entry.id === moved.id ? moved : entry)) }
    // Re-validate: moving a folder can collide with (or nest inside) another
    // registered wiki, and those rules are the whole point of the registry.
    const validated = validateRegistry(nextRegistry)
    if (validated.registry === undefined) return { ok: false, error: validated.fatal.join('；'), rolledBack: true }
    switching = true
    try {
      await farm.apply(validated.registry)
      const applied: WikiSwitchResult = { ok: true, location: { root: moved.root, name: moved.name }, path: entryPath(moved) }
      try {
        await writeRegistry(validated.registry, registryFile)
      } catch (err) {
        return { ...applied, warning: `位置已切换，但清单写入失败（重启 dsh web 后会回到原位置）：${err instanceof Error ? err.message : String(err)}` }
      }
      return applied
    } finally {
      switching = false
    }
  }
  /** Switch the DEFAULT wiki to another folder and remember the choice. */
  const switchWikiLocation = (target: { root?: unknown; name?: unknown }): Promise<WikiSwitchResult> => {
    if (farm?.registry.mode === 'multi') return repointDefault(target)
    return runSwitch(target, async (t) => { await writeLocationState(t, locationStateFile) })
  }
  /**
   * 「恢复为配置默认」: single mode drops the pointer and goes back to the cordis
   * default (cleared EVEN when the current folder already IS the default, or the
   * stale pointer wins again after the next restart); multi mode moves the
   * default wiki back to the configured location.
   */
  const resetWikiLocation = async (): Promise<WikiSwitchResult> => {
    if (farm?.registry.mode === 'multi') return repointDefault(defaultLocation)
    if (locationPath(defaultLocation) === defaultPath()) {
      await clearLocationState(locationStateFile)
      return { ok: true, location: defaultLocation, path: defaultPath() }
    }
    return runSwitch(defaultLocation, async () => { await clearLocationState(locationStateFile) })
  }

  /** The control file's view for the settings page (see controlRegistryNow). */
  const buildWikisView = (): AdminWikisView => {
    const registry = controlRegistryNow()
    return {
      mode: registry.mode,
      defaultId: registry.defaultId,
      source: controlSource,
      registryFile,
      ...(controlError !== undefined ? { error: controlError } : {}),
      warnings: controlWarnings,
      wikis: registry.wikis.map((entry) => {
        const runtime = farm?.runtime(entry.id)
        return {
          id: entry.id,
          label: entry.label,
          root: entry.root,
          name: entry.name,
          path: entryPath(entry),
          agentVisible: entry.agentVisible,
          autostart: entry.autostart,
          running: runtime !== undefined,
          status: runtime?.server.status().status ?? 'stopped',
        }
      }),
    }
  }

  /**
   * Restart the RUNNING wikis whose content a pull just changed (v0.28.0).
   *
   * Shared by the agent tool and the browser `/sync` route so the two cannot
   * drift. `dir` is where the pull ran (the repository is resolved from it) and
   * `changedFiles` are repository-relative — which is what makes this correct
   * when several knowledge bases share one repository.
   */
  const restartAffectedWikis = async (dir: string, changedFiles: readonly string[]): Promise<{ restarted: string[]; failed: Array<{ id: string; message: string }> }> => {
    if (farm === undefined) return { restarted: [], failed: [] }
    const repoRoot = (await repos.repoRootOf(dir)) ?? dir
    const restarted: string[] = []
    const failed: Array<{ id: string; message: string }> = []
    for (const runtime of farm.affectedBy(repoRoot, changedFiles)) {
      try {
        // `WikiInstance.restart()` drains the syncer queue first (rule #1).
        await runtime.restart()
        restarted.push(runtime.entry.id)
      } catch (err) {
        failed.push({ id: runtime.entry.id, message: err instanceof Error ? err.message : String(err) })
      }
    }
    return { restarted, failed }
  }

  // Routes + settings-panel admin surface (lazy webServer).
  ctx.inject(['webServer'], (webCtx: HostCtx) => {
    const ws = (webCtx as unknown as { webServer: WebServerFace }).webServer
    // sessionController is a core host service; read it LAZILY per request (via
    // the plugin root ctx) because it may be registered after webServer, and the
    // agent routes must work whenever a request actually arrives.
    const getSessionController = (): SessionControllerFace | undefined =>
      ctx.get('sessionController') as SessionControllerFace | undefined
    const getWorkspaceRegistry = (): WorkspaceRegistryFace | undefined =>
      ctx.get('workspaceRegistry') as WorkspaceRegistryFace | undefined
    // agentPresets (工作模式 roster) + sessionPersistence (per-session preset
    // badges) are also core host services — resolve them lazily like the above.
    const getAgentPresets = (): AgentPresetsFace | undefined =>
      ctx.get('agentPresets') as AgentPresetsFace | undefined
    const getSessionPersistence = (): SessionPersistenceFace | undefined =>
      ctx.get('sessionPersistence') as SessionPersistenceFace | undefined
    // permissionPresets (权限 preset roster for the picker + applying the
    // chosen permission to new sessions) and the `sessions` in-memory store
    // (the created live session handed to permissionPresets.set) are core host
    // services — resolve them lazily like the ones above.
    const getPermissionPresets = (): PermissionPresetsFace | undefined =>
      ctx.get('permissionPresets') as PermissionPresetsFace | undefined
    const getSessions = (): SessionsFace | undefined =>
      ctx.get('sessions') as SessionsFace | undefined
    // sessionQuery (会话日志查询，供「知识库」Tab 判定「本会话相关笔记」) 也是核心
    // host 服务 —— 可选注入（本部署存在），懒解析。
    const getSessionQuery = (): SessionQueryFace | undefined =>
      ctx.get('sessionQuery') as SessionQueryFace | undefined
    // v0.28.0: the request decides WHICH wiki. M1b-2b resolves every request to
    // the farm's DEFAULT runtime (the wiki this plugin has always served); the
    // `?wiki=<id>` selector arrives with the per-wiki GUI (M5). Every accessor
    // falls back to the cordis BASE when nothing is running, so a stopped farm
    // degrades to "base defaults + 503 on writes" instead of throwing.
    /**
     * Which wiki does this request target? `?wiki=<id>` (a running wiki), else
     * the farm's default — resolved by the SHARED helper in host/wiki-farm.ts,
     * so the host wiring and the verification harness cannot disagree about the
     * selector (and an unknown id falls back instead of 404ing).
     */
    const target = (req: IncomingMessage): WikiInstance | undefined => targetRuntimeFor(farm, req)
    const fallbackUi = WikiInstance.uiDefaultsFrom(config)
    const fallbackWechat = normalizeWechatConfig(config.wechat)
    /** Used only while nothing runs: base defaults, no wiki tiddler to read. */
    const idleConfig = new ConfigStore(baseShape)
    const disposeRoutes = registerRoutes({ webServer: ws }, {
      server: (req) => target(req)?.server,
      // The roster the GUI selector + the settings page read. It reports what
      // the FARM serves right now (in single mode that is the one synthesized
      // entry); the control file's full candidate list is the admin route's job.
      wikiSummaries: (req) => {
        const registry = farm?.registry
        return {
          mode: registry?.mode ?? 'single',
          defaultId: registry?.defaultId ?? DEFAULT_WIKI_ID,
          items: (registry?.wikis ?? []).map((entry) => {
            const runtime = farm?.runtime(entry.id)
            return {
              id: entry.id,
              label: entry.label,
              status: runtime?.server.status().status ?? 'stopped',
              agentVisible: entry.agentVisible,
              autostart: entry.autostart,
              running: runtime !== undefined,
              path: entryPath(entry),
            }
          }),
        }
      },
      // The `/tw/<id>/…` form: the proxy resolves the child by NAME (it cannot
      // use `target()`, whose `?wiki=` would be lost inside the iframe).
      serverById: (id) => farm?.runtime(id)?.server,
      wikiIds: () => farm?.registry.wikis.map((entry) => entry.id) ?? [],
      getClient: (req) => target(req)?.client(),
      git,
      autoCommit: (req) => target(req)?.touchAutoCommit(),
      noteDefaults: (req) => ({ tag: target(req)?.noteTag() ?? config.note.tag }),
      uiDefaults: (req) => target(req)?.uiDefaults() ?? fallbackUi,
      getWikiPath: (req) => target(req)?.path ?? defaultPath(),
      // Same helper as the agent tool (one implementation, two callers): a pull
      // can change several knowledge bases that share one repository.
      restartAffected: (_req, dir, changedFiles) => restartAffectedWikis(dir, changedFiles),
      // The composer's per-session selector (v0.28.0). Reading is a Map lookup;
      // writing persists to session-scope.ts AND starts the wiki on demand — the
      // tools resolve the scope SYNCHRONOUSLY and never start anything, so the
      // selection itself has to bring the wiki up, or the very next tool call
      // would have to refuse.
      sessionScope: {
        get: (sessionId: string) => {
          const resolution = resolveAgentScope(farm, sessionScopes, sessionId)
          const scopeId = sessionScopes[sessionId]
          return {
            ...(scopeId !== undefined ? { scope: scopeId } : {}),
            ...(resolution.entry !== undefined ? { resolved: { id: resolution.entry.id, label: resolution.entry.label } } : {}),
            ...(resolution.reason !== undefined ? { reason: resolution.reason } : {}),
          }
        },
        set: async (sessionId: string, wikiId: string | undefined) => {
          if (!isSafeSessionId(sessionId)) throw new Error('会话 id 非法')
          if (wikiId !== undefined) {
            const entry = farm?.registry.wikis.find((item) => item.id === wikiId)
            if (entry === undefined) throw new Error(`知识库「${wikiId}」不在清单里`)
            // `agentVisible: false` means "the agent never reaches this one"; a
            // selector that allowed it would contradict the setting silently.
            if (!entry.agentVisible) throw new Error(`知识库「${entry.label}」对 Agent 隐身，不能作为会话作用域`)
            if (farm !== undefined && farm.runtime(entry.id) === undefined) await farm.startEntry(entry)
          }
          await setSessionScope(sessionId, wikiId, sessionScopeFile)
          const next = { ...sessionScopes }
          if (wikiId === undefined) delete next[sessionId]
          else next[sessionId] = wikiId
          sessionScopes = next
        },
      },
      getSessionController,
      getWorkspaceRegistry,
      getAgentPresets,
      getSessionPersistence,
      getPermissionPresets,
      getSessions,
      getSessionQuery,
      sendToAgentEnabled: (req) => target(req)?.sendToAgent().enabled ?? config.ui.sendToAgent.enabled,
      sendToAgentToken: (req) => target(req)?.sendToAgent().token ?? (config.ui.sendToAgent.token ?? ''),
      // 公众号发布（v0.23.3，可选功能）：config 每请求重读（开关/adapter/token
      // 保存即生效，且每个知识库各有一份）；就绪探测每次都真跑一次
      // `opencli --version`（几百毫秒），只在按钮预检与每次起任务前发生，
      // 不做缓存以免装完 adapter 还要等 TTL。
      wechatConfig: (req) => target(req)?.wechatConfig() ?? fallbackWechat,
      wechatRunner: () => wechatRunner,
      wechatReady: async (req) => {
        const cfg = target(req)?.wechatConfig() ?? fallbackWechat
        return checkWechatReady({ enabled: cfg.enabled, command: cfg.command })
      },
    })
    const adminDeps: AdminDeps = {
      server: (req) => target(req)?.server,
      getClient: (req) => target(req)?.client(),
      getWikiPath: (req) => target(req)?.path ?? defaultPath(),
      twRoot: resolveTwRoot,
      config: (req) => target(req)?.config ?? idleConfig,
      // A settings-page save may change prompt.*: re-register the section (no
      // dsh web restart) and expose the built text for the preview panel.
      // startup.readyTimeoutMs is re-applied here too (next start/restart).
      onConfigChanged: () => {
        applyPrompt()
        applyServerTuning()
        // git.* must take effect on the RUNNING plugin (v0.25.0) — see
        // reapplyGitConfig: enabled/debounceMs/remote used to need a dsh web restart.
        void reapplyGitConfig()
      },
      // No draft → the SAVED config of the TARGETED wiki (what is injected right
      // now); with a draft → the settings form's unsaved values (v0.22.7),
      // through the same builder.
      getPrompt: (draft, req) =>
        describePrompt(draft ?? ((target(req)?.eff() ?? baseShape).prompt ?? {}) as PromptConfig, tiddlywikiToolSummary()),
      // Runtime wiki location (v0.22.0): read the current folder + how it was
      // decided, switch to another one, or drop back to the cordis default.
      wiki: {
        info: locationInfo,
        switch: switchWikiLocation,
        reset: resetWikiLocation,
      },
      // The knowledge-base LIST (v0.28.0): `info` reports the CONTROL FILE; every
      // action is validated by the pure `applyWikiAction` and persisted BEFORE
      // the farm reconciles — the file is the user's intent, and a reconcile
      // failure is reported per wiki instead of silently discarding the edit.
      wikis: {
        info: async (): Promise<AdminWikisView> => buildWikisView(),
        apply: async (body: unknown): Promise<AdminWikisApplyResult> => {
          if (disposed) return { ok: false, error: '插件正在卸载，已取消修改' }
          const action = applyWikiAction(controlRegistryNow(), body)
          if (action.registry === undefined) return { ok: false, error: action.error ?? '动作被拒绝' }
          const registry = action.registry
          try {
            await writeRegistry(registry, registryFile)
          } catch (err) {
            return { ok: false, error: `清单写入失败：${err instanceof Error ? err.message : String(err)}` }
          }
          controlRegistry = registry
          controlSource = 'file'
          controlWarnings = []
          controlError = undefined
          // Reconcile. multi → the farm runs the whole list. single → it must
          // keep serving the ONE wiki the legacy pointer names, so the
          // synthesized run-registry is used and the pointer is kept in step
          // (otherwise a restart in single mode would land somewhere else).
          const single = defaultEntry(registry)
          const runRegistry = registry.mode === 'multi'
            ? registry
            : singleEntryRegistry(single === undefined ? defaultCurrentLocation() : { root: single.root, name: single.name }, DEFAULT_WIKI_ID, 'single')
          const change = farm === undefined
            ? { started: [], stopped: [], updated: [], running: [], errors: [] }
            : await farm.apply(runRegistry)
          if (registry.mode === 'single' && single !== undefined) {
            await writeLocationState({ root: single.root, name: single.name }, locationStateFile).catch(() => undefined)
          }
          return { ok: true, info: buildWikisView(), change }
        },
      },
      seeds: {
        // Tool summaries feed the GENERATED seed content (the doc note's tool
        // list, v0.22.0) — pass them everywhere the registry can be re-run.
        checkAll: async (c) => checkAllSeeds({ client: c, tools: tiddlywikiToolSummary() }),
        run: async (c, id, force) => runSeedById({ client: c, tools: tiddlywikiToolSummary() }, id, force),
        remove: async (c, id) => removeSeedById({ client: c }, id),
      },
    }
    const disposeAdmin = registerAdminRoutes({ webServer: ws }, adminDeps)
    return () => {
      disposeRoutes()
      disposeAdmin()
    }
  })

  // Teardown: everything reversible (R6 — hot reload must not leak).
  // The disposer RETURNS its promise: cordis fiber.dispose() awaits effect
  // disposers, and dsh web's shutdown controller awaits fiber.dispose() with a
  // 5s grace — so 结束/退出/重启 dsh web 时 TW 后端子进程会被真正停掉，而不是
  // fire-and-forget 里与进程退出竞速（竞速会在 Windows 上遗留孤儿 TW 进程）。
  ctx.effect(() => () => {
    return (async () => {
      // Signal the startup task first (v0.19.1): it checks `disposed` after every
      // await and stops the child it may have spawned, instead of racing us and
      // leaving an orphan TW process / a bound clip-bridge port.
      disposed = true
      try {
        await Promise.race([
          startupTask.catch(() => undefined),
          new Promise<void>((r) => { setTimeout(r, 3_000).unref?.() }),
        ])
      } catch { /* startup issues are already logged */ }
      // Flush a pending auto-commit BEFORE teardown, so a write made within the
      // debounce window is not left uncommitted when dsh web stops (best-effort).
      try { await defaultInstance()?.flushCommitter() } catch { /* best-effort */ }
      disposeAll()
      // Release EVERY knowledge base (stop + watcher + pending commit). A failure
      // in one must not leave the others running — the farm guarantees that.
      await farm?.disposeAll()
      // …and the plugin-wide commit layer (one committer per repository).
      repos.dispose()
    })()
  }, 'dsh-tiddlywiki: host teardown')
}

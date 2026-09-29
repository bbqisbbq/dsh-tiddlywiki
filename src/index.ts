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
import { WechatPublishRunner, checkWechatReady, normalizeWechatConfig } from './host/wechat-publish.ts'
import { registerTiddlywikiTools, tiddlywikiToolSummary, type ToolsDeps, type ToolScope } from './host/tools.ts'
import { describePrompt, type PromptConfig } from './host/prompt.ts'
import {
  defaultLocationStateFile,
  locationPath,
  readLocationState,
  writeLocationState,
  type WikiLocation,
} from './host/wiki-location.ts'
import { WikiInstance } from './host/wiki-instance.ts'
import { WikiFarm, resolveAgentScope, stoppedWikiFromRequest, stoppedWikiMessage, targetRuntimeFor } from './host/wiki-farm.ts'
import { defaultSessionScopeFile, isSafeSessionId, readSessionScopes, setSessionScope } from './host/session-scope.ts'
import { installSplitSkill } from './host/skill-install.ts'
import {
  DEFAULT_WIKI_ID,
  DEFAULT_WIKI_MODE,
  applyWikiAction,
  defaultEntry,
  defaultRegistryFile,
  entryPath,
  readRegistry,
  singleEntryRegistry,
  writeRegistry,
  type WikiEntry,
  type WikiRegistry,
} from './host/wiki-registry.ts'
import { READY_TIMEOUT_DEFAULT_MS } from './host/ready-policy.ts'
import { ANON_USERNAME, PATH_PREFIX, TW_PROXY_PATH, TW_PROXY_PREFIX, WikiServer, proxyBaseFor } from './host/wiki.ts'
import { dshHomePath, defineTool } from './sdk.ts'
// v0.28.8：apply() 太大，按「自洽的子面」拆到 index-*.ts（模块族，readFamily 读取，
// 守门脚本因此不必钉单个文件名）。index.ts 仍是唯一的插件入口，也仍然拥有全部
// 可变状态（farm / 控制文件缓存 / switching / disposed），子模块只拿到显式的 deps。
import { createWikiViews, proxyBaseForEntry, restartAffectedWikis, resolveWikiRoot } from './index-wikis.ts'
import { createMutationLock } from './host/mutation-lock.ts'
import { createGitLayer } from './index-git.ts'
import { createPromptSurface, createServerTuning } from './index-prompt.ts'
import { createClipSurface } from './index-clip.ts'

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
// Pure helper behind `tiddlywiki_append`'s `heading` placement (v0.30.12): exported
// for the HEADLESS gates — its only regression test used to live in the e2e suite,
// which needs a real TW child, so cheap edge cases ("an image is not a heading")
// had nowhere to run.
export { insertIntoSection } from './host/tools-support.ts'
export { createMutationLock, type MutationLock } from './host/mutation-lock.ts'
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
  normalizeWikiIcon,
  normalizeWikiId,
  readRegistry,
  removeWiki,
  singleEntryRegistry,
  upsertWiki,
  validateRegistry,
  WIKI_ICON_NAMES,
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
export { WikiFarm, targetRuntimeFor, stoppedWikiFromRequest, stoppedWikiMessage, wikiIdFromRequest, resolveAgentScope, type AgentScope, type FarmChange, type WikiFarmOptions, type WikiRuntime } from './host/wiki-farm.ts'
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
  SKILL_FILE_NAME,
  SPLIT_SKILL_DIR,
  SPLIT_SKILL_MARKER,
  defaultSkillRoot,
  installSplitSkill,
  readBundledSkillText,
  type SkillInstallResult,
} from './host/skill-install.ts'
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
// 桌面加固（v0.28.8）：TW 子进程用哪个 node 起。导出是为了能被守门脚本直接断言
// （打包版 Electron 宿主下 process.execPath 是 Electron 二进制，起不了 TW）。
export { resolveNodeExecutable } from './host/wiki.ts'

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
  bridge: { enabled: boolean; port: number; token: string; tag: string; wiki: string }
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
  bridge: { enabled: false, port: CLIP_BRIDGE_DEFAULT_PORT, token: '', tag: 'clip', wiki: '' },
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
 *
 * v0.28.8: the implementation moved to `index-wikis.ts` together with the rest
 * of the location surface; the re-export keeps the barrel (lib/index.js) and
 * this module's own callers unchanged.
 */
export { resolveWikiRoot }

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
  /** Created by the startup task, once the control file has been read. */
  let farm: WikiFarm<WikiInstance> | undefined
  /** The runtime legacy/agent traffic falls back to (undefined = nothing up). */
  const defaultInstance = (): WikiInstance | undefined => farm?.defaultRuntime()
  /**
   * Auto-commit is keyed by REPOSITORY, not by wiki (v0.28.0), and the four
   * "effective config" accessors below all read through the DEFAULT runtime —
   * v0.28.8 moved that whole layer into index-git.ts (see its module note) and
   * this is the state it resolves against.
   */
  const gitLayer = createGitLayer({
    git,
    farm: () => farm,
    defaultInstance,
    baseShape: () => baseShape,
    gitConfig: () => config.git,
    noteConfig: () => config.note,
    defaultPath: () => wikiViews.defaultPath(),
    registryFile: () => registryFile,
    isDisposed: () => disposed,
  })
  const { repos, gitTargets, teardownCommitter, reapplyGitConfig, effectiveWorkspaceMark, effectiveBridge, effectiveWechat } = gitLayer

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
  // v0.28.8: the whole wiring (the per-assembly text + the registration) lives
  // in index-prompt.ts; the disposer list stays here because teardown order is
  // the plugin's business.
  const { applyPrompt } = createPromptSurface({
    ctx,
    effectiveConfigFor: (sessionId) => resolveAgentScope(farm, sessionScopes, sessionId).runtime?.eff() ?? baseShape,
    toolScope,
    pushDisposer: (dispose) => disposers.push(dispose),
  })

  /**
   * Readiness window from the EFFECTIVE config (v0.22.5): the settings page
   * saves `startup.readyTimeoutMs`, and this re-applies it to EVERY running
   * wiki — it takes effect on the next start()/restart() without a dsh web
   * restart. Values are clamped by host/ready-policy.ts.
   */
  const applyServerTuning = createServerTuning({ farm: () => farm })

  /**
   * The same-origin proxy base a wiki's TW frontend must use (v0.28.0).
   * The rule itself lives in host/wiki.ts (`proxyBaseFor`) so the harness and the
   * host cannot disagree about it — see that function for why it matters.
   */
  const proxyBase = (entry: WikiEntry): string => proxyBaseForEntry(() => farm, entry)
  // 本地剪藏桥（v0.28.8：整块接线搬到 index-clip.ts —— 它解释「一次剪藏落到哪个
  // 库」的唯一实现，见那里的 clipTarget 文档）。
  const { clipBridge } = createClipSurface({
    farm: () => farm,
    defaultInstance,
    effectiveBridge,
    effect: (fn, label) => ctx.effect(fn, label),
  })

  // Auto-committer + filesystem watcher live on the instance (v0.28.0). They are
  // still set up/torn down SEPARATELY: a runtime wiki switch has to release both
  // (they hold the OLD folder) and re-arm them for the new one. The teardown is
  // registered exactly ONCE below — a per-switch `disposers.push()` would leak a
  // disposer per switch.
  disposers.push(() => { void teardownCommitter() })

  // Tools (works even while the wiki is down; the scope resolves lazily).
  const toolsDeps: ToolsDeps = {
    // Per SESSION (v0.28.0): the session's scope decides which knowledge base a
    // call acts on, filtered by `agentVisible`. A refusal carries a REASON, so a
    // hidden or stopped wiki fails loudly instead of writing somewhere else.
    scope: toolScope,
    git,
    // v0.30.5（作者裁定）：同步**所有**配了 `git.remote` 的库 —— 一次一个仓库
    // （多库可能共用一个工作树），逐仓库独立成败。此前只动会话作用域那个库，
    // 回执却按会话作用域标注（"作用对象与标注不一致"）。
    gitTargets: () => gitTargets(),
    wikiPath: () => defaultInstance()?.path ?? locationPath(defaultLocation),
    autoCommit: () => defaultInstance()?.touchAutoCommit(),
    // After a pull that changed the working tree, restart the wikis whose content
    // ACTUALLY changed (v0.28.0). The syncer drain happens inside the runtime's
    // restart (rule #1); here we only pick the right targets — several knowledge
    // bases may share one repository, so "something changed" is NOT the same
    // question as "this wiki is stale".
    restartAffected: async (dir: string, changedFiles: readonly string[]) => restartAffectedWikis({ farm: () => farm, repoRootOf: (d) => repos.repoRootOf(d) }, dir, changedFiles),
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
  /**
   * Single-flight guard: two concurrent switches would fight over the child.
   * Declared here (next to `disposed`) because the whole switch surface moved to
   * index-wikis.ts and takes both as getters — see createWikiViews below.
   */
  let switching = false

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
      /**
       * Ship the 「拆分知识库」 skill FIRST (v0.28.0).
       *
       * It is deliberately independent of the wiki: it only writes a file into
       * `$DSH_HOME/skills`, and it must still happen when the wiki is slow to
       * start, fails to start, or the user is mid-migration with a broken config.
       * (It used to sit after `farm.startAll()` — which meant a wiki that never
       * became ready also silently never installed the skill. Found by restarting
       * a real host, not by a test.)
       *
       * A plugin cannot register a skill ROOT, so writing into the user's own root
       * is the only zero-config path; it only ever touches its own file (the
       * marker line decides — see host/skill-install.ts).
       */
      try {
        const installed = await installSplitSkill()
        if (installed.action === 'failed') console.warn('[dsh-tiddlywiki] 拆库 skill 安装失败：', installed.error)
        else console.info(`[dsh-tiddlywiki] 拆库 skill：${installed.action}（${installed.path}）`)
      } catch (err) {
        console.warn('[dsh-tiddlywiki] 拆库 skill 安装异常：', err)
      }
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
          proxyBase: () => proxyBase(entry),
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

  /**
   * The folder the default wiki occupies, running or not.
   *
   * v0.28.8: the location/view sub-surface lives in index-wikis.ts — it owns the
   * `{root,name}` bookkeeping, the single/multi switch orchestration and the
   * settings-page registry view. The mutable state it resolves against stays
   * HERE (farm / control-file cache / switching / disposed), which is why every
   * hop below is an accessor: `disposed` is declared just above, and the
   * `switching` flag it owns is passed as a getter/setter pair.
   */
  const wikiViews = createWikiViews({
    rawConfig: () => rawConfig,
    defaultLocation: () => defaultLocation,
    locationStateFile: () => locationStateFile,
    registryFile: () => registryFile,
    farm: () => farm,
    defaultInstance,
    controlRegistryNow,
    controlSource: () => controlSource,
    controlWarnings: () => controlWarnings,
    controlError: () => controlError,
    isSwitching: () => switching,
    setSwitching: (value) => { switching = value },
    isDisposed: () => disposed,
    applyPrompt,
  })
  const { defaultPath, defaultCurrentLocation, locationInfo, switchWikiLocation, resetWikiLocation, buildWikisView } = wikiViews

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
    /**
     * Why this request cannot be served (v0.29.0): set when `?wiki=<id>` names a
     * REGISTERED but STOPPED knowledge base. `targetRuntimeFor` deliberately
     * returns undefined for that case instead of falling back to the default wiki
     * (an unknown id still falls back — a stale bookmark must not 404), so every
     * route that either 503s on a missing client or has a harmless-looking
     * fallback (config / wiki path / prompt / status) can say WHICH wiki is down
     * and what to do, instead of quietly acting on a different one.
     */
    const targetProblem = (req: IncomingMessage): string | undefined => {
      const entry = stoppedWikiFromRequest(farm, req)
      return entry === undefined ? undefined : stoppedWikiMessage(entry)
    }
    const fallbackUi = WikiInstance.uiDefaultsFrom(config)
    const fallbackWechat = normalizeWechatConfig(config.wechat)
    /** Used only while nothing runs: base defaults, no wiki tiddler to read. */
    const idleConfig = new ConfigStore(baseShape)
    // ONE mutation lock for the whole plugin (v0.30.12): /restart, /sync,
  // /admin/restart and the seed restart all stop the TW child — before this,
  // the admin half had no lock at all and could race the others.
  const mutationLock = createMutationLock()
  const disposeRoutes = registerRoutes({ webServer: ws }, {
      mutationLock,
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
              // 每库图标（v0.28.4）：侧边栏入口与设置页选择器共用这个来源。
              icon: entry.icon,
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
      langOf: (req) => target(req)?.uiLanguage() ?? (typeof baseShape.uiLanguage === 'string' && baseShape.uiLanguage.trim().length > 0 ? baseShape.uiLanguage.trim() : 'zh'),
      getWikiPath: (req) => target(req)?.path ?? defaultPath(),
      targetProblem,
      // Same helper as the agent tool (one implementation, two callers): a pull
      // can change several knowledge bases that share one repository.
      restartAffected: (_req, dir, changedFiles) => restartAffectedWikis({ farm: () => farm, repoRootOf: (d) => repos.repoRootOf(d) }, dir, changedFiles),
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
            // v0.29.0: the client needs to know whether "resolved" is a real
            // answer (multi: this session's tools act on THAT wiki, so its cards'
            // links must open it) or just the single install's only wiki (keep
            // the pre-multi DOM, which renders no wiki attribute at all).
            mode: farm?.registry.mode ?? 'single',
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
      mutationLock,
      server: (req) => target(req)?.server,
      getClient: (req) => target(req)?.client(),
      getWikiPath: (req) => target(req)?.path ?? defaultPath(),
      targetProblem,
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
          // RUNTIME actions first (v0.28.0): `start`/`stop` do not change the list,
          // they change what is running. They live here rather than in the pure
          // `applyWikiAction` because they touch processes, not configuration —
          // and the GUI needs them: opening a wiki's panel must be able to bring
          // a stopped knowledge base up.
          const runtimeAction = (body as { action?: unknown } | null)?.action
          if (runtimeAction === 'start' || runtimeAction === 'stop') {
            if (farm === undefined) return { ok: false, error: '插件尚未就绪，请稍后再试' }
            const id = (body as { id?: unknown }).id
            const entry = typeof id === 'string' ? farm.registry.wikis.find((item) => item.id === id.trim().toLowerCase()) : undefined
            if (entry === undefined) return { ok: false, error: `知识库「${String(id)}」不在清单里` }
            const change = { started: [] as string[], stopped: [] as string[], updated: [] as string[], running: farm.runningIds(), errors: [] as Array<{ id: string; message: string }> }
            if (runtimeAction === 'start') {
              if (farm.runtime(entry.id) === undefined) {
                await farm.startEntry(entry)
                change.started.push(entry.id)
              }
            } else {
              await farm.stopEntry(entry.id)
              change.stopped.push(entry.id)
            }
            change.running = farm.runningIds()
            return { ok: true, info: buildWikisView(), change }
          }
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

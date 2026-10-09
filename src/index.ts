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
import { AutoCommitter, GitFace } from './host/git.ts'
import { type SessionsFace, type WebServerFace } from './host/routes.ts'
import { type PluginConfigShape } from './host/config.ts'
import { TiddlyWebClient, isBinaryType, TEXT_LIST_FILTER } from './host/tw-api.ts'
import { WechatPublishRunner } from './host/wechat-publish.ts'
import { registerTiddlywikiTools, type ToolsDeps, type ToolScope } from './host/tools.ts'
import {
  defaultLocationStateFile,
  // v0.30.49 / v0.30.50：readLocationState / readRegistry **只**被下面的 barrel
  // 再导出使用（`export { … } from '…'` 是独立语句、不消费 import 绑定）⇒
  // `noUnusedLocals` 把它们点成「未使用」。**必须无视这条 error 并留着**：
  // 删掉它们会让 lib/index.js 少一个导出（v0.30.48/v0.30.50 各实测一次 ——
  // typecheck / verify:unit / verify:static 全绿，只有 e2e 才崩）。
  // 判据：scripts/verify-index-barrel.mjs（进 verify:static）。
  readLocationState,
  type WikiLocation,
} from './host/wiki-location.ts'
import { WikiInstance } from './host/wiki-instance.ts'
import { WikiFarm, resolveAgentScope, targetRuntimeFor } from './host/wiki-farm.ts'
import { defaultSessionScopeFile } from './host/session-scope.ts'
import {
  DEFAULT_WIKI_ID,
  DEFAULT_WIKI_MODE,
  defaultRegistryFile,
  entryPath,
  readRegistry,
  singleEntryRegistry,
  type WikiEntry,
  type WikiRegistry,
} from './host/wiki-registry.ts'
import { ANON_USERNAME, PATH_PREFIX, TW_PROXY_PATH, TW_PROXY_PREFIX, WikiServer, proxyBaseFor } from './host/wiki.ts'
import { dshHomePath, defineTool } from './sdk.ts'
// v0.28.8：apply() 太大，按「自洽的子面」拆到 index-*.ts（模块族，readFamily 读取，
// 守门脚本因此不必钉单个文件名）。index.ts 仍是唯一的插件入口，也仍然拥有全部
// 可变状态（farm / 控制文件缓存 / switching / disposed），子模块只拿到显式的 deps。
import { createWikiViews, proxyBaseForEntry, restartAffectedWikis, resolveWikiRoot } from './index-wikis.ts'
// v0.30.42：配置面（形状 / 默认值 / 合并）整体搬走 —— `apply()` 里剩的全是
// 「顺序即语义」的装配阶段，配置解析不在其中（它是纯函数）。
import { resolveConfig, type ResolvedConfig, type TiddlywikiConfig } from './index-config.ts'
import { createMutationLock } from './host/mutation-lock.ts'
import { createGitLayer } from './index-git.ts'
import { createRouteStage } from './index-routes.ts'
import { createStartupStage } from './index-startup.ts'
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
  // v0.30.49：这条 **barrel 再导出** 是给 `lib/index.js` 的**外部**使用者的
  // （scripts/verify-wiki-switch.mjs 就 import 它）。⚠️ 再导出是**独立语句**，
  // 它不消费上面那条 import 的绑定 —— 所以 `noUnusedLocals` 会把 import 里的
  // 同名行点名成「未使用」，而**删掉 import 会让这条导出引用不到绑定**，
  // `lib/index.js` 随即少一个导出（v0.30.48 实测：typecheck / verify:unit /
  // verify:static 全绿，只有 e2e 的 verify-wiki-switch 崩在缺导出那行）。
  // 判据现在由 scripts/verify-index-barrel.mjs 守住（反向验证过：删掉即红）。
  //
  // ⚠️ 写这段注释时踩到一个**就在这条语句内部**的坑：注释里**不能出现右花括号**，
  // 否则任何按花括号配对的解析器（tsc 自己的扫描器也在内）都会把它当成 export
  // 列表的结尾，后面的 from 子句变成语法垃圾 —— 症状是「导出了却仍报缺」，
  // 而 tsc 的报错指向完全无关的 import 行。要描述这个语法请用文字。
  writeLocationState,
  LOCATION_STATE_VERSION,
  type WikiLocation,
  type WikiLocationInfo,
  type WikiLocationSource,
  type WikiLocationState,
} from './host/wiki-location.ts'
// v0.30.49 / v0.30.50 —— **为什么这两条单独写在 `from` 形式之外**：
// 同一个名字既要在 `lib/index.js` 上存在（barrel 公共面），又会让
// `export { X } from '…'` 那种写法**不消费上面 import 的绑定** ⇒
// `noUnusedLocals` 报「声明了但没读」，而删掉 import 就静默少一个导出
// （v0.30.48 / v0.30.50 各踩一次；只有 e2e 能发现）。
// 用「无 from 的 export」＝ **真的读一次那个绑定**，两个要求同时满足：
// 绑定被消费、导出照样在。判据仍是 scripts/verify-index-barrel.mjs。
export { readLocationState }
export { readRegistry }
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
/**
 * The git layer factory (v0.30.58). Exported because `gitTargets()` — "which
 * wikis count as syncable, and with which remote" — is a rule the gate
 * `scripts/verify-git-multi-sync.mjs` drives with fake deps (farm + GitFace), and
 * it is only reachable through this factory. Keep it here rather than inlining
 * a private copy of the rule into the test.
 */
export { createGitLayer, type GitLayer, type GitLayerDeps } from './index-git.ts'
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

/**
 * Official plugin whose parser every note this plugin writes depends on
 * (`text/markdown`). `--init server` does NOT include it — see ensurePlugin().
 *
 * v0.28.0: the constant moved to host/wiki-instance.ts, because applying it is
 * a PER-WIKI operation (each knowledge base carries its own tiddlywiki.info).
 */
export { MARKDOWN_PLUGIN } from './host/wiki-instance.ts'

/*
 * 配置面（v0.30.42）整体搬进 `index-config.ts`：形状 `TiddlywikiConfig`、
 * 解析后形状 `ResolvedConfig`、`CLIP_BRIDGE_DEFAULT_PORT`、`DEFAULTS` 与
 * `resolveConfig()`。这里是**纯**合并（无 ctx、无副作用、无顺序），所以能离开
 * 入口而不动 `apply()` 里那些「顺序本身就是语义」的装配段。
 * 只把**本来就是公共面**的两个名字再导出（`TiddlywikiConfig` /
 * `CLIP_BRIDGE_DEFAULT_PORT`）；`DEFAULTS` / `ResolvedConfig` / `resolveConfig`
 * 以前不是公开导出，搬迁不顺手扩大 barrel。
 */
export { CLIP_BRIDGE_DEFAULT_PORT } from './index-config.ts'
export type { TiddlywikiConfig } from './index-config.ts'

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
  const config: ResolvedConfig = resolveConfig(rawConfig)
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
    // The folder of the wiki this session acts on (v0.30.62): the git tools need a
    // DIRECTORY (drain sentinel / conflict resolution), and resolving it here is
    // what keeps them session-scoped. `entryPath` also covers a registered-but-
    // stopped wiki — resolving a conflict is a disk operation with no TW child.
    const dir = resolution.runtime?.path ?? (resolution.entry !== undefined ? entryPath(resolution.entry) : undefined)
    return {
      ...(client !== undefined ? { client } : {}),
      ...(dir !== undefined ? { dir } : {}),
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
    autoCommit: () => defaultInstance()?.touchAutoCommit(),
    // After a pull that changed the working tree, restart the wikis whose content
    // ACTUALLY changed (v0.28.0). The syncer drain happens inside the runtime's
    // restart (rule #1); here we only pick the right targets — several knowledge
    // bases may share one repository, so "something changed" is NOT the same
    // question as "this wiki is stale".
    restartAffected: async (dir: string, changedFiles: readonly string[] | undefined | undefined) => restartAffectedWikis({ farm: () => farm, repoRootOf: (d) => repos.repoRootOf(d) }, dir, changedFiles),
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

  // ── Startup stage (v0.30.50) ──────────────────────────────────────────────
  // 整个自举任务（skill → 控制文件 → 会话作用域 → 建 farm → startAll →
  // prompt → 剪藏桥）搬进 index-startup.ts。`disposed` 与 `farm` 仍归本文件
  // （前者是拆卸 effect 与这个任务的共同主人，后者路由/工具/视图都要读），
  // 所以它们以**回调**形式传进去 —— 与 index-wikis / index-routes 同一手法。
  //
  // ⚠️ 顺序本身是语义，见 index-startup.ts 的模块头（尤其是「skill 必须在
  // wiki 之前装」那条，它是真实事故的产物）。
  const startupStage = createStartupStage({
    config,
    git,
    repos,
    defaultLocation,
    locationStateFile,
    registryFile,
    sessionScopeFile,
    proxyBase,
    isDisposed: () => disposed,
    setFarm: (next) => { farm = next },
    setControl: (state) => {
      controlRegistry = state.registry
      controlSource = state.source
      controlWarnings = state.warnings
      controlError = state.error
    },
    setSessionScopes: (scopes) => { sessionScopes = scopes },
    applyPrompt,
    clipBridge,
    effectiveBridge,
    defaultCurrentLocation: () => wikiViews.defaultCurrentLocation(),
  })

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

  // The task is fire-and-forget (v0.19.1): teardown can run while it still
  // awaits, so the task itself stops the child when it notices `disposed`.
  const startupPromise = startupStage.start()
  void startupPromise

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
  const { defaultPath, defaultCurrentLocation } = wikiViews

  // Routes + settings-panel admin surface (lazy webServer). v0.30.48: the whole
  // assembly stage (the two Deps objects + both route tables) lives in
  // index-routes.ts; the entry point keeps ownership of `disposed` and builds
  // the ONE mutation lock, and hands both in. Registration still happens HERE,
  // at the position it always had — nothing about the lifecycle order moved.
  ctx.inject(['webServer'], (webCtx: HostCtx) => {
    const ws = (webCtx as unknown as { webServer: WebServerFace }).webServer
    const routeStage = createRouteStage({
      webServer: ws,
      get: (name) => ctx.get(name),
      git,
      repos,
      getFarm: () => farm,
      defaultPath,
      defaultCurrentLocation,
      controlRegistryNow,
      setControlRegistry: (registry) => {
        controlRegistry = registry
        controlSource = 'file'
        controlWarnings = []
        controlError = undefined
      },
      getSessionScopes: () => sessionScopes,
      setSessionScopes: (next) => { sessionScopes = next },
      sessionScopeFile,
      registryFile,
      locationStateFile,
      baseShape,
      config,
      wikiViews,
      onConfigChanged: () => {
        applyPrompt()
        applyServerTuning()
        // git.* must take effect on the RUNNING plugin (v0.25.0) — see
        // reapplyGitConfig: enabled/debounceMs/remote used to need a dsh web restart.
        void reapplyGitConfig()
      },
      effectivePromptFor: (req) => ((req === undefined ? undefined : targetRuntimeFor(farm, req)?.eff()) ?? baseShape).prompt ?? {},
      mutationLock: createMutationLock(),
      wechatRunner,
      isDisposed: () => disposed,
    })
    return () => routeStage.dispose()
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
          startupPromise.catch(() => undefined),
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

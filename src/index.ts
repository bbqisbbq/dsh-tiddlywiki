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
import { watch, type FSWatcher } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AutoCommitter, GitFace } from './host/git.ts'
import { registerRoutes, type AgentPresetsFace, type PermissionPresetsFace, type SessionControllerFace, type SessionPersistenceFace, type SessionsFace, type SessionQueryFace, type UiDefaultsPublic, type WebServerFace, type WorkspaceRegistryFace } from './host/routes.ts'
import { ConfigStore, DARK_PALETTE_DEFAULT, TW_WEB_HOST_TIDDLER, TW_WEB_HOST_DEFAULT, type PluginConfigShape } from './host/config.ts'
import { registerAdminRoutes, ensureLanguage, ensurePlugin, resolveTwRoot, type AdminDeps } from './host/admin.ts'
import { runAllSeeds, checkAllSeeds, runSeedById, removeSeedById, waitForFileWrite, flushPendingWrites, needsRestartAfterSeeds } from './host/seeds.ts'
import { RENDER_PLUGIN_FILE } from './host/seed-render.ts'
import { TiddlyWebClient, isBinaryType, TEXT_LIST_FILTER } from './host/tw-api.ts'
import { ClipBridge, downloadClipImage, type BridgeConfig, type ClipImageDownload } from './host/clip-bridge.ts'
import { registerTiddlywikiTools, tiddlywikiToolSummary, type ToolsDeps } from './host/tools.ts'
import { buildPromptText, normalizePromptMode, PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER, type PromptConfig } from './host/prompt.ts'
import {
  clearLocationState,
  defaultLocationStateFile,
  expandEnvPath,
  listWikiCandidates,
  locationPath,
  readLocationState,
  writeLocationState,
  type WikiLocation,
  type WikiLocationInfo,
  type WikiLocationSource,
} from './host/wiki-location.ts'
import { switchWiki, type WikiSwitchResult } from './host/wiki-switch.ts'
import { PATH_PREFIX, TW_PROXY_PATH, TW_PROXY_PREFIX, WikiServer } from './host/wiki.ts'
import { dshHomePath, defineTool } from './sdk.ts'

/** Cordis plugin name (also the client loader id / profile row id). */
export const name = 'dsh-tiddlywiki'

/** Required host services (tool registry + prompt assembly). */
export const inject = ['tools', 'systemPrompt']

/** Re-exports for the headless selftest and future consumers. */
export { AutoCommitter, GitFace, PATH_PREFIX, TW_PROXY_PATH, TW_PROXY_PREFIX, TiddlyWebClient, isBinaryType, TEXT_LIST_FILTER, WikiServer, dshHomePath, defineTool }
export { ConfigStore, deepMerge } from './host/config.ts'
export { sanitizeTwFragment, isSafeUrl } from './host/sanitize.ts'
export { MISSING_TYPE_FILTER } from './host/tw-api.ts'
export {
  AGENT_WRITTEN_TAG,
  DEFAULT_NOTE_TYPE,
  HUMAN_EDITED_TAG,
  WriteConflictError,
  assertNoConflict,
  buildWriteTiddler,
  cleanTiddler,
  flattenTiddlerFields,
} from './host/write-policy.ts'
export { openInTwEditor, registerRoutes } from './host/routes.ts'
export { writeSessionSummary, SESSION_SUMMARY_PREFIX } from './host/routes.ts'
export type { SessionQueryFace, SessionSummaryResult } from './host/routes.ts'
export { registerAdminRoutes, resolveTwRoot, readWikiInfo, writeWikiInfo, ensurePlugin, bundledCatalog, ensureLanguage, normalizeThemes, readActiveThemeName, MASKED_SECRET, maskConfigSecrets, stripMaskedSecrets } from './host/admin.ts'
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
export { runAllSeeds, checkAllSeeds, runSeedById, removeSeedById, waitForFileWrite, flushPendingWrites, needsRestartAfterSeeds, SEED_DEFS, type SeedStatus, type SeedRunResult } from './host/seeds.ts'
export { registerTiddlywikiTools, TRASH_PREFIX, TRASH_INDEX_TITLE, TrashIndexUnavailableError } from './host/tools.ts'
export { tiddlywikiToolSummary } from './host/tools.ts'
export {
  buildPromptText,
  escapePromptBraces,
  normalizePromptMode,
  toolSignatureLines,
  PROMPT_GOVERNANCE_BLOCKS,
  PROMPT_MODES,
  PROMPT_SECTION_NAME,
  PROMPT_SECTION_ORDER,
  DEFAULT_PROMPT_MODE,
  type PromptConfig,
  type PromptMode,
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
  note?: { tag?: string }
  /** 本地剪藏桥（书签小工具）：见 host/clip-bridge.ts 与 seed-clip-bridge.ts 文档。 */
  bridge?: { enabled?: boolean; port?: number; token?: string; tag?: string }
  /** 注入给每个会话的系统提示词（v0.21.0，见 host/prompt.ts）。 */
  prompt?: { enabled?: boolean; mode?: 'slim' | 'full'; extra?: string; override?: string }
  ui?: { showQuickNote?: boolean; showQuickNoteDock?: boolean; quickNoteMode?: 'native' | 'card'; sidebarLabel?: string; showPanelStatus?: boolean; showSyncButton?: boolean; followDshTheme?: boolean; darkPalette?: string; tabLabel?: string; showSessionTab?: boolean; showRightbarTab?: boolean; sendToAgent?: { enabled?: boolean; endpoint?: string; token?: string }; allArticles?: { pageSize?: number } }
  /** 启动时自动启用的 TW 语言代码（如 "zh-Hans"），也受配置 tiddler 覆盖。 */
  uiLanguage?: string
  auth?: { username?: string; password?: string }
}

/** Structural host context (subset of the dsh host + cordis surfaces). */
export interface HostCtx {
  tools: { register(tool: unknown): () => void }
  systemPrompt: { section(opts: { name: string; order: number; text: string }): () => void }
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
  note: { tag: string }
  bridge: { enabled: boolean; port: number; token: string; tag: string }
  ui: { showQuickNote: boolean; showQuickNoteDock: boolean; quickNoteMode: 'native' | 'card'; sidebarLabel: string; showPanelStatus: boolean; showSyncButton: boolean; followDshTheme: boolean; darkPalette: string; tabLabel: string; showSessionTab: boolean; showRightbarTab: boolean; sendToAgent: { enabled: boolean; endpoint?: string; token?: string }; allArticles: { pageSize: number } }
  uiLanguage: string
  auth: { username?: string; password?: string }
}

/** 剪藏桥默认端口（与 seed 文档书签代码里的地址保持一致）。 */
export const CLIP_BRIDGE_DEFAULT_PORT = 8618

/**
 * Official plugin whose parser every note this plugin writes depends on
 * (`text/markdown`). `--init server` does NOT include it — see ensurePlugin().
 */
export const MARKDOWN_PLUGIN = 'tiddlywiki/markdown'

const DEFAULTS: ResolvedConfig = {
  wikiRoot: '',
  wiki: 'main',
  port: 0,
  git: { autoCommit: true, debounceMs: 60_000, remote: '', branch: 'main' },
  note: { tag: 'inbox' },
  bridge: { enabled: false, port: CLIP_BRIDGE_DEFAULT_PORT, token: '', tag: 'clip' },
  ui: { showQuickNote: true, showQuickNoteDock: true, quickNoteMode: 'native', sidebarLabel: 'TiddlyWiki', showPanelStatus: true, showSyncButton: true, followDshTheme: true, darkPalette: DARK_PALETTE_DEFAULT, tabLabel: '知识库', showSessionTab: true, showRightbarTab: true, sendToAgent: { enabled: true }, allArticles: { pageSize: 10 } },
  uiLanguage: '',
  auth: { username: '', password: '' },
}

/** Config tiddler steering TW's frontend API base (tiddlywebadaptor). */
export { TW_WEB_HOST_TIDDLER, TW_WEB_HOST_DEFAULT } from './host/config.ts'

/**
 * Point TW's frontend at the same-origin DSH proxy (remote-access mode, R1).
 * The tiddlywebadaptor builds every API URL from $:/config/tiddlyweb/host; its
 * default `$protocol$//$host$/` resolves to the iframe's origin ROOT, which
 * 404s whenever the browser is not on the same machine as TW. Written only
 * when the tiddler is missing or still the legacy default — a user override is
 * honored (e.g. someone who really does expose TW on a dedicated origin).
 */
export async function ensureTwWebHost(client: TiddlyWebClient | undefined): Promise<void> {
  if (client === undefined) return
  // Read WITHOUT swallowing: only a 404 means "missing". A transient failure
  // must not look like "absent" and overwrite a user's custom host value.
  const current = (await client.get(TW_WEB_HOST_TIDDLER))?.text
  if (current !== undefined && current.trim() !== TW_WEB_HOST_DEFAULT) return
  await client.put({ title: TW_WEB_HOST_TIDDLER, text: TW_PROXY_PATH, type: 'text/plain', tags: [] })
}

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

/**
 * Ensure the wiki's `.gitignore` covers TW's transient artifacts, WITHOUT
 * clobbering rules the user added.
 *
 * This used to rewrite the whole file on every start, silently deleting any
 * custom ignore rules the user had put in `wiki/.gitignore`. Now the file is
 * only touched when one of the managed lines is missing, and the user's own
 * content is preserved verbatim.
 */
const MANAGED_GITIGNORE_LINES = [
  'tiddlers/$__temp_*',
  'tiddlers/$__StoryList*',
  'tiddlers/$__HistoryList*',
  '*.meta.tmp',
  // flush 哨兵（每次「重启前排干 syncer」都会重写，内容是时间戳）：不进 git，
  // 否则每次同步/播种都会给用户仓库塞一个无意义的 diff（v0.19.1）。
  'tiddlers/$__plugins_dsh-tiddlywiki_flush-probe.tid',
  'tiddlers/$__plugins_dsh-tiddlywiki_flush-probe.txt',
  'tiddlers/$__plugins_dsh-tiddlywiki_flush-probe.txt.meta',
]

async function writeGitignore(wikiPath: string): Promise<void> {
  const file = join(wikiPath, '.gitignore')
  let current = ''
  try {
    current = await readFile(file, 'utf8')
  } catch {
    /* absent → first run, write the default block */
  }
  const existing = current.split(/\r?\n/).map((line) => line.trim())
  const missing = MANAGED_GITIGNORE_LINES.filter((line) => !existing.includes(line))
  if (missing.length === 0) return
  const block = [
    '# TiddlyWiki transient artifacts (auto-managed by dsh-tiddlywiki)',
    ...missing,
    '',
  ].join('\n')
  const prefix = current.length === 0 ? '' : current.endsWith('\n') ? `${current}\n` : `${current}\n\n`
  await writeFile(file, `${prefix}${block}`, 'utf8')
}

/** Watch the wiki folders and touch the auto-committer on changes. */
function watchWiki(wikiPath: string, onChange: () => void): () => void {
  const watchers: FSWatcher[] = []
  for (const dir of [join(wikiPath, 'tiddlers'), wikiPath]) {
    try {
      const watcher = watch(dir, { persistent: false }, () => onChange())
      watchers.push(watcher)
    } catch {
      /* directory may not exist yet; the committer also fires on our writes */
    }
  }
  return () => {
    for (const watcher of watchers) {
      try { watcher.close() } catch { /* already closed */ }
    }
  }
}

/**
 * Wait until a file exists on disk (polling), up to `timeoutMs`. TW's syncer
 * flushes REST writes to the filesystem on a ~250ms task timer, so a freshly
 * seeded tiddler is not on disk the moment PUT resolves — a caller that must
 * restart TW right after (so a seeded server route loads) has to wait for the
 * flush first, or the restarted TW would boot from a stale snapshot and the
 * seeded module would be missing.
 *
 * The implementation lives in host/seeds.ts (shared with the settings page's
 * seed-run route), which is where `waitForFileWrite` is imported from.
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
  }
  // The location is MUTABLE since v0.22.0: the runtime pointer file (read below
  // in the startup task) and the settings page's「切换」both repoint it. Every
  // consumer reads it through a getter (`() => wikiPath`), never a captured copy.
  let wikiPath = join(config.wikiRoot, config.wiki)
  /** Pointer file the runtime switch persists (outside every wiki, see wiki-location.ts). */
  const locationStateFile = defaultLocationStateFile()
  const git = new GitFace()

  // Runtime-editable config (settings page): the cordis `config:` block is the
  // BASE; a config tiddler ($:/plugins/dsh-tiddlywiki/config) written by the
  // settings page overlays it. Effective values come from configStore.get().
  const configStore = new ConfigStore({ note: config.note, git: config.git, ui: config.ui, uiLanguage: config.uiLanguage, bridge: config.bridge } satisfies PluginConfigShape)
  const eff = (): PluginConfigShape => configStore.get()
  const effectiveNoteTag = (): string => {
    const tag = eff().note?.tag
    return typeof tag === 'string' && tag.trim().length > 0 ? tag : config.note.tag
  }
  /**
   * Effective bridge config (defaults + settings-page overlay). Used PER
   * REQUEST by the clip bridge — enabled/token/tag edits on the settings page
   * apply immediately; only the port is fixed at startup (listener binds once).
   */
  const effectiveBridge = (): BridgeConfig => {
    const b = eff().bridge ?? {}
    const port = typeof b.port === 'number' && Number.isInteger(b.port) && b.port > 0 && b.port < 65536 ? b.port : config.bridge.port
    const token = typeof b.token === 'string' ? b.token : ''
    const tag = typeof b.tag === 'string' && b.tag.trim().length > 0 ? b.tag.trim() : config.bridge.tag
    return { enabled: b.enabled === true, port, token, tag }
  }
  // Return type comes from routes.ts (single declaration of the UI payload the
  // client consumes — v0.20.0, previously mirrored inline here).
  const effectiveUi = (): UiDefaultsPublic => {
    const ui = eff().ui ?? {}
    const palette = typeof ui.darkPalette === 'string' && ui.darkPalette.trim().length > 0 ? ui.darkPalette.trim() : DARK_PALETTE_DEFAULT
    const label = typeof ui.sidebarLabel === 'string' && ui.sidebarLabel.trim().length > 0 ? ui.sidebarLabel.trim() : config.ui.sidebarLabel
    const tabLabel = typeof ui.tabLabel === 'string' && ui.tabLabel.trim().length > 0 ? ui.tabLabel.trim() : config.ui.tabLabel
    const quickNoteMode: 'native' | 'card' = ui.quickNoteMode === 'card' ? 'card' : 'native'
    return {
      showQuickNote: ui.showQuickNote !== false,
      showQuickNoteDock: ui.showQuickNoteDock !== false,
      quickNoteMode,
      sidebarLabel: label,
      showPanelStatus: ui.showPanelStatus !== false,
      showSyncButton: ui.showSyncButton !== false,
      followDshTheme: ui.followDshTheme !== false,
      darkPalette: palette,
      tabLabel,
      showSessionTab: ui.showSessionTab !== false,
      showRightbarTab: ui.showRightbarTab !== false,
    }
  }

  const disposers: Array<() => void> = []
  const disposeAll = (): void => {
    for (const dispose of disposers.splice(0)) dispose()
  }

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
  /** Built text for the current effective config (also the preview endpoint). */
  const promptText = (): string => {
    const p = (eff().prompt ?? {}) as PromptConfig
    return buildPromptText({
      enabled: p.enabled !== false,
      mode: normalizePromptMode(p.mode),
      extra: typeof p.extra === 'string' ? p.extra : '',
      override: typeof p.override === 'string' ? p.override : '',
      // Signature catalogue for `full` mode comes from the live tool registry,
      // never from hand-written prose (v0.21.0 — the old copy had drifted).
      tools: tiddlywikiToolSummary(),
    })
  }
  const applyPrompt = (): void => {
    const next = promptText()
    if (next === currentPromptText) return
    currentPromptText = next
    disposePromptSection?.()
    disposePromptSection = undefined
    if (next.length === 0) return
    disposePromptSection = ctx.systemPrompt.section({ name: PROMPT_SECTION_NAME, order: PROMPT_SECTION_ORDER, text: next })
  }
  disposers.push(() => {
    disposePromptSection?.()
    disposePromptSection = undefined
  })

  // TW child server.
  const server = new WikiServer({
    wikiRoot: config.wikiRoot,
    wiki: config.wiki,
    port: config.port,
    username: config.auth.username,
    password: config.auth.password,
  })

  // Lazy TW client. Rebuilt whenever the bound PORT changes (the wiki re-probes
  // a free port when a crash happened before readiness, so a cached client must
  // not stay pinned to a dead port). Credentials are attached preemptively: when
  // auth.username is configured the TW child runs behind `readers`/`writers`, so
  // EVERY request (reads included) needs Basic auth.
  let clientCache: TiddlyWebClient | undefined
  let clientPort: number | undefined
  const client = (): TiddlyWebClient | undefined => {
    const port = server.currentPort
    if (port === undefined) return undefined
    if (clientCache === undefined || clientPort !== port) {
      clientCache = new TiddlyWebClient(`http://127.0.0.1:${port}`, { username: config.auth.username, password: config.auth.password })
      clientPort = port
    }
    return clientCache
  }

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

  // Auto-committer + filesystem watcher (created after the wiki dir exists).
  // Reads the EFFECTIVE config so a settings-page git change survives a restart.
  //
  // SPLIT SETUP/TEARDOWN (v0.22.0): a runtime wiki switch has to release both
  // (they hold the OLD folder) and re-arm them for the new one. The teardown is
  // registered exactly ONCE below — a per-switch `disposers.push()` would leak a
  // disposer per switch.
  let committer: AutoCommitter | undefined
  let unwatch: (() => void) | undefined
  const setupCommitter = (): void => {
    const g = eff().git ?? {}
    committer = new AutoCommitter({
      git,
      dir: wikiPath,
      enabled: g.autoCommit ?? config.git.autoCommit,
      debounceMs: g.debounceMs ?? config.git.debounceMs,
      message: () => `wiki autocommit ${new Date().toISOString()}`,
      onError: (err) => console.warn('[dsh-tiddlywiki] autocommit:', err),
    })
    unwatch = watchWiki(wikiPath, () => committer?.touch())
  }
  const teardownCommitter = async (): Promise<void> => {
    try { unwatch?.() } catch { /* already closed */ }
    unwatch = undefined
    const current = committer
    committer = undefined
    // Flush a pending auto-commit BEFORE dropping the folder, so a write made
    // within the debounce window is not left uncommitted (switch + shutdown).
    try { await current?.flush() } catch { /* best-effort */ }
    current?.dispose()
  }
  disposers.push(() => { void teardownCommitter() })

  // Git bootstrap: repo init + initial commit + .gitignore (+ remote/first push).
  const bootstrapGit = async (): Promise<void> => {
    const g = eff().git ?? {}
    const branch = g.branch ?? config.git.branch
    const remote = g.remote ?? config.git.remote
    const isRepo = await git.isRepo(wikiPath)
    if (!isRepo) {
      await git.init(wikiPath, branch)
      await writeGitignore(wikiPath)
      await git.initialCommit(wikiPath)
    } else {
      await writeGitignore(wikiPath)
    }
    if (remote.trim().length > 0) {
      const ensured = await git.ensureRemote(wikiPath, remote.trim())
      if (ensured.ok) {
        const first = await git.firstPush(wikiPath)
        if (!first.ok) console.warn('[dsh-tiddlywiki] first push failed (retry with tiddlywiki_git_sync):', first.message)
      } else {
        console.warn('[dsh-tiddlywiki] git remote setup:', ensured.message)
      }
    }
  }

  // Tools (works even while the wiki is down; wiki() resolves lazily).
  const toolsDeps: ToolsDeps = {
    wiki: client,
    git,
    wikiPath: () => wikiPath,
    autoCommit: () => committer?.touch(),
    // After a pull that changed the working tree, restart TW so the server
    // (and the agent's reads) see the pulled content, not the old snapshot.
    restartWiki: async () => { await server.restart() },
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
   * Core-bootstrap the CURRENT `wikiPath`: markdown parser plugin, the core +
   * starter seeds, and the configured UI language. Extracted from the startup
   * task (v0.22.0) because a runtime wiki switch must run exactly this on the
   * new folder — the two paths must not drift apart.
   *
   * Only `render-route` needs a TW restart (it carries a SERVER route loaded at
   * boot); plain-content seeds must NOT restart, or the syncer's unflushed REST
   * writes would be lost.
   */
  const bootstrapWiki = async (): Promise<void> => {
    const seedClient = client()
    if (seedClient === undefined) return
    let pluginAdded = false
    try {
      pluginAdded = await ensurePlugin(wikiPath, resolveTwRoot(), MARKDOWN_PLUGIN)
      if (pluginAdded) console.info(`[dsh-tiddlywiki] enabled ${MARKDOWN_PLUGIN} for this wiki`)
    } catch (err) {
      console.warn(`[dsh-tiddlywiki] enabling ${MARKDOWN_PLUGIN}:`, err)
    }
    const seedStartedAt = Date.now()
    const results = await runAllSeeds({ client: seedClient, tools: tiddlywikiToolSummary() })
    for (const r of results) {
      if (!r.ok) console.warn(`[dsh-tiddlywiki] seed ${r.id} failed:`, r.error ?? r.detail)
    }
    if (needsRestartAfterSeeds(results)) {
      const renderFile = join(wikiPath, 'tiddlers', RENDER_PLUGIN_FILE)
      const flushed = await waitForFileWrite(renderFile, 8_000, 150, seedStartedAt)
      if (!flushed) console.warn('[dsh-tiddlywiki] seeded render plugin file not seen on disk before restart')
      // Drain the rest of the syncer queue as well: a restart that boots from a
      // stale snapshot loses every write still queued (v0.19.0).
      const drained = await flushPendingWrites(seedClient, join(wikiPath, 'tiddlers'))
      if (!drained) console.warn('[dsh-tiddlywiki] seed writes may not have been flushed before restart')
      if (!disposed) await server.restart()
    } else if (pluginAdded) {
      // tiddlywiki.info is written directly by us (no TW flush to wait for),
      // but TW only loads the plugin at boot.
      if (!disposed) await server.restart()
    }
    // Apply the configured UI language (e.g. "zh-Hans"): enable the bundled
    // language plugin in tiddlywiki.info.languages + restart once so TW loads
    // it at boot (fully offline — official language packs ship in the pkg).
    const uiLang = eff().uiLanguage
    if (typeof uiLang === 'string' && uiLang.trim().length > 0) {
      try {
        const code = uiLang.trim()
        const changed = await ensureLanguage(wikiPath, resolveTwRoot(), code)
        if (changed && !disposed) await server.restart()
        // Pin the active language tiddler so TW's UI actually switches.
        const langClient = client()
        if (langClient !== undefined) {
          await langClient.put({ title: '$:/language', text: `$:/languages/${code}`, type: 'text/plain', tags: [] }).catch(() => undefined)
        }
      } catch (err) {
        console.warn('[dsh-tiddlywiki] applying uiLanguage:', err)
      }
    }
  }

  const startupTask = (async () => {
    try {
      // Runtime pointer FIRST (v0.22.0): the settings page's「切换」persists the
      // chosen location in $DSH_HOME/dsh-tiddlywiki/location.json, which must
      // win over the cordis config default. Applied while the child is still
      // stopped, so the very first spawn already serves the right folder.
      const saved = await readLocationState(locationStateFile)
      if (saved.error !== undefined) console.warn('[dsh-tiddlywiki]', saved.error)
      if (saved.active !== undefined) {
        server.setLocation(saved.active)
        wikiPath = locationPath(saved.active)
        console.info(`[dsh-tiddlywiki] wiki location (pointer file): ${wikiPath}`)
      }
      await server.start()
      if (disposed) {
        await server.stop().catch(() => undefined)
        return
      }
      await configStore.load(client())
      // The config tiddler may carry prompt.* overrides: rebuild the already
      // registered section so a saved preference applies without a restart.
      applyPrompt()
      if (disposed) {
        await server.stop().catch(() => undefined)
        return
      }
      // Clip bridge: bind once on the configured port (works even while
      // disabled — every request re-checks the effective enabled flag, so the
      // settings-page toggle applies without a dsh web restart).
      try {
        await clipBridge.start(effectiveBridge().port)
        console.info(`[dsh-tiddlywiki] clip bridge listening on 127.0.0.1:${clipBridge.port} (enabled=${effectiveBridge().enabled})`)
      } catch (err) {
        console.warn('[dsh-tiddlywiki] clip bridge start:', err)
      }
      if (disposed) {
        try { await clipBridge.stop() } catch { /* already closing */ }
        await server.stop().catch(() => undefined)
        return
      }
      // Point TW's frontend at the same-origin DSH proxy (remote-access mode):
      // part of the seed registry (tw-web-host), so it is also covered by the
      // settings page's 重新初始化. Runs before git bootstrap so the config
      // tiddler joins the first commit.
      //
      // Seeds run after the effective config is loaded: every one-time
      // "与 dsh 联动需要 wiki 预置" item lives in the SEED_DEFS registry, and the
      // startup path seeds ONLY the core items (功能必需：发送给 Agent 按钮 +
      // TW 前端 API 基址 + 原生渲染路由) plus the starter docs — NON-force, so a
      // same-named tiddler is never overwritten. Optional seeds (首页 / 所有文章 /
      // 自定义样式 / menubar 顶栏主题自适应 / 剪藏桥说明) are opt-in from the
      // settings page「初始化」section.
      // Markdown parser + seeds + UI language: the SAME routine a runtime wiki
      // switch runs on its new folder (v0.22.0, host/wiki-switch.ts).
      try {
        await bootstrapWiki()
      } catch (err) {
        console.warn('[dsh-tiddlywiki] seeding wiki:', err)
      }
    } catch (err) {
      console.warn('[dsh-tiddlywiki] startup issue (self-healing is armed):', err)
    }
    // Git bootstrap + the auto-committer do not depend on the TW child, so run
    // them even when the wiki failed to start: every write is still versioned
    // (and a retry/restart later finds a ready repository). Skipped entirely
    // once disposed — otherwise this would register a watcher/timer (and an
    // initial commit) after teardown already ran.
    if (disposed) return
    try {
      await bootstrapGit()
      if (disposed) return
      setupCommitter()
    } catch (err) {
      console.warn('[dsh-tiddlywiki] git bootstrap failed:', err)
    }
  })()

  // ── Runtime wiki location (v0.22.0) ────────────────────────────────────────
  // The cordis `config:` block stays the DEFAULT; the settings page can switch
  // the running plugin to another folder and persists that choice in a pointer
  // file OUTSIDE every wiki (host/wiki-location.ts explains why). Everything
  // below is read through getters, so a switch is visible to tools, routes and
  // the git face immediately.
  const defaultLocation: WikiLocation = { root: config.wikiRoot, name: config.wiki }
  /** Source of the CURRENT location, for the settings page. */
  const locationSource = async (): Promise<WikiLocationSource> => {
    const state = await readLocationState(locationStateFile)
    if (state.active !== undefined && locationPath(state.active) === wikiPath) return 'state'
    return typeof rawConfig.wikiRoot === 'string' && rawConfig.wikiRoot.trim().length > 0 ? 'config' : 'default'
  }
  const locationInfo = async (): Promise<WikiLocationInfo> => {
    const state = await readLocationState(locationStateFile)
    const current = server.currentLocation
    return {
      current: { ...current, path: wikiPath, source: await locationSource() },
      default: { ...defaultLocation, path: locationPath(defaultLocation) },
      stateFile: locationStateFile,
      candidates: await listWikiCandidates(current.root),
      ...(state.error !== undefined ? { error: state.error } : {}),
    }
  }
  /** Single-flight guard: two concurrent switches would fight over the child. */
  let switching = false
  const runSwitch = async (target: { root?: unknown; name?: unknown }, persist: (t: WikiLocation) => Promise<void>): Promise<WikiSwitchResult> => {
    if (switching) return { ok: false, error: '正在切换知识库，请稍候再试', rolledBack: true }
    switching = true
    try {
      return await switchWiki({
        currentLocation: () => server.currentLocation,
        currentPath: () => wikiPath,
        stopServer: () => server.stop(),
        applyLocation: (nextLocation) => {
          server.setLocation({ root: nextLocation.root, name: nextLocation.name })
          wikiPath = locationPath(nextLocation)
          // The cached REST client holds a 2s list cache belonging to the OLD
          // wiki; drop it so the next request reads the new one.
          clientCache = undefined
          clientPort = undefined
        },
        startServer: async () => { await server.start() },
        teardownExtras: () => teardownCommitter(),
        setupExtras: () => { setupCommitter() },
        reloadConfig: async () => {
          await configStore.load(client())
          // The new wiki carries its own config tiddler → its own prompt.*.
          applyPrompt()
        },
        bootstrap: async () => {
          await bootstrapWiki()
          await bootstrapGit()
        },
        savePointer: persist,
        log: (message) => console.warn('[dsh-tiddlywiki]', message),
      }, target)
    } finally {
      switching = false
    }
  }
  /** Switch to another folder and remember the choice. */
  const switchWikiLocation = (target: { root?: unknown; name?: unknown }): Promise<WikiSwitchResult> =>
    runSwitch(target, async (t) => { await writeLocationState(t, locationStateFile) })
  /**
   * 「恢复为配置默认」: drop the pointer and go back to the cordis default. The
   * pointer must be cleared EVEN when the current folder already IS the default
   * (otherwise the stale pointer would win again after the next restart).
   */
  const resetWikiLocation = async (): Promise<WikiSwitchResult> => {
    if (locationPath(defaultLocation) === wikiPath) {
      await clearLocationState(locationStateFile)
      return { ok: true, location: defaultLocation, path: wikiPath }
    }
    return runSwitch(defaultLocation, async () => { await clearLocationState(locationStateFile) })
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
    const disposeRoutes = registerRoutes({ webServer: ws }, {
      server,
      getClient: client,
      git,
      autoCommit: () => committer?.touch(),
      noteDefaults: () => ({ tag: effectiveNoteTag() }),
      uiDefaults: () => effectiveUi(),
      getWikiPath: () => wikiPath,
      getSessionController,
      getWorkspaceRegistry,
      getAgentPresets,
      getSessionPersistence,
      getPermissionPresets,
      getSessions,
      getSessionQuery,
      sendToAgentEnabled: () => eff().ui?.sendToAgent?.enabled !== false,
      sendToAgentToken: () => {
        const token = eff().ui?.sendToAgent?.token
        return typeof token === 'string' ? token : ''
      },
    })
    const adminDeps: AdminDeps = {
      server,
      getClient: client,
      getWikiPath: () => wikiPath,
      twRoot: resolveTwRoot,
      config: configStore,
      // A settings-page save may change prompt.*: re-register the section (no
      // dsh web restart) and expose the built text for the preview panel.
      onConfigChanged: () => applyPrompt(),
      getPrompt: () => ({
        enabled: eff().prompt?.enabled !== false,
        mode: normalizePromptMode(eff().prompt?.mode),
        text: promptText(),
      }),
      // Runtime wiki location (v0.22.0): read the current folder + how it was
      // decided, switch to another one, or drop back to the cordis default.
      wiki: {
        info: locationInfo,
        switch: switchWikiLocation,
        reset: resetWikiLocation,
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
      try { await committer?.flush() } catch { /* best-effort */ }
      disposeAll()
      await server.stop()
    })()
  }, 'dsh-tiddlywiki: host teardown')
}

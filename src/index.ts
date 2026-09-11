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
import { registerRoutes, type AgentPresetsFace, type PermissionPresetsFace, type SessionControllerFace, type SessionPersistenceFace, type SessionsFace, type SessionQueryFace, type WebServerFace, type WorkspaceRegistryFace } from './host/routes.ts'
import { ConfigStore, deepMerge, DARK_PALETTE_DEFAULT, TW_WEB_HOST_TIDDLER, TW_WEB_HOST_DEFAULT, type PluginConfigShape } from './host/config.ts'
import { registerAdminRoutes, ensureLanguage, ensurePlugin, resolveTwRoot, type AdminDeps } from './host/admin.ts'
import { runAllSeeds, checkAllSeeds, runSeedById, removeSeedById, waitForFileWrite, flushPendingWrites, needsRestartAfterSeeds, SEED_DEFS, type SeedStatus, type SeedRunResult } from './host/seeds.ts'
import { RENDER_PLUGIN_FILE } from './host/seed-render.ts'
import { TiddlyWebClient, isBinaryType, TEXT_LIST_FILTER } from './host/tw-api.ts'
import { ClipBridge, buildClipTiddler, buildImageNoteTiddler, buildBinaryTiddler, downloadClipImage, hostAllowed, parseClipPayload, pickImageMime, resolveClipTitle, type BridgeConfig, type ClipImageDownload } from './host/clip-bridge.ts'
import { registerTiddlywikiTools, type ToolsDeps } from './host/tools.ts'
import { PATH_PREFIX, TW_PROXY_PATH, TW_PROXY_PREFIX, WikiServer, type WikiServerOptions } from './host/wiki.ts'
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
export { registerAdminRoutes, resolveTwRoot, readWikiInfo, writeWikiInfo, ensurePlugin, bundledCatalog, ensureLanguage, normalizeThemes, MASKED_SECRET, maskConfigSecrets, stripMaskedSecrets } from './host/admin.ts'
export { escapeInline } from './host/session-summary.ts'
export { seedDocNote, DOC_NOTE_TITLE, DOC_NOTE_TAG, DOC_NOTE_TEXT } from './host/seed-notes.ts'
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

/** Expand $VAR / ${VAR} / %VAR% from process.env (config uses $DSH_HOME). */
function expandEnvPath(input: string): string {
  return input
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k: string) => process.env[k] ?? '')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, k: string) => process.env[k] ?? '')
    .replace(/%([A-Za-z_][A-Za-z0-9_]*%)/g, (_, k: string) => process.env[k.slice(0, -1)] ?? '')
}

/** Resolve wikiRoot: explicit config (env-expanded) else $DSH_HOME/tiddlywiki. */
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

/** System-prompt section text (design doc §11 D8). */
const PROMPT_SECTION_NAME = 'dsh-tiddlywiki'
const PROMPT_SECTION_ORDER = 100
const PROMPT_TEXT = `## TiddlyWiki 持久知识库

本机有一个 TiddlyWiki 5 持久知识库（wiki 文件夹即 git 仓库）。你可以用工具读写 tiddler：

- \`tiddlywiki_search\`（query 必填；可选 tags[]/tag、since 修改时间、type、field+value、limit）检索，结果**按相关度排序**、片段取自命中处（图片等二进制附件不参与检索）；\`tiddlywiki_get\`（title）读全文（二进制附件只返回元数据，不含 base64 正文）；\`tiddlywiki_put\`（title, text, tags?, fields?, expectedModified?/expectedRevision?, force?）写/覆盖；\`tiddlywiki_batch_put\`（items[]）批量写；\`tiddlywiki_append\`（title, text, mode?, heading?）增量追加（写日志/批注的首选，不必读全文）；\`tiddlywiki_rename\`（oldTitle, newTitle, updateRefs?）重命名并尽量同步引用；\`tiddlywiki_delete\`（title, permanent?）删除（默认软删除进回收站）；\`tiddlywiki_trash\`（action=list|restore|empty）回收站。
- 其它：\`tiddlywiki_backlinks\`（title）查反向链接与标签归属；\`tiddlywiki_attach\`（title, path|url, noteTitle?）把本机文件或公网地址存成二进制附件并可选嵌入笔记；\`tiddlywiki_lint\` 知识库体检（垃圾标签 / 死链 / 空笔记 / 缺内容类型）。
- \`tiddlywiki_recent\`（limit?, since?）看最近修改的笔记（不含图片等二进制附件）；\`tiddlywiki_list_tags\` 看现有 tag 及计数。
- \`tiddlywiki_git_sync\`（pull|push|sync）做 git 同步；\`tiddlywiki_git_resolve\`（files, strategy=keep-local|keep-remote|list）在 pull 冲突后按 tiddler 二选一解决。

**不要覆盖人类正在编辑的笔记**：覆盖一篇已有笔记前先 \`tiddlywiki_get\`，把读到的 \`revision\`（或 \`modified\`）作为 \`expectedRevision\`（或 \`expectedModified\`）传入写回；若期间有人（在 TW 编辑器里）改过，写入会被拒绝并告诉你当前值——此时重新读一遍再决定，不要用 \`force\` 硬覆盖。纯增量内容优先用 \`tiddlywiki_append\`。覆盖已有条目时**不传 tags 就保留原有标签与自定义字段**（只改正文），显式传 tags 才整体替换标签。

知识库同步纪律（三条）：
1. 开工先 pull：\`tiddlywiki_git_sync action=pull\`（rebase + autostash；真冲突会自动 abort 并报冲突文件）。
2. 收工 commit + push：\`tiddlywiki_git_sync action=sync\`（pull → commit → push）。
3. 插件会自动防抖 commit（默认 60s），手动同步用上面的工具。

pull 冲突后：先 \`tiddlywiki_git_resolve files=[冲突文件] strategy=keep-local\`（保留本地）或 \`strategy=keep-remote\`（改用远端版本），再重新 pull/sync 整合其余改动。

把 wiki 当作长期记忆与知识沉淀的地方：会议纪要、决策记录、调研笔记、随手的想法都可存成独立 tiddler（tag 建议用 inbox/meeting/decision 等便于检索）。

**把有价值但不在当前执行范围内的想法沉淀进 wiki**：遇到「未来可能有用 / 值得做」的想法、或不在当前任务范围内但有实现价值的事项时，用 \`tiddlywiki_put\` 写成独立 tiddler，打上 \`todo\` + \`agent-written\` 标签（并附当前工作区名），正文简要说明来源（会话 / 工作区 / 项目背景），方便日后回溯，由用户决定是否继续。

用本插件自动创建笔记时，除了业务性 tag 外，请把「当前工作区（项目）的名字」也作为标签之一加上去（例如 \`tiddlywiki_put\` 的 tags 里带上当前 workspace 名），这样笔记能按项目归集、检索。

**Agent 笔记标签约定**：\`tiddlywiki_put\` / \`tiddlywiki_batch_put\` 新建笔记时，插件会自动补打 \`agent-written\` 标签（标记「由 Agent 撰写」），无需手动添加，也不要手动移除它（除非用户明确要求）。首页会把 Agent 笔记单独列在「Agent 区块」，主标签列表只统计人类笔记。若某篇 Agent 笔记后续被人类编辑过，请在该笔记上补打 \`human-edited\` 标签，首页会把它归入「Agent + 人工」档。覆盖写入已有的（人类）笔记时不会自动加 agent-written，请保持笔记原本的归属。

**内容类型约定**：agent 笔记正文默认用 **Markdown** 写；\`tiddlywiki_put\` / \`tiddlywiki_batch_put\` 未指定内容类型时自动按 \`text/markdown\` 写入（\`$:/\` 系统条目除外），无需手动指定。要写 TW 原生 wikitext 才需要在 fields 里显式传 \`{"type":"text/vnd.tiddlywiki"}\`。⚠️ \`fields.type\` 是 TW 的**内容类型**保留字段——不要把业务分类值（如 \`"meeting"\`）写进去（会破坏渲染），业务分类请放 \`tags\`。

**引用 wiki 笔记用可点击链接**：在回复流中引用某篇笔记时，用格式 \`[标题](/dsh-tiddlywiki/tw/#标题)\` 输出（标题含空格/特殊字符时做 URL 编码，如 \`A%20B\`；中文标题可直接写）。这类链接会被界面自动接管：点击后打开中央 TW 面板并跳转到该笔记的原生页面。回复里也优先用这个链接格式代替纯文本标题，让用户能一键跳到 wiki。`

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
  const wikiPath = join(config.wikiRoot, config.wiki)
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
  const effectiveUi = (): { showQuickNote: boolean; showQuickNoteDock: boolean; quickNoteMode: 'native' | 'card'; sidebarLabel: string; showPanelStatus: boolean; showSyncButton: boolean; followDshTheme: boolean; darkPalette: string; tabLabel: string; showSessionTab: boolean; showRightbarTab: boolean } => {
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

  // System prompt section (independent of the wiki service).
  const disposeSection = ctx.systemPrompt.section({ name: PROMPT_SECTION_NAME, order: PROMPT_SECTION_ORDER, text: PROMPT_TEXT })
  ctx.effect(() => disposeSection, 'dsh-tiddlywiki: prompt section')

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
    disposers.push(() => {
      committer?.dispose()
      unwatch?.()
    })
  }

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

  // Bring the wiki up, load the override config, then bootstrap git + committer.
  //
  // DISPOSAL-AWARE (v0.19.1): this task is fire-and-forget, but teardown can run
  // while it is still awaiting (plugin hot-reload / disable / dsh web exit
  // within the first seconds). Without the flag the disposer finished first and
  // the startup task then spawned the TW child / bound the clip-bridge port —
  // an orphan process and a leaked listener. Every await below is followed by a
  // `disposed` check, and the task stops the child itself when it notices.
  let disposed = false
  const startupTask = (async () => {
    try {
      await server.start()
      if (disposed) {
        await server.stop().catch(() => undefined)
        return
      }
      await configStore.load(client())
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
      // part of the seed registry below (tw-web-host), so it is also covered by
      // the settings page's 重新初始化. Runs before git bootstrap so the config
      // tiddler joins the first commit.
      // Seeds (run after the effective config is loaded): every one-time
      // "与 dsh 联动需要 wiki 预置" item lives in the SEED_DEFS registry.
      // The startup path seeds ONLY the CORE items (功能必需：发送给 Agent
      // 按钮 + TW 前端 API 基址) NON-force — write only what is missing, never
      // overwrite user content. Optional seeds (说明笔记 / 首页 / 所有文章 /
      // menubar 顶栏主题自适应 / 剪藏桥说明) are never forced on users: they
      // opt in from the settings page「初始化」section (重新初始化) and can opt
      // out again with 反初始化 (remove).
      try {
        const seedClient = client()
        if (seedClient !== undefined) {
          // Markdown parser bootstrap (v0.19.0): `--init server` scaffolds a
          // wiki WITHOUT tiddlywiki/markdown, but every note this plugin writes
          // (agent put/batch_put, quick note, drafts, clips) defaults to
          // `text/markdown`. Without the plugin a fresh install renders all of
          // them as raw source. Idempotent; one restart when it actually changed.
          let pluginAdded = false
          try {
            pluginAdded = await ensurePlugin(wikiPath, resolveTwRoot(), MARKDOWN_PLUGIN)
            if (pluginAdded) console.info(`[dsh-tiddlywiki] enabled ${MARKDOWN_PLUGIN} for this wiki`)
          } catch (err) {
            console.warn(`[dsh-tiddlywiki] enabling ${MARKDOWN_PLUGIN}:`, err)
          }
          const seedStartedAt = Date.now()
          const results = await runAllSeeds({ client: seedClient })
          for (const r of results) {
            if (!r.ok) console.warn(`[dsh-tiddlywiki] seed ${r.id} failed:`, r.error ?? r.detail)
          }
          // ONLY the render-route seed needs a TW restart: it carries a SERVER
          // route, which TW loads at boot. Restarting for plain-content seeds
          // (docs / home / styles) would kill the child over REST writes the
          // syncer had not flushed to disk yet, silently losing them.
          if (needsRestartAfterSeeds(results)) {
            const renderFile = join(wikiPath, 'tiddlers', RENDER_PLUGIN_FILE)
            const flushed = await waitForFileWrite(renderFile, 8_000, 150, seedStartedAt)
            if (!flushed) console.warn('[dsh-tiddlywiki] seeded render plugin file not seen on disk before restart')
            // Drain the rest of the syncer queue as well: a restart that boots
            // from a stale snapshot loses every write still queued (v0.19.0).
            const drained = await flushPendingWrites(seedClient, join(wikiPath, 'tiddlers'))
            if (!drained) console.warn('[dsh-tiddlywiki] seed writes may not have been flushed before restart')
            if (!disposed) await server.restart()
          } else if (pluginAdded) {
            // tiddlywiki.info is written directly by us (no TW flush to wait
            // for), but TW only loads the plugin at boot.
            if (!disposed) await server.restart()
          }
        }
      } catch (err) {
        console.warn('[dsh-tiddlywiki] seeding wiki:', err)
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
      seeds: {
        checkAll: async (c) => checkAllSeeds({ client: c }),
        run: async (c, id, force) => runSeedById({ client: c }, id, force),
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

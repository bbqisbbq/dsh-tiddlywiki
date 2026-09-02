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
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AutoCommitter, GitFace } from './host/git.ts'
import { registerRoutes, type WebServerFace } from './host/routes.ts'
import { ConfigStore, deepMerge, type PluginConfigShape } from './host/config.ts'
import { registerAdminRoutes, ensureLanguage, resolveTwRoot, type AdminDeps } from './host/admin.ts'
import { seedDocNote, seedSidebarLeftCss, DOC_NOTE_TITLE } from './host/seed-notes.ts'
import { TiddlyWebClient } from './host/tw-api.ts'
import { registerTiddlywikiTools, type ToolsDeps } from './host/tools.ts'
import { PATH_PREFIX, WikiServer, type WikiServerOptions } from './host/wiki.ts'
import { dshHomePath, defineTool } from './sdk.ts'

/** Cordis plugin name (also the client loader id / profile row id). */
export const name = 'dsh-tiddlywiki'

/** Required host services (tool registry + prompt assembly). */
export const inject = ['tools', 'systemPrompt']

/** Re-exports for the headless selftest and future consumers. */
export { AutoCommitter, GitFace, PATH_PREFIX, TiddlyWebClient, WikiServer, dshHomePath, defineTool }
export { ConfigStore, deepMerge } from './host/config.ts'
export { openInTwEditor } from './host/routes.ts'
export { registerAdminRoutes, resolveTwRoot, readWikiInfo, writeWikiInfo, bundledCatalog, ensureLanguage, normalizeThemes } from './host/admin.ts'
export { seedDocNote, seedSidebarLeftCss, DOC_NOTE_TITLE, DOC_NOTE_TAG, DOC_NOTE_TEXT, SIDEBAR_LEFT_CSS_TITLE, SIDEBAR_LEFT_CSS } from './host/seed-notes.ts'
export type { PluginConfigShape } from './host/config.ts'
export type { GitStatusView } from './host/git.ts'
export type { Tiddler } from './host/tw-api.ts'
export type { WikiServerOptions, WikiStatusView } from './host/wiki.ts'

/** Plugin config (design doc §13). Defaults are applied in apply(). */
export interface TiddlywikiConfig {
  wikiRoot?: string
  wiki?: string
  port?: number
  git?: { autoCommit?: boolean; debounceMs?: number; remote?: string; branch?: string }
  note?: { tag?: string }
  ui?: { showQuickNote?: boolean; sidebarLeftCss?: boolean; showPanelStatus?: boolean }
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
  ui: { showQuickNote: boolean; sidebarLeftCss: boolean; showPanelStatus: boolean }
  auth: { username?: string; password?: string }
}

const DEFAULTS: ResolvedConfig = {
  wikiRoot: '',
  wiki: 'main',
  port: 0,
  git: { autoCommit: true, debounceMs: 60_000, remote: '', branch: 'main' },
  note: { tag: 'inbox' },
  ui: { showQuickNote: true, sidebarLeftCss: true, showPanelStatus: true },
  auth: { username: '', password: '' },
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

/** Write the .gitignore for TW transient artifacts (idempotent). */
async function writeGitignore(wikiPath: string): Promise<void> {
  const lines = [
    '# TiddlyWiki transient artifacts (auto-managed by dsh-tiddlywiki)',
    'tiddlers/$__temp_*',
    'tiddlers/$__StoryList*',
    'tiddlers/$__HistoryList*',
    '*.meta.tmp',
    '',
  ]
  await writeFile(join(wikiPath, '.gitignore'), lines.join('\n'), 'utf8')
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

/** System-prompt section text (design doc §11 D8). */
const PROMPT_SECTION_NAME = 'dsh-tiddlywiki'
const PROMPT_SECTION_ORDER = 100
const PROMPT_TEXT = `## TiddlyWiki 持久知识库

本机有一个 TiddlyWiki 5 持久知识库（wiki 文件夹即 git 仓库）。你可以用工具读写 tiddler：

- \`tiddlywiki_search\`（query, tag?）检索；\`tiddlywiki_get\`（title）读全文；\`tiddlywiki_put\`（title, text, tags?, fields?）写/覆盖；\`tiddlywiki_delete\`（title）删除。
- \`tiddlywiki_git_sync\`（pull|push|sync）做 git 同步。

知识库同步纪律（三条）：
1. 开工先 pull：\`tiddlywiki_git_sync action=pull\`（rebase + autostash；真冲突会自动 abort 并报冲突文件）。
2. 收工 commit + push：\`tiddlywiki_git_sync action=sync\`（pull → commit → push）。
3. 插件会自动防抖 commit（默认 60s），手动同步用上面的工具。

把 wiki 当作长期记忆与知识沉淀的地方：会议纪要、决策记录、调研笔记、随手的想法都可存成独立 tiddler（tag 建议用 inbox/meeting/decision 等便于检索）。`

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
    ui: { ...DEFAULTS.ui, ...(rawConfig.ui ?? {}) },
    auth: { ...DEFAULTS.auth, ...(rawConfig.auth ?? {}) },
  }
  const wikiPath = join(config.wikiRoot, config.wiki)
  const git = new GitFace()

  // Runtime-editable config (settings page): the cordis `config:` block is the
  // BASE; a config tiddler ($:/plugins/dsh-tiddlywiki/config) written by the
  // settings page overlays it. Effective values come from configStore.get().
  const configStore = new ConfigStore({ note: config.note, git: config.git, ui: config.ui } satisfies PluginConfigShape)
  const eff = (): PluginConfigShape => configStore.get()
  const effectiveNoteTag = (): string => {
    const tag = eff().note?.tag
    return typeof tag === 'string' && tag.trim().length > 0 ? tag : config.note.tag
  }
  const effectiveUi = (): { showQuickNote: boolean; sidebarLeftCss: boolean; showPanelStatus: boolean } => ({
    showQuickNote: eff().ui?.showQuickNote !== false,
    sidebarLeftCss: eff().ui?.sidebarLeftCss !== false,
    showPanelStatus: eff().ui?.showPanelStatus !== false,
  })

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

  // Lazy TW client (rebuilt when the port is bound).
  let clientCache: TiddlyWebClient | undefined
  const client = (): TiddlyWebClient | undefined => {
    const port = server.currentPort
    if (port === undefined) return undefined
    clientCache ??= new TiddlyWebClient(`http://127.0.0.1:${port}`)
    return clientCache
  }

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
    noteTag: effectiveNoteTag,
    autoCommit: () => committer?.touch(),
  }
  disposers.push(...registerTiddlywikiTools(ctx, toolsDeps))

  // Bring the wiki up, load the override config, then bootstrap git + committer.
  void (async () => {
    try {
      await server.start()
      await configStore.load(client())
      // Seeds (run after the effective config is loaded):
      //  - doc note: ONE-SHOT — a fresh wiki gets the plugin guide; deleting
      //    it afterwards survives restarts (see seedDocNote).
      //  - sidebar-left CSS: PATCH-REPAIR while ui.sidebarLeftCss is on —
      //    re-seeds when missing (fresh install OR user deleted it).
      try {
        const seedClient = client()
        if (seedClient !== undefined) {
          await seedDocNote(seedClient)
          await seedSidebarLeftCss(seedClient, effectiveUi().sidebarLeftCss)
        }
      } catch (err) {
        console.warn('[dsh-tiddlywiki] seeding doc note / css:', err)
      }
      // Apply the configured UI language (e.g. "zh-Hans"): enable the bundled
      // language plugin in tiddlywiki.info.languages + restart once so TW loads
      // it at boot (fully offline — official language packs ship in the pkg).
      const uiLang = eff().uiLanguage
      if (typeof uiLang === 'string' && uiLang.trim().length > 0) {
        try {
          const code = uiLang.trim()
          const changed = await ensureLanguage(wikiPath, resolveTwRoot(), code)
          if (changed) await server.restart()
          // Pin the active language tiddler so TW's UI actually switches.
          const langClient = client()
          if (langClient !== undefined) {
            await langClient.put({ title: '$:/language', text: `$:/languages/${code}`, type: 'text/plain', tags: [] }).catch(() => undefined)
          }
        } catch (err) {
          console.warn('[dsh-tiddlywiki] applying uiLanguage:', err)
        }
      }
      await bootstrapGit()
      setupCommitter()
    } catch (err) {
      console.warn('[dsh-tiddlywiki] startup issue (self-healing is armed):', err)
    }
  })()

  // Routes + settings-panel admin surface (lazy webServer).
  ctx.inject(['webServer'], (webCtx: HostCtx) => {
    const ws = (webCtx as unknown as { webServer: WebServerFace }).webServer
    const disposeRoutes = registerRoutes({ webServer: ws }, {
      server,
      getClient: client,
      git,
      autoCommit: () => committer?.touch(),
      noteDefaults: () => ({ tag: effectiveNoteTag() }),
      uiDefaults: () => effectiveUi(),
      getWikiPath: () => wikiPath,
    })
    const adminDeps: AdminDeps = {
      server,
      getClient: client,
      getWikiPath: () => wikiPath,
      twRoot: resolveTwRoot,
      config: configStore,
    }
    const disposeAdmin = registerAdminRoutes({ webServer: ws }, adminDeps)
    return () => {
      disposeRoutes()
      disposeAdmin()
    }
  })

  // Teardown: everything reversible (R6 — hot reload must not leak).
  ctx.effect(() => () => {
    disposeAll()
    void server.stop()
  }, 'dsh-tiddlywiki: host teardown')
}

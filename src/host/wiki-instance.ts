/**
 * One knowledge base's runtime (v0.28.0) — the "wiki farm" replaces the single
 * `WikiServer` + client + config + committer quartet that used to live as loose
 * closure variables inside `apply()`.
 *
 * WHAT IS PER-WIKI, AND WHAT IS NOT
 * ---------------------------------
 * Per instance (everything that holds a folder or a port):
 *
 *   - `WikiServer`      one TW child process, one loopback port;
 *   - `TiddlyWebClient` the REST client for THAT port;
 *   - `ConfigStore`     the wiki's own `$:/plugins/dsh-tiddlywiki/config`
 *                       overlay (which is why per-wiki config already worked
 *                       before this refactor — it just was not addressable);
 *   - `AutoCommitter` + fs watcher (they hold the folder).
 *
 * Shared by the whole plugin, therefore NOT here:
 *
 *   - `GitFace`  — every method takes the directory as an argument, so it is
 *                  stateless; M2 keys the COMMITTER by repository, not by wiki;
 *   - the clip bridge (one listener on one port) and the WeChat runner;
 *   - the registered agent tools, routes and the prompt section (singletons by
 *     construction: the host rejects a duplicate tool/route/section name).
 *
 * LIFECYCLE CONTRACT
 * ------------------
 *   start()   server.start → load config tiddler → bootstrap seeds → git → arm extras
 *   restart() drain the syncer queue, THEN restart (ironclad rule #1)
 *   stop()    drain, then stop, then release the extras
 *   dispose() flush a pending commit, release extras, stop the child
 *
 * A failed `start()` must not leave a half-wired instance behind: the caller
 * decides whether to roll back, and `dispose()` is idempotent.
 *
 * @module dsh-tiddlywiki/host/wiki-instance
 */
import { watch, type FSWatcher } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AutoCommitter, type GitFace } from './git.ts'
import { ConfigStore, DARK_PALETTE_DEFAULT, type PluginConfigShape } from './config.ts'
import { TiddlyWebClient } from './tw-api.ts'
import { ensureLanguage, ensurePlugin, pinLanguageTiddler } from './admin.ts'
import { drainThenStop, flushPendingWrites, needsRestartAfterSeeds, runAllSeeds, waitForFileWrite } from './seeds.ts'
import { RENDER_PLUGIN_FILE } from './seed-render.ts'
import { WikiServer } from './wiki.ts'
import { entryPath, type WikiEntry } from './wiki-registry.ts'
import { tiddlywikiToolSummary } from './tools.ts'
import { normalizeWechatConfig } from './wechat-publish.ts'
import type { UiDefaultsPublic } from './routes.ts'
import type { BridgeConfig } from './clip-bridge.ts'

/**
 * Official plugin whose parser every note this plugin writes depends on
 * (`text/markdown`). `--init server` does NOT include it — see ensurePlugin().
 */
export const MARKDOWN_PLUGIN = 'tiddlywiki/markdown'

/**
 * The cordis `config:` block values one instance needs as its BASE layer (the
 * wiki's own config tiddler overlays them). Mirrors `ResolvedConfig` in
 * src/index.ts minus the per-instance location fields.
 */
export interface WikiInstanceBase {
  git: { autoCommit: boolean; debounceMs: number; remote: string; branch: string }
  note: { tag: string; workspaceMark: boolean }
  bridge: { enabled: boolean; port: number; token: string; tag: string }
  startup: { readyTimeoutMs: number }
  wechat: { enabled: boolean; command: string; token: string; adapter: 'publish-note' | 'publish-note-imgs'; dsn: string }
  ui: {
    showQuickNote: boolean
    showQuickNoteDock: boolean
    quickNoteMode: 'native' | 'card'
    sidebarLabel: string
    showPanelStatus: boolean
    showSyncButton: boolean
    followDshTheme: boolean
    darkPalette: string
    tabLabel: string
    showSessionTab: boolean
    showRightbarTab: boolean
    sendToAgent: { enabled: boolean; endpoint?: string; token?: string }
    allArticles: { pageSize: number }
  }
  uiLanguage: string
  auth: { username?: string; password?: string }
}

export interface WikiInstanceOptions {
  /** The registry entry this instance serves (kept in sync via {@link updateEntry}). */
  entry: WikiEntry
  /** cordis config block = the base layer for this wiki's effective config. */
  base: WikiInstanceBase
  /** Shared, stateless git face. */
  git: GitFace
  /** Resolve the installed tiddlywiki package root (plugin / language management). */
  twRoot: () => string
  /** Log sink (defaults to console.warn with the plugin prefix). */
  log?: (message: string) => void
}

/** Where a restart/stop is allowed to come from (kept for diagnostics). */
export type WikiInstanceState = 'stopped' | 'starting' | 'running' | 'failed'

/**
 * Ensure the wiki's `.gitignore` covers TW's transient artifacts, WITHOUT
 * clobbering rules the user added. Only touched when one of the managed lines
 * is missing; the user's own content is preserved verbatim.
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

/**
 * Watch one wiki's folders and touch the auto-committer on changes.
 *
 * ALWAYS attach an 'error' listener: `fs.watch` reports failures (Windows EPERM,
 * Linux ENOSPC when the inotify watch limit is exhausted) as an ASYNC 'error'
 * event, which a surrounding try/catch cannot catch. Node rethrows an unhandled
 * 'error' as an uncaught exception, and the host installs no handler → the whole
 * `dsh web` process dies. Degrading to "no watcher" is safe: our own writes still
 * call `touch()`.
 *
 * ⚠️ With N wikis there are N watchers. On Linux the inotify watch limit is a
 * real ceiling; the degradation above is what keeps that survivable.
 */
function watchWiki(wikiPath: string, onChange: () => void): () => void {
  const watchers: FSWatcher[] = []
  for (const dir of [join(wikiPath, 'tiddlers'), wikiPath]) {
    try {
      const watcher = watch(dir, { persistent: false }, () => onChange())
      watcher.on('error', (err) => {
        console.warn('[dsh-tiddlywiki] wiki watcher error (auto-commit still runs on our own writes):', err.message)
      })
      watchers.push(watcher)
    } catch {
      /* directory may not exist yet; the committer also fires on our own writes */
    }
  }
  return () => {
    for (const watcher of watchers) {
      try { watcher.close() } catch { /* already closed */ }
    }
  }
}

/** One knowledge base: its child process, client, config overlay and committer. */
export class WikiInstance {
  /** The TW child process this knowledge base runs on its own loopback port. */
  readonly server: WikiServer
  /** This wiki's own `$:/plugins/dsh-tiddlywiki/config` overlay. */
  readonly config: ConfigStore

  private entryValue: WikiEntry
  private wikiPath: string
  private clientCache: TiddlyWebClient | undefined
  private clientPort: number | undefined
  private committer: AutoCommitter | undefined
  private unwatch: (() => void) | undefined
  private disposed = false
  private gitReconfiguring = false
  private readonly log: (message: string) => void

  constructor(private readonly options: WikiInstanceOptions) {
    this.entryValue = options.entry
    this.wikiPath = entryPath(options.entry)
    this.log = options.log ?? ((message) => { console.warn('[dsh-tiddlywiki]', message) })
    this.server = new WikiServer({
      wikiRoot: options.entry.root,
      wiki: options.entry.name,
      port: 0,
      username: options.base.auth.username,
      password: options.base.auth.password,
      readyTimeoutMs: options.base.startup.readyTimeoutMs,
    })
    this.config = new ConfigStore({
      note: options.base.note,
      git: options.base.git,
      ui: options.base.ui,
      uiLanguage: options.base.uiLanguage,
      bridge: options.base.bridge,
      startup: options.base.startup,
      wechat: options.base.wechat,
    } satisfies PluginConfigShape)
  }

  /** Registry entry currently served (id/label/flags live here). */
  get entry(): WikiEntry {
    return this.entryValue
  }

  /** Absolute folder of this wiki. */
  get path(): string {
    return this.wikiPath
  }

  /** True once {@link dispose} ran: no path may spawn or start anything after it. */
  get isDisposed(): boolean {
    return this.disposed
  }

  /** Folder key used by the repo-keyed git model (M2). */
  get tiddlersDir(): string {
    return join(this.wikiPath, 'tiddlers')
  }

  /** Effective config = cordis base overlaid with THIS wiki's config tiddler. */
  eff(): PluginConfigShape {
    return this.config.get()
  }

  /** The note tag new notes get here (config tiddler overrides the base). */
  noteTag(): string {
    const tag = this.eff().note?.tag
    return typeof tag === 'string' && tag.trim().length > 0 ? tag : this.options.base.note.tag
  }

  /**
   * Whether agent-created notes get the automatic workspace marker (v0.24.0):
   * tag `ws/<project>` + field `workspace`. Default ON; an explicit `false` in
   * this wiki's config tiddler wins.
   */
  workspaceMark(): boolean {
    const value = this.eff().note?.workspaceMark
    return typeof value === 'boolean' ? value : this.options.base.note.workspaceMark
  }

  /**
   * Effective clip-bridge config for THIS wiki. Used per request by the shared
   * bridge: enabled/token/tag apply immediately; only the port is fixed at
   * startup (the listener binds once, plugin-wide).
   */
  bridgeConfig(): BridgeConfig {
    const b = this.eff().bridge ?? {}
    const port = typeof b.port === 'number' && Number.isInteger(b.port) && b.port > 0 && b.port < 65536 ? b.port : this.options.base.bridge.port
    const token = typeof b.token === 'string' ? b.token : ''
    const tag = typeof b.tag === 'string' && b.tag.trim().length > 0 ? b.tag.trim() : this.options.base.bridge.tag
    return { enabled: b.enabled === true, port, token, tag }
  }

  /**
   * Effective UI flags from a config overlay.
   *
   * STATIC on purpose (v0.28.0): the plugin also needs them when NO wiki is
   * running — a stopped farm must answer the settings page with the cordis base
   * values instead of inventing them, and duplicating this mapping in index.ts
   * is exactly the kind of drift this repo keeps paying for.
   */
  static uiDefaultsFrom(base: WikiInstanceBase, ui: PluginConfigShape['ui'] = {}): UiDefaultsPublic {
    const palette = typeof ui.darkPalette === 'string' && ui.darkPalette.trim().length > 0 ? ui.darkPalette.trim() : DARK_PALETTE_DEFAULT
    const label = typeof ui.sidebarLabel === 'string' && ui.sidebarLabel.trim().length > 0 ? ui.sidebarLabel.trim() : base.ui.sidebarLabel
    const tabLabel = typeof ui.tabLabel === 'string' && ui.tabLabel.trim().length > 0 ? ui.tabLabel.trim() : base.ui.tabLabel
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

  /** Effective UI flags for THIS wiki. */
  uiDefaults(): UiDefaultsPublic {
    return WikiInstance.uiDefaultsFrom(this.options.base, this.eff().ui)
  }

  /** Effective 公众号发布 config for THIS wiki (read per request). */
  wechatConfig(): ReturnType<typeof normalizeWechatConfig> {
    return normalizeWechatConfig(this.eff().wechat)
  }

  /** This wiki's send-to-agent switch / shared token. */
  sendToAgent(): { enabled: boolean; token: string } {
    const s2a = this.eff().ui?.sendToAgent ?? {}
    return {
      enabled: s2a.enabled !== false,
      token: typeof s2a.token === 'string' ? s2a.token : '',
    }
  }

  /** Whether the wechat feature is on for this wiki (gates seeds + prompt line). */
  wechatEnabled(): boolean {
    return (this.eff().wechat ?? {}).enabled === true
  }

  /**
   * Lazy TW client. Rebuilt whenever the bound PORT changes (a crash before
   * readiness makes the child re-probe a free port, so a cached client must not
   * stay pinned to a dead one). Credentials are attached preemptively: with
   * `auth.username` configured the child runs behind `readers`/`writers`, so
   * EVERY request needs Basic auth.
   */
  client(): TiddlyWebClient | undefined {
    const port = this.server.currentPort
    if (port === undefined) return undefined
    if (this.clientCache === undefined || this.clientPort !== port) {
      this.clientCache = new TiddlyWebClient(`http://127.0.0.1:${port}`, {
        username: this.options.base.auth.username,
        password: this.options.base.auth.password,
      })
      this.clientPort = port
    }
    return this.clientCache
  }

  /** Drop the cached client (its cached listing belongs to the old folder). */
  private resetClient(): void {
    this.clientCache = undefined
    this.clientPort = undefined
  }

  /**
   * Point this instance at another folder. THROWS while the child runs — the
   * switch orchestrator stops it first (see host/wiki-switch.ts).
   */
  updateEntry(entry: WikiEntry): void {
    const nextPath = entryPath(entry)
    if (nextPath !== this.wikiPath) {
      this.server.setLocation({ root: entry.root, name: entry.name })
      this.wikiPath = nextPath
      this.resetClient()
    }
    this.entryValue = entry
  }

  /** Re-apply the effective readiness window (next start/restart). */
  applyServerTuning(): void {
    this.server.setReadyTimeout(this.eff().startup?.readyTimeoutMs)
  }

  /** Debounced auto-commit touch (fired after our own writes). */
  touchAutoCommit(): void {
    this.committer?.touch()
  }

  /** Flush a pending auto-commit now (teardown / explicit sync). */
  async flushCommitter(): Promise<void> {
    try { await this.committer?.flush() } catch { /* best-effort */ }
  }

  /**
   * Create (or re-create) the auto-committer + fs watcher for the CURRENT
   * folder. Split from teardown so a wiki switch can release and re-arm them.
   */
  setupExtras(): void {
    const g = this.eff().git ?? {}
    this.committer = new AutoCommitter({
      git: this.options.git,
      dir: this.wikiPath,
      enabled: g.autoCommit ?? this.options.base.git.autoCommit,
      debounceMs: g.debounceMs ?? this.options.base.git.debounceMs,
      message: () => `wiki autocommit ${new Date().toISOString()}`,
      onError: (err) => this.log(`autocommit: ${err instanceof Error ? err.message : String(err)}`),
    })
    this.unwatch = watchWiki(this.wikiPath, () => this.committer?.touch())
  }

  /** Release the committer + watcher, flushing a pending commit first. */
  async teardownExtras(): Promise<void> {
    try { this.unwatch?.() } catch { /* already closed */ }
    this.unwatch = undefined
    const current = this.committer
    this.committer = undefined
    // Flush a pending auto-commit BEFORE dropping the folder, so a write made
    // within the debounce window is not left uncommitted (switch + shutdown).
    try { await current?.flush() } catch { /* best-effort */ }
    current?.dispose()
  }

  /**
   * Re-apply the effective git config to the running instance (v0.25.0):
   * `git.*` used to be read once, so saving it changed nothing until a restart.
   * The flag (plus teardownExtras' own idempotence) keeps a burst of saves from
   * leaving two committers or a dangling fs watcher.
   */
  async reapplyGitConfig(): Promise<void> {
    if (this.gitReconfiguring) return
    this.gitReconfiguring = true
    try {
      await this.teardownExtras()
      const g = this.eff().git ?? {}
      const remote = (typeof g.remote === 'string' && g.remote.trim().length > 0 ? g.remote : this.options.base.git.remote).trim()
      if (remote.length > 0) {
        const ensured = await this.options.git.ensureRemote(this.wikiPath, remote)
        if (!ensured.ok) this.log(`git remote update: ${ensured.message}`)
      }
      this.setupExtras()
    } catch (err) {
      this.log(`applying git config: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.gitReconfiguring = false
    }
  }

  /**
   * Git bootstrap: repo init + initial commit + .gitignore (+ remote/first push).
   * Kept per-wiki in M1; M2 makes it repo-keyed (two wikis may share one repo).
   */
  async bootstrapGit(): Promise<void> {
    const g = this.eff().git ?? {}
    const branch = g.branch ?? this.options.base.git.branch
    const remote = g.remote ?? this.options.base.git.remote
    const isRepo = await this.options.git.isRepo(this.wikiPath)
    if (!isRepo) {
      await this.options.git.init(this.wikiPath, branch)
      await writeGitignore(this.wikiPath)
      await this.options.git.initialCommit(this.wikiPath)
    } else {
      await writeGitignore(this.wikiPath)
    }
    if (remote.trim().length > 0) {
      const ensured = await this.options.git.ensureRemote(this.wikiPath, remote.trim())
      if (ensured.ok) {
        const first = await this.options.git.firstPush(this.wikiPath)
        if (!first.ok) this.log(`first push failed (retry with tiddlywiki_git_sync): ${first.message}`)
      } else {
        this.log(`git remote setup: ${ensured.message}`)
      }
    }
  }

  /**
   * Core-bootstrap this wiki: markdown parser plugin, the core + starter seeds,
   * and the configured UI language.
   *
   * Only `render-route` needs a TW restart (it carries a SERVER route loaded at
   * boot); plain-content seeds must NOT restart, or the syncer's unflushed REST
   * writes would be lost.
   */
  async bootstrapWiki(): Promise<void> {
    const seedClient = this.client()
    if (seedClient === undefined) return
    let pluginAdded = false
    try {
      pluginAdded = await ensurePlugin(this.wikiPath, this.options.twRoot(), MARKDOWN_PLUGIN)
      if (pluginAdded) this.log(`enabled ${MARKDOWN_PLUGIN} for this wiki`)
    } catch (err) {
      this.log(`enabling ${MARKDOWN_PLUGIN}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const seedStartedAt = Date.now()
    const results = await runAllSeeds({
      client: seedClient,
      tools: tiddlywikiToolSummary(),
      // Opt-in feature gate (v0.23.0): the「发布元数据规范」seed is skipped unless
      // THIS wiki turned 微信发布 on (its own config tiddler wins over the base).
      wechat: this.wechatEnabled(),
    })
    for (const r of results) {
      if (!r.ok) this.log(`seed ${r.id} failed: ${r.error ?? r.detail}`)
    }
    if (needsRestartAfterSeeds(results)) {
      const renderFile = join(this.wikiPath, 'tiddlers', RENDER_PLUGIN_FILE)
      const flushed = await waitForFileWrite(renderFile, 8_000, 150, seedStartedAt)
      if (!flushed) this.log('seeded render plugin file not seen on disk before restart')
      // Drain the rest of the syncer queue as well: a restart that boots from a
      // stale snapshot loses every write still queued (v0.19.0).
      const drained = await flushPendingWrites(seedClient, this.tiddlersDir)
      if (!drained) this.log('seed writes may not have been flushed before restart')
      if (!this.disposed) await this.server.restart()
    } else if (pluginAdded) {
      // tiddlywiki.info is written directly by us (no TW flush to wait for),
      // but TW only loads the plugin at boot.
      if (!this.disposed) await this.server.restart()
    }
    // Apply the configured UI language (e.g. "zh-Hans"): enable the bundled
    // language plugin in tiddlywiki.info.languages + restart once so TW loads
    // it at boot (fully offline — official language packs ship in the pkg).
    const uiLang = this.eff().uiLanguage
    if (typeof uiLang === 'string' && uiLang.trim().length > 0) {
      try {
        const code = uiLang.trim()
        const changed = await ensureLanguage(this.wikiPath, this.options.twRoot(), code)
        if (changed && !this.disposed) await this.server.restart()
        // Pin the active language tiddler so TW's UI actually switches.
        // v0.24.2: conditional — an identical body still rewrites
        // `$__language.txt.meta`'s created/modified on EVERY startup, and two
        // machines doing that conflict on every pull.
        const langClient = this.client()
        if (langClient !== undefined) {
          await pinLanguageTiddler(langClient, `$:/languages/${code}`, (message, err) => {
            if (err === undefined) this.log(message)
            else this.log(`pinning $:/language failed: ${err}`)
          }).catch(() => undefined)
        }
      } catch (err) {
        this.log(`applying uiLanguage: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /**
   * Bring this wiki up: spawn the child, load its config overlay, bootstrap it,
   * then arm the committer + watcher.
   *
   * Disposal-aware: teardown may run while this is awaiting (hot reload / dsh web
   * exit within the first seconds), so the child is stopped rather than orphaned.
   */
  async start(): Promise<void> {
    if (this.disposed) throw new Error(`知识库「${this.entryValue.id}」已卸载，无法启动`)
    try {
      await this.server.start()
      if (this.disposed) {
        await this.server.stop().catch(() => undefined)
        return
      }
      await this.config.load(this.client())
      this.applyServerTuning()
      await this.bootstrapWiki()
    } finally {
      // Git bootstrap + the committer do NOT depend on the TW child: they must
      // run even when the wiki FAILED to start, so every write is still versioned
      // and a later retry finds a ready repository (pre-v0.28 behaviour, kept
      // when the startup path moved in here).
      if (!this.disposed) {
        try {
          await this.bootstrapGit()
          if (!this.disposed) this.setupExtras()
        } catch (err) {
          this.log(`git bootstrap failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  }

  /**
   * Drain the syncer queue, then restart the child (ironclad rule #1). Returns
   * whether the store was provably quiescent, so callers can surface an
   * incomplete drain instead of losing writes silently.
   */
  async restart(): Promise<boolean> {
    return drainThenStop({
      client: this.client(),
      tiddlersDir: this.tiddlersDir,
      stop: () => this.server.restart(),
      log: this.log,
    })
  }

  /** Drain the syncer queue, then stop the child. */
  async drainStop(): Promise<boolean> {
    return drainThenStop({
      client: this.client(),
      tiddlersDir: this.tiddlersDir,
      stop: () => this.server.stop(),
      log: this.log,
    })
  }

  /** Drain + stop + release the extras. */
  async stop(): Promise<void> {
    await this.drainStop()
    await this.teardownExtras()
  }

  /**
   * Deterministic teardown. Idempotent: the plugin disposer and a rollback path
   * may both call it.
   *
   * NOTE: this intentionally does NOT drain the syncer queue (the pre-v0.28
   * teardown did not either) — it flushes the git committer and stops the child.
   * Shutdown has a 5s grace in DSH, and a drain has its own bounded waits.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.flushCommitter()
    await this.teardownExtras()
    await this.server.stop().catch(() => undefined)
  }
}

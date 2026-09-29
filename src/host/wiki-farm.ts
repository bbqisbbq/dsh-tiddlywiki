/**
 * The multi-wiki farm (v0.28.0) — owns "which knowledge bases should be
 * RUNNING", and reconciles the running set against the registry.
 *
 * WHY THIS IS A SEPARATE, PURE-ORCHESTRATION CLASS
 * ------------------------------------------------
 * The dangerous part of multi-wiki is not spawning a process; it is the
 * DIFF — what to start, what to stop, what to leave alone, and what must be
 * recycled because its folder changed. Getting that wrong either leaks TW
 * children (orphan processes holding ports) or silently drops a wiki the user
 * still has open.
 *
 * So the farm knows nothing about TiddlyWiki: `createRuntime` is injected, and
 * `scripts/verify-wiki-farm.mjs` drives the whole reconciliation with fakes that
 * only record the calls they received. The rules can then be asserted in
 * milliseconds instead of minutes.
 *
 * THE RUNNING-SET RULES
 * ---------------------
 *   single mode → ONLY the default entry runs (the registry in single mode is
 *                 normally a one-entry registry synthesized from the legacy
 *                 pointer file, so this is defensive as well as correct).
 *   multi mode  → every entry with `autostart: true` runs at boot; anything
 *                 else starts on demand (`startEntry`) — e.g. when a human
 *                 opens that wiki's panel or a session is scoped to it.
 *
 * A FOLDER CHANGE RECYCLES THE RUNTIME. `WikiServer.setLocation()` refuses to
 * repoint while a child is running, and a running instance holds an fs watcher
 * + auto-committer on the OLD folder. Stopping and creating a fresh runtime is
 * the only sequence that cannot leave half the object describing wiki A while
 * the other half serves wiki B.
 *
 * ONE FAILURE MUST NOT TAKE THE FARM DOWN. A wiki that fails to start is KEPT
 * in the running map (its child may still be coming up — WikiServer arms a
 * late-ready watch) and the failure is reported in `FarmChange.errors`, so one
 * broken folder cannot stop the other knowledge bases from serving.
 *
 * @module dsh-tiddlywiki/host/wiki-farm
 */
import { join } from 'node:path'
import { isInsidePath } from './path-key.ts'
import { defaultEntry, entryPath, type WikiEntry, type WikiRegistry } from './wiki-registry.ts'

/**
 * What the farm needs from one knowledge base's runtime.
 * `WikiInstance` (host/wiki-instance.ts) satisfies this structurally.
 */
export interface WikiRuntime {
  /** Registry entry currently served (id/label/flags/path live here). */
  readonly entry: WikiEntry
  /** Absolute folder currently served. */
  readonly path: string
  /** True once `dispose()` ran: such a runtime must never be started again. */
  readonly isDisposed: boolean
  start(): Promise<void>
  stop(): Promise<void>
  dispose(): Promise<void>
  updateEntry(entry: WikiEntry): void
}

export interface WikiFarmOptions<T extends WikiRuntime = WikiRuntime> {
  /** Build a runtime for one entry (injected so tests can use fakes). */
  createRuntime: (entry: WikiEntry) => T
  log?: (message: string) => void
}

/** What one `apply()`/`startAll()` actually did (logging + settings-page回执). */
export interface FarmChange {
  /** Ids whose child was spawned by this call. */
  started: string[]
  /** Ids whose child was stopped AND released by this call. */
  stopped: string[]
  /** Ids whose entry was refreshed in place (flags/label — no restart). */
  updated: string[]
  /** Ids running once the call settled. */
  running: string[]
  /** Start/stop failures; a failing wiki never blocks the others. */
  errors: Array<{ id: string; message: string }>
}

/**
 * `T` is the concrete runtime type: the host instantiates
 * `WikiFarm<WikiInstance>` so it can reach instance-only members (config store,
 * bootstrap, committer) without a cast; tests instantiate the default with fakes.
 */
/**
 * The wiki id a request asks for (`?wiki=<id>`), or undefined when it asks for
 * none. Extracted so the host wiring and the verification harness read the
 * selector the SAME way — a second copy of "how do I parse ?wiki=" is exactly
 * the drift this repo keeps paying for.
 */
export function wikiIdFromRequest(req: { url?: string | undefined }): string | undefined {
  try {
    const id = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('wiki')
    return id !== null && id.length > 0 ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * Which runtime does this request target?
 *
 *   `?wiki=<id>` naming a RUNNING wiki                    → that one
 *   `?wiki=<id>` naming a REGISTERED wiki that is STOPPED  → UNDEFINED (refuse)
 *   no selector, or an UNKNOWN id                          → the farm's default
 *
 * TWO FALLBACKS, TWO DIFFERENT REASONS (v0.29.0)
 * ----------------------------------------------
 * An UNKNOWN id falls back instead of 404ing on purpose: the selector comes from
 * links the user may have bookmarked, and a stale one must not strand them on a
 * broken editor. It also means `?wiki=` can never be used to START a wiki —
 * starting one is an explicit action, not a side effect of a GET.
 *
 * A REGISTERED but not-running id must NOT fall back. It used to, and the
 * failure was silent and destructive: the settings page ("正在配置：books")
 * wrote the books patch into the DEFAULT wiki's config tiddler, the quick-note
 * card listed stopped wikis and then saved into the default one, and
 * `/admin/info?wiki=<stopped>` rewrote the default wiki's `tiddlywiki.info`.
 * The named wiki is unambiguously known here, so there is nothing to guess:
 * callers get `undefined` and answer 503 with the wiki named (see
 * `stoppedWikiFromRequest` for the message). This is the same answer the
 * `/tw/<id>/` proxy already gave (it resolves LAST, exactly so a named-but-
 * stopped wiki cannot be proxied to whoever happens to be the default).
 */
export function targetRuntimeFor<T extends WikiRuntime>(farm: WikiFarm<T> | undefined, req: { url?: string | undefined }): T | undefined {
  if (farm === undefined) return undefined
  const id = wikiIdFromRequest(req)
  if (id === undefined) return farm.defaultRuntime()
  const runtime = farm.runtime(id)
  if (runtime !== undefined) return runtime
  // Registered but stopped → refuse (never act on a different knowledge base).
  if (farm.registry.wikis.some((entry) => entry.id === id)) return undefined
  return farm.defaultRuntime()
}

/**
 * The REGISTERED wiki a request names which is not running — the reason a
 * request-scoped target resolved to `undefined` (v0.29.0).
 *
 * Exists so every 503 can NAME the knowledge base and tell the user what to do,
 * instead of the generic "wiki service is not running" that made the old silent
 * fallback look like a success. Returns `undefined` when the request names no
 * wiki, names a running one, or names an unknown id (that last case still falls
 * back to the default by design — see `targetRuntimeFor`).
 */
export function stoppedWikiFromRequest<T extends WikiRuntime>(farm: WikiFarm<T> | undefined, req: { url?: string | undefined }): WikiEntry | undefined {
  if (farm === undefined) return undefined
  const id = wikiIdFromRequest(req)
  if (id === undefined) return undefined
  if (farm.runtime(id) !== undefined) return undefined
  return farm.registry.wikis.find((entry) => entry.id === id)
}

/**
 * The sentence every refusal carries (v0.29.0).
 *
 * Exported so the host wiring and the verification harness cannot drift apart on
 * what a user reads — the guard asserts this text appears in the 503 body.
 */
export function stoppedWikiMessage(entry: WikiEntry): string {
  return `知识库「${entry.label}」当前没有运行：先在「知识库」菜单里启动它再试`
}

/**
 * The knowledge base the AGENT works on for one session, plus why it might be
 * none (v0.28.0).
 *
 * The rules, in order:
 *   1. the session's EXPLICIT scope, when it names a wiki that exists — and is
 *      `agentVisible`: a hidden wiki must stay unreachable even if a stale
 *      selection points at it;
 *   2. the registry's DEFAULT, when it is visible;
 *   3. the first visible entry.
 *
 * Two deliberate refusals:
 *
 *   - an explicit scope that is visible but NOT RUNNING yields an ERROR, never a
 *     silent fallback to another wiki. Quietly writing the user's note into a
 *     different knowledge base is the single worst failure this feature can
 *     have, and "the selector said X" must win over convenience.
 *   - nothing visible → no runtime and a reason the tool can say out loud,
 *     instead of guessing a wiki the user asked to hide.
 */
export interface AgentScope<T extends WikiRuntime> {
  /** The live runtime to act on (undefined = act on nothing). */
  runtime?: T
  /** The entry the scope resolved to (for labels, even when it cannot serve). */
  entry?: WikiEntry
  /** Why there is no runtime — an actionable sentence for the tool error. */
  reason?: string
}

export function resolveAgentScope<T extends WikiRuntime>(
  farm: WikiFarm<T> | undefined,
  scopes: Record<string, string>,
  sessionId: string | undefined,
): AgentScope<T> {
  if (farm === undefined) return { reason: '知识库插件尚未就绪（还没读完清单）' }
  const registry = farm.registry
  const byId = new Map(registry.wikis.map((entry) => [entry.id, entry]))

  if (sessionId !== undefined) {
    const wantedId = scopes[sessionId]
    const explicit = wantedId === undefined ? undefined : byId.get(wantedId)
    if (explicit !== undefined && explicit.agentVisible) {
      const runtime = farm.runtime(explicit.id)
      if (runtime !== undefined) return { runtime, entry: explicit }
      return { entry: explicit, reason: `本会话作用域指定的知识库「${explicit.label}」当前没有运行，请先在界面上启动它再试` }
    }
  }

  const visible = registry.wikis.filter((entry) => entry.agentVisible)
  if (visible.length === 0) return { reason: '当前没有对 Agent 可见的知识库（可在设置里把某个库设为对 Agent 可见）' }
  const preferred = defaultEntry({ ...registry, wikis: visible })
  const order = preferred === undefined ? visible : [preferred, ...visible.filter((entry) => entry.id !== preferred.id)]
  for (const entry of order) {
    const runtime = farm.runtime(entry.id)
    if (runtime !== undefined) return { runtime, entry }
  }
  // Nothing visible is running: name the one we WOULD use so the sentence is
  // actionable ("start X"), rather than a vague "no wiki".
  return { entry: order[0], reason: `知识库「${order[0]?.label ?? ''}」当前没有运行，请先在界面上启动它再试` }
}

export class WikiFarm<T extends WikiRuntime = WikiRuntime> {
  private registryValue: WikiRegistry
  private readonly runtimes = new Map<string, T>()
  private errors: Array<{ id: string; message: string }> = []
  private readonly log: (message: string) => void

  constructor(registry: WikiRegistry, private readonly options: WikiFarmOptions<T>) {
    this.registryValue = registry
    this.log = options.log ?? ((message) => { console.warn('[dsh-tiddlywiki]', message) })
  }

  /** The registry the farm is currently reconciling against. */
  get registry(): WikiRegistry {
    return this.registryValue
  }

  /** Ids with a live runtime (order = start order). */
  runningIds(): string[] {
    return [...this.runtimes.keys()]
  }

  /** The runtime for `id`, or undefined when it is not running. */
  runtime(id: string): T | undefined {
    return this.runtimes.get(id)
  }

  /** Every running runtime, in start order (plugin-wide tuning walks this). */
  allRuntimes(): T[] {
    return [...this.runtimes.values()]
  }

  /**
   * The running wikis whose CONTENT a pull just touched (v0.28.0).
   *
   * `changedFiles` are REPOSITORY-relative (what `git diff --name-only` prints),
   * and a wiki is affected when the absolute form of one of them lands inside
   * its folder. With several wikis sharing one repository this is what keeps a
   * pull from restarting — and interrupting whoever is editing — a wiki nothing
   * happened to.
   */
  affectedBy(repoRoot: string, changedFiles: readonly string[] | undefined | undefined): T[] {
    // `undefined` = **不知道**哪些文件变了（diff 算不出来，v0.30.36）。这时必须
    // **保守重启该仓库下的全部库**：宁可多重启一个（只是多一次 TW 重启），也不能
    // 静默陈旧 —— 用户面前的 TW 是内存副本，磁盘被 pull 改过而没重启，就会一直
    // 显示旧内容，而回执说同步成功。
    //
    // ⚠️ 谓词的**方向**：受影响 = 文件落在库目录**里面**，所以正常分支写
    // `isInsidePath(runtime.path, filePath)`（第一个参数是容器）。"全部库"要用
    // 反方向的 `isInsidePath(repoRoot, runtime.path)` —— **不能**拿一个假文件名
    // （例如 `.`）去套正常分支，那样问的是「repoRoot 是否在某个库目录里」，
    // 方向反了，同仓多库里更深的那些库不会重启。
    if (changedFiles === undefined) {
      const all: T[] = []
      for (const runtime of this.runtimes.values()) {
        if (isInsidePath(repoRoot, runtime.path)) all.push(runtime)
      }
      return all
    }
    if (changedFiles.length === 0) return []
    const affected: T[] = []
    for (const runtime of this.runtimes.values()) {
      if (changedFiles.some((file) => isInsidePath(runtime.path, join(repoRoot, file)))) affected.push(runtime)
    }
    return affected
  }

  /**
   * The runtime legacy/agent traffic falls back to: the registry default when
   * it is running, else the first running one. Undefined = nothing is up.
   */
  defaultRuntime(): T | undefined {
    const preferred = defaultEntry(this.registryValue)
    if (preferred !== undefined) {
      const match = this.runtimes.get(preferred.id)
      if (match !== undefined) return match
    }
    return this.runtimes.values().next().value
  }

  /**
   * Adopt a registry WITHOUT reconciling the running set.
   *
   * The single-mode folder switch MUST keep `switchWiki()`'s rollback semantics
   * (stop → repoint → start → bootstrap, and on failure put the old wiki back),
   * so it performs the move itself and only needs the farm to agree afterwards.
   * Going through `apply()` there would reconcile a runtime the caller just
   * repointed — stopping and rebuilding the very wiki it had just started.
   */
  syncRegistry(next: WikiRegistry): void {
    this.registryValue = next
  }

  /** May this entry run AT ALL under the current mode? (removed / mode flip) */
  private visible(entry: WikiEntry): boolean {
    if (this.registryValue.mode === 'multi') return true
    return entry.id === this.registryValue.defaultId
  }

  /** Should this entry ATOMICALLY come up at boot (mode + autostart)? */
  shouldRun(entry: WikiEntry): boolean {
    if (!this.visible(entry)) return false
    if (this.registryValue.mode === 'single') return true
    return entry.autostart === true
  }

  /** Ids that boot with the plugin (settings page shows this as 「开局自启」). */
  autoStartIds(): string[] {
    return this.registryValue.wikis.filter((entry) => this.shouldRun(entry)).map((entry) => entry.id)
  }

  /**
   * BOOT: start every entry the mode/autostart asks for.
   *
   * Nothing is running yet, so there is nothing to reconcile — this IS the
   * "开局全起" rule, literally. `apply()` below is the config-CHANGE path and
   * deliberately does less.
   */
  async startAll(): Promise<FarmChange> {
    const change: FarmChange = { started: [], stopped: [], updated: [], running: [], errors: [] }
    this.errors = []
    for (const entry of this.registryValue.wikis) {
      if (!this.shouldRun(entry)) continue
      await this.startEntry(entry)
      change.started.push(entry.id)
    }
    change.running = this.runningIds()
    change.errors = [...this.errors]
    return change
  }

  /**
   * Reconcile the running set against `next` — a CONFIG CHANGE (add / edit /
   * remove an entry, or flip the mode).
   *
   * The rules are deliberately the CONSERVATIVE ones, because a config edit is
   * not a boot:
   *
   *   · an entry that is GONE, or hidden by a mode flip, must stop;
   *   · an entry that is NEWLY ADDED and should auto-start does start;
   *   · everything else keeps whatever running state it has —
   *     turning `autostart` OFF does not kill a wiki the user has open
   *     (`autostart` means "come up at boot"; the next boot honours the new
   *     value), and re-saving an unrelated field never resurrects a wiki the
   *     user stopped by hand;
   *   · a folder change recycles the runtime (setLocation refuses while running).
   *
   * This was found by `scripts/verify-wiki-farm-boot.mjs`: re-asserting the boot
   * rule on every save meant "I started C by hand, then added a wiki" silently
   * stopped C. Explicit start/stop stay explicit (`startEntry`/`stopEntry`).
   */
  async apply(next: WikiRegistry): Promise<FarmChange> {
    const change: FarmChange = { started: [], stopped: [], updated: [], running: [], errors: [] }
    this.errors = []
    const previousIds = new Set(this.registryValue.wikis.map((entry) => entry.id))
    this.registryValue = next
    const byId = new Map(next.wikis.map((entry) => [entry.id, entry]))

    // 1. Release what is gone or hidden by the mode.
    for (const id of [...this.runtimes.keys()]) {
      const entry = byId.get(id)
      if (entry === undefined || !this.visible(entry)) {
        await this.stopEntry(id)
        change.stopped.push(id)
      }
    }

    // 2. Adopt.
    for (const entry of next.wikis) {
      const runtime = this.runtimes.get(entry.id)
      if (runtime === undefined) {
        if (!previousIds.has(entry.id) && this.shouldRun(entry)) {
          await this.startEntry(entry)
          change.started.push(entry.id)
        }
        continue
      }
      if (runtime.path !== entryPath(entry)) {
        // Folder change: recycle (see the module header).
        await this.stopEntry(entry.id)
        change.stopped.push(entry.id)
        if (this.shouldRun(entry)) {
          await this.startEntry(entry)
          change.started.push(entry.id)
        }
        continue
      }
      runtime.updateEntry(entry)
      change.updated.push(entry.id)
    }

    change.running = this.runningIds()
    change.errors = [...this.errors]
    return change
  }

  /**
   * Start ONE wiki on demand (a panel was opened, a session was scoped to it, a
   * route named it). No-op when it is already running.
   */
  async startEntry(entry: WikiEntry): Promise<void> {
    if (this.runtimes.has(entry.id)) return
    let runtime: T
    try {
      runtime = this.options.createRuntime(entry)
    } catch (err) {
      this.record(entry.id, err)
      return
    }
    this.runtimes.set(entry.id, runtime)
    try {
      await runtime.start()
    } catch (err) {
      // KEEP the runtime: the child may still be coming up (WikiServer arms a
      // late-ready watch), and callers must be able to stop it. Reporting the
      // failure is what makes it observable.
      this.record(entry.id, err)
    }
  }

  /** Stop one wiki (drain + stop) and release its runtime. No-op when absent. */
  async stopEntry(id: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (runtime === undefined) return
    this.runtimes.delete(id)
    try {
      if (runtime.isDisposed) return
      await runtime.stop()
    } catch (err) {
      this.record(id, err)
    } finally {
      try {
        await runtime.dispose()
      } catch (err) {
        this.record(id, err)
      }
    }
  }

  /**
   * Release every runtime (plugin teardown / disable). Idempotent, and it keeps
   * going after a failure so one wedged wiki cannot leave the others running.
   */
  async disposeAll(): Promise<void> {
    for (const id of [...this.runtimes.keys()]) {
      await this.stopEntry(id)
    }
  }

  private record(id: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    this.errors.push({ id, message })
    this.log(`知识库「${id}」：${message}`)
  }
}

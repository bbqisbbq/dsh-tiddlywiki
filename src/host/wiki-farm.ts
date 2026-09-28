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

export interface WikiFarmOptions {
  /** Build a runtime for one entry (injected so tests can use fakes). */
  createRuntime: (entry: WikiEntry) => WikiRuntime
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

export class WikiFarm {
  private registryValue: WikiRegistry
  private readonly runtimes = new Map<string, WikiRuntime>()
  private errors: Array<{ id: string; message: string }> = []
  private readonly log: (message: string) => void

  constructor(registry: WikiRegistry, private readonly options: WikiFarmOptions) {
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
  runtime(id: string): WikiRuntime | undefined {
    return this.runtimes.get(id)
  }

  /**
   * The runtime legacy/agent traffic falls back to: the registry default when
   * it is running, else the first running one. Undefined = nothing is up.
   */
  defaultRuntime(): WikiRuntime | undefined {
    const preferred = defaultEntry(this.registryValue)
    if (preferred !== undefined) {
      const match = this.runtimes.get(preferred.id)
      if (match !== undefined) return match
    }
    return this.runtimes.values().next().value
  }

  /** Should this entry be running right now (mode + autostart)? */
  shouldRun(entry: WikiEntry): boolean {
    if (this.registryValue.mode === 'single') return entry.id === this.registryValue.defaultId
    return entry.autostart === true
  }

  /** Ids that boot with the plugin (settings page shows this as 「开局自启」). */
  autoStartIds(): string[] {
    return this.registryValue.wikis.filter((entry) => this.shouldRun(entry)).map((entry) => entry.id)
  }

  /**
   * Start every entry the current mode/autostart asks for.
   *
   * SEQUENTIAL ON PURPOSE. N TW children booting at once means N cold starts
   * competing for disk and CPU, and a farm whose logs interleave on failure is
   * much harder to read. The per-instance failure isolation (see the module
   * header) is what keeps one bad folder from blocking the rest.
   */
  async startAll(): Promise<FarmChange> {
    return this.apply(this.registryValue)
  }

  /**
   * Reconcile the running set against `next` (the new registry).
   *
   * Steps, in order (the order IS the safety property):
   *   1. release everything that must no longer run;
   *   2. adopt the new list — start new entries, recycle folder changes, refresh
   *      flags in place.
   */
  async apply(next: WikiRegistry): Promise<FarmChange> {
    const change: FarmChange = { started: [], stopped: [], updated: [], running: [], errors: [] }
    this.errors = []
    this.registryValue = next
    const byId = new Map(next.wikis.map((entry) => [entry.id, entry]))

    // 1. Release what is gone, no longer autostart, or hidden by a mode flip.
    for (const id of [...this.runtimes.keys()]) {
      const entry = byId.get(id)
      if (entry === undefined || !this.shouldRun(entry)) {
        await this.stopEntry(id)
        change.stopped.push(id)
      }
    }

    // 2. Adopt.
    for (const entry of next.wikis) {
      const runtime = this.runtimes.get(entry.id)
      if (runtime === undefined) {
        if (this.shouldRun(entry)) {
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
    let runtime: WikiRuntime
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

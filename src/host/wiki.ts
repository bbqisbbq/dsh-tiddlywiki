/**
 * WikiServer — the TiddlyWiki 5 child-process lifecycle (design doc §9, D3).
 *
 * Zero-friction rules:
 * - ensure the wiki folder exists (scaffold with `--init server` once)
 * - git bootstrap is NOT this class's job (index.ts owns the GitFace)
 * - auto-detect a free loopback port unless one is pinned in config
 * - spawn `node <tw>/tiddlywiki.js <wiki> --listen host=127.0.0.1 ...`
 *   and poll /status until it answers 200
 * - the TW child serves at the ROOT of its own dedicated loopback port (no
 *   `path-prefix`): TW's browser frontend builds its API URLs from
 *   `$protocol$//$host$/` only, so any path-prefix makes every frontend call
 *   ../../status → 404 (verified against tiddlywiki 5.4.1). Namespacing lives
 *   on the DSH webserver side (/dsh-tiddlywiki/* routes), never in TW itself.
 * - crash → restart with exponential backoff (1s,2s,4s… cap 30s), reset on
 *   a successful readiness
 * - stop() is deterministic: SIGTERM, escalate to SIGKILL after a grace
 *   period, and never leave a timer that would respawn during teardown
 *
 * @module dsh-tiddlywiki/host/wiki
 */
import { spawn, execFile, type ChildProcessByStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import type { Readable } from 'node:stream'

/** The DSH webserver route prefix (NOT a TW path-prefix; see module header). */
export const PATH_PREFIX = '/dsh-tiddlywiki'

/** How long to wait for the wiki to answer /status. */
const READY_TIMEOUT_MS = 20_000

/** Poll cadence while waiting for readiness. */
const READY_POLL_MS = 500

/** Backoff ceiling for crash restarts. */
const MAX_RESTART_BACKOFF_MS = 30_000

/** SIGTERM → SIGKILL escalation grace. */
const KILL_GRACE_MS = 3_000

/** Ring-buffer cap for the stdout/stderr log. */
const LOG_BUFFER_LIMIT = 200

/** One-shot scaffold timeout for `--init server`. */
const INIT_TIMEOUT_MS = 30_000

export interface WikiServerOptions {
  /** Root that holds one folder per wiki (default $DSH_HOME/tiddlywiki). */
  wikiRoot: string
  /** Wiki folder name under wikiRoot (default "main"). */
  wiki: string
  /** Port; 0 = auto-detect a free loopback port. */
  port: number
  /** Optional Basic Auth (loopback anonymous by default). */
  username?: string
  password?: string
  logBufferLimit?: number
}

export type WikiHealth = 'starting' | 'running' | 'stopped' | 'failed'

export interface WikiStatusView {
  status: WikiHealth
  url?: string
  port?: number
  wikiPath: string
  pid?: number
  lastStartedAt?: number
  error?: string
  logs: string[]
}

/** Resolve the absolute entry of the installed `tiddlywiki` package. */
function resolveTwEntry(): string {
  const require = createRequire(import.meta.url)
  return require.resolve('tiddlywiki/tiddlywiki.js')
}

export class WikiServer {
  private child: ChildProcessByStdio<null, Readable, Readable> | undefined
  private readonly wikiPath: string
  private readonly logs: string[] = []
  private readonly logLimit: number
  private health: WikiHealth = 'stopped'
  private port: number | undefined
  private stopping = false
  private restartTimer: NodeJS.Timeout | undefined
  private restartDelay = 1_000
  private lastStartedAt: number | undefined
  private error: string | undefined

  constructor(private readonly options: WikiServerOptions) {
    this.wikiPath = resolve(options.wikiRoot, options.wiki)
    this.logLimit = options.logBufferLimit ?? LOG_BUFFER_LIMIT
  }

  /** Base URL of the TW service, once a port is bound (root, no path prefix). */
  get url(): string | undefined {
    return this.port === undefined ? undefined : `http://127.0.0.1:${this.port}`
  }

  /** The currently bound port (undefined until first spawn). */
  get currentPort(): number | undefined {
    return this.port
  }

  private log(line: string): void {
    const ts = new Date().toISOString()
    this.logs.push(`[${ts}] ${line}`)
    if (this.logs.length > this.logLimit) this.logs.splice(0, this.logs.length - this.logLimit)
  }

  /** Scaffold the wiki folder with `--init server` when it is absent. */
  async ensureWiki(): Promise<void> {
    await mkdir(this.wikiPath, { recursive: true })
    if (existsSync(join(this.wikiPath, 'tiddlywiki.info'))) return
    const tw = resolveTwEntry()
    this.log(`init: ${process.execPath} ${tw} ${this.wikiPath} --init server`)
    await new Promise<void>((resolveP, rejectP) => {
      execFile(process.execPath, [tw, this.wikiPath, '--init', 'server'], { timeout: INIT_TIMEOUT_MS, windowsHide: true }, (err) => {
        if (err) rejectP(err as Error)
        else resolveP()
      })
    })
  }

  /** Probe a free loopback port. */
  private async findFreePort(): Promise<number> {
    return new Promise<number>((resolveP, rejectP) => {
      const server = createServer()
      server.unref()
      server.once('error', rejectP)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address === null || typeof address === 'string') {
          server.close()
          rejectP(new Error('cannot resolve a free port'))
          return
        }
        const port = address.port
        server.close(() => resolveP(port))
      })
    })
  }

  /**
   * Start (or restart) the TW child. Resolves once `/status` answers 200 or
   * the readiness deadline passes. Never throws on a crash — the exit handler
   * schedules a self-healing restart unless we are stopping.
   */
  async start(): Promise<WikiStatusView> {
    this.stopping = false
    this.restartDelay = 1_000
    await this.ensureWiki()
    if (this.child !== undefined) return this.status()
    this.health = 'starting'
    // Reuse an existing auto port across restarts (restart() → stop() → start())
    // so a fixed-baseUrl TiddlyWebClient stays valid and iframe src is stable.
    const port = this.options.port > 0 ? this.options.port : ((this.port ?? 0) > 0 ? this.port as number : await this.findFreePort())
    this.port = port
    const tw = resolveTwEntry()
    const args = [tw, this.wikiPath, '--listen', 'host=127.0.0.1', `port=${port}`]
    if (this.options.username) {
      // Locked-down mode for non-loopback exposure: Basic Auth + access lists.
      args.push(`username=${this.options.username}`)
      args.push(`password=${this.options.password ?? ''}`)
      args.push(`readers=${this.options.username}`)
      args.push(`writers=${this.options.username}`)
    }
    // Anonymous loopback mode carries NO auth args: TW's defaults open the
    // wiki to anonymous read/write on the bound (loopback) address. Passing
    // anon-username/readers/writers here was verified to 401 every request
    // ('undefined' is not authorized), so the anonymous branch stays bare.
    this.log(`spawn: ${process.execPath} ${args.join(' ')}`)
    const child = spawn(process.execPath, args, { cwd: this.wikiPath, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    child.stdout.on('data', (chunk: Buffer) => this.log(`[out] ${String(chunk).trimEnd()}`))
    child.stderr.on('data', (chunk: Buffer) => this.log(`[err] ${String(chunk).trimEnd()}`))
    child.once('exit', (code, signal) => {
      this.log(`exit code=${code} signal=${signal ?? ''} stopping=${this.stopping}`)
      this.child = undefined
      this.health = 'stopped'
      if (!this.stopping) this.scheduleRestart()
    })
    child.once('error', (err) => {
      this.log(`spawn error: ${err.message}`)
      this.error = err.message
      this.child = undefined
      this.health = 'failed'
      if (!this.stopping) this.scheduleRestart()
    })
    this.lastStartedAt = Date.now()
    await this.waitReady()
    return this.status()
  }

  /** Poll /status until 200 or the deadline; throws only on deadline/crash. */
  private async waitReady(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    for (;;) {
      if (this.child === undefined) throw new Error('wiki process exited before ready')
      try {
        const res = await fetch(`${this.url}/status`, { signal: AbortSignal.timeout(2_000) })
        if (res.ok) {
          this.health = 'running'
          this.log('ready: /status 200')
          return
        }
      } catch {
        /* not ready yet */
      }
      if (Date.now() > deadline) {
        this.health = 'failed'
        this.error = 'wiki server did not become ready in time'
        this.log(this.error)
        throw new Error(this.error)
      }
      await new Promise<void>((r) => setTimeout(r, READY_POLL_MS))
    }
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer !== undefined) return
    const delay = this.restartDelay
    this.restartDelay = Math.min(this.restartDelay * 2, MAX_RESTART_BACKOFF_MS)
    this.log(`restart scheduled in ${delay}ms`)
    this.health = 'starting'
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      void this.start().catch((err) => {
        this.health = 'failed'
        this.error = err instanceof Error ? err.message : String(err)
        this.log(`restart failed: ${this.error}`)
      })
    }, delay)
  }

  /** One-click restart (route /dsh-tiddlywiki/restart, panel retry button). */
  async restart(): Promise<WikiStatusView> {
    await this.stop()
    return this.start()
  }

  /** Deterministic teardown: cancel timers, SIGTERM, escalate to SIGKILL. */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const child = this.child
    this.child = undefined
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM')
      } catch { /* already gone */ }
      await Promise.race([
        new Promise<void>((r) => child.once('exit', () => r())),
        new Promise<void>((r) => {
          setTimeout(() => {
            try { child.kill('SIGKILL') } catch { /* already gone */ }
            r()
          }, KILL_GRACE_MS).unref?.()
        }),
      ])
    }
    this.health = 'stopped'
  }

  /** Live status view (health, url, git-independent, recent logs). */
  status(): WikiStatusView {
    return {
      status: this.health,
      url: this.url,
      port: this.port,
      wikiPath: this.wikiPath,
      pid: this.child?.pid,
      lastStartedAt: this.lastStartedAt,
      ...(this.error !== undefined ? { error: this.error } : {}),
      logs: [...this.logs],
    }
  }
}

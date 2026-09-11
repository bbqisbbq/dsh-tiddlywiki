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

/**
 * Same-origin TW proxy route on the DSH webserver (remote-access mode, R1).
 * The browser only ever talks to the DSH origin — which it already reaches
 * over loopback, LAN, Tailscale, a domain or HTTPS — and DSH proxies to the
 * loopback TW child. TW's frontend is pointed at this prefix via the
 * `$:/config/tiddlyweb/host` tiddler so every API call stays same-origin.
 */
export const TW_PROXY_PREFIX = `${PATH_PREFIX}/tw`

/** The proxy base path (trailing slash) handed to browsers / TW's frontend. */
export const TW_PROXY_PATH = `${TW_PROXY_PREFIX}/`

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
  /** In-flight start() promise: single-flight guard (v0.19.0). */
  private startPromise: Promise<WikiStatusView> | undefined
  /** In-flight restart(): two concurrent restarts must not spawn two children (v0.19.1). */
  private restartPromise: Promise<WikiStatusView> | undefined
  /** Set by a successful readiness probe; a crash BEFORE readiness means the
   *  auto-chosen port may have been taken, so it is re-probed on restart. */
  private wasReady = false

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
   *
   * SINGLE-FLIGHT (v0.19.0): two concurrent callers (double restart click, a
   * restart racing the self-heal timer) both used to pass the
   * `child !== undefined` check, probe their own port and spawn a child each —
   * the loser became an orphan process holding a port until dsh web exited.
   */
  async start(): Promise<WikiStatusView> {
    if (this.startPromise !== undefined) return this.startPromise
    const run = this.startOnce()
    this.startPromise = run
    try {
      return await run
    } finally {
      this.startPromise = undefined
    }
  }

  private async startOnce(): Promise<WikiStatusView> {
    this.stopping = false
    this.restartDelay = 1_000
    // Clear a previous failure's message (v0.19.5): a self-healed restart left
    // `this.error` set forever, so `/status` (and the panel/FAB tooltip) kept
    // reporting a stale fault even though the wiki was healthy. A fresh attempt
    // is not a failure until it proves to be one.
    this.error = undefined
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
    //
    // NEVER log the raw argv: it carries `password=…`, the ring buffer is
    // returned by the UNAUTHENTICATED GET /status, and the same string could
    // end up in a crash dump. (v0.19.0 — the spawn line used to be logged
    // verbatim; the password still lives in the OS process list, which is why
    // the wiki binds loopback by default.)
    this.log(`spawn: ${process.execPath} ${args.map((a) => (/^password=/.test(a) ? 'password=***' : a)).join(' ')}`)
    const child = spawn(process.execPath, args, { cwd: this.wikiPath, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    child.stdout.on('data', (chunk: Buffer) => this.log(`[out] ${String(chunk).trimEnd()}`))
    child.stderr.on('data', (chunk: Buffer) => this.log(`[err] ${String(chunk).trimEnd()}`))
    child.once('exit', (code, signal) => {
      // IDENTITY CHECK (v0.19.0): restart() SIGKILLs the old child and start()
      // immediately flips `stopping` back to false, so the old child's exit
      // event can arrive AFTER the new one is running. Without this check it
      // cleared `this.child`/`this.port` and marked the healthy new child
      // 'stopped' — waitReady() then polled `undefined/status` and every route
      // 503'd while TW was actually up.
      if (this.child !== child) {
        this.log(`exit code=${code} signal=${signal ?? ''} (superseded child — ignored)`)
        return
      }
      this.log(`exit code=${code} signal=${signal ?? ''} stopping=${this.stopping}`)
      this.child = undefined
      this.health = 'stopped'
      if (!this.stopping) {
        // Never became ready → most likely `EADDRINUSE` on the remembered auto
        // port. Forget it so the restart probes a fresh one instead of looping
        // on a port this process no longer owns. An explicitly configured port
        // is always honored as-is.
        if (this.options.port === 0 && !this.wasReady) this.port = undefined
        this.scheduleRestart()
      }
    })
    child.once('error', (err) => {
      this.log(`spawn error: ${err.message}`)
      this.error = err.message
      if (this.child !== child) return
      this.child = undefined
      this.health = 'failed'
      if (!this.stopping) this.scheduleRestart()
    })
    this.lastStartedAt = Date.now()
    this.wasReady = false
    await this.waitReady()
    return this.status()
  }

  /** Poll /status until 200 or the deadline; throws only on deadline/crash. */
  private async waitReady(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    // Locked-down mode (`username` configured) puts /status behind TW's
    // `readers` list: an anonymous probe gets 401 forever and the wiki would
    // never be reported ready. Authenticate preemptively, exactly like the
    // REST client does.
    const headers = this.options.username !== undefined && this.options.username.length > 0
      ? { authorization: `Basic ${Buffer.from(`${this.options.username}:${this.options.password ?? ''}`, 'utf8').toString('base64')}` }
      : undefined
    for (;;) {
      if (this.child === undefined) throw new Error('wiki process exited before ready')
      try {
        const res = await fetch(`${this.url}/status`, {
          signal: AbortSignal.timeout(2_000),
          ...(headers !== undefined ? { headers } : {}),
        })
        if (res.ok) {
          this.health = 'running'
          this.wasReady = true
          this.error = undefined
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

  /**
   * One-click restart (routes `/restart`, `/sync`, every `/admin/*` restart).
   *
   * SINGLE-FLIGHT (v0.19.1): the route-level mutex in routes.ts could not cover
   * the admin routes (separate closure), so two concurrent restarts — a double
   * click, or `/restart` racing `/admin/seeds/run` — used to run `stop()` twice
   * and spawn two children; the loser became an orphan process holding a port
   * until dsh web exited. Serializing here fixes every caller at once.
   */
  async restart(): Promise<WikiStatusView> {
    if (this.restartPromise !== undefined) return this.restartPromise
    const run = (async (): Promise<WikiStatusView> => {
      await this.stop()
      return this.start()
    })()
    this.restartPromise = run
    try {
      return await run
    } finally {
      this.restartPromise = undefined
    }
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
      // After the SIGKILL escalation, give the OS a moment to actually reap the
      // process: an immediate start() that rebinds the same port would
      // otherwise hit EADDRINUSE and enter the backoff loop (v0.19.0).
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([
          new Promise<void>((r) => child.once('exit', () => r())),
          new Promise<void>((r) => { setTimeout(r, 1_000).unref?.() }),
        ])
      }
    }
    // Only report 'stopped' when no replacement child has been spawned in the
    // meantime (restart() runs stop() → start()).
    if (this.child === undefined) this.health = 'stopped'
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

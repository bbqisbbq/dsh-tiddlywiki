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
import { awaitReady, normalizeReadyTimeoutMs, readyHardTimeoutMs } from './ready-policy.ts'

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

/*
 * Readiness is POLICY, not a constant: `ready-policy.ts` owns the soft window
 * (default 60s, configurable), the 3× hard deadline and the polling loop — see
 * its module header for the incident (a 44s cold boot of a 5000-tiddler wiki
 * was declared a failure after 20s and left the status stuck on 'failed').
 */

/** Late-ready watch: cadence and lifetime after the hard deadline passed. */
const LATE_READY_POLL_MS = 5_000

/** How long the late-ready watch keeps probing a child that outlived the deadline. */
const LATE_READY_WINDOW_MS = 10 * 60_000

/** Backoff ceiling for crash restarts. */
const MAX_RESTART_BACKOFF_MS = 30_000

/** SIGTERM → SIGKILL escalation grace. */
const KILL_GRACE_MS = 3_000

/** Ring-buffer cap for the stdout/stderr log. */
const LOG_BUFFER_LIMIT = 200

/** One-shot scaffold timeout for `--init server`. */
const INIT_TIMEOUT_MS = 30_000

/**
 * `anon-username` for the anonymous loopback spawn (v0.22.9).
 *
 * This MUST stay the literal `"GUEST"`. TW's TiddlyWeb adaptor derives its
 * login flag as `json.username !== "GUEST"` (tiddlywebadaptor.js:93), so any
 * other value — including any real person's name — still reports as logged in,
 * and syncer.js then overwrites `$:/status/UserName` with whatever `/status`
 * returns. Only this sentinel makes the syncer leave the user's signature
 * alone. Exported so the regression gate asserts the exact string instead of
 * re-typing it.
 */
export const ANON_USERNAME = 'GUEST'

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
  /**
   * Soft readiness window in ms (v0.22.5, default 60s, clamped 5s–600s): after
   * this a still-loading child is only WARNED about; the attempt fails at 3×.
   * Editable at runtime through {@link WikiServer.setReadyTimeout}.
   */
  readyTimeoutMs?: number
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
  /**
   * The wiki folder this server currently serves. MUTABLE since v0.22.0: a
   * runtime switch calls {@link setLocation} while the child is stopped.
   */
  private wikiPath: string
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
  /** Soft readiness window (ms, default 60s) — runtime-editable via {@link setReadyTimeout}. */
  private readyTimeoutMs: number
  /** Pending tick of the late-ready watch (v0.22.5), unref'ed. */
  private lateReadyTimer: NodeJS.Timeout | undefined
  /** End timestamp of the armed late-ready watch (undefined = not armed). */
  private lateReadyWatchUntil: number | undefined

  constructor(private readonly options: WikiServerOptions) {
    this.wikiPath = resolve(options.wikiRoot, options.wiki)
    this.location = { root: options.wikiRoot, name: options.wiki }
    this.logLimit = options.logBufferLimit ?? LOG_BUFFER_LIMIT
    this.readyTimeoutMs = normalizeReadyTimeoutMs(options.readyTimeoutMs)
  }

  /**
   * The wiki folder this server currently serves (v0.22.0: mutable — a runtime
   * switch calls {@link setLocation} while the child is stopped).
   */

  /** Last location applied through {@link setLocation} / the constructor. */
  private location: { root: string; name: string }

  /** Current location (root + folder name), for the settings page. */
  get currentLocation(): { root: string; name: string } {
    return { ...this.location }
  }

  /**
   * Point this server at a DIFFERENT wiki folder (runtime switch, v0.22.0).
   *
   * Refuses while a child is running: a switch that forgot the folder while the
   * old process still served it would leave `/status`, the REST client and the
   * git face describing two different wikis. Callers stop() first (see
   * `switchWiki()` in host/wiki-switch.ts), then start() again.
   *
   * The bound port is INTENTIONALLY kept: reusing it across a switch keeps the
   * iframe src and the cached REST client valid (same reasoning as restart()).
   */
  setLocation(location: { root: string; name: string }): void {
    if (this.child !== undefined) throw new Error('wiki 必须先在停止状态下才能切换位置')
    const next = resolve(location.root, location.name)
    if (next === this.wikiPath) {
      this.location = { root: location.root, name: location.name }
      return
    }
    this.location = { root: location.root, name: location.name }
    this.wikiPath = next
    // A different folder is a different wiki: clear the stale failure message
    // and the readiness flag (a crash before readiness re-probes the port).
    this.wasReady = false
    this.error = undefined
    if (this.child === undefined) this.health = 'stopped'
    this.log(`location → ${next}`)
  }

  /** Base URL of the TW service, once a port is bound (root, no path prefix). */
  get url(): string | undefined {
    return this.port === undefined ? undefined : `http://127.0.0.1:${this.port}`
  }

  /**
   * Update the readiness window (v0.22.5).
   *
   * Applies to the NEXT start()/restart(): the settings page saves
   * `startup.readyTimeoutMs` and the host calls this on every config change, so
   * a user with an even slower wiki can raise it without restarting dsh web.
   * Values are clamped by ready-policy.ts (5s–600s; anything invalid → default).
   */
  setReadyTimeout(value: unknown): void {
    const next = normalizeReadyTimeoutMs(value)
    if (next === this.readyTimeoutMs) return
    this.readyTimeoutMs = next
    this.log(`ready timeout → ${next}ms (hard deadline ${readyHardTimeoutMs(next)}ms)`)
  }

  /** The soft readiness window currently in effect (settings page / diagnostics). */
  get currentReadyTimeoutMs(): number {
    return this.readyTimeoutMs
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
    // A new attempt supersedes any late-ready watch armed by the previous one
    // (v0.22.5): it polls this.child by identity, but leaving it pending would
    // keep a pointless timer around.
    this.clearLateReadyWatch()
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
      // Do NOT add anon-username here: `authenticatedUsername` already wins in
      // get-status.js, so it changes nothing for an authenticated caller.
      args.push(`username=${this.options.username}`)
      args.push(`password=${this.options.password ?? ''}`)
      args.push(`readers=${this.options.username}`)
      args.push(`writers=${this.options.username}`)
    } else {
      // Anonymous loopback mode: no auth args (TW's defaults open the wiki to
      // anonymous read/write on the bound loopback address), but the username
      // MUST be the literal sentinel `GUEST`.
      //
      // v0.22.9 — WHY (this used to say the opposite, and that comment caused
      // the bug): the old note claimed "anon-username/readers/writers was
      // verified to 401 every request". That conflated two independent args.
      // Only `readers`/`writers` close anonymous access (server.js:63-66 makes
      // an explicit `readers` list drop the `(anon)` principal, so
      // isAuthorized() returns false and requestHandler 401s with
      // `'undefined' is not authorized`). `anon-username` ALONE is harmless —
      // verified against TW 5.4.1: /status 200, GET 204-tiddler 200, PUT 204.
      //
      // Without it, get-status.js:21 falls back to `""`, and the TiddlyWeb
      // adaptor decides login as `json.username !== "GUEST"`
      // (tiddlywebadaptor.js:93) → `"" !== "GUEST"` is TRUE → it believes the
      // anonymous reader is logged in. syncer.js:281-283 then overwrites
      // `$:/status/UserName` with that empty string on EVERY page load, which
      // silently wipes the user's Control Panel signature (and, once
      // `$:/config/SyncFilter` is edited to allowlist UserName, commits the
      // loss to disk and git). `GUEST` is a load-bearing magic value, not a
      // style choice: any other name still leaves isLoggedIn true.
      args.push(`anon-username=${ANON_USERNAME}`)
    }
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

  /**
   * Preemptive Basic header for the readiness probe. Locked-down mode
   * (`username` configured) puts /status behind TW's `readers` list: an
   * anonymous probe gets 401 forever and the wiki would never be reported
   * ready. Shared with the late-ready watch below.
   */
  private authHeaders(): Record<string, string> | undefined {
    if (this.options.username === undefined || this.options.username.length === 0) return undefined
    return { authorization: `Basic ${Buffer.from(`${this.options.username}:${this.options.password ?? ''}`, 'utf8').toString('base64')}` }
  }

  /** One /status probe: true = 200 OK. Never throws (a refused socket while TW
   *  is still loading is "not ready yet", not an error). */
  private async probeStatus(headers: Record<string, string> | undefined): Promise<boolean> {
    if (this.port === undefined) return false
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/status`, {
        signal: AbortSignal.timeout(2_000),
        ...(headers !== undefined ? { headers } : {}),
      })
      return res.ok
    } catch {
      return false
    }
  }

  /**
   * Wait for readiness (v0.22.5 policy, see ready-policy.ts).
   *
   * Throws only when the child EXITED before ready, or when the HARD deadline
   * (3× the soft window) passed with the child still silent. Passing the soft
   * window is a warning, not a verdict: a 5000-tiddler wiki can legitimately
   * need 40s+ on a cold cache, and failing there aborted seeding/config/clip
   * bridge for a wiki that was about to serve. On a hard timeout the child is
   * LEFT RUNNING and a bounded late-ready watch is armed, so `/status` stops
   * reporting a fault the moment TW really answers.
   */
  private async waitReady(): Promise<void> {
    const headers = this.authHeaders()
    const outcome = await awaitReady({
      probe: () => this.probeStatus(headers),
      isAlive: () => this.child !== undefined,
      softTimeoutMs: this.readyTimeoutMs,
      onSlow: (elapsedMs, hardTimeoutMs) => {
        // Still loading, not broken: keep the status honest ('starting') and
        // never leave a stale error behind (the pre-v0.22.5 code set 'failed'
        // here and nothing ever cleared it).
        this.health = 'starting'
        this.error = undefined
        this.log(`slow start: /status not ready after ${Math.round(elapsedMs / 1000)}s — still loading (hard deadline ${Math.round(hardTimeoutMs / 1000)}s)`)
      },
    })
    if (outcome === 'ready') {
      this.health = 'running'
      this.wasReady = true
      this.error = undefined
      this.log('ready: /status 200')
      return
    }
    if (outcome === 'timeout') {
      const hard = readyHardTimeoutMs(this.readyTimeoutMs)
      this.health = 'failed'
      this.error = `wiki server did not become ready in time (${Math.round(hard / 1000)}s)`
      this.log(this.error)
      this.armLateReadyWatch()
      throw new Error(this.error)
    }
    throw new Error('wiki process exited before ready')
  }

  /**
   * Keep a low-frequency probe on a child that outlived the readiness deadline
   * (v0.22.5). Bounded and `unref`ed (never holds the process open); cancelled
   * by stop() and superseded by the next start(). It only ever PROMOTES the
   * status — it never spawns, kills, or writes anything.
   */
  private armLateReadyWatch(): void {
    const child = this.child
    if (child === undefined || this.stopping || this.lateReadyTimer !== undefined || this.lateReadyWatchUntil !== undefined) return
    const deadline = Date.now() + LATE_READY_WINDOW_MS
    this.lateReadyWatchUntil = deadline
    const headers = this.authHeaders()
    this.log(`late-ready watch armed (up to ${Math.round(LATE_READY_WINDOW_MS / 60_000)}min)`)
    const tick = async (): Promise<void> => {
      this.lateReadyTimer = undefined
      if (this.stopping || this.child !== child || this.health === 'running') {
        this.lateReadyWatchUntil = undefined
        return
      }
      if (await this.probeStatus(headers)) {
        this.health = 'running'
        this.wasReady = true
        this.error = undefined
        this.lateReadyWatchUntil = undefined
        this.log('ready (late): /status 200 — cleared the stale startup failure')
        return
      }
      if (Date.now() >= deadline) {
        this.lateReadyWatchUntil = undefined
        this.log('late-ready watch gave up (child never answered /status)')
        return
      }
      this.lateReadyTimer = setTimeout(() => { void tick() }, LATE_READY_POLL_MS)
      this.lateReadyTimer.unref?.()
    }
    this.lateReadyTimer = setTimeout(() => { void tick() }, LATE_READY_POLL_MS)
    this.lateReadyTimer.unref?.()
  }

  /** Cancel a pending late-ready watch (stop / new attempt / teardown). */
  private clearLateReadyWatch(): void {
    if (this.lateReadyTimer !== undefined) {
      clearTimeout(this.lateReadyTimer)
      this.lateReadyTimer = undefined
    }
    this.lateReadyWatchUntil = undefined
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
    // A late-ready watch would otherwise keep probing a child we are about to
    // kill (and could resurrect 'running' during teardown).
    this.clearLateReadyWatch()
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

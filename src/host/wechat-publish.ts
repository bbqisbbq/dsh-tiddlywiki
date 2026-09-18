/**
 * 微信公众号发布的宿主侧执行器（v0.23.3）。
 *
 * 背景：发布能力的**真身**是仓库 `tools/wechat/` 下那两个 opencli adapter
 * (`publish-note` / `publish-note-imgs`)，它们驱动用户已登录的 Chrome 把一篇
 * TiddlyWiki 笔记排好版存进公众号草稿箱。CLI 用法见 docs/wechat-publish-setup.md。
 *
 * 本模块把那条命令**包成一个可查询的后台任务**，好让 TW 工具栏按钮
 * （`$:/plugins/dsh/wechat-publish`，可选功能，见 seedWechatPublish）能一键触发：
 *
 *   TW 按钮 → POST /wechat/publish → 这里 spawn opencli → 轮询
 *   GET /wechat/publish/status → 覆盖层显示进度 → 存草稿成功/失败
 *
 * 三个必须讲清楚的设计点（都是踩出来的，别改回去）：
 *
 *  1. **标题不进 argv，走 UTF-8 文件**。Windows 上 `opencli` 是 `.cmd` shim，
 *     Node 的 `spawn('opencli', …)` 直接 ENOENT，必须经 cmd.exe 才跑得起来 ——
 *     于是标题里的 `&`/`|`/`^`/引号会变成命令注入面，中文标题还会被 cmd 的代码页
 *     解码成乱码。现在宿主写 `<jobDir>/<id>.title`，argv 里只有我们自己生成的路径
 *     （配合 adapter 的 `--title-file`，见 weixin-flow.resolveNoteTitle）。
 *  2. **必须是一个 job，不是一次请求**。命令要跑几十秒到几分钟（多图更久，
 *     发表还要等扫码），TW 的 `$tw.utils.httpRequest` 和 webserver 都不会陪你等。
 *  3. **`--trace retain-on-failure` 是承重参数**（不带就对 mp.weixin.qq.com 稳定
 *     报 `Navigation rejected`，实测 trace 开 5/5 成功、关 8/8 失败），所以它写死在
 *     组装逻辑里，不暴露给调用方。
 *
 * 单并发：同一时刻只允许一个发布任务（`start()` 返回 busy）。这与路由的
 * `/sync` `/restart` 互斥是同一思路 —— 两个 opencli 同时抢一个浏览器标签页没有
 * 任何好处，只会互相踩。
 *
 * @module dsh-tiddlywiki/host/wechat-publish
 */
import { spawn as nodeSpawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dshHomePath } from '../sdk.ts'

/** The two publish adapters this runner may drive (whitelist — never free text). */
export const WECHAT_ADAPTERS = ['publish-note', 'publish-note-imgs'] as const
export type WechatAdapter = (typeof WECHAT_ADAPTERS)[number]

/** Default adapter: the one that works with the four core adapter files. */
export const DEFAULT_WECHAT_ADAPTER: WechatAdapter = 'publish-note'

/** Default CLI (config `wechat.command` overrides it, e.g. an absolute path). */
export const DEFAULT_WECHAT_COMMAND = 'opencli'

/**
 * Files each adapter needs in the opencli adapter directory. Mirrors
 * install-wechat-adapters.mjs FILES (both publish adapters import the shared
 * flow + decorator, so a half-installed directory must be reported as missing).
 */
export const WECHAT_ADAPTER_FILES: Record<WechatAdapter, readonly string[]> = {
  'publish-note': ['publish-note.js', 'wechat-html.js', 'weixin-flow.js'],
  'publish-note-imgs': ['publish-note-imgs.js', 'wechat-html.js', 'weixin-flow.js'],
}

/** Captured output per stream; the job view only exposes the tail. */
export const MAX_JOB_OUTPUT_CHARS = 64_000
/** How much of the log the TW overlay shows (keeps the JSON response small). */
export const JOB_LOG_TAIL_CHARS = 4_000
/** Hard cap for one publish run (multi-image + scan waits stay well below). */
export const DEFAULT_JOB_TIMEOUT_MS = 15 * 60_000
/** How long `opencli --version` may take before we call it missing. */
export const OPENCLI_PROBE_TIMEOUT_MS = 10_000
/** How many finished jobs to remember for post-mortem lookups. */
const JOB_HISTORY_LIMIT = 20

export interface WechatPublishConfig {
  enabled: boolean
  command: string
  token: string
  adapter: WechatAdapter
  /** Optional explicit `--dsn`; empty = derive from the request (loopback). */
  dsn: string
}

/**
 * Normalize the raw `wechat` config block. Unknown/garbage values fall back to
 * the defaults rather than reaching the spawn path — this object is built from a
 * user-editable tiddler, so every field is treated as untrusted input.
 */
export function normalizeWechatConfig(raw: unknown): WechatPublishConfig {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const command = typeof source.command === 'string' && source.command.trim().length > 0
    ? source.command.trim()
    : DEFAULT_WECHAT_COMMAND
  const token = typeof source.token === 'string' ? source.token.trim() : ''
  const adapter = WECHAT_ADAPTERS.includes(source.adapter as WechatAdapter)
    ? (source.adapter as WechatAdapter)
    : DEFAULT_WECHAT_ADAPTER
  const dsn = typeof source.dsn === 'string' ? source.dsn.trim() : ''
  return { enabled: source.enabled === true, command, token, adapter, dsn }
}

/** True when a value may be embedded in the cmd.exe command line (v0.23.3). */
export function isSafeCliValue(value: string): boolean {
  // Everything we pass is either a literal we control or a validated path/URL.
  // cmd.exe metacharacters, quotes and control characters are refused outright —
  // the title (the one user-controlled string in this flow) never gets here
  // because it travels in a file.
  return value.length > 0
    && !/["&|<>^%\r\n\t\u0000-\u001f]/.test(value)
}

/**
 * Validate the `--dsn` value: a plain http(s) URL without credentials, query or
 * fragment (the adapters append `/render` and `/get` themselves).
 */
export function isSafeDsn(dsn: string): boolean {
  return /^https?:\/\/[A-Za-z0-9._-]+(:\d{1,5})?(\/[A-Za-z0-9._\-/]*)?$/.test(dsn)
}

export interface PublishInvocation {
  file: string
  args: string[]
  /** Windows: our cmd.exe line must reach the child verbatim (no re-quoting). */
  windowsVerbatimArguments: boolean
}

/**
 * Build the argv-equivalent for one publish run. Pure + exported so the guard
 * script can assert the Windows shim path and the "no title in argv" property
 * without spawning anything.
 *
 * Windows: `opencli` resolves through PATHEXT to `opencli.cmd`, which
 * CreateProcess cannot execute — hence `cmd.exe /d /s /c "<line>"` with
 * `windowsVerbatimArguments` so Node does not re-quote our already-quoted line.
 */
export function buildPublishInvocation(opts: {
  platform: NodeJS.Platform
  command: string
  adapter: WechatAdapter
  titleFile: string
  dsn: string
}): PublishInvocation {
  if (!WECHAT_ADAPTERS.includes(opts.adapter)) throw new Error(`unsupported wechat adapter: ${String(opts.adapter)}`)
  if (!isSafeCliValue(opts.command)) throw new Error(`wechat.command contains characters that cannot be passed to the CLI: ${JSON.stringify(opts.command)}`)
  if (!isSafeCliValue(opts.titleFile)) throw new Error(`title file path is not safe for the command line: ${JSON.stringify(opts.titleFile)}`)
  if (!isSafeDsn(opts.dsn)) throw new Error(`invalid wechat dsn: ${JSON.stringify(opts.dsn)}`)
  const args = [
    'weixin', opts.adapter,
    '--title-file', opts.titleFile,
    '--dsn', opts.dsn,
    // 承重参数，见模块头注释第 3 条。
    '--trace', 'retain-on-failure',
    '-f', 'json',
  ]
  if (opts.platform === 'win32') {
    const quote = (value: string): string => (value.includes(' ') ? `"${value}"` : value)
    const line = [quote(opts.command), ...args.map(quote)].join(' ')
    return {
      file: process.env.ComSpec !== undefined && process.env.ComSpec.length > 0 ? process.env.ComSpec : 'cmd.exe',
      args: ['/d', '/s', '/c', line],
      windowsVerbatimArguments: true,
    }
  }
  return { file: opts.command, args, windowsVerbatimArguments: false }
}

/** `opencli --version`, used by the readiness probe. */
export function buildVersionInvocation(opts: { platform: NodeJS.Platform; command: string }): PublishInvocation {
  if (!isSafeCliValue(opts.command)) throw new Error(`wechat.command contains characters that cannot be passed to the CLI: ${JSON.stringify(opts.command)}`)
  if (opts.platform === 'win32') {
    const quote = (value: string): string => (value.includes(' ') ? `"${value}"` : value)
    return {
      file: process.env.ComSpec !== undefined && process.env.ComSpec.length > 0 ? process.env.ComSpec : 'cmd.exe',
      args: ['/d', '/s', '/c', `${quote(opts.command)} --version`],
      windowsVerbatimArguments: true,
    }
  }
  return { file: opts.command, args: ['--version'], windowsVerbatimArguments: false }
}

/** Keep the first `limit` characters (stdout of a long run must not grow forever). */
export function capOutput(text: string, limit: number = MAX_JOB_OUTPUT_CHARS): string {
  return text.length <= limit ? text : text.slice(0, limit)
}

/** The tail of a log, with the last `limit` characters (overlay display). */
export function tailOf(text: string, limit: number = JOB_LOG_TAIL_CHARS): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : trimmed.slice(trimmed.length - limit)
}

/**
 * Turn the adapter's exit into a user-facing verdict.
 *
 * `-f json` prints one JSON row (`[{status,title,detail}]`); a 0 exit is only
 * "ok" when we can say WHAT happened — everything else is reported as an error
 * carrying the last stderr line (the adapters write their real failure there).
 */
export function interpretPublishOutcome(input: { code: number | null; stdout: string; stderr: string }): { state: 'ok' | 'error'; message: string } {
  const row = readJsonRow(input.stdout)
  if (input.code === 0) {
    if (row !== undefined) {
      const status = typeof row.status === 'string' ? row.status : ''
      const detail = typeof row.detail === 'string' ? row.detail : ''
      const message = [status, detail].filter((s) => s.length > 0).join(' · ')
      return { state: 'ok', message: message.length > 0 ? message.slice(0, 500) : '命令已完成' }
    }
    return { state: 'ok', message: '命令已完成（未解析到结构化回执）' }
  }
  const lastErr = lastNonEmptyLine(input.stderr)
  const lastOut = lastNonEmptyLine(input.stdout)
  const detail = lastErr.length > 0 ? lastErr : lastOut
  return {
    state: 'error',
    message: (detail.length > 0 ? detail : `命令退出码 ${String(input.code)}`).slice(0, 500),
  }
}

/** Find the last parseable JSON row in the adapter's stdout. */
function readJsonRow(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim()
    if (!line.startsWith('[') && !line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line) as unknown
      const row = Array.isArray(parsed) ? parsed[0] : parsed
      if (typeof row === 'object' && row !== null) return row as Record<string, unknown>
    } catch { /* not the JSON line */ }
  }
  return undefined
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
  return lines.length > 0 ? lines[lines.length - 1]! : ''
}

export type WechatJobState = 'running' | 'ok' | 'error'

export interface WechatPublishJobView {
  id: string
  title: string
  adapter: WechatAdapter
  state: WechatJobState
  startedAt: number
  endedAt?: number
  exitCode?: number
  /** Short human verdict ("草稿已保存 · 正文 1234 字…" / the error line). */
  message: string
  /** Tail of stdout+stderr, for the overlay's log pane. */
  log: string
}

interface JobRecord {
  view: WechatPublishJobView
  stdout: string
  stderr: string
  child?: ChildProcess
  timer?: NodeJS.Timeout
}

export interface WechatPublishRunnerDeps {
  /** Resolve the CLI to run (config `wechat.command`, re-read per start). */
  command: () => string
  /** Default adapter when the caller does not pin one. */
  adapter?: () => WechatAdapter
  /** Where title files + per-job logs live. Defaults to DSH_HOME/dsh-tiddlywiki/wechat-publish. */
  jobDir?: string
  /** Injected for tests (defaults to node:child_process.spawn). */
  spawn?: typeof nodeSpawn
  platform?: NodeJS.Platform
  now?: () => number
  timeoutMs?: number
  log?: (message: string) => void
}

export type WechatPublishStartResult =
  | { ok: true; job: WechatPublishJobView }
  | { ok: false; busy: true; job: WechatPublishJobView }
  | { ok: false; busy: false; error: string }

/** The default job dir (also used by the route's readiness view). */
export function defaultWechatJobDir(): string {
  return dshHomePath('dsh-tiddlywiki', 'wechat-publish')
}

/**
 * Runs at most one publish at a time and remembers the recent history.
 *
 * The class owns the child process lifecycle, so it must be disposed with the
 * plugin (hot reload / shutdown): `dispose()` kills a running child instead of
 * leaving an orphan opencli/Chrome tab behind (the Windows-orphan lesson from
 * WikiServer applies here too).
 */
export class WechatPublishRunner {
  private readonly jobs = new Map<string, JobRecord>()

  constructor(private readonly deps: WechatPublishRunnerDeps) {}

  private get spawn(): typeof nodeSpawn {
    return this.deps.spawn ?? nodeSpawn
  }

  private get now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private running(): JobRecord | undefined {
    for (const job of this.jobs.values()) {
      if (job.view.state === 'running') return job
    }
    return undefined
  }

  /** The newest job of any state (the TW overlay polls with no id after a restart). */
  private newest(): JobRecord | undefined {
    let found: JobRecord | undefined
    for (const job of this.jobs.values()) found = job
    return found
  }

  status(id?: string): WechatPublishJobView | undefined {
    const record = id === undefined || id.length === 0 ? (this.running() ?? this.newest()) : this.jobs.get(id)
    return record === undefined ? undefined : snapshot(record.view)
  }

  /**
   * Start one publish. `title` is the tiddler title (written to a UTF-8 file —
   * never argv), `dsn` is the loopback DSH base the adapter calls back into.
   */
  start(request: { title: string; adapter?: WechatAdapter; dsn: string }): WechatPublishStartResult {
    const busy = this.running()
    if (busy !== undefined) return { ok: false, busy: true, job: snapshot(busy.view) }

    const title = request.title.trim()
    if (title.length === 0) return { ok: false, busy: false, error: 'title is required' }
    const adapter = request.adapter ?? this.deps.adapter?.() ?? DEFAULT_WECHAT_ADAPTER
    const command = this.deps.command()
    const jobDir = this.deps.jobDir ?? defaultWechatJobDir()
    const id = randomUUID().replace(/-/g, '').slice(0, 16)
    const titleFile = join(jobDir, `${id}.title`)
    const logFile = join(jobDir, `${id}.log`)

    let invocation: PublishInvocation
    try {
      invocation = buildPublishInvocation({
        platform: this.deps.platform ?? process.platform,
        command,
        adapter,
        titleFile,
        dsn: request.dsn,
      })
    } catch (err) {
      return { ok: false, busy: false, error: err instanceof Error ? err.message : String(err) }
    }

    try {
      mkdirSync(jobDir, { recursive: true })
      writeFileSync(titleFile, title, 'utf8')
    } catch (err) {
      return { ok: false, busy: false, error: `无法写入标题文件：${err instanceof Error ? err.message : String(err)}` }
    }

    const record: JobRecord = {
      view: { id, title, adapter, state: 'running', startedAt: this.now, message: '正在调用 opencli…', log: '' },
      stdout: '',
      stderr: '',
    }
    this.jobs.set(id, record)
    this.trimHistory()

    let child: ChildProcess
    try {
      child = this.spawn(invocation.file, invocation.args, {
        // The job dir is ours (just created) → a deterministic, writable cwd.
        cwd: jobDir,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      })
    } catch (err) {
      this.fail(record, `无法启动 ${command}：${err instanceof Error ? err.message : String(err)}`)
      return { ok: true, job: snapshot(record.view) }
    }
    record.child = child
    this.deps.log?.(`[dsh-tiddlywiki] wechat publish started: ${id} (${adapter})`)

    const append = (stream: 'stdout' | 'stderr', chunk: string): void => {
      record[stream] = capOutput(record[stream] + chunk)
      try {
        appendFileSync(logFile, chunk, 'utf8')
      } catch { /* log file is best-effort */ }
    }
    child.stdout?.on('data', (buf: Buffer) => append('stdout', buf.toString('utf8')))
    child.stderr?.on('data', (buf: Buffer) => append('stderr', buf.toString('utf8')))
    child.on('error', (err) => {
      this.fail(record, `无法启动 ${command}：${err.message}（是否已安装 opencli？）`)
    })
    child.on('close', (code) => {
      if (record.view.state !== 'running') return
      if (record.timer !== undefined) clearTimeout(record.timer)
      const verdict = interpretPublishOutcome({ code, stdout: record.stdout, stderr: record.stderr })
      record.view.state = verdict.state
      record.view.message = verdict.message
      record.view.exitCode = code ?? undefined
      record.view.endedAt = this.now
      record.view.log = tailOf(`${record.stdout}\n${record.stderr}`)
      this.deps.log?.(`[dsh-tiddlywiki] wechat publish ${verdict.state}: ${id} — ${verdict.message}`)
    })

    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS
    record.timer = setTimeout(() => {
      if (record.view.state !== 'running') return
      this.killTree(child)
      this.fail(record, `发布任务超时（${Math.round(timeoutMs / 60_000)} 分钟）：已终止 opencli`)
    }, timeoutMs)
    // Never hold the event loop open for a job timer (dsh web must be able to exit).
    record.timer.unref?.()

    return { ok: true, job: snapshot(record.view) }
  }

  /**
   * Kill the child AND its descendants.
   *
   * On Windows the direct child is `cmd.exe`, which in turn runs the
   * `opencli.cmd` shim and node — `child.kill()` would only reap cmd.exe and
   * leave the real work running (observed as a live process still holding the
   * job directory, i.e. `EBUSY` when the directory is removed). `taskkill /T`
   * is the only way to take the whole tree down; POSIX uses the plain kill
   * (opencli reaps its own children there).
   */
  private killTree(child: ChildProcess): void {
    const pid = child.pid
    if (pid !== undefined && (this.deps.platform ?? process.platform) === 'win32') {
      try {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
      } catch { /* taskkill unavailable: fall through to kill() */ }
    }
    try { child.kill() } catch { /* already gone */ }
  }

  /** Kill a running child + drop timers (plugin teardown / hot reload). */
  dispose(): void {
    for (const record of this.jobs.values()) {
      if (record.timer !== undefined) clearTimeout(record.timer)
      if (record.view.state === 'running' && record.child !== undefined) {
        this.killTree(record.child)
      }
    }
  }

  private fail(record: JobRecord, message: string): void {
    if (record.timer !== undefined) clearTimeout(record.timer)
    record.view.state = 'error'
    record.view.message = message
    record.view.endedAt = this.now
    record.view.log = tailOf(`${record.stdout}\n${record.stderr}`)
  }

  /** Keep the newest JOB_HISTORY_LIMIT records (Map preserves insertion order). */
  private trimHistory(): void {
    while (this.jobs.size > JOB_HISTORY_LIMIT) {
      const oldest = [...this.jobs.entries()].find(([, record]) => record.view.state !== 'running')
      if (oldest === undefined) return
      this.jobs.delete(oldest[0])
    }
  }
}

function snapshot(view: WechatPublishJobView): WechatPublishJobView {
  return { ...view }
}

export interface WechatReadyView {
  ok: boolean
  enabled: boolean
  command: string
  opencli: { ok: boolean; version: string }
  adapters: { dir: string; publishNote: boolean; publishNoteImgs: boolean; missing: string[] }
}

/** Where opencli keeps private adapters (`install-wechat-adapters.mjs` target). */
export function defaultAdaptersDir(home: string = homedir()): string {
  return join(home, '.opencli', 'clis', 'weixin')
}

/**
 * Which adapter files exist in `dir`. A missing/unreadable directory means
 * "nothing installed" — never a thrown error, because this feeds a readiness
 * report that must always answer.
 */
export function scanAdapterDir(
  dir: string,
  readDir: (path: string) => string[] = (path) => readdirSync(path),
): { publishNote: boolean; publishNoteImgs: boolean; missing: string[] } {
  let present: string[] = []
  try {
    present = readDir(dir)
  } catch {
    present = []
  }
  const has = (file: string): boolean => present.includes(file)
  const missing = [...new Set([...WECHAT_ADAPTER_FILES['publish-note'], ...WECHAT_ADAPTER_FILES['publish-note-imgs']])]
    .filter((file) => !has(file))
  return {
    publishNote: WECHAT_ADAPTER_FILES['publish-note'].every(has),
    publishNoteImgs: WECHAT_ADAPTER_FILES['publish-note-imgs'].every(has),
    missing,
  }
}

/** `opencli --version` with a timeout; never throws. */
export async function probeOpencli(opts: {
  command: string
  platform?: NodeJS.Platform
  spawn?: typeof nodeSpawn
  timeoutMs?: number
}): Promise<{ ok: boolean; version: string }> {
  let invocation: PublishInvocation
  try {
    invocation = buildVersionInvocation({ platform: opts.platform ?? process.platform, command: opts.command })
  } catch {
    return { ok: false, version: '' }
  }
  return await new Promise((resolve) => {
    const spawnFn = opts.spawn ?? nodeSpawn
    let done = false
    let out = ''
    let timer: NodeJS.Timeout | undefined
    const finish = (result: { ok: boolean; version: string }): void => {
      if (done) return
      done = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(result)
    }
    let child: ChildProcess
    try {
      child = spawnFn(invocation.file, invocation.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      })
    } catch {
      resolve({ ok: false, version: '' })
      return
    }
    timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish({ ok: false, version: '' })
    }, opts.timeoutMs ?? OPENCLI_PROBE_TIMEOUT_MS)
    timer.unref?.()
    child.stdout?.on('data', (buf: Buffer) => { out += buf.toString('utf8') })
    child.on('error', () => finish({ ok: false, version: '' }))
    child.on('close', (code) => {
      const version = out.trim().split(/\r?\n/)[0]?.trim() ?? ''
      finish({ ok: code === 0 && version.length > 0, version })
    })
  })
}

/**
 * Full readiness report for the TW button (and for the 503 body of a failed
 * start): is the CLI there, and are the adapter files installed?
 */
export async function checkWechatReady(opts: {
  enabled: boolean
  command: string
  adaptersDir?: string
  platform?: NodeJS.Platform
  spawn?: typeof nodeSpawn
  readDir?: (path: string) => string[]
  probeTimeoutMs?: number
}): Promise<WechatReadyView> {
  const dir = opts.adaptersDir ?? defaultAdaptersDir()
  const adapters = scanAdapterDir(dir, opts.readDir ?? ((p) => readdirSync(p)))
  const opencli = await probeOpencli({
    command: opts.command,
    ...(opts.platform === undefined ? {} : { platform: opts.platform }),
    ...(opts.spawn === undefined ? {} : { spawn: opts.spawn }),
    ...(opts.probeTimeoutMs === undefined ? {} : { timeoutMs: opts.probeTimeoutMs }),
  })
  return {
    ok: opts.enabled && opencli.ok && (adapters.publishNote || adapters.publishNoteImgs),
    enabled: opts.enabled,
    command: opts.command,
    opencli,
    adapters: {
      dir,
      publishNote: adapters.publishNote,
      publishNoteImgs: adapters.publishNoteImgs,
      missing: adapters.missing,
    },
  }
}

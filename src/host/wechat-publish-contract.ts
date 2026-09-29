/**
 * 公众号发布器的**契约层**（v0.30.29 从 wechat-publish.ts 拆出，**纯搬迁**）。
 *
 * 这里放「跑之前要商量清楚的东西」：适配器清单与各自的产物文件、DSN/Cli 值的合法性、
 * 配置形状与归一化、命令行调用怎么拼（含 --title-file 的落盘约定）、输出怎么判成败、
 * 以及任务视图的类型。**没有状态、没有子进程** —— 那些在 base 的 WechatPublishRunner 里。
 *
 * 两个符号**故意留在 base**：WECHAT_TITLE_FILE_ARG 与 WECHAT_ADAPTER_MARKER。
 * verify-wechat-publish.mjs 按**精确文件**读 wechat-publish.ts，并断言那两条**赋值语句**
 * 的字面量（它们是「入口版本哨兵」：真入口声明的参数名/函数名必须与之对齐）。它们只被
 * base 里的 WECHAT_FRESHNESS_MATCHERS 用到，所以留得住、也不与这里构成环。
 *
 * 依赖方向只有一条：**base → 本文件**（本文件不 import base）。
 *
 * @module dsh-tiddlywiki/host/wechat-publish-contract
 */
import { dshHomePath } from '../sdk.ts'
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'


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

/** The shared flow module every adapter imports (`resolveNoteTitle` lives here). */
export const WECHAT_FLOW_FILE = 'weixin-flow.js'

/** Captured output per stream; the job view only exposes the tail. */
export const MAX_JOB_OUTPUT_CHARS = 64_000
/** How much of the log the TW overlay shows (keeps the JSON response small). */
export const JOB_LOG_TAIL_CHARS = 4_000
/** Hard cap for one publish run (multi-image + scan waits stay well below). */
export const DEFAULT_JOB_TIMEOUT_MS = 15 * 60_000
/** How long `opencli --version` may take before we call it missing. */
export const OPENCLI_PROBE_TIMEOUT_MS = 10_000
/** How many finished jobs to remember for post-mortem lookups. */
export const JOB_HISTORY_LIMIT = 20

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

/**
 * Cap captured output, keeping the TAIL (v0.29.0).
 *
 * It used to keep the first `limit` characters, which broke the verdict:
 * `interpretPublishOutcome()` looks for the adapter's `-f json` row at the END
 * of stdout (that is where a CLI prints its result), so a run whose output
 * exceeded the cap lost the row and was reported as
 * 「命令已完成（未解析到结构化回执）」 — an ok verdict for what may have been a
 * failure. Same for stderr, where the LAST line is the real error
 * (`lastNonEmptyLine` reads it). The tail is the informative end of a log.
 */
export function capOutput(text: string, limit: number = MAX_JOB_OUTPUT_CHARS): string {
  return text.length <= limit ? text : text.slice(text.length - limit)
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

export interface JobRecord {
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

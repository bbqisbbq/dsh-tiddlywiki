/**
 * The syncer-drain primitives: "wait for a file to land", "flush the queue
 * before restarting TW", and the ONLY sanctioned stop/restart wrapper
 * (v0.30.1: split out of `seeds.ts`, which is otherwise about seed CONTENT).
 *
 * WHY THEY LIVE TOGETHER: ironclad rule #1 is that nothing may stop or restart
 * the TW child without draining the syncer queue first, and the drain itself is
 * a two-phase sentinel dance (`flushPendingWrites`) plus a throttle window.
 * Keeping all of it in one module means the rule and its implementation cannot
 * drift apart — and `scripts/verify-restart-drain.mjs` reads the FAMILY text
 * (`seeds.ts` + `seeds-*.ts`), so this move is invisible to that guard.
 *
 * @module dsh-tiddlywiki/host/seeds-flush
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TiddlyWebClient } from './tw-api.ts'
/**
 * Wait until a file exists on disk (polling), up to `timeoutMs`.
 *
 * TW's syncer flushes REST writes to the filesystem on a ~250ms task timer, so
 * a freshly seeded tiddler is not on disk the moment PUT resolves. A caller
 * that must restart TW right after (so a seeded SERVER-route plugin loads) has
 * to wait for the flush first — otherwise the restarted TW boots from a stale
 * snapshot, loses every in-memory write that had not been flushed yet, and the
 * seeded route is missing.
 *
 * `newerThanMs` makes the wait meaningful when the file ALREADY exists: it must
 * also have been (re)written after that timestamp, which is what a re-seed
 * produces. Without it an existing file would satisfy the wait immediately and
 * the caller would restart TW over in-flight writes (the v0.18.0 regression the
 * seeds-admin verify test caught).
 */
export async function waitForFileWrite(filePath: string, timeoutMs = 8_000, pollMs = 150, newerThanMs?: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (existsSync(filePath)) {
        if (newerThanMs === undefined) return true
        if (statSync(filePath).mtimeMs >= newerThanMs) return true
      }
    } catch { /* transient */ }
    if (Date.now() >= deadline) return false
    await new Promise<void>((r) => setTimeout(r, pollMs))
  }
}

/** The only seed that carries a TW SERVER route — it needs a TW restart to load. */
export const RESTART_REQUIRED_SEED_IDS = ['render-route'] as const

/**
 * Flush sentinel. TW's REST layer answers 204 as soon as the tiddler is in the
 * in-memory store; the filesystem syncer writes it on a ~250ms timer. A restart
 * in that window boots from the OLD snapshot and silently loses every write
 * still queued — the v0.18.0 review caught it for the render plugin file, but
 * any write could be lost (force-all repeatedly lost `tw-web-host`).
 *
 * A sentinel alone is NOT enough (v0.22.0). TW's syncer defers a title whose
 * last save is younger than `throttleInterval` (`$:/config/SyncThrottleInterval`,
 * default 1s): `chooseNextTask()` picks the first title that `hasChanged` AND is
 * ready, and SKIPS throttled ones — so the sentinel (a different, never-saved
 * title) can land while another dirty title is still deferred. v0.19.0's
 * "probe landed ⇒ queue drained" assumption is therefore false, and the extra
 * marker writes of v0.22.0 were enough to make `tw-web-host` the deferred title
 * every time. See `flushPendingWrites()` for the two-phase fix.
 */
export const FLUSH_PROBE_TITLE = '$:/plugins/dsh-tiddlywiki/flush-probe'
/**
 * 哨兵 tiddler 落盘后的**文件名片段**（用 `includes` 匹配，不写死扩展名）。
 *
 * 为什么不写死 `.tid`：TW 的文件系统适配器按内容类型决定扩展名——`text/plain`
 * 写成 `.txt` + `.txt.meta`，`application/json` 写成 `.json`，只有
 * `text/vnd.tiddlywiki` 才是 `.tid`。v0.19.0 的实现传了 `type: 'text/plain'`
 * 却去等 `.tid`，于是**永远等不到**，而所有调用方都只把返回值当 warning ——
 * 「排干 syncer」其实一直没生效（v0.19.1 的 selftest 断言把它抓了出来）。
 * 现在哨兵用默认 wikitext（落 `.tid`），判定再按「文件名含本片段 + 内容含本次
 * 随机戳」来做，扩展名怎么变都不会静默失效。
 */
export const FLUSH_PROBE_FILE_HINT = 'dsh-tiddlywiki_flush-probe'

/** TW default `$:/config/SyncThrottleInterval` (ms) when the tiddler is absent. */
const DEFAULT_SYNC_THROTTLE_MS = 1_000

/** Read TW's sync throttle interval (ms), clamped; a read failure → the default. */
async function readSyncThrottleMs(client: TiddlyWebClient): Promise<number> {
  try {
    const raw = (await client.get('$:/config/SyncThrottleInterval'))?.text?.trim()
    const parsed = raw === undefined || raw.length === 0 ? Number.NaN : Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SYNC_THROTTLE_MS
    return Math.min(parsed, 10_000)
  } catch {
    return DEFAULT_SYNC_THROTTLE_MS
  }
}

/**
 * Flush the syncer queue before a restart.
 *
 * Returns true only when the store is provably QUIESCENT. Two phases, because a
 * single probe can overtake a throttled title (see the doc block above):
 *
 *   1. write probe A and wait for A on disk — this drains everything the syncer
 *      is willing to write now;
 *   2. wait out one throttle window (no writes of ours in between), then write
 *      probe B and wait for IT. Any title still dirty after phase 1 becomes
 *      ready inside that window and is written, so only the probe remains.
 *
 * Returns false on timeout / a failed probe PUT; callers treat that as a warning
 * (the operation still proceeds — this is best-effort hardening, not a gate).
 */
export async function flushPendingWrites(client: TiddlyWebClient, tiddlersDir: string, timeoutMs = 12_000): Promise<boolean> {
  // ⚠️ 判定不能靠 mtime（v0.19.1 教训之二）：哨兵是在等待**紧接**它之前写的，
  // Windows 上新文件的 mtime 可能落在 `Date.now()` 同一/前一个时钟刻，
  // `mtime >= startedAt` 于是永远不成立、轮询到超时返回 false。改成写一段唯一
  // 内容、轮询文件里是否出现它：内容一致才算真的落盘，与时钟精度无关。
  const deadline = Date.now() + timeoutMs
  const probeAndWait = async (phase: string): Promise<boolean> => {
    const stamp = `flush ${phase} ${Date.now()} ${Math.random().toString(36).slice(2)}`
    try {
      // 不传 type → TW 按默认 wikitext 存成 .tid。
      await client.put({ title: FLUSH_PROBE_TITLE, text: stamp })
    } catch {
      return false
    }
    for (;;) {
      try {
        for (const name of readdirSync(tiddlersDir)) {
          if (!name.includes(FLUSH_PROBE_FILE_HINT)) continue
          try {
            if (readFileSync(join(tiddlersDir, name), 'utf8').includes(stamp)) return true
          } catch { /* transient read failure */ }
        }
      } catch { /* tiddlers dir not readable yet */ }
      if (Date.now() >= deadline) return false
      await new Promise<void>((r) => setTimeout(r, 150))
    }
  }
  if (!(await probeAndWait('a'))) return false
  // Phase 2: let every throttled title become ready and be written. The probe
  // itself was just saved, so it is throttled too — which is exactly why the
  // second send must wait out the window (otherwise probe B could land while
  // probe A's contemporaries are still deferred).
  const waitMs = Math.min((await readSyncThrottleMs(client)) + 400, 4_000)
  await new Promise<void>((r) => setTimeout(r, waitMs))
  return probeAndWait('b')
}

/** Did one of the RESTART_REQUIRED seeds actually write something? */
export function needsRestartAfterSeeds(results: Array<{ id: string; ok: boolean; wrote: boolean }>): boolean {
  return results.some((r) => r.ok && r.wrote && (RESTART_REQUIRED_SEED_IDS as readonly string[]).includes(r.id))
}

/**
 * THE ONLY SANCTIONED WAY TO STOP OR RESTART THE TW CHILD (v0.24.1).
 *
 * WHY THIS WRAPPER EXISTS
 * -----------------------
 * Ironclad rule #1 ("drain the syncer queue before restarting TW") had four
 * call sites and only three of them obeyed it. The two manual restart routes
 * (`POST /restart`, `POST /admin/restart`), the plugins/themes restart in
 * `POST /admin/info` and the knowledge-base switch (`stopServer`) all killed the
 * child with writes still queued — and a queued write is simply lost, silently,
 * exactly like the v0.19.0 `tw-web-host` loss. A rule that lives only in prose
 * gets re-broken by the next person who adds a restart.
 *
 * So the drain is now INSIDE the primitive: a caller cannot stop TW without
 * going through it, and `scripts/verify-restart-drain.mjs` asserts that no
 * `server.restart()` / `server.stop()` call site exists outside this wrapper.
 *
 * Best-effort by design: a failed drain logs and still stops (refusing to
 * restart would leave the user unable to recover from a wedged TW). Returns
 * whether the store was provably quiescent — callers surface it in their
 * response so an incomplete drain is observable rather than silent.
 */
export async function drainThenStop(options: {
  /** The REST client for the RUNNING child, or undefined when it is down. */
  client: TiddlyWebClient | undefined
  /** Absolute path of `<wiki>/tiddlers`. */
  tiddlersDir: string
  /**
   * The actual stop/restart to run after the drain. `unknown` because
   * `WikiServer.restart()` resolves a status view while `stop()` resolves void —
   * the drain does not care about either.
   */
  stop: () => Promise<unknown>
  /** Warning sink (defaults to silence so the helper stays dependency-free). */
  log?: (message: string) => void
}): Promise<boolean> {
  // No client ⇒ the child is not running ⇒ nothing is queued to lose.
  const drained = options.client === undefined
    ? true
    : await flushPendingWrites(options.client, options.tiddlersDir).catch(() => false)
  if (!drained) {
    options.log?.('syncer queue may not be fully drained — writes still queued at restart time could be lost')
  }
  await options.stop()
  return drained
}

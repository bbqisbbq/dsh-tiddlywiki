/**
 * Runtime wiki switching (v0.22.0).
 *
 * Rebinding the plugin from wiki A to wiki B is a *stateful* operation: the TW
 * child, the auto-committer, the fs watcher and the config-tiddler overlay all
 * hold the old folder. Doing it half-way leaves the process describing two
 * different wikis, so the sequence below is deliberately boring:
 *
 *   stop child → release extras → repoint → start child → reload config
 *   → core-bootstrap the new wiki → re-arm extras → persist the pointer
 *
 * The pointer is written LAST: if any earlier step fails we roll the server
 * back to the old folder and the on-disk pointer still names the working wiki,
 * so a dsh web restart can never land on a half-initialised target.
 *
 * The orchestration is separated from src/index.ts so it can be driven by a
 * real test (scripts/verify-wiki-switch.mjs) with a real WikiServer and two
 * temp folders — the rollback path is the part that must not rot.
 *
 * @module dsh-tiddlywiki/host/wiki-switch
 */
import { locationPath, normalizeLocation, type WikiLocation } from './wiki-location.ts'

/** Everything the switch needs from the plugin host, as plain callbacks. */
export interface WikiSwitchDeps {
  /** Location currently served (undefined when the plugin is on the default). */
  currentLocation: () => WikiLocation | undefined
  /** Absolute path currently served. */
  currentPath: () => string
  /** Stop the TW child. */
  stopServer: () => Promise<void>
  /** Apply a location to the (stopped) server; throws when a child is running. */
  applyLocation: (target: WikiLocation) => void
  /** Start the TW child; throws when it never becomes ready. */
  startServer: () => Promise<void>
  /** Stop the auto-committer + fs watcher (they hold the old folder). */
  teardownExtras: () => Promise<void>
  /** Re-create the auto-committer + fs watcher for the CURRENT folder. */
  setupExtras: () => void
  /** Re-read the config tiddler overlay from the new wiki. */
  reloadConfig: () => Promise<void>
  /** Startup-equivalent bootstrap of a wiki (markdown plugin, core seeds, language). */
  bootstrap: () => Promise<void>
  /** Persist the pointer file (failure is reported, not rolled back). */
  savePointer: (target: WikiLocation) => Promise<void>
  /** Log a rollback / non-fatal problem. */
  log?: (message: string) => void
}

/** Successful switch. */
export interface WikiSwitchOk {
  ok: true
  location: WikiLocation
  path: string
  /** Set when the wiki switched but the pointer could not be persisted. */
  warning?: string
}

/** Failed switch (the old wiki keeps serving when `rolledBack` is true). */
export interface WikiSwitchFail {
  ok: false
  error: string
  rolledBack: boolean
}

export type WikiSwitchResult = WikiSwitchOk | WikiSwitchFail

/**
 * Switch to `input` (root + folder name, same shape as the cordis config).
 * Never throws: failures are returned, and the previous wiki is restored.
 */
export async function switchWiki(
  deps: WikiSwitchDeps,
  input: { root?: unknown; name?: unknown },
): Promise<WikiSwitchResult> {
  const normalized = normalizeLocation(input)
  if (normalized.location === undefined) return { ok: false, error: normalized.error ?? '位置非法', rolledBack: true }
  const target = normalized.location
  const targetPath = locationPath(target)
  const previous = deps.currentLocation()
  const previousPath = deps.currentPath()
  if (targetPath === previousPath) {
    return { ok: true, location: target, path: targetPath }
  }

  const restore = async (): Promise<boolean> => {
    try {
      await deps.stopServer()
      deps.applyLocation(previous ?? { root: previousPath, name: '.' })
      await deps.startServer()
      await deps.reloadConfig()
      deps.setupExtras()
      deps.log?.(`wiki switch rolled back to ${previousPath}`)
      return true
    } catch (err) {
      deps.log?.(`wiki switch rollback FAILED: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  try {
    await deps.stopServer()
    await deps.teardownExtras()
    deps.applyLocation(target)
    await deps.startServer()
    await deps.reloadConfig()
    await deps.bootstrap()
    deps.setupExtras()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const rolledBack = await restore()
    return { ok: false, error: message, rolledBack }
  }

  // The wiki is live: persist the pointer. A failure here is NOT rolled back —
  // the running wiki is the one the user asked for; only the restart-survival
  // is lost, and saying so is more useful than reverting a working switch.
  try {
    await deps.savePointer(target)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    deps.log?.(`wiki switch: pointer write failed: ${message}`)
    return { ok: true, location: target, path: targetPath, warning: `位置已切换，但指针文件写入失败（重启 dsh web 后会回到原知识库）：${message}` }
  }
  return { ok: true, location: target, path: targetPath }
}

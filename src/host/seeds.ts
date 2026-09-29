/**
 * Unified seed registry (design: every one-time "与 dsh 联动需要 wiki 预置"
 * item is a SeedDef here).
 *
 * Three tiers (v0.16.22):
 *   - CORE seeds (`core: true`) are functionally required by the plugin's
 *     own features — the startup path seeds exactly these (non-force) and
 *     they can never be 反初始化'd.
 *   - STARTER seeds (`startup: true`, removable) are docs / examples that
 *     give a fresh wiki a working「文档中心」out of the box — the startup path
 *     ALSO seeds them on first install (safe-skip: same-named tiddlers are
 *     never overwritten), and the user can 反初始化 them anytime.
 *   - OPTIONAL seeds (`core: false`, `startup: false`) are nice-to-have
 *     content (首页 / 所有文章 / 自定义样式 / menubar 顶栏主题自适应 / 剪藏桥
 *     说明文档) — they are NEVER auto-seeded; the user opts in from the
 *     settings page「初始化」section (重新初始化) and can opt out again with
 *     反初始化 (remove).
 *
 * Each seed owns:
 *   - `check` — current state (present / missing / needs-update) for the UI;
 *   - `run(force)` — non-force keeps the ONE-SHOT / user-owned semantics
 *     (write only when missing, never overwrite), force (re)writes the
 *     built-in content and (re)records the marker;
 *   - `remove` — optional + starter seeds only: delete the seeded tiddlers +
 *     markers, returning the wiki to the "never seeded" state.
 *
 * Registry: doc-note / starter-docs / send-to-agent / render-route /
 * home-index / all-articles / ui-styles / menubar-theme / clip-bridge /
 * publish-spec / wechat-setup / wechat-publish / tw-web-host.
 *
 * @module dsh-tiddlywiki/host/seeds
 */
import type { TiddlyWebClient } from './tw-api.ts'
import type { PromptToolSummary } from './prompt.ts'

/** One seed's status as reported to the settings page. */
export interface SeedStatus {
  id: string
  title: string
  description: string
  /** true = target tiddler(s) present (or host value correct). */
  present: boolean
  /**
   * true = the seed can be 反初始化 (removed). Core seeds that the plugin's
   * own features depend on are never removable from the settings page.
   */
  removable: boolean
  /** Human detail, e.g. which tiddlers are missing. */
  detail?: string
  /**
   * true = the BUILT-IN content moved on since this wiki was seeded, so
   * 「重新初始化」would bring something new (v0.22.0 content hashes). Only set
   * for seeds that declare `content`.
   */
  updateAvailable?: boolean
  /**
   * true = the stored tiddler no longer matches what we wrote (a human edited
   * it); `undefined` = cannot tell (marker written before hashes existed);
   * `false` = untouched. The settings page warns before overwriting.
   */
  userModified?: boolean
  /** true = the marker tiddler predates v0.22.0 (no hashes recorded yet). */
  legacyMarker?: boolean
}

/** Result of running one seed. */
export interface SeedRunResult {
  id: string
  ok: boolean
  /** true = something was written this call. */
  wrote: boolean
  detail?: string
  error?: string
}

/** Context a seed needs (client to the live TW server). */
export interface SeedContext {
  client: TiddlyWebClient
  /**
   * Live tool registry summary, so generated seed content (the doc note's tool
   * list) can never go stale (v0.22.0). Absent in headless callers — generated
   * content then degrades to a pointer instead of an outdated list.
   */
  tools?: readonly PromptToolSummary[]
  /**
   * Whether the OPT-IN WeChat publishing feature is enabled (config
   * `wechat.enabled`, default false, v0.23.0). Gates the「发布元数据规范」seed:
   * users who never enabled the feature must not get that doc written into
   * their wiki. Absent (headless callers) = false.
   */
  wechat?: boolean
  /**
   * The same-origin proxy base THIS wiki's TW frontend must use (v0.28.0):
   * `/dsh-tiddlywiki/tw/` (the legacy bare path, single-wiki default) or
   * `/dsh-tiddlywiki/tw/<id>/` (one knowledge base among several).
   *
   * It MUST be per wiki: TW builds every API URL from this tiddler, so a wiki
   * whose value points at the legacy path while another wiki is the default
   * would render one wiki's UI while reading and writing another's data.
   *
   * Absent (headless callers / older hosts) = the legacy path.
   */
  proxyBase?: string
}



// The drain primitives moved to `seeds-flush.ts` (v0.30.1) — they are about
// TW's syncer, not about seed content. Re-exported here because every caller
// (routes / admin / index / tools-git) imports them from THIS module, and the
// restart-drain guard reads the whole family, not this one file.
export {
  FLUSH_PROBE_FILE_HINT,
  FLUSH_PROBE_TITLE,
  RESTART_REQUIRED_SEED_IDS,
  drainThenStop,
  flushPendingWrites,
  needsRestartAfterSeeds,
  waitForFileWrite,
} from './seeds-flush.ts'


/** A registered seed: check current state + run (optionally force) + remove. */
export interface SeedDef {
  id: string
  title: string
  description: string
  /**
   * Core seeds are seeded automatically on startup (功能必需) and can never
   * be 反初始化'd — removing them would break a plugin feature.
   */
  core: boolean
  /**
   * STARTER tier (v0.16.22): docs / examples that the startup path ALSO seeds
   * on first install (safe-skip: same-named tiddlers never overwritten), but
   * which stay removable via「反初始化」. Meaningful only when `core` is false.
   */
  startup?: boolean
  /**
   * Optional gate for the STARTUP path only (v0.23.0). When present and it
   * returns false, `runAllSeeds` skips this seed entirely — used by seeds that
   * belong to an OPT-IN feature (微信公众号发布, config `wechat.enabled`,
   * default off). A manual run ("初始化"/"重新初始化" from the settings page)
   * ignores the gate: that is an explicit request.
   */
  gate?: (ctx: SeedContext) => boolean
  /**
   * One-shot marker tiddler (v0.22.0): its `hashes` record what the built-in
   * content looked like when this wiki was seeded, which is what lets the
   * settings page tell 「内置内容有更新」 from 「用户自己改过」.
   */
  markerTitle?: string
  /**
   * The tiddlers this seed writes, in a stable order (title → text). Declaring
   * it opts the seed into update detection + marker hashes; the seed modules
   * export the very constants their writers use, so the two cannot drift.
   */
  content?: (ctx: SeedContext) => Promise<Array<{ title: string; text: string }>>
  check(ctx: SeedContext): Promise<SeedStatus>
  run(ctx: SeedContext, force: boolean): Promise<SeedRunResult>
  /** Non-core seeds only: delete the seeded tiddlers + markers (反初始化). */
  remove?(ctx: SeedContext): Promise<SeedRunResult>
}

/**
 * Presence probe for a seed's `check`. A 404 means "missing"; every other
 * failure PROPAGATES (the caller `checkAllSeeds` turns it into a failed check)
 * — swallowing it here would report "缺失" for a service that is merely
 * unavailable and invite an overwrite.
 */
import { SEED_DEFS } from './seeds-registry.ts'
// 公共面原样再导出：src/index.ts 与设置页都从 seeds.ts 取这两样（拆分时保持导入路径不变）。
export { SEED_DEFS } from './seeds-registry.ts'
export { isOurProxyBase } from './seeds-registry.ts'


/** Check every seed, returning statuses in registry order. */
export async function checkAllSeeds(ctx: SeedContext): Promise<SeedStatus[]> {
  const out: SeedStatus[] = []
  for (const def of SEED_DEFS) {
    try {
      out.push(await def.check(ctx))
    } catch (err) {
      out.push({
        id: def.id,
        title: def.title,
        description: def.description,
        present: false,
        removable: !def.core,
        detail: `检查失败：${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }
  return out
}

/**
 * Run one seed (or all, when id is undefined). Non-force = one-shot semantics;
 * force = manual "重新初始化" from the settings page. A manual run with no id
 * (重新初始化 all) covers every registry item, core and optional alike.
 */
export async function runSeedById(ctx: SeedContext, id: string | undefined, force: boolean): Promise<SeedRunResult[]> {
  const targets = id === undefined ? SEED_DEFS : SEED_DEFS.filter((d) => d.id === id)
  if (targets.length === 0) {
    return [{ id: id ?? '', ok: false, wrote: false, error: `unknown seed: ${id}` }]
  }
  const out: SeedRunResult[] = []
  for (const def of targets) {
    out.push(await def.run(ctx, force))
  }
  return out
}

/**
 * Startup path: seed the CORE items (功能必需：发送给 Agent 按钮 + 原生渲染
 * 路由 + TW 前端 API 基址) AND the STARTER items (首次安装默认：插件说明 +
 * 示例与文档), all non-force (write only what is missing — a same-named
 * tiddler already present is NEVER overwritten, so user data stays user data).
 * Remaining optional seeds (首页 / 所有文章 / 自定义样式 / menubar 顶栏主题自
 * 适应) are never forced on users — they opt in from the settings page
 * 「初始化」section.
 */
export async function runAllSeeds(ctx: SeedContext): Promise<SeedRunResult[]> {
  const out: SeedRunResult[] = []
  for (const def of SEED_DEFS) {
    if (!def.core && def.startup !== true) continue
    // Opt-in features (v0.23.0): a `gate` that returns false means "this seed
    // belongs to a feature the user has NOT enabled" → skip silently. The
    // settings page's manual 初始化 ignores gates (an explicit request wins).
    if (def.gate !== undefined && !def.gate(ctx)) continue
    out.push(await def.run(ctx, false))
  }
  return out
}

/**
 * 反初始化 (remove): delete one non-core seed's (starter 或 optional) seeded
 * tiddlers + markers, or all non-core seeds when `id` is undefined. Core
 * seeds are functionally required and cannot be removed — a direct request
 * for one returns an error result (and is skipped when removing all).
 */
export async function removeSeedById(ctx: SeedContext, id: string | undefined): Promise<SeedRunResult[]> {
  if (id === undefined) {
    const out: SeedRunResult[] = []
    for (const def of SEED_DEFS) {
      if (def.core || def.remove === undefined) continue
      out.push(await def.remove(ctx))
    }
    return out
  }
  const def = SEED_DEFS.find((d) => d.id === id)
  if (def === undefined) {
    return [{ id, ok: false, wrote: false, error: `unknown seed: ${id}` }]
  }
  if (def.core) {
    return [{ id, ok: false, wrote: false, error: '该 seed 为核心项（功能必需），不可反初始化' }]
  }
  if (def.remove === undefined) {
    return [{ id, ok: false, wrote: false, error: '该 seed 不支持移除' }]
  }
  return [await def.remove(ctx)]
}

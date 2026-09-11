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
 * tw-web-host.
 *
 * @module dsh-tiddlywiki/host/seeds
 */
import type { TiddlyWebClient } from './tw-api.ts'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { seedDocNote, unseedDocNote, DOC_NOTE_TITLE } from './seed-notes.ts'
import { seedStarterDocs, unseedStarterDocs, STARTER_DOCS_ITEMS, STARTER_DOCS_MARKER_TITLE } from './seed-starter-docs.ts'
import { seedSendToAgent, SEND_TO_AGENT_PLUGIN_TITLE } from './seed-send-to-agent.ts'
import { seedHomeIndex, unseedHomeIndex, HOME_INDEX_ITEMS } from './seed-home.ts'
import { seedAllArticles, unseedAllArticles, ALL_ARTICLES_TITLE } from './seed-all-articles.ts'
import { seedUiStyles, unseedUiStyles, UI_STYLE_ITEMS } from './seed-ui-styles.ts'
import { seedMenubarTheme, unseedMenubarTheme, MENUBAR_THEME_TIDDLER } from './seed-menubar-theme.ts'
import { seedClipBridge, unseedClipBridge, CLIP_BRIDGE_DOC_TITLE } from './seed-clip-bridge.ts'
import { seedRenderRoute, RENDER_PLUGIN_TITLE } from './seed-render.ts'
import { TW_WEB_HOST_TIDDLER, TW_WEB_HOST_DEFAULT } from './config.ts'
import { TW_PROXY_PATH } from './wiki.ts'

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
}

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
 * Flush sentinel (v0.19.0). TW's REST layer answers 204 as soon as the tiddler
 * is in the in-memory store; the filesystem syncer writes it on a ~250ms timer.
 * A restart in that window boots from the OLD snapshot and silently loses every
 * write still queued — the v0.18.0 review caught it for the render plugin file,
 * but any seed write could be lost (force-all repeatedly lost `tw-web-host`
 * when the disk was busy). Writing this sentinel LAST and waiting for its file
 * proves the queue has drained, because the syncer drains its save tasks in
 * order.
 */
export const FLUSH_PROBE_TITLE = '$:/plugins/dsh-tiddlywiki/flush-probe'
export const FLUSH_PROBE_FILE = '$__plugins_dsh_tiddlywiki_flush-probe.tid'

/** Write the flush sentinel and wait for its file; true when the queue drained. */
export async function flushPendingWrites(client: TiddlyWebClient, tiddlersDir: string, timeoutMs = 8_000): Promise<boolean> {
  const startedAt = Date.now()
  try {
    await client.put({ title: FLUSH_PROBE_TITLE, text: new Date().toISOString(), type: 'text/plain', tags: [] })
  } catch {
    return false
  }
  return waitForFileWrite(join(tiddlersDir, FLUSH_PROBE_FILE), timeoutMs, 150, startedAt)
}

/** Did one of the RESTART_REQUIRED seeds actually write something? */
export function needsRestartAfterSeeds(results: Array<{ id: string; ok: boolean; wrote: boolean }>): boolean {
  return results.some((r) => r.ok && r.wrote && (RESTART_REQUIRED_SEED_IDS as readonly string[]).includes(r.id))
}

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
const presentOf = (ctx: SeedContext, title: string): Promise<boolean> =>
  ctx.client.get(title).then((t) => t !== undefined)

/** Build the per-item detail from an unseed result. */
const removedDetail = (id: string, removed: string[]): SeedRunResult => ({
  id,
  ok: true,
  wrote: false,
  detail: removed.length > 0
    ? `已移除：${removed.join('、')}`
    : '本就不存在，无需移除',
})

/** Metadata shared by every seed and echoed in its status/result objects. */
interface SeedMeta {
  id: string
  title: string
  description: string
  core: boolean
  /** STARTER tier: also auto-seeded on first install (removable). */
  startup?: boolean
}

type SeedWriter = (client: TiddlyWebClient, opts?: { force?: boolean }) => Promise<boolean>
type SeedUnseeder = (client: TiddlyWebClient) => Promise<{ removed: string[] }>

/**
 * Define a seed from a small spec, killing the id/title/description
 * triplication and the try/catch boilerplate every registry entry used to
 * repeat by hand:
 *   - `presentTitle` → default check: is that tiddler present?
 *   - `check`        → custom presence check (overrides presentTitle).
 *   - `write`        → built-in content writer; true = (re)written this call.
 *   - `run`          → custom runner (overrides the standard write wrapper;
 *                      e.g. tw-web-host honors a user-chosen host value).
 *   - `unseed`       → remove the seeded tiddlers + markers (removable seeds).
 */
function defineSeed(meta: SeedMeta, impl: {
  presentTitle?: string
  check?: (ctx: SeedContext) => Promise<SeedStatus>
  write?: SeedWriter
  run?: (ctx: SeedContext, force: boolean) => Promise<SeedRunResult>
  unseed?: SeedUnseeder
}): SeedDef {
  const { id, title, description, core, startup } = meta
  const removable = !core
  if (impl.check === undefined && (impl.presentTitle === undefined || impl.presentTitle.length === 0)) {
    // Fail fast at module load: a seed without a presence probe would query an
    // EMPTY title, always report "missing", and be re-run on every boot.
    throw new Error(`seed "${id}" needs either presentTitle or check`)
  }
  if (impl.run === undefined && impl.write === undefined) {
    throw new Error(`seed "${id}" needs either write or run`)
  }
  const check: SeedDef['check'] = impl.check ?? (async (ctx) => {
    const present = await presentOf(ctx, impl.presentTitle ?? '')
    return { id, title, description, present, removable, detail: present ? '已存在' : '缺失' }
  })
  const run: SeedDef['run'] = impl.run ?? (async (ctx, force) => {
    try {
      const wrote = await impl.write!(ctx.client, { force })
      return { id, ok: true, wrote, detail: wrote ? (force ? '已重新初始化' : '已写入') : (force ? '内容已是最新（未重写）' : '已存在，跳过') }
    } catch (err) {
      return { id, ok: false, wrote: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  const remove: SeedDef['remove'] = impl.unseed === undefined ? undefined : async (ctx) => {
    try {
      return removedDetail(id, (await impl.unseed!(ctx.client)).removed)
    } catch (err) {
      return { id, ok: false, wrote: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  return { id, title, description, core, ...(startup === undefined ? {} : { startup }), check, run, ...(remove === undefined ? {} : { remove }) }
}

/** The full registry, in display order. */
export const SEED_DEFS: SeedDef[] = [
  defineSeed(
    { id: 'doc-note', title: '插件说明笔记', description: '「dsh-tiddlywiki 插件说明」——入门说明笔记（首次安装默认写入；ONE-SHOT，用户可改可删，标记 dsh-docs 自动进首页「📚 插件文档」栏）。', core: false, startup: true },
    { presentTitle: DOC_NOTE_TITLE, write: seedDocNote, unseed: unseedDocNote },
  ),
  defineSeed(
    { id: 'starter-docs', title: '示例与文档（汇总模板 / 教程 / 主题页示例）', description: '新手文档中心起步包：主题汇总页·模板、教程（按主题/标签做汇总页）、三个可直接运行的示例主题页（日志 / 决策记录 / 排障）。全部打 dsh-docs 标签，自动出现在首页「📚 插件文档」栏；纯示例无个人数据，同名 tiddler 已存在则安全跳过，不会覆盖。首次安装默认写入，可反初始化。', core: false, startup: true },
    {
      check: async (ctx) => {
        const missing: string[] = []
        for (const item of STARTER_DOCS_ITEMS) {
          if (!(await presentOf(ctx, item.title))) missing.push(item.title)
        }
        return { id: 'starter-docs', title: '示例与文档（汇总模板 / 教程 / 主题页示例）', description: '新手文档中心起步包：主题汇总页·模板、教程（按主题/标签做汇总页）、三个可直接运行的示例主题页（日志 / 决策记录 / 排障）。全部打 dsh-docs 标签，自动出现在首页「📚 插件文档」栏；纯示例无个人数据，同名 tiddler 已存在则安全跳过，不会覆盖。首次安装默认写入，可反初始化。', present: missing.length === 0, removable: true, detail: missing.length === 0 ? '已存在' : `缺失：${missing.join('、')}` }
      },
      write: seedStarterDocs,
      unseed: unseedStarterDocs,
    },
  ),
  defineSeed(
    { id: 'send-to-agent', title: '「发送给 Agent」按钮', description: 'TW 笔记工具栏「发送给 Agent」按钮插件（$:/plugins/dsh/send-to-agent）——把笔记一键注入 DSH 会话。', core: true },
    { presentTitle: SEND_TO_AGENT_PLUGIN_TITLE, write: seedSendToAgent },
  ),
  defineSeed(
    { id: 'render-route', title: '原生渲染路由（/render）', description: 'TW 服务端路由插件（$:/plugins/dsh/render，server-routes/render.js）——把 wiki 文本在运行中的 TW 里原生渲染成 HTML 片段，回复流工具卡与 wiki 链接跳转依赖它。seed 写入后需重启 TW 使路由生效。', core: true },
    { presentTitle: RENDER_PLUGIN_TITLE, write: seedRenderRoute },
  ),
  defineSeed(
    { id: 'home-index', title: '首页（主页 / 所有标签 / 标签笔记）', description: '默认主页：四象限待办 + 「所有标签」「所有文章」入口；所有标签：标签统计 + Agent 区块（纯 Agent / Agent+人工）；标签笔记：按标签浏览。系统提示承诺的首页由这里 seed，主页（🏠 主页）同时写入 $:/DefaultTiddlers。', core: false },
    {
      check: async (ctx) => {
        const missing: string[] = []
        for (const item of HOME_INDEX_ITEMS) {
          if (!(await presentOf(ctx, item.title))) missing.push(item.title)
        }
        return { id: 'home-index', title: '首页（主页 / 所有标签 / 标签笔记）', description: '默认主页：四象限待办 + 「所有标签」「所有文章」入口；所有标签：标签统计 + Agent 区块（纯 Agent / Agent+人工）；标签笔记：按标签浏览。系统提示承诺的首页由这里 seed，主页（🏠 主页）同时写入 $:/DefaultTiddlers。', present: missing.length === 0, removable: true, detail: missing.length === 0 ? '已存在' : `缺失：${missing.join('、')}` }
      },
      write: seedHomeIndex,
      unseed: unseedHomeIndex,
    },
  ),
  defineSeed(
    { id: 'all-articles', title: '所有文章（两列分页总览）', description: '「所有文章」——全部条目分两列（🤖 Agent 撰写 / 👤 人工·人类）各自分页展示。每页条数取插件设置 ui.allArticles.pageSize（默认 10）。', core: false },
    { presentTitle: ALL_ARTICLES_TITLE, write: seedAllArticles, unseed: unseedAllArticles },
  ),
  defineSeed(
    { id: 'ui-styles', title: '自定义样式（编辑器美化 / 窄屏侧栏 / menubar 加高 / 批注弹窗）', description: '5 张通用样式表（tag $:/tags/Stylesheet）：编辑器美化（CodeMirror 字体/光标/行号）、标题与按钮区分开、侧边栏窄屏自动隐藏（<960px）、menubar 顶栏加高、批注弹窗美化。纯样式无个人数据。', core: false },
    {
      check: async (ctx) => {
        const missing: string[] = []
        for (const item of UI_STYLE_ITEMS) {
          if (!(await presentOf(ctx, item.title))) missing.push(item.title)
        }
        return { id: 'ui-styles', title: '自定义样式（编辑器美化 / 窄屏侧栏 / menubar 加高 / 批注弹窗）', description: '5 张通用样式表（tag $:/tags/Stylesheet）：编辑器美化（CodeMirror 字体/光标/行号）、标题与按钮区分开、侧边栏窄屏自动隐藏（<960px）、menubar 顶栏加高、批注弹窗美化。纯样式无个人数据。', present: missing.length === 0, removable: true, detail: missing.length === 0 ? '已存在' : `缺失：${missing.join('、')}` }
      },
      write: seedUiStyles,
      unseed: unseedUiStyles,
    },
  ),
  defineSeed(
    { id: 'menubar-theme', title: 'menubar 顶栏主题自适应', description: '样式表覆盖（$:/plugins/dsh-tiddlywiki/menubar-theme，tag $:/tags/Stylesheet）——把 tiddlywiki/menubar 顶栏从「默认色映射的蓝色」改为跟随当前 palette 的 background/foreground，随 DSH 主题切换（$:/palette 翻转）自动换色。', core: false },
    { presentTitle: MENUBAR_THEME_TIDDLER, write: seedMenubarTheme, unseed: unseedMenubarTheme },
  ),
  defineSeed(
    { id: 'clip-bridge', title: '本地剪藏桥（书签小工具）', description: '「本地剪藏桥 + 书签小工具」使用说明（Markdown 文档，带书签代码/启用步骤/安全说明）：DSH 监听 127.0.0.1 端口接收剪藏请求，浏览器书签一键把当前页标题/URL/选中文字写进知识库（配置 bridge.*，默认 clip 标签）。真功能在插件运行时代码里，此 seed 只预置说明文档。', core: false },
    { presentTitle: CLIP_BRIDGE_DOC_TITLE, write: seedClipBridge, unseed: unseedClipBridge },
  ),
  defineSeed(
    { id: 'tw-web-host', title: 'TW 前端 API 基址（同源代理）', description: '把 $:/config/tiddlyweb/host 指向 DSH 同源代理，嵌入式 TW 才能经 DSH origin 访问（远程访问模式的前提）。', core: true },
    {
      check: async (ctx) => {
        // `run` (below) honors a USER-CHOSEN base: it only writes when the
        // value is missing or still the legacy default. The check must agree,
        // otherwise a deliberate custom host is reported as「缺失」.
        //
        // Read WITHOUT swallowing (v0.19.0): the old bare `catch` turned any
        // transient failure into `present: false` — i.e. it reported the user's
        // deliberately customised base as「缺失」and invited the settings page's
        // 「重新初始化」to overwrite it. A failure propagates to checkAllSeeds,
        // which reports「检查失败」instead of a bogus missing state.
        const current = (await ctx.client.get(TW_WEB_HOST_TIDDLER))?.text?.trim()
        const present = typeof current === 'string' && current.length > 0 && current !== TW_WEB_HOST_DEFAULT
        const detail = present
          ? (current === TW_PROXY_PATH ? `已指向 ${TW_PROXY_PATH}` : `已指向自定义基址 ${current}（保留，不会覆盖）`)
          : `当前：${current ?? '（缺失）'}，应为 ${TW_PROXY_PATH}`
        return { id: 'tw-web-host', title: 'TW 前端 API 基址（同源代理）', description: '把 $:/config/tiddlyweb/host 指向 DSH 同源代理，嵌入式 TW 才能经 DSH origin 访问（远程访问模式的前提）。', present, removable: false, detail }
      },
      run: async (ctx, force) => {
        try {
          // Read without swallowing: a transient failure must NOT look like
          // "missing" (that would overwrite a user's custom base).
          const tiddler = await ctx.client.get(TW_WEB_HOST_TIDDLER)
          const current = tiddler?.text?.trim()
          // Non-force keeps the ensure semantics: write only when missing or still
          // the legacy default (a user override pointing elsewhere is honored).
          if (!force && current !== undefined && current !== TW_WEB_HOST_DEFAULT) {
            return { id: 'tw-web-host', ok: true, wrote: false, detail: '已指向自定义基址，未覆盖' }
          }
          await ctx.client.put({ title: TW_WEB_HOST_TIDDLER, text: TW_PROXY_PATH, type: 'text/plain', tags: [] })
          return { id: 'tw-web-host', ok: true, wrote: true, detail: force ? '已重新初始化（强制写回代理基址）' : '已写入代理基址' }
        } catch (err) {
          return { id: 'tw-web-host', ok: false, wrote: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
    },
  ),
]

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

/**
 * Unified seed registry (design: every one-time "与 dsh 联动需要 wiki 预置"
 * item is a SeedDef here).
 *
 * Two tiers (v0.15.0):
 *   - CORE seeds (`core: true`) are functionally required by the plugin's
 *     own features — the startup path seeds exactly these (non-force).
 *   - OPTIONAL seeds (`core: false`) are nice-to-have content (说明笔记 /
 *     首页 / 所有文章 / menubar 顶栏主题自适应) — they are NEVER auto-seeded;
 *     the user opts in from the settings page「初始化」section (重新初始化)
 *     and can opt out again with 反初始化 (remove).
 *
 * Each seed owns:
 *   - `check` — current state (present / missing / needs-update) for the UI;
 *   - `run(force)` — non-force keeps the ONE-SHOT / user-owned semantics
 *     (write only when missing, never overwrite), force (re)writes the
 *     built-in content and (re)records the marker;
 *   - `remove` — optional seeds only: delete the seeded tiddlers + markers,
 *     returning the wiki to the "never seeded" state.
 *
 * Registry: doc-note / send-to-agent / home-index / all-articles /
 * menubar-theme / tw-web-host.
 *
 * @module dsh-tiddlywiki/host/seeds
 */
import type { TiddlyWebClient } from './tw-api.ts'
import { seedDocNote, unseedDocNote, DOC_NOTE_TITLE } from './seed-notes.ts'
import { seedSendToAgent, SEND_TO_AGENT_PLUGIN_TITLE } from './seed-send-to-agent.ts'
import { seedHomeIndex, unseedHomeIndex, HOME_INDEX_ITEMS } from './seed-home.ts'
import { seedAllArticles, unseedAllArticles, ALL_ARTICLES_TITLE } from './seed-all-articles.ts'
import { seedMenubarTheme, unseedMenubarTheme, MENUBAR_THEME_TIDDLER } from './seed-menubar-theme.ts'
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

/** A registered seed: check current state + run (optionally force) + remove. */
export interface SeedDef {
  id: string
  title: string
  description: string
  /**
   * Core seeds are seeded automatically on startup (功能必需). Optional
   * seeds are manual-only from the settings page — never forced on users.
   */
  core: boolean
  check(ctx: SeedContext): Promise<SeedStatus>
  run(ctx: SeedContext, force: boolean): Promise<SeedRunResult>
  /** Optional seeds only: delete the seeded tiddlers + markers (反初始化). */
  remove?(ctx: SeedContext): Promise<SeedRunResult>
}

const presentOf = (ctx: SeedContext, title: string): Promise<boolean> =>
  ctx.client.get(title).then((t) => t !== undefined).catch(() => false)

/** Build the per-item detail from an unseed result. */
const removedDetail = (id: string, removed: string[]): SeedRunResult => ({
  id,
  ok: true,
  wrote: false,
  detail: removed.length > 0
    ? `已移除：${removed.join('、')}`
    : '本就不存在，无需移除',
})

/** The full registry, in display order. */
export const SEED_DEFS: SeedDef[] = [
  {
    id: 'doc-note',
    title: '插件说明笔记',
    description: '「dsh-tiddlywiki 插件说明」——新 wiki 首启自动写入的入门说明（ONE-SHOT，用户可改可删）。',
    core: false,
    check: async (ctx) => {
      const present = await presentOf(ctx, DOC_NOTE_TITLE)
      return { id: 'doc-note', title: '插件说明笔记', description: '「dsh-tiddlywiki 插件说明」——新 wiki 首启自动写入的入门说明（ONE-SHOT，用户可改可删）。', present, removable: true, detail: present ? '已存在' : '缺失' }
    },
    run: async (ctx, force) => {
      try {
        const wrote = await seedDocNote(ctx.client, { force })
        return { id: 'doc-note', ok: true, wrote, detail: wrote ? (force ? '已重新初始化' : '已写入') : (force ? '内容已是最新（未重写）' : '已存在，跳过') }
      } catch (err) {
        return { id: 'doc-note', ok: false, wrote: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    remove: async (ctx) => {
      try {
        return removedDetail('doc-note', (await unseedDocNote(ctx.client)).removed)
      } catch (err) {
        return { id: 'doc-note', ok: false, wrote: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  },
  {
    id: 'send-to-agent',
    title: '「发送给 Agent」按钮',
    description: 'TW 笔记工具栏「发送给 Agent」按钮插件（$:/plugins/dsh/send-to-agent）——把笔记一键注入 DSH 会话。',
    core: true,
    check: async (ctx) => {
      const present = await presentOf(ctx, SEND_TO_AGENT_PLUGIN_TITLE)
      return { id: 'send-to-agent', title: '「发送给 Agent」按钮', description: 'TW 笔记工具栏「发送给 Agent」按钮插件（$:/plugins/dsh/send-to-agent）——把笔记一键注入 DSH 会话。', present, removable: false, detail: present ? '已存在' : '缺失' }
    },
    run: async (ctx, force) => {
      try {
        const wrote = await seedSendToAgent(ctx.client, { force })
        return { id: 'send-to-agent', ok: true, wrote, detail: wrote ? (force ? '已重新初始化' : '已写入') : (force ? '内容已是最新（未重写）' : '已存在，跳过') }
      } catch (err) {
        return { id: 'send-to-agent', ok: false, wrote: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  },
  {
    id: 'render-route',
    title: '原生渲染路由（/render）',
    description: 'TW 服务端路由插件（$:/plugins/dsh/render，server-routes/render.js）——把 wiki 文本在运行中的 TW 里原生渲染成 HTML 片段，回复流工具卡与 wiki 链接跳转依赖它。seed 写入后需重启 TW 使路由生效。',
    core: true,
    check: async (ctx) => {
      const present = await presentOf(ctx, RENDER_PLUGIN_TITLE)
      return { id: 'render-route', title: '原生渲染路由（/render）', description: 'TW 服务端路由插件（$:/plugins/dsh/render，server-routes/render.js）——把 wiki 文本在运行中的 TW 里原生渲染成 HTML 片段，回复流工具卡与 wiki 链接跳转依赖它。seed 写入后需重启 TW 使路由生效。', present, removable: false, detail: present ? '已存在' : '缺失' }
    },
    run: async (ctx, force) => {
      try {
        const wrote = await seedRenderRoute(ctx.client, { force })
        return { id: 'render-route', ok: true, wrote, detail: wrote ? (force ? '已重新初始化' : '已写入') : (force ? '内容已是最新（未重写）' : '已存在，跳过') }
      } catch (err) {
        return { id: 'render-route', ok: false, wrote: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  },
  {
    id: 'home-index',
    title: '首页（主页 / 所有标签 / 标签笔记）',
    description: '默认主页：四象限待办 + 「所有标签」「所有文章」入口；所有标签：标签统计 + Agent 区块（纯 Agent / Agent+人工）；标签笔记：按标签浏览。系统提示承诺的首页由这里 seed，主页同时写入 $:/DefaultTiddlers。',
    core: false,
    check: async (ctx) => {
      const missing: string[] = []
      for (const item of HOME_INDEX_ITEMS) {
        if (!(await presentOf(ctx, item.title))) missing.push(item.title)
      }
      return { id: 'home-index', title: '首页（主页 / 所有标签 / 标签笔记）', description: '默认主页：四象限待办 + 「所有标签」「所有文章」入口；所有标签：标签统计 + Agent 区块（纯 Agent / Agent+人工）；标签笔记：按标签浏览。系统提示承诺的首页由这里 seed，主页同时写入 $:/DefaultTiddlers。', present: missing.length === 0, removable: true, detail: missing.length === 0 ? '已存在' : `缺失：${missing.join('、')}` }
    },
    run: async (ctx, force) => {
      try {
        const wrote = await seedHomeIndex(ctx.client, { force })
        return { id: 'home-index', ok: true, wrote, detail: wrote ? (force ? '已重新初始化' : '已写入') : (force ? '内容已是最新（未重写）' : '已存在，跳过') }
      } catch (err) {
        return { id: 'home-index', ok: false, wrote: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    remove: async (ctx) => {
      try {
        return removedDetail('home-index', (await unseedHomeIndex(ctx.client)).removed)
      } catch (err) {
        return { id: 'home-index', ok: false, wrote: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  },
  {
    id: 'all-articles',
    title: '所有文章（两列分页总览）',
    description: '「所有文章」——全部条目分两列（🤖 Agent 撰写 / 👤 人工·人类）各自分页展示。每页条数取插件设置 ui.allArticles.pageSize（默认 10）。',
    core: false,
    check: async (ctx) => {
      const present = await presentOf(ctx, ALL_ARTICLES_TITLE)
      return { id: 'all-articles', title: '所有文章（两列分页总览）', description: '「所有文章」——全部条目分两列（🤖 Agent 撰写 / 👤 人工·人类）各自分页展示。每页条数取插件设置 ui.allArticles.pageSize（默认 10）。', present, removable: true, detail: present ? '已存在' : '缺失' }
    },
    run: async (ctx, force) => {
      try {
        const wrote = await seedAllArticles(ctx.client, { force })
        return { id: 'all-articles', ok: true, wrote, detail: wrote ? (force ? '已重新初始化' : '已写入') : (force ? '内容已是最新（未重写）' : '已存在，跳过') }
      } catch (err) {
        return { id: 'all-articles', ok: false, wrote: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    remove: async (ctx) => {
      try {
        return removedDetail('all-articles', (await unseedAllArticles(ctx.client)).removed)
      } catch (err) {
        return { id: 'all-articles', ok: false, wrote: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  },
  {
    id: 'menubar-theme',
    title: 'menubar 顶栏主题自适应',
    description: '样式表覆盖（$:/plugins/dsh-tiddlywiki/menubar-theme，tag $:/tags/Stylesheet）——把 tiddlywiki/menubar 顶栏从「默认色映射的蓝色」改为跟随当前 palette 的 background/foreground，随 DSH 主题切换（$:/palette 翻转）自动换色。',
    core: false,
    check: async (ctx) => {
      const present = await presentOf(ctx, MENUBAR_THEME_TIDDLER)
      return { id: 'menubar-theme', title: 'menubar 顶栏主题自适应', description: '样式表覆盖（$:/plugins/dsh-tiddlywiki/menubar-theme，tag $:/tags/Stylesheet）——把 tiddlywiki/menubar 顶栏从「默认色映射的蓝色」改为跟随当前 palette 的 background/foreground，随 DSH 主题切换（$:/palette 翻转）自动换色。', present, removable: true, detail: present ? '已存在' : '缺失' }
    },
    run: async (ctx, force) => {
      try {
        const wrote = await seedMenubarTheme(ctx.client, { force })
        return { id: 'menubar-theme', ok: true, wrote, detail: wrote ? (force ? '已重新初始化' : '已写入') : (force ? '内容已是最新（未重写）' : '已存在，跳过') }
      } catch (err) {
        return { id: 'menubar-theme', ok: false, wrote: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    remove: async (ctx) => {
      try {
        return removedDetail('menubar-theme', (await unseedMenubarTheme(ctx.client)).removed)
      } catch (err) {
        return { id: 'menubar-theme', ok: false, wrote: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  },
  {
    id: 'tw-web-host',
    title: 'TW 前端 API 基址（同源代理）',
    description: '把 $:/config/tiddlyweb/host 指向 DSH 同源代理，嵌入式 TW 才能经 DSH origin 访问（远程访问模式的前提）。',
    core: true,
    check: async (ctx) => {
      let current: string | undefined
      try {
        current = (await ctx.client.get(TW_WEB_HOST_TIDDLER))?.text?.trim()
      } catch {
        current = undefined
      }
      const ok = current === TW_PROXY_PATH
      return { id: 'tw-web-host', title: 'TW 前端 API 基址（同源代理）', description: '把 $:/config/tiddlyweb/host 指向 DSH 同源代理，嵌入式 TW 才能经 DSH origin 访问（远程访问模式的前提）。', present: ok, removable: false, detail: ok ? `已指向 ${TW_PROXY_PATH}` : `当前：${current ?? '（缺失）'}，应为 ${TW_PROXY_PATH}` }
    },
    run: async (ctx, force) => {
      try {
        let current: string | undefined
        try {
          current = (await ctx.client.get(TW_WEB_HOST_TIDDLER))?.text?.trim()
        } catch {
          current = undefined
        }
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
 * Startup path: seed ONLY the core items (功能必需：发送给 Agent 按钮 +
 * TW 前端 API 基址), non-force (write only what is missing). Optional seeds
 * (说明笔记 / 首页 / 所有文章 / menubar 顶栏主题自适应) are never forced on
 * users — they opt in from the settings page「初始化」section.
 */
export async function runAllSeeds(ctx: SeedContext): Promise<SeedRunResult[]> {
  const out: SeedRunResult[] = []
  for (const def of SEED_DEFS) {
    if (!def.core) continue
    out.push(await def.run(ctx, false))
  }
  return out
}

/**
 * 反初始化 (remove): delete one optional seed's seeded tiddlers + markers, or
 * all optional seeds when `id` is undefined. Core seeds are functionally
 * required and cannot be removed — a direct request for one returns an error
 * result (and is skipped when removing all).
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

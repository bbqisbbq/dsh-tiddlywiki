/**
 * Unified seed registry (design: every one-time "与 dsh 联动需要 wiki 预置"
 * item is a SeedDef here — the startup path runs all of them non-force, and
 * the settings page lists them with a manual "重新初始化" (force) button).
 *
 * Each seed owns:
 *   - `check` — current state (present / missing / needs-update) for the UI;
 *   - `run(force)` — non-force keeps the ONE-SHOT / user-owned semantics
 *     (write only when missing, never overwrite), force (re)writes the
 *     built-in content and (re)records the marker.
 *
 * @module dsh-tiddlywiki/host/seeds
 */
import type { TiddlyWebClient } from './tw-api.ts'
import { seedDocNote, DOC_NOTE_TITLE } from './seed-notes.ts'
import { seedSendToAgent, SEND_TO_AGENT_PLUGIN_TITLE } from './seed-send-to-agent.ts'
import { seedHomeIndex, HOME_INDEX_ITEMS } from './seed-home.ts'
import { seedAllArticles, ALL_ARTICLES_TITLE } from './seed-all-articles.ts'
import { TW_WEB_HOST_TIDDLER, TW_WEB_HOST_DEFAULT } from './config.ts'
import { TW_PROXY_PATH } from './wiki.ts'

/** One seed's status as reported to the settings page. */
export interface SeedStatus {
  id: string
  title: string
  description: string
  /** true = target tiddler(s) present (or host value correct). */
  present: boolean
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

/** A registered seed: check current state + run (optionally force). */
export interface SeedDef {
  id: string
  title: string
  description: string
  check(ctx: SeedContext): Promise<SeedStatus>
  run(ctx: SeedContext, force: boolean): Promise<SeedRunResult>
}

const presentOf = (ctx: SeedContext, title: string): Promise<boolean> =>
  ctx.client.get(title).then((t) => t !== undefined).catch(() => false)

/** The full registry, in display order. */
export const SEED_DEFS: SeedDef[] = [
  {
    id: 'doc-note',
    title: '插件说明笔记',
    description: '「dsh-tiddlywiki 插件说明」——新 wiki 首启自动写入的入门说明（ONE-SHOT，用户可改可删）。',
    check: async (ctx) => {
      const present = await presentOf(ctx, DOC_NOTE_TITLE)
      return { id: 'doc-note', title: '插件说明笔记', description: '「dsh-tiddlywiki 插件说明」——新 wiki 首启自动写入的入门说明（ONE-SHOT，用户可改可删）。', present, detail: present ? '已存在' : '缺失' }
    },
    run: async (ctx, force) => {
      try {
        const wrote = await seedDocNote(ctx.client, { force })
        return { id: 'doc-note', ok: true, wrote, detail: wrote ? (force ? '已重新初始化' : '已写入') : (force ? '内容已是最新（未重写）' : '已存在，跳过') }
      } catch (err) {
        return { id: 'doc-note', ok: false, wrote: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  },
  {
    id: 'send-to-agent',
    title: '「发送给 Agent」按钮',
    description: 'TW 笔记工具栏「发送给 Agent」按钮插件（$:/plugins/dsh/send-to-agent）——把笔记一键注入 DSH 会话。',
    check: async (ctx) => {
      const present = await presentOf(ctx, SEND_TO_AGENT_PLUGIN_TITLE)
      return { id: 'send-to-agent', title: '「发送给 Agent」按钮', description: 'TW 笔记工具栏「发送给 Agent」按钮插件（$:/plugins/dsh/send-to-agent）——把笔记一键注入 DSH 会话。', present, detail: present ? '已存在' : '缺失' }
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
    id: 'home-index',
    title: '首页（主页 / 所有标签 / 标签笔记）',
    description: '默认主页：四象限待办 + 「所有标签」「所有文章」入口；所有标签：标签统计 + Agent 区块（纯 Agent / Agent+人工）；标签笔记：按标签浏览。系统提示承诺的首页由这里 seed，主页同时写入 $:/DefaultTiddlers。',
    check: async (ctx) => {
      const missing: string[] = []
      for (const item of HOME_INDEX_ITEMS) {
        if (!(await presentOf(ctx, item.title))) missing.push(item.title)
      }
      return { id: 'home-index', title: '首页（主页 / 所有标签 / 标签笔记）', description: '默认主页：四象限待办 + 「所有标签」「所有文章」入口；所有标签：标签统计 + Agent 区块（纯 Agent / Agent+人工）；标签笔记：按标签浏览。系统提示承诺的首页由这里 seed，主页同时写入 $:/DefaultTiddlers。', present: missing.length === 0, detail: missing.length === 0 ? '已存在' : `缺失：${missing.join('、')}` }
    },
    run: async (ctx, force) => {
      try {
        const wrote = await seedHomeIndex(ctx.client, { force })
        return { id: 'home-index', ok: true, wrote, detail: wrote ? (force ? '已重新初始化' : '已写入') : (force ? '内容已是最新（未重写）' : '已存在，跳过') }
      } catch (err) {
        return { id: 'home-index', ok: false, wrote: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  },
  {
    id: 'all-articles',
    title: '所有文章（两列分页总览）',
    description: '「所有文章」——全部条目分两列（🤖 Agent 撰写 / 👤 人工·人类）各自分页展示。每页条数取插件设置 ui.allArticles.pageSize（默认 10）。',
    check: async (ctx) => {
      const present = await presentOf(ctx, ALL_ARTICLES_TITLE)
      return { id: 'all-articles', title: '所有文章（两列分页总览）', description: '「所有文章」——全部条目分两列（🤖 Agent 撰写 / 👤 人工·人类）各自分页展示。每页条数取插件设置 ui.allArticles.pageSize（默认 10）。', present, detail: present ? '已存在' : '缺失' }
    },
    run: async (ctx, force) => {
      try {
        const wrote = await seedAllArticles(ctx.client, { force })
        return { id: 'all-articles', ok: true, wrote, detail: wrote ? (force ? '已重新初始化' : '已写入') : (force ? '内容已是最新（未重写）' : '已存在，跳过') }
      } catch (err) {
        return { id: 'all-articles', ok: false, wrote: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  },
  {
    id: 'tw-web-host',
    title: 'TW 前端 API 基址（同源代理）',
    description: '把 $:/config/tiddlyweb/host 指向 DSH 同源代理，嵌入式 TW 才能经 DSH origin 访问（远程访问模式的前提）。',
    check: async (ctx) => {
      let current: string | undefined
      try {
        current = (await ctx.client.get(TW_WEB_HOST_TIDDLER))?.text?.trim()
      } catch {
        current = undefined
      }
      const ok = current === TW_PROXY_PATH
      return { id: 'tw-web-host', title: 'TW 前端 API 基址（同源代理）', description: '把 $:/config/tiddlyweb/host 指向 DSH 同源代理，嵌入式 TW 才能经 DSH origin 访问（远程访问模式的前提）。', present: ok, detail: ok ? `已指向 ${TW_PROXY_PATH}` : `当前：${current ?? '（缺失）'}，应为 ${TW_PROXY_PATH}` }
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
        detail: `检查失败：${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }
  return out
}

/**
 * Run one seed (or all, when id is undefined). Non-force = one-shot semantics;
 * force = manual "重新初始化" from the settings page.
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

/** Startup path: run every seed non-force (write only what is missing). */
export async function runAllSeeds(ctx: SeedContext): Promise<SeedRunResult[]> {
  return runSeedById(ctx, undefined, false)
}

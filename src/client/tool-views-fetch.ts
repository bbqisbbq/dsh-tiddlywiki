/**
 * Data layer of the reply-stream tool cards (v0.30.14 split of `tool-views.ts`):
 * the same-origin JSON/fragment fetchers, the tiny async-state hook, and the
 * tiddler-body LRU cache the long-lived conversation flow needs.
 *
 * @module dsh-tiddlywiki/client/tool-views-fetch
 */
import * as React from 'react'
// The render call lives in ONE place (render-fetch.ts): the tool card and the
// session「知识库」tab used to carry byte-near-identical copies of it (v0.22.8).
import { fetchRenderFragment } from './render-fetch.ts'

/* ── fetch helpers (same-origin JSON / fragment) ── */

export async function fetchJsonOrNull(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    // 404 is a NORMAL answer on `/get` (missing tiddler) and carries the
    // `{notFound:true}` body the card needs — returning null here made the
    // notFound branch below unreachable and mislabelled a missing note as
    // "wiki 服务不可用" (v0.20.0, fixed).
    if (res.status === 404) {
      const missing = (await res.json().catch(() => null)) as unknown
      return typeof missing === 'object' && missing !== null ? (missing as Record<string, unknown>) : { notFound: true }
    }
    if (!res.ok) return null
    const data = (await res.json()) as unknown
    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export async function fetchRender(title: string, wikiId?: string): Promise<string | null> {
  return fetchRenderFragment(title, 10_000, wikiId)
}

/** Lightweight async-state hook for one loader keyed by `deps`. */
export function useAsync<T>(factory: () => Promise<T | null>, deps: readonly unknown[]): { loading: boolean; data: T | null } {
  const [state, setState] = React.useState<{ loading: boolean; data: T | null }>({ loading: true, data: null })
  React.useEffect(() => {
    let alive = true
    setState({ loading: true, data: null })
    Promise.resolve(factory()).then(
      (data) => {
        if (alive) setState({ loading: false, data })
      },
      () => {
        if (alive) setState({ loading: false, data: null })
      },
    )
    return () => {
      alive = false
    }
    // factory identity is not a dep on purpose — callers pass stable closures
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}

/* ── tiddler-body cache ── */

/**
 * 卡片正文的小 LRU 缓存（title → {get, html}）：长会话里滚动历史会让同一张卡
 * 反复挂载，每次都成对打 GET /get + POST RENDER_ENDPOINT。容量 ~50、TTL 5 分钟；
 * 命中即复用。写入类工具（put/batch_put/rename/delete）挂载时先失效对应标题，
 * 所以写后的卡片仍会取到最新内容。
 */
export interface CachedTiddlerBody { at: number; get: Record<string, unknown> | null; html: string | null }
const BODY_CACHE_TTL_MS = 5 * 60_000
const BODY_CACHE_MAX = 50
const bodyCache = new Map<string, CachedTiddlerBody>()

/**
 * Cache key for one tiddler body (v0.28.8).
 *
 * The knowledge base is PART of the identity: two wikis routinely hold an entry
 * with the same title (「index」, 「笔记」…), and keying on the title alone made
 * whichever one was read first serve the other's body for five minutes. `\u0000`
 * cannot appear in either component, so the join is unambiguous.
 */
export function bodyCacheKey(wikiId: string | undefined, title: string): string {
  return `${wikiId ?? ''}\u0000${title}`
}

function readBodyCache(wikiId: string | undefined, title: string): CachedTiddlerBody | undefined {
  const key = bodyCacheKey(wikiId, title)
  const hit = bodyCache.get(key)
  if (hit === undefined) return undefined
  if (Date.now() - hit.at > BODY_CACHE_TTL_MS) {
    bodyCache.delete(key)
    return undefined
  }
  // LRU：命中即把条目移到末尾（Map 保持插入序）。
  bodyCache.delete(key)
  bodyCache.set(key, hit)
  return hit
}

function writeBodyCache(wikiId: string | undefined, title: string, value: { get: Record<string, unknown> | null; html: string | null }): void {
  const key = bodyCacheKey(wikiId, title)
  bodyCache.delete(key)
  bodyCache.set(key, { at: Date.now(), ...value })
  while (bodyCache.size > BODY_CACHE_MAX) {
    const oldest = bodyCache.keys().next().value
    if (oldest === undefined) break
    bodyCache.delete(oldest)
  }
}

/**
 * 写入/删除类工具会让缓存过期（同一标题的下一张卡必须看到最新内容）。
 *
 * v0.19.1：调用点从 render 阶段挪进 TiddlerBodyCard 的 loader（`fresh` 属性）
 * ——渲染期间改模块级 Map 在 React 并发渲染/StrictMode 下是不纯的（渲染可能被
 * 丢弃或重放），副作用属于 effect 阶段。语义不变：写入类卡片总是重新拉取。
 */
export function invalidateBodyCache(title: string, wikiId?: string): void {
  if (title.length === 0) return
  // Invalidate BOTH the scoped and the unscoped key: a write card knows its
  // session's wiki, but an earlier render may have cached the same title under
  // the default-wiki key (before the scope resolved).
  bodyCache.delete(bodyCacheKey(wikiId, title))
  bodyCache.delete(bodyCacheKey(undefined, title))
}

/**
 * 在 **effect 阶段**失效若干标题的正文缓存（写入/删除类卡片挂载时调用）。
 * 渲染期不得有副作用：React 并发渲染/StrictMode 下渲染可能被丢弃或重放，
 * 模块级 Map 的删除必须放进 effect（v0.19.1）。
 */
export function useInvalidateBodies(titles: readonly string[], wikiId?: string): void {
  const key = titles.join('\u0000')
  React.useEffect(() => {
    for (const title of key.split('\u0000')) invalidateBodyCache(title, wikiId)
  }, [key, wikiId])
}

export { readBodyCache, writeBodyCache }

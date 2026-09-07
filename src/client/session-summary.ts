/**
 * 会话顶部「知识库」Tab（conversation.view 槽位，id `dsh-tiddlywiki-summary`）——
 * 把当前会话相关的 wiki 笔记汇总渲染进 TW 原生页面。
 *
 * 判定来源是 Host 路由 POST /dsh-tiddlywiki/session/summary：后端用 sessionQuery 读
 * 本会话（含后代 subagent）的事件日志，按「产生/读取/检索」收集 tiddlywiki_* 笔记，
 * 组装 TW wikitext 写入 volatile 的 `$:/temp/dsh/session-summary/<会话ID>`（不落盘、
 * 不进 git），见 src/host/session-summary.ts。
 *
 * 渲染（v0.16.14 关键机制——为什么不能直接 `#<标题>` 直达）：浏览器端 TW 的同步
 * 机制天生看不到 `$:/temp`——服务端 recipe 列表默认 `[all[tiddlers]!is[system]]`
 * （get-tiddlers-json.js），tiddlyweb adaptor 的请求过滤器又显式
 * `-[prefix[$:/temp/]]`（tiddlywebadaptor.js getSkinnyTiddlers），而 lazyLoad 只补
 * 「已知 skinny」不拉「完全缺失」——所以 iframe 里的 TW 永远拿不到 volatile 汇总
 * 条目，`#<标题>` 直达只会渲染「佚失条目」（v0.16.11–13 的根因）。因此由本组件在
 * iframe 就绪后【注入】：同源 `/get` 读回汇总字段 →
 * `iframe.contentWindow.$tw.wiki.addTiddler(...)` 写进 iframe 的 TW store → 设置
 * `contentWindow.location.hash` 走 TW 原生 hash 导航（与中央面板 openTiddler 同一
 * 机制，落地前重试绕开 boot 时序竞争）。汇总条目始终只存在于服务端内存与 iframe
 * 内存——不落盘、不进 git、重启即消失（§四 设计不变）。
 *
 * 自愈：30s 探测——① 服务端丢失（TW 重启清空 `$:/temp`）→ 重新生成（连续
 * MAX_MISSES 次仍缺失交还手动「🔄 刷新」）；② 服务端仍在而 iframe store 丢失
 * （iframe 自身重载/重连）→ 重新注入并导航，不打扰用户在 iframe 内的浏览。
 *
 * 槽位注册（探查定稿）：`conversation.view` kind=list scope=session replaceRisk=none，
 * 官方留给第三方扩展；用新 id = 在「对话 | 轨迹」旁新增 tab（order 20），label 用
 * thunk 跟随 `ui.tabLabel` 配置（默认「知识库」）。
 *
 * @module dsh-tiddlywiki/client/session-summary
 */
import * as React from 'react'
import { attachThemeSync } from './theme-sync.ts'
import { GET_ENDPOINT } from './endpoints.ts'

export const SESSION_SUMMARY_VIEW_ID = 'dsh-tiddlywiki-summary'
const SUMMARY_ENDPOINT = '/dsh-tiddlywiki/session/summary'
/** Same-origin TW proxy base（与 host TW_PROXY_PATH 一致，client 不能 import 它）。 */
const TW_PROXY_BASE = '/dsh-tiddlywiki/tw/'
const SESSION_SUMMARY_LABEL_DEFAULT = '知识库'
/** iframe 内 TW 就绪探测节奏与上限（250ms × 80 ≈ 20s）。 */
const TW_READY_POLL_MS = 250
const TW_READY_TIMEOUT_MS = 20_000
/** hash 导航落地重试节奏与上限（500ms × 20 ≈ 10s）。 */
const NAV_RETRY_MS = 500
const NAV_RETRY_MAX = 20
/** 自愈探测周期。 */
const SELF_HEAL_MS = 30_000
/** 连续多少次「生成后服务端仍缺失」后停止自动重试，交还手动「🔄 刷新」。 */
const MAX_MISSES = 3

/** Tab 显示名缓存：客户端从 /status 读到 `ui.tabLabel` 后更新；默认「知识库」。 */
let tabLabel = SESSION_SUMMARY_LABEL_DEFAULT
export function setSessionSummaryTabLabel(label: string): void {
  tabLabel = typeof label === 'string' && label.trim().length > 0 ? label.trim() : SESSION_SUMMARY_LABEL_DEFAULT
}

/** 槽位 label thunk：每次投影重读，配置变更即时生效。 */
function labelThunk(): string {
  return tabLabel
}

/** conversation.view 标准 props（scope=session）的极小子集 + ownerProps。 */
interface SessionSummaryViewProps {
  sessionId?: string
  /** ownerProps：一次性 focus 请求（本视图无子 focus 目标，直接确认）。 */
  viewRequest?: { view?: string; focus?: string } | null
  completeViewRequest?: () => void
}

/** `/get` 读回的汇总字段子集（够渲染即可）。 */
interface SummaryFields {
  title: string
  text?: string
  type?: string
  tags?: string[]
}

/**
 * iframe 内 TW 运行时的极小结构面——只声明注入/探测用到的成员（theme-sync 已有
 * 访问 `iframe.contentWindow.$tw` 的先例，同一访问模式）。
 */
interface TwRuntime {
  Tiddler: new (fields: Record<string, unknown>) => unknown
  wiki: {
    addTiddler(tiddler: unknown): void
    tiddlerExists(title: string): boolean
    getTiddlerList(title: string): string[]
  }
}

/** 读取 iframe 内的 TW 运行时；未就绪（未启动/缺成员）返回 undefined。 */
function readTwRuntime(el: HTMLIFrameElement | null | undefined): TwRuntime | undefined {
  const w = el?.contentWindow as (Window & { $tw?: unknown }) | null | undefined
  const tw = w?.$tw as TwRuntime | undefined
  if (tw === undefined || tw.wiki === undefined) return undefined
  if (typeof tw.Tiddler !== 'function') return undefined
  if (typeof tw.wiki.addTiddler !== 'function' || typeof tw.wiki.tiddlerExists !== 'function' || typeof tw.wiki.getTiddlerList !== 'function') {
    return undefined
  }
  return tw
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/** View 组件：生成汇总 → iframe 载入 TW → 注入 volatile 条目 → 原生 hash 导航。 */
function SessionSummaryView(props: SessionSummaryViewProps): React.ReactElement {
  const { sessionId, viewRequest, completeViewRequest } = props
  const [phase, setPhase] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const [frameSrc, setFrameSrc] = React.useState<string | null>(null)
  const [summaryTitle, setSummaryTitle] = React.useState<string | null>(null)
  /** true = 汇总已在 iframe 内落地显示；false = 盖一层加载浮层（遮住 TW 默认页）。 */
  const [navigated, setNavigated] = React.useState(false)
  const [error, setError] = React.useState('')
  const [frameNonce, setFrameNonce] = React.useState(0)
  const genRef = React.useRef(0)
  const missesRef = React.useRef(0)
  const themeDisposeRef = React.useRef<(() => void) | undefined>(undefined)
  const frameElRef = React.useRef<HTMLIFrameElement | null>(null)

  const generate = React.useCallback(async (): Promise<void> => {
    const gen = ++genRef.current
    setPhase('loading')
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      setPhase('error')
      setError('缺少会话 ID')
      return
    }
    try {
      const res = await fetch(SUMMARY_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: sessionId }),
        signal: AbortSignal.timeout(25_000),
      })
      const data = (await res.json().catch(() => null)) as { ok?: boolean; title?: string; error?: string } | null
      if (gen !== genRef.current) return
      if (!res.ok || data?.ok !== true) {
        setPhase('error')
        setError(data?.error ?? `HTTP ${res.status}`)
        return
      }
      if (typeof data.title === 'string' && data.title.length > 0) {
        setSummaryTitle(data.title)
        // 注意：不带 #hash 挂载——volatile 条目不在浏览器 store，boot 期 hash 直达
        // 只会渲染「佚失条目」；就绪后由 injectAndNavigate 注入再原生导航。
        setFrameSrc(new URL(TW_PROXY_BASE, window.location.origin).href)
        // 新 nonce 强制 iframe 重挂载 → 重新注入最新汇总（含刷新场景）。
        setFrameNonce((n) => n + 1)
        setNavigated(false)
        setPhase('ready')
      } else {
        // ok 但缺 title：防御性报错，避免空 iframe + 永久加载浮层。
        setPhase('error')
        setError('响应缺少汇总标题')
      }
    } catch (err) {
      if (gen !== genRef.current) return
      setPhase('error')
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [sessionId])

  // 进入 tab 自动触发生成；切走再切回会重新挂载 → 再次生成（总是最新）。
  React.useEffect(() => {
    void generate()
  }, [generate])

  /** 服务端读回汇总字段（volatile 条目对 host 的 /get 永远可见）。 */
  const fetchSummaryFields = React.useCallback(async (title: string): Promise<SummaryFields | 'missing' | null> => {
    try {
      const res = await fetch(`${GET_ENDPOINT}?title=${encodeURIComponent(title)}`, { signal: AbortSignal.timeout(8_000) })
      if (res.status === 404) return 'missing'
      const data = (await res.json().catch(() => null)) as { ok?: boolean; title?: string; text?: string; type?: string; tags?: string[] } | null
      if (data?.ok !== true || typeof data.title !== 'string') return null
      return { title: data.title, text: data.text, type: data.type, tags: data.tags }
    } catch {
      return null
    }
  }, [])

  /**
   * 注入 + 原生导航：读回汇总字段 → 等 iframe 内 TW 启动 → addTiddler 进 iframe 的
   * store → 设 contentWindow.location.hash 走 TW 原生导航，落地重试直到条目进入
   * `$:/StoryList`（绕开「hash 设置早于 story 监听器注册」的 boot 时序竞争）。
   */
  const injectAndNavigate = React.useCallback(async (): Promise<'ok' | 'missing' | 'timeout'> => {
    if (summaryTitle === null) return 'missing'
    const fields = await fetchSummaryFields(summaryTitle)
    if (fields === 'missing') return 'missing'
    if (fields === null) return 'timeout'
    // 等 TW 启动（iframe 重挂载后 boot 需要一点时间）。
    let tw: TwRuntime | undefined
    const deadline = Date.now() + TW_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      tw = readTwRuntime(frameElRef.current)
      if (tw !== undefined) break
      await sleep(TW_READY_POLL_MS)
    }
    if (tw === undefined) {
      setNavigated(true) // TW 一直没就绪：揭开 iframe 看真实状态（代理错误页等）
      return 'timeout'
    }
    // 注入（幂等：同标题覆盖；SyncFilter 排除 $:/temp → iframe 不会把它存回服务端）。
    try {
      tw.wiki.addTiddler(new tw.Tiddler({
        title: fields.title,
        text: fields.text ?? '',
        type: fields.type ?? 'text/vnd.tiddlywiki',
        tags: fields.tags ?? [],
      }))
    } catch {
      /* 注入失败也继续尝试导航（store 里可能有旧版本可显示） */
    }
    // hash 导航 + 落地重试。
    const hash = '#' + encodeURIComponent(summaryTitle)
    for (let i = 0; i < NAV_RETRY_MAX; i++) {
      let landed = false
      try {
        landed = tw.wiki.getTiddlerList('$:/StoryList').indexOf(summaryTitle) !== -1
      } catch {
        landed = false
      }
      if (landed) {
        setNavigated(true)
        return 'ok'
      }
      const w = frameElRef.current?.contentWindow
      if (w !== null && w !== undefined) {
        try {
          const cur = w.location.hash
          // TW 的 permaview 会把地址栏改写成 `#<标题>:<story>`；只要当前 hash 不是
          // 以我们的标题开头就重设，避免和地址栏更新互相打架。
          if (cur !== hash && !cur.startsWith(hash + ':')) w.location.hash = hash
        } catch {
          /* 跨文档瞬间设置失败 → 下轮重试 */
        }
      }
      await sleep(NAV_RETRY_MS)
    }
    setNavigated(true)
    return 'timeout'
  }, [summaryTitle, fetchSummaryFields])

  // iframe 挂载后注入并导航；每次重挂载（生成/刷新）都重跑。服务端条目丢失
  // （TW 重启）→ 计入 misses 自动重新生成，连续 MAX_MISSES 次仍缺失交还手动刷新。
  React.useEffect(() => {
    if (phase !== 'ready' || summaryTitle === null) return
    let disposed = false
    void (async () => {
      const outcome = await injectAndNavigate()
      if (disposed) return
      if (outcome === 'missing') {
        missesRef.current++
        if (missesRef.current < MAX_MISSES) void generate()
      }
    })()
    return () => {
      disposed = true
    }
  }, [phase, summaryTitle, frameNonce, injectAndNavigate, generate])

  // 自愈探测（30s）：① 服务端丢失（TW 重启清空 volatile 条目）→ 重新生成；
  // ② 服务端仍在而 iframe store 丢失（iframe 自身重载/重连）→ 重新注入并导航。
  React.useEffect(() => {
    if (phase !== 'ready' || summaryTitle === null) return
    const timer = window.setInterval(() => {
      void (async () => {
        let serverHas = false
        try {
          const res = await fetch(`${GET_ENDPOINT}?title=${encodeURIComponent(summaryTitle)}`, { signal: AbortSignal.timeout(8_000) })
          serverHas = res.status !== 404
        } catch {
          return // 探测失败保持现状，下个周期再试
        }
        if (!serverHas) {
          missesRef.current++
          if (missesRef.current < MAX_MISSES) void generate()
          return
        }
        missesRef.current = 0
        const tw = readTwRuntime(frameElRef.current)
        if (tw === undefined) return
        let present = true
        try {
          present = tw.wiki.tiddlerExists(summaryTitle)
        } catch {
          return // store 暂不可读，保守不动
        }
        if (!present) {
          setNavigated(false)
          void injectAndNavigate()
        }
      })()
    }, SELF_HEAL_MS)
    return () => window.clearInterval(timer)
  }, [phase, summaryTitle, generate, injectAndNavigate])

  // 一次性 focus 请求直接确认（本视图无可聚焦子目标，避免 shell 挂起）。
  React.useEffect(() => {
    if (viewRequest !== null && viewRequest !== undefined) completeViewRequest?.()
  }, [viewRequest, completeViewRequest])

  // iframe 主题同步（同源代理，attachThemeSync 自处理 load/reapply）。
  const frameCallback = React.useCallback((el: HTMLIFrameElement | null) => {
    if (el === null) {
      frameElRef.current = null
      themeDisposeRef.current?.()
      themeDisposeRef.current = undefined
      return
    }
    frameElRef.current = el
    themeDisposeRef.current?.()
    themeDisposeRef.current = attachThemeSync(el)
  }, [])

  React.useEffect(
    () => () => {
      themeDisposeRef.current?.()
      themeDisposeRef.current = undefined
    },
    [],
  )

  const refresh = (): void => {
    void generate()
  }

  let content: React.ReactNode
  if (phase === 'loading') {
    content = React.createElement(
      'div',
      { className: 'dsh-tw-summary-state' },
      React.createElement('div', { className: 'dsh-tw-summary-state-spin' }, '⏳'),
      React.createElement('div', null, '正在生成会话 wiki 汇总…'),
    )
  } else if (phase === 'error') {
    content = React.createElement(
      'div',
      { className: 'dsh-tw-summary-state' },
      React.createElement('div', { className: 'dsh-tw-summary-state-title' }, '知识库汇总暂不可用'),
      React.createElement('div', { className: 'dsh-tw-summary-state-detail' }, error),
      React.createElement('button', { type: 'button', className: 'dsh-tw-summary-btn', onClick: refresh }, '重试'),
    )
  } else {
    // iframe 一直在挂载状态启动 TW；注入落地前盖一层加载浮层（遮住 TW 默认页，
    // 避免闪现主页/佚失条目）。TW 就绪超时时揭开浮层让用户看到 iframe 真实状态。
    content = React.createElement(
      'div',
      { className: 'dsh-tw-summary-body' },
      React.createElement('iframe', {
        key: frameNonce,
        ref: frameCallback,
        className: 'dsh-tw-summary-frame',
        src: frameSrc ?? undefined,
        title: tabLabel,
      }),
      navigated
        ? null
        : React.createElement(
            'div',
            { className: 'dsh-tw-summary-state dsh-tw-summary-state-over' },
            React.createElement('div', { className: 'dsh-tw-summary-state-spin' }, '⏳'),
            React.createElement('div', null, '正在载入会话 wiki 汇总…'),
          ),
    )
  }

  return React.createElement(
    'div',
    { className: 'dsh-tw-summary', 'data-dsh-tw-summary': 'true' },
    React.createElement(
      'div',
      { className: 'dsh-tw-summary-bar' },
      React.createElement('span', { className: 'dsh-tw-summary-bar-title' }, '📚 本会话知识库'),
      React.createElement('span', { className: 'dsh-tw-summary-bar-hint' }, '产生 / 读取 / 检索过的笔记（含子代理）'),
      React.createElement('span', { className: 'dsh-tw-summary-bar-spacer' }),
      React.createElement(
        'button',
        { type: 'button', className: 'dsh-tw-summary-btn', onClick: refresh, disabled: phase === 'loading', title: '重新生成并刷新汇总' },
        '🔄 刷新',
      ),
    ),
    content,
  )
}

/** 槽位注册所需的最小 slots 脸（与 client/index.ts 的 ClientContextFace 一致）。 */
interface SlotsFace {
  inject(name: string, register: () => unknown): (() => void) | undefined
  register(
    opts: { name: string; id: string; order?: number; label?: string | (() => string) },
    component: unknown,
  ): () => void
}

/**
 * 挂载「知识库」Tab（conversation.view 槽位）。受 `ui.showSessionTab` 控制
 * （默认开）；tab 名跟随 `ui.tabLabel`（默认「知识库」）。
 * @returns disposer（槽位未注入时 undefined）。
 */
export function mountSessionSummaryView(slots: SlotsFace | undefined, cfg: { tabLabel: string; showSessionTab: boolean }): (() => void) | undefined {
  if (slots === undefined || cfg.showSessionTab === false) return undefined
  setSessionSummaryTabLabel(cfg.tabLabel)
  return slots.inject('conversation.view', () =>
    slots.register(
      { name: 'conversation.view', id: SESSION_SUMMARY_VIEW_ID, order: 20, label: labelThunk },
      SessionSummaryView,
    ),
  )
}

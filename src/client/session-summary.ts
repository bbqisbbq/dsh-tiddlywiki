/**
 * 会话顶部「知识库」Tab（conversation.view 槽位，id `dsh-tiddlywiki-summary`）——
 * 把当前会话相关的 wiki 笔记汇总以 TW 原生渲染展示。
 *
 * 汇总内容由 Host 路由 POST /dsh-tiddlywiki/session/summary 生成：后端用
 * sessionQuery 读本会话（含后代 subagent）的事件日志，按「产生/读取/检索」收集
 * tiddlywiki_* 笔记，组装 TW wikitext 写入 volatile 的
 * `$:/temp/dsh/session-summary/<会话ID>`（不落盘、不进 git），见
 * src/host/session-summary.ts。
 *
 * 渲染（v0.16.19 修掉的坑——为什么不能走 iframe + TW story view）：TW 5.4.1 核心
 * 的视图模板级联（$:/config/ViewTemplateBodyFilters/system 的 system 规则，multids
 * 展开为独立 tiddler）把一切 `$:/temp/` 前缀 tiddler 一律按「代码块」渲染
 * （$:/core/ui/ViewTemplate/body/code → <pre><code>）——已用 headless $tw 实测：
 * 对 `$:/temp/dsh/session-summary/…` 渲染 body 级联得到 `<pre><code>…</code></pre>`
 * 而非 `<h1>`。因此**无论**是 v0.16.11–13 的「hash 直达」（浏览器端 TW 同步天生
 * 排除 `$:/temp`，只出「佚失条目」）还是 v0.16.14–18 的「注入 iframe store +
 * 原生 hash 导航」（条目进了浏览器 store 后，story view 仍被 system 级联规则按
 * 代码块展示），汇总都呈现为「整篇 wikitext 源码、像包在代码标签里」——这正是
 * 用户看到的现象。修复：客户端**不再用 iframe / story view**，改走与回复流工具卡
 * 同一条原生渲染管线——`POST /tw/render { title }`（服务端 renderText 把 wikitext
 * 块解析成 HTML 片段，内部 [[链接]] 重写为同源代理 hash /dsh-tiddlywiki/tw/#标题）
 * → dangerouslySetInnerHTML 注入滚动容器；主题与样式复用 .dsh-tw-toolcard-native
 * 的 tc-* 重主题（与工具卡视觉一致）；片段内链接由全局 wiki-link 拦截器打开中央
 * TW 面板。无 iframe → 无 story view → 无编辑按钮/草稿（v0.16.16 的三层防误编辑
 * 机制随之不再需要）。
 *
 * 槽位注册（探查定稿）：`conversation.view` kind=list scope=session replaceRisk=none，
 * 官方留给第三方扩展；用新 id = 在「对话 | 轨迹」旁新增 tab（order 20），label 用
 * thunk 跟随 `ui.tabLabel` 配置（默认「知识库」）。进入 tab 自动触发生成，顶栏提供
 * 手动「刷新」。
 *
 * @module dsh-tiddlywiki/client/session-summary
 */
import * as React from 'react'
import { GET_ENDPOINT } from './endpoints.ts'

export const SESSION_SUMMARY_VIEW_ID = 'dsh-tiddlywiki-summary'
const SUMMARY_ENDPOINT = '/dsh-tiddlywiki/session/summary'
const RENDER_ENDPOINT = '/dsh-tiddlywiki/tw/render'
const SESSION_SUMMARY_LABEL_DEFAULT = '知识库'
/** 自愈探测周期：服务端 volatile 条目被清（TW 重启）→ 自动重新生成。 */
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

/** POST /tw/render：把汇总 tiddler 的 wikitext 块解析成原生 HTML 片段（失败返回 null）。 */
async function fetchRenderFragment(title: string): Promise<string | null> {
  try {
    const res = await fetch(RENDER_ENDPOINT, {
      method: 'POST',
      // TW 服务器对 POST 一律走 writers + CSRF（X-Requested-With）门禁，与
      // tool-views 相同；同源请求可自由携带该头，缺了会 403。
      headers: { 'content-type': 'application/json', 'x-requested-with': 'TiddlyWiki' },
      body: JSON.stringify({ title }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const text = await res.text()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

/** GET /get：确认 volatile 汇总条目是否还在（404/notFound = 已被清掉）。 */
async function tiddlerExists(title: string): Promise<boolean> {
  try {
    const res = await fetch(`${GET_ENDPOINT}?title=${encodeURIComponent(title)}`, { signal: AbortSignal.timeout(8_000) })
    if (res.status === 404) return false
    const data = (await res.json().catch(() => null)) as { notFound?: boolean } | null
    return data?.notFound !== true
  } catch {
    return true // 查询失败时不误判为缺失，交由自愈定时器处理
  }
}

/** View 组件：生成汇总 → /tw/render 原生片段；顶栏带手动刷新。 */
function SessionSummaryView(props: SessionSummaryViewProps): React.ReactElement {
  const { sessionId, viewRequest, completeViewRequest } = props
  const [phase, setPhase] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const [html, setHtml] = React.useState<string | null>(null)
  const [summaryTitle, setSummaryTitle] = React.useState<string | null>(null)
  const [error, setError] = React.useState('')
  const genRef = React.useRef(0)
  const missesRef = React.useRef(0)
  /** 渲染失败且条目缺失时自动重建一次的有界开关（防循环）。 */
  const autoRetriedRef = React.useRef(false)

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
      if (typeof data.title !== 'string' || data.title.length === 0) {
        setPhase('error')
        setError('汇总生成失败：缺少标题')
        return
      }
      setSummaryTitle(data.title)
      // 原生渲染：wikitext → HTML 片段（块解析，标题/表格/列表/引用齐全，
      // 链接已重写为 /dsh-tiddlywiki/tw/#标题，点击由全局拦截器接管）。
      const fragment = await fetchRenderFragment(data.title)
      if (gen !== genRef.current) return
      if (fragment === null) {
        // 区分「条目被清（TW 重启把 $:/temp 冲掉了）」与「渲染服务不可用」：
        // 前者自动重建一次（有界），后者直接报错交还手动重试。
        const exists = await tiddlerExists(data.title)
        if (gen !== genRef.current) return
        if (!exists) {
          if (autoRetriedRef.current) {
            setPhase('error')
            setError('汇总条目不存在，自动重建失败，请重试')
            return
          }
          autoRetriedRef.current = true
          missesRef.current++
          void generate()
          return
        }
        setPhase('error')
        setError('渲染失败：wiki 渲染服务不可用（/tw/render）')
        return
      }
      autoRetriedRef.current = false
      missesRef.current = 0
      setHtml(fragment)
      setPhase('ready')
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

  // 自愈：汇总条目是 volatile 的 `$:/temp`，TW 重启即消失；若已就绪但条目
  // 被清掉（/get 404），自动重新生成（含重新渲染）。连续 MAX_MISSES 次仍缺失
  // （例如服务端写不进去）就停止自动重试，交还手动「🔄 刷新」。
  React.useEffect(() => {
    if (phase !== 'ready' || summaryTitle === null) return
    const timer = window.setInterval(() => {
      void (async () => {
        let serverHas = false
        try {
          const res = await fetch(`${GET_ENDPOINT}?title=${encodeURIComponent(summaryTitle)}`, { signal: AbortSignal.timeout(8_000) })
          const data = (await res.json().catch(() => null)) as { notFound?: boolean } | null
          serverHas = res.status !== 404 && data?.notFound !== true
        } catch {
          return // 探测失败保持现状，下个周期再试
        }
        if (!serverHas) {
          missesRef.current++
          if (missesRef.current < MAX_MISSES) void generate()
        } else {
          missesRef.current = 0
        }
      })()
    }, SELF_HEAL_MS)
    return () => window.clearInterval(timer)
  }, [phase, summaryTitle, generate])

  // 一次性 focus 请求直接确认（本视图无可聚焦子目标，避免 shell 挂起）。
  React.useEffect(() => {
    if (viewRequest !== null && viewRequest !== undefined) completeViewRequest?.()
  }, [viewRequest, completeViewRequest])

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
    // 原生 TW 片段：HTML 来自本地 wiki（与嵌入式编辑器和工具卡同一信任级别）；
    // 片段内 /dsh-tiddlywiki/tw/#标题 链接由全局拦截器打开中央 TW 面板。
    content = React.createElement('div', {
      className: 'dsh-tw-summary-native dsh-tw-toolcard-native',
      dangerouslySetInnerHTML: { __html: html ?? '' },
    })
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

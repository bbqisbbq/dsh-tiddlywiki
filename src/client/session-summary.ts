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
 * 同一条原生渲染管线——`POST /dsh-tiddlywiki/render { title }`（host 转 TW 的
 * /render 并由 **host 净化片段**后再返回，见 host/sanitize.ts；服务端 renderText
 * 把 wikitext 块解析成 HTML 片段，内部 [[链接]] 重写为同源代理 hash /dsh-tiddlywiki/tw/#标题）
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
 * 自愈（v0.24.x）：每 SELF_HEAL_MS 探一次条目是否还在（三态：在 / 被清 / 状态未知），
 * 被清才重建、未知只降级提示（不烧失败额度也不假装正常）；另按时间刷新——距上次
 * 成功生成超过 REFRESH_MS 且页面可见就重新生成，tab 长期开着也能保持新鲜。
 *
 * @module dsh-tiddlywiki/client/session-summary
 */
import * as React from 'react'
import { GET_ENDPOINT, SESSION_SUMMARY_ENDPOINT as SUMMARY_ENDPOINT } from './endpoints.ts'
// The render call lives in ONE place (render-fetch.ts) — this module and
// tool-views.ts used to carry near-identical copies (v0.22.8).
import { fetchRenderFragment } from './render-fetch.ts'
import { getTabLabel, setTabLabel } from './tw-frame.ts'

/** conversation.view 槽位注册 id（模块私有，v0.22.8：只有本文件的 mount 用）。 */
const SESSION_SUMMARY_VIEW_ID = 'dsh-tiddlywiki-summary'
/** 自愈探测周期：服务端 volatile 条目被清（TW 重启）→ 自动重新生成。 */
const SELF_HEAL_MS = 30_000
/** 连续多少次「生成后服务端仍缺失」后停止自动重试，交还手动「🔄 刷新」。 */
const MAX_MISSES = 3
/**
 * 按时间刷新：tab 长期开着时，内容不能永远停在挂载那一刻（此前唯一的新鲜度来源
 * 是「切走再切回重新挂载」）。自愈 tick 发现距上次成功生成超过这个时间就重新生成。
 */
const REFRESH_MS = 3 * 60_000

/** 槽位 label thunk：每次投影重读共享标签，配置变更即时生效。 */
function labelThunk(): string {
  return getTabLabel()
}

/** conversation.view 标准 props（scope=session）的极小子集 + ownerProps。 */
interface SessionSummaryViewProps {
  sessionId?: string
  /** ownerProps：一次性 focus 请求（本视图无子 focus 目标，直接确认）。 */
  viewRequest?: { view?: string; focus?: string } | null
  completeViewRequest?: () => void
}

/**
 * GET /get：汇总条目是否还在——三态（v0.24.x）。
 *
 * `'yes'` 存在 / `'no'` 已被清掉（404 或 `notFound`）/ `'unknown'` 探测本身失败。
 * 老实现把 catch 当作 `true`（「一切正常」）：TW 重启期间失败计数被不断清零，
 * MAX_MISSES 额度形同虚设，界面也不提示降级，只会无限期轮询。未知必须与存在
 * 区分开——只有 `'no'` 才走「重建」分支。
 *
 * The self-heal probe below reuses THIS function (v0.22.8) — the same 404 /
 * `notFound` interpretation used to be written out a second time in the
 * interval, and the two disagreed on what a transport error means.
 */
async function tiddlerExists(title: string): Promise<'yes' | 'no' | 'unknown'> {
  try {
    const res = await fetch(`${GET_ENDPOINT}?title=${encodeURIComponent(title)}`, { signal: AbortSignal.timeout(8_000) })
    if (res.status === 404) return 'no'
    // 非 2xx（500/503…）不是「条目还在」的证据：拿不到确定答案就报未知，别猜。
    if (!res.ok) return 'unknown'
    const data = (await res.json().catch(() => null)) as { notFound?: boolean } | null
    if (data === null) return 'unknown'
    return data.notFound === true ? 'no' : 'yes'
  } catch {
    return 'unknown' // 查询失败 ≠ 条目缺失，也 ≠ 一切正常
  }
}

/** View 组件：生成汇总 → host /render 原生片段；顶栏带手动刷新。 */
function SessionSummaryView(props: SessionSummaryViewProps): React.ReactElement {
  const { sessionId, viewRequest, completeViewRequest } = props
  const [phase, setPhase] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const [html, setHtml] = React.useState<string | null>(null)
  const [summaryTitle, setSummaryTitle] = React.useState<string | null>(null)
  const [error, setError] = React.useState('')
  /** 降级提示（探测状态未知 / 后台刷新失败）：不清掉已渲染的旧内容，只加一行说明。 */
  const [probeUnknown, setProbeUnknown] = React.useState(false)
  const genRef = React.useRef(0)
  /**
   * 卸载守卫（v0.22.3）：genRef 只能识别「被更新的一次 generate 取代」，覆盖不到
   * 卸载——组件卸载后 genRef 不再变化，在途的 fetch 一 resolve 就会 setState，并
   * 在「条目缺失」分支里再递归触发一轮请求（clearInterval 挡不住已在途的那次）。
   * 置 false 的效果排在同组件其它 effect 之前执行，所以清理顺序不影响它。
   */
  const mountedRef = React.useRef(true)
  /**
   * 统一「连续失败计数」：任何一次 generate() 失败（HTTP 失败 / 缺标题 / 渲染
   * 服务不可用 / 条目缺失 / 抛错）都递增，任何一次成功归零。达到 MAX_MISSES 后
   * 彻底停止自动重试（此前 missesRef 与 autoRetriedRef 交替复位会形成无界自动
   * 重生成循环）；手动「🔄 刷新」是显式重来，会清零计数重新获得重试额度。
   * （例外：探测本身失败 = 状态未知，既不计数也不清零，见自愈 tick。）
   */
  const failuresRef = React.useRef(0)
  /** 最近一次成功生成汇总的 epoch ms——自愈按它判断内容是否已过期（REFRESH_MS）。 */
  const lastGeneratedRef = React.useRef(0)

  const generate = React.useCallback(async (opts?: { silent?: boolean }): Promise<void> => {
    const gen = ++genRef.current
    // 卸载后不再发起新一轮（含「条目缺失 → 自动重建」的递归调用）。
    if (!mountedRef.current) return
    // silent = 自愈的「按时间刷新」：不动已经渲染好的内容——成功时不闪 loading，
    // 失败时也只降级提示（后台刷新不该把用户正在看的汇总换成转圈或错误页）。
    // 首次生成 / 手动刷新 / 「条目缺失 → 重建」仍然显示 loading、失败照旧报错。
    const silent = opts?.silent === true
    if (!silent) setPhase('loading')
    /** 失败收尾：计入失败额度，非 silent 时切错误态。 */
    const fail = (message: string): void => {
      failuresRef.current++
      if (silent) {
        setProbeUnknown(true)
        return
      }
      setPhase('error')
      setError(message)
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      setPhase('error')
      setError('缺少会话 ID')
      return
    }
    // 连续失败到顶：不再自动重试（彻底停止自愈），只提示手动刷新。
    if (failuresRef.current >= MAX_MISSES) {
      if (silent) {
        setProbeUnknown(true)
        return
      }
      setPhase('error')
      setError(`连续 ${MAX_MISSES} 次生成失败，已停止自动重试，请点「🔄 刷新」`)
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
      if (!mountedRef.current || gen !== genRef.current) return
      if (!res.ok || data?.ok !== true) {
        fail(data?.error ?? `HTTP ${res.status}`)
        return
      }
      if (typeof data.title !== 'string' || data.title.length === 0) {
        fail('汇总生成失败：缺少标题')
        return
      }
      setSummaryTitle(data.title)
      // 原生渲染：wikitext → HTML 片段（块解析，标题/表格/列表/引用齐全，
      // 链接已重写为 /dsh-tiddlywiki/tw/#标题，点击由全局拦截器接管）。
      const fragment = await fetchRenderFragment(data.title)
      if (!mountedRef.current || gen !== genRef.current) return
      if (fragment === null) {
        // 区分「条目被清（TW 重启把 $:/temp 冲掉了）」与「渲染服务不可用」：
        // 前者自动重建（受 MAX_MISSES 约束，有界），后者直接报错交还手动重试。
        const exists = await tiddlerExists(data.title)
        if (!mountedRef.current || gen !== genRef.current) return
        if (exists === 'no') {
          failuresRef.current++
          if (failuresRef.current < MAX_MISSES) {
            void generate()
            return
          }
          setPhase('error')
          setError('汇总条目不存在，自动重建失败，请重试')
          return
        }
        if (exists === 'unknown') {
          // 探测本身也失败：无法区分「条目被清」与「渲染服务不可用」——不计入失败
          // 额度也不清零（TW 重启期间不该被烧完额度），只报状态未知，交下一轮自愈。
          if (silent) {
            setProbeUnknown(true)
            return
          }
          setPhase('error')
          setError('渲染失败：wiki 渲染服务不可用（host /render），条目状态未知')
          return
        }
        fail('渲染失败：wiki 渲染服务不可用（host /render）')
        return
      }
      failuresRef.current = 0
      lastGeneratedRef.current = Date.now()
      setProbeUnknown(false)
      setHtml(fragment)
      setPhase('ready')
    } catch (err) {
      if (!mountedRef.current || gen !== genRef.current) return
      fail(err instanceof Error ? err.message : String(err))
    }
  }, [sessionId])

  // 进入 tab 自动触发生成；切走再切回会重新挂载 → 再次生成（总是最新）。
  // 卸载时置 mountedRef=false：在途请求 resolve 后不再 setState / 不再递归重建。
  React.useEffect(() => {
    mountedRef.current = true
    // DSH 可能复用同一个组件实例、只换 sessionId：新会话必须从零开始计数，否则会
    // 继承上一个会话「已连续 N 次失败」的状态（一进来就直接放弃自动重试）。
    failuresRef.current = 0
    // 以挂载时刻作为「上次生成」的起点（而不是 0）：首次生成若失败，按时间刷新也要
    // 等满 REFRESH_MS 才动，不会一挂载就每 30s 重试一次。
    lastGeneratedRef.current = Date.now()
    setProbeUnknown(false)
    void generate()
    return () => {
      mountedRef.current = false
    }
  }, [generate])

  // 自愈：汇总条目是 volatile 的 `$:/temp`，TW 重启即消失；条目被清掉（探测 'no'）
  // 就自动重新生成（含重新渲染），连续 MAX_MISSES 次仍缺失就交还手动「🔄 刷新」。
  // 依赖里**不能**放 phase：一进 error 态 interval 就被清理且永不重建，MAX_MISSES
  // 额度只用掉一次就失效——phase 与 interval 解耦，error 态也保持低频自愈。
  React.useEffect(() => {
    if (summaryTitle === null) return
    // alive 守卫：clearInterval 挡不住已经在途的 fetch，回调 resolve 后会在已卸载
    // 的组件上 setState 并再触发一轮请求风暴（与文件内 genRef 守卫同一风格）。
    let alive = true
    const timer = window.setInterval(() => {
      void (async () => {
        if (!alive) return
        // 页面不可见时整轮跳过：省掉 fetch，也避免后台标签页白跑一轮生成。
        if (typeof document !== 'undefined' && document.hidden) return
        // Reuse the shared interpretation rather than a second copy of the
        // 404/`notFound` logic (v0.22.8) — three-valued since v0.24.x.
        const serverHas = await tiddlerExists(summaryTitle)
        if (!alive) return
        if (serverHas === 'unknown') {
          // 探测失败：不计失败（TW 重启期间会被瞬间烧完额度），也不清零（不能把
          // 「读不到」当成「一切正常」）——只提示状态未知，下一轮继续试。
          setProbeUnknown(true)
          return
        }
        if (serverHas === 'no') {
          failuresRef.current++
          if (failuresRef.current < MAX_MISSES) {
            void generate()
            return
          }
          // 连续失败到顶：不再自动重建，交还手动「🔄 刷新」（interval 保留，只做探测）。
          setPhase('error')
          setError('汇总条目已失效且自动重建多次失败，请点「🔄 刷新」重试')
          return
        }
        // 'yes'：条目还在，但内容可能仍是上次生成那一刻的快照（tab 一直开着时，
        // 此前只有「切走再切回重新挂载」才会更新）——超 REFRESH_MS 就按时间刷新
        // （silent：不闪 loading、不打断正在看的内容）。
        // 顺序要紧：先判断刷新、后清零失败计数。反过来（先清零）会让持续失败的
        // 后台刷新每 30s 就重置一次额度，退化成 30s 一次的重生成风暴。
        if (Date.now() - lastGeneratedRef.current > REFRESH_MS) {
          void generate({ silent: true })
          return
        }
        // 内容新鲜才算「一切正常」：清零失败额度并撤下降级提示。
        failuresRef.current = 0
        setProbeUnknown(false)
      })()
    }, SELF_HEAL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [summaryTitle, generate])

  // 一次性 focus 请求直接确认（本视图无可聚焦子目标，避免 shell 挂起）。
  React.useEffect(() => {
    if (viewRequest !== null && viewRequest !== undefined) completeViewRequest?.()
  }, [viewRequest, completeViewRequest])

  const refresh = (): void => {
    // 手动刷新 = 显式重来：清零连续失败计数，重新获得自动重试额度。
    failuresRef.current = 0
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
    // probeUnknown：探测失败时**不清掉**已渲染的内容，只在上面加一行降级提示
    // （v0.24.x——以前查询失败被当成「一切正常」，界面永远不知道 TW 是不是挂了）。
    content = React.createElement(
      'div',
      { className: 'dsh-tw-summary-native dsh-tw-toolcard-native' },
      probeUnknown
        ? React.createElement(
            'div',
            { className: 'dsh-tw-summary-state-detail' },
            '⚠️ 未能确认最新状态（wiki 查询或刷新失败），以下是上次生成的内容',
          )
        : null,
      React.createElement('div', { dangerouslySetInnerHTML: { __html: html ?? '' } }),
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
  setTabLabel(cfg.tabLabel)
  return slots.inject('conversation.view', () =>
    slots.register(
      { name: 'conversation.view', id: SESSION_SUMMARY_VIEW_ID, order: 20, label: labelThunk },
      SessionSummaryView,
    ),
  )
}

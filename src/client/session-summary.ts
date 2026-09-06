/**
 * 会话顶部「知识库」Tab（conversation.view 槽位，id `dsh-tiddlywiki-summary`）——
 * 把当前会话相关的 wiki 笔记汇总渲染进 TW 原生页面。
 *
 * 判定来源是 Host 路由 POST /dsh-tiddlywiki/session/summary：后端用 sessionQuery 读
 * 本会话（含后代 subagent）的事件日志，按「产生/读取/检索」收集 tiddlywiki_* 笔记，
 * 组装 TW wikitext 写入 volatile 的 `$:/temp/dsh/session-summary/<会话ID>`（不落盘、
 * 不进 git），前端只需把一个同源代理 iframe 指向
 * `<origin>/dsh-tiddlywiki/tw/#$:/temp/dsh/session-summary/<会话ID>`——TW 用自己
 * 主题/链接/导航原生渲染，不另造 UI（见 src/host/session-summary.ts）。
 *
 * 槽位注册（探查定稿）：`conversation.view` kind=list scope=session replaceRisk=none，
 * 官方留给第三方扩展；用新 id = 在「对话 | 轨迹」旁新增 tab（order 20），label 用
 * thunk 跟随 `ui.tabLabel` 配置（默认「知识库」）。进入 tab 自动触发生成，顶栏提供
 * 手动「刷新」。
 *
 * @module dsh-tiddlywiki/client/session-summary
 */
import * as React from 'react'
import { attachThemeSync } from './theme-sync.ts'

export const SESSION_SUMMARY_VIEW_ID = 'dsh-tiddlywiki-summary'
const SUMMARY_ENDPOINT = '/dsh-tiddlywiki/session/summary'
/** Same-origin TW proxy base（与 host TW_PROXY_PATH 一致，client 不能 import 它）。 */
const TW_PROXY_BASE = '/dsh-tiddlywiki/tw/'
const SESSION_SUMMARY_LABEL_DEFAULT = '知识库'

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

/** View 组件：生成汇总 → iframe 打开 TW 原生页；顶栏带手动刷新。 */
function SessionSummaryView(props: SessionSummaryViewProps): React.ReactElement {
  const { sessionId, viewRequest, completeViewRequest } = props
  const [phase, setPhase] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const [twUrl, setTwUrl] = React.useState<string | null>(null)
  const [error, setError] = React.useState('')
  const [frameNonce, setFrameNonce] = React.useState(0)
  const genRef = React.useRef(0)
  const themeDisposeRef = React.useRef<(() => void) | undefined>(undefined)

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
        setTwUrl(new URL(TW_PROXY_BASE, window.location.origin).href + '#' + encodeURIComponent(data.title))
        // 新 nonce 强制 iframe 重挂载 → 用最新汇总重新加载（含刷新场景）。
        setFrameNonce((n) => n + 1)
      }
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

  // 一次性 focus 请求直接确认（本视图无可聚焦子目标，避免 shell 挂起）。
  React.useEffect(() => {
    if (viewRequest !== null && viewRequest !== undefined) completeViewRequest?.()
  }, [viewRequest, completeViewRequest])

  // iframe 主题同步（同源代理，attachThemeSync 自处理 load/reapply）。
  const frameCallback = React.useCallback((el: HTMLIFrameElement | null) => {
    if (el === null) {
      themeDisposeRef.current?.()
      themeDisposeRef.current = undefined
      return
    }
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
    content = React.createElement('iframe', {
      key: frameNonce,
      ref: frameCallback,
      className: 'dsh-tw-summary-frame',
      src: twUrl ?? undefined,
      title: tabLabel,
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

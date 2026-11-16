/**
 * 消息内 ```tid / ```tiddlywiki 代码块 → 真 TiddlyWiki 预览（v0.36.0）。
 *
 * WHY
 * ---
 * DSH 0.2.2-rc.3 给客户端加了座位 `conversation.chat.markdown.fence`：**按语言**给
 * 聊天流里的一个 Markdown 代码块套外壳（宿主自己的 `diff`/`math`/`patch` 就是这么
 * 实现的）。我们的助手回复里经常整段贴 tiddler —— 以前只能看到一堆 `title:` 字段行
 * 和原始 wikitext（跟 `.tid` 侧栏预览（v0.32.0）遇到的是同一个问题），现在可以就地
 * 渲染成真 TW 内容。
 *
 * 契约（2026-11-16 从宿主 `app.asar` 的
 * `dsh-cordis-client-runner/lib/client.js` 座位目录逐字核实）
 * ------------------------------------------------------------------
 *   · 座位：`conversation.chat.markdown.fence`，`kind: hoc`，`scope: session`；
 *     `declaredBy` 是 `conversation.view`（聊天视图在，它就在）。
 *   · 注册选项：`{ name, id, key?, order? }` ——
 *     `id` **必填**（层标识：新 id = 加一层；复用官方 id = 顶掉那一层）；
 *     `key` 可选，是**派发键**，也就是代码块语言（省略则该层服务所有代码块）；
 *     `order` 升序嵌套，越小越靠外。同一个 id 下，精确 key 会取代通配层 —— 所以两种
 *     语言用**两个不同 id**，不去赌"一个 id 注册两次"的行为。
 *   · 宿主 props：`{ lang, code, streaming, meta?, children }`（外加一整套标准 props，
 *     我们只用 `sessionId` 这一条去定位知识库）。`children` 就是宿主没被顶掉时的
 *     原始代码块 —— **失败时把它原样还回去**，比任何自造兜底都可靠。
 *   · 官方已占用的 key（宿主 `keyDomain` 写明的）：`diff`、`math`、`patch`。
 *
 * 三条硬约束
 * ----------
 *   1. **流式输出期间不渲染**：宿主每来一个 token 就会重渲染这一层，`code` 还在变。
 *      这时直接还 `children`（原始代码块）：既没有请求风暴，也没有"越渲染越闪"。
 *   2. **绝不空白**：请求中 / 失败 / 没有正文，一律退回原始代码块；失败时额外加一句
 *      人话说明。白屏是沉默失败 —— 这一条优先级高于"好看"。
 *   3. **渲染必须走宿主 `/render`**（铁律 #7）：注入点是 DSH 同源页面，TW 原文绝不能
 *      直接进 DOM。复用 `render-fetch.ts` 的 `fetchRenderText()`（`POST /render`
 *      的唯一文本入口），客户端**不许**直连 `/tw/render`。
 *
 * @module dsh-tiddlywiki/client/tid-fence
 */
import * as React from 'react'
import { t } from './i18n.ts'
import { parseTidText } from './tid-parse.ts'
import { fetchRenderText } from './render-fetch.ts'
import { peekSessionWikiScope, resolveSessionWikiId } from './wiki-scope.ts'

/** 宿主座位名（`conversation.view` 声明，hoc/list-session 之外唯一按语言分派的座位）。 */
export const FENCE_SLOT = 'conversation.chat.markdown.fence'

/**
 * 我们接管哪几种代码块语言。
 *
 * `tid` 是 tiddler 文件格式（可能是 `title: …` 字段 + 空行 + 正文），`tiddlywiki`
 * 是人手写 wikitext 时最常用的语言标记。两个都**不在**官方已占用列表里。
 */
export const FENCE_LANGUAGES = ['tid', 'tiddlywiki'] as const

/** 层 id 前缀：`${前缀}${语言}` —— 每层一个 id，互不覆盖。 */
export const FENCE_LAYER_ID_PREFIX = 'dsh-tiddlywiki-fence-'

/** 宿主官方已占领的派发键（`keyDomain`：`already taken: diff, math, patch`）。 */
export const FENCE_TAKEN_LANGUAGES = ['diff', 'math', 'patch'] as const

/** 嵌套位置：比官方那几层大一点，落在它们内层（不改变官方层的行为）。 */
export const FENCE_ORDER = 100

/** 宿主传给这一层的内容 props（其余标准 props 我们不看）。 */
export interface FenceOwnerProps {
  /** 代码块语言（宿主已按「首个非 `[\w-]` 字符」截断并小写）。 */
  lang?: unknown
  /** 代码块正文（不含结尾换行）。 */
  code?: unknown
  /** 消息还在流式输出 ⇒ `code` 还会变。 */
  streaming?: unknown
  /** 所在会话 id（标准 props 之一）：用来查会话作用域的知识库。 */
  sessionId?: unknown
  /** 宿主原始代码块。 */
  children?: React.ReactNode
}

/** 一块代码要渲染成什么：可选标题 + 正文 wikitext。 */
export interface FenceDocument {
  title?: string
  text: string
}

/**
 * 把代码块正文变成「要渲染的 wikitext」。
 *
 * `tid` 语言可能带 frontmatter（`title:` 等字段），交给 `parseTidText()` —— 它同时
 * 负责"解析不出字段就整份当正文"这种宽容路径，绝不因为格式怪就丢内容。
 */
export function fenceDocumentOf(lang: string, raw: string): FenceDocument {
  if (lang !== 'tid') return { text: raw }
  const parsed = parseTidText(raw)
  const titled = parsed.title !== undefined && parsed.title.length > 0
  return { ...(titled ? { title: parsed.title } : {}), text: parsed.text }
}

/**
 * 造一个语言的预览层。
 *
 * ⚠️ 所有 hook 必须在任何 `return` **之前**：`streaming` 会从 true 变 false（流结束），
 * 早退之后再挂 hook 会让 hook 顺序在两次渲染间变化，React 会直接抛错。
 */
export function createFenceLayer(lang: string): (props: FenceOwnerProps) => React.ReactNode {
  return function TidFenceLayer(props: FenceOwnerProps): React.ReactNode {
    const code = typeof props.code === 'string' ? props.code : ''
    const streaming = props.streaming === true
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
    const doc = React.useMemo(() => fenceDocumentOf(lang, code), [code])
    const [html, setHtml] = React.useState<string | null>(null)
    const [failed, setFailed] = React.useState(false)
    const [showSource, setShowSource] = React.useState(false)

    React.useEffect(() => {
      let alive = true
      setHtml(null)
      setFailed(false)
      const body = doc.text.trim()
      if (streaming || body.length === 0) return () => { alive = false }
      // 会话作用域用它自己的知识库（多库下渲染另一库的同名模板会岔）。缓存没命中就
      // 顺手补一次读取（fire-and-forget，不 await：这一层是渲染路径，不许被网络卡住）——
      // 下一次渲染就有 `?wiki=` 了。
      const peek = peekSessionWikiScope(sessionId)
      if (!peek.ready) void resolveSessionWikiId(sessionId)
      void fetchRenderText(body, 15_000, peek.resolved ?? peek.scope).then((next) => {
        if (!alive) return
        if (next === null) {
          setFailed(true)
          setHtml(null)
        } else {
          setHtml(next)
        }
      })
      return () => { alive = false }
    }, [doc.text, streaming, sessionId])

    // 流式 / 空正文：把宿主的原始代码块原样还回去（不包壳、不发请求）。
    if (streaming || doc.text.trim().length === 0) return props.children ?? null

    // 原始代码块：优先用宿主给的那一个（它有复制按钮等原生交互），没有才自造 <pre>。
    const source = props.children ?? React.createElement('pre', { className: 'dsh-tw-fence-source' }, code)

    let body: React.ReactNode
    if (showSource) {
      body = source
    } else if (failed) {
      body = React.createElement(
        React.Fragment,
        null,
        React.createElement('div', { className: 'dsh-tw-fence-note' }, t('frame.tidPreviewFallback')),
        source,
      )
    } else if (html === null) {
      // 请求在路上：先给原文，别让这一层出现一段空壳。
      body = source
    } else {
      // `dsh-tw-toolcard-native` 是仓库里那份「TW 原生片段重主题」（tc-* 类）；
      // 与回复流工具卡 / 会话「知识库」Tab 共用，避免第二套渲染样式分叉。
      body = React.createElement('div', {
        className: 'dsh-tw-fence-body dsh-tw-toolcard-native',
        dangerouslySetInnerHTML: { __html: html },
      })
    }

    const head = [
      React.createElement('span', { key: 'label', className: 'dsh-tw-fence-label' }, t('frame.fenceTitle')),
      doc.title === undefined
        ? null
        : React.createElement('span', { key: 'title', className: 'dsh-tw-fence-title' }, doc.title),
      React.createElement('span', { key: 'spacer', className: 'dsh-tw-fence-spacer' }),
      React.createElement(
        'button',
        {
          key: 'toggle',
          type: 'button',
          className: 'dsh-tw-fence-toggle',
          onClick: () => { setShowSource((prev) => !prev) },
        },
        showSource ? t('frame.fenceShowPreview') : t('frame.fenceShowSource'),
      ),
    ]

    return React.createElement(
      'div',
      { className: 'dsh-tw-fence', 'data-dsh-tw-fence': lang },
      React.createElement('div', { className: 'dsh-tw-fence-head' }, ...head),
      body,
    )
  }
}

/** 我们需要的 `ctx.slots` 片段（hoc 座位的注册形状：`id` 必填、`key` 是派发键）。 */
export interface FenceSlotsFace {
  inject(name: string, register: () => unknown): (() => void) | undefined
  register(
    opts: { name: string; id?: string; key?: string; order?: number },
    component: unknown,
  ): (() => void) | undefined
}

/**
 * 把每种语言各注册成一层。
 *
 * 宿主没有这个座位时 `slots.inject()` 拿不到声明、返回 `undefined` —— 那正是老版本
 * DSH（0.2.2-rc.2 之前）的形态，这里**静默跳过**：插件其余功能一个字节都不变。
 */
export function registerTidFences(slots: FenceSlotsFace): Array<() => void> {
  const disposers: Array<() => void> = []
  for (const lang of FENCE_LANGUAGES) {
    if ((FENCE_TAKEN_LANGUAGES as readonly string[]).includes(lang)) {
      // 写死也不可能发生（两个常量是并排声明的），但注册前挡住比顶掉官方卡片好。
      console.warn('[dsh-tiddlywiki] tid fence: refusing to claim the shipped language ' + lang)
      continue
    }
    const dispose = slots.inject(FENCE_SLOT, () =>
      slots.register(
        { name: FENCE_SLOT, id: `${FENCE_LAYER_ID_PREFIX}${lang}`, key: lang, order: FENCE_ORDER },
        createFenceLayer(lang),
      ),
    )
    if (dispose === undefined) {
      // 开发者日志（不是用户文案）：老宿主没有这个座位，属预期。
      console.warn('[dsh-tiddlywiki] tid fence: slot ' + FENCE_SLOT + ' is not declared by this host; skipping ' + lang)
      continue
    }
    disposers.push(dispose)
  }
  return disposers
}

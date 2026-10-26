/**
 * 把插件的文案目录注册进**宿主的 locale 服务**（v0.33.0，⑥b 的落地方式）。
 *
 * WHY THIS SHAPE, AND NOT A FULL MIGRATION
 * ---------------------------------------
 * 官方契约是 `ctx.locale.register(ns, { zh, en })`，并且要求命名空间先并入
 * `LocaleNamespaceMap` 由**编译器**按类型化键并集校验。本插件的客户端是 esbuild 产出的
 * **单文件、无 .d.ts**，参与不了那个类型合并 —— 直接迁过去等于把
 * `scripts/verify-client-i18n.mjs` 现有的键名校验（zh/en 键集合一致、每个 `t('…')`
 * 的键都存在、没有未使用键、无残留中文）换成零校验。
 *
 * 所以这里做的是「**注册，但不搬**」：
 *   · 目录仍然只有一份（`i18n-catalog.ts` 的 7 个分片）——宿主与本地共用同一个对象，
 *     不存在"搬一半、两份说法不一致"的中间态；
 *   · 宿主**有** locale 服务时，`t()` 先问它（语言切换由宿主运行时说了算）；
 *     拿不到、抛错、或回了个空串/键名本身，就退回本地表 —— 行为与 v0.32.0 完全一致；
 *   · 宿主**没有**该服务时（老版本 DSH）静默跳过，一个字节都不影响。
 *
 * 这条路径让"改语言即时生效"在宿主支持时自然生效，同时**不放弃**任何一条现有守门。
 *
 * @module dsh-tiddlywiki/client/i18n-host
 */
import { MESSAGES } from './i18n-catalog.ts'

/** 宿主 locale 服务里的命名空间（与插件名一致，便于排查）。 */
export const LOCALE_NAMESPACE = 'dsh-tiddlywiki'

/** 两套内置语言（与 `i18n.ts` 的 `Lang` 同形状；这里独立声明以免循环 import）。 */
export type LocaleLang = 'zh' | 'en'

/** 宿主 locale 服务的结构面（不 import @deepseek-ai）。 */
export interface LocaleServiceFace {
  /** 注册一个命名空间的两套内置语言。 */
  register?: (namespace: string, catalogs: Record<LocaleLang, Record<string, string>>) => unknown
  /**
   * 绑定命名空间，返回一个 `t`。
   *
   * 这是**可选**的：不同版本的宿主可能只有 `register`（早于 `bind`），那种情况下
   * 我们只注册、不消费，`t()` 继续用本地表。
   */
  bind?: (namespace: string) => ((key: string, vars?: Record<string, string | number>) => string) | undefined
}

let hostTranslate: ((key: string, vars?: Record<string, string | number>) => string) | undefined

/** 宿主是否已经提供了解析器（诊断/守门用）。 */
export function hasHostTranslator(): boolean {
  return hostTranslate !== undefined
}

/**
 * 注册目录并（若可用）接上宿主的 `t`。
 *
 * @param get 宿主的可选服务读取器（`ctx.get`）。未提供时直接跳过。
 * @returns 需要回收的 disposer 列表（可能为空）。
 */
export function registerLocaleWithHost(get: ((name: string) => unknown) | undefined): Array<() => void> {
  // 每次注册尝试都从"没有宿主解析器"开始：失败/服务缺失时不能留着上一次绑定的
  // 旧解析器（那会让 `t()` 继续问一个已经不存在的命名空间）。
  hostTranslate = undefined
  if (get === undefined) return []
  let service: LocaleServiceFace | undefined
  try {
    service = get('locale') as LocaleServiceFace | undefined
  } catch {
    return []
  }
  if (service === undefined || service === null) return []

  const disposers: Array<() => void> = []
  try {
    const maybeDispose = service.register?.(LOCALE_NAMESPACE, MESSAGES)
    if (typeof maybeDispose === 'function') disposers.push(maybeDispose as () => void)
  } catch (err) {
    // 注册失败只记日志：文案必须继续可用（本地表就是兜底）。
    console.warn('[dsh-tiddlywiki] locale registration failed:', err)
    return disposers
  }
  try {
    const bound = service.bind?.(LOCALE_NAMESPACE)
    if (typeof bound === 'function') hostTranslate = bound
  } catch (err) {
    console.warn('[dsh-tiddlywiki] locale bind failed:', err)
  }
  return disposers
}

/**
 * 解析一条文案：**先问宿主，再回本地表**。
 *
 * 宿主回空串、回键名本身、或直接抛错 —— 都视为"没有这条"，退回本地目录。
 * 这样即使宿主将来改了行为，界面最差也只是退回 v0.32.0 的样子，不会变空。
 */
export function translate(
  key: string,
  vars: Record<string, string | number> | undefined,
  local: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (hostTranslate !== undefined) {
    try {
      const fromHost = hostTranslate(key, vars)
      if (typeof fromHost === 'string' && fromHost.length > 0 && fromHost !== key) return fromHost
    } catch {
      /* 宿主解析失败 ≠ 文案缺失：落到本地表 */
    }
  }
  return local(key, vars)
}

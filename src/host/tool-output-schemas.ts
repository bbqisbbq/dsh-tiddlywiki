/**
 * 工具**输出** schema（v0.30.66）。
 *
 * WHY THIS EXISTS
 * ---------------
 * `defineTool` 的 `output.schema` 以前被写死成 `{}`（v0.20.0 的判断是"注册表不读它"）。
 * DSH 0.2.1 的 `createSuccessResult` 会真的跑
 * `validateJsonSchemaValue(tool.output.schema, value)` —— 校验不过就抛
 * `ToolOutputError`，工具调用直接失败。也就是说：**写实 schema 等于白送一层
 * 「execute 返回的形状」出口校验**，抓的是「render 与 value 漂移」这类事故
 * （返回了错 key / 错类型，而回执看着一切正常 —— v0.26.5 的 `fields` 按字符拆
 * 就是这一类的极端案例）。
 *
 * THE RULE (read before adding a field)
 * -------------------------------------
 * 只声明「**必定存在且类型稳定**」的字段：
 *   · 可空字段（`type: string | null`）**不进来** —— 我们面向作者的 spec DSL 没有
 *     union/oneOf 分支，硬塞会把 null 判成错；
 *   · 可选字段（`?:`）也不进来；
 *   · 每个对象都 `additionalProperties: true`，未知字段一律放行。
 *
 * 所以这些 schema 抓的是「该在的不在 / 在的类型错了」，**不是**完整契约建模。
 * 想收紧某一条时，先确认那条真的在**所有**返回路径上都存在（包括失败路径）。
 *
 * @module dsh-tiddlywiki/host/tool-output-schemas
 */
import type { ValueSpec } from '../sdk.ts'

const STRINGS: ValueSpec = { type: 'array', items: { type: 'string' } }

/** 一条检索/最近命中。`modified` 可空 → 不声明。 */
const HIT: ValueSpec = {
  type: 'object',
  additionalProperties: true,
  properties: { title: { type: 'string' }, tags: STRINGS, snippet: { type: 'string' } },
}

export const SEARCH_RESULT: ValueSpec = {
  type: 'object',
  additionalProperties: true,
  properties: {
    query: { type: 'string' },
    total: { type: 'number' },
    scope: { type: 'string', enum: ['workspace', 'all'] },
    fellBack: { type: 'boolean' },
    results: { type: 'array', items: HIT },
    tags: STRINGS,
  },
}

export const RECENT_RESULT: ValueSpec = {
  type: 'object',
  additionalProperties: true,
  properties: { results: { type: 'array', items: HIT } },
}

export const TAG_LIST_RESULT: ValueSpec = {
  type: 'object',
  additionalProperties: true,
  properties: {
    count: { type: 'number' },
    total: { type: 'number' },
    truncated: { type: 'boolean' },
    tags: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: { tag: { type: 'string' }, count: { type: 'number' } },
      },
    },
  },
}

export const GET_RESULT: ValueSpec = {
  type: 'object',
  additionalProperties: true,
  properties: {
    notFound: { type: 'boolean' },
    title: { type: 'string' },
    text: { type: 'string' },
    textTotalChars: { type: 'number' },
    offset: { type: 'number' },
    tags: STRINGS,
    fields: { type: 'object', additionalProperties: true },
  },
}

export const PUT_RESULT: ValueSpec = {
  type: 'object',
  additionalProperties: true,
  properties: { ok: { type: 'boolean' }, title: { type: 'string' }, tags: STRINGS },
}

export const BATCH_RESULT: ValueSpec = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    written: { type: 'number' },
    skipped: { type: 'number' },
    failed: { type: 'number' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          title: { type: 'string' },
          written: { type: 'boolean' },
          skipped: { type: 'boolean' },
          failed: { type: 'boolean' },
        },
      },
    },
  },
}

export const APPEND_RESULT: ValueSpec = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    title: { type: 'string' },
    mode: { type: 'string', enum: ['append', 'prepend'] },
    created: { type: 'boolean' },
    added: { type: 'number' },
    total: { type: 'number' },
  },
}

export const REPLACE_RESULT: ValueSpec = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    title: { type: 'string' },
    replaced: { type: 'number' },
    found: { type: 'boolean' },
    total: { type: 'number' },
  },
}

export const RENAME_RESULT: ValueSpec = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    from: { type: 'string' },
    to: { type: 'string' },
    refsUpdated: { type: 'number' },
    refsTiddlers: { type: 'number' },
  },
}

export const DELETE_RESULT: ValueSpec = {
  type: 'object',
  additionalProperties: true,
  properties: { ok: { type: 'boolean' }, title: { type: 'string' } },
}

export const TRASH_RESULT: ValueSpec = {
  type: 'object',
  additionalProperties: true,
  properties: { action: { type: 'string' }, message: { type: 'string' } },
}

export const BACKLINK_RESULT: ValueSpec = {
  type: 'object',
  additionalProperties: true,
  properties: {
    title: { type: 'string' },
    total: { type: 'number' },
    linkCount: { type: 'number' },
    tagCount: { type: 'number' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          title: { type: 'string' },
          refs: { type: 'number' },
          via: { type: 'string', enum: ['link', 'tag'] },
        },
      },
    },
  },
}

export const ATTACH_RESULT: ValueSpec = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    title: { type: 'string' },
    mime: { type: 'string' },
    bytes: { type: 'number' },
    chars: { type: 'number' },
    encoding: { type: 'string', enum: ['text', 'base64'] },
  },
}

export const LINT_RESULT: ValueSpec = {
  type: 'object',
  additionalProperties: true,
  properties: {
    scanned: { type: 'number' },
    checks: STRINGS,
    unknownChecks: STRINGS,
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          kind: { type: 'string' },
          count: { type: 'number' },
          hint: { type: 'string' },
          samples: STRINGS,
        },
      },
    },
  },
}

/**
 * git 工具：只有 `ok` + `message` 在**每一条**返回路径上（成功、无远端、冲突、
 * 异常）都存在，其余字段都是按情况出现（`push`/`changed`/`restartFailed`…）。
 */
export const GIT_RESULT: ValueSpec = {
  type: 'object',
  additionalProperties: true,
  properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
}

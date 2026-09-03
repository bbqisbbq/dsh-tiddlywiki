/**
 * Self-contained replacements for the @deepseek-ai runtime imports the host
 * half must NEVER take from npm-mirror SDK packages (dsh-home-paths,
 * dsh-tools' defineTool).
 *
 * Why (design doc §4.4, taskboard lesson): a published copy must not resolve
 * `@deepseek-ai/dsh-tools` from the profile's node_modules — an npm-mirror
 * dsh-tools there shadows the CLI-internal build for the WHOLE base layer and
 * breaks the agent loop. Everything here is a pure, structure-compatible
 * reimplementation of the exact behavior the registry relies on:
 *
 * - `dshHomePath` mirrors `join(resolve(env.DSH_HOME ?? ~/.dsh), ...segments)`;
 * - `defineTool` compiles author-facing parameter specs into the same raw
 *   JSON-Schema subset the registry expects and pre-validates model arguments.
 *
 * @module dsh-tiddlywiki/sdk
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The DSH user home (DSH_HOME overrides). */
export function dshHomePath(...segments: string[]): string {
  const override = process.env.DSH_HOME
  const home = resolve(override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh'))
  return join(home, ...segments)
}

/** Author-facing scalar spec. */
interface ScalarSpec {
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'null'
  readonly description?: string
  readonly enum?: readonly unknown[]
  readonly const?: unknown
}

/** Author-facing object spec (additionalProperties is mandatory). */
interface ObjectSpec {
  readonly type: 'object'
  readonly additionalProperties: boolean
  readonly description?: string
  /** Nested properties may also declare `required` (array items etc.). */
  readonly properties?: Readonly<Record<string, ParameterSpec>>
}

/** Author-facing value spec. */
type ValueSpec = ScalarSpec | ObjectSpec | { readonly type: 'json'; readonly description?: string } | { readonly type: 'array'; readonly items?: ValueSpec; readonly description?: string }

/** Author-facing parameter entry (a value spec plus top-level required). */
type ParameterSpec = ValueSpec & { readonly required?: boolean }

/** Raw JSON-Schema subset node. */
type RawSchema = Record<string, unknown>

/** Compile one value spec to the raw subset (json → annotation-only). */
function compileValue(spec: ValueSpec): RawSchema {
  const node: RawSchema = {}
  const description = (spec as { description?: string }).description
  if (typeof description === 'string' && description.length > 0) node.description = description
  const type = (spec as { type?: string }).type
  if (type === undefined || type === 'json') return node
  if (type === 'object') {
    const objectSpec = spec as ObjectSpec
    node.type = 'object'
    node.additionalProperties = objectSpec.additionalProperties
    if (objectSpec.properties !== undefined) {
      const compiled = compilePropertyMap(objectSpec.properties)
      node.properties = compiled.properties
      // Nested objects also carry their own `required` list (array items, etc.).
      if (compiled.required !== undefined) node.required = compiled.required
    }
    return node
  }
  if (type === 'array') {
    node.type = 'array'
    const items = (spec as { items?: ValueSpec }).items
    if (items !== undefined) node.items = compileValue(items)
    return node
  }
  node.type = type
  const enumValues = (spec as ScalarSpec).enum
  if (enumValues !== undefined) node.enum = [...enumValues]
  const constValue = (spec as ScalarSpec).const
  if (constValue !== undefined) node.const = constValue
  return node
}

/** Compile a property map: properties + collected required list. */
function compilePropertyMap(spec: Readonly<Record<string, ParameterSpec>>): { properties: Record<string, RawSchema>; required?: string[] } {
  const properties: Record<string, RawSchema> = {}
  const required: string[] = []
  for (const [name, entry] of Object.entries(spec)) {
    const { required: isRequired, ...valueSpec } = entry as ParameterSpec & Record<string, unknown>
    properties[name] = compileValue(valueSpec as ValueSpec)
    if (isRequired === true) required.push(name)
  }
  return required.length > 0 ? { properties, required } : { properties }
}

/** Does a JS value match a raw-subset scalar type? */
function matchesScalarType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number'
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return true
  }
}

/** Validate a value against the compiled subset; returns path-qualified violations. */
function validateValue(schema: RawSchema, value: unknown, path: string): string[] {
  if (typeof schema.type !== 'string' || schema.type.length === 0) return []
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path} must be an object`]
    const violations: string[] = []
    const present = value as Record<string, unknown>
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in present)) violations.push(`${path}.${key} is required`)
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys((schema.properties as Record<string, RawSchema> | undefined) ?? {}))
      for (const key of Object.keys(present)) {
        if (!known.has(key)) violations.push(`${path}.${key} is not a declared property`)
      }
    }
    for (const [key, child] of Object.entries((schema.properties as Record<string, RawSchema> | undefined) ?? {})) {
      if (key in present) violations.push(...validateValue(child, present[key], `${path}.${key}`))
    }
    return violations
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path} must be an array`]
    const violations: string[] = []
    const items = schema.items as RawSchema | undefined
    if (items !== undefined) {
      value.forEach((item, index) => { violations.push(...validateValue(items, item, `${path}[${index}]`)) })
    }
    return violations
  }
  if (!matchesScalarType(value, schema.type)) return [`${path} must be ${schema.type}`]
  const enumValues = schema.enum as unknown[] | undefined
  if (enumValues !== undefined && !enumValues.some(v => v === value)) {
    return [`${path} must be one of ${enumValues.map(String).join(', ')}`]
  }
  const constValue = (schema as { const?: unknown }).const
  if (constValue !== undefined && constValue !== value) {
    return [`${path} must be ${String(constValue)}`]
  }
  return []
}

/** Options shape we consume (a structural subset of the SDK's defineTool). */
export interface DefineToolOptions<A, V> {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, ParameterSpec>>
  readonly output: {
    readonly schema: { readonly type: 'json' }
    render(args: A, value: V): Array<{ type: 'text'; text: string }>
  }
  execute(args: A, exec: unknown): Promise<V>
}

/** A registry-ready tool definition (structure-compatible with the SDK's). */
export interface ToolDefinition<A = unknown, V = unknown> {
  readonly name: string
  readonly description: string
  readonly parameters: RawSchema
  readonly output: {
    readonly schema: RawSchema
    render(args: A, value: V): Array<{ type: 'text'; text: string }>
  }
  execute(args: A, exec: unknown): Promise<V>
}

/**
 * Define a first-party tool: compile the parameter spec, pre-validate
 * arguments, and pass through the execution.
 */
export function defineTool<A extends Record<string, unknown>, V>(options: DefineToolOptions<A, V>): ToolDefinition<A, V> {
  const compiled = compilePropertyMap(options.parameters as Readonly<Record<string, ParameterSpec>>)
  const parameters: RawSchema = { type: 'object', properties: compiled.properties }
  if (compiled.required !== undefined) parameters.required = compiled.required
  const userExecute = options.execute
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: {},
      render(args, value) {
        return options.output.render(args, value)
      },
    },
    async execute(args, exec) {
      const violations = validateValue(parameters, args, 'arguments')
      if (violations.length > 0) {
        throw new Error(`Error: invalid arguments: ${violations.join('; ')}`)
      }
      return userExecute(args, exec)
    },
  }
}

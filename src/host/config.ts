/**
 * Extensible plugin config (design doc §13, config panel).
 *
 * Two layers:
 *   base      — the cordis `config:` block (profile composition, defaults);
 *   overrides — a user-editable config tiddler ($:/plugins/dsh-tiddlywiki/config,
 *               a JSON string) written by the settings page.
 * The tiddler overlays the base (tiddler wins), so future config fields just
 * extend the shape — no schema, no @deepseek-ai dependency, and the config
 * travels with the wiki's git history.
 *
 * @module dsh-tiddlywiki/host/config
 */
import type { TiddlyWebClient } from './tw-api.ts'

/** Config tiddler (JSON string) where the settings page stores overrides. */
export const CONFIG_TIDDLER = '$:/plugins/dsh-tiddlywiki/config'

/** Extensible, loose plugin config shape (future fields just appear here). */
export interface PluginConfigShape {
  note?: { tag?: string }
  git?: { autoCommit?: boolean; debounceMs?: number; remote?: string; branch?: string }
  uiLanguage?: string
  [key: string]: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deep-merge: `over` wins; nested plain objects merge recursively. */
export function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key] as Record<string, unknown>, value)
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * Runtime config store: caches the override tiddler and exposes the effective
 * (merged) config. `load` runs at startup and after every write/restart.
 */
export class ConfigStore {
  private overrides: PluginConfigShape = {}

  constructor(private readonly base: PluginConfigShape) {}

  /** Effective config = cordis base overlaid with the user override tiddler. */
  get(): PluginConfigShape {
    return deepMerge(this.base, this.overrides) as PluginConfigShape
  }

  /** Reload the override tiddler (no-op when the wiki is unavailable). */
  async load(client: TiddlyWebClient | undefined): Promise<void> {
    this.overrides = {}
    if (client === undefined) return
    try {
      const tiddler = await client.get(CONFIG_TIDDLER)
      if (tiddler !== undefined && typeof tiddler.text === 'string') {
        const parsed = JSON.parse(tiddler.text) as unknown
        if (isPlainObject(parsed)) this.overrides = parsed as PluginConfigShape
      }
    } catch {
      // Wiki not ready or config tiddler unreadable → keep empty overrides.
      this.overrides = {}
    }
  }

  /** Merge a patch into the overrides and persist the tiddler. */
  async set(client: TiddlyWebClient, patch: PluginConfigShape): Promise<PluginConfigShape> {
    this.overrides = deepMerge(this.overrides, patch) as PluginConfigShape
    await client.put({
      title: CONFIG_TIDDLER,
      text: JSON.stringify(this.overrides, null, 2),
      type: 'application/json',
      tags: [],
    })
    return this.get()
  }
}

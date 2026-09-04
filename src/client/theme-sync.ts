/**
 * Adaptive DSH theme for the embedded TiddlyWiki iframes (design doc §12).
 *
 * Both the center-column panel and the quick-note editor popup embed the
 * SAME-ORIGIN TW proxy, so this module can reach the TW runtime directly
 * (`iframe.contentWindow.$tw`) and drive its native theming.
 *
 * How TW theming works
 * --------------------
 * TW 5 renders its colours through the ACTIVE palette: `$:/palette` holds the
 * title of a palette tiddler (`$:/palettes/…`), and every `<<colour x>>` in
 * the theme stylesheet resolves against that tiddler at render time. TW
 * re-renders all stylesheets live on any tiddler change, so flipping
 * `$:/palette` re-themes the whole embedded UI instantly — the exact mechanism
 * TW's own palette switcher uses. Overriding the rendered CSS variables is a
 * dead end for the default Vanilla theme because its base stylesheet bakes the
 * palette values in as literals; switching the palette is the supported path.
 *
 * DSH theme detection
 * -------------------
 * The DSH shell's ThemePresenter projects the resolved theme onto the page:
 * `data-ds-dark-theme` on <body> (dark) plus an inline `color-scheme` on
 * <html> that is always "light"|"dark" (the "system" preference is resolved
 * upstream). Those two signals are authoritative; `prefers-color-scheme` is
 * only a fallback when neither is present (no DSH theming projected).
 *
 * Non-persistence
 * ---------------
 * `$:/palette` IS included in TW's default sync filter, so a naive write would
 * be PUT back to the TiddlyWeb server and land in the wiki's git history on
 * every theme toggle. We suppress that: the syncer's dirty check is
 * `getChangeCount(title) > tiddlerInfo[title].changeCount`, and the change
 * event that would drive the save is dispatched on a microtask — so after
 * writing we synchronously re-align the recorded changeCount and the syncer
 * sees the tiddler as already clean. The flip stays in-memory only; the wiki's
 * stored palette and the user's choice are never modified.
 *
 * @module dsh-tiddlywiki/client/theme-sync
 */

/** Default dark palette used when DSH is dark (overridable in settings). */
export const DARK_PALETTE_DEFAULT = '$:/palettes/CupertinoDark'
/** Fallback light palette when no user palette was ever captured. */
export const LIGHT_PALETTE_FALLBACK = '$:/palettes/Vanilla'

/** DSH's dark-mode marker (set/removed on <body> by dsh-client-ui-layout). */
const DARK_ATTR = 'data-ds-dark-theme'
/** The TW tiddler holding the active palette tiddler title. */
const PALETTE_TIDDLER = '$:/palette'

/** Minimal structural face over TW's runtime globals inside the iframe. */
interface TwRuntime {
  $tw?: {
    wiki: {
      getTiddlerText(title: string): string | undefined
      getTiddler(title: string): { fields?: Record<string, unknown> } | undefined
      /** TW 5.4.1 has no setTiddlerText; setText(title,'text',…) routes through
       *  addTiddler and bumps changeCount + dispatches the change event. */
      setText(title: string, field: string | undefined, index: string | undefined, value: string | undefined): void
      getChangeCount(title: string): number
    }
    syncer?: {
      tiddlerInfo?: Record<string, { changeCount?: number; revision?: unknown; timestampLastSaved?: Date }>
      syncadaptor?: {
        saveTiddler: (tiddler: { fields?: Record<string, unknown> }, callback: (err: unknown, adaptorInfo: unknown, revision: number) => void) => void
      }
    }
  }
}

/** Appliers registered for live frames; config changes re-apply to all. */
const frameAppliers = new Set<() => void>()
/** Syncers already wrapped with the palette save guard (per iframe window). */
const guardedSyncers = new WeakSet<object>()
/** Remembered user palette (light) that we restore when leaving dark mode. */
let userLightPalette = ''
/** Whether the adaptive feature is on (settings `ui.followDshTheme`). */
let syncEnabled = true
/** Configured dark palette (settings `ui.darkPalette`). */
let darkPalette = DARK_PALETTE_DEFAULT

/**
 * Resolve the DSH shell's current effective dark state. The body attribute
 * and the inline root `color-scheme` projected by the ThemePresenter are
 * authoritative; the OS media query only answers when DSH isn't projecting a
 * theme snapshot (plain embed / non-DSH page).
 */
function readDshDark(): boolean {
  try {
    const root = document.documentElement
    const body = document.body
    if (body !== null && body.hasAttribute(DARK_ATTR)) return true
    if (root !== null) {
      const scheme = root.style.getPropertyValue('color-scheme').trim().toLowerCase()
      if (scheme === 'dark') return true
      if (scheme === 'light') return false
    }
  } catch {
    // DOM not ready or not present (e.g. smoke harness) → fall through.
  }
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

/** Active palette tiddler title (falls back to the light default). */
function activePaletteTitle($tw: NonNullable<TwRuntime['$tw']>): string {
  try {
    const title = $tw.wiki.getTiddlerText(PALETTE_TIDDLER)
    return typeof title === 'string' && title.trim().length > 0 ? title.trim() : LIGHT_PALETTE_FALLBACK
  } catch {
    return LIGHT_PALETTE_FALLBACK
  }
}

/** True when the active palette tiddler declares `color-scheme: dark`. */
function activePaletteIsDark($tw: NonNullable<TwRuntime['$tw']>): boolean {
  try {
    const fields = $tw.wiki.getTiddler(activePaletteTitle($tw))?.fields
    return fields !== undefined && fields['color-scheme'] === 'dark'
  } catch {
    return false
  }
}

/**
 * Mark `$:/palette` as clean in the syncer's records so a FORCED flip is never
 * PUT back to the TiddlyWeb server. Runs synchronously right after the write,
 * before the microtask-dispatched change event lets the syncer evaluate
 * dirtiness; user-initiated palette changes (bumped afterwards) still sync.
 */
function suppressPaletteSync($tw: NonNullable<TwRuntime['$tw']>): void {
  try {
    const syncer = $tw.syncer
    if (syncer?.tiddlerInfo === undefined) return
    const changeCount = $tw.wiki.getChangeCount(PALETTE_TIDDLER)
    const info = syncer.tiddlerInfo[PALETTE_TIDDLER]
    if (info !== undefined) info.changeCount = changeCount
    else syncer.tiddlerInfo[PALETTE_TIDDLER] = { changeCount }
  } catch {
    // Best-effort; the rare worst case is a single persisted flip.
  }
}

/**
 * Install a one-shot guard on this frame's syncadaptor: while a palette WE
 * forced is active (`userLightPalette` captured), a PUT of `$:/palette` whose
 * text is still our forced dark palette is swallowed instead of reaching the
 * TiddlyWeb server. This makes the non-persistence guarantee deterministic —
 * TW's boot-time sync (which may load `$:/palette` from the server and bump its
 * changeCount AFTER our re-align) can otherwise queue a save of the forced
 * palette during the first ~1s. Idempotent per syncer instance.
 */
function installPaletteSaveGuard($tw: NonNullable<TwRuntime['$tw']>): void {
  try {
    const syncer = $tw.syncer
    const adaptor = syncer?.syncadaptor
    if (syncer === undefined || adaptor === undefined || guardedSyncers.has(syncer)) return
    const origSave = adaptor.saveTiddler.bind(adaptor)
    adaptor.saveTiddler = (tiddler, callback): void => {
      const suppressed =
        syncEnabled &&
        userLightPalette.length > 0 &&
        tiddler?.fields?.title === PALETTE_TIDDLER &&
        tiddler?.fields?.text === darkPalette
      if (suppressed) {
        // Fake a successful save (revision 0 = unchanged on the server); the
        // SaveTiddlerTask re-records tiddlerInfo with the current changeCount,
        // so the syncer's accounting stays consistent and no task is re-created.
        callback(null, {}, 0)
        return
      }
      origSave(tiddler, callback)
    }
    guardedSyncers.add(syncer)
  } catch {
    // Guard is best-effort; the changeCount re-align below still covers steady state.
  }
}

/** Write the active palette (no-op when unchanged) without persisting. */
function setPalette($tw: NonNullable<TwRuntime['$tw']>, target: string): void {
  try {
    if (activePaletteTitle($tw) === target) return
    $tw.wiki.setText(PALETTE_TIDDLER, 'text', undefined, target)
    suppressPaletteSync($tw)
  } catch {
    // TW may be mid-render; the next apply pass will retry.
  }
}

/**
 * Drive `$:/palette` toward the DSH theme. In dark mode a light palette is
 * swapped for `darkPalette` (remembering the user's palette first); in light
 * mode a palette WE forced is restored, while a user-chosen dark palette is
 * left alone.
 */
function applyPalette($tw: NonNullable<TwRuntime['$tw']>, dark: boolean): void {
  const current = activePaletteTitle($tw)
  if (dark) {
    if (activePaletteIsDark($tw)) return // user already on a dark palette
    if (current !== darkPalette) userLightPalette = current // remember their light choice
    setPalette($tw, darkPalette)
  } else if (activePaletteIsDark($tw) && current === darkPalette && userLightPalette.length > 0) {
    // We forced this dark palette (and captured the user's light choice before
    // doing so) → restore it. A user who picked the dark palette themselves is
    // never captured, so their choice is left alone.
    setPalette($tw, userLightPalette)
  }
}

/** Keep the iframe's native `color-scheme` in step with the ACTIVE palette. */
function syncColorScheme($tw: NonNullable<TwRuntime['$tw']>, frame: HTMLIFrameElement): void {
  try {
    const html = frame.contentDocument?.documentElement
    if (html === undefined || html === null) return
    const paletteIsDark = activePaletteIsDark($tw)
    const target = paletteIsDark ? 'dark' : 'light'
    if (html.style.getPropertyValue('color-scheme') !== target) html.style.setProperty('color-scheme', target)
  } catch {
    // Cross-frame / not-yet-loaded edge cases are retried on the next pass.
  }
}

/** Apply the current DSH theme to one TW iframe (no-op until TW is ready). */
function applyToFrame(frame: HTMLIFrameElement): void {
  const $tw = (frame.contentWindow as TwRuntime | null)?.$tw
  if ($tw === undefined || $tw.wiki === undefined) return
  installPaletteSaveGuard($tw)
  if (syncEnabled) {
    applyPalette($tw, readDshDark())
  } else {
    // Feature off → undo any palette we forced (leave the user's own choice).
    applyPalette($tw, false)
  }
  syncColorScheme($tw, frame)
}

/**
 * Configure the feature and re-apply to every live frame. `enabled` is the
 * settings `ui.followDshTheme`; `darkPalette` the settings `ui.darkPalette`.
 */
export function setThemeSyncConfig(opts: { enabled?: boolean; darkPalette?: string }): void {
  const enabled = opts.enabled !== false
  const palette =
    typeof opts.darkPalette === 'string' && opts.darkPalette.trim().length > 0 ? opts.darkPalette.trim() : DARK_PALETTE_DEFAULT
  const changed = enabled !== syncEnabled || palette !== darkPalette
  syncEnabled = enabled
  darkPalette = palette
  if (changed) for (const apply of [...frameAppliers]) apply()
}

/**
 * Make one TW iframe follow the DSH theme for as long as the returned
 * disposer is not called. Re-applies on the iframe's `load` (covers TW
 * restarts and proxy reloads), on DSH theme changes (body-attribute mutations
 * and `prefers-color-scheme`), and once immediately for already-loaded frames.
 */
export function attachThemeSync(frame: HTMLIFrameElement | null): () => void {
  if (frame === null) return () => {}
  const apply = (): void => applyToFrame(frame)
  frameAppliers.add(apply)

  const onLoad = (): void => apply()
  frame.addEventListener('load', onLoad)

  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const onMedia = (): void => apply()
  try {
    media.addEventListener('change', onMedia)
  } catch {
    media.addListener?.(onMedia)
  }

  let observer: MutationObserver | undefined
  try {
    observer = new MutationObserver(() => apply())
    if (document.body !== null) observer.observe(document.body, { attributes: true, attributeFilter: [DARK_ATTR] })
    if (document.documentElement !== null) {
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    }
  } catch {
    observer = undefined
  }

  // TW's boot-time sync can load `$:/palette` from the server shortly after
  // load (reverting our in-memory flip and bumping its changeCount), so also
  // re-apply on a few short lags. Each pass is idempotent: it re-flips in
  // memory if a boot load reverted us, and re-aligns the syncer's changeCount.
  const timers = [150, 600, 1500, 3000].map((ms) => window.setTimeout(apply, ms))

  // The frame may already be loaded when this is attached late.
  apply()

  return () => {
    frameAppliers.delete(apply)
    frame.removeEventListener('load', onLoad)
    for (const id of timers) window.clearTimeout(id)
    try {
      media.removeEventListener('change', onMedia)
    } catch {
      media.removeListener?.(onMedia)
    }
    try {
      observer?.disconnect()
    } catch {
      // Already disconnected.
    }
  }
}

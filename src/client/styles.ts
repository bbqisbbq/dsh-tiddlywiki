/**
 * Client stylesheet injection (design doc D5 — pure DOM, no React).
 * All rules are `dsh-tw-*` scoped; the tag is stable per plugin so the HMR
 * driver can identify it on rebuild.
 *
 * Theme: uses the live `--dsw-alias-*` design tokens (same family as the
 * shutdown launcher) with fallbacks, so it follows light/dark automatically.
 *
 * @module dsh-tiddlywiki/client/styles
 */

import { CSS_TEXT } from './styles-css.ts'
/** Stable <style> id so HMR/teardown can find the tag it injected (module-private:
 *  only injectStyles() below uses it — v0.22.8). */
const STYLE_ID = 'dsh-tiddlywiki-styles'


/**
 * Inject the plugin stylesheet and return a disposer removing it.
 * A style tag that already exists is REUSED, but its content is refreshed when
 * it differs (HMR / re-apply after a CSS change) — the old version returned
 * early and left stale CSS in place.
 *
 * TOKENED DISPOSAL (v0.19.1): the node is shared across instances (same id), so
 * a stale disposer must not remove a stylesheet a NEWER instance is using. Each
 * apply stamps a fresh token on the element and the disposer only removes it
 * while the token still matches — the interleaved hot-reload case (new apply
 * reuses the node → old dispose fires) no longer leaves the page unstyled.
 */
export function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  let el = document.getElementById(STYLE_ID)
  if (el === null) {
    el = document.createElement('style')
    el.id = STYLE_ID
    el.dataset.plugin = 'dsh-tiddlywiki'
    el.textContent = CSS_TEXT
    document.head.append(el)
  } else if (el.textContent !== CSS_TEXT) {
    el.textContent = CSS_TEXT
  }
  const token = String(Date.now()) + ':' + Math.random().toString(36).slice(2)
  el.dataset.instance = token
  return () => {
    if (el?.dataset.instance === token) el.remove()
  }
}

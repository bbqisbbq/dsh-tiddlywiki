/**
 * One-shot transient toast, shared by the quick-note widget and the settings
 * page. Reuses a single body-level element (`.dsh-tw-toast`) with a show
 * class; the element is created lazily and styled by styles.ts.
 *
 * @module dsh-tiddlywiki/client/toast
 */

export function toast(message: string): void {
  let el = document.querySelector<HTMLElement>('.dsh-tw-toast')
  if (el === null) {
    el = document.createElement('div')
    el.className = 'dsh-tw-toast'
    document.body.append(el)
  }
  el.textContent = message
  el.classList.add('dsh-tw-toast-show')
  clearTimeout((el as HTMLElement & { __twToastTimer?: number }).__twToastTimer)
  ;(el as HTMLElement & { __twToastTimer?: number }).__twToastTimer = window.setTimeout(() => {
    el?.classList.remove('dsh-tw-toast-show')
  }, 2_500)
}

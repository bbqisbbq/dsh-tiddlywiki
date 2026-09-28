/**
 * The one DOM element helper shared by the client widgets (v0.28.8).
 *
 * WHY A MODULE FOR ONE FUNCTION: `make()` existed as a private copy inside
 * `settings-page.ts` — fine while the settings page was one file, but extracting
 * the icon picker (and any future widget) needs the same three lines, and a
 * second private copy is exactly the kind of drift this repo has paid for before
 * (see the endpoints.ts note about eight re-declared routes). One definition,
 * imported where needed.
 *
 * @module dsh-tiddlywiki/client/dom
 */

/**
 * Create an element with an optional class and text.
 *
 * `text` goes through `textContent` — deliberately, not `innerHTML`: callers
 * pass values that can originate in user-editable files (a wiki's label or icon),
 * and this helper must never be a markup injection point.
 */
export function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

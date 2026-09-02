/**
 * Tiny pub/sub panel state shared by the sidebar entry and the center panel.
 *
 * @module dsh-tiddlywiki/client/state
 */

export type PanelListener = (open: boolean) => void

export class PanelState {
  private open = false
  private readonly listeners = new Set<PanelListener>()

  isOpen(): boolean {
    return this.open
  }

  toggle(): void {
    this.set(!this.open)
  }

  openPanel(): void {
    this.set(true)
  }

  closePanel(): void {
    this.set(false)
  }

  set(value: boolean): void {
    if (this.open === value) return
    this.open = value
    for (const listener of [...this.listeners]) listener(value)
  }

  subscribe(listener: PanelListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

import Icon from '~icons/ao3e/icon.jsx'

import { ADDON_CLASS } from '#common'
import React from '#dom'

/**
 * The floating control in the bottom-right corner: a round, touch-sized button
 * (the extension's AO3 logo) that expands a stack of pills above it, and
 * collapses them again, so the stack can grow without crowding the page. AO3's
 * pages get it from the `FilterToolbar` unit; an exported page's work view
 * builds its own pills into the same shell.
 */

export const TOOLBAR_CLASS = `${ADDON_CLASS}--filter-toolbar`
export const PANEL_CLASS = `${TOOLBAR_CLASS}--panel`
export const FAB_CLASS = `${TOOLBAR_CLASS}--fab`
export const OPEN_CLASS = `${TOOLBAR_CLASS}--open`
export const BUTTON_CLASS = `${TOOLBAR_CLASS}--button`
export const ICON_CLASS = `${TOOLBAR_CLASS}--icon`

/**
 * How much of the bottom-right corner the toolbar is occupying, published on
 * `<html>` for anything else that parks itself there. The toast stack is the
 * one thing that does (see {@link file://../common/toast/toast.css}) and it
 * offsets itself by this, so a toast raised by one of the pills sits above the
 * toolbar instead of over it — without it, saving anything from a pill made the
 * whole toolbar unreachable for as long as the toast was up, the launcher
 * included.
 *
 * Deliberately survives {@link FloatingToolbar.detach}: a pill's write re-runs
 * every unit, and the toast it raised is *not* ours to remove (it has no
 * `ADDON_CLASS`, so it rides out the rebuild). Dropping the property in between
 * would drop that toast onto the corner and lift it again a moment later.
 */
const RESERVE_PROP = '--ao3e-corner-reserve'

export interface FloatingToolbar {
  /** The whole control, to append to the page. Hidden while its panel is empty, if the owner says so. */
  el: HTMLElement
  /** Where the pills go, stacked upward from the launcher. */
  panel: HTMLElement
  isOpen: () => boolean
  setOpen: (open: boolean) => void
  /** Publish how much of the corner the control takes now — after a change the box can't see, such as hiding it. */
  syncReserve: () => void
  /** Stop following outside clicks and the control's box. The element stays where it is. */
  detach: () => void
}

export interface FloatingToolbarOptions {
  /** Told whenever the panel opens or closes. */
  onOpenChange?: (open: boolean) => void
}

export function createFloatingToolbar({ onOpenChange }: FloatingToolbarOptions = {}): FloatingToolbar {
  const panel = (<div class={PANEL_CLASS} role="group" />) as HTMLElement
  const fab = (
    <button type="button" class={FAB_CLASS} aria-haspopup="true" aria-expanded="false">
      <Icon />
    </button>
  ) as HTMLElement as HTMLButtonElement

  // The panel renders above the fab (column layout) so the pills stack upward.
  const el = (
    <div class={`${ADDON_CLASS}  ${TOOLBAR_CLASS}`}>
      {panel}
      {fab}
    </div>
  ) as HTMLElement

  let open = false

  // Measured from the live box rather than worked out from the stylesheet, so
  // the reader's font size, however many pills the page has and a box growing
  // out of one are all in it. Collapsed, only the circle counts: the panel
  // keeps its layout box while it is hidden, and reserving that would hold
  // every toast a couple of hundred pixels off the bottom of the page for
  // nothing.
  const syncReserve = (): void => {
    // Nothing is published until the control has a box. Leaving the property as
    // it was until then is the point: a toast raised by a pill outlives the
    // rebuild that pill's write sets off, and must not drop onto the corner and
    // rise again in between.
    if (!el.isConnected)
      return
    const measured = el.hidden ? null : (open ? el : fab).getBoundingClientRect()
    const reserved = measured ? Math.max(0, Math.round(window.innerHeight - measured.top)) : 0
    document.documentElement.style.setProperty(RESERVE_PROP, `${reserved}px`)
  }

  // Everything that changes the box: the control being appended (the first real
  // measurement), a pill arriving or leaving, a box opening out of one.
  const observer = new ResizeObserver(() => syncReserve())
  observer.observe(el)

  const setOpen = (next: boolean): void => {
    open = next
    el.classList.toggle(OPEN_CLASS, open)
    fab.setAttribute('aria-expanded', String(open))
    const label = open ? 'Hide extension controls' : 'Show extension controls'
    fab.title = label
    fab.setAttribute('aria-label', label)
    onOpenChange?.(open)
    // Opening changes what counts as taken without changing the box the
    // observer is watching, so it has nothing to say about this one.
    syncReserve()
  }
  setOpen(false)

  fab.addEventListener('click', (e) => {
    e.preventDefault()
    setOpen(!open)
  })

  // Collapse when the reader clicks anywhere outside the control.
  const outside = (e: Event): void => {
    if (open && !el.contains(e.target as Node))
      setOpen(false)
  }
  document.addEventListener('pointerdown', outside, true)

  return {
    el,
    panel,
    isOpen: () => open,
    setOpen,
    syncReserve,
    detach: () => {
      document.removeEventListener('pointerdown', outside, true)
      observer.disconnect()
    },
  }
}

/** A pill for the panel: an icon, its words, and the label its tooltip and a screen reader give. */
export function toolbarButton(icon: Element, text: string, label: string, action?: string): HTMLButtonElement {
  return (
    <button type="button" class={BUTTON_CLASS} title={label} aria-label={label} data-ao3e-action={action}>
      <span class={ICON_CLASS}>{icon}</span>
      <span>{text}</span>
    </button>
  ) as HTMLElement as HTMLButtonElement
}

import MdiClockCheck from '~icons/mdi/clock-check.jsx'
import MdiContentCopy from '~icons/mdi/content-copy.jsx'
import MdiEyeCheck from '~icons/mdi/eye-check.jsx'
import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiLinkVariant from '~icons/mdi/link-variant.jsx'
import MdiMinusCircle from '~icons/mdi/minus-circle.jsx'
import MdiOpenInApp from '~icons/mdi/open-in-app.jsx'
import MdiOpenInNew from '~icons/mdi/open-in-new.jsx'
import MdiPlusCircle from '~icons/mdi/plus-circle.jsx'
import MdiStar from '~icons/mdi/star.jsx'

import { ADDON_CLASS } from '#common'
import React from '#dom'

import type { MenuItem } from './contextMenu.tsx'

import { openMenu, openPopover } from './contextMenu.tsx'

/**
 * Attaches the right-click / long-press / indicator triggers that open the
 * floating menus, and the small per-state indicator icons.
 *
 * Events are handled by a single set of document-level listeners (installed once)
 * that look up the element under the pointer in a per-page {@link triggers}
 * registry. Doing it by delegation rather than per-element listeners means we
 * never leak handlers on the native links we decorate (tags, bylines, titles),
 * and {@link clearMenuTriggers} — called from each unit's `clean()` — wipes the
 * registry every run so a disabled feature stops responding.
 */

const TRIGGER_CLASS = `${ADDON_CLASS}--menu-trigger`
const INDICATORS_CLASS = `${ADDON_CLASS}--indicators`
const INDICATOR_CLASS = `${ADDON_CLASS}--indicator`

const LONG_PRESS_MS = 450
const MOVE_CANCEL_PX = 10
/** Collapse a right-click + long-press for one physical gesture into one open. */
const REOPEN_GUARD_MS = 250

// ---------------------------------------------------------------------------
// Global enable flag. Seeded from the `contextMenusEnabled` option each run (see
// content_script.ts) and flipped live by the floating-toolbar toggle. When off,
// our menus stay out of the way of the browser's native context menu on links —
// except our own indicator elements, which are always ours to act on.
// ---------------------------------------------------------------------------

let menusEnabled = true
export function setMenusEnabled(value: boolean): void {
  menusEnabled = value
}
export function getMenusEnabled(): boolean {
  return menusEnabled
}

// ---------------------------------------------------------------------------
// Trigger registry + delegated event handling.
// ---------------------------------------------------------------------------

interface Trigger {
  /** Open the menu/popover for this element at the given viewport point. */
  open: (x: number, y: number) => void
  /**
   * Whether the element is one of ours (an indicator/popover anchor) rather than
   * a page link. Indicators also open on a plain left-click / short tap and work
   * even when {@link menusEnabled} is false.
   */
  indicator: boolean
  /**
   * For page links: open the menu on a plain left-click / short tap (suppressing
   * navigation) instead of following the link. Unlike {@link indicator} this is
   * still gated by {@link menusEnabled}, and the menu's "Open" item restores the
   * navigation. Set from the `openMenuOnClick` option on tag/fandom/author links.
   */
  clickToOpen: boolean
}

const triggers = new Map<HTMLElement, Trigger>()

/** Drop every registered trigger. Called from each menu unit's `clean()`. */
export function clearMenuTriggers(): void {
  triggers.clear()
}

export interface TriggerOptions {
  /** Treat the element as one of ours: opens on left-click/tap, ignores the global disable. */
  indicator?: boolean
  /** For a page link: left-click/tap opens the menu (suppressing navigation) while menus are enabled. */
  clickToOpen?: boolean
}

/**
 * Register `el` so right-click / long-press (and, for indicators, a plain click)
 * opens the menu built by `build`. `build` is called at open time, so it always
 * sees the freshest options/sidebar state.
 */
export function attachMenuTrigger(
  el: HTMLElement,
  build: () => MenuItem[] | Promise<MenuItem[]>,
  opts: TriggerOptions = {},
): void {
  el.classList.add(TRIGGER_CLASS)
  triggers.set(el, {
    indicator: !!opts.indicator,
    clickToOpen: !!opts.clickToOpen,
    open: (x, y) => {
      void Promise.resolve(build()).then((items) => {
        if (items && items.length)
          openMenu(items, { x, y })
      })
    },
  })
}

/** Register `el` so the same triggers open an informational popover instead of a menu. */
export function attachPopoverTrigger(el: HTMLElement, getContent: () => Node | string): void {
  el.classList.add(TRIGGER_CLASS)
  triggers.set(el, {
    indicator: true,
    clickToOpen: false,
    open: (x, y) => openPopover(getContent(), { x, y }),
  })
}

/** Walk up from an event target to the nearest registered trigger element. */
function findTrigger(target: EventTarget | null): { el: HTMLElement, trigger: Trigger } | null {
  // Start from the deepest Element — clicks/taps often land on an icon's <svg> or
  // <path>, which are SVGElements (not HTMLElement). Matching on Element and
  // walking up reaches the registered HTML trigger (the indicator span / link).
  let el: Element | null = target instanceof Element ? target : null
  while (el) {
    const trigger = triggers.get(el as HTMLElement)
    if (trigger)
      return { el: el as HTMLElement, trigger }
    if (el === document.body)
      break
    el = el.parentElement
  }
  return null
}

let lastOpen = 0
function fire(trigger: Trigger, x: number, y: number): void {
  const now = Date.now()
  if (now - lastOpen < REOPEN_GUARD_MS)
    return
  lastOpen = now
  trigger.open(x, y)
}

// --- Long-press tracking (touch / pen). ------------------------------------

interface LongPress {
  trigger: Trigger
  x: number
  y: number
  timer: ReturnType<typeof setTimeout>
}
let longPress: LongPress | null = null
/** Set when a long-press opened a menu, so the trailing click is swallowed. */
let swallowClick = false

function cancelLongPress(): void {
  if (longPress) {
    clearTimeout(longPress.timer)
    longPress = null
  }
}

function onContextMenu(e: MouseEvent): void {
  const hit = findTrigger(e.target)
  if (!hit)
    return
  if (!menusEnabled && !hit.trigger.indicator)
    return // let the browser's native menu through
  e.preventDefault()
  fire(hit.trigger, e.clientX, e.clientY)
}

function onPointerDown(e: PointerEvent): void {
  if (e.pointerType === 'mouse')
    return // long-press is a touch/pen gesture; mouse uses right-click
  const hit = findTrigger(e.target)
  if (!hit)
    return
  if (!menusEnabled && !hit.trigger.indicator)
    return
  cancelLongPress()
  swallowClick = false
  longPress = {
    trigger: hit.trigger,
    x: e.clientX,
    y: e.clientY,
    timer: setTimeout(() => {
      const lp = longPress
      longPress = null
      if (!lp)
        return
      swallowClick = true
      fire(lp.trigger, lp.x, lp.y)
    }, LONG_PRESS_MS),
  }
}

function onPointerMove(e: PointerEvent): void {
  if (longPress
    && (Math.abs(e.clientX - longPress.x) > MOVE_CANCEL_PX
      || Math.abs(e.clientY - longPress.y) > MOVE_CANCEL_PX)) {
    cancelLongPress()
  }
}

function onPointerEnd(): void {
  cancelLongPress()
}

function onClick(e: MouseEvent): void {
  // Suppress the click that a long-press leaves behind (so links don't navigate
  // and text isn't actioned).
  if (swallowClick) {
    swallowClick = false
    e.preventDefault()
    e.stopImmediatePropagation()
    return
  }
  const hit = findTrigger(e.target)
  if (!hit)
    return
  // Indicators always open on click (they're ours); links open on click only when
  // `openMenuOnClick` made them clickToOpen, and only while menus are enabled.
  // A modifier-click on a link (ctrl/cmd/shift/alt) is left to the browser so the
  // user can still open it in a new tab/window the usual way.
  const modified = e.ctrlKey || e.metaKey || e.shiftKey || e.altKey
  const openOnClick = hit.trigger.indicator || (hit.trigger.clickToOpen && menusEnabled && !modified)
  if (!openOnClick)
    return
  e.preventDefault()
  e.stopPropagation()
  fire(hit.trigger, e.clientX, e.clientY)
}

let installed = false
function install(): void {
  if (installed)
    return
  installed = true
  document.addEventListener('contextmenu', onContextMenu, true)
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('pointermove', onPointerMove, true)
  document.addEventListener('pointerup', onPointerEnd, true)
  document.addEventListener('pointercancel', onPointerEnd, true)
  document.addEventListener('click', onClick, true)
}
install()

// ---------------------------------------------------------------------------
// Standard "this is a link" menu items, appended to link-based menus only while
// we're actually overriding the native menu (so the user keeps copy/open access).
// ---------------------------------------------------------------------------

export function standardLinkItems(link: HTMLAnchorElement): MenuItem[] {
  if (!menusEnabled)
    return []
  return [
    {
      icon: () => <MdiContentCopy />,
      label: 'Copy text',
      separatorBefore: true,
      onSelect: () => void navigator.clipboard?.writeText(link.textContent?.trim() ?? ''),
    },
    {
      icon: () => <MdiLinkVariant />,
      label: 'Copy address',
      onSelect: () => void navigator.clipboard?.writeText(link.href),
    },
    {
      // Always offered so following the link is never lost — especially when
      // `openMenuOnClick` makes a plain click open this menu instead of navigating.
      icon: () => <MdiOpenInApp />,
      label: 'Open',
      onSelect: () => {
        window.location.assign(link.href)
      },
    },
    {
      icon: () => <MdiOpenInNew />,
      label: 'Open in new tab',
      onSelect: () => {
        window.open(link.href, '_blank', 'noopener')
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// Permanent indicators. One small icon per active state, shown next to an item
// only when something is active. The returned span is itself a menu trigger.
// ---------------------------------------------------------------------------

/** A state an indicator can show, in display order. */
export type IndicatorState = 'include' | 'exclude' | 'hide' | 'invert' | 'highlight' | 'saved'

const INDICATOR_ICONS: Record<IndicatorState, () => Node> = {
  include: () => <MdiPlusCircle />,
  exclude: () => <MdiMinusCircle />,
  hide: () => <MdiEyeOff />,
  invert: () => <MdiEyeCheck />,
  highlight: () => <MdiStar />,
  saved: () => <MdiClockCheck />,
}

const INDICATOR_ORDER: IndicatorState[] = ['include', 'exclude', 'hide', 'invert', 'highlight', 'saved']

export interface IndicatorOptions {
  /** Colour for the highlight star (defaults to the CSS fallback). */
  highlightColor?: string
}

/**
 * Build the indicator span for a set of active states, or `null` when nothing is
 * active (so callers can skip inserting an empty node). The span carries the
 * trigger class but is wired to a menu by the caller via {@link attachMenuTrigger}.
 */
export function buildIndicators(states: Iterable<IndicatorState>, opts: IndicatorOptions = {}): HTMLElement | null {
  const set = new Set(states)
  const ordered = INDICATOR_ORDER.filter(s => set.has(s))
  if (ordered.length === 0)
    return null

  const span = (<span class={`${ADDON_CLASS}  ${INDICATORS_CLASS}`} aria-hidden="true" />) as HTMLElement
  for (const state of ordered) {
    const icon = (
      <span class={`${INDICATOR_CLASS}  ${INDICATOR_CLASS}--${state}`}>{INDICATOR_ICONS[state]()}</span>
    ) as HTMLElement
    if (state === 'highlight' && opts.highlightColor)
      icon.style.setProperty('--ao3e-indicator-color', opts.highlightColor)
    span.append(icon)
  }
  return span
}

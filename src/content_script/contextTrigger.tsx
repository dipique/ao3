import MdiArrowCollapseVertical from '~icons/mdi/arrow-collapse-vertical.jsx'
import MdiCheckCircle from '~icons/mdi/check-circle.jsx'
import MdiContentCopy from '~icons/mdi/content-copy.jsx'
import MdiEyeCheck from '~icons/mdi/eye-check.jsx'
import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiLinkVariant from '~icons/mdi/link-variant.jsx'
import MdiMinusCircle from '~icons/mdi/minus-circle.jsx'
import MdiOpenInApp from '~icons/mdi/open-in-app.jsx'
import MdiOpenInNew from '~icons/mdi/open-in-new.jsx'
import MdiPlusCircle from '~icons/mdi/plus-circle.jsx'
import MdiStar from '~icons/mdi/star.jsx'
import MdiTagOff from '~icons/mdi/tag-off.jsx'

import type { MarkConfig, MarkId } from '#common'

import { ADDON_CLASS, isExtensionContextValid, toast } from '#common'
import { markIcon } from '#content_script/markIcons.js'
import React from '#dom'

import type { MenuItem } from './contextMenu.tsx'

import { closeFloating, openMenu, openPopover } from './contextMenu.tsx'

/**
 * Attaches the right-click / long-press / indicator triggers that open the
 * floating menus, and the small per-state indicator icons. Shift is reserved as a
 * per-gesture escape hatch: held down, the extension stands aside and the element
 * behaves the way the browser would have it (see {@link wantsNativeBehavior}).
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

/**
 * Shift means "stand back": for one gesture, the extension gets out of the way
 * and the element behaves as the browser would have it. A per-gesture escape
 * hatch that needs no setting and no round trip through the toolbar's "Disable
 * right-click menus" toggle.
 *
 * - **Right-click** — our menu stays shut and the native one opens, so "Copy
 *   image", "Inspect" or "Search with…" are reachable on anything we decorate.
 *   Firefox already treats Shift+right-click this way on pages that override the
 *   context menu, so there the chord is the one users reach for anyway.
 * - **Left-click** — we don't intercept, so the browser reads the click exactly
 *   as it normally would. On an element with no native click behaviour of its
 *   own — our indicator icons — {@link followLinkFor} stands in.
 *
 * Shift alone, not Ctrl+Shift, so that **any further modifier is still the
 * browser's to read**: Ctrl+Shift+click keeps meaning "open in a new foreground
 * tab", and merely also tells us to keep out of it. What that costs is Shift's
 * own native meaning on a link — "open in a new window" — which the menu's link
 * rows cover anyway.
 *
 * Mouse only; a long-press has no modifier to hold.
 */
function wantsNativeBehavior(e: MouseEvent): boolean {
  return e.shiftKey
}

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
  /**
   * The page link this trigger speaks for, when the trigger element isn't the
   * link itself — an indicator icon sits *beside* the tag/fandom/author/work link
   * it belongs to. It's what Shift+click opens (see
   * {@link wantsNativeBehavior}), matching the menu's own "Open" row. Null when
   * there's nothing to open: a word count, a hidden-work reason, a work-page
   * title that isn't a link.
   */
  link: HTMLElement | null
}

const triggers = new Map<HTMLElement, Trigger>()

/**
 * Drop every registered trigger. Called from each menu unit's `clean()`.
 *
 * Also shuts whatever menu or popover is open, because the very next thing a
 * `clean()` does is remove every `.AO3E` node — which takes the floating element
 * with it but leaves its four document/window listeners pointing at a node
 * nothing else can reach.
 */
export function clearMenuTriggers(): void {
  triggers.clear()
  closeFloating()
}

/**
 * Drop triggers whose element has left the DOM. The registry holds its keys
 * strongly, so blurbs removed when the Marked-for-Later search view tears down
 * (or re-renders) would otherwise leak. Prunes only disconnected elements, so the
 * still-connected native page triggers — which {@link clearMenuTriggers} would
 * also wipe — are left intact.
 */
export function pruneDetachedTriggers(): void {
  for (const el of triggers.keys()) {
    if (!el.isConnected)
      triggers.delete(el)
  }
}

export interface TriggerOptions {
  /** Treat the element as one of ours: opens on left-click/tap, ignores the global disable. */
  indicator?: boolean
  /** For a page link: left-click/tap opens the menu (suppressing navigation) while menus are enabled. */
  clickToOpen?: boolean
  /**
   * The link this trigger stands next to, for an element that isn't itself a
   * link (an indicator). Shift+click follows it — see {@link Trigger.link}.
   */
  link?: HTMLElement | null
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
    link: opts.link ?? null,
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
    link: null,
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

/** Told the reader once that this page's copy of the extension is stale. */
let staleNotified = false

let lastOpen = 0
function fire(trigger: Trigger, x: number, y: number): void {
  // The extension was reloaded, updated, or disabled under this page. Our menus
  // read settings to build themselves and write them on select, so none of it
  // would work — retire the triggers (which also hands links back to the
  // browser's own context menu) and say why, once.
  if (!isExtensionContextValid()) {
    clearMenuTriggers()
    if (!staleNotified) {
      staleNotified = true
      toast('AO3 Enhancements was updated or reloaded. Refresh this page to use its menus again.', { type: 'error' })
    }
    return
  }

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
  // Checked before anything else, so the escape hatch also covers our indicators
  // — which otherwise open their menu regardless of the global disable.
  if (wantsNativeBehavior(e))
    return
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

/**
 * The left-click half of {@link wantsNativeBehavior}.
 *
 * When the thing clicked is (or sits inside) a real link, the browser's own
 * handling *is* the native behaviour asked for — Shift+click opens a window,
 * Ctrl+Shift+click a new foreground tab — so we do nothing and let the event run
 * its course.
 *
 * Our indicator icons have no such default: they're spans we put *beside* the
 * link they describe, so a click there does nothing at all unless we act. There
 * we follow the link ourselves, reading the same modifier the browser would have
 * — Ctrl/Cmd for a new tab, otherwise here — through the same two calls the
 * menu's "Open" and "Open in new tab" rows make. Shift is what got us here, so it
 * can't also mean something on this side.
 */
function followLinkFor(hit: { el: HTMLElement, trigger: Trigger }, e: MouseEvent): void {
  if (hit.el.closest('a[href]'))
    return // a real link: the browser already does the right thing
  const { link } = hit.trigger
  if (!(link instanceof HTMLAnchorElement) || !link.href)
    return // nothing to open (a word count, a hidden-work reason)
  e.preventDefault()
  e.stopPropagation()
  if (e.ctrlKey || e.metaKey)
    window.open(link.href, '_blank', 'noopener')
  else
    window.location.assign(link.href)
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
  // Shift stands the extension down for this click — including on an indicator,
  // which would otherwise open its menu regardless of anything else.
  if (wantsNativeBehavior(e)) {
    followLinkFor(hit, e)
    return
  }
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
      scope: 'builtin',
      onSelect: () => void navigator.clipboard?.writeText(link.textContent?.trim() ?? ''),
    },
    {
      icon: () => <MdiLinkVariant />,
      label: 'Copy address',
      scope: 'builtin',
      onSelect: () => void navigator.clipboard?.writeText(link.href),
    },
    {
      // Always offered so following the link is never lost — especially when
      // `openMenuOnClick` makes a plain click open this menu instead of navigating.
      icon: () => <MdiOpenInApp />,
      label: 'Open',
      scope: 'builtin',
      onSelect: () => {
        window.location.assign(link.href)
      },
    },
    {
      icon: () => <MdiOpenInNew />,
      label: 'Open in new tab',
      scope: 'builtin',
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

/**
 * A state an indicator can show. The fixed seven describe a rule or the filter
 * the item sits in; `mark:<id>` covers the per-work marks, which are data (see
 * {@link file://../common/workMarks.ts}) and so can't be enumerated here.
 */
export type IndicatorState = 'require' | 'include' | 'exclude' | 'hide' | 'collapse' | 'invert' | 'highlight' | 'hideFilter' | `mark:${MarkId}`

/** The non-mark states, in display order. Marks follow them, in mark-table order. */
const FILTER_STATES = ['require', 'include', 'exclude', 'hide', 'collapse', 'invert', 'highlight', 'hideFilter'] as const
type FilterState = typeof FILTER_STATES[number]

const FILTER_ICONS: Record<FilterState, () => Node> = {
  require: () => <MdiCheckCircle />,
  include: () => <MdiPlusCircle />,
  exclude: () => <MdiMinusCircle />,
  hide: () => <MdiEyeOff />,
  collapse: () => <MdiArrowCollapseVertical />,
  invert: () => <MdiEyeCheck />,
  highlight: () => <MdiStar />,
  hideFilter: () => <MdiTagOff />,
}

/** Hover text, so an icon's meaning doesn't depend on recognising it. */
const FILTER_LABELS: Record<FilterState, string> = {
  // Search-view only: AO3's own sidebar has no "every shown work must have this"
  // filter, so this one can never light up on a native listing.
  require: 'Required in the filter',
  include: 'Included in the filter',
  exclude: 'Excluded from the filter',
  hide: 'Hidden',
  collapse: 'Collapsed',
  invert: 'Always shown',
  highlight: 'Highlighted',
  // Normally unseen — the tag it sits on is hidden — but it shows up wherever
  // HideFilters doesn't reach (e.g. while that unit is mid-run).
  hideFilter: 'Tag hidden',
}

/** The indicator state for a mark id. */
export function markIndicatorState(id: MarkId): IndicatorState {
  return `mark:${id}`
}

export interface IndicatorOptions {
  /** Colour for the highlight star (defaults to the CSS fallback). */
  highlightColor?: string
  /** The mark table, so `mark:*` states can resolve their icon, label and colour. */
  marks?: Record<MarkId, MarkConfig>
  /**
   * Hover text to show for a mark instead of its plain label — what a mark with
   * per-work state (the ongoing mark's chapter/readiness hint) has to say
   * about *this* work. Falls back to the label wherever the caller couldn't work one
   * out, so a half-built hint never replaces a correct one.
   */
  titles?: Record<MarkId, string>
  /**
   * Colour for a mark instead of its configured one, for the same reason as
   * {@link titles}: a mark carrying per-work state can mean different things on
   * different works, and the ongoing mark's readiness is the case in point.
   * Falls back to the mark's own colour.
   */
  colors?: Record<MarkId, string>
}

/** One indicator's rendered parts, whatever kind of state it came from. */
interface Indicator {
  suffix: string
  label: string
  icon: () => Node
  color?: string
}

/** Resolve the active states into indicators, in display order (filters, then marks). */
function resolve(set: Set<IndicatorState>, opts: IndicatorOptions): Indicator[] {
  const out: Indicator[] = []
  for (const state of FILTER_STATES) {
    if (set.has(state)) {
      out.push({
        suffix: state,
        label: FILTER_LABELS[state],
        icon: FILTER_ICONS[state],
        color: state === 'highlight' ? opts.highlightColor : undefined,
      })
    }
  }

  // Marks render in the order the mark table lists them, so a work's indicators
  // read the same way everywhere regardless of what order the caller collected.
  const ids = opts.marks ? Object.keys(opts.marks) : []
  for (const id of ids) {
    if (!set.has(markIndicatorState(id)))
      continue
    const config = opts.marks![id]!
    out.push({
      suffix: `mark  ${INDICATOR_CLASS}--mark-${id}`,
      label: opts.titles?.[id] || config.label || id,
      icon: markIcon(config.icon),
      color: opts.colors?.[id] || config.color,
    })
  }
  return out
}

/**
 * Build the indicator span for a set of active states, or `null` when nothing is
 * active (so callers can skip inserting an empty node). The span carries the
 * trigger class but is wired to a menu by the caller via {@link attachMenuTrigger}.
 */
export function buildIndicators(states: Iterable<IndicatorState>, opts: IndicatorOptions = {}): HTMLElement | null {
  const indicators = resolve(new Set(states), opts)
  if (indicators.length === 0)
    return null

  const span = (<span class={`${ADDON_CLASS}  ${INDICATORS_CLASS}`} aria-hidden="true" />) as HTMLElement
  for (const { suffix, label, icon, color } of indicators) {
    const el = (
      <span
        class={`${INDICATOR_CLASS}  ${INDICATOR_CLASS}--${suffix}`}
        title={label}
      >
        {icon()}
      </span>
    ) as HTMLElement
    if (color)
      el.style.setProperty('--ao3e-indicator-color', color)
    span.append(el)
  }
  return span
}

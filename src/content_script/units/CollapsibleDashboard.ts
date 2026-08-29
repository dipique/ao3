import { ADDON_CLASS } from '#common'
import { Unit } from '#content_script/Unit.js'

/**
 * CollapsibleDashboard — folds your own dashboard sidebar out of the way.
 *
 * On your own `/users/…` pages AO3 marks the sidebar `#dashboard.own` and draws
 * a thick red band across its top and bottom. Clicking the **top** band hides
 * the sidebar and leaves that band behind as a thin rail down the left edge of
 * the viewport; clicking the rail brings the sidebar back, and `#main` reclaims
 * the space in between.
 *
 * The band is a CSS border, not a child element, so there is nothing to hang a
 * listener on — the click lands on `#dashboard` itself and is told apart from a
 * click on a nav link by where it fell relative to `clientTop` (the rendered
 * width of that border).
 *
 * Collapsed/expanded lives in the page's own `localStorage` (see
 * {@link LS_COLLAPSED}), so it is per-device and never travels through the
 * synced options — the `collapsibleDashboard` option is only the on/off switch.
 *
 * Only the wide layout folds: below AO3's 62em breakpoint the sidebar restacks
 * as a full-width bar above `#main` (see {@link WIDE_LAYOUT}), where there is no
 * gutter to reclaim and nothing for a left-edge rail to stand in for. The
 * stylesheet declines to apply the fold there and this unit declines to start
 * one, so a narrow window can't put the page into a state it won't render.
 */

const RAIL_CLASS = `${ADDON_CLASS}--dashboard-rail`
/** Set on `<html>` (not `<body>`) so the rules apply before the body is styled. */
const COLLAPSED_CLASS = `${ADDON_CLASS}--dashboard-collapsed`

/** localStorage key. Namespaced so it doesn't collide with AO3's own storage. */
const LS_COLLAPSED = 'ao3e:dashboard:collapsed'

/**
 * The layout the fold is built for — AO3's own desktop breakpoint, i.e. the
 * inverse of the `max-width: 62em` its midsize stylesheet uses. Matched here and
 * in the stylesheet, so the two always agree on when folding is possible.
 */
const WIDE_LAYOUT = '(min-width: 62.01em)'

/**
 * Everything one active instance sets up, kept at module scope so the static
 * `clean()` (which runs before every re-run, enabled or not) can undo all of it
 * — mirrors {@link file://./ReaderMode.ts}.
 */
interface DashboardState {
  rail: HTMLElement
  detach: Array<() => void>
}
let active: DashboardState | null = null

function teardown(): void {
  if (!active)
    return

  const { rail, detach } = active
  active = null

  detach.forEach(fn => fn())
  rail.remove()

  // Always leave the sidebar showing. This also runs when the option is switched
  // off, and a hidden sidebar with no rail left to reopen it would be a trap.
  const root = document.documentElement
  root.classList.remove(COLLAPSED_CLASS)
  root.style.removeProperty('--ao3e-dashboard-rail-width')
  root.style.removeProperty('--ao3e-dashboard-rail-color')
}

export class CollapsibleDashboard extends Unit {
  static override get name() { return 'CollapsibleDashboard' }
  override get enabled() { return this.options.collapsibleDashboard }

  static override async clean(): Promise<void> {
    teardown()
  }

  override async ready(): Promise<void> {
    // `.own` is AO3's marker for "this dashboard is yours" — the only sidebar it
    // gives the red bands, and the only one worth collapsing.
    const dashboard = document.querySelector<HTMLElement>('#dashboard.own')
    if (!dashboard)
      return

    // Defensive: a previous instance should already be gone via clean(). Also
    // guarantees the sidebar is visible for the measurement below.
    teardown()

    const wide = window.matchMedia(WIDE_LAYOUT)
    const root = document.documentElement

    // Match the rail to the band the reader actually clicks — a custom skin can
    // restyle it, and `clientTop` is that border's rendered width. Only worth
    // reading in the wide layout: that's the only one that folds, and the
    // narrow stylesheets thin the band to 7-10px, which would leave a stale
    // measurement behind if the window were later widened. Anywhere else the
    // stylesheet's own 15px/#900 fallbacks stand.
    if (wide.matches) {
      root.style.setProperty('--ao3e-dashboard-rail-width', `${dashboard.clientTop}px`)
      root.style.setProperty('--ao3e-dashboard-rail-color', getComputedStyle(dashboard).borderTopColor)
    }

    const rail = document.createElement('button')
    rail.type = 'button'
    rail.className = `${ADDON_CLASS} ${RAIL_CLASS}`
    rail.title = 'Show the dashboard sidebar'
    rail.setAttribute('aria-label', 'Show the dashboard sidebar')
    rail.setAttribute('aria-controls', 'dashboard')
    document.body.append(rail)

    const setCollapsed = (collapsed: boolean): void => {
      root.classList.toggle(COLLAPSED_CLASS, collapsed)
      localStorage.setItem(LS_COLLAPSED, collapsed ? '1' : '0')
    }
    setCollapsed(localStorage.getItem(LS_COLLAPSED) === '1')

    const onBorderClick = (e: MouseEvent): void => {
      // Nothing folds in the stacked layout, so don't let a click there record a
      // fold the reader can't see happen.
      if (!wide.matches)
        return
      // Only the top band. Everything inside the sidebar's padding box — every
      // link in it — sits at or past `clientTop`, so this can't eat a nav click.
      if (e.clientY - dashboard.getBoundingClientRect().top >= dashboard.clientTop)
        return
      setCollapsed(true)
    }
    dashboard.addEventListener('click', onBorderClick)

    const onRailClick = (): void => setCollapsed(false)
    rail.addEventListener('click', onRailClick)

    active = {
      rail,
      detach: [
        () => dashboard.removeEventListener('click', onBorderClick),
        () => rail.removeEventListener('click', onRailClick),
      ],
    }

    this.logger.debug(`Collapsible dashboard ready (wide layout: ${wide.matches}).`)
  }
}

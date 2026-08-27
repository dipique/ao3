import Icon from '~icons/ao3e/icon.jsx'
import MdiBookOpenVariant from '~icons/mdi/book-open-variant.jsx'
import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiEye from '~icons/mdi/eye.jsx'
import MdiGestureTapHold from '~icons/mdi/gesture-tap-hold.jsx'

import { ADDON_CLASS, marksHideAnything, options } from '#common'
import { getMenusEnabled, setMenusEnabled } from '#content_script/contextTrigger.js'
import { NATIVE_HIDDEN_CLASS, VIEW_HIDDEN_CLASS } from '#content_script/searchView/classes.ts'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

const TOOLBAR_CLASS = `${ADDON_CLASS}--filter-toolbar`
const PANEL_CLASS = `${ADDON_CLASS}--filter-toolbar--panel`
const FAB_CLASS = `${ADDON_CLASS}--filter-toolbar--fab`
const OPEN_CLASS = `${ADDON_CLASS}--filter-toolbar--open`
const BUTTON_CLASS = `${ADDON_CLASS}--filter-toolbar--button`

/** Toggled on <body> to temporarily reveal works hidden by any filter (see CSS). */
const PEEK_CLASS = `${ADDON_CLASS}--peek-hidden`

/**
 * Blurbs HideWorks hid (at least partly) — by a tag, author, crossover or
 * language filter. Every hidden work carries `data-ao3e-hidden-by`, so this
 * matches them all regardless of which filter kind was responsible.
 */
const HIDDEN_SELECTOR = 'li[data-ao3e-hidden-by]'

/**
 * How many works the reader's filters have hidden *in the listing they're
 * looking at* — the only ones peek could reveal. Two kinds are in the page but
 * not in front of the reader, and neither counts: the native listing a custom
 * search view is standing in for, and the works that view is holding back
 * because they're filtered out or on another of its pages.
 *
 * Recounted rather than cached because a search view marks its works as it
 * decorates them, a page at a time — the number simply isn't known when this
 * unit runs, and changes with every filter and page turn after it.
 */
function countHidden(): number {
  let count = 0
  for (const el of document.querySelectorAll(HIDDEN_SELECTOR)) {
    if (el.classList.contains(VIEW_HIDDEN_CLASS) || el.closest(`.${NATIVE_HIDDEN_CLASS}`))
      continue
    count++
  }
  return count
}

/**
 * The mounted toolbar's peek pill, so a listing that fills in *after* this unit
 * ran can bring the count up to date. Null when the page has no peek pill.
 */
let syncPeek: (() => void) | null = null
let peekPending = false

/**
 * Bring the peek pill in line with what's actually hidden now — adding or
 * dropping it as that count crosses zero. Called by the search view after every
 * render, and when it closes; coalesced to one pass per frame.
 */
export function refreshFilterToolbar(): void {
  if (!syncPeek || peekPending)
    return
  peekPending = true
  requestAnimationFrame(() => {
    peekPending = false
    syncPeek?.()
  })
}

/**
 * Document listener that collapses the panel on an outside click. Kept at module
 * scope (not per-instance) so each run's `clean()` can detach the previous one
 * before `ready()` mounts a fresh toolbar — otherwise re-runs would leak listeners.
 */
let outsideHandler: ((e: Event) => void) | null = null
function detachOutsideHandler(): void {
  if (outsideHandler) {
    document.removeEventListener('pointerdown', outsideHandler, true)
    outsideHandler = null
  }
}

/**
 * A floating control in the bottom-right corner of listing pages. A round,
 * touch-sized button (the extension's AO3 logo) expands a stack of pill toggles
 * — and collapses them again — so the stack can grow without crowding the page:
 *
 * - **Peek** — on any listing where the extension hid one or more works, toggles
 *   a body class that reveals them (and hides them again) without touching the
 *   saved filters. Gated by the `filterToolbar` option, shown only when works
 *   were hidden.
 * - **Disable menus** — the escape hatch for the in-page context menus: flips
 *   `contextMenusEnabled`, restoring the browser's native menu on links. Shown
 *   whenever any menu decorator is active on the page, so it's always reachable.
 *   (The per-gesture version is holding Shift; see
 *   {@link file://../contextTrigger.tsx}.)
 * - **Reader mode** — on a work page, toggles the `readerMode` option (font-zoom
 *   + drag-to-width on the work text) without a trip to the options page.
 *
 * Runs after HideWorks so the hidden markers the peek counts are already in place.
 */
export class FilterToolbar extends Unit {
  static override get name() { return 'FilterToolbar' }

  /** A single work / chapter page — the only place the reader-mode pill applies. */
  private get onWorkPage(): boolean {
    return /^\/works\/\d+/.test(location.pathname)
  }

  /** Whether any feature that adds a context menu is active on the page. */
  private get menuFeaturesActive(): boolean {
    const o = this.options
    return o.tagToolbar
      || o.fandomToolbar
      || o.markForLaterToolbar
      || o.hideAuthorToolbar
      || o.subscribeAuthorToolbar
      || o.muteAuthorToolbar
      || o.rules.enabled
      || o.workMarks.enabled
  }

  /** Whether the peek pill could apply here (the `filterToolbar` option + a hide feature). */
  private get peekAvailable(): boolean {
    const { filterToolbar, rules, hideCrossovers, hideLanguages, workMarks } = this.options
    return filterToolbar && (
      rules.enabled || hideCrossovers.enabled || hideLanguages.enabled
      || (workMarks.enabled && marksHideAnything(workMarks.marks))
    )
  }

  override get enabled() {
    // `onWorkPage` only reads the URL (available at document_start); the precise
    // `#workskin` check that actually gates the reader pill happens in `ready()`.
    return this.peekAvailable || this.menuFeaturesActive || this.onWorkPage
  }

  static override async clean(): Promise<void> {
    detachOutsideHandler()
    syncPeek = null
    document.body.classList.remove(PEEK_CLASS)
  }

  override async ready(): Promise<void> {
    // The pill is built whenever peeking *could* apply here, not only when
    // something is hidden already: a custom search view hides its works long
    // after this runs, and there'd be nothing left to add the pill to.
    const showPeek = this.peekAvailable
    const showMenus = this.menuFeaturesActive
    // The reader pill needs the actual work text present, not just a work URL.
    const showReader = this.onWorkPage && document.querySelector('#workskin') !== null

    if (!showPeek && !showMenus && !showReader) {
      this.logger.debug('Nothing to show in the filter toolbar.')
      return
    }

    document.body.append(this.buildToolbar(showPeek, showMenus, showReader))
    this.logger.debug(`Filter toolbar added (peek: ${showPeek}, menus toggle: ${showMenus}, reader: ${showReader}).`)
  }

  buildToolbar(showPeek: boolean, showMenus: boolean, showReader: boolean): HTMLElement {
    const panel = <div class={PANEL_CLASS} role="group" />
    if (showReader)
      panel.append(this.buildReaderButton())
    // Built up front but only put in the panel while it has something to say —
    // see syncVisible below. The menus pill is kept to hand as the insertion
    // point, so the peek pill always comes back in the same place.
    const peek = showPeek ? this.buildPeekButton() : null
    const menusButton = showMenus ? this.buildMenusButton() : null
    if (menusButton)
      panel.append(menusButton)

    const fab: HTMLButtonElement = (
      <button type="button" class={FAB_CLASS} aria-haspopup="true" aria-expanded="false">
        <Icon />
      </button>
    ) as HTMLElement as HTMLButtonElement

    // The panel renders above the fab (column layout) so the pills stack upward.
    const container = (
      <div class={`${ADDON_CLASS}  ${TOOLBAR_CLASS}`}>
        {panel}
        {fab}
      </div>
    )

    // The peek pill comes and goes with the count, and with nothing left in the
    // panel there is nothing for the fab to open — so the whole toolbar steps
    // out of the corner rather than leaving a button that opens an empty box.
    const syncVisible = (): void => {
      if (peek) {
        const count = peek.sync()
        if (count > 0 && !peek.button.isConnected) {
          if (menusButton)
            menusButton.before(peek.button)
          else
            panel.append(peek.button)
        }
        else if (count === 0 && peek.button.isConnected) {
          peek.button.remove()
        }
      }
      container.hidden = panel.children.length === 0
    }
    if (peek)
      syncPeek = syncVisible
    syncVisible()

    let open = false
    const setOpen = (next: boolean): void => {
      open = next
      container.classList.toggle(OPEN_CLASS, open)
      fab.setAttribute('aria-expanded', String(open))
      const label = open ? 'Hide extension controls' : 'Show extension controls'
      fab.title = label
      fab.setAttribute('aria-label', label)
    }
    setOpen(false)

    fab.addEventListener('click', (e) => {
      e.preventDefault()
      setOpen(!open)
    })

    // Collapse when the user clicks anywhere outside the toolbar.
    detachOutsideHandler()
    outsideHandler = (e: Event) => {
      if (open && !container.contains(e.target as Node))
        setOpen(false)
    }
    document.addEventListener('pointerdown', outsideHandler, true)

    return container
  }

  /** The peek pill, plus the sync that relabels it and reports the current count. */
  buildPeekButton(): { button: HTMLButtonElement, sync: () => number } {
    const icon: HTMLElement = <span class={`${ADDON_CLASS}--filter-toolbar--icon`} />
    const text: HTMLElement = <span />
    const button: HTMLButtonElement = (
      <button type="button" class={BUTTON_CLASS} aria-pressed="false">
        {icon}
        {text}
      </button>
    ) as HTMLElement as HTMLButtonElement

    const sync = (): number => {
      const count = countHidden()
      if (count === 0)
        return 0
      const noun = count === 1 ? 'work' : 'works'
      const peeking = document.body.classList.contains(PEEK_CLASS)
      icon.replaceChildren(peeking ? <MdiEyeOff /> : <MdiEye />)
      text.textContent = `${peeking ? 'Hide' : 'Show'} ${count} filtered ${noun}`
      button.setAttribute('aria-pressed', String(peeking))
      const label = peeking
        ? 'Re-hide works your filters hid'
        : 'Temporarily show works your filters hid (does not change your filters)'
      button.title = label
      button.setAttribute('aria-label', label)
      return count
    }

    button.addEventListener('click', () => {
      document.body.classList.toggle(PEEK_CLASS)
      sync()
    })

    return { button, sync }
  }

  buildMenusButton(): HTMLElement {
    const icon: HTMLElement = <span class={`${ADDON_CLASS}--filter-toolbar--icon`}><MdiGestureTapHold /></span>
    const text: HTMLElement = <span />
    const button: HTMLButtonElement = (
      <button type="button" class={`${BUTTON_CLASS}  ${ADDON_CLASS}--filter-toolbar--menus`} aria-pressed="false">
        {icon}
        {text}
      </button>
    ) as HTMLElement as HTMLButtonElement

    const sync = () => {
      const enabled = getMenusEnabled()
      // aria-pressed marks the "disabled" override as active, so the button reads
      // as a toggle that's "on" when it has switched the menus off.
      button.setAttribute('aria-pressed', String(!enabled))
      text.textContent = enabled ? 'Disable right-click menus' : 'Enable right-click menus'
      const label = enabled
        ? 'Turn off the extension\'s right-click / long-press menus (restores the browser\'s native menu). To stand it down for one gesture instead, hold Shift while clicking.'
        : 'Turn the extension\'s right-click / long-press menus back on'
      button.title = label
      button.setAttribute('aria-label', label)
    }

    button.addEventListener('click', () => {
      const next = !getMenusEnabled()
      setMenusEnabled(next)
      void options.set({ contextMenusEnabled: next })
      sync()
    })
    sync()

    return button
  }

  buildReaderButton(): HTMLElement {
    // Optimistic local state so the pill flips instantly; the options change also
    // triggers a re-run that rebuilds the toolbar (and (de)activates ReaderMode).
    let on = this.options.readerMode
    const icon: HTMLElement = <span class={`${ADDON_CLASS}--filter-toolbar--icon`}><MdiBookOpenVariant /></span>
    const text: HTMLElement = <span />
    const button: HTMLButtonElement = (
      <button type="button" class={BUTTON_CLASS} aria-pressed="false">
        {icon}
        {text}
      </button>
    ) as HTMLElement as HTMLButtonElement

    const sync = () => {
      // aria-pressed reads as the feature's on/off state (green when on).
      button.setAttribute('aria-pressed', String(on))
      text.textContent = on ? 'Disable reader mode' : 'Enable reader mode'
      const label = on
        ? 'Turn off reader mode (zoom + adjustable width) for this work'
        : 'Turn on reader mode (zoom + adjustable width) for this work'
      button.title = label
      button.setAttribute('aria-label', label)
    }

    button.addEventListener('click', () => {
      on = !on
      void options.set({ readerMode: on })
      sync()
    })
    sync()

    return button
  }
}

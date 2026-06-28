import Icon from '~icons/ao3e/icon.jsx'
import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiEye from '~icons/mdi/eye.jsx'
import MdiGestureTapHold from '~icons/mdi/gesture-tap-hold.jsx'

import { ADDON_CLASS, options } from '#common'
import { getMenusEnabled, setMenusEnabled } from '#content_script/contextTrigger.js'
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
 *
 * Runs after HideWorks so the hidden markers the peek counts are already in place.
 */
export class FilterToolbar extends Unit {
  static override get name() { return 'FilterToolbar' }

  /** Whether any feature that adds a context menu is active on the page. */
  private get menuFeaturesActive(): boolean {
    const o = this.options
    return o.tagToolbar
      || o.fandomToolbar
      || o.markForLaterToolbar
      || o.hideAuthorToolbar
      || o.subscribeAuthorToolbar
      || o.muteAuthorToolbar
      || o.hideWorks.enabled
      || o.hideSeries.enabled
  }

  /** Whether the peek pill could apply here (the `filterToolbar` option + a hide feature). */
  private get peekAvailable(): boolean {
    const { filterToolbar, hideTags, hideAuthors, hideCrossovers, hideLanguages, hideWorks, hideSeries } = this.options
    return filterToolbar && (hideTags.enabled || hideAuthors.enabled || hideCrossovers.enabled || hideLanguages.enabled || hideWorks.enabled || hideSeries.enabled)
  }

  override get enabled() {
    return this.peekAvailable || this.menuFeaturesActive
  }

  static override async clean(): Promise<void> {
    detachOutsideHandler()
    document.body.classList.remove(PEEK_CLASS)
  }

  override async ready(): Promise<void> {
    const count = this.peekAvailable ? document.querySelectorAll(HIDDEN_SELECTOR).length : 0
    const showPeek = count > 0
    const showMenus = this.menuFeaturesActive

    if (!showPeek && !showMenus) {
      this.logger.debug('Nothing to show in the filter toolbar.')
      return
    }

    document.body.append(this.buildToolbar(count, showPeek, showMenus))
    this.logger.debug(`Filter toolbar added (peek: ${showPeek}, menus toggle: ${showMenus}).`)
  }

  buildToolbar(count: number, showPeek: boolean, showMenus: boolean): HTMLElement {
    const panel = <div class={PANEL_CLASS} role="group" />
    if (showPeek)
      panel.append(this.buildPeekButton(count))
    if (showMenus)
      panel.append(this.buildMenusButton())

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

  buildPeekButton(count: number): HTMLElement {
    const noun = count === 1 ? 'work' : 'works'
    const icon: HTMLElement = <span class={`${ADDON_CLASS}--filter-toolbar--icon`} />
    const text: HTMLElement = <span />
    const button: HTMLButtonElement = (
      <button type="button" class={BUTTON_CLASS} aria-pressed="false">
        {icon}
        {text}
      </button>
    ) as HTMLElement as HTMLButtonElement

    const sync = () => {
      const peeking = document.body.classList.contains(PEEK_CLASS)
      icon.replaceChildren(peeking ? <MdiEyeOff /> : <MdiEye />)
      text.textContent = `${peeking ? 'Hide' : 'Show'} ${count} filtered ${noun}`
      button.setAttribute('aria-pressed', String(peeking))
      const label = peeking
        ? 'Re-hide works your filters hid'
        : 'Temporarily show works your filters hid (does not change your filters)'
      button.title = label
      button.setAttribute('aria-label', label)
    }

    button.addEventListener('click', () => {
      document.body.classList.toggle(PEEK_CLASS)
      sync()
    })
    sync()

    return button
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
        ? 'Turn off the extension\'s right-click / long-press menus (restores the browser\'s native menu)'
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
}

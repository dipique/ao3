import MdiEyeCheck from '~icons/mdi/eye-check.jsx'
import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiFilterVariant from '~icons/mdi/filter-variant.jsx'
import MdiStar from '~icons/mdi/star.jsx'

import type { EntityFilter, FilterBehavior } from '#common'

import { ADDON_CLASS, DEFAULT_SERIES_HIGHLIGHT_COLOR, DEFAULT_WORK_HIGHLIGHT_COLOR, options } from '#common'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

/**
 * The four states a work/series filter toggle cycles through, in click order.
 * `unset` means no id-based filter exists; the others map onto a
 * {@link FilterBehavior} (with `hide` stored as a missing behavior).
 */
type ToggleState = 'unset' | 'hide' | 'highlight' | 'invert'
const STATE_ORDER: ToggleState[] = ['unset', 'hide', 'highlight', 'invert']

function nextState(state: ToggleState): ToggleState {
  return STATE_ORDER[(STATE_ORDER.indexOf(state) + 1) % STATE_ORDER.length]!
}

function stateToBehavior(state: ToggleState): FilterBehavior | undefined {
  return state === 'hide' ? undefined : state === 'unset' ? undefined : state
}

/** The toggle only manages the id-based (numeric `value`) filter for an entity. */
function findIdFilter(filters: EntityFilter[], id: string): EntityFilter | undefined {
  return filters.find(f => f.value.trim() === id)
}

function stateOf(filters: EntityFilter[], id: string): ToggleState {
  const filter = findIdFilter(filters, id)
  if (!filter)
    return 'unset'
  return filter.behavior === 'highlight' ? 'highlight' : filter.behavior === 'invert' ? 'invert' : 'hide'
}

/** A toggle button on the page, keyed by entity id so toggling one syncs the rest. */
interface ToggleButton {
  button: HTMLButtonElement
  id: string
}

abstract class FilterEntityToolbar extends Unit {
  /** `'work'` or `'series'` — used in labels. */
  protected abstract get noun(): 'work' | 'series'
  /** The path segment the entity's links use. */
  protected abstract get kind(): 'works' | 'series'
  /** The option key ({@link Unit.options}) holding this kind's filters. */
  protected abstract get optionKey(): 'hideWorks' | 'hideSeries'
  /** Highlight colour shown on the star when a filter highlights without its own colour. */
  protected abstract get defaultColor(): string
  /** CSS class for this kind's toggle buttons. */
  protected abstract get toolbarClass(): string
  /** Live registry of this kind's buttons, shared across page runs. */
  protected abstract get buttons(): ToggleButton[]

  /**
   * Links to decorate: every `/works/:id` (or `/series/:id`) link, returning the
   * id and the element the toggle should be inserted after. Works place the
   * toggle just after the blurb title (left of the mark-for-later button);
   * series place it after each series link.
   */
  protected links(): { id: string, after: HTMLAnchorElement }[] {
    const idRe = new RegExp(`^/${this.kind}/(\\d+)(?:/|$)`)
    const out: { id: string, after: HTMLAnchorElement }[] = []
    const selector = this.kind === 'works'
      ? '.blurb .header h4.heading a[href*="/works/"]'
      : 'a[href*="/series/"]'
    for (const el of document.querySelectorAll<HTMLAnchorElement>(selector)) {
      let id: string | undefined
      try {
        id = new URL(el.href).pathname.match(idRe)?.[1]
      }
      catch {
        continue
      }
      if (id)
        out.push({ id, after: el })
    }
    return out
  }

  override async ready(): Promise<void> {
    this.buttons.length = 0

    const filters = (this.options[this.optionKey]).filters
    for (const { id, after } of this.links()) {
      // clean() already removed previous toolbars, but guard against duplicates
      // (a work can appear in several links within one blurb).
      if (after.nextElementSibling?.classList.contains(this.toolbarClass))
        continue
      after.after(this.buildButton(id, stateOf(filters, id)))
    }

    this.logger.debug(`Added ${this.noun} filter toggles to ${this.buttons.length} links.`)
  }

  buildButton(id: string, state: ToggleState): HTMLButtonElement {
    const button = (
      <button type="button" class={`${ADDON_CLASS}  ${this.toolbarClass}`} aria-pressed="false" />
    ) as HTMLElement as HTMLButtonElement

    this.setButtonState(button, state)

    button.addEventListener('click', (e) => {
      e.preventDefault()
      void this.onClick(id)
    })

    this.buttons.push({ button, id })
    return button
  }

  setButtonState(button: HTMLButtonElement, state: ToggleState): void {
    button.classList.remove(
      `${this.toolbarClass}--hide`,
      `${this.toolbarClass}--highlight`,
      `${this.toolbarClass}--invert`,
    )
    button.style.removeProperty('--ao3e-toggle-color')

    let icon: HTMLElement
    let label: string
    switch (state) {
      case 'hide':
        icon = <MdiEyeOff />
        label = `${this.noun} hidden — click to highlight instead`
        button.classList.add(`${this.toolbarClass}--hide`)
        break
      case 'highlight':
        icon = <MdiStar />
        label = `${this.noun} highlighted — click to always-show instead`
        button.classList.add(`${this.toolbarClass}--highlight`)
        button.style.setProperty('--ao3e-toggle-color', this.defaultColor)
        break
      case 'invert':
        icon = <MdiEyeCheck />
        label = `${this.noun} always shown — click to clear`
        button.classList.add(`${this.toolbarClass}--invert`)
        break
      default:
        icon = <MdiFilterVariant />
        label = `Filter this ${this.noun} (hide / highlight / always-show)`
        break
    }
    button.replaceChildren(icon)
    button.setAttribute('aria-pressed', String(state !== 'unset'))
    button.title = label
    button.setAttribute('aria-label', label)
  }

  async onClick(id: string): Promise<void> {
    // Read the freshest list so we don't clobber a concurrent change (e.g. the
    // options page editing it at the same time).
    const { filters } = await options.get(this.optionKey)

    const target = nextState(stateOf(filters, id))

    const index = filters.findIndex(f => f.value.trim() === id)
    if (index !== -1)
      filters.splice(index, 1)
    if (target !== 'unset')
      filters.push({ value: id, matcher: 'exact', behavior: stateToBehavior(target) })

    await options.set({ [this.optionKey]: { enabled: true, filters } })

    // Reflect the new state immediately on every button for this entity. The
    // options-change listener re-runs the units shortly after (rebuilding these
    // buttons), but that's debounced, so this avoids a visible lag.
    for (const entry of this.buttons) {
      if (entry.id === id)
        this.setButtonState(entry.button, target)
    }
  }
}

const WORK_TOOLBAR_CLASS = `${ADDON_CLASS}--filter-work-toolbar`
const SERIES_TOOLBAR_CLASS = `${ADDON_CLASS}--filter-series-toolbar`
const workButtons: ToggleButton[] = []
const seriesButtons: ToggleButton[] = []

export class FilterWorkToolbar extends FilterEntityToolbar {
  static override get name() { return 'FilterWorkToolbar' }
  override get enabled() { return this.options.hideWorks.enabled }
  protected override get noun() { return 'work' as const }
  protected override get kind() { return 'works' as const }
  protected override get optionKey() { return 'hideWorks' as const }
  protected override get defaultColor() { return this.options.hideWorks.defaultHighlightColor || DEFAULT_WORK_HIGHLIGHT_COLOR }
  protected override get toolbarClass() { return WORK_TOOLBAR_CLASS }
  protected override get buttons() { return workButtons }

  static override async clean(): Promise<void> {
    workButtons.length = 0
  }
}

export class FilterSeriesToolbar extends FilterEntityToolbar {
  static override get name() { return 'FilterSeriesToolbar' }
  override get enabled() { return this.options.hideSeries.enabled }
  protected override get noun() { return 'series' as const }
  protected override get kind() { return 'series' as const }
  protected override get optionKey() { return 'hideSeries' as const }
  protected override get defaultColor() { return this.options.hideSeries.defaultHighlightColor || DEFAULT_SERIES_HIGHLIGHT_COLOR }
  protected override get toolbarClass() { return SERIES_TOOLBAR_CLASS }
  protected override get buttons() { return seriesButtons }

  static override async clean(): Promise<void> {
    seriesButtons.length = 0
  }
}

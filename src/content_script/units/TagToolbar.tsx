import MdiMinusCircle from '~icons/mdi/minus-circle.jsx'
import MdiPlusCircle from '~icons/mdi/plus-circle.jsx'

import { ADDON_CLASS } from '#common'
import {
  type Direction,
  hasTagFilterFields,
  isTagSelected,
  onFilterChange,
  resetFilterSidebarCaches,
  toggleTagFilter,
} from '#content_script/filterSidebar.js'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

const TOOLBAR_CLASS = `${ADDON_CLASS}--tag-toolbar`
const BUTTON_CLASS = `${ADDON_CLASS}--tag-toolbar--button`
const ACTIVE_CLASS = `${ADDON_CLASS}--tag-toolbar--active`
const INCLUDE_CLASS = `${ADDON_CLASS}--tag-toolbar--include`
const EXCLUDE_CLASS = `${ADDON_CLASS}--tag-toolbar--exclude`

/**
 * Blurb tag links we decorate. These are the text-based tags (relationships,
 * characters, additional tags, warnings) shown under each work — NOT the
 * fandom tags in `h5.fandoms`, which are id-based and handled separately.
 */
const TAG_LINK_SELECTOR = '.blurb ul.tags a.tag'

/**
 * Every toolbar button on the page, so a change to one tag's state is reflected
 * on every blurb showing that same tag. Rebuilt on each `ready()`.
 */
const buttons: { button: HTMLElement, name: string, direction: Direction }[] = []

function setButtonState(button: HTMLElement, direction: Direction, selected: boolean): void {
  button.classList.toggle(ACTIVE_CLASS, selected)
  button.setAttribute('aria-pressed', String(selected))
  const verb = direction === 'include' ? 'included' : 'excluded'
  const action = direction === 'include' ? 'Include this tag in' : 'Exclude this tag from'
  const label = selected ? `Remove tag from ${verb} tags` : `${action} the filter`
  button.title = label
  button.setAttribute('aria-label', label)
}

function refreshAll(): void {
  for (const { button, name, direction } of buttons)
    setButtonState(button, direction, isTagSelected(direction, name))
}

// Re-sync when any control (this toolbar, or a hidden-work exclude button)
// mutates the filter. Registered once; refreshAll over an empty registry is a
// harmless no-op between page runs.
onFilterChange(refreshAll)

export class TagToolbar extends Unit {
  static override get name() { return 'TagToolbar' }
  override get enabled() { return this.options.tagToolbar }

  static override async clean(): Promise<void> {
    buttons.length = 0
    resetFilterSidebarCaches()
  }

  override async ready(): Promise<void> {
    buttons.length = 0

    if (!hasTagFilterFields()) {
      this.logger.debug('No filter sidebar on this page; skipping tag toolbars.')
      return
    }

    const tagLinks = document.querySelectorAll(TAG_LINK_SELECTOR)
    for (const tagLink of tagLinks) {
      const name = tagLink.textContent?.trim()
      if (!name)
        continue
      // clean() already removed previous toolbars, but guard against duplicates.
      if (tagLink.nextElementSibling?.classList.contains(TOOLBAR_CLASS))
        continue

      tagLink.after(this.buildToolbar(name))
    }

    refreshAll()
    this.logger.debug(`Added include/exclude toolbars to ${buttons.length / 2} tag links.`)
  }

  buildToolbar(name: string): HTMLElement {
    return (
      <span class={`${ADDON_CLASS} ${TOOLBAR_CLASS}`}>
        {this.buildButton('exclude', name)}
        {this.buildButton('include', name)}
      </span>
    )
  }

  buildButton(direction: Direction, name: string): HTMLElement {
    const Icon = direction === 'include' ? MdiPlusCircle : MdiMinusCircle
    const directionClass = direction === 'include' ? INCLUDE_CLASS : EXCLUDE_CLASS

    const button: HTMLElement = (
      <button type="button" class={`${BUTTON_CLASS} ${directionClass}`} aria-pressed="false">
        <Icon />
      </button>
    )

    button.addEventListener('click', (e) => {
      e.preventDefault()
      if (!toggleTagFilter(direction, name))
        this.logger.warn(`No ${direction} checkbox or field for "${name}"; cannot update filter.`)
    })

    buttons.push({ button, name, direction })
    return button
  }
}

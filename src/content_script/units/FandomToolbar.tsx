import MdiMinusCircle from '~icons/mdi/minus-circle.jsx'
import MdiPlusCircle from '~icons/mdi/plus-circle.jsx'

import { ADDON_CLASS } from '#common'
import {
  type Direction,
  hasFandomFilterFields,
  isFandomSelected,
  loadFandomIdLookup,
  onFilterChange,
  resetFilterSidebarCaches,
  resolveFandomIdSync,
  resolveFandomIdWithFetch,
  scrapeSidebar,
  toggleFandomFilter,
} from '#content_script/filterSidebar.js'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

const TOOLBAR_CLASS = `${ADDON_CLASS}--fandom-toolbar`
const BUTTON_CLASS = `${ADDON_CLASS}--fandom-toolbar--button`
const ACTIVE_CLASS = `${ADDON_CLASS}--fandom-toolbar--active`
const INCLUDE_CLASS = `${ADDON_CLASS}--fandom-toolbar--include`
const EXCLUDE_CLASS = `${ADDON_CLASS}--fandom-toolbar--exclude`
const VISIBLE_CLASS = `${ADDON_CLASS}--fandom-toolbar--visible`

/**
 * Grace period before hiding the toolbar after the pointer leaves the fandom
 * link, so the user can cross the small gap onto the toolbar to click it.
 */
const HIDE_DELAY_MS = 250

/**
 * Blurb fandom links. Unlike the text-based tags handled by TagToolbar, these
 * are id-based: the filter form references fandoms by numeric id, not name, so
 * we must resolve each displayed name to an id before we can filter on it.
 */
const FANDOM_LINK_SELECTOR = 'h5.fandoms a.tag'

// ---------------------------------------------------------------------------
// Per-fandom state shared across every blurb showing the same fandom.
// ---------------------------------------------------------------------------

interface FandomEntry {
  name: string
  href: string
  id: number | null
  resolving: boolean
  buttons: { button: HTMLButtonElement, direction: Direction }[]
}

/** lowercased name -> entry. Rebuilt each ready(). */
const entries = new Map<string, FandomEntry>()

function setButtonState(button: HTMLButtonElement, direction: Direction, entry: FandomEntry): void {
  const known = entry.id != null
  button.disabled = !known
  const selected = known && isFandomSelected(direction, entry.id!)
  button.classList.toggle(ACTIVE_CLASS, selected)
  button.setAttribute('aria-pressed', String(selected))

  let label: string
  if (!known) {
    label = entry.resolving ? 'Looking up fandom id…' : 'Fandom id unknown — cannot filter'
  }
  else {
    const verb = direction === 'include' ? 'included' : 'excluded'
    const action = direction === 'include' ? 'Include this fandom in' : 'Exclude this fandom from'
    label = selected ? `Remove fandom from ${verb} fandoms` : `${action} the filter`
  }
  button.title = label
  button.setAttribute('aria-label', label)
}

function refreshEntry(entry: FandomEntry): void {
  for (const { button, direction } of entry.buttons)
    setButtonState(button, direction, entry)
}

function refreshAll(): void {
  for (const entry of entries.values())
    refreshEntry(entry)
}

// Re-sync when any control mutates the filter (this toolbar or a hidden-work
// exclude button). Registered once; a no-op over an empty registry between runs.
onFilterChange(refreshAll)

export class FandomToolbar extends Unit {
  static override get name() { return 'FandomToolbar' }
  override get enabled() { return this.options.fandomToolbar }

  static override async clean(): Promise<void> {
    entries.clear()
    resetFilterSidebarCaches()
  }

  override async ready(): Promise<void> {
    entries.clear()

    // Only operate on works-listing pages that have the fandom filter form.
    const fandomLinks = document.querySelectorAll(FANDOM_LINK_SELECTOR)
    if (!hasFandomFilterFields() || fandomLinks.length === 0) {
      this.logger.debug('No fandom filter or fandom links on this page; skipping fandom toolbars.')
      return
    }

    await loadFandomIdLookup()
    scrapeSidebar()

    for (const link of fandomLinks) {
      if (!(link instanceof HTMLAnchorElement))
        continue
      const name = link.textContent?.trim()
      if (!name)
        continue
      if (link.nextElementSibling?.classList.contains(TOOLBAR_CLASS))
        continue

      const key = name.toLowerCase()
      let entry = entries.get(key)
      if (!entry) {
        entry = { name, href: link.href, id: resolveFandomIdSync(name), resolving: false, buttons: [] }
        entries.set(key, entry)
      }
      link.after(this.buildToolbar(entry, link))
    }

    refreshAll()
    this.logger.debug(`Added include/exclude toolbars to ${entries.size} fandoms.`)
  }

  buildToolbar(entry: FandomEntry, link: HTMLAnchorElement): HTMLElement {
    const toolbar = (
      <span class={`${ADDON_CLASS} ${TOOLBAR_CLASS}`}>
        {this.buildButton('exclude', entry)}
        {this.buildButton('include', entry)}
      </span>
    )

    // Show/hide is driven from JS (rather than a pure CSS :hover bridge) so a
    // small grace delay lets the pointer cross the gap from the link onto the
    // toolbar without it vanishing. Hovering either element keeps it open.
    let hideTimer: ReturnType<typeof setTimeout> | undefined
    const show = (): void => {
      clearTimeout(hideTimer)
      toolbar.classList.add(VISIBLE_CLASS)
      // Lazily resolve unknown fandoms on first hover so the click is instant.
      if (entry.id == null)
        void this.resolveEntry(entry, link.href)
    }
    const scheduleHide = (): void => {
      clearTimeout(hideTimer)
      hideTimer = setTimeout(() => toolbar.classList.remove(VISIBLE_CLASS), HIDE_DELAY_MS)
    }
    for (const el of [link, toolbar]) {
      el.addEventListener('pointerenter', show)
      el.addEventListener('pointerleave', scheduleHide)
    }
    return toolbar
  }

  buildButton(direction: Direction, entry: FandomEntry): HTMLButtonElement {
    const Icon = direction === 'include' ? MdiPlusCircle : MdiMinusCircle
    const directionClass = direction === 'include' ? INCLUDE_CLASS : EXCLUDE_CLASS

    const button = (
      <button type="button" class={`${BUTTON_CLASS} ${directionClass}`} aria-pressed="false">
        <Icon />
      </button>
    ) as HTMLElement as HTMLButtonElement

    button.addEventListener('click', (e) => {
      e.preventDefault()
      void this.onButtonClick(direction, entry)
    })

    entry.buttons.push({ button, direction })
    return button
  }

  async resolveEntry(entry: FandomEntry, href: string): Promise<void> {
    if (entry.id != null || entry.resolving)
      return
    entry.resolving = true
    refreshEntry(entry)
    const id = await resolveFandomIdWithFetch(entry.name, href)
    entry.resolving = false
    if (id != null)
      entry.id = id
    refreshEntry(entry)
  }

  async onButtonClick(direction: Direction, entry: FandomEntry): Promise<void> {
    if (entry.id == null) {
      // Last-ditch: resolve on click for users who clicked before hover resolved.
      await this.resolveEntry(entry, entry.href)
      if (entry.id == null) {
        this.logger.warn(`Could not resolve an id for "${entry.name}"; cannot filter.`)
        return
      }
    }
    toggleFandomFilter(direction, entry.id, entry.name)
  }
}

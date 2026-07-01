import MdiHelpCircleOutline from '~icons/mdi/help-circle-outline.jsx'
import MdiMinusCircle from '~icons/mdi/minus-circle.jsx'
import MdiPlusCircle from '~icons/mdi/plus-circle.jsx'

import type { MenuItem } from '#content_script/contextMenu.js'
import type { CheckboxGroup } from '#content_script/filterSidebar.js'
import type { FacetKey } from '#content_script/searchView/engine.ts'

import { ADDON_CLASS, getArchiveLink, toast } from '#common'
import { openPopover } from '#content_script/contextMenu.js'
import { attachMenuTrigger, clearMenuTriggers } from '#content_script/contextTrigger.js'
import {
  hasCheckboxGroupFields,
  isCheckboxGroupSelected,
  resetFilterSidebarCaches,
  toggleCheckboxGroupFilter,
} from '#content_script/filterSidebar.js'
import { findFacetBridge } from '#content_script/searchView/facetBridge.ts'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

/**
 * Adds the same include/exclude context menu the tag links get to the four
 * symbols in a blurb's "required tags" 2×2 square: rating, archive warnings,
 * category, and completion status. Right-click / long-press opens the menu; when
 * `openMenuOnClick` is on (or the blurb lives in the in-memory search view) a
 * plain click opens it too instead of AO3's native symbols-key modal — which is
 * still reachable via the menu's "Show Symbol Key" row.
 *
 * Include/exclude drives the in-memory engine when the blurb is inside a search
 * view (via {@link findFacetBridge}), else the page's native filter sidebar. The
 * completion-status symbol has no native sidebar equivalent, so its include/
 * exclude rows appear only inside the search view.
 */

/** The `<a>` wrapping each symbol; AO3 points them all at the symbols-key modal. */
const SYMBOL_SELECTOR = '.blurb ul.required-tags li a'

interface SymbolInfo {
  /** The in-memory engine facet this symbol maps to. */
  facet: FacetKey
  /** The native sidebar checkbox group, or null when there's no sidebar filter. */
  group: CheckboxGroup | null
  /** The tag value(s) the symbol represents (categories/warnings can be several). */
  values: string[]
}

/** Classify a required-tags symbol span into its facet + filter value(s), or null. */
function classifySymbol(span: Element): SymbolInfo | null {
  const title = span.getAttribute('title')?.trim()
    ?? span.querySelector('.text')?.textContent?.trim()
    ?? ''
  const split = title.split(',').map(s => s.trim()).filter(Boolean)

  if (span.classList.contains('rating'))
    return { facet: 'rating', group: 'rating', values: title ? [title] : [] }
  if (span.classList.contains('warnings'))
    return { facet: 'warnings', group: 'archive_warning', values: split }
  if (span.classList.contains('category'))
    return { facet: 'categories', group: 'category', values: split }
  if (span.classList.contains('iswip')) {
    // The engine's status values are "Complete" / "Work in Progress" (not the
    // symbol's "Complete Work" title); read the state from the class instead.
    const complete = span.classList.contains('complete-yes')
    return { facet: 'status', group: null, values: [complete ? 'Complete' : 'Work in Progress'] }
  }
  return null
}

interface FilterTarget {
  isSelected: (dir: 'include' | 'exclude', value: string) => boolean
  toggle: (dir: 'include' | 'exclude', value: string) => void
}

/**
 * Resolve where include/exclude should act for one symbol: the in-memory search
 * view (if the blurb is inside one) or the native sidebar (if it has that group's
 * checkboxes). Null when neither can filter this facet (e.g. completion status on
 * a plain listing).
 */
function filterTargetFor(info: SymbolInfo, anchor: Element): FilterTarget | null {
  const bridge = findFacetBridge(anchor)
  if (bridge) {
    return {
      isSelected: (dir, value) => bridge.isSelected(info.facet, dir, value),
      toggle: (dir, value) => bridge.toggle(info.facet, dir, value),
    }
  }
  if (info.group && hasCheckboxGroupFields(info.group)) {
    const group = info.group
    return {
      isSelected: (dir, value) => isCheckboxGroupSelected(dir, group, value),
      toggle: (dir, value) => void toggleCheckboxGroupFilter(dir, group, value),
    }
  }
  return null
}

// --- Symbols key ("Show Symbol Key" menu row). -----------------------------
// Fetched once and cached; shown in our own popover so it behaves the same on a
// native listing and inside the search view (where AO3's modal script isn't wired
// to the re-mounted blurb nodes).

const SYMBOLS_KEY_CLASS = `${ADDON_CLASS}--symbols-key`
let symbolsKeyCache: HTMLElement | null = null

async function fetchSymbolsKey(): Promise<Node> {
  if (!symbolsKeyCache) {
    const res = await fetch(getArchiveLink('/help/symbols_key'), { credentials: 'same-origin' })
    if (!res.ok)
      throw new Error(`Failed to load symbols key (${res.status})`)
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html')
    const main = (doc.querySelector('#main') ?? doc.body).cloneNode(true) as HTMLElement
    // Drop page chrome that doesn't belong in a floating popover.
    main.querySelectorAll('.actions, .navigation, form, script').forEach(el => el.remove())
    symbolsKeyCache = main
  }
  return (<div class={SYMBOLS_KEY_CLASS}>{symbolsKeyCache.cloneNode(true)}</div>) as HTMLElement
}

function showSymbolsKey(): void {
  void fetchSymbolsKey()
    .then(content => openPopover(content, {
      x: window.innerWidth / 2,
      y: Math.max(48, window.innerHeight / 4),
    }))
    .catch(() => toast('Could not load the symbols key.', { type: 'error' }))
}

// ---------------------------------------------------------------------------

/** Build the symbol's menu fresh at open time (filter state + target are current). */
function buildSymbolMenu(anchor: HTMLAnchorElement, span: Element): MenuItem[] {
  const items: MenuItem[] = []
  const info = classifySymbol(span)
  const target = info ? filterTargetFor(info, anchor) : null

  if (info && target) {
    info.values.forEach((value, i) => {
      const suffix = info.values.length > 1 ? ` "${value}"` : ''
      items.push({
        icon: () => <MdiPlusCircle />,
        label: `Include${suffix} in filter`,
        active: target.isSelected('include', value),
        separatorBefore: i > 0,
        onSelect: () => target.toggle('include', value),
      })
      items.push({
        icon: () => <MdiMinusCircle />,
        label: `Exclude${suffix} from filter`,
        active: target.isSelected('exclude', value),
        onSelect: () => target.toggle('exclude', value),
      })
    })
  }

  items.push({
    icon: () => <MdiHelpCircleOutline />,
    label: 'Show Symbol Key',
    separatorBefore: items.length > 0,
    onSelect: () => showSymbolsKey(),
  })
  return items
}

export class RequiredTagsToolbar extends Unit {
  static override get name() { return 'RequiredTagsToolbar' }
  // Rides with the tag context menu — the same include/exclude-in-filter feature.
  override get enabled() { return this.options.tagToolbar }

  static override async clean(): Promise<void> {
    clearMenuTriggers()
    resetFilterSidebarCaches()
  }

  override async ready(): Promise<void> {
    let count = 0
    for (const anchor of this.root.querySelectorAll<HTMLAnchorElement>(SYMBOL_SELECTOR)) {
      const span = anchor.querySelector(':scope > span')
      if (!span || !classifySymbol(span))
        continue
      // Inside the search view a plain click must open the menu (AO3's native
      // modal isn't wired to the re-mounted blurbs), so hijack clicks there too.
      const clickToOpen = this.options.openMenuOnClick || !!findFacetBridge(anchor)
      attachMenuTrigger(anchor, () => buildSymbolMenu(anchor, span), { clickToOpen })
      count++
    }
    this.logger.debug(`Added required-tags menus to ${count} symbols.`)
  }
}

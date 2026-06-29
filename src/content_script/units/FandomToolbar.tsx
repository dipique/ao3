import MdiCloseCircleOutline from '~icons/mdi/close-circle-outline.jsx'
import MdiEyeCheck from '~icons/mdi/eye-check.jsx'
import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiMinusCircle from '~icons/mdi/minus-circle.jsx'
import MdiPlusCircle from '~icons/mdi/plus-circle.jsx'
import MdiStar from '~icons/mdi/star.jsx'

import type { Tag } from '#common'
import type { MenuItem } from '#content_script/contextMenu.js'

import { DEFAULT_HIGHLIGHT_COLOR, options, TagType } from '#common'
import {
  attachMenuTrigger,
  buildIndicators,
  clearMenuTriggers,
  type IndicatorState,
  standardLinkItems,
} from '#content_script/contextTrigger.js'
import {
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
import { clearTagBehavior, tagBehavior, toggleTagBehavior } from '#content_script/persistentFilters.js'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

/**
 * Blurb fandom links. Unlike the text-based tags handled by TagToolbar, the
 * sidebar filters fandoms by numeric id, so include/exclude must resolve each
 * displayed name to an id first. Hide / always-show / highlight, however, are
 * persistent filters keyed by name (as a {@link TagType.Fandom} tag), so they
 * need no id and work on any page.
 */
const FANDOM_LINK_SELECTOR = 'h5.fandoms a.tag'

interface FandomEntry {
  link: HTMLAnchorElement
  tag: Tag
  behavior: 'hide' | 'invert' | 'highlight' | null
  highlightColor: string
  hasFields: boolean
  indicator: HTMLElement | null
}

const entries: FandomEntry[] = []

function computeStates(entry: FandomEntry): IndicatorState[] {
  const states: IndicatorState[] = []
  if (entry.hasFields) {
    const id = resolveFandomIdSync(entry.tag.name)
    if (id != null) {
      if (isFandomSelected('include', id))
        states.push('include')
      if (isFandomSelected('exclude', id))
        states.push('exclude')
    }
  }
  if (entry.behavior)
    states.push(entry.behavior)
  return states
}

/** Resolve the fandom's id (cached, else fetched) and toggle its sidebar filter. */
async function toggleFandom(direction: 'include' | 'exclude', tag: Tag, link: HTMLAnchorElement): Promise<void> {
  let id = resolveFandomIdSync(tag.name)
  id ??= await resolveFandomIdWithFetch(tag.name, link.href)
  if (id == null)
    return
  toggleFandomFilter(direction, id, tag.name)
}

async function buildFandomMenu(tag: Tag, link: HTMLAnchorElement): Promise<MenuItem[]> {
  const items: MenuItem[] = []

  if (hasFandomFilterFields()) {
    const id = resolveFandomIdSync(tag.name)
    items.push({
      icon: () => <MdiPlusCircle />,
      label: 'Include in filter',
      active: id != null && isFandomSelected('include', id),
      onSelect: () => toggleFandom('include', tag, link),
    })
    items.push({
      icon: () => <MdiMinusCircle />,
      label: 'Exclude from filter',
      active: id != null && isFandomSelected('exclude', id),
      onSelect: () => toggleFandom('exclude', tag, link),
    })
  }

  const { filters } = await options.get('hideTags')
  const behavior = tagBehavior(filters, tag)
  // The active behaviour is shown disabled (current state); "Clear" removes it.
  items.push(
    {
      icon: () => <MdiEyeOff />,
      label: 'Hide',
      danger: true,
      active: behavior === 'hide',
      disabled: behavior === 'hide',
      separatorBefore: items.length > 0,
      onSelect: () => toggleTagBehavior(tag, 'hide'),
    },
    {
      icon: () => <MdiEyeCheck />,
      label: 'Always show',
      active: behavior === 'invert',
      disabled: behavior === 'invert',
      onSelect: () => toggleTagBehavior(tag, 'invert'),
    },
    {
      icon: () => <MdiStar />,
      label: 'Highlight',
      active: behavior === 'highlight',
      disabled: behavior === 'highlight',
      onSelect: () => toggleTagBehavior(tag, 'highlight'),
    },
  )
  if (behavior) {
    items.push({
      icon: () => <MdiCloseCircleOutline />,
      label: 'Clear',
      onSelect: () => clearTagBehavior(tag),
    })
  }

  items.push(...standardLinkItems(link))
  return items
}

function syncIndicator(entry: FandomEntry): void {
  const states = computeStates(entry)
  const next = buildIndicators(states, { highlightColor: entry.highlightColor })
  if (next)
    attachMenuTrigger(next, () => buildFandomMenu(entry.tag, entry.link), { indicator: true })

  if (entry.indicator && next)
    entry.indicator.replaceWith(next)
  else if (entry.indicator && !next)
    entry.indicator.remove()
  else if (!entry.indicator && next)
    entry.link.after(next)

  entry.indicator = next
}

onFilterChange(() => {
  for (const entry of entries)
    syncIndicator(entry)
})

export class FandomToolbar extends Unit {
  static override get name() { return 'FandomToolbar' }
  override get enabled() { return this.options.fandomToolbar }

  static override async clean(): Promise<void> {
    entries.length = 0
    clearMenuTriggers()
    resetFilterSidebarCaches()
  }

  override async ready(): Promise<void> {
    entries.length = 0

    const fandomLinks = this.root.querySelectorAll<HTMLAnchorElement>(FANDOM_LINK_SELECTOR)
    if (fandomLinks.length === 0)
      return

    const hasFields = hasFandomFilterFields()
    // Include/exclude needs the id lookup; hide/highlight (by name) doesn't.
    if (hasFields) {
      await loadFandomIdLookup()
      scrapeSidebar()
    }

    const highlightColor = this.options.hideTags.defaultHighlightColor || DEFAULT_HIGHLIGHT_COLOR
    const { filters } = this.options.hideTags

    for (const link of fandomLinks) {
      const name = link.textContent?.trim()
      if (!name)
        continue

      const tag: Tag = { name, type: TagType.Fandom }
      const entry: FandomEntry = {
        link,
        tag,
        behavior: tagBehavior(filters, tag),
        highlightColor,
        hasFields,
        indicator: null,
      }
      entries.push(entry)

      attachMenuTrigger(link, () => buildFandomMenu(tag, link), { clickToOpen: this.options.openMenuOnClick })
      syncIndicator(entry)
    }

    this.logger.debug(`Added fandom menus to ${entries.length} fandom links.`)
  }
}

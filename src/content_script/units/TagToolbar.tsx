import MdiCloseCircleOutline from '~icons/mdi/close-circle-outline.jsx'
import MdiEyeCheck from '~icons/mdi/eye-check.jsx'
import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiMinusCircle from '~icons/mdi/minus-circle.jsx'
import MdiPlusCircle from '~icons/mdi/plus-circle.jsx'
import MdiStar from '~icons/mdi/star.jsx'

import type { Tag } from '#common'
import type { MenuItem } from '#content_script/contextMenu.js'

import { DEFAULT_HIGHLIGHT_COLOR, options } from '#common'
import {
  attachMenuTrigger,
  buildIndicators,
  clearMenuTriggers,
  type IndicatorState,
  standardLinkItems,
} from '#content_script/contextTrigger.js'
import {
  hasTagFilterFields,
  isTagSelected,
  onFilterChange,
  resetFilterSidebarCaches,
  toggleTagFilter,
} from '#content_script/filterSidebar.js'
import { clearTagBehavior, tagBehavior, toggleTagBehavior } from '#content_script/persistentFilters.js'
import { Unit } from '#content_script/Unit.js'
import { getTagFromElement } from '#content_script/utils.js'
import React from '#dom'

/**
 * Blurb tag links we decorate. These are the text-based tags (relationships,
 * characters, additional tags, warnings) shown under each work — NOT the
 * fandom tags in `h5.fandoms`, which are id-based and handled by FandomToolbar.
 */
const TAG_LINK_SELECTOR = '.blurb ul.tags a.tag'

/**
 * A decorated tag link: the link itself (a menu trigger), the parsed tag, its
 * persistent hide/show/highlight behaviour (snapshot from options this run), and
 * the indicator node currently shown after it (or null when nothing is active).
 * Rebuilt each `ready()`; the ephemeral include/exclude part is re-synced on
 * filter change.
 */
interface TagEntry {
  link: HTMLAnchorElement
  tag: Tag
  behavior: 'hide' | 'invert' | 'highlight' | null
  highlightColor: string
  hasFields: boolean
  indicator: HTMLElement | null
}

const entries: TagEntry[] = []

function computeStates(entry: TagEntry): IndicatorState[] {
  const states: IndicatorState[] = []
  if (entry.hasFields && isTagSelected('include', entry.tag.name))
    states.push('include')
  if (entry.hasFields && isTagSelected('exclude', entry.tag.name))
    states.push('exclude')
  if (entry.behavior)
    states.push(entry.behavior)
  return states
}

/** Build the tag's menu fresh at open time (so include/exclude + saved state are current). */
async function buildTagMenu(tag: Tag, link: HTMLAnchorElement): Promise<MenuItem[]> {
  const items: MenuItem[] = []

  if (hasTagFilterFields()) {
    items.push({
      icon: () => <MdiPlusCircle />,
      label: 'Include in filter',
      active: isTagSelected('include', tag.name),
      onSelect: () => void toggleTagFilter('include', tag.name),
    })
    items.push({
      icon: () => <MdiMinusCircle />,
      label: 'Exclude from filter',
      active: isTagSelected('exclude', tag.name),
      onSelect: () => void toggleTagFilter('exclude', tag.name),
    })
  }

  const { filters } = await options.get('hideTags')
  const behavior = tagBehavior(filters, tag)
  // The three behaviours are mutually exclusive; the active one is shown disabled
  // (it's the current state), with a "Clear" row to return to no rule.
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

/** Insert/replace/remove a tag's indicator to match its current active states. */
function syncIndicator(entry: TagEntry): void {
  const states = computeStates(entry)
  const next = buildIndicators(states, { highlightColor: entry.highlightColor })
  if (next)
    attachMenuTrigger(next, () => buildTagMenu(entry.tag, entry.link), { indicator: true })

  if (entry.indicator && next)
    entry.indicator.replaceWith(next)
  else if (entry.indicator && !next)
    entry.indicator.remove()
  else if (!entry.indicator && next)
    entry.link.after(next)

  entry.indicator = next
}

// Re-sync the include/exclude indicators when any control mutates the sidebar
// filter. Registered once; a no-op over an empty registry between page runs.
onFilterChange(() => {
  for (const entry of entries)
    syncIndicator(entry)
})

export class TagToolbar extends Unit {
  static override get name() { return 'TagToolbar' }
  override get enabled() { return this.options.tagToolbar }

  static override async clean(): Promise<void> {
    entries.length = 0
    clearMenuTriggers()
    resetFilterSidebarCaches()
  }

  override async ready(): Promise<void> {
    entries.length = 0

    const hasFields = hasTagFilterFields()
    const highlightColor = this.options.hideTags.defaultHighlightColor || DEFAULT_HIGHLIGHT_COLOR
    const { filters } = this.options.hideTags

    for (const link of document.querySelectorAll<HTMLAnchorElement>(TAG_LINK_SELECTOR)) {
      const name = link.textContent?.trim()
      if (!name)
        continue

      // getTagFromElement reads the (untrimmed) link text; match the trimmed name
      // used when persistent filters are saved.
      const tag: Tag = { ...getTagFromElement(link), name }
      const entry: TagEntry = {
        link,
        tag,
        behavior: tagBehavior(filters, tag),
        highlightColor,
        hasFields,
        indicator: null,
      }
      entries.push(entry)

      attachMenuTrigger(link, () => buildTagMenu(tag, link))
      syncIndicator(entry)
    }

    this.logger.debug(`Added tag menus to ${entries.length} tag links.`)
  }
}

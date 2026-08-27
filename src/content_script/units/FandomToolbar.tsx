import MdiArrowCollapseVertical from '~icons/mdi/arrow-collapse-vertical.jsx'
import MdiCloseCircleOutline from '~icons/mdi/close-circle-outline.jsx'
import MdiEyeCheck from '~icons/mdi/eye-check.jsx'
import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiStar from '~icons/mdi/star.jsx'
import MdiTagOff from '~icons/mdi/tag-off.jsx'

import type { FilterBehavior, Tag } from '#common'
import type { MenuItem } from '#content_script/contextMenu.js'
import type { FilterTarget } from '#content_script/filterTarget.js'

import { options, ruleTargetColor, TagType } from '#common'
import {
  attachMenuTrigger,
  buildIndicators,
  clearMenuTriggers,
  type IndicatorState,
  standardLinkItems,
} from '#content_script/contextTrigger.js'
import {
  loadFandomIdLookup,
  resetFilterSidebarCaches,
  scrapeSidebar,
} from '#content_script/filterSidebar.js'
import {
  activeFilterDirs,
  filterMenuItems,
  filterTargetFor,
  nativeFandomTarget,
  onFilterTargetChange,
} from '#content_script/filterTarget.js'
import { clearRule, ruleBehavior, ruleIndicatorBehavior, tagKey, toggleRuleBehavior } from '#content_script/persistentFilters.js'
import { findFacetBridge } from '#content_script/searchView/facetBridge.ts'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

/**
 * Blurb fandom links. Unlike the text-based tags handled by TagToolbar, the
 * sidebar filters fandoms by numeric id, so include/exclude must resolve each
 * displayed name to an id first — the one thing the in-memory search view's
 * fandom facet doesn't need, since it filters the works it already holds by
 * name. Hide / always-show / highlight, however, are persistent rules keyed by
 * name (target {@link TagType.Fandom}), so they need no id and work on any page.
 */
const FANDOM_LINK_SELECTOR = 'h5.fandoms a.tag'

interface FandomEntry {
  link: HTMLAnchorElement
  tag: Tag
  behavior: FilterBehavior | null
  highlightColor: string
  /** The search view's fandom facet, or the sidebar's fandom filter, or neither. */
  filter: FilterTarget | null
  indicator: HTMLElement | null
}

const entries: FandomEntry[] = []

function computeStates(entry: FandomEntry): IndicatorState[] {
  const states: IndicatorState[] = activeFilterDirs(entry.filter, entry.tag.name)
  const behavior = ruleIndicatorBehavior(entry.behavior)
  if (behavior)
    states.push(behavior)
  return states
}

async function buildFandomMenu(tag: Tag, link: HTMLAnchorElement, filter: FilterTarget | null): Promise<MenuItem[]> {
  const items: MenuItem[] = filterMenuItems(filter, tag.name)

  const { filters } = await options.get('rules')
  const key = tagKey(tag)
  const behavior = ruleBehavior(filters, key)
  // The active behaviour is shown disabled (current state); "Clear" removes it.
  items.push(
    {
      icon: () => <MdiEyeOff />,
      label: 'Hide',
      scope: 'settings',
      danger: true,
      active: behavior === 'hide',
      disabled: behavior === 'hide',
      onSelect: () => toggleRuleBehavior(key, 'hide'),
    },
    {
      icon: () => <MdiArrowCollapseVertical />,
      label: 'Collapse',
      scope: 'settings',
      active: behavior === 'collapse',
      disabled: behavior === 'collapse',
      onSelect: () => toggleRuleBehavior(key, 'collapse'),
    },
    {
      icon: () => <MdiEyeCheck />,
      label: 'Always show',
      scope: 'settings',
      active: behavior === 'invert',
      disabled: behavior === 'invert',
      onSelect: () => toggleRuleBehavior(key, 'invert'),
    },
    {
      icon: () => <MdiStar />,
      label: 'Highlight',
      scope: 'settings',
      active: behavior === 'highlight',
      disabled: behavior === 'highlight',
      onSelect: () => toggleRuleBehavior(key, 'highlight'),
    },
    {
      // Hides the fandom tag itself wherever it's listed, leaving the work
      // alone. Undoing it is a settings job — the tag is gone from the page.
      icon: () => <MdiTagOff />,
      label: 'Hide this filter',
      scope: 'settings',
      active: behavior === 'hideFilter',
      disabled: behavior === 'hideFilter',
      onSelect: () => toggleRuleBehavior(key, 'hideFilter'),
    },
  )
  if (behavior) {
    items.push({
      icon: () => <MdiCloseCircleOutline />,
      label: 'Clear',
      scope: 'settings',
      onSelect: () => clearRule(key),
    })
  }

  items.push(...standardLinkItems(link))
  return items
}

function syncIndicator(entry: FandomEntry): void {
  const states = computeStates(entry)
  const next = buildIndicators(states, { highlightColor: entry.highlightColor })
  if (next)
    attachMenuTrigger(next, () => buildFandomMenu(entry.tag, entry.link, entry.filter), { indicator: true, link: entry.link })

  if (entry.indicator && next)
    entry.indicator.replaceWith(next)
  else if (entry.indicator && !next)
    entry.indicator.remove()
  else if (!entry.indicator && next)
    entry.link.after(next)

  entry.indicator = next
}

onFilterTargetChange(() => {
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

    // Inside a search view the facet bridge filters by name, so the whole id
    // apparatus is beside the point; on a native listing include/exclude needs
    // the lookup, while hide/highlight (by name) never does.
    const bridged = !!findFacetBridge(fandomLinks[0]!)
    const nativeFilter = bridged ? null : nativeFandomTarget()
    if (nativeFilter) {
      await loadFandomIdLookup()
      scrapeSidebar()
    }

    const { filters, colors } = this.options.rules
    const highlightColor = ruleTargetColor(TagType.Fandom, colors)

    for (const link of fandomLinks) {
      const name = link.textContent?.trim()
      if (!name)
        continue

      const tag: Tag = { name, type: TagType.Fandom }
      const entry: FandomEntry = {
        link,
        tag,
        behavior: ruleBehavior(filters, tagKey(tag)),
        highlightColor,
        // The native fallback carries this link's href, so a fandom missing from
        // the index can still be resolved from its own page on first use.
        filter: filterTargetFor(link, 'fandoms', nativeFilter && nativeFandomTarget(link.href)),
        indicator: null,
      }
      entries.push(entry)

      attachMenuTrigger(link, () => buildFandomMenu(tag, link, entry.filter), { clickToOpen: this.options.openMenuOnClick })
      syncIndicator(entry)
    }

    this.logger.debug(`Added fandom menus to ${entries.length} fandom links.`)
  }
}

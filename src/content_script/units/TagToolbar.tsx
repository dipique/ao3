import MdiArrowCollapseVertical from '~icons/mdi/arrow-collapse-vertical.jsx'
import MdiCloseCircleOutline from '~icons/mdi/close-circle-outline.jsx'
import MdiEyeCheck from '~icons/mdi/eye-check.jsx'
import MdiEyeOff from '~icons/mdi/eye-off.jsx'
import MdiStar from '~icons/mdi/star.jsx'
import MdiTagOff from '~icons/mdi/tag-off.jsx'

import type { FilterBehavior, Tag } from '#common'
import type { MenuItem } from '#content_script/contextMenu.js'
import type { FilterTarget } from '#content_script/filterTarget.js'

import { options, ruleTargetColor } from '#common'
import {
  attachMenuTrigger,
  buildIndicators,
  clearMenuTriggers,
  type IndicatorState,
  standardLinkItems,
} from '#content_script/contextTrigger.js'
import { resetFilterSidebarCaches } from '#content_script/filterSidebar.js'
import {
  activeFilterDirs,
  facetForTagType,
  filterMenuItems,
  filterTargetFor,
  nativeTagTarget,
  onFilterTargetChange,
} from '#content_script/filterTarget.js'
import { clearRule, ruleBehavior, ruleIndicatorBehavior, tagKey, toggleRuleBehavior } from '#content_script/persistentFilters.js'
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
 * persistent hide/show/highlight behaviour (snapshot from options this run), the
 * filter its include/exclude rows drive (the search view the blurb sits in, else
 * the page's sidebar — null when neither can filter this tag), and the indicator
 * node currently shown after it (or null when nothing is active). Rebuilt each
 * `ready()`; the ephemeral include/exclude part is re-synced on filter change.
 */
interface TagEntry {
  link: HTMLAnchorElement
  tag: Tag
  behavior: FilterBehavior | null
  highlightColor: string
  filter: FilterTarget | null
  indicator: HTMLElement | null
}

const entries: TagEntry[] = []

function computeStates(entry: TagEntry): IndicatorState[] {
  const states: IndicatorState[] = activeFilterDirs(entry.filter, entry.tag.name)
  const behavior = ruleIndicatorBehavior(entry.behavior)
  if (behavior)
    states.push(behavior)
  return states
}

/** Build the tag's menu fresh at open time (so include/exclude + saved state are current). */
async function buildTagMenu(tag: Tag, link: HTMLAnchorElement, filter: FilterTarget | null): Promise<MenuItem[]> {
  const items: MenuItem[] = filterMenuItems(filter, tag.name)

  const { filters } = await options.get('rules')
  const key = tagKey(tag)
  const behavior = ruleBehavior(filters, key)
  // The behaviours are mutually exclusive; the active one is shown disabled
  // (it's the current state), with a "Clear" row to return to no rule.
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
      // Hides the tag itself wherever it's listed, leaving the work alone. Once
      // applied the tag is gone from the page, so undoing it is a settings job.
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

/** Insert/replace/remove a tag's indicator to match its current active states. */
function syncIndicator(entry: TagEntry): void {
  const states = computeStates(entry)
  const next = buildIndicators(states, { highlightColor: entry.highlightColor })
  if (next)
    attachMenuTrigger(next, () => buildTagMenu(entry.tag, entry.link, entry.filter), { indicator: true, link: entry.link })

  if (entry.indicator && next)
    entry.indicator.replaceWith(next)
  else if (entry.indicator && !next)
    entry.indicator.remove()
  else if (!entry.indicator && next)
    entry.link.after(next)

  entry.indicator = next
}

// Re-sync the include/exclude indicators when any control mutates the filter —
// AO3's sidebar or a search view's facets. Registered once; a no-op over an empty
// registry between page runs.
onFilterTargetChange(() => {
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

    // Resolved once per run: the sidebar lookup behind it is page-wide, and a
    // run covers one page (or one search view) at a time.
    const nativeFilter = nativeTagTarget()
    const { filters, colors } = this.options.rules

    for (const link of this.root.querySelectorAll<HTMLAnchorElement>(TAG_LINK_SELECTOR)) {
      const name = link.textContent?.trim()
      if (!name)
        continue

      // getTagFromElement reads the (untrimmed) link text; match the trimmed name
      // used when persistent filters are saved.
      const tag: Tag = { ...getTagFromElement(link), name }
      const entry: TagEntry = {
        link,
        tag,
        behavior: ruleBehavior(filters, tagKey(tag)),
        // The star's colour follows the tag's own type, so a highlighted
        // relationship can read differently from a highlighted freeform.
        highlightColor: ruleTargetColor(tag.type ?? 'tag', colors),
        filter: filterTargetFor(link, facetForTagType(tag.type), nativeFilter),
        indicator: null,
      }
      entries.push(entry)

      attachMenuTrigger(link, () => buildTagMenu(tag, link, entry.filter), { clickToOpen: this.options.openMenuOnClick })
      syncIndicator(entry)
    }

    this.logger.debug(`Added tag menus to ${entries.length} tag links.`)
  }
}

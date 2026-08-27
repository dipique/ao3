import MdiCheckCircle from '~icons/mdi/check-circle.jsx'
import MdiMinusCircle from '~icons/mdi/minus-circle.jsx'
import MdiPlusCircle from '~icons/mdi/plus-circle.jsx'

import type { Tag } from '#common'

import { TagType } from '#common'
import React from '#dom'

import type { MenuItem } from './contextMenu.tsx'
import type { CheckboxGroup } from './filterSidebar.js'
import type { FacetDir, FacetKey } from './searchView/engine.ts'

import {
  hasCheckboxGroupFields,
  hasFandomFilterFields,
  hasTagFilterFields,
  isCheckboxGroupSelected,
  isFandomSelected,
  isTagSelected,
  onFilterChange,
  resolveFandomIdSync,
  resolveFandomIdWithFetch,
  toggleCheckboxGroupFilter,
  toggleFandomFilter,
  toggleTagFilter,
} from './filterSidebar.js'
import { findFacetBridge, onFacetChange } from './searchView/facetBridge.ts'

/**
 * Where a blurb decorator's "include / exclude / require in filter" should land.
 *
 * A blurb can sit in either of two filters, and the decorators must not have to
 * care which: AO3's own "Sort and Filter" sidebar on a native listing, or the
 * in-memory engine behind a custom search view (Marked for Later, a
 * non-canonical tag's works, a text-search result set), which has no sidebar to
 * drive at all. Each decorator resolves a {@link FilterTarget} for the value it
 * acts on — the view wins when the element is inside one — and speaks to that.
 *
 * The two differ in what they can express, which is why a target carries its own
 * {@link FilterTarget.dirs}: the engine understands `require` (AND within a
 * facet group) and the sidebar doesn't, so only a bridged menu offers that row.
 */

/** A direction a value can be selected in. `require` is search-view only. */
export type FilterDir = FacetDir

/** Everything AO3's sidebar can express. */
const NATIVE_DIRS = ['include', 'exclude'] as const
/** Everything the in-memory engine can express. */
const FACET_DIRS = ['include', 'exclude', 'require'] as const

export interface FilterTarget {
  /** Which of the two filters this is — a search view's facets, or AO3's sidebar. */
  kind: 'facet' | 'native'
  /** The directions this target can actually apply, in menu order. */
  dirs: readonly FilterDir[]
  isSelected: (dir: FilterDir, value: string) => boolean
  toggle: (dir: FilterDir, value: string) => void
}

/**
 * The tag type each facet group's values are. Readiness, language and completion
 * status are not tags at all, so no tag filter can speak about them.
 */
export const FACET_TAG_TYPES: Partial<Record<FacetKey, TagType>> = {
  rating: TagType.Rating,
  warnings: TagType.ArchiveWarning,
  categories: TagType.Category,
  fandoms: TagType.Fandom,
  relationships: TagType.Relationship,
  characters: TagType.Character,
  freeforms: TagType.Freeform,
}

const TAG_TYPE_FACETS = new Map<TagType, FacetKey>(
  Object.entries(FACET_TAG_TYPES).map(([facet, type]) => [type, facet as FacetKey]),
)

/**
 * The engine facet a tag of this type feeds, or null when there is none — an
 * untyped tag, which can't be filed under one group with any confidence.
 */
export function facetForTagType(type: TagType | undefined): FacetKey | null {
  return (type && TAG_TYPE_FACETS.get(type)) ?? null
}

/**
 * Resolve where a value shown at `el` should be filtered: the search view `el`
 * lives in (when the engine has a facet for this kind of value), else the
 * caller's native-sidebar fallback. Null when neither can filter it — the menu
 * or button then simply doesn't offer the rows.
 *
 * The bridge is tried first on purpose: a page that offers a search view may
 * still have its own — now hidden — filter form behind it, and filling in a form
 * the reader can't see would do nothing they'd notice.
 */
export function filterTargetFor(
  el: Element | null,
  facet: FacetKey | null,
  native: FilterTarget | null = null,
): FilterTarget | null {
  const bridge = facet ? findFacetBridge(el) : null
  if (bridge && facet) {
    return {
      kind: 'facet',
      dirs: FACET_DIRS,
      isSelected: (dir, value) => bridge.isSelected(facet, dir, value),
      toggle: (dir, value) => bridge.toggle(facet, dir, value),
    }
  }
  return native
}

/**
 * The sidebar's text-tag fields — relationships, characters, additional tags and
 * warnings, anything it filters by name. Null when this page has none.
 */
export function nativeTagTarget(): FilterTarget | null {
  if (!hasTagFilterFields())
    return null
  return {
    kind: 'native',
    dirs: NATIVE_DIRS,
    isSelected: (dir, value) => dir !== 'require' && isTagSelected(dir, value),
    toggle: (dir, value) => {
      if (dir !== 'require')
        void toggleTagFilter(dir, value)
    },
  }
}

/**
 * The sidebar's fandom filter, which works by numeric id — so a displayed name
 * has to be resolved first, from the bundled index, the learned cache, or (once,
 * on demand) the fandom's own page at `href`.
 */
export function nativeFandomTarget(href?: string): FilterTarget | null {
  if (!hasFandomFilterFields())
    return null
  return {
    kind: 'native',
    dirs: NATIVE_DIRS,
    isSelected: (dir, value) => {
      if (dir === 'require')
        return false
      const id = resolveFandomIdSync(value)
      return id != null && isFandomSelected(dir, id)
    },
    toggle: (dir, value) => {
      if (dir === 'require')
        return
      void (async () => {
        let id = resolveFandomIdSync(value)
        if (id == null && href)
          id = await resolveFandomIdWithFetch(value, href)
        if (id != null)
          toggleFandomFilter(dir, id, value)
      })()
    },
  }
}

/**
 * One of the sidebar's fixed checkbox groups (rating, archive warning,
 * category), whose full set of boxes is present on every works-filter page.
 */
export function nativeCheckboxTarget(group: CheckboxGroup): FilterTarget | null {
  if (!hasCheckboxGroupFields(group))
    return null
  return {
    kind: 'native',
    dirs: NATIVE_DIRS,
    isSelected: (dir, value) => dir !== 'require' && isCheckboxGroupSelected(dir, group, value),
    toggle: (dir, value) => {
      if (dir !== 'require')
        void toggleCheckboxGroupFilter(dir, group, value)
    },
  }
}

/**
 * The native fallback for a tag, split by type the way AO3's own sidebar splits
 * them: fandoms by id, rating/warning/category by checkbox, everything else
 * (including untyped tags) by name.
 *
 * Only reached on a native listing — inside a search view every tag type goes
 * through the bridge instead.
 */
export function nativeTargetForTag(tag: Tag, href?: string): FilterTarget | null {
  switch (tag.type) {
    case TagType.Fandom: return nativeFandomTarget(href)
    case TagType.Rating: return nativeCheckboxTarget('rating')
    case TagType.ArchiveWarning: return nativeCheckboxTarget('archive_warning')
    case TagType.Category: return nativeCheckboxTarget('category')
    default: return nativeTagTarget()
  }
}

/**
 * The directions `value` is currently selected in — the little icons a decorator
 * shows next to it. A subset of `IndicatorState`, which is what the callers pass
 * it to.
 */
export function activeFilterDirs(filter: FilterTarget | null, value: string): FilterDir[] {
  return filter ? filter.dirs.filter(dir => filter.isSelected(dir, value)) : []
}

/** How each direction presents itself in a context menu. */
const DIR_ITEMS: Record<FilterDir, { icon: () => Node, label: (suffix: string) => string }> = {
  include: { icon: () => <MdiPlusCircle />, label: suffix => `Include${suffix} in filter` },
  exclude: { icon: () => <MdiMinusCircle />, label: suffix => `Exclude${suffix} from filter` },
  // Search-view only — AO3's sidebar has no "every result must have this" filter.
  require: { icon: () => <MdiCheckCircle />, label: suffix => `Require${suffix} in filter` },
}

/**
 * The filter rows for one value, in the order its target lists its directions —
 * two on a native listing, three (with "Require") inside a search view, none at
 * all when nothing can filter it. `suffix` names the value in the label, for
 * menus that offer rows for more than one value at a time.
 */
export function filterMenuItems(filter: FilterTarget | null, value: string, suffix = ''): MenuItem[] {
  if (!filter)
    return []
  return filter.dirs.map(dir => ({
    icon: DIR_ITEMS[dir].icon,
    label: DIR_ITEMS[dir].label(suffix),
    scope: 'search' as const,
    active: filter.isSelected(dir, value),
    onSelect: () => filter.toggle(dir, value),
  }))
}

/**
 * Subscribe to "the filter moved", whichever filter it was. Registered once at
 * module load by each consumer; their refresh functions iterate per-page
 * registries that are rebuilt each run, so a stale call is a harmless no-op.
 */
export function onFilterTargetChange(fn: () => void): void {
  onFilterChange(fn)
  onFacetChange(fn)
}

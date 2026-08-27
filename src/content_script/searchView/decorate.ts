import type { Options } from '#common'
import type { Unit } from '#content_script/Unit.js'

import { ruleMatchesTag } from '#common'
import { pruneDetachedTriggers } from '#content_script/contextTrigger.js'
import { FACET_TAG_TYPES } from '#content_script/filterTarget.js'
import { FandomToolbar } from '#content_script/units/FandomToolbar.tsx'
import { FilterSeriesToolbar, FilterWorkToolbar } from '#content_script/units/FilterEntityToolbars.tsx'
import { HideAuthorToolbar } from '#content_script/units/HideAuthorToolbar.tsx'
import { HideFilters } from '#content_script/units/HideFilters.ts'
import { HideWorks } from '#content_script/units/HideWorks.tsx'
import { HighlightAuthors } from '#content_script/units/HighlightAuthors.ts'
import { HighlightSeries, HighlightWorks } from '#content_script/units/HighlightEntities.ts'
import { HighlightTags } from '#content_script/units/HighlightTags.ts'
import { RequiredTagsToolbar } from '#content_script/units/RequiredTagsToolbar.tsx'
import { Stats } from '#content_script/units/Stats/Stats.ts'
import { TagToolbar } from '#content_script/units/TagToolbar.tsx'
import { WordCountToolbar } from '#content_script/units/WordCountToolbar.tsx'

import type { FacetKey } from './engine.ts'

/**
 * Per-blurb enhancements — units that decide one blurb's fate from that blurb
 * alone. Safe to run lazily, one at a time, as pages are shown. HideWorks
 * collapses the works the reader's rules collapse (first, as on a native
 * listing, so the rest decorate what it leaves — the works a rule *hides* never
 * reach a page at all; see {@link file://./hidden.ts}); Stats adds the kudos/hits
 * ratio, reading time and thousands separators; the highlight units colour
 * favourite tags/authors/works/series, and HideFilters takes the muted ones out
 * of each blurb's tag list.
 *
 * The view mounts every blurb but decorates each at most once (see its
 * `decorated` set), which is what keeps HideWorks — the one unit here that
 * rewrites a blurb rather than adding to it — from wrapping the same work twice.
 */
const BLURB_UNITS = [HideWorks, Stats, HighlightTags, HideFilters, HighlightAuthors, HighlightWorks, HighlightSeries] as typeof Unit[]

/**
 * Context-menu toolbars — units that keep a shared registry of every decorated
 * link (each `ready()` resets it) and match `.blurb`-scoped selectors. They must
 * run once over the whole results container, not per blurb. Their menus open on
 * right-click / long-press (and the indicators they add open on click).
 */
const CONTAINER_UNITS = [TagToolbar, RequiredTagsToolbar, FandomToolbar, HideAuthorToolbar, FilterWorkToolbar, FilterSeriesToolbar, WordCountToolbar] as typeof Unit[]

function runUnit(U: typeof Unit, options: Options, root: ParentNode): void {
  const unit = new U(options, root)
  if (unit.enabled)
    void unit.ready().catch(err => console.error('[searchView] blurb decoration failed', err))
}

/**
 * Apply the per-blurb enhancements to one freshly mounted blurb. Called the first
 * time a blurb is shown, so a large list only decorates what's actually viewed.
 */
export function decorateBlurb(blurb: HTMLElement, options: Options): void {
  for (const U of BLURB_UNITS)
    runUnit(U, options, blurb)
}

/**
 * Wire the context-menu toolbars over the whole results container. Run once per
 * (re-)mount: each toolbar resets its link registry and scans the container. The
 * triggers registry is pruned first to release any from a previous render.
 */
export function decorateContainer(root: HTMLElement, options: Options): void {
  pruneDetachedTriggers()
  for (const U of CONTAINER_UNITS)
    runUnit(U, options, root)
}

/**
 * Build the view's `hideFacetValue` predicate from the user's `'hideFilter'` tag
 * rules — the search view's answer to the native sidebar rows HideFilters hides.
 * Returns undefined when no such rule applies, so the view skips the check
 * entirely.
 */
export function makeFacetHider(options: Options): ((key: FacetKey, value: string) => boolean) | undefined {
  const { enabled, filters } = options.rules
  const hidden = enabled ? filters.filter(f => f.behavior === 'hideFilter') : []
  if (hidden.length === 0)
    return undefined
  return (key, value) => {
    const type = FACET_TAG_TYPES[key]
    return type !== undefined && hidden.some(f => ruleMatchesTag(f, { name: value, type }))
  }
}

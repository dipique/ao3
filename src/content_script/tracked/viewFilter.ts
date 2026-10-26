// Deep into `src/common` rather than through `#common`: the barrel reaches
// `browser` at import time, and this module is meant to load under a plain
// `node --test`. `trackedLists.ts` has no imports of its own, and the engine's
// only one is a type, so the three load bare.
import type { TrackedFacetFilter, TrackedFilter } from '../../common/trackedLists.ts'
import type { FacetKey, FilterState } from '../searchView/engine.ts'

import { canonicalFilter } from '../../common/trackedLists.ts'
import { emptyFilterState, FACET_KEYS, VIEW_ONLY_KEYS } from '../searchView/engine.ts'

export { excludedTagNames } from '../../common/trackedLists.ts'

/**
 * A custom search view's filter as a tracked list keeps it, and back.
 *
 * The view works in {@link FilterState}: a set of selections per facet group,
 * the free-text box and the word-count range. A list keeps the same thing as a
 * {@link TrackedFilter}, canonical and plain enough to sync, because the list
 * outlives the view — it is put back on screen when the reader comes to refine
 * the list, and applied to every page the review reads for it. The groups a
 * filter keeps are the view's own names; the list's module doesn't know them,
 * so it is here that they are read.
 */

/**
 * A view's filter as a list stores it: include, exclude and require become `in`,
 * `ex` and `req`, and the whole goes through {@link canonicalFilter}, so the same
 * filter reached in any order is spelled one way. Undefined when it narrows
 * nothing.
 *
 * Give it the reader's own filter (`readerFilter` in the engine), not the view's
 * whole state: what the reader's rules exclude on their behalf is theirs to
 * change, not the list's. The {@link VIEW_ONLY_KEYS} groups are left out here
 * too, whatever they hold.
 */
export function trackedFilterOf(f: FilterState): TrackedFilter | undefined {
  const facets: Record<string, TrackedFacetFilter> = {}
  for (const key of FACET_KEYS) {
    if (VIEW_ONLY_KEYS.includes(key))
      continue
    const selection = f.facets[key]
    facets[key] = { in: [...selection.include], ex: [...selection.exclude], req: [...selection.require] }
  }
  return canonicalFilter({ facets, text: f.text, words: [f.wordsMin, f.wordsMax] })
}

/** Whether a stored filter's group is one this build's view has, and one a list may keep. */
function isListKey(key: string): key is FacetKey {
  return (FACET_KEYS as readonly string[]).includes(key) && !VIEW_ONLY_KEYS.includes(key as FacetKey)
}

/**
 * A stored filter as the view's own: what a list's works are tested against
 * (`matches` in the engine), and what the view opens with when the list is put
 * back on screen. Null when the list has no filter.
 *
 * It takes whatever storage or a sync handed over, and reads it through
 * {@link canonicalFilter} first. A group this build doesn't know is passed over,
 * which errs toward keeping a work rather than dropping it; so are the
 * {@link VIEW_ONLY_KEYS} groups, which a list never keeps.
 */
export function filterStateOf(filter: unknown): FilterState | null {
  const canonical = canonicalFilter(filter)
  if (!canonical)
    return null
  const state = emptyFilterState()
  for (const [key, selection] of Object.entries(canonical.facets ?? {})) {
    if (!isListKey(key))
      continue
    const group = state.facets[key]
    for (const value of selection.in ?? [])
      group.include.add(value)
    for (const value of selection.req ?? [])
      group.require.add(value)
    for (const value of selection.ex ?? [])
      group.exclude.add(value)
  }
  state.text = canonical.text ?? ''
  state.wordsMin = canonical.words?.[0] ?? null
  state.wordsMax = canonical.words?.[1] ?? null
  return state
}

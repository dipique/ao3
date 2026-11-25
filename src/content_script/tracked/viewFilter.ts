// Deep into `src/common` rather than through `#common`: the barrel reaches
// `browser` at import time, and this module is meant to load under a plain
// `node --test`. `trackedLists.ts` has no imports of its own, and the engine's
// only one is a type, so the three load bare.
import type { Completion } from '../../common/data.ts'
import type { TrackedFacetFilter, TrackedFilter } from '../../common/trackedLists.ts'
import type { FacetKey, FilterState } from '../searchView/engine.ts'

import { canonicalFilter } from '../../common/trackedLists.ts'
import { completionOf, emptyFilterState, FACET_KEYS, selectCompletion, VIEW_ONLY_KEYS, WIP_VALUE } from '../searchView/engine.ts'

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
 * The group a list keeps the status facet's completion choice under, and its
 * two values: the view's own spelling from when completion was a group of its
 * own, which stored filters (and other devices' builds) still use.
 */
const COMPLETION_KEY = 'completion'
const COMPLETE_VALUE = 'Complete'

/** Whether a stored completion selection lets works carrying `value` through. */
function admits(selection: TrackedFacetFilter, value: string): boolean {
  if (selection.ex?.includes(value))
    return false
  if (selection.in?.length && !selection.in.includes(value))
    return false
  // A work carries exactly one completion value, so requiring any other shuts
  // it out.
  return (selection.req ?? []).every(required => required === value)
}

/**
 * A stored completion selection as the one choice it narrows to: complete works
 * only, works in progress only, or (null) either. Any spelling that narrows to
 * one side counts — including one, or excluding the other.
 */
function storedCompletion(selection: TrackedFacetFilter): Completion | null {
  const complete = admits(selection, COMPLETE_VALUE)
  const wip = admits(selection, WIP_VALUE)
  if (complete === wip)
    return null
  return complete ? 'complete' : 'incomplete'
}

/**
 * A view's filter as a list stores it: include, exclude and require become `in`,
 * `ex` and `req`, and the whole goes through {@link canonicalFilter}, so the same
 * filter reached in any order is spelled one way. Undefined when it narrows
 * nothing.
 *
 * Give it the reader's own filter (`readerFilter` in the engine), not the view's
 * whole state: what the reader's rules exclude on their behalf is theirs to
 * change, not the list's. The {@link VIEW_ONLY_KEYS} groups are left out here
 * too, whatever they hold, but for the status group's completion choice, which
 * is kept as the one value it narrows to.
 */
export function trackedFilterOf(f: FilterState): TrackedFilter | undefined {
  const facets: Record<string, TrackedFacetFilter> = {}
  for (const key of FACET_KEYS) {
    if (VIEW_ONLY_KEYS.includes(key))
      continue
    const selection = f.facets[key]
    facets[key] = { in: [...selection.include], ex: [...selection.exclude], req: [...selection.require] }
  }
  const completion = completionOf(f.facets.status)
  if (completion)
    facets[COMPLETION_KEY] = { in: [completion === 'complete' ? COMPLETE_VALUE : WIP_VALUE] }
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
 * {@link VIEW_ONLY_KEYS} groups, which a list never keeps. Its completion goes
 * into the status group.
 */
export function filterStateOf(filter: unknown): FilterState | null {
  const canonical = canonicalFilter(filter)
  if (!canonical)
    return null
  const state = emptyFilterState()
  for (const [key, selection] of Object.entries(canonical.facets ?? {})) {
    if (key === COMPLETION_KEY)
      selectCompletion(state.facets.status, storedCompletion(selection))
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

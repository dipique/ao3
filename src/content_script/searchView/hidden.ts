import type { Options } from '#common'
import type { Work } from '#content_script/blurb.js'
import type { HideVerdict } from '#content_script/units/HideWorks.tsx'

import { blurbOf, hasNode } from '#content_script/blurb.js'
import { FACET_TAG_TYPES, facetForTagType } from '#content_script/filterTarget.js'
import { hideVerdict } from '#content_script/units/HideWorks.tsx'

import type { FacetKey, FacetValueRef } from './engine.ts'

import { makeFacetHider } from './decorate.ts'
import { facetValues } from './engine.ts'

/** The facet groups a tag rule can speak about — the ones whose values are tags. */
const TAG_FACETS = Object.keys(FACET_TAG_TYPES) as FacetKey[]

/**
 * One value in one group as a single string, so a Set can hold the pair. A
 * colon separates them: no facet key contains one, and every lookup is built
 * by this same function.
 */
function facetKey(key: FacetKey, value: string): string {
  return `${key}:${value}`
}

/**
 * Stamp each work with whether the reader's rules take it out of the listing
 * outright — {@link Work.hidden}, the view's cue to drop it from the results
 * rather than let HideWorks collapse it in place — and, when
 * {@link Options.autoExcludeHidden} is on, hand as many of those decisions as
 * possible to the view's own filter instead. Returns the facet exclusions that
 * takes, for the caller to seed the view with.
 *
 * The hidden/collapsed distinction only matters here. On a native listing a
 * hidden work still occupies its slot in AO3's twenty-per-page, so hiding it can
 * only ever leave a shorter page; in one of our views the works are ours to
 * page, so a rule that says "I never want to see this" should cost the reader
 * nothing — 25 results asked for is 25 results shown.
 *
 * Handing a work over changes nothing about what the reader sees: the exclusion
 * drops it from the results exactly as `hidden` did. What it buys is that the
 * reason is now *on screen* — a row in the facet sidebar, with its count, that
 * can be lifted — which is the same bargain the option strikes with AO3's own
 * sidebar on a native listing. It only happens when **every** reason the work is
 * gone can be put that way (an author or work rule, a mark, a crossover cannot),
 * so a work is never quietly let back in.
 *
 * A post-pass over the whole set rather than something the per-blurb decoration
 * works out, because that decoration only runs on the page being *shown*: the
 * view has to know which works are gone before it can decide what a page is.
 * Runs on every load, cached or fresh, so it follows an options change.
 *
 * `hidesNothing` is a list the reader built themselves, where none of this
 * applies: every work on it is there because they put it there, and taking one
 * away for carrying a tag they usually skip answers a question nobody asked. No
 * work is hidden, none is handed to the filter either — an exclusion would take
 * it off the list just as surely — and the per-blurb half of the same decision
 * is switched off beside it (see `decorateBlurb`).
 */
export function applyHidden(works: Work[], options: Options, opts: { hidesNothing?: boolean } = {}): FacetValueRef[] {
  if (opts.hidesNothing) {
    for (const work of works)
      stamp(work, false, false)
    return []
  }
  const verdicts = works.map(work => hideVerdict(blurbOf(work), options))
  const handOver = options.autoExcludeHidden && options.rules.enabled

  // Values still carried by a work the rules leave on screen — one an "always
  // show" rule rescued, or one merely collapsed. Excluding such a value would
  // take that work away too, undoing the very rule that kept it, so it is off
  // limits however many hidden works also carry it.
  const kept = new Set<string>()
  if (handOver) {
    works.forEach((work, index) => {
      if (verdicts[index]!.mode === 'hide')
        return
      for (const facet of TAG_FACETS) {
        for (const value of facetValues(work, facet))
          kept.add(facetKey(facet, value))
      }
    })
  }
  // A value the reader has muted ("hide filter") has no row to show an exclusion
  // on, and the view drops any selection on one — so an exclusion there would
  // silently lapse and let the work back in.
  const muted = handOver ? makeFacetHider(options) : undefined

  const excludes = new Map<string, FacetValueRef>()
  works.forEach((work, index) => {
    const verdict = verdicts[index]!
    const handed = handOver && verdict.mode === 'hide'
      ? asExclusions(verdict, kept, muted)
      : null
    stamp(work, verdict.mode === 'hide' && !handed, !!handed)
    for (const ref of handed ?? [])
      excludes.set(facetKey(ref.key, ref.value), ref)
  })

  return [...excludes.values()]
}

/**
 * Record how the hiding leaves one work: gone from the results, and whether it
 * is gone because the view's own filter was handed the reason — which tells
 * HideWorks that a work of this kind is on screen only because the reader lifted
 * that exclusion, so it collapses rather than leaving a blank slot.
 *
 * Always both fields, never just the one that changed: the same works are
 * re-stamped on every load, and a view reopened from memory is handed the very
 * objects the last one stamped, so anything left unwritten would outlive the
 * options that wrote it. A node not built yet takes the stamp from the work when
 * it is.
 */
function stamp(work: Work, hidden: boolean, filtered: boolean): void {
  work.hidden = hidden
  work.filtered = filtered
  if (!hasNode(work))
    return
  if (filtered)
    work.el.dataset.ao3eFiltered = ''
  else
    delete work.el.dataset.ao3eFiltered
}

/**
 * Every reason this work is hidden, as facet exclusions — or null the moment one
 * of them can't be. All or nothing: a work let into the results on a partial
 * exclusion would be one the reader's rules say they never want to see.
 */
function asExclusions(
  verdict: HideVerdict,
  kept: Set<string>,
  muted: ((key: FacetKey, value: string) => boolean) | undefined,
): FacetValueRef[] | null {
  const refs: FacetValueRef[] = []
  for (const { target, rule } of verdict.excludes) {
    // No rule means a mark, a crossover or a language — the reader's own
    // bookkeeping, which is not a property of the work for a filter to act on.
    if (!target || !rule)
      return null
    const key = facetForTagType(target.type)
    if (!key || kept.has(facetKey(key, target.name)) || muted?.(key, target.name))
      return null
    refs.push({ key, value: target.name })
  }
  return refs.length > 0 ? refs : null
}

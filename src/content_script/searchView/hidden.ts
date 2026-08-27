import type { Options } from '#common'
import type { Work } from '#content_script/blurb.js'

import { getBlurb } from '#content_script/blurb.js'
import { hideVerdict } from '#content_script/units/HideWorks.tsx'

/**
 * Stamp each work with whether the reader's rules take it out of the listing
 * outright — {@link Work.hidden}, the view's cue to drop it from the results
 * rather than let HideWorks collapse it in place.
 *
 * The distinction only matters here. On a native listing a hidden work still
 * occupies its slot in AO3's twenty-per-page, so hiding it can only ever leave a
 * shorter page; in one of our views the works are ours to page, so a rule that
 * says "I never want to see this" should cost the reader nothing — 25 results
 * asked for is 25 results shown.
 *
 * A post-pass over the whole set rather than something the per-blurb decoration
 * works out, because that decoration only runs on the page being *shown*: the
 * view has to know which works are gone before it can decide what a page is.
 * Runs on every load, cached or fresh, so it follows an options change.
 */
export function applyHidden(works: Work[], options: Options): void {
  for (const work of works)
    work.hidden = hideVerdict(getBlurb(work.el), options).mode === 'hide'
}

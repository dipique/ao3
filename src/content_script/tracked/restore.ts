import type { Options } from '#common'
import type { OpenOptions } from '#content_script/searchView/host.tsx'

import { isOpening } from '#content_script/searchView/host.tsx'

import { pendingRestore, restoreDone } from './refining.ts'
import { filterStateOf } from './viewFilter.ts'

/**
 * Put a tracked list's view filter back on screen, for a tab that has just
 * arrived on the list's own page by its refining link — the step that lets the
 * reader refine a custom search where they left it, instead of from a blank
 * view. Each custom search unit (an uncommon tag's works, a series, a works
 * search) calls this from `ready()` when it has no view of its own to reopen.
 *
 * `open` opens the unit's view with the options it is given, and `cacheKey` is
 * that view's, to tell its opens apart from anyone else's.
 *
 * **Once, on arrival.** The tab's mark says the filter still has to go back
 * ({@link pendingRestore}); this clears that as soon as its open has settled, so
 * no later run of the page puts the filter back over whatever the reader has
 * done with it since. Every options change re-runs the page, and those re-runs
 * reopen the view as the reader left it, not as the list has it.
 *
 * **But not too soon.** The first visit to a list's page can itself write to the
 * options — filling in what the list is, a tag's category say — and so re-run the
 * page straight away. A view already on screen by then is carried through that
 * re-run like any other. One still loading is not: the re-run takes the page
 * down around it. So the mark is left alone while a newer open of the same view
 * has taken over, which is the re-run calling this again; that call finishes the
 * job, and clears it.
 *
 * A list with no view filter has nothing to put back; the mark is cleared and
 * the page left as the archive drew it.
 */
export async function restoreListFilter(options: Options, cacheKey: string, open: (opts: OpenOptions) => Promise<void>): Promise<void> {
  if (!options.trackedLists.enabled)
    return
  const list = pendingRestore(options.trackedLists.lists)
  if (!list)
    return
  const seed = filterStateOf(list.filter)
  if (seed)
    await open({ seed })
  // Opened, failed or cancelled, the arrival is over — unless a re-run has
  // started this view again, and will be back here when it's done.
  if (!isOpening(cacheKey))
    restoreDone(list.id)
}

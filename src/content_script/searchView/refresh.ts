import type { SnapshotDescriptor } from '#common'
import type { Work } from '#content_script/blurb.js'

import { withPage } from '#common'
import { PATIENCE, WAIT_BUDGET } from '#content_script/archiveFetch.js'

import { writeSnapshot } from './cache.ts'
import { detectPageCount, fetchPageDoc, MAX_SCANNED_PAGES, scrapeListing } from './scrape.ts'

/**
 * Re-scrape a stored listing from outside the page it came from — the options
 * page, driving the site export.
 *
 * Everything the live path gets from its document, this gets from the snapshot's
 * {@link SnapshotDescriptor} instead: the URL from `listUrl`, the page count
 * from a fetched page 1 rather than the pagination on screen.
 *
 * **Import discipline.** This module deliberately imports only `scrape.ts`,
 * `cache.ts` and `blurb.ts`, never `host.tsx` — the host pulls in `decorate.ts`,
 * and with it very nearly every Unit, which is a great deal of content script to
 * drag into the options bundle for a function that only fetches and stores.
 *
 * The fetches carry the reader's AO3 session even though the options page is an
 * extension origin: both browsers treat a request to a host in
 * `host_permissions` as privileged rather than cross-site, so `SameSite=Lax`
 * cookies ride along (measured). Nothing here needs an AO3 tab open.
 */

/** Works per listing page, as {@link file://./host.tsx}'s budget assumes. */
const WORKS_PER_PAGE = 20

export interface RefreshOptions {
  /** Snapshot to rewrite — the same key the search view stores under. */
  cacheKey: string
  descriptor: SnapshotDescriptor
  /**
   * Ceiling on works kept, i.e. `options.searchMaxResults`. A listing with more
   * is loaded up to the ceiling and reported as {@link RefreshResult.truncated};
   * AO3 will happily serve a text search half a million works deep.
   */
  limit: number
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
  /**
   * Persist whatever else the source keeps in step with its snapshot, mirroring
   * `SearchSource.onPersist` on the live path (a Marked for Later refresh, for
   * instance, is the only thing that can bring the saved-work id index up to
   * date). Left to the caller: which side-tables a listing owns is a property of
   * the source, and this module only knows the descriptor.
   */
  onPersist?: (works: Work[]) => Promise<void>
  /**
   * Which of the listing's works the stored list actually holds, mirroring
   * `SearchSource.select` on the live path.
   *
   * A list whose works are *chosen from* its listing rather than being it — the
   * read list, which reads the reader's AO3 history looking for the works they
   * have marked — would otherwise be refreshed into the listing itself, and the
   * next export would be their whole browsing history. Left to the caller for the
   * same reason {@link onPersist} is: which listings are like that is a property
   * of the source, and this module only knows the descriptor.
   */
  select?: (works: Work[]) => Work[]
  /** Whether the scrape may stop early, given the ids seen — see `ScrapeOptions`. */
  satisfied?: (ids: ReadonlySet<string>) => boolean
}

export interface RefreshResult {
  works: Work[]
  /** Pages actually fetched (a page that kept failing is skipped, not fatal). */
  loadedPages: number
  /** Pages requested under the ceiling. */
  fetchedPages: number
  /** Pages the listing really has. */
  totalPages: number
  /** The ceiling cut the listing short. */
  truncated: boolean
  /**
   * AO3 kept refusing, so the scrape came back short and **nothing was written**
   * — the stored list is still whatever it was. A partial listing saved over a
   * complete one would lose works on the strength of a bad few minutes, and take
   * the ids of whatever side table the source keeps with them. The caller should
   * stop and resume later rather than treat this as the new list.
   */
  blocked: boolean
  /**
   * Page 1 came back with `body.logged-in`. False means AO3 served the signed-out
   * view, and what was scraped is at best partial: no restricted works, no
   * private listing at all. The caller reports it; the snapshot is still written,
   * because a signed-out scrape of a public listing is perfectly good.
   */
  loggedIn: boolean
}

/**
 * Fetch the listing named by `descriptor` and rewrite its snapshot.
 *
 * Throws if page 1 can't be fetched at all — without it there is no page count
 * and no way to tell an empty listing from a broken one. Individual later pages
 * that fail are skipped, and show up as `loadedPages < fetchedPages`.
 */
export async function refreshSnapshot(opts: RefreshOptions): Promise<RefreshResult> {
  const { cacheKey, descriptor, limit, onProgress, signal, onPersist, select, satisfied } = opts

  // This is the job's refresh, run from the options page with nobody watching —
  // so it waits a rate limit out rather than failing back to a reader who isn't
  // there. The same scrape from a live AO3 page keeps the impatient default.
  const firstPageDoc = await fetchPageDoc(withPage(descriptor.listUrl, 1), signal, PATIENCE.bulk)
  const loggedIn = firstPageDoc.body?.classList.contains('logged-in') ?? false
  const totalPages = Math.max(1, detectPageCount(firstPageDoc))

  // A ceiling under one page would fetch nothing at all; one page is the floor.
  const ceiling = Math.max(WORKS_PER_PAGE, Math.floor(limit) || WORKS_PER_PAGE)
  // A selected list is searching a haystack: its ceiling bounds what comes out,
  // so the listing gets read as far as `satisfied` or the page cap allows.
  const fetchedPages = select
    ? Math.min(totalPages, MAX_SCANNED_PAGES)
    : Math.min(totalPages, Math.ceil(ceiling / WORKS_PER_PAGE))

  const { works: scraped, loadedPages, blocked } = await scrapeListing({
    pageCount: fetchedPages,
    pageUrl: page => withPage(descriptor.listUrl, page),
    blurbSelector: descriptor.blurbSelector,
    firstPageDoc,
    onProgress,
    signal,
    patience: PATIENCE.bulk,
    satisfied,
    // Nobody is watching this one, so it waits a rate limit out rather than
    // handing back a listing with holes in it.
    waitBudget: WAIT_BUDGET.bulk,
  })

  const works = select ? select(scraped) : scraped
  // The pages fetched can hold more than the ceiling; the hard trim keeps it exact.
  if (works.length > ceiling)
    works.length = ceiling

  // See `RefreshResult.blocked`: what we have is not the list, so it does not
  // become the stored one.
  if (!blocked) {
    await writeSnapshot(cacheKey, works, descriptor)
    await onPersist?.(works)
  }

  return {
    works,
    loadedPages,
    fetchedPages,
    totalPages,
    blocked: !!blocked,
    truncated: fetchedPages < totalPages,
    loggedIn,
  }
}

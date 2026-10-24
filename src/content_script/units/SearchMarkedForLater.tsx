import type { OpenOptions, SearchSource } from '#content_script/searchView/host.tsx'

import { getArchiveLink, readWorkIds } from '#common'
import { linkedTo } from '#content_script/lists/openLink.ts'
import { markedForLaterKey, ownMarkedForLaterPage } from '#content_script/markedForLaterCopy.ts'
import { loadMarkedForLaterIndex, saveMarkedForLaterIndex } from '#content_script/markedForLaterIndex.js'
import { hideClearHistory, showClearHistory } from '#content_script/readingsNav.ts'
import { refreshIntervalMs } from '#content_script/searchView/freshness.ts'
import { openSearchView, resumeSearchView, suspendSearchView } from '#content_script/searchView/host.tsx'
import { detectPageCount } from '#content_script/searchView/scrape.ts'
import { applyStatus } from '#content_script/searchView/status.ts'
import { Unit } from '#content_script/Unit.js'
import { onTakenOffMarkedForLater, seedMarkedForLater } from '#content_script/units/FilterEntityToolbars.tsx'

/**
 * Identifies this use of the search view for local layout prefs (collapsed
 * groups, facet order, sort). One id for the whole feature — not per-user — so a
 * user's layout follows them across accounts on the same device.
 */
const SOURCE_ID = 'marked-for-later'

/**
 * Replaces your own Marked for Later page with one in-memory, instantly
 * filterable/sortable view of every page of the list. It opens by itself and
 * there is no native list to go back to: two versions of the same list on one
 * page was one too many, and a reload landing on AO3's paged version instead of
 * the one being used was the worst of both. Its open URL opens it whatever the
 * switch says ({@link file://./../lists/openLink.ts}).
 *
 * A stored snapshot renders instantly, and the list is only reloaded behind it
 * once that snapshot is older than the reader's refresh interval — which, now
 * that every visit to the page opens the view, is what keeps a long list from
 * costing dozens of requests each time. Everything generic about that lives in
 * the shared search-view host ({@link file://./../searchView/host.tsx}); this
 * unit is only the source.
 */
export class SearchMarkedForLater extends Unit {
  static override get name() { return 'SearchMarkedForLater' }
  override get enabled() { return this.options.searchMarkedForLater || linkedTo('marked-for-later') }

  static override async clean(): Promise<void> {
    // A global re-run (options change, navigation) tears the view down. If it was
    // open, snapshot it so ready() can reopen it where the user left off.
    suspendSearchView()
    showClearHistory()
  }

  override async ready(): Promise<void> {
    const pageUser = ownMarkedForLaterPage()
    if (!pageUser)
      return

    // Clearing the reader's whole history is History's business, not this list's.
    hideClearHistory()

    // If a global re-run took the view down, put it back (from memory, no
    // re-scrape) where the reader left off — so e.g. a "Hide tag" context-menu
    // action doesn't reset their filters — or, still loading, as far as it had
    // got. Otherwise it simply opens, as the page.
    if (!resumeSearchView(markedForLaterKey(pageUser), opts => this.openView(pageUser, opts)))
      void this.openView(pageUser)
  }

  async openView(userId: string, opts: OpenOptions = {}): Promise<void> {
    // Loaded up front so marking a work read here can take it out of the index
    // straight away (`noteMarkedForLater` does nothing to an index it hasn't
    // read), rather than waiting for the next scrape to rewrite it.
    await loadMarkedForLaterIndex(userId).catch(err => this.logger.error('Could not read the saved-work index', err))
    await openSearchView(this.source(userId, readWorkIds(this.options.workMarks)), this.options, opts)
  }

  /** Everything the shared host needs to know about a Marked for Later list. */
  source(userId: string, read: ReadonlySet<string>): SearchSource {
    return {
      id: SOURCE_ID,
      cacheKey: markedForLaterKey(userId),
      descriptor: () => ({
        sourceId: SOURCE_ID,
        label: `Marked for Later — ${userId}`,
        listUrl: getArchiveLink(`/users/${userId}/readings?show=to-read`),
      }),
      pageUrl: page => getArchiveLink(`/users/${userId}/readings?show=to-read&page=${page}`),
      pageCount: () => detectPageCount(document),
      replacesListing: true,
      // A work the reader has marked read is done with, whatever AO3 still lists
      // — it comes off the moment the mark goes on. If AO3 didn't take it off
      // its own list too, the read list's Status facet will say so.
      belongs: work => !read.has(work.workId),
      // A to-read list runs to hundreds of works for some readers, and a full
      // reload on every visit is exactly what gets them rate-limited.
      refreshInterval: () => refreshIntervalMs(this.options.searchProfileListsRefreshHours),
      // A to-read list is the reader's own: they put every work on it by hand,
      // and a rule taking one back off would only make the list they built lie
      // about what is on it.
      hidesNothing: true,
      nativeElements: () => document.querySelectorAll('#main ol.reading.work.index.group, #main ol.pagination'),
      mount: (container) => {
        const anchor = document.querySelector('#main ul.navigation.actions')
          ?? document.querySelector('#main ol.reading.work.index.group')
        anchor?.after(container)
      },
      prepare: (works) => {
        // Every work here is marked for later — keep the work menu's saved state
        // in step with the set before it decorates the blurbs, as the list's own
        // works, which draws their clocks.
        seedMarkedForLater(works.map(work => work.workId), { listed: true })
        applyStatus(works, this.options)
      },
      // This page is the only place that sees the whole list, so the id index
      // every *other* listing reads ({@link file://./../markedForLaterIndex.ts})
      // is written with the snapshot — an index that lagged it would show the
      // clock on works already triaged away.
      onPersist: works => saveMarkedForLaterIndex(userId, works.map(work => work.workId)),
      // Its works are marked read from their own menus: the clock on each title
      // opens one. A work taken off the list there leaves the view at once.
      leaving: drop => onTakenOffMarkedForLater(drop),
      emptyMessage: 'No works found in your Marked for Later list.',
      errorMessage: 'Could not load your Marked for Later list.',
    }
  }
}

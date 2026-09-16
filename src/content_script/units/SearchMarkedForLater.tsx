import type { Work } from '#content_script/blurb.js'
import type { SearchSource } from '#content_script/searchView/host.tsx'
import type { ViewState } from '#content_script/searchView/view.tsx'

import { getArchiveLink, parseUser, readWorkIds, toast } from '#common'
import { loadMarkedForLaterIndex, noteMarkedForLater, saveMarkedForLaterIndex } from '#content_script/markedForLaterIndex.js'
import { submitMark } from '#content_script/markForLater.js'
import { hideClearHistory, showClearHistory } from '#content_script/readingsNav.ts'
import { openSearchView, suspendSearchView, takeReopen } from '#content_script/searchView/host.tsx'
import { detectPageCount } from '#content_script/searchView/scrape.ts'
import { applyStatus } from '#content_script/searchView/status.ts'
import { Unit } from '#content_script/Unit.js'
import { seedMarkedForLater } from '#content_script/units/FilterEntityToolbars.tsx'
import { applyMarkGroup } from '#content_script/workMarks.js'

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
 * the one being used was the worst of both.
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
  override get enabled() { return this.options.searchMarkedForLater }

  static override async clean(): Promise<void> {
    // A global re-run (options change, navigation) tears the view down. If it was
    // open, snapshot it so ready() can reopen it where the user left off.
    suspendSearchView()
    showClearHistory()
  }

  override async ready(): Promise<void> {
    // Only your own Marked for Later page, and only when logged in.
    const match = location.pathname.match(/^\/users\/([^/]+)\/readings\/?$/)
    if (!match)
      return
    if (new URLSearchParams(location.search).get('show') !== 'to-read')
      return
    if (!document.body.classList.contains('logged-in'))
      return
    const pageUser = match[1]!
    const currentUser = parseUser(document)?.userId
    if (!currentUser || currentUser.toLowerCase() !== pageUser.toLowerCase())
      return

    // Clearing the reader's whole history is History's business, not this list's.
    hideClearHistory()

    // If a global re-run closed the view, put it back (from memory, no re-scrape)
    // where the reader left off — so e.g. a "Hide tag" context-menu action
    // doesn't reset their filters. Otherwise it simply opens, as the page.
    const pending = takeReopen(snapshotKey(pageUser))
    void this.openView(pageUser, pending ? { initialState: pending, refresh: false } : {})
  }

  async openView(userId: string, opts: { initialState?: ViewState, refresh?: boolean } = {}): Promise<void> {
    // Loaded up front so a "Mark as Read" here can take the work out of it
    // straight away (`noteMarkedForLater` does nothing to an index it hasn't
    // read), rather than waiting for the next scrape to rewrite it.
    await loadMarkedForLaterIndex(userId).catch(err => this.logger.error('Could not read the saved-work index', err))
    await openSearchView(this.source(userId, readWorkIds(this.options.workMarks)), this.options, opts)
  }

  /** Everything the shared host needs to know about a Marked for Later list. */
  source(userId: string, read: ReadonlySet<string>): SearchSource {
    return {
      id: SOURCE_ID,
      cacheKey: snapshotKey(userId),
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
      refreshInterval: () => Math.max(0, this.options.searchProfileListsRefreshHours || 0) * 60 * 60_000,
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
        // in step with the set before it decorates the blurbs.
        seedMarkedForLater(works.map(work => work.workId))
        applyStatus(works, this.options)
      },
      // This page is the only place that sees the whole list, so the id index
      // every *other* listing reads ({@link file://./../markedForLaterIndex.ts})
      // is written with the snapshot — an index that lagged it would show the
      // clock on works already triaged away.
      onPersist: works => saveMarkedForLaterIndex(userId, works.map(work => work.workId)),
      viewConfig: {
        // Each blurb gets a "Mark as Read" button; on success the view drops the
        // work and reports the reduced set, which the host persists so the
        // snapshot (and a reopen from cache) stays in sync with the server.
        blurbAction: {
          label: 'Mark as Read',
          title: 'Mark as read — remove this work from your Marked for Later list',
          run: async (work: Work) => {
            try {
              // save: false ⇒ POST /works/:id/mark_as_read (leaves reading history).
              await submitMark(work.workId, false)
              // The saved-work index is kept by scrapes and by the actions that
              // change it, not by this list's snapshot, which leaves out works
              // it has pruned (see `belongs`) and so can't be what it's rebuilt
              // from.
              noteMarkedForLater(work.workId, false)
            }
            catch (err) {
              this.logger.error('Mark as read failed', err)
              toast('Could not mark this work as read.', { type: 'error' })
              throw err
            }
            // Record it locally too, so a work triaged from here stops resurfacing
            // in listings. Only after the server call succeeded — a failed unsave
            // would otherwise leave the work read *and* still on the list. Same
            // call our work menu and AO3's own button make, so all three agree.
            if (this.options.workMarks.enabled)
              applyMarkGroup(this.options.workMarks, work.workId, true)
          },
        },
      },
      emptyMessage: 'No works found in your Marked for Later list.',
      errorMessage: 'Could not load your Marked for Later list.',
    }
  }
}

function snapshotKey(userId: string): string {
  return `${SOURCE_ID}:${userId}`
}

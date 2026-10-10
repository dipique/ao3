import type { FilteredListing } from '#common'
import type { OpenOptions, SearchSource } from '#content_script/searchView/host.tsx'

import { ADDON_CLASS, FILTERED_LISTING_SOURCE_ID, filteredListing, getArchiveLink, withPage } from '#common'
import { linkedTo, resumeView } from '#content_script/lists/openLink.ts'
import { refreshIntervalMs } from '#content_script/searchView/freshness.ts'
import { openSearchView, suspendSearchView } from '#content_script/searchView/host.tsx'
import { detectPageCount, detectResultCount } from '#content_script/searchView/scrape.ts'
import { applyStatus } from '#content_script/searchView/status.ts'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

const FEATURE = `${ADDON_CLASS}--search-filtered-listing`
const BUTTON_CLASS = `${FEATURE}--button`

/**
 * Local layout prefs id. One for the feature, not one per listing — the reader
 * wants the same columns and sort whichever tag's or author's works they search.
 */
const SOURCE_ID = FILTERED_LISTING_SOURCE_ID

/** The listing's works. */
function worksList(): HTMLOListElement | null {
  return document.querySelector<HTMLOListElement>('#main ol.work.index.group')
}

/** The page's pagination blocks — one above the works, one below. */
function paginations(): NodeListOf<HTMLElement> {
  return document.querySelectorAll<HTMLElement>('#main ol.pagination')
}

/**
 * The listing's Sort & Filter sidebar, and the actions-row link a narrow screen
 * opens it by. The archive's own script answers that link by moving the whole
 * page aside to make room for the sidebar, so it goes with it: left behind, it
 * would push the page aside for a sidebar that isn't there.
 */
function sidebar(): Element[] {
  const link = document.querySelector('#main #go_to_filters')?.closest('li')
  return [...document.querySelectorAll('#main form#work-filters'), ...(link ? [link] : [])]
}

/** This page with no fragment, absolute: what its pages are numbered from. */
function pageAddress(): string {
  return getArchiveLink(`${location.pathname}${location.search}`)
}

/**
 * A filtered listing — a tag's, an author's or a collection's works — already
 * has AO3's Sort & Filter sidebar, which sorts and filters it by asking the
 * archive again. This unit adds a "Search these works" button to the listing's
 * own row of actions, which loads every page of it, as sorted and filtered, into
 * the same in-memory filterable view the Marked for Later page uses: what the
 * sidebar can't do, such as narrowing by the reader's own marks, without asking
 * the archive again for every change. Off unless the reader switches it on; a
 * saved list's own links open its view whatever the switch says
 * ({@link file://./../lists/openLink.ts}).
 *
 * A busy tag's listing runs to tens of thousands of works, so the shared host's
 * result ceiling ({@link file://./../searchView/host.tsx}) does the arguing,
 * as it does for a works search. Everything else — the stored copy, the
 * background refresh, back to the list — is the host's too; this unit only
 * says where the works come from and where the view goes.
 */
export class SearchFilteredListing extends Unit {
  static override get name() { return 'SearchFilteredListing' }
  override get enabled() { return this.options.searchFilteredListing || linkedTo('works-filter') }

  static override async clean(): Promise<void> {
    suspendSearchView()
  }

  override async ready(): Promise<void> {
    const listing = filteredListing(location.href)
    if (!listing)
      return
    const list = worksList()
    // A listing that matched nothing — nothing to search.
    if (!list || !list.querySelector('li.blurb'))
      return

    if (this.options.searchFilteredListing) {
      // The row with Works and Bookmarks in it: the listing's one set of
      // actions, and where an action on its works belongs.
      const subnav = document.querySelector('#main ul.navigation.actions')
      if (!subnav || subnav.querySelector(`.${BUTTON_CLASS}`))
        return

      const button = (
        <button type="button" class={`${ADDON_CLASS}  ${BUTTON_CLASS}`}>Search these works</button>
      ) as HTMLElement as HTMLButtonElement
      button.addEventListener('click', () => {
        void this.openView(listing, list)
      })
      subnav.append(<li class={ADDON_CLASS}>{button}</li>)
      this.logger.debug('Search filtered listing button added.')
    }

    // If a global re-run (say a "Hide tag" from a context menu) closed an open
    // view, put it back from cache where the reader left off. Failing that, a
    // saved list's open URL or refining link opens on the list's filter.
    resumeView(this.options, 'works-filter', listing.key, opts => this.openView(listing, list, opts))
  }

  async openView(listing: FilteredListing, list: HTMLOListElement, opts: OpenOptions = {}): Promise<void> {
    await openSearchView(this.source(listing, list), this.options, opts)
  }

  /** Everything the shared host needs to know about a filtered listing. */
  source(listing: FilteredListing, list: HTMLOListElement): SearchSource {
    return {
      id: SOURCE_ID,
      cacheKey: listing.key,
      descriptor: () => ({
        sourceId: SOURCE_ID,
        label: listing.label,
        listUrl: getArchiveLink(listing.url),
        ...(listing.dateFilter ? { dateFilter: listing.dateFilter } : {}),
      }),
      // This page's own query, filters and sort as the reader has them, so the
      // walk reads exactly the listing on screen, from page 1 whichever page
      // the reader opened it from.
      pageUrl: page => withPage(pageAddress(), page),
      pageCount: () => detectPageCount(document),
      resultCount: () => detectResultCount(document),
      refreshInterval: () => refreshIntervalMs(this.options.searchListingsRefreshHours),
      // The works and their paging, the sidebar that sorts and filters them on
      // the archive, and the button that opened the view: the view has its own
      // filters and "Back to list", and all of them come back with the list.
      // The heading stays, since it names whose listing this is.
      nativeElements: () => [list, ...paginations(), ...sidebar()],
      // Where the works start, before the paging above them: the view stands in
      // for the list rather than following it.
      mount: (container) => {
        const anchor = paginations()[0] ?? list
        anchor.before(container)
      },
      // Marks and progress apply to any work, so the Status facet is worth
      // having here too — just not switched on by default (see `defaultStatus`).
      prepare: works => applyStatus(works, this.options),
      viewConfig: {
        // "marked" is really the order the source listed them in: whatever the
        // listing was sorted by when the reader pressed the button.
        sortLabels: { marked: 'Listing order' },
        // Browsing a listing isn't triage: opening on "Ready" only would quietly
        // hide every work the reader has already started.
        defaultStatus: [],
      },
      emptyMessage: 'No works found in this listing.',
      errorMessage: 'Could not load the works in this listing.',
    }
  }
}

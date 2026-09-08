import type { SearchSource } from '#content_script/searchView/host.tsx'
import type { ViewState } from '#content_script/searchView/view.tsx'

import { ADDON_CLASS, getArchiveLink } from '#common'
import { openSearchView, suspendSearchView, takeReopen } from '#content_script/searchView/host.tsx'
import { detectPageCount } from '#content_script/searchView/scrape.ts'
import { applyStatus } from '#content_script/searchView/status.ts'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

const FEATURE = `${ADDON_CLASS}--search-series-works`
const BUTTON_CLASS = `${FEATURE}--button`

/**
 * Local layout prefs id. One for the feature, not one per series — the reader
 * wants the same columns and sort every time, whichever series it is.
 */
const SOURCE_ID = 'series-works'

/** Where a series page lists its works. A `ul`, unlike every other listing. */
const LIST_SELECTOR = 'ul.series.work.index.group'
const BLURB_SELECTOR = `${LIST_SELECTOR} > li.blurb`

/** The series id in the current URL, or null if this isn't a series page. */
function seriesId(): string | null {
  return location.pathname.match(/^\/series\/(\d+)\/?$/)?.[1] ?? null
}

/** The series' works listing, or null if the page doesn't have one. */
function worksList(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#main ${LIST_SELECTOR}`)
}

/** The page's pagination blocks — one above the list, one below. */
function paginations(): NodeListOf<HTMLElement> {
  return document.querySelectorAll<HTMLElement>('#main ol.pagination')
}

/**
 * How many works the series meta says it holds. Only used to explain a
 * truncated load; the load itself is bounded by the page count.
 */
function seriesWorkCount(): number | null {
  const text = document.querySelector('#main dl.series.meta dl.stats dd.works')?.textContent
  const count = Number((text ?? '').replace(/\D/g, ''))
  return Number.isFinite(count) && count > 0 ? count : null
}

/** The series' name, for the snapshot's label. */
function seriesName(): string {
  return document.querySelector('#main h2.heading')?.textContent?.trim().replace(/\s+/g, ' ') || 'Series'
}

/**
 * A series page is a plain paged list of its works — AO3 offers no sort or
 * filter for it, whatever the series' size. This unit adds a "Search these
 * works" button to the page's own row of actions, which loads every page of the
 * list into the same in-memory filterable view the Marked for Later page uses.
 *
 * All the machinery (cached snapshot, background refresh, back to list) is the
 * shared search-view host ({@link file://./../searchView/host.tsx}); this unit
 * only describes where the works come from and where the view goes.
 */
export class SearchSeriesWorks extends Unit {
  static override get name() { return 'SearchSeriesWorks' }
  override get enabled() { return this.options.searchSeriesWorks }

  static override async clean(): Promise<void> {
    suspendSearchView()
  }

  override async ready(): Promise<void> {
    const id = seriesId()
    if (!id)
      return
    const list = worksList()
    // A series with nothing posted to it yet — nothing to search.
    if (!list || !list.querySelector('li.blurb'))
      return

    // The row that already holds "Subscribe" and "Bookmark Series": this page's
    // one set of actions, and where an action on the same series belongs.
    const subnav = document.querySelector('#main ul.navigation.actions')
    if (!subnav || subnav.querySelector(`.${BUTTON_CLASS}`))
      return

    const button = (
      <button type="button" class={`${ADDON_CLASS}  ${BUTTON_CLASS}`}>Search these works</button>
    ) as HTMLElement as HTMLButtonElement
    button.addEventListener('click', () => {
      void this.openView(id, list)
    })
    subnav.append(<li class={ADDON_CLASS}>{button}</li>)
    this.logger.debug('Search series works button added.')

    // If a global re-run (say a "Hide tag" from a context menu) closed an open
    // view, put it back from cache where the reader left off.
    const pending = takeReopen(snapshotKey(id))
    if (pending)
      void this.openView(id, list, { initialState: pending, refresh: false })
  }

  async openView(id: string, list: HTMLElement, opts: { initialState?: ViewState, refresh?: boolean } = {}): Promise<void> {
    await openSearchView(this.source(id, list), this.options, opts)
  }

  /** Everything the shared host needs to know about a series' works listing. */
  source(id: string, list: HTMLElement): SearchSource {
    return {
      id: SOURCE_ID,
      cacheKey: snapshotKey(id),
      descriptor: () => ({
        sourceId: SOURCE_ID,
        label: `Series: ${seriesName()}`,
        listUrl: getArchiveLink(`/series/${id}`),
        // A series lists its works in a `ul`, not the `ol` every other listing
        // uses, so a refresh has to be scoped the same way this scrape is.
        blurbSelector: BLURB_SELECTOR,
      }),
      // Built from the id alone, so opening from page 3 still starts at page 1.
      pageUrl: page => getArchiveLink(`/series/${id}?page=${page}`),
      pageCount: () => detectPageCount(document),
      resultCount: seriesWorkCount,
      blurbSelector: BLURB_SELECTOR,
      // The list and its pagination, plus the button that opened the view — the
      // view has its own "Back to list", and all three come back with the list.
      nativeElements: () => [list, ...paginations()],
      // Between the series' own details and the paging: the view stands in for
      // the list, so it belongs where the list starts rather than at the end of
      // the page.
      mount: (container) => {
        const anchor = paginations()[0] ?? list
        anchor.before(container)
      },
      // Marks and progress apply to any work, so the Status facet is worth
      // having here too — just not switched on by default (see `defaultStatus`).
      prepare: works => applyStatus(works, this.options),
      viewConfig: {
        // "marked" is really the order the source listed them in, which here is
        // the order of the series itself — the one order that means something.
        sortLabels: { marked: 'Series order' },
        // Browsing a series isn't triage: opening on "Ready" only would quietly
        // hide every work the reader has already started.
        defaultStatus: [],
      },
      emptyMessage: 'No works found in this series.',
      errorMessage: 'Could not load the works in this series.',
    }
  }
}

/** Snapshot cache key for the series in the current URL. */
function snapshotKey(id: string): string {
  return `${SOURCE_ID}:${id}`
}

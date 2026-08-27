import type { SearchSource } from '#content_script/searchView/host.tsx'
import type { ViewState } from '#content_script/searchView/view.tsx'

import { ADDON_CLASS, getArchiveLink } from '#common'
import { openSearchView, suspendSearchView, takeReopen } from '#content_script/searchView/host.tsx'
import { applyReadiness } from '#content_script/searchView/readiness.ts'
import { detectPageCount } from '#content_script/searchView/scrape.ts'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

const FEATURE = `${ADDON_CLASS}--search-text-results`
const BUTTON_CLASS = `${FEATURE}--button`

/**
 * Local layout prefs id — one for the feature, not one per query. The reader
 * wants the same columns, facet order and sort whatever they searched for.
 */
const SOURCE_ID = 'text-search'

/** The results list on `/works/search`, or null when the page is the form. */
function resultsList(): HTMLOListElement | null {
  if (!/^\/works\/search\/?$/.test(location.pathname))
    return null
  // `?edit_search=true` re-renders the form with the query filled in and no
  // results, and a bare `/works/search` is the form too — in both, this is absent.
  return document.querySelector<HTMLOListElement>('#main.works-search ol.work.index.group')
}

/**
 * The "427,247 Found" heading's number, or null if AO3 didn't print one. Only
 * ever used to tell the reader how much they're not getting; the load itself is
 * bounded by the page count.
 */
function foundCount(): number | null {
  for (const h3 of document.querySelectorAll('#main.works-search h3.heading')) {
    const match = h3.textContent?.match(/(\d[\d,.]*)\s+Found\b/)
    if (!match)
      continue
    const count = Number(match[1]!.replace(/\D/g, ''))
    return Number.isFinite(count) ? count : null
  }
  return null
}

/**
 * Search results the reader can actually filter. AO3's works text search takes
 * a query and hands back a paged list with a sort dropdown and nothing else —
 * no facets, no way to see which fandoms or tags the matches cluster in. This
 * unit adds a "Search these results" button to the results page that loads them
 * into the same in-memory filterable view the Marked for Later page and the
 * uncommon-tag pages use.
 *
 * A text search is the one source that routinely runs to hundreds of thousands
 * of works, so the shared host's result ceiling
 * ({@link file://./../searchView/host.tsx}) does the arguing: over the limit,
 * the reader is shown the totals and asked whether to load the first N in the
 * Archive's own order, or go back and narrow the query. Everything else — the
 * cached snapshot, background refresh, back to list — is the host's too; this
 * unit only says where the works come from and where the view goes.
 */
export class SearchTextResults extends Unit {
  static override get name() { return 'SearchTextResults' }
  override get enabled() { return this.options.searchTextResults }

  static override async clean(): Promise<void> {
    suspendSearchView()
  }

  override async ready(): Promise<void> {
    const list = resultsList()
    // No results list means the form, or a search that matched nothing.
    if (!list || !list.querySelector('li.blurb'))
      return

    // The "Edit Your Search" subnav — the page's one row of actions, and the
    // natural neighbour for an action that reworks the same results.
    const subnav = document.querySelector('#main.works-search ul.navigation.actions')
    if (!subnav || subnav.querySelector(`.${BUTTON_CLASS}`))
      return

    const button = (
      <button type="button" class={`${ADDON_CLASS}  ${BUTTON_CLASS}`}>Search these results</button>
    ) as HTMLElement as HTMLButtonElement
    button.addEventListener('click', () => {
      void this.openView(list)
    })
    subnav.append(<li class={ADDON_CLASS}>{button}</li>)
    this.logger.debug('Search text results button added.')

    // If a global re-run (say a "Hide tag" from a context menu) closed an open
    // view, put it back from cache where the reader left off.
    const pending = takeReopen(snapshotKey())
    if (pending)
      void this.openView(list, { initialState: pending, refresh: false })
  }

  async openView(list: HTMLOListElement, opts: { initialState?: ViewState, refresh?: boolean } = {}): Promise<void> {
    await openSearchView(this.source(list), this.options, opts)
  }

  /** Everything the shared host needs to know about a works search's results. */
  source(list: HTMLOListElement): SearchSource {
    return {
      id: SOURCE_ID,
      cacheKey: snapshotKey(),
      pageUrl: page => getArchiveLink(`${location.pathname}?${pageQuery(page)}`),
      pageCount: () => detectPageCount(document),
      resultCount: foundCount,
      // The results, their pagination, and the count heading — which says how
      // many the Archive matched, not how many we loaded, so leaving it up over
      // a capped view would only mislead. The view carries its own count.
      nativeElements: () => [
        list,
        ...document.querySelectorAll('#main.works-search ol.pagination.actions, #main.works-search h3.heading:not(.landmark)'),
      ],
      mount: (container) => {
        const anchor = document.querySelector('#main.works-search ul.navigation.actions') ?? list
        anchor.after(container)
      },
      // Progress marks apply to any work, so the Readiness facet is worth having
      // here too — just not switched on by default (see `defaultReadiness`).
      prepare: works => applyReadiness(works, this.options),
      viewConfig: {
        // "marked" is really the order the source listed them in — here whatever
        // the search was sorted by when the reader pressed the button.
        sortLabels: { marked: 'Search order' },
        // Browsing results isn't triage: opening on "Ready" only would quietly
        // hide every work the reader has already started.
        defaultReadiness: [],
      },
      emptyMessage: 'No works found for this search.',
      errorMessage: 'Could not load the results for this search.',
    }
  }
}

/**
 * The current search's query string with `page` set to `page`. Everything else
 * — every `work_search[…]` field, the sort — is carried through untouched, so
 * the scrape walks exactly the list the reader is looking at.
 */
function pageQuery(page: number): string {
  const params = new URLSearchParams(location.search)
  params.set('page', String(page))
  // Nothing to do with the results; only re-renders the form.
  params.delete('edit_search')
  return params.toString()
}

/**
 * Snapshot cache key for the search in the current URL. Built from the sorted
 * query (minus `page`) so the same search reached by different orderings of the
 * same fields shares one snapshot, and two different searches never do.
 */
function snapshotKey(): string {
  const params = new URLSearchParams(location.search)
  params.delete('page')
  params.delete('edit_search')
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
  return `${SOURCE_ID}:${new URLSearchParams(entries).toString()}`
}

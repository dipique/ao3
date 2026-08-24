import type { Work } from '#content_script/blurb.js'
import type { SearchSource } from '#content_script/searchView/host.tsx'
import type { ViewState } from '#content_script/searchView/view.tsx'

import { ADDON_CLASS, getArchiveLink, parseUser, toast } from '#common'
import { saveMarkedForLaterIndex } from '#content_script/markedForLaterIndex.js'
import { openSearchView, suspendSearchView, takeReopen } from '#content_script/searchView/host.tsx'
import { applyReadiness } from '#content_script/searchView/readiness.ts'
import { detectPageCount } from '#content_script/searchView/scrape.ts'
import { Unit } from '#content_script/Unit.js'
import { seedMarkedForLater, submitMark } from '#content_script/units/FilterEntityToolbars.tsx'
import { applyMarkGroup } from '#content_script/workMarks.js'
import React from '#dom'

const FEATURE = `${ADDON_CLASS}--search-marked-for-later`
const BUTTON_CLASS = `${FEATURE}--button`

/**
 * Identifies this use of the search view for local layout prefs (collapsed
 * groups, facet order, sort). One id for the whole feature — not per-user — so a
 * user's layout follows them across accounts on the same device.
 */
const SOURCE_ID = 'marked-for-later'

/**
 * Adds a "Search Marked for Later" button to your own to-read page that loads
 * every page of the list into one in-memory, instantly filterable/sortable view
 * (rendered in place; a "Back to list" button restores the native page). A
 * cached snapshot renders instantly on revisit while a fresh scrape runs in the
 * background. Everything generic about that lives in the shared search-view host
 * ({@link file://./../searchView/host.tsx}); this unit is only the source.
 */
export class SearchMarkedForLater extends Unit {
  static override get name() { return 'SearchMarkedForLater' }
  override get enabled() { return this.options.searchMarkedForLater }

  static override async clean(): Promise<void> {
    // A global re-run (options change, navigation) tears the view down. If it was
    // open, snapshot it so ready() can reopen it where the user left off.
    suspendSearchView()
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

    const current = Array.from(document.querySelectorAll('#main ul.navigation.actions span.current'))
      .find(span => span.textContent?.trim() === 'Marked for Later')
    const host = current?.closest('li')
    if (!host || host.parentElement?.querySelector(`.${BUTTON_CLASS}`))
      return

    const button = (
      <button type="button" class={`${ADDON_CLASS}  ${BUTTON_CLASS}`}>Search Marked for Later</button>
    ) as HTMLElement as HTMLButtonElement
    button.addEventListener('click', () => {
      void this.openView(pageUser)
    })
    host.after(<li class={ADDON_CLASS}>{button}</li>)
    this.logger.debug('Search Marked for Later button added.')

    // If a global re-run closed an open view, reopen it (from cache, no re-scrape)
    // where the user left off — so e.g. a "Hide tag" context-menu action doesn't
    // dump them back to the native list.
    const pending = takeReopen(snapshotKey(pageUser))
    if (pending)
      void this.openView(pageUser, { initialState: pending, refresh: false })
  }

  async openView(userId: string, opts: { initialState?: ViewState, refresh?: boolean } = {}): Promise<void> {
    await openSearchView(this.source(userId), this.options, opts)
  }

  /** Everything the shared host needs to know about a Marked for Later list. */
  source(userId: string): SearchSource {
    return {
      id: SOURCE_ID,
      cacheKey: snapshotKey(userId),
      pageUrl: page => getArchiveLink(`/users/${userId}/readings?show=to-read&page=${page}`),
      pageCount: () => detectPageCount(document),
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
        applyReadiness(works, this.options)
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

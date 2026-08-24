import type { SearchSource } from '#content_script/searchView/host.tsx'
import type { ViewState } from '#content_script/searchView/view.tsx'

import { ADDON_CLASS, getArchiveLink } from '#common'
import { openSearchView, suspendSearchView, takeReopen } from '#content_script/searchView/host.tsx'
import { applyReadiness } from '#content_script/searchView/readiness.ts'
import { detectPageCount } from '#content_script/searchView/scrape.ts'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

const FEATURE = `${ADDON_CLASS}--search-tag-works`
const LINK_CLASS = `${FEATURE}--link`

/**
 * Local layout prefs id. One for the feature, not one per tag — the reader wants
 * the same columns and sort every time they search a tag, whichever tag it is.
 */
const SOURCE_ID = 'tag-works'

/** Where a tag page keeps its works, as opposed to the bookmarks listed below them. */
const LISTBOX_SELECTOR = 'div.work.listbox'
const BLURB_SELECTOR = `${LISTBOX_SELECTOR} ul.index.group > li.blurb`

/** The tag profile block on `/tags/NAME`, or null if this isn't such a page. */
function tagProfile(): HTMLElement | null {
  // Only the bare tag URL. `/tags/NAME/works` is the filterable listing, which
  // AO3 only serves for canonical tags and which needs nothing from us.
  if (!/^\/tags\/[^/]+\/?$/.test(location.pathname))
    return null
  return document.querySelector<HTMLElement>('#main div.tag.profile')
}

/**
 * Whether AO3 has marked this tag common (canonical). Its description paragraphs
 * are the only tell on the bare tag URL: a canonical tag's says it is one and
 * links to the filterable listing, a non-canonical tag's doesn't.
 */
function isCanonical(profile: HTMLElement): boolean {
  return Array.from(profile.querySelectorAll(':scope > p')).some(p => p.innerHTML.includes('canonical'))
}

/**
 * A non-canonical (uncommon) tag can't be filtered on: AO3 gives its page a
 * plain paged list of works and no sort/filter sidebar at all. This unit adds a
 * "Search these works" link to the sentence that says so, which loads every page
 * of that list into the same in-memory filterable view the Marked for Later page
 * uses — the one thing AO3 won't do for these tags.
 *
 * All the machinery (cached snapshot, background refresh, back to list) is the
 * shared search-view host ({@link file://./../searchView/host.tsx}); this unit
 * only describes where the works come from and where the view goes.
 */
export class SearchTagWorks extends Unit {
  static override get name() { return 'SearchTagWorks' }
  override get enabled() { return this.options.searchTagWorks }

  static override async clean(): Promise<void> {
    suspendSearchView()
  }

  override async ready(): Promise<void> {
    const profile = tagProfile()
    if (!profile || isCanonical(profile))
      return
    const listbox = profile.querySelector<HTMLElement>(`:scope > ${LISTBOX_SELECTOR}`)
    // No works listed under this tag — nothing to search.
    if (!listbox || !listbox.querySelector('li.blurb'))
      return
    if (profile.querySelector(`.${LINK_CLASS}`))
      return

    // The "…has not been marked common and can't be filtered on (yet)" sentence
    // sits between the parent tags and the works. Hang the link off the end of
    // it, so the offer reads as the answer to what it just said. If AO3 ever
    // stops printing it, fall back to a paragraph of our own in the same place.
    const previous = listbox.previousElementSibling
    let notice: HTMLElement
    if (previous instanceof HTMLParagraphElement) {
      notice = previous
    }
    else {
      notice = (<p class={ADDON_CLASS} />) as HTMLElement
      listbox.before(notice)
    }

    const link = (
      <button type="button" class={`${ADDON_CLASS}  ${LINK_CLASS}`}>Search these works</button>
    ) as HTMLElement as HTMLButtonElement
    link.addEventListener('click', () => {
      void this.openView(notice, listbox, link)
    })
    notice.append(' ', link)
    this.logger.debug('Search tag works link added.')

    // If a global re-run (say a "Hide tag" from a context menu) closed an open
    // view, put it back from cache where the reader left off.
    const pending = takeReopen(snapshotKey())
    if (pending)
      void this.openView(notice, listbox, link, { initialState: pending, refresh: false })
  }

  async openView(
    notice: HTMLElement,
    listbox: HTMLElement,
    link: HTMLElement,
    opts: { initialState?: ViewState, refresh?: boolean } = {},
  ): Promise<void> {
    await openSearchView(this.source(notice, listbox, link), this.options, opts)
  }

  /** Everything the shared host needs to know about a tag's works listing. */
  source(notice: HTMLElement, listbox: HTMLElement, link: HTMLElement): SearchSource {
    return {
      id: SOURCE_ID,
      cacheKey: snapshotKey(),
      // The path already carries the tag, percent-encoded the way AO3 wants it;
      // built from the path alone so opening from page 3 still starts at page 1.
      pageUrl: page => getArchiveLink(`${location.pathname}?page=${page}`),
      pageCount: () => detectPageCount(listbox),
      blurbSelector: BLURB_SELECTOR,
      // The native list, and the link that opened the view — the view has its own
      // "Back to list" button, and both come back when it does. The sentence
      // itself stays: it's still the reason the reader is looking at our view.
      nativeElements: () => [listbox, link],
      mount: container => notice.after(container),
      // Progress marks apply to any work, so the Readiness facet is worth having
      // here too — just not switched on by default (see `defaultReadiness`).
      prepare: works => applyReadiness(works, this.options),
      viewConfig: {
        // "marked" is really the order the source listed them in, which here is
        // the Archive's own ordering for the tag rather than anything the reader did.
        sortLabels: { marked: 'Archive order' },
        // Browsing a tag isn't triage: opening on "Ready" only would quietly hide
        // every work the reader has already started.
        defaultReadiness: [],
      },
      emptyMessage: 'No works found for this tag.',
      errorMessage: 'Could not load the works for this tag.',
    }
  }
}

/**
 * Snapshot cache key for the tag in the current URL. The raw path segment, so it
 * stays stable however AO3 chooses to escape the tag's name.
 */
function snapshotKey(): string {
  return `${SOURCE_ID}:${location.pathname.replace(/^\/tags\/|\/$/g, '')}`
}

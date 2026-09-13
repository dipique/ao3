import type { SearchSource } from '#content_script/searchView/host.tsx'
import type { ViewState } from '#content_script/searchView/view.tsx'

import { ADDON_CLASS, getArchiveLink, parseUser, readWorkIds, toast } from '#common'
import { loadMarkedForLaterIndex } from '#content_script/markedForLaterIndex.js'
import { clearHistoryItem, hideClearHistory, showClearHistory } from '#content_script/readingsNav.ts'
import { readMisses, writeMisses } from '#content_script/searchView/cache.ts'
import { NATIVE_HIDDEN_CLASS } from '#content_script/searchView/classes.ts'
import { limitFor, openSearchView, suspendSearchView, takeReopen } from '#content_script/searchView/host.tsx'
import { detectPageCount, fetchPageDoc } from '#content_script/searchView/scrape.ts'
import { applyStatus } from '#content_script/searchView/status.ts'
import { Unit } from '#content_script/Unit.js'
import React from '#dom'

const FEATURE = `${ADDON_CLASS}--search-read-works`
const BUTTON_CLASS = `${FEATURE}--button`
/** The heading and subnav items that stand in for AO3's own while the view is up. */
const CHROME_CLASS = `${FEATURE}--chrome`

/** What the page calls this list, in its heading and in the subnav. */
const LIST_NAME = 'Read'

/**
 * Identifies this use of the search view for local layout prefs. One id for the
 * feature, as with every other source — a reader wants the same columns, sort
 * and collapsed groups whichever account they are signed in as.
 */
const SOURCE_ID = 'read-works'

/**
 * Both halves of `/users/:user/readings`: `?show=to-read` is the Marked for
 * Later list, anything else is History.
 */
function readingsUser(): string | null {
  return location.pathname.match(/^\/users\/([^/]+)\/readings\/?$/)?.[1] ?? null
}

/** Whether the page being shown is the History listing rather than the to-read one. */
function onHistoryPage(): boolean {
  return new URLSearchParams(location.search).get('show') !== 'to-read'
}

/**
 * Adds a "Search read items" button to your own readings pages, next to the
 * Marked for Later one, that puts **the works you have marked read** — the
 * `read` mark and every verdict that aliases it, Favorite and Good and the rest
 * ({@link readWorkIds}) — into the same in-memory, instantly filterable view,
 * where the Marks facet narrows them to one ("everything I called a favourite").
 *
 * **Where the blurbs come from, and why it matters.** A mark table holds work
 * ids and nothing else: no title, no author, no tags, nothing a listing could be
 * drawn or faceted from. So the marked ids are the list, and the archive's own
 * History — the one listing AO3 keeps of works you have read — is scraped as a
 * haystack to find their blurbs in. The view shows the intersection: the works
 * you marked, never merely the ones you visited. That is what
 * {@link SearchSource.select} is, and `satisfied` is what stops the scrape as
 * soon as every marked work has been found rather than reading a history to its
 * end.
 *
 * The gap that leaves is honest and reported: a work marked read that is not in
 * your AO3 history at all — marked from a listing without ever opening it, or
 * read before the archive kept the record — has no blurb to draw, and the view
 * says how many were missed rather than quietly listing fewer works.
 *
 * Offered on the to-read page as well as on History, because the Marked for
 * Later view's "Mark as Read" button is where a work joins this list — the
 * reader is standing in the right place to want it. Opening it from there means
 * the page count can't be read off the document, which is what
 * {@link SearchSource.pageCount}'s promise and {@link SearchSource.firstPageDoc}
 * are for.
 *
 * Everything generic (cached snapshot, background refresh, back to list) is the
 * shared search-view host ({@link file://./../searchView/host.tsx}).
 */
export class SearchReadWorks extends Unit {
  static override get name() { return 'SearchReadWorks' }
  // Marks are the list; with them off there is nothing this could show.
  override get enabled() { return this.options.searchReadWorks && this.options.workMarks.enabled }

  static override async clean(): Promise<void> {
    // A global re-run (options change, navigation) tears the view down. If it was
    // open, snapshot it so ready() can reopen it where the user left off.
    suspendSearchView()
    showClearHistory()
  }

  override async ready(): Promise<void> {
    // Only your own readings pages, and only when logged in.
    const pageUser = readingsUser()
    if (!pageUser || !document.body.classList.contains('logged-in'))
      return
    const currentUser = parseUser(document)?.userId
    if (!currentUser || currentUser.toLowerCase() !== pageUser.toLowerCase())
      return

    // Only History's own listing offers to clear it; on the to-read page it is
    // hidden for good, and on History while this view is up (see `listChrome`).
    if (!onHistoryPage())
      hideClearHistory()

    const host = anchorItem()
    if (!host || host.parentElement?.querySelector(`.${BUTTON_CLASS}`))
      return

    const button = (
      <button type="button" class={`${ADDON_CLASS}  ${BUTTON_CLASS}`}>Search read items</button>
    ) as HTMLElement as HTMLButtonElement
    button.addEventListener('click', () => {
      void this.openView(pageUser)
    })
    host.after(<li class={ADDON_CLASS}>{button}</li>)
    this.logger.debug('Search read items button added.')

    // If a global re-run closed an open view, reopen it (from cache, no
    // re-scrape) where the user left off.
    const pending = takeReopen(snapshotKey(pageUser))
    if (pending)
      void this.openView(pageUser, { initialState: pending, refresh: false })
  }

  async openView(userId: string, opts: { initialState?: ViewState, refresh?: boolean } = {}): Promise<void> {
    const wanted = readWorkIds(this.options.workMarks)
    // Nothing marked means nothing to look for, and a whole history read to
    // discover it. Say so instead.
    if (!wanted.size) {
      toast('You haven’t marked any works as read yet.', { type: 'error' })
      return
    }
    // The Status facet's "Marked for later" value is read synchronously per work
    // from an index that has to be loaded once per page run. On the to-read page
    // the Marked for Later view loads it; on History nothing else does, and a
    // work saved for a re-read is worth seeing here.
    await loadMarkedForLaterIndex(userId).catch(err => this.logger.error('Could not read the saved-work index', err))
    const absent = await readMisses(snapshotKey(userId)).catch((err) => {
      this.logger.error('Could not read the works the last scrape missed', err)
      return new Set<string>()
    })
    await openSearchView(this.source(userId, wanted, absent), this.options, opts)
  }

  /**
   * Everything the shared host needs: the marked works to look for, the history
   * to look for them in, and which of them the last scrape looked for and didn't
   * find (kept up to date as scrapes finish, which is why it is a live set).
   */
  source(userId: string, wanted: Set<string>, absent: Set<string>): SearchSource {
    const listUrl = getArchiveLink(`/users/${userId}/readings`)
    // Page 1, when counting the pages had to fetch it (see `pageCount`). One-shot:
    // whoever reads it next is the scrape that the count was worked out for.
    let firstPage: Document | undefined
    // Said once per open, not once per load: the view renders from cache and
    // again after the background refresh, and the shortfall is the same news
    // both times.
    let reported = false
    return {
      id: SOURCE_ID,
      cacheKey: snapshotKey(userId),
      descriptor: () => ({
        sourceId: SOURCE_ID,
        label: `Read works — ${userId}`,
        listUrl,
      }),
      pageUrl: page => `${listUrl}?page=${page}`,
      // Opened over the to-read page, there is nothing native to go back to —
      // that page is itself a search view — so the subnav's Marked for Later
      // link is the way back. Over History, "Back to list" means History.
      replacesListing: !onHistoryPage(),
      refreshInterval: () => Math.max(0, this.options.searchProfileListsRefreshHours || 0) * 60 * 60_000,
      // Thousands of works that almost never change: an automatic reload only
      // goes looking for works marked since the list was stored. Not for the
      // ones the last scrape already looked for and didn't find, either — a work
      // missing from the history can only be ruled out by reading all of it, and
      // doing that every day for works that aren't there is the cost this avoids.
      topUp: (stored) => {
        const have = new Set(stored.map(work => work.workId))
        const missing = new Set([...wanted].filter(id => !have.has(id) && !absent.has(id)))
        if (!missing.size)
          return null
        return {
          satisfied: ids => [...missing].every(id => ids.has(id)),
          select: works => works.filter(work => missing.has(work.workId)),
        }
      },
      pageCount: async () => {
        if (onHistoryPage())
          return detectPageCount(document)
        firstPage = await fetchPageDoc(`${listUrl}?page=1`)
        return detectPageCount(firstPage)
      },
      firstPageDoc: () => {
        const doc = firstPage
        firstPage = undefined
        return doc
      },
      // The list is the marks; the history is only where their blurbs live.
      select: works => works.filter(work => wanted.has(work.workId)),
      // Stateless on purpose. The source outlives a single scrape — a background
      // refresh reuses it — so a running tally of what is left to find would be
      // empty by the second scrape and stop it on its first page.
      satisfied: ids => [...wanted].every(id => ids.has(id)),
      // Whichever of the two listings this page is showing, plus its pagination
      // — and the heading and subnav item that say which list that is, which
      // `mount` stands in for.
      nativeElements: () => [
        ...document.querySelectorAll('#main ol.reading.work.index.group, #main ol.pagination'),
        ...listChrome(),
      ],
      mount: (container) => {
        const anchor = document.querySelector('#main ul.navigation.actions')
          ?? document.querySelector('#main ol.reading.work.index.group')
        anchor?.after(container)
        showReadChrome(userId)
      },
      unmount: () => {
        for (const el of document.querySelectorAll(`.${CHROME_CLASS}`))
          el.remove()
      },
      prepare: (works, { fresh }) => {
        applyStatus(works, this.options)
        if (!fresh)
          return
        // Record what this scrape couldn't find, for the next top-up to leave
        // alone. Not when the works ceiling cut the list short: a work trimmed
        // off the end was found, and calling it missing would hide it for good.
        if (works.length < limitFor(this.options)) {
          const shown = new Set(works.map(work => work.workId))
          absent.clear()
          for (const id of wanted) {
            if (!shown.has(id))
              absent.add(id)
          }
          void writeMisses(snapshotKey(userId), absent).catch(err => this.logger.error('Could not record the works this scrape missed', err))
        }
        if (reported)
          return
        // Only of a set just scraped, and only against what a whole one could
        // have held: a cached render answers an older question (marks made since
        // are simply not in it yet), and a list cut short by the reader's own
        // works ceiling is not a list with anything missing from it.
        const reachable = Math.min(wanted.size, limitFor(this.options))
        const missed = reachable - works.length
        if (missed <= 0)
          return
        reported = true
        toast(
          `${missed.toLocaleString()} of your ${wanted.size.toLocaleString()} read works aren’t in your AO3 history, so they can’t be shown here.`,
          { type: 'error' },
        )
      },
      viewConfig: {
        // "marked" is the order the haystack listed them in, which for History is
        // most recently opened first.
        sortLabels: { marked: 'Date last visited' },
        // Every work here has a verdict already, so opening on "Ready" would hide
        // the whole list behind a facet the reader never set.
        defaultStatus: [],
      },
      emptyMessage: 'None of the works you’ve marked read are in your AO3 history.',
      errorMessage: 'Could not load your reading history.',
    }
  }
}

/**
 * The furniture that names the list on screen: the page heading ("History",
 * "Marked for Later"), the subnav item AO3 marks as current, and our own button.
 * Hidden while the view is up, because what they say is no longer true — the
 * reader is looking at the read list, whichever page they opened it from.
 */
function listChrome(): Element[] {
  const nav = document.querySelector('#main ul.navigation.actions')
  return [
    document.querySelector('#main > h2.heading'),
    nav?.querySelector(`:scope > li:not(.${ADDON_CLASS}) > span.current`)?.parentElement,
    nav?.querySelector(`.${BUTTON_CLASS}`)?.closest('li'),
    // The read list isn't History, so History's "clear everything" goes too.
    clearHistoryItem(),
  ].filter((el): el is HTMLElement => !!el)
}

/**
 * Stand in for {@link listChrome} while the view is up, the way AO3 draws its
 * own lists: a heading naming the list, the list's subnav item as the current
 * one — in place of our button, which has nothing left to do — and the item
 * that *was* current turned back into a link, so the reader can go to it.
 *
 * Everything added carries {@link CHROME_CLASS}, which is what `unmount` removes;
 * the originals come back with the rest of the native page.
 */
function showReadChrome(userId: string): void {
  const hidden = `.${NATIVE_HIDDEN_CLASS}`
  const heading = document.querySelector(`#main > h2.heading${hidden}`)
  heading?.after(<h2 class={`heading ${ADDON_CLASS}  ${CHROME_CLASS}`}>{LIST_NAME}</h2>)

  const nav = document.querySelector('#main ul.navigation.actions')
  const current = nav?.querySelector(`:scope > li${hidden} > span.current`)
  if (current) {
    // The page's own list, as a link to itself: the plain native page again.
    const path = `/users/${userId}/readings`
    const href = onHistoryPage() ? path : `${path}?show=to-read`
    current.parentElement!.after(
      <li class={`${ADDON_CLASS}  ${CHROME_CLASS}`}><a href={href}>{current.textContent?.trim() ?? ''}</a></li>,
    )
  }
  nav?.querySelector(`.${BUTTON_CLASS}`)?.closest('li')?.after(
    <li class={`${ADDON_CLASS}  ${CHROME_CLASS}`}><span class="current">{LIST_NAME}</span></li>,
  )
}

/**
 * The subnav item our button goes after: the Marked for Later one (a link on
 * History, the current page's own label on the to-read list), skipping past
 * anything of ours already there.
 */
function anchorItem(): HTMLElement | null {
  const item = Array.from(document.querySelectorAll('#main ul.navigation.actions > li'))
    .find(li => li.textContent?.trim() === 'Marked for Later')
  if (!item)
    return null
  let last: Element = item
  while (last.nextElementSibling?.classList.contains(ADDON_CLASS))
    last = last.nextElementSibling
  return last as HTMLElement
}

function snapshotKey(userId: string): string {
  return `${SOURCE_ID}:${userId}`
}

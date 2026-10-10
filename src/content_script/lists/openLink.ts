import type { ListHost, OpenAsk, Options } from '#common'
import type { OpenOptions } from '#content_script/searchView/host.tsx'

import { openAsk, openTarget, ownPageLink, savedListsOf, toast } from '#common'
import { isOpening, resumeSearchView } from '#content_script/searchView/host.tsx'
import { arrivingList } from '#content_script/tracked/refining.ts'
import { restoreListFilter } from '#content_script/tracked/restore.ts'
import { filterStateOf } from '#content_script/tracked/viewFilter.ts'

/**
 * A page opened by a list's own link, and the search view it owes that list.
 *
 * A list's open URL is its own page on the archive with `#ao3e-open=<ref>` on
 * the end ({@link file://../../common/listLinks.ts}), and it asks for the
 * list's search view, seeded with the list's view filter: from the list's
 * offline copy if there is one, otherwise by reading the listing, which keeps
 * the copy. The page reads the link once, as it starts, and takes it off the
 * address: it means nothing to the archive or to whoever the address is later
 * passed to, and the view is owed once — a reader who goes back to the
 * archive's own listing stays there through every later run of the page.
 *
 * **Whatever the page button's switch says.** The link asks for this list, so
 * the view opens though its kind's button is switched off. So does a list's
 * refining link ({@link file://../tracked/refining.ts}) put the list's view
 * filter back: left off, the toolbar would read the listing as the list without
 * its filter, and offer to save it so. Either link keeps the unit that opens
 * the view running for the life of the page, so a re-run puts the view back as
 * the reader left it, as it would with the switch on; the button stays off.
 */

const UNKNOWN_LINK = 'This link doesn’t name a list saved on this browser for this page.'

interface PageLinks {
  /** What the open URL asks of this page, if it has one this page can open. */
  ask: OpenAsk | null
  /** Whether {@link ask}'s view has yet to be opened. */
  owed: boolean
  /** The views a list's own link asked this page for. */
  hosts: ReadonlySet<ListHost>
}

/** Read once per page, by its first run. */
let links: PageLinks | null = null

/**
 * Read the page's links, once: the open URL, taken off the address, and the
 * list a refining link has brought the tab here to refine. For the first run
 * of the page, before any unit is built, since what they ask for decides which
 * units run. An open URL naming no list this page opens is said so, once the
 * page is there to say it on, with a link to the list's own page when it names
 * a list known here. Nothing goes there by itself.
 */
export function readListLinks(options: Options): void {
  if (links)
    return
  const lists = savedListsOf({ tracked: options.trackedLists, saved: options.savedLists }).map(one => one.list)
  const target = openTarget(location.hash)
  const ask = target && openAsk(target, lists, location.href)
  if (target)
    history.replaceState(history.state, '', `${location.pathname}${location.search}`)
  // A list with no view filter has nothing to put back, and the archive's
  // listing is already the list.
  const refining = arrivingList(lists)
  const restoring = refining && filterStateOf(refining.filter) ? refining.kind : null
  links = {
    ask,
    owed: !!ask,
    hosts: new Set([ask?.host, restoring].filter((host): host is ListHost => !!host)),
  }
  if (target && !ask) {
    const link = ownPageLink(target, lists, options.user.userId) ?? undefined
    whenShown(() => toast(UNKNOWN_LINK, { type: 'error', link }))
  }
}

/** Whether a list's own link asked this page for `host`'s view: for its unit's `enabled`. */
export function linkedTo(host: ListHost): boolean {
  return links?.hosts.has(host) ?? false
}

/**
 * Open the view the page's open URL asks of `host`, if it still owes it: `open`
 * opens the unit's view, `cacheKey` being that view's. Null, opening nothing,
 * when the link asks nothing of `host`, or its view is already opened.
 *
 * The view is owed until an open of it has settled, opened, failed or
 * cancelled. A re-run that takes the page down around a view still loading
 * hands that view's opening to the re-run's own open of it
 * ({@link resumeSearchView}), and the open made here settles when that one
 * does. A re-run can also overtake an open still reading what it needs before
 * it opens anything, and open the view again from here; so an open that a
 * newer one of the same view has taken over leaves it owed, for that one to
 * settle.
 */
export function openLinked(host: ListHost, cacheKey: string, open: (opts: OpenOptions) => Promise<void>): Promise<void> | null {
  const page = links
  const ask = page?.owed && page.ask?.host === host ? page.ask : null
  if (!page || !ask)
    return null
  const seed = ask.list && filterStateOf(ask.list.filter)
  return open(seed ? { seed } : {}).then(() => {
    if (!isOpening(cacheKey))
      page.owed = false
  })
}

/**
 * Bring a unit's view up as this run of the page owes it: put back what a
 * re-run took down, a view where the reader left it or one still opening as far
 * as it had got; failing that, open the list the page's open URL names; failing
 * that, put back the view filter of a list the tab has come to refine
 * ({@link restoreListFilter}).
 */
export function resumeView(options: Options, host: ListHost, cacheKey: string, open: (opts: OpenOptions) => Promise<void>): void {
  if (!resumeSearchView(cacheKey, open))
    void (openLinked(host, cacheKey, open) ?? restoreListFilter(options, cacheKey, open))
}

/** Run `show` once the page has a body to show things on. */
function whenShown(show: () => void): void {
  if (document.body)
    show()
  else
    document.addEventListener('DOMContentLoaded', show, { once: true })
}

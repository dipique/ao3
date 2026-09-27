import type { RefiningMark, TrackedList } from '#common'

import { getArchiveLink, parseRefiningMark, refineLink, REFINING_STORAGE_KEY, refiningId } from '#common'

/**
 * Which list this tab is refining — the tab-side half of refining a list.
 *
 * The options page links each list to its own page with the list's id in the
 * fragment ({@link refineLink}). Arriving by that link marks the tab as
 * refining that list, and the mark is kept in the tab's `sessionStorage`
 * ({@link REFINING_STORAGE_KEY}) rather than in the address, because refining
 * is made of moving between addresses: submitting a listing's Sort & Filter
 * sidebar loads a new one, and a fragment would be lost on the way. A reload or
 * a copied link doesn't carry it either, since the fragment is taken off the
 * address as soon as it has been read.
 *
 * The mark ends when the list is updated, when the page is tracked as a new list
 * instead, when the reader stops refining, and when the list no longer exists.
 * Never on navigation. Every read and write is guarded: a tab whose storage is
 * unavailable simply has no mark.
 */

/** The mark as the tab holds it, whether or not its list still exists. */
export function readRefiningMark(): RefiningMark | null {
  try {
    return parseRefiningMark(sessionStorage.getItem(REFINING_STORAGE_KEY))
  }
  catch {
    return null
  }
}

/**
 * Mark this tab as refining list `id`. `restore` says the list's view filter
 * still has to be put back on screen, which is only so when the tab is about to
 * open the list's own page.
 */
export function startRefining(id: string, restore = true): void {
  try {
    sessionStorage.setItem(REFINING_STORAGE_KEY, JSON.stringify({ id, restore } satisfies RefiningMark))
  }
  catch {}
}

/** End the tab's mark, if it has one. */
export function endRefining(): void {
  try {
    sessionStorage.removeItem(REFINING_STORAGE_KEY)
  }
  catch {}
}

/**
 * The list this tab is refining, or null. A mark whose list is gone — deleted
 * on the options page, or by a sync — is dropped here, the first time anything
 * looks.
 */
export function refiningList<T extends Pick<TrackedList, 'id'>>(lists: readonly T[]): T | null {
  const mark = readRefiningMark()
  if (!mark)
    return null
  const list = lists.find(one => one.id === mark.id)
  if (!list)
    endRefining()
  return list ?? null
}

/**
 * Read a refining link's fragment, if the page was opened by one: mark the tab
 * as refining the list it names (when there still is such a list), and take the
 * fragment off the address either way — it's ours, and it means nothing to the
 * archive or to whoever the address is later passed to.
 */
export function takeRefiningLink(lists: readonly Pick<TrackedList, 'id'>[]): void {
  const id = refiningId(location.hash)
  if (id === null)
    return
  if (lists.some(one => one.id === id))
    startRefining(id)
  history.replaceState(history.state, '', `${location.pathname}${location.search}`)
}

/**
 * Open a list's own page in this tab, refining it — the pill's way onto the
 * refining link for a reader who arrived some other way. False, having done
 * nothing, when the list's address isn't an archive page of its kind.
 */
export function openRefining(entry: Pick<TrackedList, 'id' | 'kind' | 'url'>): boolean {
  const link = refineLink(entry)
  if (!link)
    return false
  startRefining(entry.id)
  const target = new URL(getArchiveLink(link))
  // An address that differs from this one only by its fragment is a scroll, not
  // a load: the page would never be read again. Load it again instead — the mark
  // is already made.
  if (target.origin === location.origin && target.pathname === location.pathname && target.search === location.search)
    location.reload()
  else
    location.assign(target.href)
  return true
}

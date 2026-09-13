import { ADDON_CLASS } from '#common'

/**
 * AO3's readings pages — History and Marked for Later — share one subnav, and
 * its last item, "Clear Entire History", is a destructive action that belongs
 * to only one of them. On the to-read list, or while a search view stands in for
 * History, it sits beside a list it has nothing to do with, one careless click
 * from wiping the reader's whole record. So it is only shown on the plain
 * History listing.
 */

/** Put on the "Clear Entire History" item wherever it doesn't belong. */
const HIDDEN_CLASS = `${ADDON_CLASS}--clear-history-hidden`

/**
 * The "Clear Entire History" subnav item, or null if this page has none.
 *
 * It carries no class or id of its own, so it is found by position: the last
 * link in the subnav. Only AO3's own items are counted — ours (a search button,
 * the stand-in items a view puts up) would otherwise be last — and the link has
 * to actually say "clear", so a page that dropped the item can never have its
 * History or Marked for Later link hidden in its place.
 */
export function clearHistoryItem(): HTMLElement | null {
  const links = [...document.querySelectorAll<HTMLAnchorElement>(`div#main > ul.navigation.actions > li:not(.${ADDON_CLASS}) > a`)]
  const last = links.at(-1)
  if (!last || !/clear/i.test(`${last.getAttribute('href') ?? ''} ${last.textContent ?? ''}`))
    return null
  return last.parentElement
}

/** Hide "Clear Entire History" for as long as this page run lasts. */
export function hideClearHistory(): void {
  clearHistoryItem()?.classList.add(HIDDEN_CLASS)
}

/** Undo {@link hideClearHistory} — for a unit's `clean()`, which a re-run needs complete. */
export function showClearHistory(): void {
  for (const el of document.querySelectorAll(`.${HIDDEN_CLASS}`))
    el.classList.remove(HIDDEN_CLASS)
}

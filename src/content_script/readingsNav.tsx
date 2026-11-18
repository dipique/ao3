import { ADDON_CLASS } from '#common'
import { NATIVE_HIDDEN_CLASS } from '#content_script/searchView/classes.ts'
import React from '#dom'

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

/**
 * The user whose readings page this is, or null on any other page. Both halves
 * of `/users/:user/readings` count: `?show=to-read` is the Marked for Later
 * list, anything else is History.
 */
export function readingsUser(): string | null {
  return location.pathname.match(/^\/users\/([^/]+)\/readings\/?$/)?.[1] ?? null
}

/** Whether the page being shown is the History listing rather than the to-read one. */
export function onHistoryPage(): boolean {
  return new URLSearchParams(location.search).get('show') !== 'to-read'
}

/** A view that stands in for a readings page's own list, as the subnav and heading name it. */
export interface ReadingsView {
  /** The class on the view's own subnav button. */
  buttonClass: string
  /** The class on everything {@link showListChrome} adds, which the view removes when it closes. */
  chromeClass: string
  /** What the view calls its list, as a heading and as a subnav item. */
  name: string
}

/**
 * The subnav item a view's button goes after: the Marked for Later one (a link
 * on History, the current page's own label on the to-read list), skipping past
 * anything of ours already there, such as another view's button.
 */
export function anchorItem(): HTMLElement | null {
  const item = Array.from(document.querySelectorAll('#main ul.navigation.actions > li'))
    .find(li => li.textContent?.trim() === 'Marked for Later')
  if (!item)
    return null
  let last: Element = item
  while (last.nextElementSibling?.classList.contains(ADDON_CLASS))
    last = last.nextElementSibling
  return last as HTMLElement
}

/**
 * The furniture that names the list on screen: the page heading ("History",
 * "Marked for Later"), the subnav item AO3 marks as current, the view's own
 * button, and History's "Clear Entire History". Hidden while the view is up,
 * because none of it is true any more: the reader is looking at the view,
 * whichever page they opened it from.
 */
export function listChrome(view: Pick<ReadingsView, 'buttonClass'>): Element[] {
  const nav = document.querySelector('#main ul.navigation.actions')
  return [
    document.querySelector('#main > h2.heading'),
    nav?.querySelector(`:scope > li:not(.${ADDON_CLASS}) > span.current`)?.parentElement,
    nav?.querySelector(`.${view.buttonClass}`)?.closest('li'),
    clearHistoryItem(),
  ].filter((el): el is HTMLElement => !!el)
}

/**
 * Stand in for {@link listChrome} while the view is up, the way AO3 draws its
 * own lists: a heading naming the view's list, its subnav item as the current
 * one in place of the view's button (or where it would be), and the item that
 * was* current turned back into a link, so the reader can go back to the plain
 * page. The originals come back with the rest of the native page.
 *
 * `userId` is as {@link readingsUser} reads it from the page's address, so it is
 * already encoded for one.
 */
export function showListChrome(view: ReadingsView, userId: string): void {
  const hidden = `.${NATIVE_HIDDEN_CLASS}`
  const heading = document.querySelector(`#main > h2.heading${hidden}`)
  heading?.after(<h2 class={`heading ${ADDON_CLASS}  ${view.chromeClass}`}>{view.name}</h2>)

  const nav = document.querySelector('#main ul.navigation.actions')
  const current = nav?.querySelector(`:scope > li${hidden} > span.current`)
  if (current) {
    const path = `/users/${userId}/readings`
    const href = onHistoryPage() ? path : `${path}?show=to-read`
    current.parentElement!.after(
      <li class={`${ADDON_CLASS}  ${view.chromeClass}`}><a href={href}>{current.textContent?.trim() ?? ''}</a></li>,
    )
  }
  const place = nav?.querySelector(`.${view.buttonClass}`)?.closest('li') ?? anchorItem()
  place?.after(
    <li class={`${ADDON_CLASS}  ${view.chromeClass}`}><span class="current">{view.name}</span></li>,
  )
}

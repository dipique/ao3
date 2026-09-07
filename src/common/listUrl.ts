/**
 * Page-number handling for an AO3 listing URL.
 *
 * Pure — no DOM, no browser APIs, no imports — so it loads under a plain
 * `node --test` (see `test/searchView/listUrl.test.mjs`).
 *
 * A snapshot's stored `listUrl` names the listing, not a particular page of it:
 * it may have been captured from page 3, and AO3's own links carry whatever page
 * they came from. So the page is always *set*, never appended, and every other
 * part of the URL — the `show=to-read` of a Marked for Later list, a text
 * search's whole query — is left exactly as it was.
 */

/**
 * `listUrl` with its `page` query parameter set to `page`.
 *
 * Throws on a relative URL: a stored `listUrl` is always absolute (the sources
 * build it through `getArchiveLink`), and quietly resolving one against whatever
 * document happened to be current is how a refresh ends up scraping the wrong
 * site.
 */
export function withPage(listUrl: string, page: number): string {
  const url = new URL(listUrl)
  url.searchParams.set('page', String(page))
  return url.href
}

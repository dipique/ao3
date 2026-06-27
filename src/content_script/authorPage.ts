import { fetchAndParseDocument } from '#common'

/**
 * Per-run cache of fetched author pages, keyed by URL. Both the subscribe and
 * mute toolbars need the same byline page (a user/pseud page) to read their
 * respective controls, so sharing the fetch avoids requesting it twice when both
 * are enabled. Cleared each run via {@link resetAuthorPageCache}.
 */
const cache = new Map<string, Promise<Document>>()

export function getAuthorPage(url: string): Promise<Document> {
  let page = cache.get(url)
  if (!page) {
    // Drop failures from the cache so a later hover can retry rather than being
    // stuck with a rejected promise for the rest of the run.
    page = fetchAndParseDocument(url).catch((err) => {
      cache.delete(url)
      throw err
    })
    cache.set(url, page)
  }
  return page
}

export function resetAuthorPageCache(): void {
  cache.clear()
}

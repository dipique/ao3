import { fetchWithRetry } from '#content_script/archiveFetch.js'
import { parseWork, type Work } from '#content_script/blurb.js'

/**
 * Generic, polite scraper for a paginated AO3 works listing (search results,
 * a fandom page, a user's Marked for Later, etc.). It fetches every page,
 * collects the real `li.blurb` nodes and parses them into `Work[]`. AO3 runs on
 * donated infrastructure and rate-limits aggressively, so requests run through a
 * small concurrency pool and back off on HTTP 429 (see
 * {@link file://../archiveFetch.ts}).
 */

/** Highest page number from a `pagy`/AO3 pagination block in a listing document. */
export function detectPageCount(doc: Document | Element): number {
  const pagination = doc.querySelector('ol.pagination.pagy, ol.pagination.actions')
  if (!pagination)
    return 1
  const numbers = Array.from(pagination.querySelectorAll('li a, li span'))
    .map(el => Number((el.textContent ?? '').replace(/\D/g, '')))
    .filter(n => Number.isFinite(n) && n > 0)
  return numbers.length ? Math.max(...numbers) : 1
}

/**
 * Fetch one listing page as a Document, retrying on 429 (honouring Retry-After).
 *
 * Exported because a caller outside an AO3 page — the options page, refreshing a
 * stored snapshot — has to fetch page 1 before it can know how many pages there
 * are, and wants exactly these retry manners while it does.
 */
export async function fetchPageDoc(url: string, signal?: AbortSignal, retries = 3): Promise<Document> {
  const res = await fetchWithRetry(url, signal, retries)
  if (res.status !== 200)
    throw new Error(`Failed to fetch ${url} (status ${res.status})`)
  // A private DOMParser, not the shared parseDocument(), so we don't clobber
  // the module-level CSRF token cache other features rely on.
  return new DOMParser().parseFromString(await res.text(), 'text/html')
}

/**
 * Where the blurbs sit in a fetched listing page. AO3's search results and a
 * user's readings use `ol.work.index.group`; a tag's own page lists its works in
 * a `ul.index.group` inside the works listbox — and puts a *second* such list
 * (bookmarks) further down, so that one has to be scoped to its listbox.
 */
export const DEFAULT_BLURB_SELECTOR = 'ol.work.index.group > li.blurb'

export interface ScrapeOptions {
  /** Total number of pages to fetch (see {@link detectPageCount}). */
  pageCount: number
  /** Builds the URL for a given 1-based page number. */
  pageUrl: (page: number) => string
  /** Where the blurbs are (see {@link DEFAULT_BLURB_SELECTOR}). */
  blurbSelector?: string
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
  /** Max simultaneous requests. Default 3 — polite for AO3. */
  concurrency?: number
  /**
   * Page 1, when the caller has already fetched it (to read the page count off
   * a listing it can't see live). Saves AO3 a duplicate request per refresh.
   */
  firstPageDoc?: Document
}

export interface ScrapeResult {
  works: Work[]
  loadedPages: number
  totalPages: number
}

/** Collect and parse the blurbs from already-fetched listing documents. */
export function collectWorks(docs: Document[], blurbSelector: string = DEFAULT_BLURB_SELECTOR): Work[] {
  const works: Work[] = []
  const seen = new Set<string>()
  let order = 0
  for (const doc of docs) {
    for (const li of doc.querySelectorAll(blurbSelector)) {
      if (!(li instanceof HTMLLIElement))
        continue
      // Adopt into the live document so the node can be mounted in the view.
      document.adoptNode(li)
      const work = parseWork(li, order)
      if (work.workId && seen.has(work.workId))
        continue
      if (work.workId)
        seen.add(work.workId)
      work.markedOrder = order++
      works.push(work)
    }
  }
  return works
}

/**
 * Fetch every page of a listing through a bounded pool and return the parsed
 * works. Pages that keep failing (e.g. persistent 429) are skipped; the caller
 * gets `loadedPages < totalPages` and can warn about the partial result.
 */
export async function scrapeListing(opts: ScrapeOptions): Promise<ScrapeResult> {
  const { pageCount, pageUrl, blurbSelector, onProgress, signal, concurrency = 3, firstPageDoc } = opts
  // Sparse by page index; failed pages stay holes and are filtered out below.
  const docs: (Document | undefined)[] = []
  let done = 0
  let next = 0
  let failures = 0
  if (firstPageDoc) {
    docs[0] = firstPageDoc
    next = 1
    done = 1
  }
  onProgress?.(done, pageCount)

  async function worker(): Promise<void> {
    while (next < pageCount) {
      if (signal?.aborted)
        return
      const index = next++
      try {
        docs[index] = await fetchPageDoc(pageUrl(index + 1), signal)
      }
      catch (err) {
        if (signal?.aborted)
          return
        failures++
        console.warn('[searchView] page fetch failed', err)
      }
      done++
      onProgress?.(done, pageCount)
    }
  }

  await Promise.all(Array.from({ length: Math.max(0, Math.min(concurrency, pageCount - next)) }, worker))
  if (signal?.aborted)
    throw new DOMException('Scrape aborted', 'AbortError')

  return {
    works: collectWorks(docs.filter((d): d is Document => d !== undefined), blurbSelector),
    loadedPages: pageCount - failures,
    totalPages: pageCount,
  }
}

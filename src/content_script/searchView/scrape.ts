import { parseWork, type Work } from '#content_script/blurb.js'

/**
 * Generic, polite scraper for a paginated AO3 works listing (search results,
 * a fandom page, a user's Marked for Later, etc.). It fetches every page,
 * collects the real `li.blurb` nodes and parses them into `Work[]`. AO3 runs on
 * donated infrastructure and rate-limits aggressively, so requests run through a
 * small concurrency pool and back off on HTTP 429.
 */

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

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

/** Fetch one listing page as a Document, retrying on 429 (honouring Retry-After). */
async function fetchPageDoc(url: string, signal?: AbortSignal, retries = 3): Promise<Document> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { credentials: 'same-origin', signal })
    if (res.status === 200) {
      // A private DOMParser, not the shared parseDocument(), so we don't clobber
      // the module-level CSRF token cache other features rely on.
      return new DOMParser().parseFromString(await res.text(), 'text/html')
    }
    if (res.status === 429 && attempt < retries) {
      const retryAfter = Number(res.headers.get('Retry-After'))
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 1000 * 2 ** attempt))
      continue
    }
    throw new Error(`Failed to fetch ${url} (status ${res.status})`)
  }
}

export interface ScrapeOptions {
  /** Total number of pages to fetch (see {@link detectPageCount}). */
  pageCount: number
  /** Builds the URL for a given 1-based page number. */
  pageUrl: (page: number) => string
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
  /** Max simultaneous requests. Default 3 — polite for AO3. */
  concurrency?: number
}

export interface ScrapeResult {
  works: Work[]
  loadedPages: number
  totalPages: number
}

/** Collect and parse the blurbs from already-fetched listing documents. */
export function collectWorks(docs: Document[]): Work[] {
  const works: Work[] = []
  const seen = new Set<string>()
  let order = 0
  for (const doc of docs) {
    for (const li of doc.querySelectorAll('ol.work.index.group > li.blurb')) {
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
  const { pageCount, pageUrl, onProgress, signal, concurrency = 3 } = opts
  // Sparse by page index; failed pages stay holes and are filtered out below.
  const docs: (Document | undefined)[] = []
  let done = 0
  let next = 0
  let failures = 0
  onProgress?.(0, pageCount)

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

  await Promise.all(Array.from({ length: Math.min(concurrency, pageCount) }, worker))
  if (signal?.aborted)
    throw new DOMException('Scrape aborted', 'AbortError')

  return {
    works: collectWorks(docs.filter((d): d is Document => d !== undefined)),
    loadedPages: pageCount - failures,
    totalPages: pageCount,
  }
}

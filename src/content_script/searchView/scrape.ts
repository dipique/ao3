import { archiveWaitRemaining, fetchWithRetry, PATIENCE, WAIT_BUDGET, waitForArchive } from '#content_script/archiveFetch.js'
import { parseWork, type Work } from '#content_script/blurb.js'

/**
 * Generic, polite scraper for a paginated AO3 works listing (search results,
 * a fandom page, a user's Marked for Later, etc.). It fetches every page,
 * collects the real `li.blurb` nodes and parses them into `Work[]`. AO3 runs on
 * donated infrastructure and rate-limits aggressively, so requests run through a
 * small concurrency pool, take a breather every twenty requests, and back off on
 * HTTP 429 (see {@link file://../archiveFetch.ts}).
 *
 * **A rate limit is not a page's failure, and does not cost it its place.** The
 * scrape runs in rounds: a round fetches the pages still wanted, and the moment
 * one of them is refused for good, the round is called off — every page it had
 * not yet landed goes back on the list, the whole pool sits out the archive's
 * pause together, and the next round asks again for exactly what is missing.
 * Only a page that keeps failing *on its own account* ({@link MAX_PAGE_ATTEMPTS}
 * times, for a 404 or a broken connection) is given up on.
 *
 * That is the difference between a scrape that survives a 429 and one that
 * doesn't. Marching the rest of the queue into a wall the archive has already
 * put up costs one patience-length wait per page and ends with a listing full of
 * holes; standing still once, together, costs one wait for the whole run.
 */

/**
 * How many times a page may fail on its own account before the scrape stops
 * asking for it. Rate limits don't count — those are the archive's answer to
 * everyone, not to this page.
 */
const MAX_PAGE_ATTEMPTS = 3

/**
 * How many times the archive may call a round off before the scrape stops
 * coming back, however much of its waiting budget is left.
 *
 * The budget alone isn't enough of a stop: a `Retry-After` of a second or two
 * spends none of it, so a listing that is refused a page at a time could go
 * round for ever without ever having *waited*. This is the count that ends it.
 */
const MAX_REFUSED_ROUNDS = 6

/**
 * Pages a caller will read of a listing it is *searching* rather than showing
 * (see {@link ScrapeOptions.satisfied}) before giving up on finding the rest.
 * Ten thousand entries deep — far past where a reader's marks realistically
 * live, and a hard stop on reading a history that has no end in sight.
 */
export const MAX_SCANNED_PAGES = 500

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
export async function fetchPageDoc(url: string, signal?: AbortSignal, patience: number = PATIENCE.interactive): Promise<Document> {
  const res = await fetchWithRetry(url, signal, patience)
  // Told apart from every other bad status because it is the one that isn't
  // about this page: the archive would have refused anything asked for at that
  // moment, so a caller with more pages to fetch must stop rather than take it
  // as news about this one.
  if (res.status === 429)
    throw new ArchiveBusyError(url)
  if (res.status !== 200)
    throw new Error(`Failed to fetch ${url} (status ${res.status})`)
  // A private DOMParser, not the shared parseDocument(), so we don't clobber
  // the module-level CSRF token cache other features rely on.
  return new DOMParser().parseFromString(await res.text(), 'text/html')
}

/**
 * AO3 was still refusing once {@link file://../archiveFetch.ts} had waited as
 * long as the caller's patience allowed. Nothing is wrong with the page; we were
 * asking too often, and must come back later.
 */
export class ArchiveBusyError extends Error {
  constructor(url: string) {
    super(`AO3 is asking us to slow down (${url})`)
    this.name = 'ArchiveBusyError'
  }
}

/** Whether a thrown value is {@link ArchiveBusyError} — by name, as `AbortError` is. */
export function isArchiveBusy(err: unknown): boolean {
  return (err as Error)?.name === 'ArchiveBusyError'
}

/**
 * A controller that aborts when `parent` does, so a round can call itself off
 * without touching the caller's signal — whose abort means something else
 * entirely (the reader pressed Back) and must still reach us.
 *
 * `AbortSignal.any` would say this in one line, but it landed in Firefox 124 and
 * the manifest supports 117.
 */
function roundController(parent?: AbortSignal): AbortController {
  const child = new AbortController()
  if (!parent)
    return child
  if (parent.aborted)
    child.abort(parent.reason)
  else
    parent.addEventListener('abort', () => child.abort(parent.reason), { once: true })
  return child
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
   * How long to sit out a rate limit before giving up on a page — see
   * {@link file://../archiveFetch.ts}'s `PATIENCE`. Defaults to the impatient
   * one, since most scrapes happen with a reader watching the progress bar.
   */
  patience?: number
  /**
   * Page 1, when the caller has already fetched it (to read the page count off
   * a listing it can't see live). Saves AO3 a duplicate request per refresh.
   */
  firstPageDoc?: Document
  /**
   * How long the whole scrape may spend sitting out rate limits before it gives
   * up and reports what it has — see {@link WAIT_BUDGET}. Defaults to the
   * interactive budget, since most scrapes happen with a reader watching.
   */
  waitBudget?: number
  /**
   * Whether enough has been fetched to stop, given the work ids seen so far.
   *
   * For a listing that is being *searched* rather than shown. The read list
   * knows which works it wants before it starts — they are the ones the reader
   * has marked — and only reads the archive's history to find their blurbs, so
   * it can stop the moment it has them all instead of reading to the end of a
   * history that may run to hundreds of pages.
   *
   * Called after each page lands, with every id seen so far. Stopping here is
   * not a shortfall: see {@link ScrapeResult.satisfied}.
   */
  satisfied?: (ids: ReadonlySet<string>) => boolean
}

export interface ScrapeResult {
  works: Work[]
  /** Pages actually fetched and parsed. */
  loadedPages: number
  totalPages: number
  /**
   * {@link ScrapeOptions.satisfied} said to stop, so the pages not fetched were
   * not wanted. `loadedPages < totalPages` here means the scrape finished early
   * on purpose, which is the opposite of something having gone wrong.
   */
  satisfied?: boolean
  /**
   * The scrape stopped early because AO3 was still rate-limiting when its
   * {@link ScrapeOptions.waitBudget} ran out. The pages it never got are not
   * missing because anything is wrong with them, which is a different thing to
   * tell the reader — and a reason to try again later rather than to accept
   * this as the listing.
   */
  blocked?: boolean
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
 * works, coming back after a rate limit rather than giving up on what it
 * interrupted (see this module's own notes). A page that keeps failing on its
 * own account is skipped; the caller gets `loadedPages < totalPages` and can
 * warn about the partial result, and `blocked` when what stopped it was AO3.
 */
export async function scrapeListing(opts: ScrapeOptions): Promise<ScrapeResult> {
  const {
    pageCount,
    pageUrl,
    blurbSelector,
    onProgress,
    signal,
    concurrency = 3,
    firstPageDoc,
    patience,
    waitBudget = WAIT_BUDGET.interactive,
    satisfied,
  } = opts
  const selector = blurbSelector ?? DEFAULT_BLURB_SELECTOR
  // Sparse by page index; pages we never got stay holes and are filtered out below.
  const docs: (Document | undefined)[] = []
  // Pages still wanted, by index. A page leaves this list when it lands, or when
  // it has failed on its own account too often to be worth asking for again.
  let wanted = Array.from({ length: pageCount }, (_, i) => i)
  if (firstPageDoc) {
    docs[0] = firstPageDoc
    wanted.shift()
  }
  // Failures earned by the page itself; a refused round adds nothing here.
  const attempts = new Map<number, number>()
  // Every work id landed so far, for `satisfied`. Read off the blurbs' own
  // `id="work_123"` rather than by parsing them, which is the expensive half and
  // would be paid on every page of a haystack we mostly mean to throw away.
  const seenIds = new Set<string>()
  let enough = false
  // Pages settled one way or the other, which is what the progress bar counts:
  // a page put back for another round is not progress, and pretending otherwise
  // would run the bar to the end and leave it there.
  let settled = pageCount - wanted.length
  let blocked = false
  // Time spent standing still, which is the only thing the budget bounds: the
  // ordinary slow scrape of a very long listing spends none of it however long
  // it runs for.
  let waited = 0
  let refusedRounds = 0
  onProgress?.(settled, pageCount)

  while (wanted.length) {
    if (signal?.aborted)
      break
    const queue = wanted
    wanted = []
    let next = 0
    // Called off by the first page that is refused for good, which stops the
    // others where they stand — inside a wait they would otherwise sit out in
    // full before discovering the round is over. Each simply doesn't land its
    // page, and every page that didn't land goes back below.
    const round = roundController(signal)
    let refused = false

    const worker = async (): Promise<void> => {
      while (next < queue.length) {
        if (round.signal.aborted)
          return
        const index = queue[next++]!
        try {
          docs[index] = await fetchPageDoc(pageUrl(index + 1), round.signal, patience)
        }
        catch (err) {
          if (round.signal.aborted)
            return
          if (isArchiveBusy(err)) {
            refused = true
            round.abort()
            return
          }
          attempts.set(index, (attempts.get(index) ?? 0) + 1)
          console.warn('[searchView] page fetch failed', err)
          continue
        }
        settled++
        onProgress?.(settled, pageCount)
        if (satisfied) {
          for (const el of docs[index]!.querySelectorAll(selector))
            seenIds.add(el.id.replace(/^work_/, ''))
          if (satisfied(seenIds)) {
            // Everything wanted has been found. Stop the pool where it stands —
            // the pages nobody has reached hold nothing we came for.
            enough = true
            round.abort()
            return
          }
        }
      }
    }

    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker))
    if (signal?.aborted)
      break
    if (enough) {
      wanted = []
      break
    }

    for (const index of queue) {
      if (docs[index])
        continue
      // Out of tries of its own — the page itself is the problem (a 404, a
      // listing that moved under us), and asking again would only cost AO3 more
      // requests for the same answer.
      if ((attempts.get(index) ?? 0) >= MAX_PAGE_ATTEMPTS) {
        settled++
        continue
      }
      wanted.push(index)
    }
    onProgress?.(settled, pageCount)
    if (!wanted.length)
      break

    // Nothing left but pages the archive wouldn't give us. Sit out its pause
    // once, for the whole pool, and go round again — unless we have already
    // spent the run's whole budget on waiting, in which case the reader gets
    // what we have and the chance to try again later.
    if (refused) {
      // Looked at before committing to it: a blind refusal can run to the hour,
      // and a budget only checked afterwards would be a budget already blown.
      const remaining = archiveWaitRemaining()
      if (++refusedRounds > MAX_REFUSED_ROUNDS || waited + remaining > waitBudget) {
        blocked = true
        break
      }
      const before = Date.now()
      await waitForArchive(signal)
      // Measured rather than assumed: the pause may have been extended while we
      // sat in it, and the running total has to be of time actually spent.
      waited += Date.now() - before
    }
  }

  if (signal?.aborted)
    throw new DOMException('Scrape aborted', 'AbortError')

  const landed = docs.filter((d): d is Document => d !== undefined)
  return {
    works: collectWorks(landed, selector),
    loadedPages: landed.length,
    totalPages: pageCount,
    satisfied: enough,
    blocked,
  }
}

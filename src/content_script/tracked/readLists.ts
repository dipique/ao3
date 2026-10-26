import type { Day, NextRead, PageRead, PassState, TrackedList } from '#common'
import type { Work } from '#content_script/blurb.js'

import { applyPage, dayOf, excludedTagNames, getArchiveLink, nextRead, PAGE_SIZE, pageUrl, pruneReviewed, recordFor, storedRecordOf, toShortId, unpackRows, utcToday } from '#common'
import { archiveWaitRemaining, onArchiveWait, waitForArchive } from '#content_script/archiveFetch.js'
import { storeWorks } from '#content_script/searchView/blurbStore.ts'
import { collectWorks, DEFAULT_BLURB_SELECTOR, detectPageCount, detectResultCount, fetchPageDoc, isArchiveBusy } from '#content_script/searchView/scrape.ts'
import { TAG_BLURB_SELECTOR } from '#content_script/tagPage.ts'

import { readStoredRecords, writeReadRecord } from './readStore.ts'

/**
 * Bringing the tracked lists' read records up to date: the loop that runs the
 * pure planner ({@link file://../../common/trackedReads.ts}) against the
 * archive, one request at a time, until every list has been read to its end.
 *
 * Each list is asked only for what its record doesn't yet hold — everything
 * filed from the day after its `through` — so a second run the same day reads
 * only today's tail, and a run the next day about a page per list. The list
 * read least far is always read next, so the earliest unknown days come in
 * first, and it reads past the window the reader is looking at, which is what
 * has the next one ready.
 *
 * After every page its works go to the blurb store and the list's record is
 * written, so a run stopped by a rate limit, a closed tab or an abort loses at
 * most the page it was reading.
 *
 * **Import discipline.** No `searchView/hidden.ts`, no `decorate.ts` and no
 * Unit, so the options page can bundle it: hide verdicts belong to whoever
 * draws the works.
 */

/**
 * Pages of a scanned list read in one go. A series is short and lists its works
 * in series order, which no date bound touches, so it is read whole — and past
 * this many pages, only the last few, since new parts are appended to the end.
 */
const SCAN_PAGE_CAP = 5

/** How often one request may fail on its own account before its list is given up on for the run. */
const MAX_REQUEST_ATTEMPTS = 3

/**
 * How often in a row the archive may call the run off before it stops coming
 * back, however much of its waiting budget is left. A short `Retry-After`
 * spends none of the budget, so without a count a run refused a page at a time
 * could go round for ever having never actually waited. A page that lands
 * starts the count again: a run reads every list to its end, which can be
 * hundreds of pages.
 */
const MAX_REFUSED_ROUNDS = 6

/** A series lists its works in a `ul`, unlike every other listing on the archive. */
const SERIES_BLURB_SELECTOR = 'ul.series.work.index.group > li.blurb'

/** Where a run has got, for whoever is showing it. */
export interface ReadStatus {
  /** Lists done for this run: read to their end, or given up on. */
  listsDone: number
  lists: number
  /** The list being read now, by id; null between requests and once the run is over. */
  reading: string | null
  /** Epoch ms a pause in requests to the archive runs to; 0 when there is none. */
  waitUntil: number
  /** Requests made, retries included. */
  requests: number
}

export interface ReadOptions {
  /** The lists to read. One that isn't tracked is left out. */
  lists: readonly TrackedList[]
  /** The review window's first day (`reviewStart`): where a list never read is read from. */
  start: Day
  /**
   * The window's first day as it stands now, asked before each page is added:
   * the reader may mark a range reviewed while the run goes on, and the records
   * then lose those days. Absent, `start` throughout.
   */
  currentStart?: () => Promise<Day>
  /** How long one request may wait out refusals: `PATIENCE.interactive` in the review, `.bulk` from the options page. */
  patience: number
  /** How long the run may spend waiting out refusals in all before it stops. */
  waitBudget: number
  signal?: AbortSignal
  onProgress?: (status: ReadStatus) => void
}

export interface ReadOutcome {
  /** The archive was still refusing when the waiting budget ran out; the lists not yet done are as the last page left them. */
  blocked: boolean
  /** Lists given up on for this run: three request errors, signed out, or an address that isn't a page on the archive. */
  failed: string[]
  requests: number
}

/** One list as the run holds it. */
interface ListState extends PassState {
  list: TrackedList
  /** The tag names its view filter excludes, which every page it reads asks the archive to leave out. */
  exclude: string[]
  scanned: boolean
}

/** Whether a list is read whole rather than by date. */
function isScanned(list: TrackedList): boolean {
  return list.kind === 'series-works' || (list.kind === 'tag-works' && !!list.scan)
}

/** Where a list's works sit on the page it is read from. */
function blurbSelectorFor(list: TrackedList): string {
  if (list.kind === 'series-works')
    return SERIES_BLURB_SELECTOR
  // Only a tag read by scanning is read off the tag's own page, which lists
  // bookmarks below the works in a second list of the same shape; one read
  // through a search by the tag's name is an ordinary works search.
  if (list.kind === 'tag-works' && list.scan)
    return TAG_BLURB_SELECTOR
  return DEFAULT_BLURB_SELECTOR
}

/** Abort the way the listing scrape does, so a caller can tell the two apart from nothing. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException('Tracked lists read aborted', 'AbortError')
}

/**
 * Whether the archive answered as though nobody were signed in. A session that
 * has lapsed returns a shorter list (works only visible to registered users are
 * missing from it) that looks exactly like a real one, and a record trusted off
 * the back of it would lose them for good. Only an explicit `logged-out`
 * counts.
 */
function signedOut(doc: Document): boolean {
  return doc.body?.classList.contains('logged-out') ?? false
}

/**
 * Read every tracked list's record up to date, and say how it went.
 *
 * A list fails for the run on its third request error, on a page that says
 * nobody is signed in, or when its address isn't a page on the archive. Its
 * record keeps every page it had and is marked `failed`, and the next run tries
 * it again. A rate limit is sat out once for everybody and the same request
 * made again, within the request's patience and the run's waiting budget; past
 * those the run stops, `blocked`, with every record as its last page left it.
 *
 * Throws an `AbortError` when `signal` aborts.
 */
export async function readTrackedLists(opts: ReadOptions): Promise<ReadOutcome> {
  const { signal } = opts
  const lists = opts.lists.filter(list => list.tracked)
  const stored = await readStoredRecords(lists.map(list => list.id))
  const states: ListState[] = lists.map(list => ({
    listId: list.id,
    list,
    record: recordFor(list, stored.get(list.id), opts.start),
    exclude: excludedTagNames(list.filter),
    scanned: isScanned(list),
  }))

  const failed: string[] = []
  const attempts = new Map<string, number>()
  let requests = 0
  let waited = 0
  let refusedRounds = 0
  let blocked = false
  let reading: string | null = null
  let waitUntil = 0

  const report = (): void => {
    opts.onProgress?.({ listsDone: states.filter(state => state.done).length, lists: states.length, reading, waitUntil, requests })
  }
  const unwatch = onArchiveWait((until) => {
    waitUntil = until
    report()
  })

  const giveUp = async (state: ListState): Promise<void> => {
    state.done = true
    failed.push(state.listId)
    state.record = { ...state.record, failed: true }
    await writeReadRecord(state.listId, state.record)
  }

  const get = async (url: string): Promise<Document> => {
    requests++
    report()
    return fetchPageDoc(getArchiveLink(url), signal, opts.patience)
  }

  try {
    // An entry whose address isn't a page on the archive any more — one that
    // arrived through sync, or was edited by hand — can't be read at all.
    for (const state of states) {
      if (pageUrl(state.list, state.record.from, 1) === null)
        await giveUp(state)
    }
    report()

    for (;;) {
      throwIfAborted(signal)
      const next = nextRead(states, utcToday())
      if (!next)
        break
      const state = states.find(candidate => candidate.listId === next.listId)!
      const key = `${next.listId}\u0000${next.from}\u0000${next.page}`
      reading = state.listId
      try {
        const read = await readPage(state, next, get)
        if (!read) {
          await giveUp(state)
          continue
        }
        refusedRounds = 0
        // The reader may have marked days reviewed since this run began, and
        // another page may have taken them off the stored record: the stored
        // one is the one to add to, and the reviewed days stay off. One that
        // no longer covers the window as it stands now (the watermark went
        // back) is what this run is reading again, and isn't.
        const start = await (opts.currentStart?.() ?? opts.start)
        const raw = (await readStoredRecords([state.listId])).get(state.listId)
        const stored = storedRecordOf(state.list, raw)
        if (stored && stored.from > state.record.from && recordFor(state.list, raw, start) === stored)
          state.record = stored
        state.record = pruneReviewed(state.record, start - 1).record
        const record = applyPage(state.record, read.page, { readDay: utcToday(), scanned: state.scanned, at: Date.now() })
        // Blurbs first, record second, so a record never names a blurb that
        // isn't there; and only the blurbs of works the record keeps.
        const kept = new Set(unpackRows(record.rows).map(row => row.sid))
        await storeWorks(read.works.filter(work => kept.has(toShortId(work.workId)!)))
        state.record = record
        await writeReadRecord(state.listId, state.record)
        state.pass = { from: next.from, page: next.page }
        if (read.page.reachedEnd)
          state.done = true
        attempts.delete(key)
      }
      catch (err) {
        if (signal?.aborted || (err as Error)?.name === 'AbortError')
          throw err
        if (isArchiveBusy(err)) {
          // Looked at before committing to it: a blind refusal can run to the
          // hour, and a budget only checked afterwards is one already blown.
          const remaining = archiveWaitRemaining()
          if (++refusedRounds > MAX_REFUSED_ROUNDS || waited + remaining > opts.waitBudget) {
            blocked = true
            break
          }
          const before = Date.now()
          await waitForArchive(signal)
          waited += Date.now() - before
          continue
        }
        const tries = (attempts.get(key) ?? 0) + 1
        attempts.set(key, tries)
        console.warn('[tracked] page fetch failed', err)
        if (tries >= MAX_REQUEST_ATTEMPTS)
          await giveUp(state)
      }
    }
  }
  finally {
    unwatch()
    reading = null
    waitUntil = 0
    report()
  }
  return { blocked, failed, requests }
}

/**
 * Read the page `next` names, and hand back its works and what it says. Null
 * when the archive answered as though nobody were signed in. Throws for a page
 * with no listing on it at all — neither a work nor a heading count — which is
 * an error page served as a page, and no evidence the query has ended.
 *
 * A **scanned** list is read whole instead, as one page that reaches the end:
 * every page up to the cap, and past the cap the last few, since a series
 * appends. Nothing is handed back until all of them have landed, so a refusal
 * partway leaves the record as it was rather than half-read.
 */
async function readPage(
  state: ListState,
  next: NextRead,
  get: (url: string) => Promise<Document>,
): Promise<{ works: Work[], page: PageRead } | null> {
  const urlFor = (page: number): string => {
    const url = pageUrl(state.list, next.from, page, { exclude: state.exclude })
    if (!url)
      throw new Error(`Not a page on the archive: ${state.list.url}`)
    return url
  }
  const docs: Document[] = [await get(urlFor(next.page))]
  if (state.scanned) {
    const pages = Math.max(1, detectPageCount(docs[0]!))
    const from = pages <= SCAN_PAGE_CAP ? 2 : pages - SCAN_PAGE_CAP + 1
    for (let p = Math.max(2, from); p <= pages; p++)
      docs.push(await get(urlFor(p)))
  }
  if (docs.some(signedOut))
    return null
  const first = docs[0]!

  const seenAt = Date.now()
  const selector = blurbSelectorFor(state.list)
  // Counted before the works are collected, which takes their nodes out of the page.
  const listed = first.querySelectorAll(selector).length
  const works: Work[] = []
  const rows: PageRead['rows'] = []
  for (const doc of docs) {
    for (const work of collectWorks([doc], selector, seenAt)) {
      const sid = work.workId ? toShortId(work.workId) : null
      if (sid === null)
        continue
      works.push(work)
      rows.push({ sid, blurbDay: dayOf(work.dateText) ?? Number.NaN })
    }
  }

  let reachedEnd = true
  if (!state.scanned) {
    const count = detectResultCount(first)
    if (count === null && listed === 0)
      throw new Error(`No listing on the page: ${urlFor(next.page)}`)
    reachedEnd = listed < PAGE_SIZE || (count !== null && next.page * PAGE_SIZE >= count)
  }
  return { works, page: { from: next.from, page: next.page, rows, reachedEnd } }
}

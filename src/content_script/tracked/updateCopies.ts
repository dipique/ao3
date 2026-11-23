import type { CopyFailure, DatedCopy, Day, ListRead, ListReadFailure, NextRead, PageRead, PassState, SnapshotDescriptor, StoredList, TrackedKind, TrackedList } from '#common'
import type { Work } from '#content_script/blurb.js'
import type { RefreshHolder, RefreshOutcome } from '#content_script/searchView/listRefresh.ts'
import type { Hold } from '#content_script/searchView/refreshClaim.ts'

import { copyKeyOf, copyLabel, copyWanted, datedFor, dayOf, getArchiveLink, LIST_VERSION, MAX_REQUEST_ATTEMPTS, mergeDatedPage, nextRead, PAGE_SIZE, pageBase, pageUrl, sharedExclusions, sourceLabel, toShortId, unpackRows, utcToday } from '#common'
import { archiveWaitRemaining, onArchiveWait, waitForArchive } from '#content_script/archiveFetch.js'
import { storeWorks } from '#content_script/searchView/blurbStore.ts'
import { readStoredLists, writeStoredList } from '#content_script/searchView/cache.ts'
import { acquireRefresh } from '#content_script/searchView/refreshClaim.ts'
import { collectWorks, DEFAULT_BLURB_SELECTOR, detectPageCount, detectResultCount, fetchPageDoc, isArchiveBusy, SERIES_BLURB_SELECTOR } from '#content_script/searchView/scrape.ts'
import { TAG_BLURB_SELECTOR } from '#content_script/tagPage.ts'

/**
 * Bringing tracked lists' offline copies up to date by date: the loop that runs
 * the pure planner ({@link file://../../common/trackedReads.ts}) against the
 * archive, one request at a time, writing each copy as its pages land.
 *
 * Tracked lists at one address share a copy ({@link copyKeyOf}), read once for
 * all of them. Each copy is asked only for what it doesn't yet hold — from the
 * day after it is settled through — so a second run the same day reads only
 * today's tail, and a run the next day about a page per list. The copy read
 * least far is always read next, so the earliest unknown days come in first.
 *
 * After every page its works go to the blurb store and the copy is written,
 * so a run stopped by a rate limit, a closed tab or an abort loses at most the
 * page it was reading. A read never takes a work off a copy.
 *
 * Each copy is read under its list refresh claim, so this page and another —
 * the list's own view, the options page, another review — never read one copy
 * at once: a copy another page is reading is left to it, and its writes reach
 * whoever is watching.
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

/**
 * How often in a row the archive may call the run off before it stops coming
 * back, however much of its waiting budget is left. A short `Retry-After`
 * spends none of the budget, so without a count a run refused a page at a time
 * could go round for ever having never actually waited. A page that lands
 * starts the count again.
 */
export const MAX_REFUSED_ROUNDS = 6

/** Where the pages that aren't an ordinary listing list their works. */
const BLURB_SELECTORS: Partial<Record<TrackedKind, string>> = {
  'tag-works': TAG_BLURB_SELECTOR,
  'series-works': SERIES_BLURB_SELECTOR,
}

/** Where a run has got, for whoever is showing it. */
export interface ReadStatus {
  /** Lists done for this run: read as far as asked, left to another page, or given up on. */
  listsDone: number
  lists: number
  /** A list whose copy is being read now, by id; null between requests and once the run is over. */
  reading: string | null
  /** Epoch ms a pause in requests to the archive runs to; 0 when there is none. */
  waitUntil: number
  /** Requests made, retries included. */
  requests: number
  /** Every list's own progress, by id: the lists sharing a copy share its progress. */
  byList: Record<string, ListRead>
}

export interface UpdateOptions {
  /** Every tracked list: the lists sharing a copy are found among them. One that isn't tracked is left out. */
  entries: readonly TrackedList[]
  /** The lists whose copies to bring up to date, by id; absent, every tracked list. */
  only?: readonly string[]
  /** The last day wanted settled. Today reads each copy to the end of its query. */
  through: Day
  /** The first day wanted: a copy whose stretch starts after it is read again from its tracking day. */
  askFrom?: Day
  /** Read even a copy recent enough for `through`: a Refresh, where a request asks only for what is missing. */
  refresh?: boolean
  /** Read every copy again from its tracking day: Full refresh. */
  full?: boolean
  /** Who reads, for the copies' refresh claims. */
  holder: RefreshHolder
  /** How long one request may wait out refusals: `PATIENCE.interactive` in the review, `.bulk` from the options page. */
  patience: number
  /** How long the run may spend waiting out refusals in all before it stops. */
  waitBudget: number
  signal?: AbortSignal
  onProgress?: (status: ReadStatus) => void
  /**
   * A copy is the run's to read, by the ids of its lists: its claim is taken,
   * and any putting back to the tracking day (Full refresh) is written, so a
   * run stopped after this and started again needn't put it back again.
   */
  onReady?: (listIds: string[]) => void
}

export interface UpdateOutcome {
  /** The archive was still refusing when the waiting budget ran out; the copies not yet done are as their last page left them. */
  blocked: boolean
  /** Lists whose copy was given up on for this run, by id: three request errors, signed out, or an address that isn't a page on the archive. */
  failed: string[]
  /** Lists whose copy was left to another page reading it, or that another page asked to stop, by id. */
  elsewhere: string[]
  requests: number
}

/** One copy as the run holds it. `listId` is its key, for {@link nextRead}. */
interface CopyState extends PassState<DatedCopy> {
  key: string
  /** The tracked lists sharing it, in the order the reader lists them. */
  lists: TrackedList[]
  /** The list whose address it is read from: one marked `scan`, when any is. */
  reader: TrackedList
  /** The tags all its lists exclude, left out of every page it asks for. */
  exclude: string[]
  scanned: boolean
  copy: StoredList
  /** Whether it was stored when the run took its claim, or has been written since: one that vanishes was reset. */
  stored: boolean
  /** Its refresh claim, while the run holds it. */
  hold?: Hold
  /** The claim was taken and let go: lost to another page, cancelled, or released once the copy was done. */
  over?: boolean
  /** How its claim is let go. */
  outcome: RefreshOutcome
}

/** Whether a list is read whole rather than by date. */
export function isScanned(list: TrackedList): boolean {
  return list.kind === 'series-works' || (list.kind === 'tag-works' && !!list.scan)
}

/** Where a list's works sit on the page it is read from. */
export function blurbSelectorFor(list: TrackedList): string {
  if (list.kind === 'series-works')
    return SERIES_BLURB_SELECTOR
  // Only a tag read by scanning is read off the tag's own page, which lists
  // bookmarks below the works in a second list of the same shape; one read
  // through a search by the tag's name is an ordinary works search.
  if (list.kind === 'tag-works' && list.scan)
    return TAG_BLURB_SELECTOR
  return DEFAULT_BLURB_SELECTOR
}

/** How a tracked list's copy is fetched again from elsewhere: its descriptor, as a copy first kept for it carries. */
export function copyDescriptor(list: TrackedList): SnapshotDescriptor {
  const blurbSelector = BLURB_SELECTORS[list.kind]
  return {
    sourceId: list.kind,
    label: copyLabel(list),
    listUrl: getArchiveLink(list.url),
    ...(blurbSelector ? { blurbSelector } : {}),
  }
}

/** Abort the way the listing scrape does, so a caller can tell the two apart from nothing. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException('Tracked lists read aborted', 'AbortError')
}

/**
 * Whether the archive answered as though nobody were signed in. A session that
 * has lapsed returns a shorter list (works only visible to registered users are
 * missing from it) that looks exactly like a real one, and a copy settled off
 * the back of it would lose them for good. Only an explicit `logged-out`
 * counts.
 */
export function signedOut(doc: Document): boolean {
  return doc.body?.classList.contains('logged-out') ?? false
}

/** The tracked lists of `entries` grouped by the copy they share, in the order their first list comes; lists with no copy key apart. */
function byCopy(entries: readonly TrackedList[]): { groups: Map<string, TrackedList[]>, keyless: TrackedList[] } {
  const groups = new Map<string, TrackedList[]>()
  const keyless: TrackedList[] = []
  for (const list of entries) {
    if (!list.tracked)
      continue
    const key = copyKeyOf(list)
    if (key === null)
      keyless.push(list)
    else
      groups.set(key, [...groups.get(key) ?? [], list])
  }
  return { groups, keyless }
}

/**
 * Bring tracked lists' copies up to date through `through`, and say how it
 * went.
 *
 * A copy settled far enough already isn't read (unless it is a Refresh). A copy
 * fails for the run on its third request error, on a page that says nobody is
 * signed in, or when its address isn't a page on the archive: it keeps every
 * page it had, and says why it failed until a page lands. A rate limit is sat
 * out once for everybody and the same request made again, within the request's
 * patience and the run's waiting budget; past those the run stops, `blocked`.
 *
 * Throws an `AbortError` when `signal` aborts.
 */
export async function updateTrackedCopies(opts: UpdateOptions): Promise<UpdateOutcome> {
  const { signal } = opts
  const today = utcToday()
  const { groups, keyless } = byCopy(opts.entries)
  const wanted = opts.only && new Set(opts.only)
  const ask = { askFrom: opts.askFrom, full: opts.full }
  const readAnyway = !!(opts.full || opts.refresh)
  const stored = await readStoredLists()

  /** `key`'s copy ready to be read for `lists`: the one stored, or a new one with nothing in it yet. */
  const prepare = (key: string, lists: TrackedList[], reader: TrackedList, had: StoredList | undefined): StoredList =>
    datedFor(had ?? { v: LIST_VERSION, scrapedAt: 0, ids: '', descriptor: copyDescriptor(reader) }, lists, today, ask)

  const states: CopyState[] = []
  for (const [key, lists] of groups) {
    if (wanted && !lists.some(list => wanted.has(list.id)))
      continue
    const reader = lists.find(list => list.scan) ?? lists[0]!
    const copy = prepare(key, lists, reader, stored[key])
    const read = readAnyway || copyWanted(copy, lists, opts.through, today)
    states.push({ listId: key, key, lists, reader, exclude: sharedExclusions(lists), scanned: isScanned(reader), copy, record: copy.dated!, stored: !!stored[key], done: !read, outcome: 'written' })
  }
  const unkeyed = keyless.filter(list => !wanted || wanted.has(list.id))

  const byList = new Map<string, ListRead>()
  for (const state of states) {
    for (const list of state.lists)
      byList.set(list.id, { name: sourceLabel(list), phase: state.done ? 'done' : 'queued', page: 0, of: 0 })
  }
  for (const list of unkeyed)
    byList.set(list.id, { name: sourceLabel(list), phase: 'failed', page: 0, of: 0, failure: 'not-archive' })
  /** Move a copy's lists on: what a retry said goes unless it is said again. */
  const mark = (state: CopyState, fields: Partial<ListRead>): void => {
    for (const list of state.lists) {
      const { attempt: _attempt, error: _error, ...rest } = byList.get(list.id)!
      byList.set(list.id, { ...rest, ...fields })
    }
  }

  const failed: string[] = unkeyed.map(list => list.id)
  const elsewhere: string[] = []
  const attempts = new Map<string, number>()
  let requests = 0
  let waited = 0
  let refusedRounds = 0
  let blocked = false
  let reading: string | null = null
  let waitUntil = 0

  const report = (): void => {
    opts.onProgress?.({ listsDone: [...byList.values()].filter(read => read.phase === 'done' || read.phase === 'failed').length, lists: byList.size, reading, waitUntil, requests, byList: Object.fromEntries(byList) })
  }
  const unwatch = onArchiveWait((until) => {
    waitUntil = until
    report()
  })

  /** Nothing more for `state` this run: its claim is let go at once, so a page wanting the copy needn't wait for the rest of the run. */
  const finish = async (state: CopyState, fields: Partial<ListRead> = { phase: 'done' }): Promise<void> => {
    state.done = true
    mark(state, fields)
    const hold = state.hold
    state.hold = undefined
    if (hold) {
      state.over = true
      await hold.release(state.outcome).catch(() => {})
    }
  }

  /**
   * Write `state`'s copy as `next` makes it from the copy stored now
   * ({@link pageBase}), for a page of a pass from `passFrom` (null to note a
   * failure). Nothing is written, and the copy is done for the run, once its
   * claim was lost or cancelled, or when what is stored no longer takes the
   * page: reset, or read afresh by another page.
   */
  const write = async (state: CopyState, next: (copy: StoredList) => StoredList, passFrom: Day | null): Promise<boolean> => {
    const written = !state.over && !state.hold?.cancelled
      ? await writeStoredList(state.key, (current) => {
          const base = pageBase(current, state.copy, state.lists, today, passFrom, state.stored)
          return base && next(base)
        })
      : null
    if (!written) {
      await finish(state)
      return false
    }
    state.stored = true
    state.copy = written
    state.record = written.dated!
    return true
  }

  const giveUp = async (state: CopyState, reason: ListReadFailure, error?: string): Promise<void> => {
    state.outcome = 'failed'
    failed.push(...state.lists.map(list => list.id))
    const failure: CopyFailure = error === undefined ? { reason, at: Date.now() } : { reason, error, at: Date.now() }
    await write(state, copy => ({ ...copy, dated: { ...copy.dated!, failed: failure } }), null)
    await finish(state, error === undefined ? { phase: 'failed', failure: reason } : { phase: 'failed', failure: reason, error })
  }

  /**
   * Take `state`'s refresh claim, and read its copy again now it is the run's
   * alone: another page may have read it since the run began. False when the
   * copy isn't the run's to read — another page is reading it, and its writes
   * reach whoever is watching — or no longer wants reading.
   */
  const claim = async (state: CopyState): Promise<boolean> => {
    if (state.hold)
      return true
    const acquired = await acquireRefresh(state.key, {
      holder: opts.holder,
      onCancel: () => {
        state.outcome = 'cancelled'
        elsewhere.push(...state.lists.map(list => list.id))
        void finish(state, { phase: 'queued' })
      },
      onLost: () => {
        state.hold = undefined
        state.over = true
        void finish(state)
      },
    })
    if (acquired.kind === 'follow') {
      elsewhere.push(...state.lists.map(list => list.id))
      // Not read here, so not done: another page is reading it.
      await finish(state, { phase: 'queued' })
      return false
    }
    state.hold = acquired.hold
    const had = (await readStoredLists())[state.key]
    const copy = prepare(state.key, state.lists, state.reader, had)
    state.stored = !!had
    state.copy = copy
    state.record = copy.dated!
    if (!readAnyway && !copyWanted(copy, state.lists, opts.through, today)) {
      await finish(state)
      return false
    }
    // A copy put back to its tracking day, or given its dated part, is written
    // so at once: the review sees those days as being read, and every page
    // after merges into it.
    if (had && copy !== had && !await write(state, () => copy, null))
      return false
    opts.onReady?.(state.lists.map(list => list.id))
    return true
  }

  const get = async (url: string): Promise<Document> => {
    requests++
    report()
    return fetchPageDoc(getArchiveLink(url), signal, opts.patience)
  }

  try {
    // A copy whose address isn't a page on the archive any more — one that
    // arrived through sync, or was edited by hand — can't be read at all.
    for (const state of states) {
      if (!state.done && pageUrl(state.reader, state.record.from, 1) === null)
        await giveUp(state, 'not-archive')
    }
    report()

    for (;;) {
      throwIfAborted(signal)
      const next = nextRead(states, today)
      if (!next)
        break
      const state = states.find(candidate => candidate.key === next.listId)!
      if (!await claim(state))
        continue
      // The copy may have been read since the run began: the next page is the
      // one its stored copy asks for.
      const want = state.pass ? next : nextRead([state], today)!
      const key = `${want.listId}\u0000${want.from}\u0000${want.page}`
      reading = ((wanted && state.lists.find(list => wanted.has(list.id))) || state.lists[0]!).id
      mark(state, { phase: 'reading', page: want.page - 1 })
      try {
        const read = await readPage({ list: state.reader, exclude: state.exclude, scanned: state.scanned }, want, get)
        reading = null
        if (!read) {
          await giveUp(state, 'signed-out')
          continue
        }
        refusedRounds = 0
        const at = Date.now()
        const merge = (copy: StoredList): StoredList => mergeDatedPage(copy, read.page, { readDay: utcToday(), scanned: state.scanned, at })
        // Blurbs first, copy second, so a copy never names a blurb that isn't
        // there; and only the blurbs of works the copy keeps.
        const kept = new Set(unpackRows(merge(state.copy).dated!.rows).map(row => row.sid))
        await storeWorks(read.works.filter(work => kept.has(toShortId(work.workId)!)))
        if (!await write(state, merge, want.from))
          continue
        state.pass = { from: want.from, page: want.page }
        state.hold?.progress(want.page, read.of)
        attempts.delete(key)
        const of = read.of || byList.get(state.lists[0]!.id)!.of
        if (read.page.reachedEnd || state.record.through >= opts.through)
          await finish(state, { phase: 'done', page: want.page, of })
        else
          mark(state, { phase: 'queued', page: want.page, of })
      }
      catch (err) {
        reading = null
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
        const error = err instanceof Error ? err.message : String(err)
        if (tries >= MAX_REQUEST_ATTEMPTS) {
          await giveUp(state, 'request', error)
        }
        else {
          mark(state, { phase: 'retrying', attempt: tries, error })
          report()
        }
      }
    }
  }
  finally {
    unwatch()
    reading = null
    waitUntil = 0
    for (const state of states) {
      if (state.done)
        continue
      state.outcome = blocked ? 'blocked' : signal?.aborted ? 'cancelled' : state.outcome
      await finish(state, { phase: 'queued' })
    }
    report()
  }
  return { blocked, failed, elsewhere, requests }
}

/**
 * Read the page `next` names, and hand back its works and what it says. Null
 * when the archive answered as though nobody were signed in. Throws for a page
 * with no listing on it at all — neither a work nor a heading count — which is
 * an error page served as a page, and no evidence the query has ended.
 *
 * A **scanned** copy is read whole instead, as one page that reaches the end:
 * every page up to the cap, and past the cap the last few, since a series
 * appends. Nothing is handed back until all of them have landed, so a refusal
 * partway leaves the copy as it was rather than half-read.
 */
export async function readPage(
  state: { list: TrackedList, exclude: string[], scanned: boolean },
  next: NextRead,
  get: (url: string) => Promise<Document>,
): Promise<{ works: Work[], page: PageRead, of: number } | null> {
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
  let of = 0
  if (!state.scanned) {
    const count = detectResultCount(first)
    if (count === null && listed === 0)
      throw new Error(`No listing on the page: ${urlFor(next.page)}`)
    reachedEnd = listed < PAGE_SIZE || (count !== null && next.page * PAGE_SIZE >= count)
    if (count !== null)
      of = Math.max(next.page, Math.ceil(count / PAGE_SIZE))
  }
  return { works, page: { from: next.from, page: next.page, rows, reachedEnd }, of }
}

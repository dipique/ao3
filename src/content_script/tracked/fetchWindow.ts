import type { Day, ListProgress, MergedWork, Options, PlannedWindow, TrackedList } from '#common'
import type { Work } from '#content_script/blurb.js'
import type { FilterState } from '#content_script/searchView/engine.ts'

import { canonicalFilter, dayOf, getArchiveLink, listBase, mergeItems, PAGE_SIZE, pageUrl, planWindow, sourceLabel, toShortId } from '#common'
import { archiveWaitRemaining, onArchiveWait, PATIENCE, WAIT_BUDGET, waitForArchive } from '#content_script/archiveFetch.js'
import { matches } from '#content_script/searchView/engine.ts'
import { applyHidden } from '#content_script/searchView/hidden.ts'
import { collectWorks, DEFAULT_BLURB_SELECTOR, detectPageCount, detectResultCount, fetchPageDoc, isArchiveBusy } from '#content_script/searchView/scrape.ts'
import { TAG_BLURB_SELECTOR } from '#content_script/tagPage.ts'
import { excludedTagNames, filterStateOf } from '#content_script/tracked/viewFilter.ts'

/**
 * Reading a review window out of the archive: the loop that runs the tracked
 * lists' planner ({@link file://../../common/trackedLists.ts}) against real
 * pages until a window settles, and hands back the works it holds.
 *
 * **It only ever reads the window.** Every tracked list is asked for its works
 * oldest first from one day before the window starts, a page at a time, and the
 * planner is asked after each page whether it has enough. A reader three months
 * behind pays what a reader one day behind pays, because nothing past the
 * window's end is ever fetched on purpose — which is the whole argument for
 * gathering a review this way rather than keeping a backlog.
 *
 * Three things make that cheap enough to be worth it:
 *
 * - **The heading count.** Every listing page says how many works its query
 *   matched, and the archive's date bounds are inclusive whole UTC days
 *   ({@link detectResultCount}). So one page-1 request at `date_from = X` says
 *   exactly how far into a list's query day X begins — a *boundary* — which
 *   usually confirms the window's last day without reading another page of it.
 * - **A margin of one day on each side.** A blurb's printed date can be a day
 *   either side of the day the archive filed the work under, so each list's
 *   query starts a day early ({@link listBase}) and a window ending on day E is
 *   only settled once everything filed up to E + 1 has been read. Together those
 *   make a reviewed range airtight for any drift of one day.
 * - **Nothing is fetched twice.** A {@link TrackedSession} holds the pages
 *   already read, so moving the window's end by a day re-plans over what is
 *   already in hand and usually asks the archive for nothing at all.
 *
 * Requests go out **one at a time**, through {@link fetchPageDoc} at interactive
 * patience: the planner decides what is needed next, so a pool could only fetch
 * pages it has already ruled out. Rate limits are the archive's answer to
 * everyone rather than news about one page, so a refusal is sat out once and the
 * same request is made again ({@link file://../archiveFetch.ts}).
 */

/**
 * Pages of a scanned list read in one go. A series is short and lists its works
 * in series order, which no date bound touches, so it is read whole — and past
 * this many pages, only the last few, since new parts are appended to the end.
 */
const SCAN_PAGE_CAP = 5

/** How often one request may fail on its own account before its list is written off. */
const MAX_REQUEST_ATTEMPTS = 3

/**
 * How often the archive may call the run off before it stops coming back,
 * however much of its waiting budget is left. A short `Retry-After` spends none
 * of the budget, so without a count a run refused a page at a time could go
 * round for ever having never actually waited.
 */
const MAX_REFUSED_ROUNDS = 6

/**
 * A backstop on the plan-read-plan loop. Every plan moves the list it names on,
 * so a window settles in the requests it needs and no more; this is only here so
 * that a planner that stopped being true to that would end the run rather than
 * hold the archive for ever.
 */
const MAX_STEPS = 2000

/** A series lists its works in a `ul`, unlike every other listing on the archive. */
const SERIES_BLURB_SELECTOR = 'ul.series.work.index.group > li.blurb'

/** What {@link fetchWindow} is asked for. */
export interface FetchWindowOptions {
  /**
   * The lists to read — the reader's **tracked** ones. Paused entries are the
   * caller's to leave out, exactly as they are for `reviewStart`, so that what
   * this reads and what the window's start was worked out from can't disagree.
   */
  lists: readonly TrackedList[]
  /** The window's first day (`reviewStart`). */
  start: Day
  /** The current UTC day (`utcToday`). Never part of a reviewable window. */
  today: Day
  /** How many works the window aims for (`options.trackedLists.target`). */
  target: number
  /**
   * The reader moved the window's end by hand (the toolbar's ± day): plan
   * exactly `[start, endOverride]` rather than sizing to the target.
   */
  endOverride?: Day
  /**
   * **Archive work ids** the reader has already dealt with — marked read, or
   * saved for later. Those works count as reviewed: they don't count toward the
   * target, and they are left out of what comes back altogether. They still
   * occupy their place in each list's query while the window is being worked
   * out, because the positions are what the boundary arithmetic compares.
   *
   * Taken once, by the caller, for the whole of one open: a work marked *during*
   * a review shouldn't vanish from under the reader.
   */
  reviewed: ReadonlySet<string>
  /** The reader's options — the rules that hide works, and the per-day ceiling. */
  options: Options
  /** Aborted when the view is closed, replaced, or asked to load again. */
  signal?: AbortSignal
  /**
   * Say what is being read and how far it has got. `done` counts requests made;
   * `total` is 0 throughout, because how many a window needs isn't known until
   * it settles. Archive pauses are reported here too, so a run that has gone
   * quiet for two minutes can say why rather than looking like it has hung.
   */
  onProgress?: (text: string, done: number, total: number) => void
  /**
   * Pages already read, kept between calls (see {@link TrackedSession}). Without
   * one, every call starts from nothing.
   */
  session?: TrackedSession
}

/** A day whose works were cut off at the per-day ceiling. */
export interface CappedDay {
  day: Day
  /** How many works the day holds. */
  count: number
  /** How many of them came back — `options.searchMaxResults`. */
  shown: number
  /** The lists whose works landed on that day, for naming who filled it. */
  lists: string[]
}

/** What {@link fetchWindow} comes back with. */
export interface FetchedWindow {
  /**
   * The settled window, straight from the planner: its range, whether it may be
   * marked reviewed, and what one more day would add. Its `count` and `days` are
   * what the lists hold; {@link FetchedWindow.days} is what is being shown,
   * which is lower on a day the ceiling cut off.
   */
  window: PlannedWindow
  /**
   * The window's works in review order — oldest day first, and within a day the
   * order the first list to turn a work up listed it in. Already-reviewed works
   * are not here, and nor is a work that every list to turn it up has a view
   * filter rejecting. Works the rules hide are, stamped `hidden`/`filtered`,
   * because whether a rule still hides one is the view's question at the moment
   * it draws it, not this one's.
   *
   * `markedOrder` is stamped with that order, which is what the view's "Review
   * order" sort shows.
   */
  works: Work[]
  /** Short work id → the ids of the lists that turned it up: the List source facet's values. */
  sources: Map<string, string[]>
  /** Counting works shown per day, one entry for every day of the window, empty days included. */
  days: Map<Day, number>
  /** Ids of lists that couldn't be read. Their works are missing, so the window isn't reviewable. */
  failed: string[]
  /** Days cut off at `options.searchMaxResults`, if any. */
  capped: CappedDay[]
  /**
   * Roughly how many works the tracked lists hold between the window's start and
   * today that this window doesn't — the toolbar's "about N more to review".
   * Free, because it's what each list's page 1 already said its query matched.
   * An upper bound: two lists that overlap count the same work twice, and works
   * the reader's rules hide are in it, as are works a list's view filter rejects
   * that the archive couldn't leave out for it.
   */
  backlog: number
  /**
   * The archive was still refusing when the run's waiting budget ran out, so
   * this is not an answer about what the lists hold. The caller keeps whatever
   * it had rather than writing this over it.
   */
  blocked: boolean
  /** Requests made. Every page and every boundary, retries included. */
  requests: number
}

/**
 * Pages already read, so that a second look at the same window costs nothing.
 *
 * Moving the window's end by a day re-plans over exactly the works the last plan
 * read, and a list read to its end stays read. What is held is each list's
 * progress — its rows, its heading count, the boundaries it has learned — which
 * is only meaningful for the window start it was read for, since a list's query
 * begins a day before that start. So the whole session is dropped the moment the
 * start or the set of lists moves, and the next window is read fresh. That is
 * also the right answer rather than a shortcut: a new window is a later range,
 * and a scanned series may have gained a part since.
 */
export interface TrackedSession {
  /** What the held progress was read for. Anything else and it's dropped. */
  sig: string
  lists: Map<string, ListState>
  /** Every work read, by short id — one object per work, however many lists hold it. */
  works: Map<string, Work>
}

/** One list as it is being read. */
interface ListState {
  entry: TrackedList
  progress: ListProgress
  /**
   * The list's view filter ({@link TrackedList.filter}) as the search view's own,
   * built once per call — or null when it has none, and wants every work its
   * query returns.
   */
  wants: FilterState | null
  /** The tag names its view filter excludes, which every page it reads asks the archive to leave out. */
  exclude: string[]
}

/** An empty session, for a caller that means to keep one across calls. */
export function createTrackedSession(): TrackedSession {
  return { sig: '', lists: new Map(), works: new Map() }
}

/**
 * What a session's held progress is only true for: the window's start, and every
 * list's identity, address, view filter, tracking date and reading mode.
 *
 * The filter because it decides both what is asked for (the tag names it
 * excludes go to the archive) and which of the rows read the list wants. A list
 * re-filtered between two calls would otherwise keep rows from a query it no
 * longer asks, judged by a filter it no longer has.
 */
function sessionSig(lists: readonly TrackedList[], start: Day): string {
  return [start, ...lists.map(list => [
    list.id,
    list.kind,
    list.url,
    JSON.stringify(canonicalFilter(list.filter) ?? null),
    list.since,
    list.scan ? 1 : 0,
  ].join('\u0000'))].join('\u0001')
}

/** `2:05`, or `9s` under a minute. */
function countdown(ms: number): string {
  const total = Math.ceil(ms / 1000)
  const seconds = total % 60
  return total >= 60 ? `${Math.floor(total / 60)}:${String(seconds).padStart(2, '0')}` : `${seconds}s`
}

/** Where a list's works sit on the page it is read from. */
function blurbSelectorFor(entry: TrackedList): string {
  if (entry.kind === 'series-works')
    return SERIES_BLURB_SELECTOR
  // Only a tag read by scanning is read off the tag's own page, which lists
  // bookmarks below the works in a second list of the same shape; one read
  // through a search by the tag's name is an ordinary works search.
  if (entry.kind === 'tag-works' && entry.scan)
    return TAG_BLURB_SELECTOR
  return DEFAULT_BLURB_SELECTOR
}

/** Whether a list is read whole rather than by date. */
function isScanned(entry: TrackedList): boolean {
  return entry.kind === 'series-works' || (entry.kind === 'tag-works' && !!entry.scan)
}

/**
 * Gather the review window: plan, read the page the plan names, mark every work
 * on it, and plan again until the window settles.
 *
 * A work **counts** toward the target unless the reader has already dealt with
 * it (marked read, or saved for later) or their rules take it out of the listing
 * — the same {@link applyHidden} pass the search view's host runs, so "hidden"
 * means one thing in both places. A work that doesn't count still holds its
 * place in its list's query, because the boundary arithmetic counts positions.
 *
 * A list with a **view filter** — what the reader had narrowed a custom search
 * to when they tracked it — only wants the works that filter passes, tested with
 * the search view's own `matches`, so the list tracks exactly what the view
 * showed. A work it rejects isn't one of its works at all: it doesn't count for
 * it, isn't named as coming from it, and is left out unless another list wants
 * it (`ListItem.member`). It still holds its place in the list's rows, like
 * every other row. The tag names the filter excludes are also sent with every
 * page the list reads ({@link excludedTagNames}), so the archive can leave those
 * works out before they cost a page; the filter is applied here all the same,
 * which costs nothing and keeps the review right if the archive ever ignores a
 * name.
 *
 * A list that can't be read is written off and the window is computed from the
 * rest; it comes back in {@link FetchedWindow.failed}, and the window isn't
 * reviewable while one is there, since marking a range reviewed whose works were
 * never shown is the one way this can lose a work.
 */
export async function fetchWindow(opts: FetchWindowOptions): Promise<FetchedWindow> {
  const { lists, start, today, target, endOverride, reviewed, options, signal } = opts
  const session = opts.session ?? createTrackedSession()
  const startedAt = Date.now()
  const ceiling = Math.max(1, options.searchMaxResults)

  const sig = sessionSig(lists, start)
  if (session.sig !== sig) {
    session.sig = sig
    session.lists.clear()
    session.works.clear()
  }
  const states = lists.map(entry => stateFor(session, entry, start))
  const progress = states.map(state => state.progress)

  let requests = 0
  let blocked = false
  /** Time actually spent standing still, which is the only thing the budget bounds. */
  let waited = 0
  let refusedRounds = 0
  const attempts = new Map<string, number>()
  /** Works a page brought whose hide verdict hasn't been taken yet. */
  let fresh: Work[] = []
  // The first pass always runs: a session read a minute ago holds verdicts taken
  // against the options as they were then, and a rule may have changed since.
  let recount = true

  let progressText = 'Reading your tracked lists…'
  let waitUntil = 0
  let waitText = ''
  const report = (): void => {
    const left = Math.max(0, waitUntil - Date.now())
    opts.onProgress?.(left > 0 ? `${waitText} — trying again in ${countdown(left)}` : progressText, requests, 0)
  }
  // One subscription rather than one per request: a pause is held for every
  // caller at once, so it is one thing happening, and saying it once is right.
  const unwatch = onArchiveWait((until, reason) => {
    waitUntil = until
    waitText = reason === 'refused' ? 'AO3 asked us to slow down' : 'Giving AO3 a moment'
    report()
  })

  /** One request, counted and abortable. */
  const get = async (url: string): Promise<Document> => {
    requests++
    report()
    return fetchPageDoc(getArchiveLink(url), signal, PATIENCE.interactive)
  }

  let settled: PlannedWindow | undefined
  try {
    for (let step = 0; !settled; step++) {
      throwIfAborted(signal)
      if (fresh.length) {
        // The verdict is per work, so taking it a page at a time says the same
        // as one pass over everything read so far would. (`applyHidden` splits a
        // hidden work's reason between `hidden` and `filtered` depending on what
        // the *whole* set carries, but a work is out of the results either way,
        // and out of the results is all counting asks.) The set that comes back
        // is stamped once more below, so what the caller gets is coherent.
        applyHidden(fresh, options)
        fresh = []
        recount = true
      }
      if (recount) {
        markCounts(states, session, reviewed)
        recount = false
      }
      // Every plan moves some list on, so the loop ends on its own. This is the
      // stop for a planner that ever stopped being true to that: give up on
      // whatever is unfinished, which leaves it nothing left to ask for.
      if (step >= MAX_STEPS)
        markAllUnfinishedFailed(progress)

      const plan = planWindow(progress, { start, today, target, endOverride })
      if ('window' in plan) {
        settled = plan.window
        break
      }

      const id = 'fetch' in plan ? plan.fetch : plan.boundary
      const state = states.find(candidate => candidate.entry.id === id)
      // The planner only ever names a list it was given, so this can't happen —
      // but a run that asked for nothing would never end, which is worse.
      if (!state) {
        markAllUnfinishedFailed(progress)
        continue
      }
      const key = 'fetch' in plan ? `${id}\u0000p${plan.page}` : `${id}\u0000b${plan.day}`
      progressText = `Reading ${sourceLabel(state.entry, lists)}…`

      try {
        if ('boundary' in plan)
          await readBoundary(state, plan.day, get)
        else
          await readPage(state, plan.page, get, session, startedAt, fresh)
        attempts.delete(key)
      }
      catch (err) {
        if (signal?.aborted || (err as Error)?.name === 'AbortError')
          throw err
        if (isArchiveBusy(err)) {
          // Looked at before committing to it: a blind refusal can run to the
          // hour, and a budget only checked afterwards is one already blown.
          const remaining = archiveWaitRemaining()
          if (++refusedRounds > MAX_REFUSED_ROUNDS || waited + remaining > WAIT_BUDGET.interactive) {
            blocked = true
            markAllUnfinishedFailed(progress)
            continue
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
          state.progress.failed = true
        continue
      }
    }
  }
  finally {
    unwatch()
  }

  return assemble({
    states,
    settled: settled!,
    session,
    start,
    today,
    reviewed,
    options,
    ceiling,
    blocked,
    requests,
  })
}

/** The held progress for one list, or a fresh one — either way with its filter read afresh for this call. */
function stateFor(session: TrackedSession, entry: TrackedList, start: Day): ListState {
  const wants = filterStateOf(entry.filter)
  const exclude = excludedTagNames(entry.filter)
  const held = session.lists.get(entry.id)
  if (held) {
    Object.assign(held, { entry, wants, exclude })
    return held
  }
  const scanned = isScanned(entry)
  const state: ListState = {
    entry,
    wants,
    exclude,
    progress: {
      id: entry.id,
      base: listBase(entry, start),
      items: [],
      total: 0,
      bounds: new Map<Day, number>(),
      exhausted: false,
      // An entry whose address isn't a page on the archive any more — one that
      // arrived through sync, or was edited by hand — can't be read at all, and
      // saying so now beats discovering it a request at a time.
      failed: pageUrl(entry, listBase(entry, start), 1) === null,
      ...(scanned ? { scanned: true } : {}),
    },
  }
  session.lists.set(entry.id, state)
  return state
}

/** Abort the way the listing scrape does, so a caller can tell the two apart from nothing. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException('Tracked review fetch aborted', 'AbortError')
}

/**
 * Give up on every list that hasn't finished. Used when the archive stops
 * answering at all: the window is still worked out and shown from whatever did
 * land, but nothing that has a list missing from it can be marked reviewed.
 */
function markAllUnfinishedFailed(progress: readonly ListProgress[]): void {
  for (const list of progress) {
    if (!list.exhausted)
      list.failed = true
  }
}

/**
 * Read one page of a list's query and add its works to the list's rows.
 *
 * A **scanned** list is read whole on its first page instead: every page up to
 * the cap, and past the cap the last few, since a series appends. It is then
 * exhausted, so it is never read again for this window. Nothing is committed
 * until all of its pages have landed, so a refusal partway leaves the list as it
 * was rather than half-read.
 */
async function readPage(
  state: ListState,
  page: number,
  get: (url: string) => Promise<Document>,
  session: TrackedSession,
  seenAt: number,
  fresh: Work[],
): Promise<void> {
  const { entry, progress } = state
  const selector = blurbSelectorFor(entry)
  const docs: Document[] = []

  if (progress.scanned) {
    const first = await get(urlFor(state, progress.base, 1))
    if (signedOut(first)) {
      progress.failed = true
      return
    }
    const pages = Math.max(1, detectPageCount(first))
    docs.push(first)
    // Page 1 is already paid for, so its works are kept whichever end of the
    // list they came from; `assignDay` drops the old ones either way.
    const from = pages <= SCAN_PAGE_CAP ? 2 : pages - SCAN_PAGE_CAP + 1
    for (let p = Math.max(2, from); p <= pages; p++)
      docs.push(await get(urlFor(state, progress.base, p)))
  }
  else {
    const doc = await get(urlFor(state, progress.base, page))
    if (page === 1 && signedOut(doc)) {
      progress.failed = true
      return
    }
    docs.push(doc)
  }

  let added = 0
  for (const doc of docs) {
    // One document at a time: a work read twice because it was updated between
    // two pages has to stay in the rows twice, since the rows are compared by
    // position, and `collectWorks` drops a repeat within one call.
    const works = collectWorks([doc], selector, seenAt)
    added += works.length
    for (const work of works) {
      const sid = work.workId ? toShortId(work.workId) : null
      if (!sid) {
        // A row that isn't a work still holds its place: everything after it in
        // the query sits one further on than it would otherwise look.
        progress.items.push({ sid: `\u0000${entry.id}:${progress.items.length}`, day: Number.NaN, counts: false })
        continue
      }
      // One object per work, however many lists or pages turn it up. The first
      // copy read is the one kept, so a work that moved between two pages of the
      // same query doesn't come back as two different works.
      const held = session.works.get(sid) ?? work
      if (held === work)
        session.works.set(sid, work)
      fresh.push(held)
      progress.items.push({ sid, day: dayOf(held.dateText) ?? Number.NaN, counts: false })
    }
  }

  if (progress.scanned) {
    progress.total = progress.items.length
    progress.exhausted = true
    return
  }

  const count = detectResultCount(docs[0]!)
  if (count !== null)
    progress.total = count
  else
    // No heading to read. A total below the rows already read would be taken for
    // the end of the list, so it is put just out of reach until a short page —
    // the other way the end is known — actually arrives.
    progress.total = Math.max(progress.total, progress.items.length + (added < PAGE_SIZE ? 0 : PAGE_SIZE))
  if (added < PAGE_SIZE || (count !== null && progress.items.length >= count))
    progress.exhausted = true
}

/**
 * Ask where a day begins in a list's query: page 1 of the same query bounded at
 * that day instead, whose heading count is how many works the query has from
 * there on. What is left — the total less that count — is how many come before
 * it, which is the position the planner compares its rows against.
 *
 * The works on that page are deliberately thrown away. The rows have to stay a
 * contiguous prefix of the query for the positions to mean anything, and these
 * are from the far side of it.
 */
async function readBoundary(state: ListState, day: Day, get: (url: string) => Promise<Document>): Promise<void> {
  const { progress } = state
  // A page with no heading at all is read as "nothing from this day on", which
  // puts the boundary past everything read and asks for another page instead —
  // the conservative answer, and the true one when the day really is empty.
  const from = detectResultCount(await get(urlFor(state, day, 1))) ?? 0
  progress.bounds.set(day, Math.max(0, progress.total - from))
}

/**
 * A list's page, asking the archive to leave out the tags its view filter
 * excludes. Throws for an entry that can't be read, which `stateFor` has already
 * failed.
 */
function urlFor(state: ListState, from: Day, page: number): string {
  const url = pageUrl(state.entry, from, page, { exclude: state.exclude })
  if (!url)
    throw new Error(`Not a page on the archive: ${state.entry.url}`)
  return url
}

/**
 * Whether the archive answered as though nobody were signed in. A review is read
 * from the reader's own readings page, so this shouldn't happen — but a session
 * that has lapsed would otherwise return a shorter list (works only visible to
 * registered users are missing from it) that looks exactly like a real one, and
 * a range marked reviewed off the back of it would lose them for good.
 *
 * Only an explicit `logged-out` counts. A page that says neither is taken at
 * face value rather than written off on the strength of a missing class.
 */
function signedOut(doc: Document): boolean {
  return doc.body?.classList.contains('logged-out') ?? false
}

/**
 * Say which rows each list wants, and which of those count toward the target,
 * now that their works' hide verdicts have been taken. Rows are left in place
 * either way: a work that doesn't count, or that the list's view filter rejects,
 * still sits where it sits in its list's query, and the boundary arithmetic
 * counts positions.
 */
function markCounts(states: readonly ListState[], session: TrackedSession, reviewed: ReadonlySet<string>): void {
  for (const state of states) {
    const { wants } = state
    for (const item of state.progress.items) {
      const work = session.works.get(item.sid)
      // A row that isn't a work has nothing to test, and never counts anyway.
      const member = !work || !wants || matches(work, wants)
      if (member)
        delete item.member
      else
        item.member = false
      // Both stamps: a work the rules hide is either dropped outright or handed
      // to the view's own filter, and either way the reader doesn't see it.
      item.counts = member && !!work && !reviewed.has(work.workId) && !work.hidden && !work.filtered
    }
  }
}

interface AssembleOptions {
  states: readonly ListState[]
  settled: PlannedWindow
  session: TrackedSession
  start: Day
  today: Day
  reviewed: ReadonlySet<string>
  options: Options
  ceiling: number
  blocked: boolean
  requests: number
}

/**
 * Turn the settled window and the rows read into what the review shows: the
 * works in review order, which lists each came from, and how many there are a
 * day.
 *
 * The merge is the planner's own ({@link mergeItems}), so what is shown and what
 * was counted can't drift apart — a work two lists both turned up is one work
 * here as it was there, on the later of the two days if they disagree.
 */
function assemble(opts: AssembleOptions): FetchedWindow {
  const { states, settled, session, reviewed, options, ceiling } = opts
  const progress = states.map(state => state.progress)
  const merged = mergeItems(progress, { start: opts.start, today: opts.today })

  // Where each work was first seen — the lists in order, and each list's rows in
  // the order its query returned them. That is the order within a day: the order
  // the reader would have met these works in had they opened the lists
  // themselves. A counter rather than a pair, since walking it this way already
  // visits every row in exactly that order.
  const place = new Map<string, number>()
  for (const list of progress) {
    for (const item of list.items) {
      if (!place.has(item.sid))
        place.set(item.sid, place.size)
    }
  }

  const byDay = new Map<Day, [string, MergedWork][]>()
  for (const row of merged) {
    const [, work] = row
    if (work.day < settled.start || work.day > settled.end)
      continue
    const day = byDay.get(work.day)
    if (day)
      day.push(row)
    else
      byDay.set(work.day, [row])
  }

  const works: Work[] = []
  const sources = new Map<string, string[]>()
  const days = new Map<Day, number>()
  const capped: CappedDay[] = []

  for (let day = settled.start; day <= settled.end; day++) {
    const rows = (byDay.get(day) ?? [])
      .filter(([sid]) => {
        const work = session.works.get(sid)
        // Already-reviewed works never reach the view, the stored window or the
        // facet: the reader has dealt with them, and the range covers them
        // whether they are shown or not.
        return !!work && !reviewed.has(work.workId)
      })
      .sort((a, b) => (place.get(a[0]) ?? 0) - (place.get(b[0]) ?? 0))

    const shown = rows.length > ceiling ? rows.slice(0, ceiling) : rows
    if (shown.length < rows.length) {
      capped.push({
        day,
        count: rows.length,
        shown: shown.length,
        lists: [...new Set(rows.flatMap(([, work]) => work.lists))],
      })
    }

    let counting = 0
    for (const [sid, work] of shown) {
      const parsed = session.works.get(sid)!
      parsed.markedOrder = works.length
      works.push(parsed)
      sources.set(sid, work.lists)
      if (work.counts)
        counting++
    }
    days.set(day, counting)
  }

  // Once more over exactly the set going out, so that a work's `hidden` and
  // `filtered` stamps describe this list rather than the page it arrived on.
  applyHidden(works, options)

  // Each list's page-1 count is everything its query holds from the window's
  // start through today, so the sum less the window is what is still waiting. A
  // scanned list's count is its whole series and says nothing about a date
  // range, so it is left out rather than allowed to invent a backlog.
  const held = progress.reduce((sum, list) => sum + (list.failed || list.scanned ? 0 : list.total), 0)

  return {
    window: settled,
    works,
    sources,
    days,
    failed: progress.filter(list => list.failed).map(list => list.id),
    capped,
    backlog: Math.max(0, held - settled.count),
    blocked: opts.blocked,
    requests: opts.requests,
  }
}

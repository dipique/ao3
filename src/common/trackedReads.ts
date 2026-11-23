import type { StoredList } from './cache.ts'
import type { Day, TrackedList } from './trackedLists.ts'

import { claimLive } from './claim.ts'
import { copyKeyOf, listsAtCopy } from './listLinks.ts'
import { excludedTagNames, formatDay, normalizeTrackedUrl, wholeNumber } from './trackedLists.ts'
import { fromShortId, packOrderedIds, toShortId, unpackOrderedIds } from './workId.ts'

/**
 * A tracked list's offline copy, read by date: the works its query turned up,
 * by day, and how far that is known to be complete — the copy's **dated part**
 * ({@link DatedCopy}). The review's window is computed from the copies, without
 * asking the archive, and the updater that brings them up to date only ever
 * asks for what they don't yet say.
 *
 * ## How far a copy is trusted
 *
 * A copy is read by asking its query for everything filed from `through + 1`,
 * oldest first, to its end. The archive files a work under the
 * UTC day of its update, and a query from day F is everything filed on F or
 * later, so a pass that reaches its end on day R has seen everything filed
 * through R − 1. Today is never trusted: it isn't over.
 *
 * A blurb day `D` counts as complete for a copy once `through ≥ D`. A blurb's
 * printed date can be a day off its filing day, so a work updated in the first
 * hours of a UTC day and dated the day before can land on a day already
 * trusted. Trusting only through R − 2 would close that, at the price of
 * yesterday never counting as read, so a reader who is caught up would always
 * be told the review is still reading. The gap is accepted.
 *
 * This module is the decidable half: the dated part's shape and codec, merging
 * a page into a copy, which copy to read next, each list's view of the copy it
 * shares, and the window the copies make; and moving the read records an older
 * build kept onto the copies. The archive half lives with the content script.
 *
 * Imports only other pure modules of `src/common`, so it loads under a plain
 * `node --test`.
 */

/**
 * One tracked list's read record, as an older build kept it (`storage.local`
 * key `trackedRead.<listId>`), read only to move it onto the list's copy
 * ({@link planRecordMigration}).
 */
export interface TrackedRead {
  v: 1
  /**
   * What the archive was asked for this list ({@link readQuery}). A record
   * whose query no longer matches its list moves nothing onto its copy.
   */
  query: string
  /** First filing day the record covers: the later of the list's tracking day and the window's start, at its first read. */
  from: Day
  /** Every work filed on or before this day has been read. `from − 1` when nothing is yet. */
  through: Day
  /** Epoch ms of the last page written; 0 when none has been. */
  readAt: number
  /** One row per work, in first-read order: its short id and stored day ({@link packRows}). */
  rows: string
  /** Set when the last run gave up on this list; cleared by the next page that lands. */
  failed?: true
}

/**
 * What {@link applyPage} reads and writes: the works read so far, by day, and
 * how far that is settled. A record has it, and so does a tracked list's
 * offline copy ({@link DatedCopy}). A page that lands clears `failed`.
 */
export interface SettledRows {
  from: Day
  through: Day
  readAt: number
  rows: string
  failed?: unknown
}

/** Why a tracked list's last read gave up, and when. */
export interface CopyFailure {
  reason: ListReadFailure
  /** What went wrong with the last request, when a request did. */
  error?: string
  /** Epoch ms. */
  at: number
}

/**
 * A tracked list's offline copy, as far as it has been read by date: the
 * `dated` part of its stored list. Every work it names by day is one the
 * copy's `ids` name too; a copy kept before it was read by date can name
 * more, undated.
 *
 * `from`..`through` is the one stretch of days the copy is complete for, by
 * the rules {@link applyPage} applies. The day a list was read on is never in
 * it.
 */
export interface DatedCopy extends SettledRows {
  /** What the archive is asked for this copy ({@link copyQuery}). A copy whose query no longer matches its lists is read again. */
  query: string
  failed?: CopyFailure
}

/** One work of a record: its short id and the day it is reviewed on. */
export interface ReadRow {
  sid: string
  day: Day
}

/** One page of a pass, as read: the query's start, the page number, and its works' blurb days. */
export interface PageRead {
  from: Day
  page: number
  /** The page's works in the order the archive listed them. A blurb day that couldn't be read is `NaN`. */
  rows: { sid: string, blurbDay: Day }[]
  /** The page was the query's last. */
  reachedEnd: boolean
}

/** One list, or one copy, as a run of the reader stands: `listId` is whatever names it to the run. */
export interface PassState<R extends SettledRows = SettledRows> {
  listId: string
  record: R
  /** The pass under way this run: the day it reads from and the last page read. Absent before its first page. */
  pass?: { from: Day, page: number }
  /** Nothing more to read this run: a pass reached its end, or the list failed. */
  done?: boolean
}

/** The next request a run makes. */
export interface NextRead {
  listId: string
  from: Day
  page: number
}

const ROW_SEPARATOR = ','
const DAY_SEPARATOR = '.'
const RADIX = 36
const ROW_RE = /^([0-9a-z]+)\.([0-9a-z]+)$/

/**
 * Rows as stored: `sid.day` with the day in base 36, comma-separated, in row
 * order. A short id is base 36 already, so neither separator can occur in one.
 */
export function packRows(rows: readonly ReadRow[]): string {
  return rows.map(row => `${row.sid}${DAY_SEPARATOR}${row.day.toString(RADIX)}`).join(ROW_SEPARATOR)
}

/** Stored rows back, in order. A part that isn't a row is skipped. */
export function unpackRows(text: string): ReadRow[] {
  if (!text)
    return []
  const rows: ReadRow[] = []
  for (const part of text.split(ROW_SEPARATOR)) {
    const match = ROW_RE.exec(part)
    if (!match)
      continue
    const day = Number.parseInt(match[2]!, RADIX)
    if (Number.isSafeInteger(day))
      rows.push({ sid: match[1]!, day })
  }
  return rows
}

/**
 * What the archive is asked for `list`, as one string: its kind, address and
 * reading mode, and the tag names its view filter excludes — which go to the
 * archive with every page, so they change what a query returns. The rest of a
 * view filter is matched on this side, so changing it keeps the record; only
 * which of its works the list wants is worked out again.
 */
export function readQuery(list: Pick<TrackedList, 'kind' | 'url' | 'scan' | 'filter'>): string {
  return JSON.stringify([list.kind, list.url, list.scan ? 1 : 0, excludedTagNames(list.filter)])
}

/** `stored` as a record of `list`'s current query, or null when it isn't one. */
export function storedRecordOf(list: Pick<TrackedList, 'kind' | 'url' | 'scan' | 'filter'>, stored: unknown): TrackedRead | null {
  if (typeof stored !== 'object' || stored === null)
    return null
  const record = stored as Partial<TrackedRead>
  if (record.v !== 1 || record.query !== readQuery(list) || typeof record.rows !== 'string')
    return null
  const from = wholeNumber(record.from)
  const through = wholeNumber(record.through)
  if (from === null || through === null || through < from - 1 || wholeNumber(record.readAt) === null)
    return null
  return record as TrackedRead
}

/**
 * Which list and page to read next, or null when the run is done.
 *
 * Always the list read least far (the lowest `through`; the first in order on a
 * tie), so every list's earliest unknown days come in first, and the window
 * the reader is looking at fills before the ones after it. A pass under way
 * goes on from its next page on the day it started from; a list with none
 * starts one from the day after its `through`, which on a list read through
 * yesterday is today's tail. A list is passed over once its pass this run
 * reached its end, or it failed.
 */
export function nextRead(states: readonly PassState<SettledRows>[], today: Day): NextRead | null {
  let pick: PassState<SettledRows> | undefined
  for (const state of states) {
    if (!state.done && (!pick || state.record.through < pick.record.through))
      pick = state
  }
  if (!pick)
    return null
  if (pick.pass)
    return { listId: pick.listId, from: pick.pass.from, page: pick.pass.page + 1 }
  return { listId: pick.listId, from: Math.min(pick.record.through + 1, today), page: 1 }
}

/** What {@link applyPage} needs besides the page. */
export interface PageContext {
  /** The UTC day the page was read on: each page's own, so a pass across midnight trusts only the new yesterday. */
  readDay: Day
  /** Read whole rather than by date: a series, or a tag marked `scan`. */
  scanned: boolean
  /** Epoch ms the page was read, for {@link TrackedRead.readAt}. */
  at: number
}

/**
 * The day a work read on a page from `from` is stored on, or null when it
 * isn't kept.
 *
 * A blurb day before `from − 1` was set by hand: the query only returned the
 * work because it was filed on or after `from`, so it is stored on `from`.
 * `from − 1` itself is a blurb a day off its filing day, and is kept as it is.
 * A work with no readable date counts on `from`. A scanned list returns old
 * works as well as new, so there anything dated before `from`, or not dated
 * at all, is an old work and is dropped.
 */
function storedDay(blurbDay: Day, from: Day, scanned: boolean): Day | null {
  if (!Number.isFinite(blurbDay))
    return scanned ? null : from
  if (scanned)
    return blurbDay >= from ? blurbDay : null
  return blurbDay < from - 1 ? from : blurbDay
}

/**
 * Merge one page into a record, and hand back the next record.
 *
 * - **By work.** A work already in the record moves to the later of its two
 *   days: it was updated, and the later day is what it is now. A new work goes
 *   on the end.
 * - **Clamped once, here** ({@link storedDay}). Nothing is kept from before the
 *   record's own `from`. A future date is stored as read, and only clamped to
 *   today when a window is computed.
 * - **`through`** moves to yesterday once a pass reaches its end. A pass cut
 *   short trusts everything filed two days before its last dated row, since the
 *   query is sorted by filing day and a blurb day can be a day off it; never
 *   past yesterday, and never back. A scanned list isn't sorted by date at all,
 *   so a scanned pass cut short trusts nothing more.
 */
export function applyPage<T extends SettledRows>(record: T, page: PageRead, context: PageContext): T {
  const rows = unpackRows(record.rows)
  const index = new Map(rows.map((row, at) => [row.sid, at]))
  for (const { sid, blurbDay } of page.rows) {
    const day = storedDay(blurbDay, page.from, context.scanned)
    if (day === null || day < record.from)
      continue
    const at = index.get(sid)
    if (at === undefined) {
      index.set(sid, rows.length)
      rows.push({ sid, day })
    }
    else if (day > rows[at]!.day) {
      rows[at] = { sid, day }
    }
  }

  const yesterday = context.readDay - 1
  let through = record.through
  if (page.reachedEnd) {
    through = Math.max(through, yesterday)
  }
  else if (!context.scanned) {
    const last = page.rows.findLast(row => Number.isFinite(row.blurbDay))
    if (last)
      through = Math.max(through, Math.min(yesterday, last.blurbDay - 2))
  }

  const { failed: _failed, ...rest } = record
  return { ...rest, through, readAt: context.at, rows: packRows(rows) } as T
}

/** How often one request may fail on its own account before its list is given up on for the run. */
export const MAX_REQUEST_ATTEMPTS = 3

// ---------------------------------------------------------------------------
// The dated copy
//

type QueriedList = Pick<TrackedList, 'kind' | 'url' | 'scan' | 'filter'>

/**
 * What the archive is asked for the copy `lists` share, as one string: its
 * kind and address, whether it is read whole (`scan`, when any of the lists
 * asks for it), and the tag names every one of their view filters excludes —
 * which go to the archive with every page. A tag only some of them exclude is
 * read, and left to each list's own filter.
 *
 * The address is the copy's, so the lists' spelling, sort, title and tracking
 * day ask nothing different.
 */
export function copyQuery(lists: readonly QueriedList[]): string {
  const first = lists[0]
  const address = first ? normalizeTrackedUrl(first.url)?.key ?? first.url : ''
  return JSON.stringify([first?.kind ?? '', address, lists.some(list => list.scan) ? 1 : 0, sharedExclusions(lists)])
}

/** The tag names every one of `lists`' view filters excludes, sorted: what the copy they share asks the archive to leave out. */
export function sharedExclusions(lists: readonly Pick<TrackedList, 'filter'>[]): string[] {
  const [head = [], ...others] = lists.map(list => new Set(excludedTagNames(list.filter)))
  return [...head].filter(name => others.every(names => names.has(name))).sort()
}

/** `copy`'s dated part, or null when it has none, it is malformed, or it was read for another query than `lists` ask. */
export function datedOf(copy: Pick<StoredList, 'dated'> | null | undefined, lists: readonly QueriedList[]): DatedCopy | null {
  const dated = copy?.dated as Partial<DatedCopy> | undefined
  if (typeof dated !== 'object' || dated === null || dated.query !== copyQuery(lists) || typeof dated.rows !== 'string')
    return null
  const from = wholeNumber(dated.from)
  const through = wholeNumber(dated.through)
  if (from === null || through === null || through < from - 1 || wholeNumber(dated.readAt) === null)
    return null
  return dated as DatedCopy
}

/** The last day `copy` is complete through for `lists`, or null when it hasn't been read by date for them. */
export function settledThrough(copy: Pick<StoredList, 'dated'> | null | undefined, lists: readonly QueriedList[]): Day | null {
  return datedOf(copy, lists)?.through ?? null
}

/**
 * Whether `copy` wants reading for a request through `through`: it hasn't
 * been read by date for `lists`, or is settled short of `through` (or of
 * yesterday, the furthest a read can settle). Asked through today, it also
 * wants reading when it wasn't read today, since today's works are only
 * there once a read today has been. So a copy read whole — a series — is read
 * at most once a day.
 */
export function copyWanted(copy: Pick<StoredList, 'dated'> | null | undefined, lists: readonly QueriedList[], through: Day, today: Day): boolean {
  const dated = datedOf(copy, lists)
  if (!dated)
    return true
  if (dated.through < Math.min(through, today - 1))
    return true
  return through >= today && Math.floor(dated.readAt / 86_400_000) < today
}

/** The day a copy of `lists` is read from: the earliest of their tracking days, or `today` when none has one. */
function copySince(lists: readonly Pick<TrackedList, 'since'>[], today: Day): Day {
  const days = lists.map(list => wholeNumber(list.since)).filter((day): day is Day => day !== null)
  return days.length ? Math.min(...days) : today
}

/** What {@link datedFor} is asked to cover. */
export interface DatedAsk {
  /** The first day wanted. One before the copy's stretch reads it again from the tracking day. */
  askFrom?: Day
  /** Read again from the tracking day whatever the copy holds: Full refresh. */
  full?: boolean
}

/**
 * `copy` ready to be read by date for `lists`: the same copy when its dated
 * part covers what is asked, and otherwise one whose stretch starts at the
 * lists' tracking day.
 *
 * - **Undated**, kept before the copy was read by date: its works stay, and the
 *   first page read merges into them.
 * - **Another query, or malformed**: the works it read are another search's,
 *   and go with it.
 * - **Asked for days before its stretch** (from the tracking day on), **or a
 *   full refresh**: read again from the tracking day ({@link resetForFull}),
 *   its works kept, so the stretch stays one.
 */
export function datedFor(copy: StoredList, lists: readonly (QueriedList & Pick<TrackedList, 'since'>)[], today: Day, ask: DatedAsk = {}): StoredList {
  const since = copySince(lists, today)
  const current = datedOf(copy, lists)
  if (!current) {
    const fresh: DatedCopy = { query: copyQuery(lists), from: since, through: since - 1, readAt: 0, rows: '' }
    return { ...copy, ids: copy.dated === undefined ? copy.ids : '', dated: fresh }
  }
  // Nothing before the tracking day is wanted, so a stretch from it, or from
  // earlier, covers any ask.
  if (ask.full || (ask.askFrom !== undefined && Math.max(ask.askFrom, since) < current.from))
    return resetForFull(copy, since)
  return copy
}

/**
 * What a page read in a pass from `passFrom` merges into: the copy stored now,
 * as `lists` read it, so works and settling another writer added meanwhile are
 * kept. `held` is the copy as the run holds it; a copy not stored when the run
 * began (`wasStored` false) and still not stored merges into that.
 *
 * Null when the run must stop reading the copy: it was stored and is gone
 * (reset), or what is stored no longer reaches the pass — reset and read
 * afresh by another page, or its stretch now starting later than the run's —
 * so a page from further on would settle days nobody read. With no pass under
 * way (`passFrom` null, a failure being noted) any stored copy will do.
 */
export function pageBase(current: StoredList | undefined, held: StoredList, lists: readonly (QueriedList & Pick<TrackedList, 'since'>)[], today: Day, passFrom: Day | null, wasStored: boolean): StoredList | null {
  if (!current)
    return wasStored ? null : held
  const base = datedFor(current, lists, today)
  const dated = base.dated!
  if (passFrom !== null && (dated.through < passFrom - 1 || dated.from > held.dated!.from))
    return null
  return base
}

/** `copy` with its stretch put back to start on `since`, settled for nothing: its works, and any failure, kept. */
export function resetForFull(copy: StoredList, since: Day): StoredList {
  if (!copy.dated)
    return copy
  return { ...copy, dated: { ...copy.dated, from: since, through: since - 1 } }
}

/**
 * Merge one page into a copy read by date ({@link datedFor}), by
 * {@link applyPage}'s rules, and write its works in the copy's order: newest
 * day first, in the order first read within a day, then any undated works the
 * copy kept from before, in their order. Nothing is taken off.
 */
export function mergeDatedPage(copy: StoredList, page: PageRead, context: PageContext): StoredList {
  if (!copy.dated)
    throw new Error('A page merges only into a copy read by date')
  const dated = applyPage(copy.dated, page, context)
  return { ...copy, scrapedAt: context.at, ids: copyIds(dated.rows, copy.ids), dated }
}

/**
 * A dated copy's ids: the works its `rows` name, newest day first and in the
 * order first read within a day, then any undated works of `ids` (packed
 * ordered ids) the copy kept from before, in their order.
 */
function copyIds(rows: string, ids: string): string {
  const order = unpackRows(rows)
    .map((row, at) => ({ ...row, at }))
    .sort((a, b) => b.day - a.day || a.at - b.at)
    .map(row => row.sid)
  const placed = new Set(order)
  const undated = unpackOrderedIds(ids).map(toShortId).filter((sid): sid is string => sid !== null && !placed.has(sid))
  return packOrderedIds([...order, ...undated].map(fromShortId).filter((id): id is string => id !== null))
}

/**
 * A read of a tracked copy's listing that isn't by date — its own page on
 * the archive, walked as it is shown, in whatever sort and between whatever
 * dates — merged into the copy: works go in at their blurb days, a work seen
 * again moves to its later day, works dated before the copy's stretch (or
 * not dated) are left out, nothing is settled and nothing is taken off, and
 * the copy goes on saying when it was last read by date, and why that failed.
 *
 * A **whole** read — every page of the listing, none failed or cut short — of
 * the list's dates from no later than the copy's stretch starts is as good
 * as a read by date: it settles the copy through yesterday, says when it was
 * read, and clears any failure. A
 * copy not yet read by date is given a stretch from its lists' tracking day
 * ({@link datedFor}) first.
 */
export function mergeWalk(copy: StoredList, rows: PageRead['rows'], lists: readonly (QueriedList & Pick<TrackedList, 'since'>)[], today: Day, at: number, read: WalkRead = { whole: false, from: null }): StoredList {
  const ready = datedFor(copy, lists, today)
  const merged = mergeDatedPage(ready, { from: ready.dated!.from, page: 1, rows, reachedEnd: false }, { readDay: today, scanned: true, at })
  if (read.whole && (read.from === null || read.from <= ready.dated!.from)) {
    const { failed: _failed, ...dated } = merged.dated!
    return { ...merged, dated: { ...dated, through: Math.max(dated.through, today - 1), readAt: at } }
  }
  // When the copy was last read by date, and why that read gave up, are the
  // reads by date's to say: a walk of the page is neither.
  const { readAt, failed } = ready.dated!
  return { ...merged, dated: { ...merged.dated!, readAt, ...(failed ? { failed } : {}) } }
}

/** How a read of a tracked copy's own page went, for {@link mergeWalk}. */
export interface WalkRead {
  /** Every page of the listing was read, none failed or cut short. */
  whole: boolean
  /** The first day the read's dates started on; null for no lower bound. */
  from: Day | null
}

/** One list's view of the copy it shares: what {@link windowFromRecords} takes for it. */
export interface ListView extends SettledRows {
  failed?: CopyFailure
}

/**
 * `list`'s view of the copy it shares with `sharing` (itself among them): the
 * copy's works from the list's own tracking day, and how far that is settled.
 * The days before its tracking day are none of the list's business, so a copy
 * settled short of that day misses nothing of it. A failure on the copy is the
 * list's too. Null when the copy hasn't been read by date for these lists.
 */
export function listRows(list: TrackedList, copy: Pick<StoredList, 'dated'> | null | undefined, sharing: readonly TrackedList[], start?: Day): ListView | null {
  const dated = datedOf(copy, sharing)
  if (!dated)
    return null
  const since = wholeNumber(list.since) ?? dated.from
  // The first day the list wants: its tracking day, or the review's start
  // when that is later. A stretch starting after it hasn't read those days,
  // so nothing is settled for the list until they are.
  const wanted = start === undefined ? since : Math.max(since, start)
  const short = dated.from > wanted
  const from = short ? wanted : Math.max(dated.from, since)
  const rows = from === dated.from ? dated.rows : packRows(unpackRows(dated.rows).filter(row => row.day >= from))
  const view: ListView = { from, through: short ? from - 1 : Math.max(dated.through, from - 1), readAt: dated.readAt, rows }
  if (dated.failed)
    view.failed = dated.failed
  return view
}

/**
 * Every tracked list's view of its copy ({@link listRows}) among `stored`
 * (stored lists, by key), by list id, for a review starting on `start`: the
 * copy under its key, shared with the other tracked lists at that key. A list
 * whose copy hasn't been read by date for them has none. A list whose address
 * isn't a page on the archive has no copy to read, and its view says so.
 */
export function copyViews(lists: readonly TrackedList[], stored: Readonly<Record<string, StoredList | undefined>>, start?: Day): Map<string, ListView> {
  const tracked = lists.filter(list => list.tracked)
  const views = new Map<string, ListView>()
  for (const list of tracked) {
    const key = copyKeyOf(list)
    if (key === null) {
      const from = start ?? wholeNumber(list.since) ?? 0
      views.set(list.id, { from, through: from - 1, readAt: 0, rows: '', failed: { reason: 'not-archive', at: 0 } })
      continue
    }
    const view = listRows(list, stored[key], listsAtCopy(tracked, key), start)
    if (view)
      views.set(list.id, view)
  }
  return views
}

/**
 * For the options page's records line: the day every tracked list read at all
 * is settled through (the lowest), and the ids of the lists with nothing read
 * yet, by their views ({@link listRows}).
 */
export function viewSummary(lists: readonly TrackedList[], views: ReadonlyMap<string, Pick<SettledRows, 'through' | 'readAt'> | null>): { through: Day | null, behind: string[] } {
  let through: Day | null = null
  const behind: string[] = []
  for (const list of lists) {
    if (!list.tracked)
      continue
    const view = views.get(list.id)
    if (!view || view.readAt === 0) {
      behind.push(list.id)
      continue
    }
    through = through === null ? view.through : Math.min(through, view.through)
  }
  return { through, behind }
}

/** What went wrong with a request, for a reader: AO3's status where it gave one, else the error less the address it asked. */
export function requestTrouble(error: string | undefined): string {
  if (!error)
    return ''
  const status = /\bstatus (\d{3})\b/i.exec(error)?.[1]
  return status ? `AO3 answered with error ${status}` : error.replace(/:?\s*https?:\/\/\S+/g, '').trim()
}

/** Why a list's read gave up, as a clause to build a sentence on: lowercase, no full stop. */
export function failureWords(reason: ListReadFailure, error?: string): string {
  switch (reason) {
    case 'signed-out':
      return 'AO3 answered as though you were signed out'
    case 'not-archive':
      return 'its address isn’t a page on AO3'
    default: {
      const why = requestTrouble(error)
      return `all ${MAX_REQUEST_ATTEMPTS} tries failed${why ? ` (${why})` : ''}`
    }
  }
}

/** Why a list's read gave up, as a sentence of its own. */
export function failureSentence(reason: ListReadFailure, error?: string): string {
  const words = failureWords(reason, error)
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`
}

/**
 * Where one list has got in a run. `queued` has yet to be read, or waits its
 * turn partway, while a list read less far goes first; `retrying` is between
 * a failed request and its next try.
 */
export type ListReadPhase = 'queued' | 'reading' | 'retrying' | 'done' | 'failed'

/**
 * Why a list was given up on: signed out, an address that isn't a page on the
 * archive, or {@link MAX_REQUEST_ATTEMPTS} failed requests.
 */
export type ListReadFailure = 'signed-out' | 'not-archive' | 'request'

export interface ListRead {
  /** What the review calls the list. */
  name: string
  phase: ListReadPhase
  /** The pages of its pass read this run, so the one being read or retried is the next; 0 before the first. */
  page: number
  /** The pages its pass has, as its first page counts them; 0 before then, and for a list read whole. */
  of: number
  /** While retrying: how many tries of the page have failed. */
  attempt?: number
  /** Once failed: why. */
  failure?: ListReadFailure
  /** What went wrong with the last request, while retrying and once failed by it. */
  error?: string
}

/** What {@link windowFromRecords} is given. */
export interface WindowInput {
  /** The tracked lists, in the order the review lists them. An entry that isn't tracked takes no part. */
  lists: readonly TrackedList[]
  /** Each list's record, or its view of its copy ({@link listRows}), by list id. A list with none is pending. */
  records: ReadonlyMap<string, SettledRows>
  /** The window's first day (`reviewStart`). */
  start: Day
  /** The current UTC day. */
  today: Day
  /** How many counting works a window aims for. */
  target: number
  /** The window's end, set by hand: `[start, endOverride]`, within the start and yesterday. */
  endOverride?: Day
  /** Whether a list's view filter wants the work. */
  member: (listId: string, sid: string) => boolean
  /** Whether a work counts toward the target: not when the rules hide it, nor when it is already marked read or saved for later. */
  counts: (sid: string) => boolean
}

/** One work of a computed window. */
export interface WindowWork {
  sid: string
  /** The day it is reviewed on. */
  day: Day
  /** The lists that turned it up and want it, in list order: its List source values. */
  lists: string[]
  counts: boolean
}

/** A review window, computed from the lists' views of their copies. */
export interface ComputedWindow {
  start: Day
  /** Inclusive. */
  end: Day
  /** Works in review order: day, then list order, then row order. */
  works: WindowWork[]
  /** Counting works per day, one entry for every day of the window, empty days included. */
  days: Map<Day, number>
  /** Counting works on the day after the window: what one more day would add, as far as the copies know. */
  nextDayCount: number
  /** Lists complete through `end`. */
  complete: string[]
  /** Lists not yet complete through `end`, and still being read. */
  pending: string[]
  /** Lists not complete through `end` whose last run gave up on them. */
  failed: string[]
  /** Never when `end` reaches today or a list failed short of it. Pending lists don't block it. */
  reviewable: boolean
}

/**
 * The review window the copies make, without asking the archive.
 *
 * **Merging.** Every tracked list's rows, in list order and each list's rows in
 * order, merged by work. A row its list's view filter rejects (`member`) takes
 * no part: it doesn't name that list or move the work. A work two lists hold
 * goes on the later of their days, which is what it is now, in the place the
 * row that put it there had. A future day is reviewed today. Rows on days
 * before `start` are reviewed already. The views are taken as given: a
 * caller passes each list's view of its copy ({@link copyViews}).
 *
 * **Sizing.** Walking forward from `start`, the first day whose running total
 * of counting works goes over the target ends the window the day before it, or
 * at `start`, since a window is never less than a day. If nothing tips it, it
 * runs to yesterday. `endOverride` replaces the sizing. A reader reviewed
 * through yesterday gets a preview of today, which can't be marked reviewed.
 * A partial copy only holds fewer works than a full one, so as copies fill in
 * the window can only end earlier.
 *
 * `counts` is only asked about works on the days walked — from `start` to the
 * day after the window — so a caller can load the blurbs it needs a day at a
 * time. `member` is asked about every row, but a work with no row on those
 * days can't reach the window whatever it answers.
 *
 * **Completeness.** A list is complete through the window's end once its
 * `through` reaches it, or yesterday for a preview of today — and it has been
 * read, unless its record starts after the window's end and so has nothing
 * for it. One that isn't is
 * failed when its last run gave up on it, and pending otherwise.
 */
export function windowFromRecords(input: WindowInput): ComputedWindow {
  const { start, today, target } = input
  const yesterday = today - 1
  const lists = input.lists.filter(list => list.tracked)

  const merged = new Map<string, WindowWork & { place: number }>()
  let place = 0
  for (const list of lists) {
    const record = input.records.get(list.id)
    if (!record)
      continue
    for (const row of unpackRows(record.rows)) {
      if (!input.member(list.id, row.sid))
        continue
      const day = Math.min(row.day, today)
      const at = place++
      const work = merged.get(row.sid)
      if (!work) {
        merged.set(row.sid, { sid: row.sid, day, lists: [list.id], counts: false, place: at })
        continue
      }
      if (!work.lists.includes(list.id))
        work.lists.push(list.id)
      if (day > work.day) {
        work.day = day
        work.place = at
      }
    }
  }

  const byDay = new Map<Day, (WindowWork & { place: number })[]>()
  for (const work of merged.values()) {
    if (work.day < start)
      continue
    const day = byDay.get(work.day)
    if (day)
      day.push(work)
    else
      byDay.set(work.day, [work])
  }
  for (const works of byDay.values())
    works.sort((a, b) => a.place - b.place)

  const counted = new Map<Day, number>()
  const countOf = (day: Day): number => {
    let n = counted.get(day)
    if (n === undefined) {
      n = 0
      for (const work of byDay.get(day) ?? []) {
        work.counts = input.counts(work.sid)
        if (work.counts)
          n++
      }
      counted.set(day, n)
    }
    return n
  }

  let end: Day
  if (start > yesterday) {
    end = start
  }
  else if (input.endOverride !== undefined) {
    end = Math.min(Math.max(input.endOverride, start), yesterday)
  }
  else {
    end = yesterday
    let total = 0
    for (let day = start; day <= today; day++) {
      total += countOf(day)
      if (total > target) {
        end = Math.min(yesterday, Math.max(start, day - 1))
        break
      }
    }
  }

  const works: WindowWork[] = []
  const days = new Map<Day, number>()
  for (let day = start; day <= end; day++) {
    days.set(day, countOf(day))
    for (const { place: _place, ...work } of byDay.get(day) ?? [])
      works.push(work)
  }

  const bound = Math.min(end, yesterday)
  const complete: string[] = []
  const pending: string[] = []
  const failed: string[] = []
  for (const list of lists) {
    const record = input.records.get(list.id)
    if (record && record.through >= bound && (record.readAt > 0 || record.from > end))
      complete.push(list.id)
    else if (record?.failed)
      failed.push(list.id)
    else
      pending.push(list.id)
  }

  return {
    start,
    end,
    works,
    days,
    nextDayCount: countOf(end + 1),
    complete,
    pending,
    failed,
    reviewable: !failed.length && end < today,
  }
}

/** What {@link planRecordMigration} makes of the read records an older build kept. */
export interface RecordMigration {
  /** Copies to store, by key. */
  writes: Record<string, StoredList>
  /** Record keys to remove. */
  drop: string[]
}

/**
 * Move the read records an older build kept onto the tracked lists' copies,
 * so the review goes on where it was without reading anything again.
 *
 * Each copy's records — one per tracked list sharing it, of its list's
 * query — become its dated part: their works together, each on its later day,
 * complete from the latest of their starts through the earliest of their
 * ends — or for nothing, when a list at the copy had none, since each record
 * left out its own list's excluded tags. A record's failure isn't carried
 * over: it never said why, and the next read finds out for itself. The
 * copy keeps every work it held besides, after them. A copy already read by
 * date keeps what it has. A list with a record and no copy gets one
 * (`emptyCopy`), where one can be made. Every record is dropped,
 * whatever came of it, so running it again changes nothing.
 */
export function planRecordMigration(
  records: ReadonlyMap<string, unknown>,
  lists: readonly TrackedList[],
  stored: Readonly<Record<string, StoredList | undefined>>,
  emptyCopy: (list: TrackedList) => StoredList | null,
): RecordMigration {
  const tracked = lists.filter(list => list.tracked)
  const groups = new Map<string, { sharing: TrackedList[], found: TrackedRead[] }>()
  for (const list of tracked) {
    const key = copyKeyOf(list)
    if (key === null)
      continue
    const group = groups.get(key) ?? { sharing: listsAtCopy(tracked, key), found: [] }
    const record = storedRecordOf(list, records.get(list.id))
    if (record)
      group.found.push(record)
    groups.set(key, group)
  }

  const writes: Record<string, StoredList> = {}
  for (const [key, { sharing, found }] of groups) {
    const copy = stored[key]
    if (!found.length || datedOf(copy, sharing))
      continue
    const rows = new Map<string, Day>()
    for (const record of found) {
      for (const row of unpackRows(record.rows))
        rows.set(row.sid, Math.max(row.day, rows.get(row.sid) ?? row.day))
    }
    const from = Math.max(...found.map(record => record.from))
    const readAt = Math.min(...found.map(record => record.readAt))
    const packed = packRows([...rows].map(([sid, day]) => ({ sid, day })))
    // Each record was read leaving out its own list's excluded tags: only when
    // every list at the copy has one are the copy's days all read.
    const whole = found.length === sharing.length
    const dated: DatedCopy = {
      query: copyQuery(sharing),
      from,
      through: whole ? Math.max(from - 1, Math.min(...found.map(record => record.through))) : from - 1,
      readAt,
      rows: packed,
    }
    const base = copy && typeof copy.ids === 'string' ? copy : emptyCopy(sharing.find(list => list.scan) ?? sharing[0]!)
    if (!base)
      continue
    writes[key] = { ...base, ids: copyIds(packed, base.ids), dated }
  }
  return { writes, drop: [...records.keys()].map(readRecordKey) }
}

/** What every record's `storage.local` key starts with. */
export const READ_RECORD_PREFIX = 'trackedRead.'

/** The `storage.local` key a list's record is kept under. */
export function readRecordKey(listId: string): string {
  return `${READ_RECORD_PREFIX}${listId}`
}

/**
 * A page's word that it is reading the tracked lists: one reader across the
 * browser. Every review tab and the options page would otherwise ask the
 * archive for the same pages against a rate limit they share; the copies
 * land the same way whoever reads them, so the rest watch the copies instead.
 *
 * The holder renews it every {@link CLAIM_RENEW_MS}. One left unrenewed for
 * {@link CLAIM_TTL_MS} is a page that went away mid-read, and holds nobody.
 */
export interface ReadClaim {
  /** The page run reading: a token of its own, made when it loaded. */
  by: string
  /** Epoch ms the claim was made or last renewed; 0 once it is withdrawn. */
  at: number
}

/** How long a claim holds without being renewed. */
export const CLAIM_TTL_MS = 60_000

/** How often a page reading renews its claim: well inside {@link CLAIM_TTL_MS}, since a tab in the background has its timers slowed. */
export const CLAIM_RENEW_MS = 20_000

/** Why a read refuses to start, or stops, while another page holds the claim. */
export const READING_ELSEWHERE = 'Reading in another tab'

/** A claim by page run `by` at `now`. */
export function readClaim(by: string, now: number): ReadClaim {
  return { by, at: now }
}

/**
 * Who holds the read claim as page run `self` sees it at `now`: `free` when
 * nobody does (never claimed, withdrawn, or left to lapse), `self` when this
 * page run does, `other` while another page run's claim is live.
 */
export function claimHolder(claim: Partial<ReadClaim> | null | undefined, self: string, now: number): 'free' | 'self' | 'other' {
  if (!claim || !claimLive(claim.at, now, CLAIM_TTL_MS))
    return 'free'
  return claim.by === self ? 'self' : 'other'
}

/** `12 Sep – 19 Sep 2026`, with the year said once when both ends share it. */
export function formatRange(start: Day, end: Day): string {
  const from = formatDay(start)
  const to = formatDay(end)
  if (from === to)
    return from
  const sameYear = from.slice(-4) === to.slice(-4)
  return `${sameYear ? from.slice(0, -5) : from} – ${to}`
}

/** What the review's status line is told. */
export interface ReviewStatusInput {
  window: Pick<ComputedWindow, 'start' | 'end' | 'complete' | 'pending' | 'failed'>
  /** Each list's title, by id. */
  labels: ReadonlyMap<string, string>
  /** The pause this page's reading is sitting out, in words with its countdown; null when there is none. */
  wait: string | null
  /** Another page is reading the copies, and this one follows what it writes. */
  elsewhere: boolean
  /** The last reading here stopped because AO3 kept refusing, with lists still unread. */
  stopped: boolean
  /** When the copies were last read by date, as the reader reads a time; null when none has been. */
  readAt: string | null
  /** Why each list that couldn't be read gave up, by id, where that is known. */
  reasons?: ReadonlyMap<string, CopyFailure>
}

/**
 * Why each of `failed` (list ids) couldn't be read, as sentences to follow a
 * line saying so: one list's reason alone, several each after its title.
 * Empty when no reason is known.
 */
export function failureNotes(failed: readonly string[], labels: ReadonlyMap<string, string>, reasons: ReadonlyMap<string, CopyFailure> | undefined): string {
  const known = failed.flatMap((id) => {
    const failure = reasons?.get(id)
    return failure ? [{ id, sentence: failureSentence(failure.reason, failure.error) }] : []
  })
  if (failed.length === 1)
    return known[0]?.sentence ?? ''
  return known.map(({ id, sentence }) => `“${labels.get(id) ?? id}”: ${sentence}`).join(' ')
}

/** `notes` set after a sentence, or nothing for none. */
function notesAfter(notes: string): string {
  return notes ? ` ${notes}` : ''
}

/** The review's status line: how current the window is. */
export interface ReviewStatus {
  /** Which of the three it says, most severe first. */
  kind: 'failed' | 'pending' | 'current'
  text: string
  /** The lists it is about, by title, for hovering. */
  lists: string[]
  /**
   * Where a `pending` window's lists are being read: here, here but sitting out
   * a pause, by another page, or nowhere since AO3 stopped the reading here.
   */
  reading?: 'here' | 'waiting' | 'elsewhere' | 'stopped'
}

/**
 * How current the window is, in order of severity: that a list couldn't be
 * read, its works missing; that lists are still being read for the window's
 * days, with the pause being sat out if there is one; or that it is up to date.
 */
export function reviewStatus(input: ReviewStatusInput): ReviewStatus {
  const { window, labels } = input
  const named = (ids: readonly string[]): string[] => ids.map(id => labels.get(id) ?? id)
  if (window.failed.length) {
    const lists = named(window.failed)
    const who = lists.map(label => `“${label}”`).join(', ')
    return {
      kind: 'failed',
      text: `${who} couldn’t be loaded, so ${lists.length === 1 ? 'its' : 'their'} works are missing from this range.${notesAfter(failureNotes(window.failed, labels, input.reasons))}`,
      lists,
    }
  }
  if (window.pending.length) {
    const total = window.complete.length + window.pending.length
    const lists = `${window.pending.length} of ${total} ${total === 1 ? 'list' : 'lists'} for ${formatRange(window.start, window.end)}`
    if (input.stopped && !input.wait && !input.elsewhere)
      return { kind: 'pending', text: `Not yet read: ${lists} — AO3 asked us to slow down. Refresh to try again.`, lists: named(window.pending), reading: 'stopped' }
    const where = input.wait ? ` — ${input.wait}` : input.elsewhere ? ', in another tab' : ''
    const reading = input.wait ? 'waiting' : input.elsewhere ? 'elsewhere' : 'here'
    return { kind: 'pending', text: `Still reading ${lists}${where}`, lists: named(window.pending), reading }
  }
  return { kind: 'current', text: input.readAt ? `Up to date as of ${input.readAt}` : 'Up to date', lists: [] }
}

import type { Day, TrackedList } from './trackedLists.ts'

import { excludedTagNames, wholeNumber } from './trackedLists.ts'

/**
 * What the review keeps of each tracked list between visits: the works its
 * query turned up, by day, and how far that is known to be complete — a list's
 * **read record**. The review's window is computed from these, without asking
 * the archive, and the reader that brings them up to date only ever asks for
 * what they don't yet say.
 *
 * ## How far a record is trusted
 *
 * A record is read by asking the list's query for everything filed from
 * `through + 1`, oldest first, to its end. The archive files a work under the
 * UTC day of its update, and a query from day F is everything filed on F or
 * later, so a pass that reaches its end on day R has seen everything filed
 * through R − 1. Today is never trusted: it isn't over.
 *
 * A blurb day `D` counts as complete for a list once `through ≥ D`. A blurb's
 * printed date can be a day off its filing day, so a work updated in the first
 * hours of a UTC day and dated the day before can land on a day already
 * trusted. Trusting only through R − 2 would close that, at the price of
 * yesterday never counting as read, so a reader who is caught up would always
 * be told the review is still reading. The gap is accepted.
 *
 * This module is the decidable half: the record's shape and codec, merging a
 * page into one, which list to read next, pruning reviewed days, and the window
 * the records make. The archive half lives with the content script.
 *
 * Imports only the tracked lists' own pure module, so it loads under a plain
 * `node --test`.
 */

/** One tracked list's read record. `storage.local` key `trackedRead.<listId>`. Never synced. */
export interface TrackedRead {
  v: 1
  /**
   * What the archive is asked for this list ({@link readQuery}). A record
   * whose query no longer matches its list is dropped and read again.
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

/** One list as a run of the reader stands. */
export interface PassState {
  listId: string
  record: TrackedRead
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

/** The first day `list`'s record covers, for a window starting on `start`. */
function firstDay(list: Pick<TrackedList, 'since'>, start: Day): Day {
  return Math.max(wholeNumber(list.since) ?? start, start)
}

/** `stored` as a record of `list`'s current query, or null when it isn't one. */
function usableRecord(list: Pick<TrackedList, 'kind' | 'url' | 'scan' | 'filter'>, stored: unknown): TrackedRead | null {
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
 * The record for `list` as stored, or a fresh one when it's missing, malformed,
 * of another query, or doesn't cover the window starting on `start`: one that
 * begins after that day (the watermark went back, by an Undo or by hand) or
 * before the list was last tracked.
 *
 * One that begins before the window is kept. The days before `start` are
 * reviewed, and {@link pruneReviewed} takes them off.
 */
export function recordFor(list: TrackedList, stored: unknown, start: Day): TrackedRead {
  const from = firstDay(list, start)
  const record = usableRecord(list, stored)
  const since = wholeNumber(list.since)
  if (record && record.from <= from && (since === null || record.from >= since))
    return record
  return { v: 1, query: readQuery(list), from, through: from - 1, readAt: 0, rows: '' }
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
export function nextRead(states: readonly PassState[], today: Day): NextRead | null {
  let pick: PassState | undefined
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
export function applyPage(record: TrackedRead, page: PageRead, context: PageContext): TrackedRead {
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
  return { ...rest, through, readAt: context.at, rows: packRows(rows) }
}

/**
 * Drop the rows on days at or before `reviewedThrough`, and hand back the next
 * record and the short ids no longer in it. The record then starts the day
 * after, so a watermark put back later finds it no longer covers the window
 * and reads it again ({@link recordFor}). Days marked reviewed before they were
 * read are not read any more.
 *
 * The same record comes back when nothing changes.
 */
export function pruneReviewed(record: TrackedRead, reviewedThrough: Day): { record: TrackedRead, dropped: string[] } {
  const from = Math.max(record.from, reviewedThrough + 1)
  const through = Math.max(record.through, from - 1)
  const kept: ReadRow[] = []
  const dropped: string[] = []
  for (const row of unpackRows(record.rows)) {
    if (row.day <= reviewedThrough)
      dropped.push(row.sid)
    else
      kept.push(row)
  }
  if (!dropped.length && from === record.from && through === record.through)
    return { record, dropped }
  return { record: { ...record, from, through, rows: packRows(kept) }, dropped }
}

/**
 * For the options page's records line: the day the tracked lists are all read
 * through (the lowest `through` of those read at all), and the ids of the lists
 * not yet read — no record, one of another query, or none of its pages written.
 */
export function readSummary(lists: readonly TrackedList[], records: ReadonlyMap<string, unknown>): { through: Day | null, behind: string[] } {
  let through: Day | null = null
  const behind: string[] = []
  for (const list of lists) {
    if (!list.tracked)
      continue
    const record = usableRecord(list, records.get(list.id))
    if (!record || record.readAt === 0) {
      behind.push(list.id)
      continue
    }
    through = through === null ? record.through : Math.min(through, record.through)
  }
  return { through, behind }
}

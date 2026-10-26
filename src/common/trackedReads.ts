import type { Day, TrackedList } from './trackedLists.ts'

import { claimLive } from './claim.ts'
import { excludedTagNames, formatDay, wholeNumber } from './trackedLists.ts'
import { fromShortId } from './workId.ts'

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
 * Imports only other pure modules of `src/common`, so it loads under a plain
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
  const record = storedRecordOf(list, stored)
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
    const record = storedRecordOf(list, records.get(list.id))
    if (!record || record.readAt === 0) {
      behind.push(list.id)
      continue
    }
    through = through === null ? record.through : Math.min(through, record.through)
  }
  return { through, behind }
}

/** What {@link windowFromRecords} is given. */
export interface WindowInput {
  /** The tracked lists, in the order the review lists them. An entry that isn't tracked takes no part. */
  lists: readonly TrackedList[]
  /** Each list's record, by list id. A list with none is pending. */
  records: ReadonlyMap<string, TrackedRead>
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

/** A review window, computed from the records. */
export interface ComputedWindow {
  start: Day
  /** Inclusive. */
  end: Day
  /** Works in review order: day, then list order, then row order. */
  works: WindowWork[]
  /** Counting works per day, one entry for every day of the window, empty days included. */
  days: Map<Day, number>
  /** Counting works on the day after the window: what one more day would add, as far as the records know. */
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
 * The review window the records make, without asking the archive.
 *
 * **Merging.** Every tracked list's rows, in list order and each list's rows in
 * order, merged by work. A row its list's view filter rejects (`member`) takes
 * no part: it doesn't name that list or move the work. A work two lists hold
 * goes on the later of their days, which is what it is now, in the place the
 * row that put it there had. A future day is reviewed today. Rows on days
 * before `start` are reviewed already. The records are taken as given: a
 * caller passes each list's through `recordFor`.
 *
 * **Sizing.** Walking forward from `start`, the first day whose running total
 * of counting works goes over the target ends the window the day before it, or
 * at `start`, since a window is never less than a day. If nothing tips it, it
 * runs to yesterday. `endOverride` replaces the sizing. A reader reviewed
 * through yesterday gets a preview of today, which can't be marked reviewed.
 * A partial record only holds fewer works than a full one, so as records fill
 * in the window can only end earlier.
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

/** What every record's `storage.local` key starts with. */
export const READ_RECORD_PREFIX = 'trackedRead.'

/** The `storage.local` key a list's record is kept under. */
export function readRecordKey(listId: string): string {
  return `${READ_RECORD_PREFIX}${listId}`
}

/**
 * Of `keys` (storage keys), the records of lists not among `trackedIds`: a
 * list that stopped being tracked while nothing was there to drop its record.
 */
export function strayRecordKeys(keys: readonly string[], trackedIds: readonly string[]): string[] {
  const tracked = new Set(trackedIds.map(readRecordKey))
  return keys.filter(key => key.startsWith(READ_RECORD_PREFIX) && !tracked.has(key))
}

/**
 * Every work the records hold, as decimal work ids. A record keeps its works'
 * blurbs alive: the review draws them from the store, so a pruner must count
 * them as referenced. Anything that isn't a record is passed over.
 */
export function recordedWorkIds(records: Iterable<unknown>): Set<string> {
  const ids = new Set<string>()
  for (const record of records) {
    const rows = (record as Partial<TrackedRead> | null)?.rows
    if (typeof rows !== 'string')
      continue
    for (const { sid } of unpackRows(rows)) {
      const id = fromShortId(sid)
      if (id !== null)
        ids.add(id)
    }
  }
  return ids
}

/**
 * A page's word that it is reading the tracked lists: one reader across the
 * browser. Every review tab and the options page would otherwise ask the
 * archive for the same pages against a rate limit they share; the records
 * land the same way whoever reads them, so the rest watch the records instead.
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

/**
 * Whether the records want reading: a tracked list's is missing, short of
 * yesterday, or wasn't written today (which is what reads today's tail).
 */
export function recordsBehind(records: ReadonlyMap<string, TrackedRead>, lists: readonly TrackedList[], today: Day): boolean {
  return lists.some((list) => {
    if (!list.tracked)
      return false
    const record = records.get(list.id)
    return !record || record.through < today - 1 || Math.floor(record.readAt / 86_400_000) < today
  })
}

/** What the review's status line is told. */
export interface ReviewStatusInput {
  window: Pick<ComputedWindow, 'start' | 'end' | 'complete' | 'pending' | 'failed'>
  /** Each list's title, by id. */
  labels: ReadonlyMap<string, string>
  /** The pause this page's reading is sitting out, in words with its countdown; null when there is none. */
  wait: string | null
  /** Another page is reading the records, and this one follows what it writes. */
  elsewhere: boolean
  /** The last reading here stopped because AO3 kept refusing, with lists still unread. */
  stopped: boolean
  /** When the records were last written, as the reader reads a time; null when none has been. */
  readAt: string | null
}

/** The review's status line: how current the window is. */
export interface ReviewStatus {
  /** Which of the three it says, most severe first. */
  kind: 'failed' | 'pending' | 'current'
  text: string
  /** The lists it is about, by title, for hovering. */
  lists: string[]
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
      text: `${who} couldn’t be loaded, so ${lists.length === 1 ? 'its' : 'their'} works are missing from this range.`,
      lists,
    }
  }
  if (window.pending.length) {
    const total = window.complete.length + window.pending.length
    const lists = `${window.pending.length} of ${total} ${total === 1 ? 'list' : 'lists'} for ${formatRange(window.start, window.end)}`
    if (input.stopped && !input.wait && !input.elsewhere)
      return { kind: 'pending', text: `Not yet read: ${lists} — AO3 asked us to slow down. Refresh to try again.`, lists: named(window.pending) }
    const where = input.wait ? ` — ${input.wait}` : input.elsewhere ? ', in another tab' : ''
    return { kind: 'pending', text: `Still reading ${lists}${where}`, lists: named(window.pending) }
  }
  return { kind: 'current', text: input.readAt ? `Up to date as of ${input.readAt}` : 'Up to date', lists: [] }
}

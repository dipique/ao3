import type { ComputedWindow, Day, Options, TrackedList, TrackedListsOption, TrackedRead } from '#common'
import type { Work } from '#content_script/blurb.js'
import type { FilterState } from '#content_script/searchView/engine.ts'

import { fromShortId, pruneReviewed, recordFor, reviewStart, toShortId, unpackRows, utcToday, windowFromRecords } from '#common'
import { recordRuleTiming } from '#content_script/ruleTiming.ts'
import { readRecords, rewriteStale, worksFromRecords } from '#content_script/searchView/blurbStore.ts'
import { matches } from '#content_script/searchView/engine.ts'
import { applyHidden } from '#content_script/searchView/hidden.ts'
import { readStoredRecords, writeReadRecords } from '#content_script/tracked/readStore.ts'
import { filterStateOf } from '#content_script/tracked/viewFilter.ts'

/**
 * The review window, computed from the tracked lists' read records without
 * asking the archive: the half of the review that loads what the pure
 * `windowFromRecords` needs — the records, and the blurbs whose hide verdicts
 * and view filters decide which works count — and hands back the works to draw.
 */

/** What {@link computeWindow} is given. */
export interface WindowRequest {
  option: TrackedListsOption
  options: Options
  /** Archive work ids the reader has already dealt with: they neither count nor show. */
  reviewed: ReadonlySet<string>
  /** The reader's ± day, or an end held for the visit. */
  endOverride?: Day
  /** Works already parsed this page run, by archive work id, reused and added to. */
  works: Map<string, Work>
}

/** A window and what drawing it takes. */
export interface ReviewWindow {
  window: ComputedWindow
  /** The window's works to draw, in review order, `markedOrder` numbered to match. */
  works: Work[]
  /** Each tracked list's record as the window was computed from it. */
  records: Map<string, TrackedRead>
  /** Short ids of works the records no longer hold: rows on days now reviewed. */
  pruned: string[]
  /** Works in the records on days after the window: what is still to review, roughly. */
  later: number
}

/**
 * Compute the review window `option` asks for from the records as stored.
 *
 * Records still holding days the watermark has passed — it moved on another
 * device, or here before the reader got to it — are pruned, and written back.
 *
 * Blurbs are loaded only for the days the window is sized over: a pass counts
 * every work it hasn't loaded as wanted and counting, which can only end the
 * window early, then loads the works on the days it walked and goes again,
 * until nothing new is needed. A work whose blurb isn't stored can't be drawn,
 * and takes no part.
 */
export async function computeWindow(request: WindowRequest): Promise<ReviewWindow> {
  const { option, options, reviewed, works } = request
  const lists = option.lists.filter(list => list.tracked)
  const start = reviewStart(option)
  const today = utcToday()

  const stored = await readStoredRecords(lists.map(list => list.id))
  const records = new Map<string, TrackedRead>()
  const prunedWrites = new Map<string, TrackedRead>()
  const pruned: string[] = []
  for (const list of lists) {
    const record = recordFor(list, stored.get(list.id), start)
    const after = pruneReviewed(record, start - 1)
    if (after.record !== record && stored.has(list.id)) {
      prunedWrites.set(list.id, after.record)
      pruned.push(...after.dropped)
    }
    records.set(list.id, after.record)
  }
  await writeReadRecords(prunedWrites)

  const wants = new Map<string, FilterState | null>(lists.map(list => [list.id, filterStateOf(list.filter)]))
  const missing = new Set<string>()
  const workOf = (sid: string): Work | undefined => {
    const id = fromShortId(sid)
    return id === null ? undefined : works.get(id)
  }
  const member = (settled: boolean) => (listId: string, sid: string): boolean => {
    const work = workOf(sid)
    if (!work)
      return !settled && !missing.has(sid)
    const filter = wants.get(listId)
    return !filter || matches(work, filter)
  }
  const counts = (settled: boolean) => (sid: string): boolean => {
    const work = workOf(sid)
    if (!work)
      return !settled && !missing.has(sid)
    return !reviewed.has(work.workId) && !work.hidden && !work.filtered
  }
  const base = { lists, records, start, today, target: option.target, endOverride: request.endOverride }

  for (;;) {
    const trial = windowFromRecords({ ...base, member: member(false), counts: counts(false) })
    const wanted = new Set<string>()
    for (const record of records.values()) {
      for (const row of unpackRows(record.rows)) {
        if (row.day >= start && Math.min(row.day, today) <= trial.end + 1 && !workOf(row.sid) && !missing.has(row.sid))
          wanted.add(row.sid)
      }
    }
    if (!wanted.size)
      break
    await loadWorks([...wanted], works, missing, options)
  }

  const window = windowFromRecords({ ...base, member: member(true), counts: counts(true) })
  const drawn: Work[] = []
  for (const { sid } of window.works) {
    const work = workOf(sid)
    if (!work || reviewed.has(work.workId))
      continue
    work.markedOrder = drawn.length
    drawn.push(work)
  }

  const after = new Set<string>()
  for (const record of records.values()) {
    for (const row of unpackRows(record.rows)) {
      if (Math.min(row.day, today) > window.end)
        after.add(row.sid)
    }
  }
  for (const work of window.works)
    after.delete(work.sid)

  return { window, works: drawn, records, pruned, later: after.size }
}

/**
 * Parse the stored blurbs of these works into `works`, and take their hide
 * verdicts. Short ids with no stored blurb go in `missing`.
 */
async function loadWorks(sids: string[], works: Map<string, Work>, missing: Set<string>, options: Options): Promise<void> {
  const ids = sids.map(fromShortId).filter((id): id is string => id !== null)
  const { works: found, stale } = worksFromRecords(ids, await readRecords(ids))
  if (stale.length)
    void rewriteStale(stale).catch(err => console.error('[tracked] could not rewrite stored blurbs', err))
  const got = new Set<string>()
  for (const work of found) {
    works.set(work.workId, work)
    got.add(toShortId(work.workId)!)
  }
  for (const sid of sids) {
    if (!got.has(sid))
      missing.add(sid)
  }
  applyHidden(found, options, { timed: recordRuleTiming })
}

/** Whether the reader should read: a list's record is short of yesterday, or wasn't read today. */
export function recordsBehind(records: ReadonlyMap<string, TrackedRead>, lists: readonly TrackedList[], now: number = Date.now()): boolean {
  const today = utcToday(now)
  return lists.some((list) => {
    if (!list.tracked)
      return false
    const record = records.get(list.id)
    return !record || record.through < today - 1 || utcToday(record.readAt) < today
  })
}

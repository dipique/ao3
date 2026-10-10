import { sameReading, withDateFilter } from '../../common/trackedLists.ts'

/**
 * Whether a search view may open on the copy it kept without reading its
 * listing again ({@link isFresh}), and the refresh-after settings that decide
 * how long that is ({@link refreshIntervalMs}).
 *
 * Pure — its one import is pure too — so it loads under a plain `node --test`.
 */

/** An hour, in the ms a refresh interval is counted in. */
export const HOUR_MS = 60 * 60_000

/**
 * A refresh-after setting, in hours, as a source's refresh interval in ms.
 * Anything that isn't a positive number of hours is `0`: read on every open.
 */
export function refreshIntervalMs(hours: number): number {
  return Math.max(0, hours || 0) * HOUR_MS
}

/** A kept copy, as far as {@link isFresh} asks about it. */
export interface KeptCopy {
  /** When a read last wrote it. */
  scrapedAt: number
  /** How many of the works it names have lost their stored blurbs. */
  missing: number
  /** The listing it was read from: its descriptor's. Absent for a copy that never said. */
  listUrl?: string
  /** The date filter it was read under, kept apart from {@link listUrl}: its descriptor's. */
  dateFilter?: string
}

/** What an open asks of a kept copy. */
export interface Wanted {
  /** The source's refresh interval, in ms. */
  intervalMs: number
  /** The listing the open would read: the source's descriptor's. */
  listUrl: string
  /** The date filter the open would read it under: the source's descriptor's. */
  dateFilter?: string
  now: number
}

/**
 * Whether opening the view may show `copy` as it is, without reading its
 * listing behind it. Only when all of these hold:
 *
 * - it is younger than the interval, counted from `scrapedAt`, and not dated
 *   ahead of `now` (a clock set back);
 * - it names no work whose blurb has gone, which only a read puts back;
 * - it is a read of the listing the page asks for ({@link sameReading}), each
 *   address with its date filter put back on. A filtered listing keeps one
 *   copy for every sort and date range, and a copy read in another of them
 *   holds other works, in another order.
 */
export function isFresh(copy: KeptCopy, wanted: Wanted): boolean {
  if (copy.missing || copy.listUrl === undefined)
    return false
  if (!sameReading(withDateFilter(copy.listUrl, copy.dateFilter), withDateFilter(wanted.listUrl, wanted.dateFilter)))
    return false
  const age = wanted.now - copy.scrapedAt
  return age >= 0 && age < wanted.intervalMs
}

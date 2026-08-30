import type { MarkConfig, MarkId, WorkProgress } from './workMarks.ts'

import { markProgress, progressMarkIds } from './workMarks.ts'

/**
 * What a work's recorded progress *means*: is it worth opening yet, which
 * chapters are still unread, and how to say both in one line each.
 *
 * The storage side lives in {@link file://./workMarks.ts}; this is the
 * semantics, kept separate for the same reason
 * {@link file://./wordCount.ts} is — one authority the content script, the
 * hiding pass and the tests all read, with no DOM and no `browser` APIs.
 *
 * It may import from `workMarks.ts` (itself import-free), but never from
 * `#common`: that barrel calls `browser.runtime.getManifest()` at module load,
 * which would take this module out of reach of `node --test`.
 */

/**
 * Whether an ongoing work is worth surfacing.
 *
 * - `ready` — open it: there are chapters you haven't read and no date says wait.
 * - `waiting` — a wait-until date the reader set is still in the future.
 * - `caughtUp` — you're level with what's been published; nothing new to read.
 */
export type Readiness = 'ready' | 'waiting' | 'caughtUp'

/** Facet/label text per state, so nothing downstream spells these out twice. */
export const READINESS_LABELS: Record<Readiness, string> = {
  ready: 'Ready',
  waiting: 'Waiting',
  caughtUp: 'Caught up',
}

/**
 * Indicator colour per state, or null to keep the mark's own colour.
 *
 * A progress mark is the one mark whose indicator means something different
 * work to work: "open this now" and "nothing here yet" are opposite answers
 * wearing the same calendar. Both non-ready states are ones you'd otherwise have
 * to hover to discover, and both show up unhidden in the Marked-for-Later view,
 * so they say so in colour:
 *
 * - `ready` keeps the mark's colour — this is the state the mark is *for*.
 * - `waiting` is amber: deliberately parked, come back later.
 * - `caughtUp` is the muted grey the `read` mark uses, because that is what it
 *   amounts to until the author posts again — dormant rather than pending.
 */
export const READINESS_COLORS: Record<Readiness, string | null> = {
  ready: null,
  waiting: '#d97706',
  caughtUp: '#6b7280',
}

/** The colour an indicator should paint for one state, given the mark's own. */
export function readinessColor(state: Readiness, base: string | undefined): string | undefined {
  return READINESS_COLORS[state] ?? base
}

// ---------------------------------------------------------------------------
// Days since the epoch. A wait-until date is a calendar decision ("check back
// in March"), so it's stored as a day number rather than a timestamp: computed
// from *local* calendar parts through `Date.UTC`, which pins it to that day
// regardless of the zone it's read back in. `<input type="date">` hands us
// `YYYY-MM-DD`, which splits straight into those parts with no Date parsing —
// the one shape where `new Date(text)` would have meant UTC midnight and drifted
// a day backwards for everyone west of Greenwich.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000

/** Parse a `YYYY-MM-DD` date-input value into days since the epoch; null if it isn't one. */
export function toEpochDays(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim())
  if (!match)
    return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (month < 1 || month > 12 || day < 1 || day > 31)
    return null
  return Date.UTC(year, month - 1, day) / MS_PER_DAY
}

/** Render days since the epoch back as a `YYYY-MM-DD` date-input value. */
export function fromEpochDays(days: number): string {
  const date = new Date(days * MS_PER_DAY)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/** Today, as days since the epoch, read off the local calendar. */
export function todayEpochDays(now: Date = new Date()): number {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_PER_DAY
}

/**
 * `days` shifted by whole months — what the editor's "+1 month" preset means.
 * Overshooting a short month clamps to its last day (31 Jan + 1 month is 28
 * Feb, not 3 March), which is how a reader reads "in a month".
 */
export function addMonths(days: number, months: number): number {
  const date = new Date(days * MS_PER_DAY)
  const day = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + months)
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
  date.setUTCDate(Math.min(day, lastDay))
  return date.getTime() / MS_PER_DAY
}

/** Short display form of a wait-until date, e.g. `3/14/26`. */
export function formatEpochDays(days: number): string {
  const date = new Date(days * MS_PER_DAY)
  const year = String(date.getUTCFullYear() % 100).padStart(2, '0')
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}/${year}`
}

// ---------------------------------------------------------------------------
// The readiness rule.
// ---------------------------------------------------------------------------

/**
 * Whether an ongoing work should surface, given the chapter count published so
 * far — the **left** number of `dd.chapters` (`9` in `9/23`); the right one is
 * the author's guess at a total and is never a count of anything that exists.
 *
 * Shown only when both hold: no wait-until date is still in the future, *and*
 * there is at least one chapter past where the reader stopped.
 *
 * `publishedChapters` is null when the count couldn't be read at all (a series
 * blurb, a bookmark of an external work). That half of the rule then fails open
 * — an unreadable count is not evidence there's nothing new — while an explicit
 * wait-until date still stands, because that one the reader typed themselves.
 */
export function readiness(
  progress: WorkProgress | undefined,
  publishedChapters: number | null,
  today: number,
): Readiness {
  const waitUntil = progress?.waitUntil
  if (waitUntil !== undefined && waitUntil > today)
    return 'waiting'
  if (publishedChapters === null)
    return 'ready'
  return (progress?.chapter ?? 0) < publishedChapters ? 'ready' : 'caughtUp'
}

/**
 * The chapters the reader hasn't seen, or null when there are none. Also null
 * when the count is unknown, and when the recorded chapter is *past* the
 * published count — a work trimmed after it was read is caught up, not owed
 * negative chapters.
 */
export function unreadRange(
  progress: WorkProgress | undefined,
  publishedChapters: number | null,
): { from: number, to: number } | null {
  if (publishedChapters === null)
    return null
  const from = (progress?.chapter ?? 0) + 1
  return from > publishedChapters ? null : { from, to: publishedChapters }
}

/** `Unread: chapters 7-9` / `Unread: chapter 9` / `No unread chapters`. */
export function describeUnread(
  progress: WorkProgress | undefined,
  publishedChapters: number | null,
): string {
  const range = unreadRange(progress, publishedChapters)
  if (!range)
    return 'No unread chapters'
  return range.from === range.to
    ? `Unread: chapter ${range.from}`
    : `Unread: chapters ${range.from}-${range.to}`
}

/**
 * What the wait-until date says right now. A date that has passed is still
 * named rather than treated as absent: it's the reader's own note about when
 * they meant to come back, and seeing it is half the point of having set it.
 */
export function describeWaitUntil(progress: WorkProgress | undefined, today: number): string {
  const waitUntil = progress?.waitUntil
  if (waitUntil === undefined)
    return 'Ready (no Wait Until date set)'
  return waitUntil > today
    ? `Not Ready (wait until ${formatEpochDays(waitUntil)})`
    : `Ready (passed Wait Until date ${formatEpochDays(waitUntil)})`
}

/** Both lines of the hint — what's unread, and what the date says — newline-joined. */
export function describeProgress(
  progress: WorkProgress | undefined,
  publishedChapters: number | null,
  today: number,
): string {
  return `${describeUnread(progress, publishedChapters)}\n${describeWaitUntil(progress, today)}`
}

/**
 * The reason line for a work collapsed by its progress. Takes the mark's own
 * label so a renamed mark reads correctly; only the parenthetical is ours.
 */
export function hiddenLabel(state: Readiness, label = 'Ongoing'): string {
  return state === 'waiting' ? `${label} (Not Ready)` : `${label} (No unread chapters)`
}

// ---------------------------------------------------------------------------
// Reading the table.
// ---------------------------------------------------------------------------

/** One mark's progress entries, paired with the mark id, for a whole run. */
export interface ProgressSource {
  id: MarkId
  entries: Map<string, WorkProgress>
}

/**
 * Every progress-tracking mark's entries, unpacked once. Callers that hide (or
 * facet) a whole listing want this rather than a lookup per work — and get an
 * empty list, and so a clean no-op, from a table with no such mark at all.
 */
export function progressSources(marks: Record<MarkId, MarkConfig>): ProgressSource[] {
  return progressMarkIds(marks)
    .map(id => ({ id, entries: markProgress(marks, id) }))
    .filter(source => source.entries.size > 0)
}

/**
 * The first progress mark this work carries, with its entry — the answer to
 * "is this work ongoing, and where in it am I?". Only one can apply per group,
 * since a progress mark stands alone in its own (see `markIsExclusive`).
 */
export function findProgress(
  sources: readonly ProgressSource[],
  workId: string,
): { id: MarkId, progress: WorkProgress } | null {
  for (const { id, entries } of sources) {
    const progress = entries.get(workId)
    if (progress)
      return { id, progress }
  }
  return null
}

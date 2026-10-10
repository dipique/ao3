import type { ListRef } from '../../common/listLinks.ts'
import type { Day } from '../../common/trackedLists.ts'
import type { CachingBuckets } from '../../content_script/siteExport/workText.ts'
import type { JobActions, JobView } from './jobView.ts'

import { hostPage, openLink } from '../../common/listLinks.ts'
import { formatDay, isoDay } from '../../common/trackedLists.ts'
import { toEpochDays } from '../../common/workProgress.ts'
import { listJob } from './jobView.ts'
import { timeAgo } from './moments.ts'
import { moreCounts } from './moreMenu.ts'
import { TRACK_OFF } from './savedListRows.ts'

/**
 * The Review block: the two numbers that shape a review — how far the reader
 * has been, and how many works a range aims for — and *This review*, the range
 * being reviewed now, which is stored like a list so that it can be cached and
 * downloaded, and which Start Review opens.
 */

/** How many works a review range aims for, at the least and the most. */
export const WORKS_PER_REVIEW = { min: 10, max: 500 } as const

/** What the job and every reason that names the job's list call the review's window. */
export const REVIEW_NAME = 'this review'

/**
 * Why Start Review is off, once Tracked lists is on. Worded to follow the
 * control's name after a dash. `noWindow` is for a review with no page to open
 * on: none gathered yet, and the reader's account not known.
 */
export const START_OFF = {
  noneTracked: 'off while no list is tracked',
  noWindow: 'off until your first review is gathered on AO3',
} as const

/** The watermark as the reader reads it. */
export function reviewedThroughLabel(day: Day): string {
  return day > 0 ? formatDay(day) : 'Nothing reviewed yet'
}

/**
 * The latest day a reader may claim to have reviewed, as the date picker's
 * `max`. A review range never reaches today — the day isn't over, and marking
 * it reviewed would bury every work posted later today.
 */
export function latestReviewable(today: Day): string {
  return isoDay(today - 1)
}

/**
 * The watermark a date typed into the picker writes: that day, at most
 * yesterday; 0, "nothing reviewed yet", for an emptied field, which is how a
 * reader starts over; or null for a date still being typed, which writes
 * nothing.
 */
export function reviewedThroughFrom(text: string, today: Day): Day | null {
  if (!text.trim())
    return 0
  const day = toEpochDays(text)
  return day === null ? null : Math.min(day, today - 1)
}

/** The review's stored window, as This review reads it. */
export interface ReviewWindow {
  /** Its stored key, which is also what a job names it by. */
  key: string
  count: number
  /** Its works in the cache's buckets: cached, failed and new. */
  buckets: CachingBuckets
  scrapedAt: number
  /** The page it was gathered on. */
  listUrl?: string
}

export interface ReviewBlockInput {
  /** Whether Tracked lists is on. */
  enabled: boolean
  /** Whether any list is tracked: with none, there is no review to open. */
  tracking: boolean
  window: ReviewWindow | null
  /** The reader's AO3 account, on whose readings the review opens. */
  userId?: string
  job: JobView
  now: number
}

export interface ReviewBlockView {
  /** Why Reviewed through and Works per review are off, or null. */
  settingsOff: string | null
  /** "37 works", and "gathered 22 minutes ago · 0 cached"; null with no window. */
  figure: { count: string, detail: string } | null
  /** What the cell says with no window. */
  empty: string | null
  /**
   * Cache works and Download Offline Copy; Stop while the job on the window
   * runs; Continue or Discard while it is stopped; nothing with no window.
   */
  actions: JobActions | null
  /** Why Cache works and Download Offline Copy are off: another list's job. */
  offlineOff: string | null
  /** The job is on the window, so its line goes in the cell. */
  job: boolean
  /** Start Review: where it goes, its name, and why it is off. */
  start: { href: string | null, label: string, off: string | null }
  /** The works a retry asks for again, stale ones included; with none, More offers no retry. */
  retry: number
  /** The cached works; with none, More offers no download without refreshing. */
  cached: number
}

export function reviewBlock({ enabled, tracking, window, userId, job, now }: ReviewBlockInput): ReviewBlockView {
  const settingsOff = enabled ? null : TRACK_OFF.review
  const open = reviewOpen(window, userId)
  const startOff = settingsOff ?? (!tracking ? START_OFF.noneTracked : !open ? START_OFF.noWindow : null)
  const start = {
    href: startOff ? null : open,
    label: window ? `Start the review: ${works(window.count)}` : 'Start the review',
    off: startOff,
  }
  if (!window) {
    return {
      settingsOff,
      figure: null,
      // With a page to open, Start Review gathers the first review itself.
      empty: open
        ? 'Nothing gathered yet.'
        : 'Nothing gathered yet: your first review is gathered when you open Tracked on your readings page on AO3.',
      actions: null,
      offlineOff: null,
      job: false,
      start,
      retry: 0,
      cached: 0,
    }
  }

  const { actions, off, here } = listJob(job, window.key)
  return {
    settingsOff,
    figure: {
      count: works(window.count),
      detail: `gathered ${timeAgo(window.scrapedAt, now)} · ${window.buckets.cached.toLocaleString()} cached`,
    },
    empty: null,
    actions,
    offlineOff: off,
    job: here,
    start,
    ...moreCounts(window.buckets),
  }
}

const REVIEW: ListRef = { kind: 'review' }

/**
 * Where Start Review opens the review: its open URL ({@link openLink}), on the
 * reader's readings ({@link hostPage}), which gathers a review when there is
 * none yet; else, with their account not known, on the page its window was
 * gathered on; null with neither.
 */
function reviewOpen(window: ReviewWindow | null, userId: string | undefined): string | null {
  const page = hostPage(REVIEW, null, userId) ?? window?.listUrl
  return page ? openLink(REVIEW, page) : null
}

function works(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'work' : 'works'}`
}

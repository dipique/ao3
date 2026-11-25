import type { WorkFreshness } from './workText.ts'

import { COMMENT_LOAD_RETRIES } from '../../common/constants.ts'

/**
 * Whether the work page the reader is on holds everything a cached copy of the
 * work would, so its text can be kept without asking AO3 for it again — what
 * "Opportunistically cache work text" decides on every visit.
 *
 * A copy is the whole work, so every chapter has to be on the page: a
 * one-chapter work always is, and a longer one only as its entire work. With
 * comments saved alongside, a work that has any needs some of them shown, and
 * AO3 loads them after the page when it is asked for them (`#comments`), so the
 * page is looked at again a few times before it is given up on. How many are
 * shown doesn't matter: a copy holding fewer than every page of them is stored
 * as not holding them all, and the next caching run fetches the rest.
 *
 * Pure, so it loads under a plain `node --test`.
 */

/** What the work page holds, as far as caching it goes. */
export interface WorkPageShape {
  /** Chapters written, per the work's stats. */
  written: number
  /** Chapters whose text is on the page. */
  shown: number
  /** Comments the work has, per its stats. */
  comments: number
  /** Top-level comments on the page. */
  commentsShown: number
  /** The page asked AO3 for its comments, which may still be on their way. */
  commentsAsked: boolean
}

export interface CaptureOptions {
  /** The reader saves comments with cached works. */
  comments: boolean
  /** How many times the page has been looked at again for its comments. */
  attempt: number
}

/** Keep the page's text now, look again in a moment, or leave it. */
export type CaptureStep = 'capture' | 'wait' | 'skip'

export function captureStep(page: WorkPageShape, { comments, attempt }: CaptureOptions): CaptureStep {
  if (page.written < 1 || page.shown < page.written)
    return 'skip'
  if (!comments || page.comments === 0 || page.commentsShown > 0)
    return 'capture'
  if (!page.commentsAsked)
    return 'skip'
  return attempt < COMMENT_LOAD_RETRIES ? 'wait' : 'skip'
}

const DAY_SECONDS = 24 * 60 * 60

/**
 * The blurb facts to store beside a copy taken from its work page. The page
 * dates the work to the day, where a listing's blurb has it to the second; a
 * stored blurb of the same day lends its time, so the next caching run, which
 * judges the copy against a listing's blurb, doesn't take that blurb's later
 * hour for an update.
 */
export function pageFreshness(page: WorkFreshness, storedDateUpdated: number | undefined): WorkFreshness {
  if (page.dateUpdated > 0 && storedDateUpdated !== undefined
    && Math.floor(storedDateUpdated / DAY_SECONDS) === Math.floor(page.dateUpdated / DAY_SECONDS)) {
    return { ...page, dateUpdated: storedDateUpdated }
  }
  return page
}

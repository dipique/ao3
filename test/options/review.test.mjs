import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { formatDay, isoDay } from '../../src/common/trackedLists.ts'
import { jobView } from '../../src/options_ui/model/jobView.ts'
import { timeAgo } from '../../src/options_ui/model/moments.ts'
import { latestReviewable, recordsLine, REVIEW_NAME, reviewBlock, reviewedThroughFrom, reviewedThroughLabel, START_OFF, WORKS_PER_REVIEW } from '../../src/options_ui/model/review.ts'
import { TRACK_OFF } from '../../src/options_ui/model/savedListRows.ts'

const NOW = 1_800_000_000_000
const TODAY = Math.floor(NOW / 86_400_000)
const REVIEW = 'tracked-review'
const OTHER = 'marked-for-later:tester'
const READINGS = 'https://archiveofourown.org/users/tester/readings#ao3e-tracked'
/** The review's open URL, on the reader's readings. */
const OPEN = '/users/tester/readings#ao3e-open=tracked-review'

/** The window's works in the cache's buckets: none cached, unless told otherwise. */
const buckets = (fields = {}) => ({ total: 37, cached: 0, failed: 0, unfetched: 37, bytes: 0, staleFailures: 0, ...fields })

/** The review's stored window: 37 works, gathered 22 minutes ago, none cached. */
const WINDOW = { key: REVIEW, count: 37, buckets: buckets(), scrapedAt: NOW - 22 * 60_000, listUrl: READINGS }

/** The job as the page reads it: on `key`, running unless told otherwise. */
function job(key, { job: fields, ...status } = {}) {
  return jobView({
    job: fields === null
      ? null
      : {
          cacheKey: key,
          descriptor: { sourceId: 'marked-for-later', label: 'Marked for Later', listUrl: '' },
          steps: ['caching'],
          queue: [],
          done: 3,
          total: 37,
          startedAt: NOW - 60_000,
          updatedAt: NOW,
          errors: [],
          errorCount: 0,
          ...fields,
        },
    running: true,
    message: 'Fetching…',
    error: null,
    warnings: [],
    waitingUntil: null,
    waitReason: null,
    ...status,
  }, k => (k === REVIEW ? REVIEW_NAME : 'Marked for Later'), NOW)
}

const IDLE = job(null, { job: null, running: false })

/** The block for the reader `tester`, with the review on, a list tracked, the window stored and no job, unless told otherwise. */
const block = (input = {}) => reviewBlock({ enabled: true, tracking: true, window: WINDOW, userId: 'tester', job: IDLE, now: NOW, ...input })

describe('the review settings', () => {
  test('works per review is a target from 10 to 500', () => {
    assert.deepEqual(WORKS_PER_REVIEW, { min: 10, max: 500 })
  })

  test('the watermark reads as a day, or says nothing is reviewed yet', () => {
    assert.equal(reviewedThroughLabel(0), 'Nothing reviewed yet')
    assert.equal(reviewedThroughLabel(TODAY - 9), formatDay(TODAY - 9))
  })

  test('the latest day the picker offers is yesterday: today isn\'t over', () => {
    assert.equal(latestReviewable(TODAY), isoDay(TODAY - 1))
  })

  test('a typed day is what is written, at most yesterday', () => {
    assert.equal(reviewedThroughFrom(isoDay(TODAY - 9), TODAY), TODAY - 9)
    assert.equal(reviewedThroughFrom(` ${isoDay(TODAY - 9)} `, TODAY), TODAY - 9)
    assert.equal(reviewedThroughFrom(isoDay(TODAY), TODAY), TODAY - 1)
    assert.equal(reviewedThroughFrom(isoDay(TODAY + 30), TODAY), TODAY - 1)
  })

  test('an emptied date starts over: nothing reviewed', () => {
    assert.equal(reviewedThroughFrom('', TODAY), 0)
    assert.equal(reviewedThroughFrom('   ', TODAY), 0)
  })

  test('a date still being typed writes nothing', () => {
    assert.equal(reviewedThroughFrom('2026-09-', TODAY), null)
    assert.equal(reviewedThroughFrom('2026-13-01', TODAY), null)
    assert.equal(reviewedThroughFrom('yesterday', TODAY), null)
  })

  test('with the review on they can be changed; off, they say why not', () => {
    assert.equal(block().settingsOff, null)
    assert.equal(block({ enabled: false }).settingsOff, TRACK_OFF.review)
  })
})

describe('This review', () => {
  test('its count, when it was gathered, and how much of it is cached', () => {
    const view = block({ window: { ...WINDOW, buckets: buckets({ cached: 12, unfetched: 25 }) } })
    assert.deepEqual(view.figure, { count: '37 works', detail: `gathered ${timeAgo(WINDOW.scrapedAt, NOW)} · 12 cached` })
    assert.equal(view.empty, null)
    assert.equal(block({ window: { ...WINDOW, count: 1 } }).figure.count, '1 work')
  })

  test('Start Review opens the review by its open URL, on the reader\'s readings, and says how much it holds', () => {
    assert.deepEqual(block().start, { href: OPEN, label: 'Start the review: 37 works', off: null })
  })

  test('with the reader\'s account not known, Start Review opens it on the page it was gathered on', () => {
    assert.equal(block({ userId: undefined }).start.href, 'https://archiveofourown.org/users/tester/readings#ao3e-open=tracked-review')
  })

  test('with neither, there is nowhere to open it, as with no window', () => {
    assert.deepEqual(block({ userId: undefined, window: { ...WINDOW, listUrl: undefined } }).start, { href: null, label: 'Start the review: 37 works', off: START_OFF.noWindow })
  })

  test('with no job, its offline copy can be cached and downloaded', () => {
    const view = block()
    assert.equal(view.actions, 'offline')
    assert.equal(view.offlineOff, null)
    assert.equal(view.job, false)
  })

  test('More: a retry while any of its works has failed, stale ones included, and a download without refreshing once any is cached', () => {
    const view = block({ window: { ...WINDOW, buckets: buckets({ cached: 12, failed: 2, staleFailures: 1, unfetched: 23 }) } })
    assert.equal(view.retry, 3)
    assert.equal(view.cached, 12)
    assert.equal(block().retry, 0)
    assert.equal(block().cached, 0)
  })

  test('with no window yet, the cell says so and has nothing to cache, and Start Review opens the review on the reader\'s readings, which gathers the first', () => {
    const view = block({ window: null })
    assert.equal(view.figure, null)
    assert.equal(view.empty, 'Nothing gathered yet.')
    assert.equal(view.actions, null)
    assert.equal(view.offlineOff, null)
    assert.equal(view.retry, 0)
    assert.equal(view.cached, 0)
    assert.deepEqual(view.start, { href: OPEN, label: 'Start the review', off: null })
  })

  test('with no window and the reader\'s account not known, there is no page to open: the cell says how the first review is gathered', () => {
    const view = block({ window: null, userId: undefined })
    assert.equal(view.empty, 'Nothing gathered yet: your first review is gathered when you open Tracked on your readings page on AO3.')
    assert.equal(view.actions, null)
    assert.deepEqual(view.start, { href: null, label: 'Start the review', off: START_OFF.noWindow })
    assert.equal(START_OFF.noWindow, 'off until your first review is gathered on AO3')
  })

  test('with Tracked lists off, Start Review is off and says why, and the offline copy still works, More included', () => {
    const view = block({ enabled: false, window: { ...WINDOW, buckets: buckets({ cached: 12, failed: 2, unfetched: 23 }) } })
    assert.deepEqual(view.start, { href: null, label: 'Start the review: 37 works', off: TRACK_OFF.review })
    assert.ok(view.figure)
    assert.equal(view.actions, 'offline')
    assert.equal(view.offlineOff, null)
    assert.equal(view.retry, 2)
    assert.equal(view.cached, 12)
  })

  test('Tracked lists being off comes first, before anything else that keeps Start Review off', () => {
    assert.deepEqual(block({ enabled: false, window: null }).start, { href: null, label: 'Start the review', off: TRACK_OFF.review })
    assert.equal(block({ enabled: false, window: null, userId: undefined }).start.off, TRACK_OFF.review)
    assert.equal(block({ enabled: false, tracking: false }).start.off, TRACK_OFF.review)
  })

  test('with no list tracked, there is nothing to review', () => {
    assert.equal(START_OFF.noneTracked, 'off while no list is tracked')
    assert.deepEqual(block({ tracking: false }).start, { href: null, label: 'Start the review: 37 works', off: START_OFF.noneTracked })
    assert.deepEqual(block({ tracking: false, window: null }).start, { href: null, label: 'Start the review', off: START_OFF.noneTracked })
    assert.equal(block({ tracking: false, window: null, userId: undefined }).start.off, START_OFF.noneTracked)
  })

  test('another list\'s job turns its offline actions off, naming the list; Start Review is untouched', () => {
    const view = block({ job: job(OTHER) })
    assert.equal(view.actions, 'offline')
    assert.equal(view.offlineOff, 'off for now: one job at a time, and Marked for Later is caching')
    assert.equal(view.job, false)
    assert.equal(view.start.href, OPEN)
  })

  test('a stopped or finished job on another list turns nothing off', () => {
    assert.equal(block({ job: job(OTHER, { running: false }) }).offlineOff, null)
    assert.equal(block({ job: job(OTHER, { running: false, job: { steps: [] } }) }).offlineOff, null)
  })

  test('its own job: the line in the cell, and Stop in place of the actions', () => {
    const view = block({ job: job(REVIEW) })
    assert.equal(view.actions, 'stop')
    assert.equal(view.job, true)
    assert.equal(view.offlineOff, null)
    assert.equal(block({ job: job(REVIEW, { waitingUntil: NOW + 5_000, waitReason: 'refused' }) }).actions, 'stop', 'a pause is still running')
  })

  test('its own job, stopped: Continue or Discard', () => {
    const view = block({ job: job(REVIEW, { running: false }) })
    assert.equal(view.actions, 'resume')
    assert.equal(view.job, true)
  })

  test('its own job, finished: the line stays, and the actions are back', () => {
    const view = block({ job: job(REVIEW, { running: false, job: { steps: [] } }) })
    assert.equal(view.actions, 'offline')
    assert.equal(view.job, true)
    assert.equal(view.offlineOff, null)
  })

  test('the job calls it this review, which reads in the other lists\' reasons', () => {
    assert.equal(job(REVIEW).label, 'Caching this review')
    assert.equal(block({ window: { ...WINDOW, key: OTHER }, job: job(REVIEW) }).offlineOff, 'off for now: one job at a time, and this review is caching')
  })
})

describe('Pre-load', () => {
  test('reads the tracked lists ahead whenever the review could be opened, window or not', () => {
    assert.deepEqual(block().preload, { off: null })
    assert.deepEqual(block({ window: null }).preload, { off: null })
  })

  test('off, and says why, with Tracked lists off, with no list tracked, or with nowhere for the review to open', () => {
    assert.deepEqual(block({ enabled: false }).preload, { off: TRACK_OFF.review })
    assert.deepEqual(block({ tracking: false }).preload, { off: START_OFF.noneTracked })
    assert.deepEqual(block({ window: null, userId: undefined }).preload, { off: START_OFF.noWindow })
  })

  test('its job with no window yet: the line in the cell, and Stop in place of Pre-load', () => {
    const view = block({ window: null, job: job(REVIEW) })
    assert.equal(view.job, true)
    assert.equal(view.actions, 'stop')
  })

  test('off while another list has the one job, naming it', () => {
    assert.equal(block({ job: job(OTHER) }).preload.off, block({ job: job(OTHER) }).offlineOff)
    assert.notEqual(block({ job: job(OTHER) }).preload.off, null)
  })
})

describe('the records line', () => {
  test('how far every list is read, and how many are not yet', () => {
    assert.equal(recordsLine({ through: TODAY - 2, behind: 3 }), `Lists read through ${formatDay(TODAY - 2)} · 3 not yet read`)
    assert.equal(recordsLine({ through: TODAY - 2, behind: 0 }), `Lists read through ${formatDay(TODAY - 2)}`)
    assert.equal(recordsLine({ through: null, behind: 1 }), 'No list read yet')
  })

  test('nothing to say with no list tracked', () => {
    assert.equal(recordsLine({ through: null, behind: 0 }), null)
  })
})

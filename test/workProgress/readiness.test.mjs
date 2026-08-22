import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createDefaultMarks, packIds, packProgress } from '../../src/common/workMarks.ts'
// workProgress.ts imports only workMarks.ts, which is itself import-free — so
// the pair loads bare under Node's type stripping, with no build and no DOM.
import {
  addMonths,
  describeProgress,
  describeUnread,
  describeWaitUntil,
  findProgress,
  formatEpochDays,
  fromEpochDays,
  hiddenLabel,
  progressSources,
  readiness,
  READINESS_LABELS,
  todayEpochDays,
  toEpochDays,
  unreadRange,
} from '../../src/common/workProgress.ts'

const TODAY = toEpochDays('2026-03-14')

describe('epoch days', () => {
  test('a date-input value round-trips', () => {
    assert.equal(fromEpochDays(toEpochDays('2026-03-14')), '2026-03-14')
    assert.equal(fromEpochDays(toEpochDays('1970-01-01')), '1970-01-01')
    assert.equal(toEpochDays('1970-01-01'), 0)
  })

  test('anything that is not YYYY-MM-DD is null', () => {
    for (const bad of ['', '  ', '14/3/2026', '2026-3-14', '2026-13-01', '2026-01-32', 'tomorrow'])
      assert.equal(toEpochDays(bad), null, bad)
  })

  test('today is read off the local calendar, not off UTC', () => {
    // A timestamp late on the 14th in a zone behind UTC is still the 14th; going
    // through Date.UTC on the *local* parts is what keeps it there.
    const lateEvening = new Date(2026, 2, 14, 23, 30)
    const earlyMorning = new Date(2026, 2, 14, 0, 30)
    assert.equal(todayEpochDays(lateEvening), TODAY)
    assert.equal(todayEpochDays(earlyMorning), TODAY)
  })

  test('formatting is M/d/yy, with no timezone drift', () => {
    assert.equal(formatEpochDays(TODAY), '3/14/26')
    assert.equal(formatEpochDays(toEpochDays('2026-01-01')), '1/1/26')
    assert.equal(formatEpochDays(toEpochDays('2025-12-31')), '12/31/25')
    assert.equal(formatEpochDays(toEpochDays('2026-11-09')), '11/9/26')
  })

  test('a month is a month, clamped at the end of a short one', () => {
    assert.equal(fromEpochDays(addMonths(toEpochDays('2026-03-14'), 1)), '2026-04-14')
    assert.equal(fromEpochDays(addMonths(toEpochDays('2026-03-14'), 3)), '2026-06-14')
    assert.equal(fromEpochDays(addMonths(toEpochDays('2026-01-31'), 1)), '2026-02-28')
    assert.equal(fromEpochDays(addMonths(toEpochDays('2026-12-15'), 1)), '2027-01-15')
  })
})

describe('readiness', () => {
  test('unread chapters and no date: ready', () => {
    assert.equal(readiness({ chapter: 7 }, 9, TODAY), 'ready')
  })

  test('level with what is published: caught up', () => {
    assert.equal(readiness({ chapter: 9 }, 9, TODAY), 'caughtUp')
  })

  test('past what is published (the work was trimmed): still caught up', () => {
    assert.equal(readiness({ chapter: 12 }, 9, TODAY), 'caughtUp')
  })

  test('a future date wins even with chapters to read', () => {
    assert.equal(readiness({ chapter: 7, waitUntil: TODAY + 1 }, 9, TODAY), 'waiting')
  })

  test('a date of exactly today has come round', () => {
    assert.equal(readiness({ chapter: 7, waitUntil: TODAY }, 9, TODAY), 'ready')
  })

  test('a passed date does not by itself make a caught-up work ready', () => {
    assert.equal(readiness({ chapter: 9, waitUntil: TODAY - 30 }, 9, TODAY), 'caughtUp')
  })

  test('zero published chapters is caught up, not ready', () => {
    assert.equal(readiness({ chapter: 0 }, 0, TODAY), 'caughtUp')
  })

  test('an unreadable chapter count fails open', () => {
    // A series blurb, or a work with no dd.chapters: not knowing is not evidence
    // there is nothing new, so the work is shown.
    assert.equal(readiness({ chapter: 9 }, null, TODAY), 'ready')
    assert.equal(readiness(undefined, null, TODAY), 'ready')
  })

  test('...but a date the reader typed themselves still stands', () => {
    assert.equal(readiness({ chapter: 9, waitUntil: TODAY + 1 }, null, TODAY), 'waiting')
  })

  test('no recorded progress at all reads as "nothing read yet"', () => {
    assert.equal(readiness(undefined, 9, TODAY), 'ready')
    assert.equal(readiness(undefined, 0, TODAY), 'caughtUp')
  })
})

describe('unreadRange', () => {
  test('the chapters after where you stopped, up to what is published', () => {
    assert.deepEqual(unreadRange({ chapter: 6 }, 9), { from: 7, to: 9 })
  })

  test('one chapter behind is a range of one', () => {
    assert.deepEqual(unreadRange({ chapter: 8 }, 9), { from: 9, to: 9 })
  })

  test('nothing owed when level, past, or unknown', () => {
    assert.equal(unreadRange({ chapter: 9 }, 9), null)
    assert.equal(unreadRange({ chapter: 12 }, 9), null)
    assert.equal(unreadRange({ chapter: 0 }, 0), null)
    assert.equal(unreadRange({ chapter: 3 }, null), null)
  })
})

describe('the hint text', () => {
  test('plural, singular, and none', () => {
    assert.equal(describeUnread({ chapter: 6 }, 9), 'Unread: chapters 7-9')
    assert.equal(describeUnread({ chapter: 8 }, 9), 'Unread: chapter 9')
    assert.equal(describeUnread({ chapter: 9 }, 9), 'No unread chapters')
    assert.equal(describeUnread({ chapter: 9 }, null), 'No unread chapters')
  })

  test('what the wait-until date says', () => {
    assert.equal(describeWaitUntil({ chapter: 1 }, TODAY), 'Ready (no Wait Until date set)')
    assert.equal(
      describeWaitUntil({ chapter: 1, waitUntil: TODAY }, TODAY),
      'Ready (passed Wait Until date 3/14/26)',
      'a date that has come round today counts as passed',
    )
    assert.equal(
      describeWaitUntil({ chapter: 1, waitUntil: toEpochDays('2026-03-13') }, TODAY),
      'Ready (passed Wait Until date 3/13/26)',
    )
    assert.equal(
      describeWaitUntil({ chapter: 1, waitUntil: toEpochDays('2026-03-15') }, TODAY),
      'Not Ready (wait until 3/15/26)',
    )
  })

  test('both lines, newline-joined', () => {
    assert.equal(
      describeProgress({ chapter: 6, waitUntil: toEpochDays('2026-03-14') }, 9, TODAY),
      'Unread: chapters 7-9\nReady (passed Wait Until date 3/14/26)',
    )
  })

  test('the collapsed-row label names the mark and the reason', () => {
    assert.equal(hiddenLabel('waiting'), 'Ongoing (Not Ready)')
    assert.equal(hiddenLabel('caughtUp'), 'Ongoing (No unread chapters)')
    assert.equal(hiddenLabel('waiting', 'In progress'), 'In progress (Not Ready)')
  })

  test('the facet labels are the three states spelled out', () => {
    assert.deepEqual(READINESS_LABELS, { ready: 'Ready', waiting: 'Waiting', caughtUp: 'Caught up' })
  })
})

describe('reading the mark table', () => {
  function tableWith(entries) {
    const marks = createDefaultMarks()
    marks.continue.items = packIds(Object.keys(entries))
    marks.continue.progress = packProgress(Object.entries(entries))
    return marks
  }

  test('progressSources unpacks each tracking mark once', () => {
    const sources = progressSources(tableWith({ 7: { chapter: 3 }, 9: { chapter: 1 } }))
    assert.equal(sources.length, 1)
    assert.equal(sources[0].id, 'continue')
    assert.deepEqual([...sources[0].entries.keys()], ['7', '9'])
  })

  test('an empty mark contributes no source at all', () => {
    assert.deepEqual(progressSources(createDefaultMarks()), [])
  })

  test('findProgress answers "is this work ongoing, and where am I?"', () => {
    const sources = progressSources(tableWith({ 7: { chapter: 3 } }))
    assert.deepEqual(findProgress(sources, '7'), { id: 'continue', progress: { chapter: 3 } })
    assert.equal(findProgress(sources, '404'), null)
    assert.equal(findProgress([], '7'), null, 'no tracking mark ⇒ a clean no-op')
  })
})

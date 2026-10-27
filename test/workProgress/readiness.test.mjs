import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createDefaultMarks, packIds, packProgress } from '../../src/common/workMarks.ts'
// workProgress.ts imports only workMarks.ts, which is itself import-free — so
// the pair loads bare under Node's type stripping, with no build and no DOM.
import {
  addMonths,
  applyDatePreset,
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

describe('the wait-until presets', () => {
  const day = text => toEpochDays(text)
  const press = (field, ...shifts) => {
    let run = null
    let value = field
    for (const shift of shifts) {
      run = applyDatePreset(value, TODAY, shift, run)
      value = run.value
    }
    return fromEpochDays(value)
  }
  const WEEK = { months: 0, days: 7 }
  const MONTH = { months: 1, days: 0 }
  const QUARTER = { months: 3, days: 0 }

  test('one press moves the field on from today', () => {
    assert.equal(press(TODAY, WEEK), '2026-03-21')
    assert.equal(press(TODAY, QUARTER), '2026-06-14')
  })

  test('pressing again adds again', () => {
    assert.equal(press(TODAY, QUARTER, QUARTER), '2026-09-14')
    assert.equal(press(TODAY, WEEK, WEEK, WEEK), '2026-04-04')
    assert.equal(press(TODAY, MONTH, WEEK), '2026-04-21')
  })

  test('stacked months land where the total would, not where a short month clamped them', () => {
    // 30 Nov + 3 months clamps to 28 Feb; another 3 from there would be 28 May.
    const NOV_30 = day('2026-11-30')
    const run = applyDatePreset(NOV_30, NOV_30, QUARTER, null)
    assert.equal(fromEpochDays(run.value), '2027-02-28')
    assert.equal(fromEpochDays(applyDatePreset(run.value, NOV_30, QUARTER, run).value), '2027-05-30')
  })

  test('a date the reader typed starts a new run from that date', () => {
    const run = applyDatePreset(TODAY, TODAY, QUARTER, null)
    assert.equal(fromEpochDays(applyDatePreset(day('2026-07-01'), TODAY, MONTH, run).value), '2026-08-01')
  })

  test('an existing future date is moved on from, not replaced', () => {
    assert.equal(press(day('2026-05-02'), MONTH), '2026-06-02')
  })

  test('an empty or past field starts from today', () => {
    assert.equal(press(null, WEEK), '2026-03-21')
    assert.equal(press(day('2025-12-25'), WEEK), '2026-03-21')
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
  /** The numbers `text` gives, in order. */
  const numbers = text => (text.match(/\d+/g) ?? []).map(Number)

  test('the chapters unread, first to last, a single one once, and none', () => {
    assert.deepEqual(numbers(describeUnread({ chapter: 6 }, 9)), [7, 9])
    assert.deepEqual(numbers(describeUnread({ chapter: 8 }, 9)), [9])
    assert.deepEqual(numbers(describeUnread({ chapter: 9 }, 9)), [])
    assert.equal(describeUnread({ chapter: 9 }, null), describeUnread({ chapter: 9 }, 9), 'an unknown count has nothing unread either')
    assert.notEqual(describeUnread({ chapter: 6 }, 9).replace(/\d+/g, '#'), describeUnread({ chapter: 8 }, 9).replace(/\d+/g, '#'), 'one chapter is not said as a range')
  })

  test('what the wait-until date says', () => {
    /** The line with its date taken out, to compare what it says of the date. */
    const verdict = (waitUntil) => {
      const line = describeWaitUntil({ chapter: 1, waitUntil }, TODAY)
      assert.ok(line.includes(formatEpochDays(waitUntil)), `${line} should give the date`)
      return line.replace(formatEpochDays(waitUntil), '')
    }
    const none = describeWaitUntil({ chapter: 1 }, TODAY)
    assert.deepEqual(numbers(none), [], 'no date to give')
    assert.equal(verdict(TODAY), verdict(toEpochDays('2026-03-13')), 'a date that has come round today counts as passed')
    assert.notEqual(verdict(toEpochDays('2026-03-15')), verdict(TODAY), 'a date still to come is not')
  })

  test('both lines, newline-joined', () => {
    const progress = { chapter: 6, waitUntil: toEpochDays('2026-03-14') }
    assert.equal(
      describeProgress(progress, 9, TODAY),
      `${describeUnread(progress, 9)}\n${describeWaitUntil(progress, TODAY)}`,
    )
  })

  test('the collapsed-row label names the mark, and tells the two states apart', () => {
    assert.ok(hiddenLabel('waiting', 'In progress').includes('In progress'))
    assert.ok(hiddenLabel('caughtUp', 'In progress').includes('In progress'))
    assert.notEqual(hiddenLabel('waiting', 'In progress'), hiddenLabel('caughtUp', 'In progress'))
  })

  test('the facet has a label for each of the three states', () => {
    assert.deepEqual(Object.keys(READINESS_LABELS).sort(), ['caughtUp', 'ready', 'waiting'])
    assert.equal(new Set(Object.values(READINESS_LABELS)).size, 3, 'each told apart')
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

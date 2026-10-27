import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { formatMoment, NEVER, RECENT_DAY, timeAgo } from '../../src/options_ui/model/moments.ts'

const NOW = new Date(2026, 9, 3, 18, 4).getTime()

const time = at => new Date(at).toLocaleTimeString(undefined, { timeStyle: 'short' })
const dated = at => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** `at`, as `now` writes it: named by its day, `today` or `yesterday`, in place of its date, and its time. */
function namesDay(at, now, day) {
  const text = formatMoment(at, now)
  assert.ok(text.includes(RECENT_DAY[day]), `${text} should name the day`)
  assert.ok(text.includes(time(at)), `${text} should give the time`)
  assert.notEqual(text, dated(at))
}

describe('formatMoment', () => {
  test('is a medium date and a short time', () => {
    const at = new Date(2026, 9, 1, 18, 46).getTime()
    assert.equal(formatMoment(at), dated(at))
  })

  test('without a now, names no day, however recent', () => {
    assert.equal(formatMoment(NOW - 60000), dated(NOW - 60000))
  })

  test('names today, from its first minute', () => {
    const afternoon = new Date(2026, 9, 3, 14, 46).getTime()
    const midnight = new Date(2026, 9, 3, 0, 0).getTime()
    namesDay(afternoon, NOW, 'today')
    namesDay(midnight, NOW, 'today')
  })

  test('names yesterday, to its last minute', () => {
    const evening = new Date(2026, 9, 2, 18, 46).getTime()
    const late = new Date(2026, 9, 2, 23, 59).getTime()
    namesDay(evening, NOW, 'yesterday')
    namesDay(late, NOW, 'yesterday')
  })

  test('yesterday is the calendar day before, across a month\'s end', () => {
    const now = new Date(2026, 10, 1, 0, 30).getTime()
    const at = new Date(2026, 9, 31, 23, 50).getTime()
    namesDay(at, now, 'yesterday')
  })

  test('dates anything older', () => {
    const at = new Date(2026, 9, 1, 23, 59).getTime()
    assert.equal(formatMoment(at, NOW), dated(at))
  })

  test('dates a moment on a later day, as a clock set wrong gives', () => {
    const at = new Date(2026, 9, 4, 9, 0).getTime()
    assert.equal(formatMoment(at, NOW), dated(at))
  })
})

describe('timeAgo', () => {
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const MINUTE = 60_000
  const DAY = 24 * 60 * MINUTE

  test('says how long ago, in the largest unit that holds it', () => {
    assert.equal(timeAgo(NOW - 30_000, NOW), relative.format(-30, 'second'))
    assert.equal(timeAgo(NOW - 22 * MINUTE, NOW), relative.format(-22, 'minute'))
    assert.equal(timeAgo(NOW - 3 * 60 * MINUTE, NOW), relative.format(-3, 'hour'))
    assert.equal(timeAgo(NOW - 2 * DAY, NOW), relative.format(-2, 'day'))
    assert.equal(timeAgo(NOW - 14 * DAY, NOW), relative.format(-2, 'week'))
    assert.equal(timeAgo(NOW - 91 * DAY, NOW), relative.format(-3, 'month'))
    assert.equal(timeAgo(NOW - 730 * DAY, NOW), relative.format(-2, 'year'))
  })

  test('in words where a number would read oddly', () => {
    assert.equal(timeAgo(NOW, NOW), relative.format(0, 'second'))
    assert.equal(timeAgo(NOW - DAY, NOW), relative.format(-1, 'day'))
  })

  test('a moment that never happened is never', () => {
    assert.equal(timeAgo(0, NOW), NEVER)
  })
})

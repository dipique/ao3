import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { formatMoment } from '../../src/options_ui/model/moments.ts'

const NOW = new Date(2026, 9, 3, 18, 4).getTime()

const time = at => new Date(at).toLocaleTimeString(undefined, { timeStyle: 'short' })
const dated = at => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

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
    assert.equal(formatMoment(afternoon, NOW), `Today, ${time(afternoon)}`)
    assert.equal(formatMoment(midnight, NOW), `Today, ${time(midnight)}`)
  })

  test('names yesterday, to its last minute', () => {
    const evening = new Date(2026, 9, 2, 18, 46).getTime()
    const late = new Date(2026, 9, 2, 23, 59).getTime()
    assert.equal(formatMoment(evening, NOW), `Yesterday, ${time(evening)}`)
    assert.equal(formatMoment(late, NOW), `Yesterday, ${time(late)}`)
  })

  test('yesterday is the calendar day before, across a month\'s end', () => {
    const now = new Date(2026, 10, 1, 0, 30).getTime()
    const at = new Date(2026, 9, 31, 23, 50).getTime()
    assert.equal(formatMoment(at, now), `Yesterday, ${time(at)}`)
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

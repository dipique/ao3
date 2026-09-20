import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// Node strips the TS types on import; trackedLists.ts imports nothing at all,
// so it loads without a build, a DOM, or the extension APIs.
import { dayOf, formatDay, isoDay, utcToday } from '../../src/common/trackedLists.ts'

const MS_PER_DAY = 86_400_000

describe('dayOf', () => {
  test('reads a blurb date as that UTC calendar day', () => {
    assert.equal(dayOf('19 Jun 2012'), Date.UTC(2012, 5, 19) / MS_PER_DAY)
    assert.equal(dayOf('01 Jan 1970'), 0)
  })

  test('takes the day zero-padded or not, and the month in any case', () => {
    assert.equal(dayOf('05 Sep 2026'), dayOf('5 Sep 2026'))
    assert.equal(dayOf('5 sep 2026'), dayOf('5 Sep 2026'))
  })

  test('ignores whitespace around and between the parts', () => {
    assert.equal(dayOf('  19   Jun 2012\n'), dayOf('19 Jun 2012'))
  })

  test('returns null for anything that is not a blurb date', () => {
    for (const text of ['', 'yesterday', '2012-06-19', '19 June 2012', 'Jun 19 2012', '19 Jun 12', '19 Jux 2012'])
      assert.equal(dayOf(text), null, text)
    assert.equal(dayOf(undefined), null)
  })

  test('returns null for a date that does not exist', () => {
    assert.equal(dayOf('31 Feb 2026'), null)
    assert.equal(dayOf('0 Mar 2026'), null)
    assert.equal(dayOf('29 Feb 2025'), null)
    assert.equal(dayOf('29 Feb 2024'), Date.UTC(2024, 1, 29) / MS_PER_DAY)
  })
})

describe('utcToday', () => {
  test('is the UTC calendar day, changing exactly at UTC midnight', () => {
    const midnight = Date.UTC(2026, 8, 19)
    assert.equal(utcToday(midnight - 1), dayOf('18 Sep 2026'))
    assert.equal(utcToday(midnight), dayOf('19 Sep 2026'))
    assert.equal(utcToday(midnight + MS_PER_DAY - 1), dayOf('19 Sep 2026'))
  })

  test('takes a Date as well as epoch milliseconds', () => {
    assert.equal(utcToday(new Date(Date.UTC(2026, 8, 19, 23, 59))), dayOf('19 Sep 2026'))
  })

  test('defaults to now', () => {
    const before = Math.floor(Date.now() / MS_PER_DAY)
    const now = utcToday()
    const after = Math.floor(Date.now() / MS_PER_DAY)
    assert.ok(now === before || now === after)
  })
})

describe('isoDay / formatDay', () => {
  test('isoDay writes the YYYY-MM-DD the date filter takes', () => {
    assert.equal(isoDay(dayOf('19 Jun 2012')), '2012-06-19')
    assert.equal(isoDay(dayOf('5 Sep 2026')), '2026-09-05')
    assert.equal(isoDay(0), '1970-01-01')
  })

  test('formatDay writes a day the way a blurb does, zero-padded', () => {
    assert.equal(formatDay(dayOf('12 Sep 2026')), '12 Sep 2026')
    assert.equal(formatDay(dayOf('5 Sep 2026')), '05 Sep 2026')
  })

  test('formatDay round-trips through dayOf', () => {
    for (let day = dayOf('1 Jan 2024'); day <= dayOf('31 Dec 2024'); day += 7)
      assert.equal(dayOf(formatDay(day)), day)
  })
})

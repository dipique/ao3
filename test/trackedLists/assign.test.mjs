import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { dayOf, reviewStart } from '../../src/common/trackedLists.ts'

const START = dayOf('10 Sep 2026')

describe('reviewStart', () => {
  const list = (since, tracked = true) => ({ id: String(since), kind: 'series-works', url: '/series/1', alias: '', tracked, since })

  test('with no review history, starts on the day the first list was tracked', () => {
    assert.equal(reviewStart({ reviewedThrough: 0, lists: [list(START + 4), list(START)] }), START)
  })

  test('with a watermark, starts the day after it', () => {
    assert.equal(reviewStart({ reviewedThrough: START + 2, lists: [list(START)] }), START + 3)
  })

  test('never starts before every tracked list began', () => {
    assert.equal(reviewStart({ reviewedThrough: START, lists: [list(START + 5), list(START + 7)] }), START + 5)
  })

  test('paused lists do not count', () => {
    assert.equal(reviewStart({ reviewedThrough: 0, lists: [list(START - 30, false), list(START)] }), START)
  })

  test('ignores a since or watermark that is not a whole number', () => {
    assert.equal(reviewStart({ reviewedThrough: Number.NaN, lists: [list(Number.NaN), list(START)] }), START)
    assert.equal(reviewStart({ reviewedThrough: START, lists: [] }), START + 1)
  })
})

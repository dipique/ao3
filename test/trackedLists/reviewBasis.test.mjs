import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { dayOf, reviewBasis, sameReviewBasis } from '../../src/common/trackedLists.ts'

const SINCE = dayOf('1 Sep 2026')

function list(id, extra = {}) {
  return { id, kind: 'tag-works', url: `https://archiveofourown.org/tags/${id}/works`, alias: id, tracked: true, since: SINCE, ...extra }
}

function option(extra = {}) {
  return { enabled: true, target: 50, reviewedThrough: dayOf('29 Sep 2026'), lists: [list('a'), list('b')], ...extra }
}

describe('reviewBasis', () => {
  test('a window answers to the options it was gathered against', () => {
    assert.ok(sameReviewBasis(reviewBasis(option()), option()))
  })

  test('a window sized to one target doesn’t answer to another', () => {
    const stored = reviewBasis(option({ target: 50 }))
    assert.equal(sameReviewBasis(stored, option({ target: 10 })), false)
  })

  test('a window stored without its target doesn’t answer to any', () => {
    const { target: _, ...stored } = reviewBasis(option())
    assert.equal(sameReviewBasis(stored, option()), false)
  })

  test('a moved watermark makes it stale', () => {
    const stored = reviewBasis(option())
    assert.equal(sameReviewBasis(stored, option({ reviewedThrough: dayOf('30 Sep 2026') })), false)
  })

  test('a watermark that isn’t a day reads as nothing reviewed, on both sides', () => {
    const stored = reviewBasis(option({ reviewedThrough: Number.NaN }))
    assert.ok(sameReviewBasis(stored, option({ reviewedThrough: 0 })))
  })

  test('a list tracked, removed or re-addressed makes it stale', () => {
    const stored = reviewBasis(option())
    assert.equal(sameReviewBasis(stored, option({ lists: [list('a')] })), false)
    assert.equal(sameReviewBasis(stored, option({ lists: [list('a'), list('b'), list('c')] })), false)
    assert.equal(sameReviewBasis(stored, option({ lists: [list('a'), list('b', { url: 'https://archiveofourown.org/tags/x/works' })] })), false)
  })

  test('a changed view filter makes it stale', () => {
    const stored = reviewBasis(option())
    const filtered = list('b', { filter: { text: 'slow burn' } })
    assert.equal(sameReviewBasis(stored, option({ lists: [list('a'), filtered] })), false)
  })

  test('a renamed list doesn’t', () => {
    const stored = reviewBasis(option())
    assert.ok(sameReviewBasis(stored, option({ lists: [list('a', { alias: 'Renamed' }), list('b')] })))
  })

  test('an entry that isn’t tracked doesn’t take part', () => {
    const stored = reviewBasis(option())
    assert.ok(sameReviewBasis(stored, option({ lists: [list('a'), list('b'), list('c', { tracked: false })] })))
  })
})

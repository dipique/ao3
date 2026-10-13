import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { CLAIM_TTL_MS, claimWait, dayOf, reviewBasis, reviewClaim } from '../../src/common/trackedLists.ts'

const SINCE = dayOf('1 Sep 2026')
const NOW = Date.UTC(2026, 9, 1, 12)

function list(id, extra = {}) {
  return { id, kind: 'tag-works', url: `https://archiveofourown.org/tags/${id}/works`, alias: id, tracked: true, since: SINCE, ...extra }
}

function option(extra = {}) {
  return { enabled: true, target: 50, reviewedThrough: dayOf('29 Sep 2026'), lists: [list('a'), list('b')], ...extra }
}

/** The stored window's facts, gathered against `against` (or never gathered). */
function stored(against, computedAt = NOW - 60_000) {
  return { ...reviewBasis(against), computedAt }
}

const OLD = option()
const NEXT = option({ reviewedThrough: dayOf('1 Oct 2026') })

describe('claimWait', () => {
  test('nobody else gathering: gather it here', () => {
    assert.equal(claimWait(stored(OLD), { ...reviewClaim(NEXT, 'other', NOW), at: 0 }, NEXT, 'me', NOW), 'gather')
  })

  test('another page run gathering this window: wait for it', () => {
    assert.equal(claimWait(stored(OLD), reviewClaim(NEXT, 'other', NOW), NEXT, 'me', NOW + 1000), 'waiting')
  })

  test('this page run’s own claim is no reason to wait', () => {
    assert.equal(claimWait(stored(OLD), reviewClaim(NEXT, 'me', NOW), NEXT, 'me', NOW), 'gather')
  })

  test('the window it was gathering has landed', () => {
    assert.equal(claimWait(stored(NEXT), reviewClaim(NEXT, 'other', NOW), NEXT, 'me', NOW), 'landed')
  })

  test('a window that has landed counts even once the claim is withdrawn', () => {
    assert.equal(claimWait(stored(NEXT), { ...reviewClaim(NEXT, 'other', NOW), at: 0 }, NEXT, 'me', NOW), 'landed')
  })

  test('the empty store, never gathered, has not landed', () => {
    assert.equal(claimWait(stored(NEXT, 0), reviewClaim(NEXT, 'other', NOW), NEXT, 'me', NOW), 'waiting')
  })

  test('a claim on another basis holds nobody', () => {
    assert.equal(claimWait(stored(OLD), reviewClaim(NEXT, 'other', NOW), option({ target: 10, reviewedThrough: NEXT.reviewedThrough }), 'me', NOW), 'gather')
    assert.equal(claimWait(stored(OLD), reviewClaim(OLD, 'other', NOW), NEXT, 'me', NOW), 'gather')
  })

  test('a claim left unrenewed lapses: its tab went away', () => {
    const claim = reviewClaim(NEXT, 'other', NOW)
    assert.equal(claimWait(stored(OLD), claim, NEXT, 'me', NOW + CLAIM_TTL_MS - 1), 'waiting')
    assert.equal(claimWait(stored(OLD), claim, NEXT, 'me', NOW + CLAIM_TTL_MS), 'gather')
  })

  test('a claim dated far ahead of the clock holds nobody either', () => {
    assert.equal(claimWait(stored(OLD), reviewClaim(NEXT, 'other', NOW + CLAIM_TTL_MS), NEXT, 'me', NOW), 'gather')
  })

  test('a claim missing what it should hold holds nobody', () => {
    assert.equal(claimWait(stored(OLD), {}, NEXT, 'me', NOW), 'gather')
    assert.equal(claimWait(stored(OLD), { ...reviewClaim(NEXT, 'other', NOW), at: Number.NaN }, NEXT, 'me', NOW), 'gather')
  })
})

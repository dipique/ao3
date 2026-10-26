import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { CLAIM_RENEW_MS, CLAIM_TTL_MS, claimHolder, readClaim } from '../../src/common/trackedReads.ts'

const NOW = Date.UTC(2026, 9, 1, 12)

describe('claimHolder', () => {
  test('nobody has claimed: free', () => {
    assert.equal(claimHolder(undefined, 'me', NOW), 'free')
    assert.equal(claimHolder({ by: '', at: 0 }, 'me', NOW), 'free')
  })

  test('another page run reading: other', () => {
    assert.equal(claimHolder(readClaim('other', NOW), 'me', NOW + 1000), 'other')
  })

  test('this page run’s own claim: self', () => {
    assert.equal(claimHolder(readClaim('me', NOW), 'me', NOW), 'self')
  })

  test('a withdrawn claim holds nobody', () => {
    assert.equal(claimHolder({ ...readClaim('other', NOW), at: 0 }, 'me', NOW), 'free')
  })

  test('a claim left unrenewed lapses: its page went away', () => {
    const claim = readClaim('other', NOW)
    assert.equal(claimHolder(claim, 'me', NOW + CLAIM_TTL_MS - 1), 'other')
    assert.equal(claimHolder(claim, 'me', NOW + CLAIM_TTL_MS), 'free')
  })

  test('measured either way round, since the claim is another page’s clock', () => {
    assert.equal(claimHolder(readClaim('other', NOW + CLAIM_TTL_MS - 1), 'me', NOW), 'other')
    assert.equal(claimHolder(readClaim('other', NOW + CLAIM_TTL_MS), 'me', NOW), 'free')
  })

  test('anything malformed holds nobody', () => {
    for (const junk of [null, {}, { by: 'other', at: 'x' }, { by: 'other', at: -5 }])
      assert.equal(claimHolder(junk, 'me', NOW), 'free')
  })

  test('renewed well inside the time it holds for', () => {
    assert.ok(CLAIM_RENEW_MS * 2 < CLAIM_TTL_MS)
  })
})

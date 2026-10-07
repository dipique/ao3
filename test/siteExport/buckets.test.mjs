import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { cachingBuckets } from '../../src/content_script/siteExport/workText.ts'

const AT = Date.UTC(2026, 8, 7)

/** A cache entry holding text, unless `size` says otherwise. */
function meta(over = {}) {
  return { size: 1000, updatedAt: 0, chapters: 1, words: 500, fetchedAt: AT, v: 1, ...over }
}

/** Every bucket must be there, and the three a work can be in must add up to the list. */
function buckets(workIds, index) {
  const got = cachingBuckets(workIds, index)
  assert.equal(got.cached + got.failed + got.unfetched, got.total, 'cached, failed and new add up to the list')
  return got
}

/**
 * How much of one stored list is cached, as three buckets every work is in
 * exactly one of: cached (its text is here), failed (it isn't, and the last
 * try failed) and new (nothing was ever fetched). A cached work whose latest
 * refetch failed is still cached, and counted again as a stale failure, since
 * the copy it has is the one from before.
 */
describe('cachingBuckets', () => {
  test('each work is in one bucket, and the buckets add up to the list', () => {
    const got = buckets(['1', '2', '3', '4'], {
      1: meta({ size: 300 }),
      2: meta({ size: 0, failure: 'restricted', attempts: 1 }),
      4: meta({ size: 700 }),
    })
    assert.deepEqual(got, { total: 4, cached: 2, failed: 1, unfetched: 1, bytes: 1000, staleFailures: 0 })
  })

  test('a cached work whose refetch failed is cached, and a stale failure', () => {
    const got = buckets(['1', '2'], {
      1: meta({ size: 400, failure: 'error', attempts: 2 }),
      2: meta({ size: 0, failure: 'notfound', attempts: 1 }),
    })
    assert.equal(got.cached, 1)
    assert.equal(got.failed, 1, 'only the work with no text at all is failed')
    assert.equal(got.staleFailures, 1)
    assert.equal(got.bytes, 400, 'the copy from before still counts')
  })

  test('purged means new: a work with no entry was never fetched', () => {
    assert.deepEqual(buckets(['1', '2'], {}), { total: 2, cached: 0, failed: 0, unfetched: 2, bytes: 0, staleFailures: 0 })
  })

  test('an entry with no text and no failure is new too', () => {
    assert.equal(buckets(['1'], { 1: meta({ size: 0 }) }).unfetched, 1)
  })

  test('only the list\'s own works count, each once', () => {
    const got = buckets(['1', '1', '2'], { 1: meta({ size: 300 }), 9: meta({ size: 5000 }) })
    assert.deepEqual(got, { total: 2, cached: 1, failed: 0, unfetched: 1, bytes: 300, staleFailures: 0 })
  })

  test('an empty list is all zeros', () => {
    assert.deepEqual(buckets([], { 1: meta() }), { total: 0, cached: 0, failed: 0, unfetched: 0, bytes: 0, staleFailures: 0 })
  })
})

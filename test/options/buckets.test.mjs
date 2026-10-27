import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { bucketBar, bucketFigures, formatBytes } from '../../src/options_ui/model/buckets.ts'
import { figures, mentions } from '../facts.mjs'

const MB = 1024 * 1024

/** A list's works sorted into the cache's buckets: 240 works, 205 cached, 6 failed, 29 new. */
const buckets = (fields = {}) => ({ total: 240, cached: 205, failed: 6, unfetched: 29, bytes: 6.9 * MB, staleFailures: 0, ...fields })

describe('formatBytes', () => {
  test('bytes at a readable scale', () => {
    assert.equal(formatBytes(0), '0 B')
    assert.equal(formatBytes(1023), '1023 B')
    assert.equal(formatBytes(1024), '1.0 kB')
    assert.equal(formatBytes(264 * 1024), '264 kB')
    assert.equal(formatBytes(6.9 * MB), '6.9 MB')
    assert.equal(formatBytes(12 * MB), '12 MB')
    assert.equal(formatBytes(3 * 1024 * MB), '3.0 GB')
  })
})

describe('bucketBar', () => {
  /** The tooltip's figures, a line each. */
  const tipFigures = bar => bar.tip.split('\n').map(line => figures(line))

  test('the cached and failed works as parts of the bar, the new ones the rest of it', () => {
    const bar = bucketBar(buckets())
    assert.equal(bar.cached, 85.4)
    assert.equal(bar.failed, 2.5)
  })

  test('named for every bucket, and its tooltip one bucket a line', () => {
    const bar = bucketBar(buckets())
    assert.deepEqual(figures(bar.label), [6, 29, 205, 240])
    assert.deepEqual(tipFigures(bar), [[205], [6], [29], [240]], 'cached, failed, new, and the whole')
  })

  test('a cached work whose refetch failed is drawn as cached: its text is here', () => {
    const bar = bucketBar(buckets({ staleFailures: 4 }))
    assert.equal(bar.cached, 85.4)
    assert.equal(bar.failed, 2.5)
    assert.equal(bar.label, bucketBar(buckets()).label)
  })

  test('nothing cached yet: an empty bar', () => {
    const bar = bucketBar(buckets({ total: 620, cached: 0, failed: 0, unfetched: 620, bytes: 0 }))
    assert.equal(bar.cached, 0)
    assert.equal(bar.failed, 0)
    assert.deepEqual(figures(bar.label), [0, 0, 620, 620])
  })

  test('an empty list draws nothing, rather than dividing by nothing', () => {
    const bar = bucketBar(buckets({ total: 0, cached: 0, failed: 0, unfetched: 0, bytes: 0 }))
    assert.equal(bar.cached, 0)
    assert.equal(bar.failed, 0)
    assert.deepEqual(figures(bar.label), [0, 0, 0, 0])
  })

  test('figures in the thousands', () => {
    const big = bucketBar(buckets({ total: 2400, cached: 1205, failed: 0, unfetched: 1195 }))
    assert.deepEqual(figures(big.label), [0, 1195, 1205, 2400])
    for (const n of [1205, 2400, 1195])
      assert.ok(mentions(big.label, n.toLocaleString()) && mentions(big.tip, n.toLocaleString()), `${n} grouped by thousands`)
    assert.deepEqual(tipFigures(big), [[1205], [0], [1195], [2400]])
  })
})

describe('bucketFigures', () => {
  test('what is cached and its size, and what isn\'t, the failures among it', () => {
    assert.deepEqual(bucketFigures(buckets()), { cached: '205', size: '6.9 MB', uncached: '35', failed: '6' })
  })

  test('no failures, no failure figure', () => {
    assert.deepEqual(bucketFigures(buckets({ total: 620, cached: 0, failed: 0, unfetched: 620, bytes: 0 })), { cached: '0', size: '0 B', uncached: '620', failed: null })
  })

  test('everything cached: nothing to say is uncached', () => {
    assert.deepEqual(bucketFigures(buckets({ cached: 240, failed: 0, unfetched: 0, staleFailures: 3 })), { cached: '240', size: '6.9 MB', uncached: null, failed: null })
  })
})

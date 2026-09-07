import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// Node strips the TS types on import; workText.ts is pure (no `#common`, no
// `browser`, no DOM, no imports at all), so it loads with a plain `node --test`.
import {
  FAILURE_BACKOFF_BASE_MS,
  FAILURE_BACKOFF_MAX_MS,
  failureBackoffMs,
  freshnessFromWork,
  needsFetch,
  planWorkCache,
  summarizeWorkText,
  WORK_TEXT_TTL_MS,
  WORK_TEXT_VERSION,
} from '../../src/content_script/siteExport/workText.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 7)

/** A cached entry that agrees with {@link blurb} in every respect. */
function meta(over = {}) {
  return {
    size: 36_000,
    updatedAt: 1_770_000_000,
    chapters: 3,
    words: 5000,
    fetchedAt: NOW - DAY,
    v: WORK_TEXT_VERSION,
    ...over,
  }
}

/** The blurb facts a cached entry is judged against. */
function blurb(over = {}) {
  return { workId: '1', dateUpdated: 1_770_000_000, chapters: 3, words: 5000, ...over }
}

describe('needsFetch', () => {
  test('a work with no entry at all is fetched', () => {
    assert.equal(needsFetch(undefined, blurb(), NOW), 'absent')
  })

  test('an entry the blurb still agrees with is left alone', () => {
    assert.equal(needsFetch(meta(), blurb(), NOW), null)
  })

  test('a sanitizer bump invalidates everything, however current', () => {
    assert.equal(needsFetch(meta({ v: WORK_TEXT_VERSION - 1 }), blurb(), NOW), 'version')
    // Including a version from some *newer* build, which this one can't render.
    assert.equal(needsFetch(meta({ v: WORK_TEXT_VERSION + 1 }), blurb(), NOW), 'version')
  })

  describe('proxy 1 — updated_at', () => {
    test('a newer blurb timestamp means new chapters or an edit', () => {
      assert.equal(needsFetch(meta(), blurb({ dateUpdated: 1_770_000_001 }), NOW), 'updated')
    })

    test('an older one does not — AO3 hands out stale and zero timestamps', () => {
      assert.equal(needsFetch(meta(), blurb({ dateUpdated: 1_700_000_000 }), NOW), null)
    })

    test('updated_at=0 on the blurb falls through to the next proxy', () => {
      assert.equal(needsFetch(meta(), blurb({ dateUpdated: 0 }), NOW), null)
      assert.equal(needsFetch(meta(), blurb({ dateUpdated: 0, chapters: 4 }), NOW), 'chapters')
    })

    test('updated_at=0 on the entry is no answer either, not an old date', () => {
      assert.equal(needsFetch(meta({ updatedAt: 0 }), blurb(), NOW), null)
    })
  })

  describe('proxy 2 — chapters written', () => {
    test('a new chapter is stale', () => {
      assert.equal(needsFetch(meta(), blurb({ chapters: 4 }), NOW), 'chapters')
    })

    test('a deleted chapter is stale too — any difference is an edit', () => {
      assert.equal(needsFetch(meta(), blurb({ chapters: 2 }), NOW), 'chapters')
    })

    test('a blurb with no chapter count says nothing', () => {
      assert.equal(needsFetch(meta(), blurb({ chapters: 0 }), NOW), null)
    })
  })

  describe('proxy 3 — word count', () => {
    test('an in-place edit that moved neither of the above still shows here', () => {
      assert.equal(needsFetch(meta(), blurb({ words: 5100 }), NOW), 'words')
      assert.equal(needsFetch(meta(), blurb({ words: 4900 }), NOW), 'words')
    })

    test('a blurb with no word count says nothing', () => {
      assert.equal(needsFetch(meta(), blurb({ words: 0 }), NOW), null)
    })
  })

  describe('proxy 4 — the TTL floor', () => {
    test('an entry older than the TTL is refetched even when nothing moved', () => {
      assert.equal(needsFetch(meta({ fetchedAt: NOW - WORK_TEXT_TTL_MS - 1 }), blurb(), NOW), 'ttl')
      assert.equal(needsFetch(meta({ fetchedAt: NOW - WORK_TEXT_TTL_MS }), blurb(), NOW), 'ttl')
    })

    test('one day short of it is not', () => {
      assert.equal(needsFetch(meta({ fetchedAt: NOW - WORK_TEXT_TTL_MS + DAY }), blurb(), NOW), null)
    })

    test('the floor is overridable', () => {
      assert.equal(needsFetch(meta({ fetchedAt: NOW - 2 * DAY }), blurb(), NOW, { ttlMs: DAY }), 'ttl')
    })

    test('the blurb proxies are reported ahead of it', () => {
      const old = meta({ fetchedAt: NOW - WORK_TEXT_TTL_MS - DAY })
      assert.equal(needsFetch(old, blurb({ chapters: 9 }), NOW), 'chapters')
    })
  })

  describe('failures', () => {
    const failed = (over = {}) => meta({ failure: 'error', attempts: 1, attemptedAt: NOW - DAY, ...over })

    test('a failed entry is retried once its backoff has elapsed', () => {
      assert.equal(needsFetch(failed(), blurb(), NOW), 'retry')
    })

    test('and left alone until then, however stale the blurb says it is', () => {
      const fresh = failed({ attemptedAt: NOW - 60_000 })
      assert.equal(needsFetch(fresh, blurb({ chapters: 40 }), NOW), null)
    })

    test('the backoff clock is the last attempt, not the last good fetch', () => {
      // Text from months ago, an attempt a minute ago: still waiting.
      const entry = failed({ fetchedAt: NOW - 200 * DAY, attemptedAt: NOW - 60_000 })
      assert.equal(needsFetch(entry, blurb(), NOW), null)
    })

    test('an entry that never held text falls back to fetchedAt', () => {
      const entry = { size: 0, updatedAt: 0, chapters: 0, words: 0, fetchedAt: NOW - DAY, v: WORK_TEXT_VERSION, failure: 'notfound', attempts: 1 }
      assert.equal(needsFetch(entry, blurb(), NOW), 'retry')
    })

    test('a run can decline to retry failures at all', () => {
      assert.equal(needsFetch(failed(), blurb(), NOW, { retryFailures: false }), null)
    })

    test('or insist on retrying them now — the reader just signed back in', () => {
      const waiting = failed({ attemptedAt: NOW - 60_000 })
      assert.equal(needsFetch(waiting, blurb(), NOW, { retryFailures: 'now' }), 'retry')
    })

    test('a version bump still beats a pending backoff', () => {
      const waiting = failed({ attemptedAt: NOW - 60_000, v: WORK_TEXT_VERSION - 1 })
      assert.equal(needsFetch(waiting, blurb(), NOW), 'version')
    })
  })
})

describe('failureBackoffMs', () => {
  test('doubles per consecutive failure', () => {
    assert.equal(failureBackoffMs(1), FAILURE_BACKOFF_BASE_MS)
    assert.equal(failureBackoffMs(2), FAILURE_BACKOFF_BASE_MS * 2)
    assert.equal(failureBackoffMs(4), FAILURE_BACKOFF_BASE_MS * 8)
  })

  test('is capped, so a deleted work is retried rarely rather than never', () => {
    assert.equal(failureBackoffMs(50), FAILURE_BACKOFF_MAX_MS)
  })

  test('treats a missing or nonsense count as the first failure', () => {
    assert.equal(failureBackoffMs(undefined), FAILURE_BACKOFF_BASE_MS)
    assert.equal(failureBackoffMs(0), FAILURE_BACKOFF_BASE_MS)
    assert.equal(failureBackoffMs(-3), FAILURE_BACKOFF_BASE_MS)
  })
})

describe('planWorkCache', () => {
  const works = [blurb({ workId: 'a' }), blurb({ workId: 'b', chapters: 9 }), blurb({ workId: 'c' })]
  const index = { a: meta(), b: meta(), c: meta({ failure: 'notfound', attempts: 2, attemptedAt: NOW - 60_000 }) }

  test('queues only what needs fetching, and says why', () => {
    const plan = planWorkCache(works, index, NOW)
    assert.deepEqual(plan.queue, ['b'])
    assert.deepEqual(plan.reasons, { b: 'chapters' })
    assert.deepEqual(plan.fresh, ['a'])
    assert.deepEqual(plan.waiting, ['c'])
  })

  test('keeps the listing order, so a run stopped half way did the top of the list', () => {
    const plan = planWorkCache(works, {}, NOW)
    assert.deepEqual(plan.queue, ['a', 'b', 'c'])
    assert.deepEqual(plan.reasons, { a: 'absent', b: 'absent', c: 'absent' })
  })

  test('queues a work listed twice only once, and skips unparsed blurbs', () => {
    const plan = planWorkCache(
      [blurb({ workId: 'a' }), blurb({ workId: '' }), blurb({ workId: 'a' })],
      {},
      NOW,
    )
    assert.deepEqual(plan.queue, ['a'])
  })

  test('an empty list plans nothing', () => {
    assert.deepEqual(planWorkCache([], {}, NOW), { queue: [], reasons: {}, fresh: [], waiting: [] })
  })
})

describe('summarizeWorkText', () => {
  test('totals the text, and counts failures separately', () => {
    const usage = summarizeWorkText({
      a: meta({ size: 1000 }),
      b: meta({ size: 2000 }),
      // A work that went restricted after being cached still holds its text.
      c: meta({ size: 500, failure: 'restricted', attempts: 1 }),
      // One that never had any.
      d: meta({ size: 0, failure: 'notfound', attempts: 3 }),
    })
    assert.deepEqual(usage, { cached: 3, failed: 2, bytes: 3500 })
  })

  test('an empty index totals nothing', () => {
    assert.deepEqual(summarizeWorkText({}), { cached: 0, failed: 0, bytes: 0 })
  })
})

describe('freshnessFromWork', () => {
  test('reads the three proxies off a parsed blurb', () => {
    const work = { workId: '42', dateUpdated: 1_770_000_000, chapters: { written: 3, total: 5 }, words: 5000, title: 'ignored' }
    assert.deepEqual(freshnessFromWork(work), {
      workId: '42',
      dateUpdated: 1_770_000_000,
      chapters: 3,
      words: 5000,
    })
  })
})

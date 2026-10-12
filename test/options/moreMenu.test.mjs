import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { moreCounts, moreMenu } from '../../src/options_ui/model/moreMenu.ts'

/** A copy of 240 works: 205 cached, 6 failed, 29 new. */
const buckets = (fields = {}) => ({ total: 240, cached: 205, failed: 6, unfetched: 29, bytes: 7_235_174, staleFailures: 0, ...fields })

const OFF = 'off for now: one job at a time, and Marked for Later is caching'

/** A tile's menu: its list can be refreshed and removed from here. */
const tile = (input = {}) => moreMenu({ refresh: true, remove: true, retry: 6, cached: 205, off: null, ...input })

/** This review's: no listing behind it to refresh, and nothing to remove. */
const review = (input = {}) => moreMenu({ refresh: false, remove: false, retry: 1, cached: 2, off: null, ...input })

const kinds = menu => menu.items.map(item => item.kind)

describe('what More offers for a copy', () => {
  test('a retry of every work that failed, a cached one whose refetch failed included', () => {
    assert.equal(moreCounts(buckets()).retry, 6)
    assert.equal(moreCounts(buckets({ staleFailures: 3 })).retry, 9)
    assert.equal(moreCounts(buckets({ failed: 0 })).retry, 0)
  })

  test('a download without refreshing of the works cached', () => {
    assert.equal(moreCounts(buckets()).cached, 205)
    assert.equal(moreCounts(buckets({ cached: 0, bytes: 0 })).cached, 0)
  })
})

describe('a More menu', () => {
  test('a tile\'s: the list refreshed first, a retry, a download without refreshing, and remove, as its tooltip says', () => {
    assert.deepEqual(tile(), {
      title: 'Refresh the list first, retry failed works, download without refreshing, remove',
      items: [
        { kind: 'refresh-first', off: null },
        { kind: 'retry', off: null },
        { kind: 'download-cached', off: null },
        { kind: 'remove', off: null },
      ],
    })
  })

  test('a retry only while a work has failed, and a download without refreshing only once one is cached', () => {
    assert.deepEqual(kinds(tile({ retry: 0 })), ['refresh-first', 'download-cached', 'remove'])
    assert.deepEqual(kinds(tile({ cached: 0 })), ['refresh-first', 'retry', 'remove'])
    assert.equal(tile({ retry: 0, cached: 0 }).title, tile().title, 'the tooltip says what the menu is for')
  })

  test('This review\'s: a retry and a download without refreshing; no refresh, with no one listing behind it, and no remove', () => {
    assert.deepEqual(review(), {
      title: 'Retry failed works, download without refreshing',
      items: [{ kind: 'retry', off: null }, { kind: 'download-cached', off: null }],
    })
    assert.deepEqual(kinds(review({ retry: 0 })), ['download-cached'])
    assert.deepEqual(kinds(review({ cached: 0 })), ['retry'])
  })

  test('with nothing to offer, there is no menu', () => {
    assert.equal(review({ retry: 0, cached: 0 }), null)
  })

  test('another list\'s job turns off every item that starts a job, saying why; Remove stays on', () => {
    assert.deepEqual(tile({ off: OFF }).items, [
      { kind: 'refresh-first', off: OFF },
      { kind: 'retry', off: OFF },
      { kind: 'download-cached', off: OFF },
      { kind: 'remove', off: null },
    ])
    assert.deepEqual(review({ off: OFF }).items, [{ kind: 'retry', off: OFF }, { kind: 'download-cached', off: OFF }])
  })

  test('a list that can\'t be refreshed turns off refreshing first alone, with its own reason; the rest work from the copy as it is', () => {
    const needs = 'off while Work marks, under Reading, is switched off'
    assert.deepEqual(tile({ refreshOff: needs }).items, [
      { kind: 'refresh-first', off: needs },
      { kind: 'retry', off: null },
      { kind: 'download-cached', off: null },
      { kind: 'remove', off: null },
    ])
    assert.deepEqual(tile({ refreshOff: needs, off: OFF }).items.map(item => item.off), [needs, OFF, OFF, null], 'another list\'s job turns the rest off')
    assert.equal(tile({ refreshOff: needs }).title, tile().title)
  })
})

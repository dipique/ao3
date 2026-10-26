import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { dayOf } from '../../src/common/trackedLists.ts'
import { packRows, recordFor, windowFromRecords } from '../../src/common/trackedReads.ts'

const TODAY = dayOf('20 Sep 2026')
const START = dayOf('10 Sep 2026')

function list(id, extra = {}) {
  return { id, kind: 'works-filter', url: `/tags/${id}/works`, alias: id, tracked: true, since: START - 30, ...extra }
}

/** A record of `entry` read through `through`, holding `rows`: `[sid, day]` pairs. */
function read(entry, through, rows, extra = {}) {
  return { ...recordFor(entry, undefined, START), through, readAt: 1, rows: packRows(rows.map(([sid, day]) => ({ sid, day }))), ...extra }
}

/** `[sid, day]` pairs from `[day, n]` rows, making `n` works a day with ids from `prefix`. */
function many(prefix, perDay) {
  const out = []
  for (const [day, n] of perDay) {
    for (let i = 0; i < n; i++)
      out.push([`${prefix}${out.length}`, day])
  }
  return out
}

/** Compute the window with everything counting and every list wanting every work, over what's given. */
function compute(lists, records, over = {}) {
  return windowFromRecords({
    lists,
    records: new Map(records.map(record => [record[0], record[1]])),
    start: START,
    today: TODAY,
    target: 40,
    member: () => true,
    counts: () => true,
    ...over,
  })
}

const sids = window => window.works.map(work => work.sid)

describe('windowFromRecords', () => {
  describe('sizing', () => {
    test('ends the day before the day that tips it over the target', () => {
      const a = list('a')
      const rows = many('w', Array.from({ length: 10 }, (_, i) => [START + i, 8]))
      const window = compute([a], [['a', read(a, TODAY - 1, rows)]])
      assert.equal(window.start, START)
      assert.equal(window.end, START + 4)
      assert.deepEqual([...window.days], [[START, 8], [START + 1, 8], [START + 2, 8], [START + 3, 8], [START + 4, 8]])
      assert.equal(window.nextDayCount, 8)
      assert.equal(window.works.length, 40)
    })

    test('a first day over the target on its own is still a window of one day', () => {
      const a = list('a')
      const window = compute([a], [['a', read(a, TODAY - 1, many('w', [[START, 60], [START + 1, 3]]))]])
      assert.equal(window.end, START)
      assert.equal(window.works.length, 60)
    })

    test('nothing tips it: it runs to yesterday', () => {
      const a = list('a')
      const window = compute([a], [['a', read(a, TODAY - 1, many('w', [[START, 3], [START + 4, 2]]))]])
      assert.equal(window.end, TODAY - 1)
      assert.equal(window.days.size, TODAY - START)
      assert.equal(window.days.get(START + 1), 0)
    })

    test('works that don’t count are shown but not counted', () => {
      const a = list('a')
      const rows = many('w', [[START, 30], [START + 1, 30], [START + 2, 30]])
      const hidden = new Set(rows.slice(0, 20).map(([sid]) => sid))
      const window = compute([a], [['a', read(a, TODAY - 1, rows)]], { counts: sid => !hidden.has(sid) })
      assert.equal(window.end, START + 1)
      assert.equal(window.days.get(START), 10)
      assert.equal(window.works.length, 60)
      assert.equal(window.works.filter(work => !work.counts).length, 20)
    })

    test('only the days it walks are asked whether their works count', () => {
      const a = list('a')
      const rows = many('w', Array.from({ length: 10 }, (_, i) => [START + i, 8]))
      const asked = new Set()
      compute([a], [['a', read(a, TODAY - 1, rows)]], { counts: (sid) => {
        asked.add(sid)
        return true
      } })
      const days = new Map(rows)
      assert.ok([...asked].every(sid => days.get(sid) <= START + 5), 'nothing past the day after the window')
    })

    test('endOverride replaces the sizing, within the start and yesterday', () => {
      const a = list('a')
      const rec = read(a, TODAY - 1, many('w', Array.from({ length: 10 }, (_, i) => [START + i, 8])))
      assert.equal(compute([a], [['a', rec]], { endOverride: START + 7 }).end, START + 7)
      assert.equal(compute([a], [['a', rec]], { endOverride: START - 4 }).end, START)
      assert.equal(compute([a], [['a', rec]], { endOverride: TODAY + 2 }).end, TODAY - 1)
    })
  })

  describe('merging', () => {
    test('works in review order: day, then list order, then row order', () => {
      const a = list('a')
      const b = list('b')
      const window = compute([a, b], [
        ['a', read(a, TODAY - 1, [['a1', START + 1], ['a2', START], ['s', START]])],
        ['b', read(b, TODAY - 1, [['b1', START], ['s', START], ['b2', START + 1]])],
      ])
      assert.deepEqual(sids(window), ['a2', 's', 'b1', 'a1', 'b2'])
      assert.deepEqual(window.works.find(work => work.sid === 's').lists, ['a', 'b'])
    })

    test('a work a later list moves to a later day takes its place there from that list', () => {
      const a = list('a')
      const b = list('b')
      const window = compute([a, b], [
        ['a', read(a, TODAY - 1, [['s', START + 1]])],
        ['b', read(b, TODAY - 1, [['b1', START + 3], ['s', START + 3]])],
      ])
      assert.deepEqual(sids(window), ['b1', 's'])
    })

    test('two lists disagreeing on a day: the later wins, and both name it', () => {
      const a = list('a')
      const b = list('b')
      const window = compute([a, b], [
        ['a', read(a, TODAY - 1, [['s', START + 1]])],
        ['b', read(b, TODAY - 1, [['s', START + 3]])],
      ])
      assert.deepEqual(window.works.map(work => [work.sid, work.day, work.lists]), [['s', START + 3, ['a', 'b']]])
    })

    test('a list’s view filter decides whether the work is its own', () => {
      const a = list('a')
      const b = list('b')
      const records = [
        ['a', read(a, TODAY - 1, [['s', START + 3], ['only-a', START]])],
        ['b', read(b, TODAY - 1, [['s', START + 1]])],
      ]
      const member = (listId, sid) => !(listId === 'a' && (sid === 's' || sid === 'only-a'))
      const window = compute([a, b], records, { member })
      assert.deepEqual(window.works.map(work => [work.sid, work.day, work.lists]), [['s', START + 1, ['b']]])
    })

    test('a future-dated row is reviewed today', () => {
      const a = list('a')
      const rec = read(a, TODAY - 1, [['ahead', TODAY + 4]])
      assert.deepEqual(sids(compute([a], [['a', rec]])), [])
      const preview = compute([a], [['a', rec]], { start: TODAY })
      assert.deepEqual(preview.works.map(work => [work.sid, work.day]), [['ahead', TODAY]])
    })

    test('a future-dated row in one list and an earlier one in another: reviewed today', () => {
      const a = list('a')
      const b = list('b')
      const preview = compute([a, b], [
        ['a', read(a, TODAY - 1, [['s', TODAY + 3]])],
        ['b', read(b, TODAY - 1, [['s', TODAY - 2]])],
      ], { start: TODAY })
      assert.deepEqual(preview.works.map(work => [work.sid, work.day]), [['s', TODAY]])
    })

    test('rows on reviewed days are left out', () => {
      const a = list('a')
      const window = compute([a], [['a', read(a, TODAY - 1, [['old', START - 1], ['new', START]])]])
      assert.deepEqual(sids(window), ['new'])
    })

    test('a list that isn’t tracked takes no part', () => {
      const a = list('a', { tracked: false })
      assert.deepEqual(sids(compute([a], [['a', read(a, TODAY - 1, [['w', START]])]])), [])
    })
  })

  describe('how complete it is', () => {
    test('a list read through the window’s end is complete, one short of it pending', () => {
      const a = list('a')
      const b = list('b')
      const c = list('c')
      const window = compute([a, b, c], [
        ['a', read(a, TODAY - 1, many('a', [[START, 30], [START + 1, 30]]))],
        ['b', read(b, START, [])],
      ])
      assert.equal(window.end, START)
      assert.deepEqual(window.complete, ['a', 'b'])
      assert.deepEqual(window.pending, ['c'], 'a list with no record is pending')
      assert.deepEqual(window.failed, [])
      assert.equal(window.reviewable, true, 'pending lists don’t block it')
    })

    test('a list that failed short of the end is failed, and the window isn’t reviewable', () => {
      const a = list('a')
      const b = list('b')
      const window = compute([a, b], [
        ['a', read(a, TODAY - 1, [])],
        ['b', read(b, START + 2, [], { failed: true })],
      ])
      assert.deepEqual(window.failed, ['b'])
      assert.deepEqual(window.pending, [])
      assert.equal(window.reviewable, false)
    })

    test('a list that failed after reading past the end is complete', () => {
      const a = list('a')
      const window = compute([a], [['a', read(a, TODAY - 1, many('w', [[START, 50]]), { failed: true })]])
      assert.deepEqual(window.complete, ['a'])
      assert.deepEqual(window.failed, [])
    })

    test('a list tracked after the window ends is complete without being read', () => {
      const a = list('a')
      const b = list('b', { since: START + 3 })
      const window = compute([a, b], [
        ['a', read(a, TODAY - 1, many('w', [[START, 30], [START + 1, 30]]))],
        ['b', recordFor(b, undefined, START)],
      ])
      assert.deepEqual(window.complete, ['a', 'b'])
    })

    test('partial records end a window no later than full ones would', () => {
      const a = list('a')
      const rows = many('w', Array.from({ length: 10 }, (_, i) => [START + i, 8]))
      const partial = compute([a], [['a', read(a, START + 2, rows.filter(([, day]) => day <= START + 4))]])
      assert.equal(partial.end, TODAY - 1)
      assert.deepEqual(partial.pending, ['a'])
      const full = compute([a], [['a', read(a, TODAY - 1, rows)]])
      assert.ok(full.end <= partial.end)
    })
  })

  test('an empty window while lists are still being read says so', () => {
    const a = list('a')
    const window = compute([a], [['a', read(a, START + 1, [])]])
    assert.deepEqual(window.works, [])
    assert.deepEqual(window.pending, ['a'])
    assert.equal(window.reviewable, true)
  })

  test('an empty window still has its days', () => {
    const a = list('a')
    const window = compute([a], [['a', read(a, TODAY - 1, [])]])
    assert.equal(window.end, TODAY - 1)
    assert.deepEqual(window.works, [])
    assert.equal(window.days.size, TODAY - START)
    assert.equal(window.reviewable, true)
  })

  test('a list tracked today is pending in the preview of today until it has been read', () => {
    const a = list('a', { since: TODAY })
    const fresh = compute([a], [['a', recordFor(a, undefined, TODAY)]], { start: TODAY })
    assert.deepEqual(fresh.pending, ['a'])
    const read = compute([a], [['a', { ...recordFor(a, undefined, TODAY), readAt: 1 }]], { start: TODAY })
    assert.deepEqual(read.complete, ['a'])
  })

  test('caught up, endOverride has nothing to move', () => {
    const a = list('a')
    const window = compute([a], [['a', read(a, TODAY - 1, [])]], { start: TODAY, endOverride: TODAY - 3 })
    assert.equal(window.end, TODAY)
  })

  test('caught up: a preview of today, never reviewable, complete once read through yesterday', () => {
    const a = list('a')
    const b = list('b')
    const window = compute([a, b], [
      ['a', read(a, TODAY - 1, [['t', TODAY], ['y', TODAY - 1]])],
      ['b', read(b, TODAY - 2, [])],
    ], { start: TODAY })
    assert.equal(window.start, TODAY)
    assert.equal(window.end, TODAY)
    assert.deepEqual(sids(window), ['t'])
    assert.equal(window.reviewable, false)
    assert.deepEqual(window.complete, ['a'])
    assert.deepEqual(window.pending, ['b'])
  })
})

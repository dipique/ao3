import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { assignDay, dayOf, listBase, mergeItems, reviewStart } from '../../src/common/trackedLists.ts'

const TODAY = dayOf('19 Sep 2026')
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

describe('listBase', () => {
  test('is the day before the window for a list tracked before it', () => {
    assert.equal(listBase({ since: START - 20 }, START), START - 1)
  })

  test('is the day before tracking began for a list tracked inside it', () => {
    assert.equal(listBase({ since: START + 4 }, START), START + 3)
  })
})

describe('assignDay', () => {
  const context = { base: START - 1, start: START, today: TODAY }

  test('a day inside the range is unchanged', () => {
    for (const day of [START, START + 3, TODAY])
      assert.equal(assignDay(day, context), day)
  })

  test('the two days before the window are dropped: they were reviewed already', () => {
    assert.equal(assignDay(START - 1, context), null)
    assert.equal(assignDay(START - 2, context), null)
  })

  test('anything earlier was hand-set, and counts on the first day', () => {
    assert.equal(assignDay(START - 3, context), START)
    assert.equal(assignDay(dayOf('1 Jan 2019'), context), START)
  })

  test('a date after today counts on today', () => {
    assert.equal(assignDay(TODAY + 1, context), TODAY)
    assert.equal(assignDay(TODAY + 40, context), TODAY)
  })

  test('an unreadable date counts on the first day', () => {
    assert.equal(assignDay(Number.NaN, context), START)
  })

  test('a list tracked inside the window adds nothing dated before tracking began', () => {
    const since = START + 5
    const late = { base: listBase({ since }, START), start: START, today: TODAY }
    assert.equal(assignDay(since - 1, late), null)
    assert.equal(assignDay(since - 2, late), null)
    assert.equal(assignDay(since, late), since)
    // Further off than a day's drift is still hand-set, and still clamped in.
    assert.equal(assignDay(since - 3, late), START)
  })

  describe('from a scanned list', () => {
    const scanned = { ...context, scanned: true }

    test('an old work is just old: dropped, not clamped', () => {
      assert.equal(assignDay(dayOf('1 Jan 2019'), scanned), null)
      assert.equal(assignDay(START - 1, scanned), null)
    })

    test('a work in range is unchanged, and the future is still clamped', () => {
      assert.equal(assignDay(START, scanned), START)
      assert.equal(assignDay(TODAY + 1, scanned), TODAY)
    })

    test('an unreadable date is dropped, or it would be in every window', () => {
      assert.equal(assignDay(Number.NaN, scanned), null)
    })
  })
})

describe('mergeItems', () => {
  const list = (id, items, extra = {}) => ({
    id,
    base: START - 1,
    items: items.map(([sid, day, counts = true]) => ({ sid, day, counts })),
    total: 100,
    bounds: new Map(),
    exhausted: false,
    failed: false,
    ...extra,
  })
  const context = { start: START, today: TODAY }

  test('a work in two lists is one work, carrying both', () => {
    const merged = mergeItems([list('a', [['w1', START]]), list('b', [['w1', START]])], context)
    assert.deepEqual([...merged], [['w1', { day: START, counts: true, lists: ['a', 'b'] }]])
  })

  test('two reads on different days put it on the later one', () => {
    const merged = mergeItems([list('a', [['w1', START + 1]]), list('b', [['w1', START + 6]])], context)
    assert.equal(merged.get('w1').day, START + 6)
    // Whichever list read it last.
    assert.equal(mergeItems([list('b', [['w1', START + 6]]), list('a', [['w1', START + 1]])], context).get('w1').day, START + 6)
  })

  test('a read that dates it as reviewed does not hide a later one', () => {
    const merged = mergeItems([list('a', [['w1', START - 1]]), list('b', [['w1', START + 2]])], context)
    assert.deepEqual(merged.get('w1'), { day: START + 2, counts: true, lists: ['a', 'b'] })
  })

  test('works no list gives a day are left out', () => {
    assert.equal(mergeItems([list('a', [['w1', START - 1], ['w2', START - 2]])], context).size, 0)
  })

  test('counts is whatever the read on the winning day says', () => {
    assert.equal(mergeItems([list('a', [['w1', START, false]]), list('b', [['w1', START + 1, true]])], context).get('w1').counts, true)
    assert.equal(mergeItems([list('a', [['w1', START, true]]), list('b', [['w1', START + 1, false]])], context).get('w1').counts, false)
    assert.equal(mergeItems([list('a', [['w1', START, false]]), list('b', [['w1', START, true]])], context).get('w1').counts, true)
  })

  test('each list\'s days are assigned against its own base', () => {
    const since = START + 5
    const merged = mergeItems([
      list('early', [['w1', since - 1]]),
      list('late', [['w1', since - 1], ['w2', since - 1]], { base: since - 1 }),
    ], context)
    // The early list vouches for w1 on its own day; the late one adds nothing before it began.
    assert.equal(merged.get('w1').day, since - 1)
    assert.equal(merged.has('w2'), false)
  })

  test('a scanned list\'s old works are dropped', () => {
    const merged = mergeItems([list('s', [['old', dayOf('1 Jan 2019')], ['new', START + 1]], { scanned: true })], context)
    assert.deepEqual([...merged.keys()], ['new'])
  })
})

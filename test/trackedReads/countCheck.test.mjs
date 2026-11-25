import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { dayOf } from '../../src/common/trackedLists.ts'
import { checkPasses, checkThrough, copyQuery, packRows, settleChecked, unpackRows } from '../../src/common/trackedReads.ts'
import { fromShortId, packOrderedIds, toShortId, unpackOrderedIds } from '../../src/common/workId.ts'

const TODAY = dayOf('20 Sep 2026')
const SINCE = dayOf('1 Sep 2026')
const DAY_MS = 86_400_000
const AT = Date.UTC(2026, 8, 20, 12)
/** Noon of a day, as an epoch ms "as of". */
const noonOf = day => day * DAY_MS + DAY_MS / 2

const LISTS = [{ id: 'a', kind: 'works-filter', url: '/tags/Fluff/works', alias: 'a', tracked: true, since: SINCE }]

const idsOf = copy => unpackOrderedIds(copy.ids).map(toShortId)
const packSids = sids => packOrderedIds(sids.map(fromShortId))

/** A copy never read by date, holding `sids`, last read from its page on `asOf`. */
function copy(sids, { asOf = TODAY - 3, ...dated } = {}) {
  return {
    v: 3,
    scrapedAt: noonOf(asOf),
    ids: packSids(sids),
    descriptor: { sourceId: 'works-filter', label: 'Fluff', listUrl: 'https://archiveofourown.org/tags/Fluff/works' },
    dated: { query: copyQuery(LISTS), from: SINCE, through: SINCE - 1, readAt: 0, rows: '', ...dated },
  }
}

const works = pairs => pairs.map(([sid, blurbDay]) => ({ sid, blurbDay }))

describe('checkThrough', () => {
  const plain = { scanned: false, full: false }

  test('a copy never read by date is checked through the day before its "as of"', () => {
    assert.equal(checkThrough(copy(['a1']), TODAY, plain), TODAY - 4)
  })

  test('never past yesterday, whatever the "as of" says', () => {
    assert.equal(checkThrough(copy(['a1'], { asOf: TODAY + 2 }), TODAY, plain), TODAY - 1)
  })

  test('a copy read by date since, or read in full from its page, isn’t checked', () => {
    assert.equal(checkThrough(copy(['a1'], { readAt: AT }), TODAY, plain), null)
  })

  test('a list read whole, and a Full refresh, aren’t checked', () => {
    assert.equal(checkThrough(copy(['a1']), TODAY, { scanned: true, full: false }), null)
    assert.equal(checkThrough(copy(['a1']), TODAY, { scanned: false, full: true }), null)
  })

  test('a copy holding no works isn’t checked', () => {
    assert.equal(checkThrough(copy([]), TODAY, plain), null)
  })

  test('nothing to gain — read before its tracking day, or settled that far already — isn’t checked', () => {
    assert.equal(checkThrough(copy(['a1'], { asOf: SINCE }), TODAY, plain), null)
    assert.equal(checkThrough(copy(['a1'], { through: TODAY - 4 }), TODAY, plain), null)
  })

  test('a copy with no dated part isn’t checked', () => {
    const { dated: _dated, ...undated } = copy(['a1'])
    assert.equal(checkThrough(undated, TODAY, plain), null)
  })
})

describe('checkPasses', () => {
  const THROUGH = TODAY - 4
  const held = works([['a1', SINCE], ['a2', SINCE + 1], ['a3', SINCE + 5], ['old', SINCE - 30], ['new', TODAY - 2]])

  test('passes when every work on the page is in the copy, and AO3 counts no more than the copy holds in the stretch', () => {
    assert.equal(checkPasses(held, { sids: ['a1', 'a2'], count: 3 }, SINCE, THROUGH), true)
    assert.equal(checkPasses(held, { sids: ['a1', 'a2'], count: 2 }, SINCE, THROUGH), true)
  })

  test('fails when a work on the page isn’t in the copy', () => {
    assert.equal(checkPasses(held, { sids: ['a1', 'zz'], count: 2 }, SINCE, THROUGH), false)
  })

  test('fails when AO3 counts more works in the stretch than the copy holds there', () => {
    assert.equal(checkPasses(held, { sids: ['a1'], count: 4 }, SINCE, THROUGH), false)
  })

  test('only works dated inside the stretch count towards the copy’s side', () => {
    // `old` is from before the tracking day and `new` after the stretch: 3 in it.
    assert.equal(checkPasses(held, { sids: [], count: 4 }, SINCE, THROUGH), false)
    assert.equal(checkPasses(works([['a1', SINCE], ['x', Number.NaN]]), { sids: ['a1'], count: 2 }, SINCE, THROUGH), false, 'a work with no date doesn’t count')
  })

  test('fails when the page gives no count', () => {
    assert.equal(checkPasses(held, { sids: ['a1'], count: null }, SINCE, THROUGH), false)
  })

  test('an empty stretch passes when AO3 agrees it is empty', () => {
    assert.equal(checkPasses(works([['old', SINCE - 30]]), { sids: [], count: 0 }, SINCE, THROUGH), true)
  })
})

describe('settleChecked', () => {
  const THROUGH = TODAY - 4
  const held = copy(['new', 'a3', 'a1', 'old'])
  const read = works([['new', TODAY - 2], ['a3', SINCE + 5], ['a1', SINCE], ['old', SINCE - 30]])

  test('settles the copy through the day checked, and dates the works from its tracking day on', () => {
    const settled = settleChecked(held, read, THROUGH, TODAY, AT)
    assert.equal(settled.dated.through, THROUGH)
    assert.equal(settled.dated.from, SINCE)
    assert.deepEqual(unpackRows(settled.dated.rows).map(row => [row.sid, row.day]).sort(), [['a1', SINCE], ['a3', SINCE + 5], ['new', TODAY - 2]])
  })

  test('keeps every work, those from before its tracking day after the dated ones', () => {
    assert.deepEqual(idsOf(settleChecked(held, read, THROUGH, TODAY, AT)), ['new', 'a3', 'a1', 'old'])
  })

  test('says when it was checked and clears any failure, but its "as of" stays', () => {
    const failed = copy(['a1'], { failed: { reason: 'request', at: 5 } })
    const settled = settleChecked(failed, works([['a1', SINCE]]), THROUGH, TODAY, AT)
    assert.equal(settled.dated.readAt, AT)
    assert.equal('failed' in settled.dated, false)
    assert.equal(settled.scrapedAt, failed.scrapedAt)
  })

  test('never winds the copy back', () => {
    const further = copy(['a1'], { through: TODAY - 2, rows: packRows([{ sid: 'a1', day: SINCE }]) })
    assert.equal(settleChecked(further, works([['a1', SINCE]]), THROUGH, TODAY, AT).dated.through, TODAY - 2)
  })
})

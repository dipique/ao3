import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { dayOf } from '../../src/common/trackedLists.ts'
import { applyPage, nextRead, packRows, pruneReviewed, readQuery, readSummary, recordFor, unpackRows } from '../../src/common/trackedReads.ts'

const TODAY = dayOf('20 Sep 2026')
const START = dayOf('10 Sep 2026')
const AT = Date.UTC(2026, 8, 20, 12)

function list(id, extra = {}) {
  return { id, kind: 'works-filter', url: `/tags/${id}/works`, alias: id, tracked: true, since: START - 30, ...extra }
}

/** A record of `entry` as `recordFor` makes it, with fields over it. */
function record(entry, extra = {}) {
  return { ...recordFor(entry, undefined, START), ...extra }
}

const rowsOf = rec => unpackRows(rec.rows)
const page = (from, rows, reachedEnd = false, n = 1) => ({ from, page: n, rows: rows.map(([sid, blurbDay]) => ({ sid, blurbDay })), reachedEnd })

describe('packRows / unpackRows', () => {
  test('round-trip, in order', () => {
    const rows = [{ sid: '48x79', day: START }, { sid: 'a', day: START + 3 }, { sid: '1b90uz', day: START - 2 }]
    assert.deepEqual(unpackRows(packRows(rows)), rows)
  })

  test('nothing packs to the empty string, and back', () => {
    assert.equal(packRows([]), '')
    assert.deepEqual(unpackRows(''), [])
  })

  test('junk parts are skipped', () => {
    const packed = packRows([{ sid: 'a', day: START }, { sid: 'b', day: START + 1 }])
    assert.deepEqual(unpackRows(`${packed},nonsense,X.Y,.`), [{ sid: 'a', day: START }, { sid: 'b', day: START + 1 }])
  })
})

describe('readQuery', () => {
  test('the same list asks the same thing', () => {
    assert.equal(readQuery(list('a')), readQuery(list('a', { alias: 'renamed', since: START })))
  })

  test('the address, the scan mode and the tag exclusions are what it asks', () => {
    const base = readQuery(list('a', { kind: 'tag-works', url: '/tags/a' }))
    assert.notEqual(readQuery(list('a', { kind: 'tag-works', url: '/tags/b' })), base)
    assert.notEqual(readQuery(list('a', { kind: 'tag-works', url: '/tags/a', scan: true })), base)
    const excluding = { facets: { freeforms: { ex: ['Angst'] } } }
    assert.notEqual(readQuery(list('a', { kind: 'tag-works', url: '/tags/a', filter: excluding })), base)
  })

  test('a view filter that sends no exclusions asks the same thing', () => {
    const including = { facets: { freeforms: { in: ['Fluff'] } }, text: 'x', words: [1000, null] }
    assert.equal(readQuery(list('a', { filter: including })), readQuery(list('a')))
  })
})

describe('recordFor', () => {
  test('a list never read starts at the window, with nothing read', () => {
    const fresh = recordFor(list('a'), undefined, START)
    assert.deepEqual(fresh, { v: 1, query: readQuery(list('a')), from: START, through: START - 1, readAt: 0, rows: '' })
  })

  test('a list tracked inside the window starts on its tracking day', () => {
    const fresh = recordFor(list('a', { since: START + 4 }), undefined, START)
    assert.equal(fresh.from, START + 4)
    assert.equal(fresh.through, START + 3)
  })

  test('a stored record of the same query is kept', () => {
    const stored = record(list('a'), { through: START + 5, readAt: AT, rows: packRows([{ sid: 'x', day: START + 2 }]) })
    assert.equal(recordFor(list('a'), stored, START), stored)
  })

  test('a record of another query is dropped and read again', () => {
    const stored = record(list('a'), { through: START + 5, readAt: AT })
    const changed = list('a', { filter: { facets: { freeforms: { ex: ['Angst'] } } } })
    assert.deepEqual(recordFor(changed, stored, START), recordFor(changed, undefined, START))
  })

  test('a record that starts after the window no longer covers it, and is dropped', () => {
    const stored = record(list('a'), { from: START + 3, through: START + 5, readAt: AT })
    assert.equal(recordFor(list('a'), stored, START).through, START - 1)
  })

  test('a record from before the list was tracked again is dropped', () => {
    const stored = record(list('a'), { through: START + 5, readAt: AT })
    assert.equal(recordFor(list('a', { since: START + 2 }), stored, START).from, START + 2)
  })

  test('a record whose window moved on is kept: pruning catches it up', () => {
    const stored = record(list('a'), { through: START + 5, readAt: AT })
    assert.equal(recordFor(list('a'), stored, START + 3), stored)
  })

  test('anything malformed is a fresh record', () => {
    for (const junk of [null, 'x', {}, { ...record(list('a')), v: 2 }, { ...record(list('a')), through: 'x' }, { ...record(list('a')), rows: 3 }])
      assert.deepEqual(recordFor(list('a'), junk, START), recordFor(list('a'), undefined, START))
  })
})

describe('applyPage', () => {
  const at = { readDay: TODAY, scanned: false, at: AT }

  test('a page’s works are kept on their blurb days, in the order read', () => {
    const next = applyPage(record(list('a')), page(START, [['a', START], ['b', START + 1], ['c', START + 1]]), at)
    assert.deepEqual(rowsOf(next), [{ sid: 'a', day: START }, { sid: 'b', day: START + 1 }, { sid: 'c', day: START + 1 }])
    assert.equal(next.readAt, AT)
  })

  test('the record is not changed in place', () => {
    const before = record(list('a'))
    const copy = structuredClone(before)
    applyPage(before, page(START, [['a', START]]), at)
    assert.deepEqual(before, copy)
  })

  describe('the clamp', () => {
    test('a hand-set date before the day ahead of the query is stored on the query’s first day', () => {
      const from = START + 4
      const rec = record(list('a'), { through: from - 1 })
      const next = applyPage(rec, page(from, [['old', dayOf('1 Jan 2019')], ['early', from - 2]]), at)
      assert.deepEqual(rowsOf(next), [{ sid: 'old', day: from }, { sid: 'early', day: from }])
    })

    test('a date one day before the query is drift, and is kept as it is', () => {
      const from = START + 4
      const next = applyPage(record(list('a'), { through: from - 1 }), page(from, [['drift', from - 1]]), at)
      assert.deepEqual(rowsOf(next), [{ sid: 'drift', day: from - 1 }])
    })

    test('nothing is kept from before the record starts', () => {
      const next = applyPage(record(list('a')), page(START, [['drift', START - 1], ['ok', START]]), at)
      assert.deepEqual(rowsOf(next), [{ sid: 'ok', day: START }])
    })

    test('a row with no readable date counts on the query’s first day', () => {
      const next = applyPage(record(list('a')), page(START, [['nodate', Number.NaN]]), at)
      assert.deepEqual(rowsOf(next), [{ sid: 'nodate', day: START }])
    })

    test('a future date is stored as read', () => {
      const next = applyPage(record(list('a')), page(START, [['ahead', TODAY + 3]]), at)
      assert.deepEqual(rowsOf(next), [{ sid: 'ahead', day: TODAY + 3 }])
    })

    test('a scanned list drops what is dated before the query: those are old works', () => {
      const from = START + 4
      const rec = record(list('s', { kind: 'series-works', url: '/series/1' }), { through: from - 1 })
      const next = applyPage(rec, page(from, [['old', START - 40], ['prev', from - 1], ['nodate', Number.NaN], ['new', from], ['newer', from + 2]], true), { ...at, scanned: true })
      assert.deepEqual(rowsOf(next), [{ sid: 'new', day: from }, { sid: 'newer', day: from + 2 }])
    })
  })

  describe('merging by work', () => {
    test('a work read again on a later day moves to it', () => {
      const rec = record(list('a'), { through: START + 2, rows: packRows([{ sid: 'a', day: START }, { sid: 'b', day: START + 1 }]) })
      const next = applyPage(rec, page(START + 3, [['a', START + 5]]), at)
      assert.deepEqual(rowsOf(next), [{ sid: 'a', day: START + 5 }, { sid: 'b', day: START + 1 }])
    })

    test('a work read again on an earlier day stays on its later one', () => {
      const rec = record(list('a'), { through: START + 2, rows: packRows([{ sid: 'a', day: START + 6 }]) })
      const next = applyPage(rec, page(START + 3, [['a', START + 4]]), at)
      assert.deepEqual(rowsOf(next), [{ sid: 'a', day: START + 6 }])
    })

    test('a work twice on one page is one row, on its later day', () => {
      const next = applyPage(record(list('a')), page(START, [['a', START], ['a', START + 2]]), at)
      assert.deepEqual(rowsOf(next), [{ sid: 'a', day: START + 2 }])
    })
  })

  describe('how far it is read', () => {
    test('a pass that reaches its end trusts everything through yesterday', () => {
      const next = applyPage(record(list('a')), page(START, [['a', START + 2]], true), at)
      assert.equal(next.through, TODAY - 1)
    })

    test('an empty last page still reaches the end', () => {
      const next = applyPage(record(list('a')), page(START, [], true), at)
      assert.equal(next.through, TODAY - 1)
    })

    test('a pass cut short trusts two days before its last row', () => {
      const next = applyPage(record(list('a')), page(START, [['a', START + 2], ['b', START + 6]]), at)
      assert.equal(next.through, START + 4)
    })

    test('the last row is the last with a date', () => {
      const next = applyPage(record(list('a')), page(START, [['a', START + 6], ['b', Number.NaN]]), at)
      assert.equal(next.through, START + 4)
    })

    test('a cut-short pass never trusts today', () => {
      const next = applyPage(record(list('a')), page(START, [['a', TODAY + 5]]), at)
      assert.equal(next.through, TODAY - 1)
    })

    test('it never goes back', () => {
      const rec = record(list('a'), { through: START + 8 })
      const next = applyPage(rec, page(START + 9, [['a', START + 9]]), at)
      assert.equal(next.through, START + 8)
    })

    test('a page with no dated rows trusts nothing more', () => {
      const rec = record(list('a'), { through: START + 2 })
      assert.equal(applyPage(rec, page(START + 3, [['a', Number.NaN]]), at).through, START + 2)
      assert.equal(applyPage(rec, page(START + 3, []), at).through, START + 2)
    })

    test('a read across UTC midnight trusts only through the new yesterday', () => {
      const first = applyPage(record(list('a')), page(START, [['a', TODAY - 1]]), { ...at, readDay: TODAY })
      assert.equal(first.through, TODAY - 3)
      const second = applyPage(first, page(START, [['b', TODAY]], true, 2), { ...at, readDay: TODAY + 1, at: AT + 86_400_000 })
      assert.equal(second.through, TODAY)
    })
  })

  test('a page that lands clears a failure', () => {
    const next = applyPage(record(list('a'), { failed: true }), page(START, [['a', START]]), at)
    assert.equal('failed' in next, false)
  })
})

describe('nextRead', () => {
  const state = (entry, extra = {}, pass) => ({ listId: entry.id, record: record(entry, extra), ...(pass ? { pass } : {}) })

  test('reads first from the list read least far, from the day after it', () => {
    const states = [state(list('a'), { through: START + 4 }), state(list('b'), { through: START + 1 }), state(list('c'), { through: START + 6 })]
    assert.deepEqual(nextRead(states, TODAY), { listId: 'b', from: START + 2, page: 1 })
  })

  test('a list never read is read from its start', () => {
    assert.deepEqual(nextRead([state(list('a'))], TODAY), { listId: 'a', from: START, page: 1 })
  })

  test('a tie goes to the list first in order', () => {
    const states = [state(list('a'), { through: START + 1 }), state(list('b'), { through: START + 1 })]
    assert.equal(nextRead(states, TODAY).listId, 'a')
  })

  test('a pass under way goes on from where it got, on the day it started from', () => {
    const states = [state(list('a'), { through: START + 3 }, { from: START, page: 2 })]
    assert.deepEqual(nextRead(states, TODAY), { listId: 'a', from: START, page: 3 })
  })

  test('a list done for this run is passed over; none left is null', () => {
    const states = [{ ...state(list('a')), done: true }, state(list('b'), { through: START + 9 })]
    assert.equal(nextRead(states, TODAY).listId, 'b')
    assert.equal(nextRead([{ ...state(list('a')), done: true }], TODAY), null)
    assert.equal(nextRead([], TODAY), null)
  })

  test('a list read through yesterday is still read for today’s tail', () => {
    assert.deepEqual(nextRead([state(list('a'), { through: TODAY - 1 })], TODAY), { listId: 'a', from: TODAY, page: 1 })
  })

  test('never asks from a day after today', () => {
    assert.equal(nextRead([state(list('a'), { through: TODAY + 3 })], TODAY).from, TODAY)
  })
})

describe('pruneReviewed', () => {
  const rows = [{ sid: 'a', day: START }, { sid: 'b', day: START + 2 }, { sid: 'c', day: START + 3 }, { sid: 'd', day: START + 1 }]

  test('drops the rows on reviewed days, and names their works', () => {
    const { record: next, dropped } = pruneReviewed(record(list('a'), { through: START + 5, rows: packRows(rows) }), START + 2)
    assert.deepEqual(rowsOf(next), [{ sid: 'c', day: START + 3 }])
    assert.deepEqual(dropped, ['a', 'b', 'd'])
  })

  test('the record then starts after the reviewed days', () => {
    const { record: next } = pruneReviewed(record(list('a'), { through: START + 5, rows: packRows(rows) }), START + 2)
    assert.equal(next.from, START + 3)
    assert.equal(next.through, START + 5)
  })

  test('days reviewed before they were read are not read any more', () => {
    const { record: next } = pruneReviewed(record(list('a'), { through: START, rows: packRows(rows) }), START + 2)
    assert.equal(next.through, START + 2)
  })

  test('nothing to drop hands the same record back', () => {
    const rec = record(list('a'), { through: START + 5, rows: packRows(rows) })
    const { record: next, dropped } = pruneReviewed(rec, START - 1)
    assert.equal(next, rec)
    assert.deepEqual(dropped, [])
  })

  test('a list tracked after the reviewed days keeps its start', () => {
    const rec = record(list('a', { since: START + 5 }))
    assert.equal(pruneReviewed(rec, START + 2).record.from, START + 5)
  })
})

describe('readSummary', () => {
  test('the lists read least far, and the lists not yet read', () => {
    const lists = [list('a'), list('b'), list('c'), list('d', { tracked: false })]
    const records = new Map([
      ['a', record(lists[0], { through: START + 4, readAt: AT })],
      ['b', record(lists[1], { through: START + 2, readAt: AT })],
    ])
    assert.deepEqual(readSummary(lists, records), { through: START + 2, behind: ['c'] })
  })

  test('a record of another query, or never read, is not read', () => {
    const lists = [list('a'), list('b')]
    const records = new Map([
      ['a', record(list('a', { url: '/tags/other/works' }), { through: START + 4, readAt: AT })],
      ['b', record(lists[1])],
    ])
    assert.deepEqual(readSummary(lists, records), { through: null, behind: ['a', 'b'] })
  })
})

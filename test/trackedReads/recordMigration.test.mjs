import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { dayOf } from '../../src/common/trackedLists.ts'
import { copyQuery, datedOf, packRows, planRecordMigration, readQuery, readRecordKey, unpackRows } from '../../src/common/trackedReads.ts'
import { fromShortId, packOrderedIds, toShortId, unpackOrderedIds } from '../../src/common/workId.ts'

const TODAY = dayOf('20 Sep 2026')
const SINCE = dayOf('1 Sep 2026')
const START = dayOf('10 Sep 2026')
const AT = Date.UTC(2026, 8, 19, 12)
const KEY = 'works-filter:/tags/Fluff/works'

function list(id, extra = {}) {
  return { id, kind: 'works-filter', url: '/tags/Fluff/works', alias: id, tracked: true, since: SINCE, ...extra }
}

/** A read record of `entry`, as an older build stored it. */
function record(entry, rows, extra = {}) {
  return { v: 1, query: readQuery(entry), from: START, through: TODAY - 2, readAt: AT, rows: packRows(rows), ...extra }
}

const describeList = entry => ({ sourceId: entry.kind, label: entry.alias, listUrl: `https://archiveofourown.org${entry.url}` })
const emptyCopy = entry => ({ v: 3, scrapedAt: 0, ids: '', descriptor: describeList(entry) })
const idsOf = copy => unpackOrderedIds(copy.ids).map(toShortId)
const packSids = sids => packOrderedIds(sids.map(fromShortId))

/** The stored lists after applying `plan` to `stored`. */
const applied = (stored, plan) => ({ ...stored, ...plan.writes })

describe('planRecordMigration', () => {
  test('a record becomes its copy\'s dated part: the works, and how far they are complete', () => {
    const fluff = list('fluff')
    const rows = [{ sid: 'a1', day: START }, { sid: 'a2', day: START + 3 }]
    const stored = { [KEY]: { v: 3, scrapedAt: 5, ids: packSids(['old1', 'a1']), descriptor: describeList(fluff) } }
    const plan = planRecordMigration(new Map([['fluff', record(fluff, rows)]]), [fluff], stored, emptyCopy)
    const copy = plan.writes[KEY]
    assert.deepEqual(datedOf(copy, [fluff]), { query: copyQuery([fluff]), from: START, through: TODAY - 2, readAt: AT, rows: packRows(rows) })
    assert.deepEqual(idsOf(copy), ['a2', 'a1', 'old1'], 'the record\'s works newest first, then what the copy held besides')
    assert.deepEqual(copy.descriptor, stored[KEY].descriptor)
    assert.deepEqual(plan.drop, [readRecordKey('fluff')])
  })

  test('a list with a record and no copy gets one', () => {
    const fluff = list('fluff')
    const plan = planRecordMigration(new Map([['fluff', record(fluff, [{ sid: 'a1', day: START }])]]), [fluff], {}, emptyCopy)
    assert.deepEqual(idsOf(plan.writes[KEY]), ['a1'])
    assert.deepEqual(plan.writes[KEY].descriptor, describeList(fluff))
  })

  test('a record that last failed moves without the failure: it never said why, and the next read finds out', () => {
    const fluff = list('fluff')
    const plan = planRecordMigration(new Map([['fluff', record(fluff, [], { failed: true })]]), [fluff], {}, emptyCopy)
    assert.equal('failed' in plan.writes[KEY].dated, false)
  })

  test('two lists sharing a copy: their works together, complete only as far as both are', () => {
    const one = list('one')
    const two = list('two', { since: SINCE + 2 })
    const records = new Map([
      ['one', record(one, [{ sid: 'a1', day: START }], { through: TODAY - 1 })],
      ['two', record(two, [{ sid: 'a1', day: START + 2 }, { sid: 'b1', day: START + 1 }], { from: START + 1, through: TODAY - 3 })],
    ])
    const copy = planRecordMigration(records, [one, two], {}, emptyCopy).writes[KEY]
    assert.equal(copy.dated.from, START + 1)
    assert.equal(copy.dated.through, TODAY - 3)
    assert.deepEqual(unpackRows(copy.dated.rows).find(row => row.sid === 'a1'), { sid: 'a1', day: START + 2 }, 'a work both hold is on its later day')
    assert.deepEqual(idsOf(copy).sort(), ['a1', 'b1'])
  })

  test('a copy only some of its lists have a record for keeps their works but counts nothing complete', () => {
    const one = list('one', { filter: { facets: { freeforms: { ex: ['Angst'] } } } })
    const two = list('two')
    const copy = planRecordMigration(new Map([['one', record(one, [{ sid: 'a1', day: START }])]]), [one, two], {}, emptyCopy).writes[KEY]
    assert.deepEqual(idsOf(copy), ['a1'])
    assert.equal(copy.dated.through, copy.dated.from - 1, 'the other list\'s works were never read')
  })

  test('a list no copy can be made for here moves nothing', () => {
    const fluff = list('fluff')
    const plan = planRecordMigration(new Map([['fluff', record(fluff, [{ sid: 'a1', day: START }])]]), [fluff], {}, () => null)
    assert.deepEqual(plan.writes, {})
    assert.deepEqual(plan.drop, [readRecordKey('fluff')])
  })

  test('a record of another query, or not a record, is dropped and moves nothing', () => {
    const fluff = list('fluff')
    const records = new Map([['fluff', { ...record(fluff, [{ sid: 'a1', day: START }]), query: 'something else' }], ['gone', { v: 1 }]])
    const plan = planRecordMigration(records, [fluff], {}, emptyCopy)
    assert.deepEqual(plan.writes, {})
    assert.deepEqual(plan.drop.sort(), [readRecordKey('fluff'), readRecordKey('gone')].sort())
  })

  test('a copy already read by date keeps what it has', () => {
    const fluff = list('fluff')
    const dated = { query: copyQuery([fluff]), from: SINCE, through: TODAY - 1, readAt: AT + 5, rows: packRows([{ sid: 'c1', day: SINCE }]) }
    const stored = { [KEY]: { v: 3, scrapedAt: 5, ids: packSids(['c1']), descriptor: describeList(fluff), dated } }
    const plan = planRecordMigration(new Map([['fluff', record(fluff, [{ sid: 'a1', day: START }])]]), [fluff], stored, emptyCopy)
    assert.deepEqual(plan.writes, {})
    assert.deepEqual(plan.drop, [readRecordKey('fluff')])
  })

  test('run again over what it wrote, it changes nothing', () => {
    const fluff = list('fluff')
    const records = new Map([['fluff', record(fluff, [{ sid: 'a1', day: START }])]])
    const first = planRecordMigration(records, [fluff], {}, emptyCopy)
    const second = planRecordMigration(records, [fluff], applied({}, first), emptyCopy)
    assert.deepEqual(second.writes, {})
    const third = planRecordMigration(new Map(), [fluff], applied({}, first), emptyCopy)
    assert.deepEqual(third, { writes: {}, drop: [] })
  })
})

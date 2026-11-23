import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { dayOf } from '../../src/common/trackedLists.ts'
import { copyQuery, copyWanted, datedFor, datedOf, mergeDatedPage, mergeWalk, packRows, pageBase, resetForFull, settledThrough, sharedExclusions, unpackRows } from '../../src/common/trackedReads.ts'
import { fromShortId, packOrderedIds, toShortId, unpackOrderedIds } from '../../src/common/workId.ts'

const TODAY = dayOf('20 Sep 2026')
const SINCE = dayOf('1 Sep 2026')
const AT = Date.UTC(2026, 8, 20, 12)

function list(id, extra = {}) {
  return { id, kind: 'works-filter', url: '/tags/Fluff/works', alias: id, tracked: true, since: SINCE, ...extra }
}

/** Short ids a stored list names, in order. */
const idsOf = copy => unpackOrderedIds(copy.ids).map(toShortId)
const packSids = sids => packOrderedIds(sids.map(fromShortId))

/** A stored copy holding `sids`, undated unless `dated` is given. */
function copy(sids = [], dated) {
  return { v: 3, scrapedAt: AT - 86_400_000, ids: packSids(sids), descriptor: { sourceId: 'works-filter', label: 'Fluff', listUrl: 'https://archiveofourown.org/tags/Fluff/works' }, ...(dated ? { dated } : {}) }
}

function dated(lists, extra = {}) {
  return { query: copyQuery(lists), from: SINCE, through: SINCE - 1, readAt: 0, rows: '', ...extra }
}

const page = (from, rows, reachedEnd = false) => ({ from, page: 1, rows: rows.map(([sid, blurbDay]) => ({ sid, blurbDay })), reachedEnd })
const context = (extra = {}) => ({ readDay: TODAY, scanned: false, at: AT, ...extra })

/** Every work a copy's dated rows name is one its ids name. */
function assertRowsInIds(stored) {
  const ids = new Set(idsOf(stored))
  for (const { sid } of unpackRows(stored.dated?.rows ?? ''))
    assert.ok(ids.has(sid), `${sid} is in the rows but not the ids`)
}

describe('copyQuery', () => {
  test('lists at one address ask the same thing, however they are spelt, named or dated', () => {
    const a = copyQuery([list('a')])
    assert.equal(copyQuery([list('b', { alias: 'other', since: SINCE + 5 })]), a)
    assert.equal(copyQuery([list('c', { url: '/tags/Fluff/works?work_search[sort_column]=kudos_count' })]), a)
  })

  test('the address and the scan mode change what it asks', () => {
    const tag = list('a', { kind: 'tag-works', url: '/tags/Rare' })
    assert.notEqual(copyQuery([list('a', { url: '/tags/Angst/works' })]), copyQuery([list('a')]))
    assert.notEqual(copyQuery([{ ...tag, scan: true }]), copyQuery([tag]))
  })

  test('a copy read in scan mode for any of its lists is read in scan mode', () => {
    const tag = list('a', { kind: 'tag-works', url: '/tags/Rare' })
    assert.equal(copyQuery([tag, { ...tag, id: 'b', scan: true }]), copyQuery([{ ...tag, scan: true }]))
  })

  test('only the tags every list excludes are left out', () => {
    const excluding = (...names) => ({ facets: { freeforms: { ex: names } } })
    const shared = copyQuery([list('a', { filter: excluding('Angst', 'Smut') }), list('b', { filter: excluding('Smut', 'Gore') })])
    assert.equal(shared, copyQuery([list('a', { filter: excluding('Smut') })]))
    assert.equal(copyQuery([list('a', { filter: excluding('Smut') }), list('b')]), copyQuery([list('a')]))
  })

  test('the order of the lists asks nothing different', () => {
    const excluding = { facets: { freeforms: { ex: ['Smut'] } } }
    const one = list('a', { filter: excluding })
    const two = list('b', { filter: excluding, since: SINCE - 3 })
    assert.equal(copyQuery([one, two]), copyQuery([two, one]))
  })
})

describe('sharedExclusions', () => {
  test('the tags every list excludes, sorted; none with no lists', () => {
    const excluding = (...names) => ({ filter: { facets: { freeforms: { ex: names } } } })
    assert.deepEqual(sharedExclusions([excluding('Smut', 'Angst'), excluding('Angst', 'Smut', 'Gore')]), ['Angst', 'Smut'])
    assert.deepEqual(sharedExclusions([]), [])
  })
})

describe('copyWanted', () => {
  const lists = [list('a')]
  const readOn = (day, through) => copy([], dated(lists, { through, readAt: day * 86_400_000 + 3_600_000 }))

  test('a copy never read by date for its lists wants reading', () => {
    assert.equal(copyWanted(null, lists, TODAY - 1, TODAY), true)
    assert.equal(copyWanted(copy(['a1']), lists, TODAY - 1, TODAY), true)
  })

  test('asked through yesterday: wanted while settled short of it', () => {
    assert.equal(copyWanted(readOn(TODAY, TODAY - 1), lists, TODAY - 1, TODAY), false)
    assert.equal(copyWanted(readOn(TODAY - 1, TODAY - 2), lists, TODAY - 1, TODAY), true)
  })

  test('asked through an earlier day, a copy settled that far isn\'t read', () => {
    assert.equal(copyWanted(readOn(TODAY - 3, TODAY - 4), lists, TODAY - 5, TODAY), false)
  })

  test('asked through today: wanted unless read today', () => {
    assert.equal(copyWanted(readOn(TODAY, TODAY - 1), lists, TODAY, TODAY), false)
    assert.equal(copyWanted(readOn(TODAY - 1, TODAY - 1), lists, TODAY, TODAY), true)
  })
})

describe('datedOf / settledThrough', () => {
  const lists = [list('a')]

  test('a dated part of the lists\' query is the copy\'s, and says how far it is settled', () => {
    const stored = copy(['a1'], dated(lists, { through: TODAY - 2, readAt: AT }))
    assert.deepEqual(datedOf(stored, lists), stored.dated)
    assert.equal(settledThrough(stored, lists), TODAY - 2)
  })

  test('none for no copy, an undated copy, another query, or a malformed part', () => {
    assert.equal(settledThrough(null, lists), null)
    assert.equal(settledThrough(copy(['a1']), lists), null)
    assert.equal(datedOf(copy([], dated([list('a', { url: '/tags/Angst/works' })])), lists), null)
    for (const broken of [{ rows: 7 }, { from: 'x' }, { through: SINCE - 5 }, { readAt: 1.5 }])
      assert.equal(datedOf(copy([], dated(lists, broken)), lists), null, JSON.stringify(broken))
  })

  test('a dated part read for nothing yet is settled through the day before its start', () => {
    assert.equal(settledThrough(copy([], dated(lists)), lists), SINCE - 1)
  })
})

describe('datedFor', () => {
  const lists = [list('a'), list('b', { since: SINCE - 4 })]

  test('an undated copy keeps its works and starts a stretch at the earliest tracking day', () => {
    const next = datedFor(copy(['a1', 'a2']), lists, TODAY)
    assert.deepEqual(idsOf(next), ['a1', 'a2'])
    assert.deepEqual(next.dated, { query: copyQuery(lists), from: SINCE - 4, through: SINCE - 5, readAt: 0, rows: '' })
  })

  test('a dated part of another query is dropped, and its works with it', () => {
    const stored = copy(['a1'], { ...dated(lists), query: 'something else', rows: packRows([{ sid: 'a1', day: SINCE }]) })
    const next = datedFor(stored, lists, TODAY)
    assert.deepEqual(idsOf(next), [])
    assert.equal(next.dated.rows, '')
    assert.equal(next.dated.through, SINCE - 5)
  })

  test('a copy that covers what is asked comes back as it is', () => {
    const stored = copy(['a1'], dated(lists, { from: SINCE - 4, through: TODAY - 1, readAt: AT, rows: packRows([{ sid: 'a1', day: SINCE }]) }))
    assert.equal(datedFor(stored, lists, TODAY), stored)
    assert.equal(datedFor(stored, lists, TODAY, { askFrom: SINCE }), stored)
  })

  test('asked from before the tracking day, nothing earlier is wanted, so a copy from the tracking day covers it', () => {
    const stored = copy(['a1'], dated(lists, { from: SINCE - 4, through: TODAY - 1, readAt: AT }))
    assert.equal(datedFor(stored, lists, TODAY, { askFrom: SINCE - 30 }), stored)
  })

  test('a copy starting before a tracking day moved later keeps its stretch', () => {
    const stored = copy(['a1'], dated(lists, { from: SINCE - 10, through: TODAY - 1, readAt: AT }))
    assert.equal(datedFor(stored, lists, TODAY, { askFrom: SINCE - 30 }), stored)
  })

  test('asked for days before its stretch, it is read again from the tracking day, works kept', () => {
    const rows = packRows([{ sid: 'a1', day: SINCE + 3 }])
    const stored = copy(['a1'], dated(lists, { from: SINCE + 2, through: TODAY - 1, readAt: AT, rows }))
    const next = datedFor(stored, lists, TODAY, { askFrom: SINCE + 1 })
    assert.deepEqual(idsOf(next), ['a1'])
    assert.equal(next.dated.rows, rows)
    assert.equal(next.dated.from, SINCE - 4)
    assert.equal(next.dated.through, SINCE - 5)
  })

  test('a full refresh reads again from the tracking day, works kept', () => {
    const rows = packRows([{ sid: 'a1', day: SINCE + 3 }])
    const stored = copy(['a1'], dated(lists, { from: SINCE - 4, through: TODAY - 1, readAt: AT, rows }))
    const next = datedFor(stored, lists, TODAY, { full: true })
    assert.equal(next.dated.rows, rows)
    assert.equal(next.dated.through, SINCE - 5)
  })

  test('lists with no readable tracking day start today', () => {
    const next = datedFor(copy(), [list('a', { since: undefined })], TODAY)
    assert.equal(next.dated.from, TODAY)
  })
})

describe('resetForFull', () => {
  test('the stretch goes back to the given day, keeping the works and the failure', () => {
    const lists = [list('a')]
    const failed = { reason: 'signed-out', at: AT }
    const rows = packRows([{ sid: 'a1', day: SINCE + 3 }])
    const next = resetForFull(copy(['a1'], dated(lists, { through: TODAY - 1, readAt: AT, rows, failed })), SINCE - 2)
    assert.deepEqual(next.dated, { ...dated(lists), from: SINCE - 2, through: SINCE - 3, readAt: AT, rows, failed })
    assert.deepEqual(idsOf(next), ['a1'])
  })
})

describe('mergeDatedPage', () => {
  const lists = [list('a')]
  const start = (sids = [], extra = {}) => datedFor(copy(sids), lists, TODAY, extra)

  test('works go newest day first, in the order read within a day', () => {
    const next = mergeDatedPage(start(), page(SINCE, [['a1', SINCE], ['a2', SINCE + 2], ['a3', SINCE + 2], ['a4', SINCE + 1]]), context())
    assert.deepEqual(idsOf(next), ['a2', 'a3', 'a4', 'a1'])
    assertRowsInIds(next)
  })

  test('a work seen again moves to its later day', () => {
    const first = mergeDatedPage(start(), page(SINCE, [['a1', SINCE], ['a2', SINCE + 1]]), context())
    const next = mergeDatedPage(first, page(SINCE + 2, [['a1', SINCE + 3]]), context())
    assert.deepEqual(idsOf(next), ['a1', 'a2'])
    assert.deepEqual(unpackRows(next.dated.rows).find(row => row.sid === 'a1'), { sid: 'a1', day: SINCE + 3 })
  })

  test('works a page doesn\'t list stay', () => {
    const first = mergeDatedPage(start(), page(SINCE, [['a1', SINCE], ['a2', SINCE + 1]], true), context({ readDay: TODAY - 3 }))
    const next = mergeDatedPage(first, page(TODAY - 3, [['a3', TODAY - 2]], true), context())
    assert.deepEqual(idsOf(next), ['a3', 'a2', 'a1'])
  })

  test('an undated copy\'s works stay after the dated ones, in their order', () => {
    const next = mergeDatedPage(start(['old2', 'old1']), page(SINCE, [['a1', SINCE]]), context())
    assert.deepEqual(idsOf(next), ['a1', 'old2', 'old1'])
    assertRowsInIds(next)
  })

  test('an undated work the page dates joins the dated ones', () => {
    const next = mergeDatedPage(start(['a1', 'old']), page(SINCE, [['a2', SINCE], ['a1', SINCE + 1]]), context())
    assert.deepEqual(idsOf(next), ['a1', 'a2', 'old'])
  })

  test('settles by the read\'s rules, stamps the copy, and clears a failure', () => {
    const failing = { ...start(), dated: { ...start().dated, failed: { reason: 'request', error: 'HTTP 500', at: AT - 5 } } }
    const ended = mergeDatedPage(failing, page(SINCE, [['a1', SINCE]], true), context())
    assert.equal(ended.dated.through, TODAY - 1)
    assert.equal(ended.dated.readAt, AT)
    assert.equal(ended.scrapedAt, AT)
    assert.equal('failed' in ended.dated, false)

    const cut = mergeDatedPage(start(), page(SINCE, [['a1', SINCE + 5]]), context())
    assert.equal(cut.dated.through, SINCE + 3)
    const scanned = mergeDatedPage(start(), page(SINCE, [['a1', SINCE + 5]]), context({ scanned: true }))
    assert.equal(scanned.dated.through, SINCE - 1)
  })

  test('the descriptor and the list\'s own markup are kept', () => {
    const stored = { ...start(), ctx: { a1: '<p>x</p>' } }
    const next = mergeDatedPage(stored, page(SINCE, [['a1', SINCE]]), context())
    assert.deepEqual(next.descriptor, stored.descriptor)
    assert.deepEqual(next.ctx, stored.ctx)
  })
})

describe('pageBase', () => {
  const lists = [list('a')]
  const held = (extra = {}) => copy(['a1'], dated(lists, { through: SINCE + 2, readAt: AT, rows: packRows([{ sid: 'a1', day: SINCE + 1 }]), ...extra }))

  test('a copy not stored when the run began merges into what the run holds', () => {
    const mine = held()
    assert.equal(pageBase(undefined, mine, lists, TODAY, SINCE + 3, false), mine)
  })

  test('a copy stored when the run began and gone since was reset: no base', () => {
    assert.equal(pageBase(undefined, held(), lists, TODAY, SINCE + 3, true), null)
  })

  test('what another writer added since is kept', () => {
    const now = copy(['a1', 'b9'], dated(lists, { through: SINCE + 2, readAt: AT + 5, rows: packRows([{ sid: 'a1', day: SINCE + 1 }, { sid: 'b9', day: SINCE + 2 }]) }))
    assert.equal(pageBase(now, held(), lists, TODAY, SINCE + 3, true), now)
  })

  test('a copy settled further by another page meanwhile is still a base', () => {
    const now = held({ through: TODAY - 1 })
    assert.equal(pageBase(now, held(), lists, TODAY, SINCE + 3, true), now)
  })

  test('a copy no longer reaching the pass — reset and read afresh elsewhere — is no base', () => {
    const fresh = copy([], dated(lists))
    assert.equal(pageBase(fresh, held(), lists, TODAY, SINCE + 3, true), null)
  })

  test('a copy whose stretch now starts later than the run\'s is no base', () => {
    assert.equal(pageBase(held({ from: SINCE + 1 }), held(), lists, TODAY, SINCE + 3, true), null)
  })

  test('with no pass under way (a failure being noted), any stored copy is a base', () => {
    const fresh = copy([], dated(lists))
    assert.equal(pageBase(fresh, held(), lists, TODAY, null, true), fresh)
  })
})

describe('mergeWalk', () => {
  const lists = [list('a')]
  const walk = rows => rows.map(([sid, blurbDay]) => ({ sid, blurbDay }))

  test('a page walked as it is shown merges in at blurb days, settling nothing', () => {
    const stored = copy(['a1'], dated(lists, { through: SINCE + 3, readAt: AT, rows: packRows([{ sid: 'a1', day: SINCE + 1 }]) }))
    const next = mergeWalk(stored, walk([['a2', SINCE + 5], ['a1', SINCE + 2]]), lists, TODAY, AT + 9)
    assert.deepEqual(idsOf(next), ['a2', 'a1'])
    assert.deepEqual(unpackRows(next.dated.rows), [{ sid: 'a1', day: SINCE + 2 }, { sid: 'a2', day: SINCE + 5 }])
    assert.equal(next.dated.through, SINCE + 3)
    assert.equal(next.scrapedAt, AT + 9)
  })

  test('works dated before the copy\'s stretch, or not dated, are left out; nothing is taken off', () => {
    const stored = copy(['a1'], dated(lists, { through: SINCE + 3, readAt: AT, rows: packRows([{ sid: 'a1', day: SINCE + 1 }]) }))
    const next = mergeWalk(stored, walk([['old', SINCE - 3], ['blank', Number.NaN]]), lists, TODAY, AT)
    assert.deepEqual(idsOf(next), ['a1'])
  })

  test('an undated copy is given a stretch from its tracking day, settled for nothing, and keeps its works', () => {
    const next = mergeWalk(copy(['x1']), walk([['a1', SINCE + 1]]), lists, TODAY, AT)
    assert.deepEqual(idsOf(next), ['a1', 'x1'])
    assert.equal(next.dated.through, SINCE - 1)
  })
})

describe('mergeWalk keeps what only a read by date says', () => {
  const lists = [list('a')]

  test('when the copy was last read by date, and why that read gave up', () => {
    const failed = { reason: 'signed-out', at: AT - 7 }
    const stored = copy(['a1'], dated(lists, { through: SINCE + 3, readAt: AT - 9, rows: packRows([{ sid: 'a1', day: SINCE + 1 }]), failed }))
    const next = mergeWalk(stored, [{ sid: 'a2', blurbDay: SINCE + 5 }], lists, TODAY, AT)
    assert.equal(next.dated.readAt, AT - 9)
    assert.deepEqual(next.dated.failed, failed)
  })
})

describe('mergeWalk of a whole read', () => {
  const lists = [list('a')]
  const failed = { reason: 'request', at: AT - 9 }
  const stored = () => copy(['a1'], dated(lists, { through: SINCE + 3, readAt: AT - 9, rows: packRows([{ sid: 'a1', day: SINCE + 1 }]), failed }))

  test('settles the copy through the day before the read, clears its failure and says when it was read', () => {
    const next = mergeWalk(stored(), [{ sid: 'a2', blurbDay: SINCE + 5 }], lists, TODAY, AT, { whole: true, from: null })
    assert.equal(next.dated.through, TODAY - 1)
    assert.equal(next.dated.readAt, AT)
    assert.equal('failed' in next.dated, false)
  })

  test('a whole read from no later than the copy\'s stretch counts; one starting later doesn\'t', () => {
    assert.equal(mergeWalk(stored(), [], lists, TODAY, AT, { whole: true, from: SINCE }).dated.through, TODAY - 1)
    assert.equal(mergeWalk(stored(), [], lists, TODAY, AT, { whole: true, from: SINCE + 1 }).dated.through, SINCE + 3)
  })

  test('a read that isn\'t whole settles nothing', () => {
    assert.equal(mergeWalk(stored(), [], lists, TODAY, AT, { whole: false, from: null }).dated.through, SINCE + 3)
  })
})

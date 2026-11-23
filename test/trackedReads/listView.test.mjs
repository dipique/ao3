import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { dayOf } from '../../src/common/trackedLists.ts'
import { copyQuery, copyViews, failureWords, listRows, packRows, unpackRows, viewSummary, windowFromRecords } from '../../src/common/trackedReads.ts'

const TODAY = dayOf('20 Sep 2026')
const SINCE = dayOf('1 Sep 2026')
const AT = Date.UTC(2026, 8, 20, 12)

function list(id, extra = {}) {
  return { id, kind: 'works-filter', url: '/tags/Fluff/works', alias: id, tracked: true, since: SINCE, ...extra }
}

function copy(lists, dated = {}) {
  return { v: 3, scrapedAt: AT, ids: '', dated: { query: copyQuery(lists), from: SINCE, through: TODAY - 1, readAt: AT, rows: '', ...dated } }
}

describe('listRows', () => {
  const early = list('early')
  const late = list('late', { since: SINCE + 5 })
  const both = [early, late]
  const rows = packRows([{ sid: 'a', day: SINCE + 1 }, { sid: 'b', day: SINCE + 6 }, { sid: 'c', day: SINCE + 5 }])

  test('a list sees the copy from its own tracking day', () => {
    const stored = copy(both, { rows })
    const view = listRows(late, stored, both)
    assert.deepEqual(unpackRows(view.rows).map(row => row.sid), ['b', 'c'])
    assert.equal(view.from, SINCE + 5)
    assert.equal(view.through, TODAY - 1)
    assert.equal(view.readAt, AT)
    assert.deepEqual(unpackRows(listRows(early, stored, both).rows).map(row => row.sid), ['a', 'b', 'c'])
  })

  test('a copy settled short of a list\'s tracking day has nothing missing for it before that day', () => {
    const view = listRows(late, copy(both, { through: SINCE + 1 }), both)
    assert.equal(view.from, SINCE + 5)
    assert.equal(view.through, SINCE + 4)
  })

  test('no view of no copy, an undated copy, or one read for other lists', () => {
    assert.equal(listRows(early, null, both), null)
    assert.equal(listRows(early, { ...copy(both), dated: undefined }, both), null)
    assert.equal(listRows(early, copy([list('x', { url: '/tags/Angst/works' })]), both), null)
  })

  test('a failure on the copy is every sharing list\'s', () => {
    const failed = { reason: 'signed-out', at: AT }
    assert.deepEqual(listRows(late, copy(both, { failed }), both).failed, failed)
    assert.equal('failed' in listRows(late, copy(both), both), false)
  })

  test('the review\'s window takes the views', () => {
    const stored = copy(both, { rows, through: SINCE + 7 })
    const records = new Map(both.map(one => [one.id, listRows(one, stored, both)]))
    const window = windowFromRecords({ lists: both, records, start: SINCE, today: SINCE + 8, target: 50, member: () => true, counts: () => true })
    assert.deepEqual(window.works.map(work => [work.sid, work.lists]), [['a', ['early']], ['c', ['early', 'late']], ['b', ['early', 'late']]])
    assert.deepEqual(window.complete, ['early', 'late'])
  })

  test('a failed copy short of the window marks its lists failed', () => {
    const stored = copy(both, { through: SINCE, failed: { reason: 'request', at: AT } })
    const records = new Map(both.map(one => [one.id, listRows(one, stored, both)]))
    const window = windowFromRecords({ lists: both, records, start: SINCE + 6, today: SINCE + 8, target: 50, member: () => true, counts: () => true })
    assert.deepEqual(window.failed, ['early', 'late'])
  })
})

describe('viewSummary', () => {
  test('how far every list read is settled, and which lists have nothing read yet', () => {
    const lists = [list('a'), list('b'), list('c'), list('off', { tracked: false })]
    const views = new Map([
      ['a', { from: SINCE, through: TODAY - 1, readAt: AT, rows: '' }],
      ['b', { from: SINCE, through: TODAY - 4, readAt: AT, rows: '' }],
      ['c', { from: SINCE, through: SINCE - 1, readAt: 0, rows: '' }],
    ])
    assert.deepEqual(viewSummary(lists, views), { through: TODAY - 4, behind: ['c'] })
    assert.deepEqual(viewSummary(lists, new Map()), { through: null, behind: ['a', 'b', 'c'] })
  })
})

describe('failureWords', () => {
  test('each reason says something of its own', () => {
    const words = ['signed-out', 'not-archive', 'request'].map(reason => failureWords(reason))
    assert.equal(new Set(words).size, 3)
  })

  test('a request error gives AO3\'s status, not the address asked', () => {
    const words = failureWords('request', 'Request failed with status 503: https://archiveofourown.org/works?page=2')
    assert.ok(words.includes('503'))
    assert.equal(words.includes('https://'), false)
  })
})

describe('copyViews', () => {
  test('each tracked list\'s view of the copy stored under its key, shared with the lists at that key', () => {
    const one = list('one')
    const two = list('two', { since: SINCE + 2 })
    const other = list('other', { url: '/tags/Angst/works' })
    const off = list('off', { tracked: false })
    const stored = { 'works-filter:/tags/Fluff/works': copy([one, two], { rows: packRows([{ sid: 'a', day: SINCE }, { sid: 'b', day: SINCE + 3 }]) }) }
    const views = copyViews([one, two, other, off], stored)
    assert.deepEqual([...views.keys()], ['one', 'two'])
    assert.deepEqual(unpackRows(views.get('two').rows).map(row => row.sid), ['b'])
  })
})

describe('copyViews against the review\'s start', () => {
  test('a copy whose stretch starts after the days a list wants holds nothing settled for it', () => {
    const one = list('one', { since: SINCE - 10 })
    const stored = { 'works-filter:/tags/Fluff/works': copy([one], { from: SINCE, through: TODAY - 1, rows: packRows([{ sid: 'a', day: SINCE + 1 }]) }) }
    const view = copyViews([one], stored, SINCE - 5).get('one')
    assert.equal(view.from, SINCE - 5)
    assert.equal(view.through, SINCE - 6, 'nothing settled until the days before the stretch are read')
    assert.deepEqual(unpackRows(view.rows).map(row => row.sid), ['a'])
  })

  test('a stretch from the review\'s start, or from the list\'s tracking day, covers what the list wants', () => {
    const one = list('one', { since: SINCE - 10 })
    const stored = { 'works-filter:/tags/Fluff/works': copy([one], { from: SINCE, through: TODAY - 1 }) }
    assert.equal(copyViews([one], stored, SINCE).get('one').through, TODAY - 1)
    assert.equal(copyViews([one], stored, SINCE + 3).get('one').through, TODAY - 1)
  })

  test('a tracked list whose address can\'t be read has a view saying so', () => {
    const lost = list('lost', { url: 'https://example.com/tags/x' })
    const view = copyViews([lost], {}, SINCE).get('lost')
    assert.equal(view.failed.reason, 'not-archive')
    assert.equal(view.readAt, 0)
  })
})

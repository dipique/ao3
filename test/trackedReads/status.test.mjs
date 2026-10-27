import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { dayOf } from '../../src/common/trackedLists.ts'
import { formatRange, reviewStatus } from '../../src/common/trackedReads.ts'
import { figures, mentions } from '../facts.mjs'

const START = dayOf('30 Sep 2026')
const labels = new Map([['a', 'Alpha'], ['b', 'Beta'], ['c', 'Gamma']])

function status(window, over = {}) {
  return reviewStatus({
    window: { start: START, end: START + 2, complete: [], pending: [], failed: [], ...window },
    labels,
    wait: null,
    elsewhere: false,
    stopped: false,
    readAt: '14:02',
    ...over,
  })
}

describe('formatRange', () => {
  test('the year once when both ends share it, one day as itself', () => {
    assert.equal(formatRange(START, START + 2), '30 Sep – 02 Oct 2026')
    assert.equal(formatRange(START, START), '30 Sep 2026')
    assert.equal(formatRange(dayOf('30 Dec 2026'), dayOf('02 Jan 2027')), '30 Dec 2026 – 02 Jan 2027')
  })
})

describe('reviewStatus', () => {
  test('up to date, as of when the records were last written', () => {
    const line = status({ complete: ['a', 'b'] })
    assert.equal(line.kind, 'current')
    assert.deepEqual(line.lists, [])
    assert.equal(line.reading, undefined)
    assert.ok(mentions(line.text, '14:02'), line.text)
  })

  test('still reading: how many lists, for which days, named on hover', () => {
    const line = status({ complete: ['a'], pending: ['b', 'c'] })
    assert.equal(line.kind, 'pending')
    assert.equal(line.reading, 'here')
    assert.deepEqual(line.lists, ['Beta', 'Gamma'])
    assert.deepEqual(figures(line.text, formatRange(START, START + 2)), [2, 3], 'two of the three lists, for the window\'s days')
  })

  test('with the pause this page is sitting out, or the other page doing the reading', () => {
    const window = { complete: ['a'], pending: ['b'] }
    const wait = 'trying again in 1:05'
    const waiting = status(window, { wait })
    assert.equal(waiting.reading, 'waiting')
    assert.ok(mentions(waiting.text, wait), 'the countdown is part of the line')
    assert.equal(status(window, { elsewhere: true }).reading, 'elsewhere')
  })

  test('a reading that stopped for AO3 says the lists are not yet read', () => {
    const line = status({ complete: ['a'], pending: ['b'] }, { stopped: true })
    assert.equal(line.kind, 'pending')
    assert.equal(line.reading, 'stopped')
    assert.deepEqual(line.lists, ['Beta'])
    assert.ok(mentions(line.text, formatRange(START, START + 2)), 'for the window\'s days')
  })

  test('a list that failed outranks one still being read', () => {
    const line = status({ pending: ['a'], failed: ['b'] })
    assert.equal(line.kind, 'failed')
    assert.deepEqual(line.lists, ['Beta'])
    assert.ok(mentions(line.text, 'Beta') && !mentions(line.text, 'Alpha'), line.text)
    const both = status({ failed: ['a', 'b'] })
    assert.deepEqual(both.lists, ['Alpha', 'Beta'])
    assert.ok(mentions(both.text, 'Alpha') && mentions(both.text, 'Beta'), both.text)
  })
})

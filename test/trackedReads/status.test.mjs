import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { dayOf } from '../../src/common/trackedLists.ts'
import { formatRange, reviewStatus } from '../../src/common/trackedReads.ts'

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
    assert.deepEqual(status({ complete: ['a', 'b'] }), { kind: 'current', text: 'Up to date as of 14:02', lists: [] })
  })

  test('still reading: how many lists, for which days, named on hover', () => {
    assert.deepEqual(status({ complete: ['a'], pending: ['b', 'c'] }), {
      kind: 'pending',
      text: 'Still reading 2 of 3 lists for 30 Sep – 02 Oct 2026',
      lists: ['Beta', 'Gamma'],
    })
  })

  test('with the pause this page is sitting out, or the other page doing the reading', () => {
    const window = { complete: ['a'], pending: ['b'] }
    assert.equal(status(window, { wait: 'AO3 asked us to slow down — trying again in 1:05' }).text, 'Still reading 1 of 2 lists for 30 Sep – 02 Oct 2026 — AO3 asked us to slow down — trying again in 1:05')
    assert.equal(status(window, { elsewhere: true }).text, 'Still reading 1 of 2 lists for 30 Sep – 02 Oct 2026, in another tab')
  })

  test('a reading that stopped for AO3 says the lists are not yet read, and how to try again', () => {
    assert.deepEqual(status({ complete: ['a'], pending: ['b'] }, { stopped: true }), {
      kind: 'pending',
      text: 'Not yet read: 1 of 2 lists for 30 Sep – 02 Oct 2026 — AO3 asked us to slow down. Refresh to try again.',
      lists: ['Beta'],
    })
  })

  test('a list that failed outranks one still being read', () => {
    assert.deepEqual(status({ pending: ['a'], failed: ['b'] }), {
      kind: 'failed',
      text: '“Beta” couldn’t be loaded, so its works are missing from this range.',
      lists: ['Beta'],
    })
    assert.equal(status({ failed: ['a', 'b'] }).text, '“Alpha”, “Beta” couldn’t be loaded, so their works are missing from this range.')
  })
})

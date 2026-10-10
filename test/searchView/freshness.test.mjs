import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { OPTION_DEFAULTS } from '../../src/common/optionDefaults.ts'
import { HOUR_MS, isFresh, refreshIntervalMs } from '../../src/content_script/searchView/freshness.ts'

const AO3 = 'https://archiveofourown.org'
const NOW = 1_800_000_000_000
const DAY = refreshIntervalMs(24)
const BY_TITLE = `${AO3}/tags/Bees/works?work_search[sort_column]=title`

/** A stored copy read from `listUrl`, `age` ago. */
function copy(age, { listUrl = BY_TITLE, missing = 0 } = {}) {
  return { scrapedAt: NOW - age, missing, listUrl }
}

/** What an open of `listUrl` under `intervalMs` asks of a copy. */
function wanted(intervalMs, listUrl = BY_TITLE) {
  return { intervalMs, listUrl, now: NOW }
}

describe('refreshIntervalMs', () => {
  test('is a refresh-after setting\'s hours in ms', () => {
    assert.equal(refreshIntervalMs(1), HOUR_MS)
    assert.equal(refreshIntervalMs(168), 168 * HOUR_MS)
  })

  test('reads anything that isn\'t a positive number of hours as every time', () => {
    for (const hours of [0, -6, Number.NaN, undefined, null])
      assert.equal(refreshIntervalMs(hours), 0, String(hours))
  })

  test('the listing views start out reading their listing on every open, and the reader\'s own lists trusting a copy for a day', () => {
    assert.equal(OPTION_DEFAULTS.searchListingsRefreshHours, 0)
    assert.equal(refreshIntervalMs(OPTION_DEFAULTS.searchProfileListsRefreshHours), DAY)
  })
})

describe('isFresh', () => {
  test('a copy younger than the interval is shown as it is', () => {
    assert.equal(isFresh(copy(0), wanted(DAY)), true)
    assert.equal(isFresh(copy(DAY - 1), wanted(DAY)), true)
  })

  test('a copy the interval\'s age or older is read again', () => {
    assert.equal(isFresh(copy(DAY), wanted(DAY)), false)
    assert.equal(isFresh(copy(DAY + 1), wanted(DAY)), false)
  })

  test('with no interval, every copy is read again, however new', () => {
    assert.equal(isFresh(copy(0), wanted(0)), false)
  })

  test('a copy stamped later than now — a clock set back — is read again', () => {
    assert.equal(isFresh(copy(-HOUR_MS), wanted(DAY)), false)
  })

  test('a copy naming works whose blurbs are gone is read again, since only a read can bring them back', () => {
    assert.equal(isFresh(copy(HOUR_MS, { missing: 1 }), wanted(DAY)), false)
  })

  test('a copy of another read of the listing is read again: another sort, or another date range', () => {
    assert.equal(isFresh(copy(HOUR_MS), wanted(DAY, `${AO3}/tags/Bees/works?work_search[sort_column]=kudos_count`)), false)
    assert.equal(isFresh(copy(HOUR_MS), wanted(DAY, `${BY_TITLE}&work_search[date_from]=2026-01-01`)), false)
    assert.equal(isFresh(copy(HOUR_MS, { listUrl: `${BY_TITLE}&work_search[date_to]=2026-01-01` }), wanted(DAY)), false)
  })

  test('the same read in the listing\'s other spelling is shown as it is', () => {
    assert.equal(isFresh(copy(HOUR_MS), wanted(DAY, `${AO3}/works?work_search[sort_column]=title&tag_id=Bees&page=2`)), true)
  })

  test('a copy that never said what it was read from is read again', () => {
    assert.equal(isFresh({ scrapedAt: NOW - HOUR_MS, missing: 0 }, wanted(DAY)), false)
  })

  test('the reader\'s own lists, which are no listing of the archive\'s, are matched by their address', () => {
    const toRead = `${AO3}/users/me/readings?show=to-read`
    assert.equal(isFresh(copy(HOUR_MS, { listUrl: toRead }), wanted(DAY, toRead)), true)
    assert.equal(isFresh(copy(HOUR_MS, { listUrl: toRead }), wanted(DAY, `${AO3}/users/someone-else/readings?show=to-read`)), false)
  })
})

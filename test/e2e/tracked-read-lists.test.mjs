import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { unpackRows } from '../../src/common/trackedReads.ts'
import { bundleForPage } from '../siteExport/helpers.mjs'
import { findChrome, installMock, launch } from './helpers.mjs'
import { archiveRoutes, CLOCK_BASE, installClock, listing, MS_PER_DAY, readsOf, resetWorkIds, TODAY, works } from './trackedReview.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

/**
 * The reader that brings the tracked lists' read records up to date, run in an
 * archive page against the stand-in archive, over a mock `storage.local`.
 *
 * What is pinned down is which requests go out — per list, from which day,
 * which page — on a first read, on a second the same day, on one the next day,
 * and after a rate limit; and that what each page brought is kept.
 */
describe('tracked lists: the reader', { skip }, () => {
  let browser
  let script

  before(async () => {
    script = await bundleForPage('test/e2e/readListsEntry.ts', 'RL')
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  const START = TODAY - 10

  /** A tab on the archive with the reader loaded, a store of its own and the stand-in archive behind it. */
  async function openTab(fixtures, refuse = () => 0) {
    const fetched = []
    const tab = await browser.newPage()
    await tab.setRequestInterception(true)
    tab.on('request', archiveRoutes({ fixtures, fetched, refuse: url => refuse(url) }))
    await tab.evaluateOnNewDocument(installClock, CLOCK_BASE)
    await tab.evaluateOnNewDocument(installMock, {})
    await tab.goto('https://archiveofourown.org/users/me/readings')
    await tab.evaluate(script)
    return { tab, fetched }
  }

  /**
   * One run over `fixtures`' lists. The clock is first wound past the fetch
   * layer's idle reset, so one run's requests never earn the next a breather,
   * and on by `days` whole days.
   */
  function run(tab, fixtures, { days = 0, patience = 'interactive', budget = 'interactive' } = {}) {
    return tab.evaluate(async (input) => {
      window.__offset += window.RL.PACE_IDLE_RESET_MS * 2 + input.days * input.day
      const statuses = []
      const outcome = await window.RL.readTrackedLists({
        lists: input.lists,
        start: input.start,
        patience: window.RL.PATIENCE[input.patience],
        waitBudget: input.budget === 'none' ? 0 : window.RL.WAIT_BUDGET[input.budget],
        onProgress: status => statuses.push(status),
      })
      return { ...outcome, statuses }
    }, { lists: fixtures.map(fixture => fixture.entry), start: START, days, day: MS_PER_DAY, patience, budget })
  }

  /** The records the tab's store holds, by list id. */
  async function records(tab, fixtures) {
    const ids = fixtures.map(fixture => fixture.entry.id)
    return new Map(await tab.evaluate(async list => [...await window.RL.readStoredRecords(list)], ids))
  }

  /**
   * What the lists were asked for since `from` (an index into `fetched`), as
   * `[list id, from, page]`. Anything else the page asked for (its icon) is
   * left out.
   */
  const asked = (fetched, fixtures, from = 0) => {
    const byKey = new Map(fixtures.map(fixture => [fixture.key, fixture.entry.id]))
    return readsOf(fetched.slice(from)).filter(read => byKey.has(read.list)).map(read => [byKey.get(read.list), read.from, read.page])
  }

  describe('a first read, then again the same day, then the next', () => {
    resetWorkIds(7000)
    const alpha = listing('alpha', Array.from({ length: 10 }, (_, i) => [START + i, 8]))
    const beta = listing('beta', Array.from({ length: 10 }, (_, i) => [START + i, 2]))
    const gamma = listing('gamma', Array.from({ length: 7 }, (_, i) => [START + 3 + i, 1]), { entry: { since: START + 3 } })
    const fixtures = [alpha, beta, gamma]
    let tab
    let fetched

    before(async () => {
      ({ tab, fetched } = await openTab(fixtures))
    })

    after(async () => tab?.close())

    test('reads every list to its end, the list read least far always next', async () => {
      const outcome = await run(tab, fixtures)
      assert.equal(outcome.blocked, false)
      assert.deepEqual(outcome.failed, [])
      assert.deepEqual(asked(fetched, fixtures), [
        ['alpha', START, 1],
        ['beta', START, 1],
        ['alpha', START, 2],
        ['alpha', START, 3],
        ['gamma', START + 3, 1],
        ['alpha', START, 4],
      ])
      assert.equal(outcome.requests, 6)

      const stored = await records(tab, fixtures)
      for (const fixture of fixtures) {
        const record = stored.get(fixture.entry.id)
        assert.equal(record.through, TODAY - 1, `${fixture.entry.id} is read through yesterday`)
        assert.deepEqual(unpackRows(record.rows).map(row => row.sid).sort(), fixture.works.map(work => Number(work.id).toString(36)).sort())
      }
      assert.equal(stored.get('gamma').from, START + 3, 'a list tracked inside the window starts on its tracking day')

      const blurbs = await tab.evaluate(async id => Object.keys(await window.browser.storage.local.get(`blurbData.${id}`)), Number(alpha.works[0].id).toString(36))
      assert.equal(blurbs.length, 1, 'each page’s works go to the blurb store')

      const last = outcome.statuses.at(-1)
      assert.deepEqual({ ...last, waitUntil: 0 }, { listsDone: 3, lists: 3, reading: null, waitUntil: 0, requests: 6 })
    })

    test('a second run the same day asks each list only for today', async () => {
      const before = fetched.length
      const outcome = await run(tab, fixtures)
      assert.deepEqual(asked(fetched, fixtures, before), [['alpha', TODAY, 1], ['beta', TODAY, 1], ['gamma', TODAY, 1]])
      assert.equal(outcome.requests, 3)
    })

    test('a run the next day asks one page per list, from the day before', async () => {
      alpha.works.push(...works([[TODAY, 3]]))
      const before = fetched.length
      await run(tab, fixtures, { days: 1 })
      assert.deepEqual(asked(fetched, fixtures, before), [['alpha', TODAY, 1], ['beta', TODAY, 1], ['gamma', TODAY, 1]])
      const stored = await records(tab, fixtures)
      assert.equal(stored.get('alpha').through, TODAY, 'trusted through the new yesterday')
      assert.equal(unpackRows(stored.get('alpha').rows).length, 83)
    })
  })

  test('a rate limit mid-run keeps every page before it, and the next run goes on from there', async () => {
    resetWorkIds(8000)
    const alpha = listing('alpha', Array.from({ length: 10 }, (_, i) => [START + i, 8]))
    const beta = listing('beta', Array.from({ length: 10 }, (_, i) => [START + i, 2]))
    const fixtures = [alpha, beta]
    let refused = false
    const refuse = (url) => {
      if (refused || !url.pathname.includes('/alpha/') || url.searchParams.get('page') !== '3')
        return 0
      refused = true
      return 30
    }
    const { tab, fetched } = await openTab(fixtures, refuse)
    try {
      const outcome = await run(tab, fixtures, { patience: 'suggestion', budget: 'none' })
      assert.equal(outcome.blocked, true)
      assert.deepEqual(outcome.failed, [])
      let stored = await records(tab, fixtures)
      assert.equal(unpackRows(stored.get('alpha').rows).length, 40, 'alpha’s first two pages are kept')
      assert.equal(stored.get('alpha').through, START + 2)
      assert.equal(stored.get('beta').through, TODAY - 1, 'beta was read to its end before the refusal')

      const before = fetched.length
      const again = await run(tab, fixtures)
      assert.equal(again.blocked, false)
      assert.deepEqual(asked(fetched, fixtures, before)[0], ['alpha', START + 3, 1], 'read on from the day after what it holds')
      stored = await records(tab, fixtures)
      assert.equal(unpackRows(stored.get('alpha').rows).length, 80)
      assert.equal(stored.get('alpha').through, TODAY - 1)
    }
    finally {
      await tab.close()
    }
  })

  test('a list that keeps failing is given up on for the run, and its record says so', async () => {
    resetWorkIds(9000)
    const alpha = listing('alpha', [[START, 2]])
    const broken = listing('broken', [[START, 2]], { list: { fail: true } })
    const fixtures = [alpha, broken]
    const { tab, fetched } = await openTab(fixtures)
    try {
      const outcome = await run(tab, fixtures)
      assert.deepEqual(outcome.failed, ['broken'])
      assert.equal(asked(fetched, fixtures).filter(([id]) => id === 'broken').length, 3, 'three tries, then no more')
      const stored = await records(tab, fixtures)
      assert.equal(stored.get('broken').failed, true)
      assert.equal(stored.get('broken').through, START - 1)
      assert.equal(stored.get('alpha').through, TODAY - 1)
    }
    finally {
      await tab.close()
    }
  })
})

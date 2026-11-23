import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { copyKeyOf } from '../../src/common/listLinks.ts'
import { copyQuery, packRows, unpackRows } from '../../src/common/trackedReads.ts'
import { bundleForPage } from '../siteExport/helpers.mjs'
import { findChrome, installMock, launch } from './helpers.mjs'
import { archiveRoutes, CLOCK_BASE, installClock, listing, MS_PER_DAY, readsOf, resetWorkIds, search, series, TODAY } from './trackedReview.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

/**
 * The updater that brings tracked lists' offline copies up to date by date, run
 * in an archive page against the stand-in archive, over a mock `storage.local`.
 *
 * What is pinned down is which requests go out — per copy, from which day,
 * which page — and what each copy then holds: its works, newest day first, and
 * the day it is settled through.
 */
describe('tracked lists: the copy updater', { skip }, () => {
  let browser
  let script

  before(async () => {
    script = await bundleForPage('test/e2e/updateCopiesEntry.ts', 'UC')
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  const SINCE = TODAY - 10
  const sid = work => Number(work.id).toString(36)

  /** A tab on the archive with the updater loaded, a store seeded with `seed`, and the stand-in archive behind it. */
  async function openTab(fixtures, { refuse = () => 0, seed = {} } = {}) {
    const fetched = []
    const tab = await browser.newPage()
    await tab.setRequestInterception(true)
    tab.on('request', archiveRoutes({ fixtures, fetched, refuse: url => refuse(url) }))
    await tab.evaluateOnNewDocument(installClock, CLOCK_BASE)
    await tab.evaluateOnNewDocument(installMock, seed)
    await tab.goto('https://archiveofourown.org/users/me/readings')
    await tab.evaluate(script)
    return { tab, fetched }
  }

  /**
   * One run over `fixtures`' lists. The clock is first wound past the fetch
   * layer's idle reset, so one run's requests never earn the next a breather,
   * and on by `days` whole days and `ms` more. `through` is a day offset from
   * the run's today; absent, to the end.
   */
  function run(tab, fixtures, { days = 0, ms = 0, through, refresh = false, full = false, only, resetAfterPage, writeFirst, budget = 'interactive' } = {}) {
    return tab.evaluate(async (input) => {
      window.__offset += window.UC.PACE_IDLE_RESET_MS * 2 + input.days * input.day + input.ms
      const today = Math.floor(Date.now() / input.day)
      const statuses = []
      let reset = false
      let wrote = false
      const outcome = await window.UC.updateTrackedCopies({
        entries: input.lists,
        only: input.only,
        through: today + (input.through ?? 0),
        refresh: input.refresh,
        full: input.full,
        holder: 'page',
        patience: window.UC.PATIENCE.suggestion,
        waitBudget: input.budget === 'none' ? 0 : window.UC.WAIT_BUDGET[input.budget],
        onProgress: (status) => {
          statuses.push(status)
          // Another page writing a copy before this run has asked for anything.
          if (input.writeFirst && !wrote) {
            wrote = true
            void window.browser.storage.local.get('cache.searchLists').then(({ 'cache.searchLists': lists }) =>
              window.browser.storage.local.set({ 'cache.searchLists': { ...lists, [input.writeFirst.key]: input.writeFirst.copy } }))
          }
          // Reset list data, from another page, once the list's first page has landed.
          if (input.resetAfterPage && !reset && status.byList[input.resetAfterPage.id]?.page === 1) {
            reset = true
            void window.browser.storage.local.get('cache.searchLists').then(({ 'cache.searchLists': lists }) => {
              const { [input.resetAfterPage.key]: _gone, ...rest } = lists
              return window.browser.storage.local.set({ 'cache.searchLists': rest })
            })
          }
        },
      })
      return { ...outcome, statuses }
    }, { lists: fixtures.map(fixture => fixture.entry), days, ms, day: MS_PER_DAY, through, refresh, full, only, resetAfterPage, writeFirst, budget })
  }

  /** The copy stored for `fixture`'s list, or undefined. */
  async function copyOf(tab, fixture) {
    const lists = await tab.evaluate(async () => (await window.browser.storage.local.get('cache.searchLists'))['cache.searchLists'] ?? {})
    return lists[copyKeyOf(fixture.entry)]
  }

  const idsOf = copy => copy.ids ? copy.ids.split(',') : []

  /** What the lists were asked for since `from` (an index into `fetched`), as `[fixture key, from, page]`. Anything else the page asked for (its icon) is left out. */
  const asked = (fetched, from = 0) => readsOf(fetched.slice(from)).filter(read => read.list !== '/favicon.ico').map(read => [read.list, read.from, read.page])

  describe('a first read, then again the same day, then the next', () => {
    resetWorkIds(7000)
    const alpha = listing('alpha', Array.from({ length: 10 }, (_, i) => [SINCE + i, 8]), { entry: { since: SINCE } })
    const beta = listing('beta', Array.from({ length: 10 }, (_, i) => [SINCE + i, 2]), { entry: { since: SINCE } })
    const fixtures = [alpha, beta]
    let tab
    let fetched

    before(async () => {
      ({ tab, fetched } = await openTab(fixtures))
    })

    after(async () => tab?.close())

    test('reads every copy to its end from its tracking day, the copy read least far always next', async () => {
      const outcome = await run(tab, fixtures)
      assert.equal(outcome.blocked, false)
      assert.deepEqual(outcome.failed, [])
      assert.deepEqual(asked(fetched), [
        ['/tags/alpha/works', SINCE, 1],
        ['/tags/beta/works', SINCE, 1],
        ['/tags/alpha/works', SINCE, 2],
        ['/tags/alpha/works', SINCE, 3],
        ['/tags/alpha/works', SINCE, 4],
      ])
      const copy = await copyOf(tab, alpha)
      assert.equal(copy.dated.through, TODAY - 1)
      assert.equal(copy.dated.from, SINCE)
      assert.equal(unpackRows(copy.dated.rows).length, 80)
      assert.equal(idsOf(copy)[0], sid(alpha.works.at(-8)), 'the newest day comes first')
      assert.equal(idsOf(copy).at(-1), sid(alpha.works[7]), 'the oldest day last')
      assert.equal(copy.descriptor.listUrl, 'https://archiveofourown.org/tags/alpha/works')
      assert.equal(outcome.statuses.at(-1).byList.alpha.phase, 'done')
    })

    test('asked again the same day through yesterday, nothing is read', async () => {
      const before = fetched.length
      const outcome = await run(tab, fixtures, { through: -1 })
      assert.deepEqual(asked(fetched, before), [])
      assert.equal(outcome.requests, 0)
    })

    test('a Refresh the same day asks each copy only for today', async () => {
      const before = fetched.length
      await run(tab, fixtures, { refresh: true })
      assert.deepEqual(asked(fetched, before), [['/tags/alpha/works', TODAY, 1], ['/tags/beta/works', TODAY, 1]])
    })

    test('asked the next day, one page per copy, from the day before', async () => {
      const before = fetched.length
      await run(tab, fixtures, { days: 1, through: -1 })
      assert.deepEqual(asked(fetched, before), [['/tags/alpha/works', TODAY, 1], ['/tags/beta/works', TODAY, 1]])
      assert.equal((await copyOf(tab, alpha)).dated.through, TODAY)
    })
  })

  test('lists at one address share one copy, read once from the earlier tracking day', async () => {
    resetWorkIds(7500)
    const early = listing('shared', Array.from({ length: 5 }, (_, i) => [SINCE + i, 2]), { entry: { id: 'early', since: SINCE } })
    const late = { ...early, entry: { ...early.entry, id: 'late', alias: 'late', since: SINCE + 3 } }
    const { tab, fetched } = await openTab([early])
    try {
      const outcome = await run(tab, [early, late])
      assert.deepEqual(asked(fetched), [['/tags/shared/works', SINCE, 1]])
      assert.equal(unpackRows((await copyOf(tab, early)).dated.rows).length, 10)
      const last = outcome.statuses.at(-1)
      assert.deepEqual([last.byList.early.phase, last.byList.late.phase], ['done', 'done'])
      assert.equal(last.lists, 2)
    }
    finally {
      await tab.close()
    }
  })

  test('only the lists asked for are read, with the lists sharing their copy', async () => {
    resetWorkIds(7600)
    const alpha = listing('alpha', [[SINCE, 2]], { entry: { since: SINCE } })
    const beta = listing('beta', [[SINCE, 2]], { entry: { since: SINCE } })
    const off = listing('off', [[SINCE, 2]], { entry: { since: SINCE, tracked: false } })
    const { tab, fetched } = await openTab([alpha, beta, off])
    try {
      await run(tab, [alpha, beta, off], { only: ['beta', 'off'] })
      assert.deepEqual(asked(fetched), [['/tags/beta/works', SINCE, 1]])
    }
    finally {
      await tab.close()
    }
  })

  test('a copy kept before it was read by date keeps its works, and the read merges into them', async () => {
    resetWorkIds(7700)
    const alpha = listing('alpha', [[SINCE, 2]], { entry: { since: SINCE } })
    const key = copyKeyOf(alpha.entry)
    const seed = { 'cache.searchLists': { [key]: { v: 3, scrapedAt: 1, ids: 'zz1,zz2', descriptor: { sourceId: 'works-filter', label: 'Old', listUrl: 'https://archiveofourown.org/tags/alpha/works?sort=kudos' } } } }
    const { tab } = await openTab([alpha], { seed })
    try {
      await run(tab, [alpha])
      const copy = await copyOf(tab, alpha)
      assert.deepEqual(idsOf(copy), [...alpha.works.map(sid), 'zz1', 'zz2'])
      assert.equal(copy.descriptor.label, 'Old', 'the copy’s own descriptor stays')
    }
    finally {
      await tab.close()
    }
  })

  test('Full refresh reads again from the tracking day, keeping works it no longer finds', async () => {
    resetWorkIds(7800)
    const alpha = listing('alpha', [[SINCE, 2], [SINCE + 2, 2]], { entry: { since: SINCE } })
    const { tab, fetched } = await openTab([alpha])
    try {
      await run(tab, [alpha])
      const gone = alpha.works.shift()
      const before = fetched.length
      await run(tab, [alpha], { full: true })
      assert.deepEqual(asked(fetched, before), [['/tags/alpha/works', SINCE, 1]])
      const copy = await copyOf(tab, alpha)
      assert.ok(idsOf(copy).includes(sid(gone)), 'a work gone from AO3 stays')
      assert.equal(copy.dated.through, TODAY - 1)
    }
    finally {
      await tab.close()
    }
  })

  test('a rate limit mid-run keeps every page before it, and the next run goes on from there', async () => {
    resetWorkIds(8000)
    const alpha = listing('alpha', Array.from({ length: 10 }, (_, i) => [SINCE + i, 8]), { entry: { since: SINCE } })
    let refused = false
    const refuse = (url) => {
      if (refused || url.searchParams.get('page') !== '3')
        return 0
      refused = true
      return 30
    }
    const { tab, fetched } = await openTab([alpha], { refuse })
    try {
      const outcome = await run(tab, [alpha], { budget: 'none' })
      assert.equal(outcome.blocked, true)
      let copy = await copyOf(tab, alpha)
      assert.equal(unpackRows(copy.dated.rows).length, 40, 'the first two pages are kept')
      assert.equal(copy.dated.through, SINCE + 2)
      const before = fetched.length
      await run(tab, [alpha], { ms: 30_000 })
      assert.deepEqual(asked(fetched, before)[0], ['/tags/alpha/works', SINCE + 3, 1], 'read on from the day after what it holds')
      copy = await copyOf(tab, alpha)
      assert.equal(unpackRows(copy.dated.rows).length, 80)
      assert.equal(copy.dated.through, TODAY - 1)
    }
    finally {
      await tab.close()
    }
  })

  test('a series is read whole, at most once a day for a request, and every time for a Refresh', async () => {
    resetWorkIds(8700)
    const parts = series('91', [[SINCE - 40, 2], [SINCE + 1, 1], [SINCE + 5, 1]], { entry: { since: SINCE } })
    const { tab, fetched } = await openTab([parts])
    try {
      await run(tab, [parts], { through: -1 })
      assert.equal(asked(fetched).length, 1)
      const copy = await copyOf(tab, parts)
      assert.equal(copy.dated.through, TODAY - 1)
      assert.equal(idsOf(copy).length, 2, 'works from before the tracking day aren’t kept')
      await run(tab, [parts], { through: -1 })
      assert.equal(asked(fetched).length, 1, 'read today already')
      await run(tab, [parts], { refresh: true })
      assert.equal(asked(fetched).length, 2)
    }
    finally {
      await tab.close()
    }
  })

  test('signed out, or a page with no listing on it, the copy says why and keeps what it had', async () => {
    resetWorkIds(8800)
    const out = listing('out', [[SINCE, 2]], { entry: { since: SINCE }, list: { signedOut: true } })
    const blank = listing('blank', [[SINCE, 2]], { entry: { since: SINCE }, list: { blank: true } })
    const key = copyKeyOf(out.entry)
    const seed = { 'cache.searchLists': { [key]: { v: 3, scrapedAt: 1, ids: 'zz1', descriptor: { sourceId: 'works-filter', label: 'out', listUrl: 'https://archiveofourown.org/tags/out/works' } } } }
    const { tab, fetched } = await openTab([out, blank], { seed })
    try {
      const outcome = await run(tab, [out, blank])
      assert.deepEqual(outcome.failed.sort(), ['blank', 'out'])
      assert.equal(asked(fetched).filter(([key]) => key === '/tags/out/works').length, 1, 'signed out is not tried again')
      const outCopy = await copyOf(tab, out)
      assert.equal(outCopy.dated.failed.reason, 'signed-out')
      assert.deepEqual(idsOf(outCopy), ['zz1'])
      const blankCopy = await copyOf(tab, blank)
      assert.equal(blankCopy.dated.failed.reason, 'request')
      assert.ok(blankCopy.dated.failed.error, 'what went wrong with the page is kept')
      assert.equal(blankCopy.dated.through, SINCE - 1)
    }
    finally {
      await tab.close()
    }
  })

  test('a page that lands clears the failure', async () => {
    resetWorkIds(8900)
    const alpha = listing('alpha', [[SINCE, 2]], { entry: { since: SINCE }, list: { signedOut: true } })
    const { tab } = await openTab([alpha])
    try {
      await run(tab, [alpha])
      assert.ok((await copyOf(tab, alpha)).dated.failed)
      alpha.signedOut = false
      await run(tab, [alpha])
      assert.equal('failed' in (await copyOf(tab, alpha)).dated, false)
    }
    finally {
      await tab.close()
    }
  })

  test('a copy another page is reading is left to it', async () => {
    resetWorkIds(9000)
    const alpha = listing('alpha', [[SINCE, 2]], { entry: { since: SINCE } })
    const key = copyKeyOf(alpha.entry)
    const claim = { id: 'them', by: 'other-page', holder: 'options', done: 0, total: 0, waitUntil: 0, waitReason: null, outcome: null, endedAt: 0 }
    const { tab, fetched } = await openTab([alpha])
    try {
      await tab.evaluate(async (input) => {
        await window.browser.storage.local.set({ [`listRefresh.${input.key}`]: { ...input.claim, at: Date.now(), startedAt: Date.now() } })
      }, { key, claim })
      const outcome = await run(tab, [alpha])
      assert.deepEqual(asked(fetched), [])
      assert.deepEqual(outcome.failed, [])
    }
    finally {
      await tab.close()
    }
  })

  test('a copy reset while it is being read isn’t written back, and isn’t read further', async () => {
    resetWorkIds(9100)
    const alpha = listing('alpha', Array.from({ length: 8 }, (_, i) => [SINCE + i, 10]), { entry: { since: SINCE } })
    const { tab, fetched } = await openTab([alpha])
    try {
      await run(tab, [alpha], { resetAfterPage: { id: 'alpha', key: copyKeyOf(alpha.entry) } })
      assert.equal(await copyOf(tab, alpha), undefined)
      assert.equal(asked(fetched).length, 2, 'the page under way when it was reset is the last asked for')
    }
    finally {
      await tab.close()
    }
  })

  /** The refresh claim stored for `fixture`'s copy. */
  const claimOf = (tab, fixture) => tab.evaluate(async key => (await window.browser.storage.local.get(key))[key], `listRefresh.${copyKeyOf(fixture.entry)}`)

  test('each copy’s claim is let go as written once it is read, and as blocked when AO3 stops the run', async () => {
    resetWorkIds(9200)
    const alpha = listing('alpha', [[SINCE, 2]], { entry: { since: SINCE } })
    const beta = listing('beta', Array.from({ length: 4 }, (_, i) => [SINCE + i, 10]), { entry: { since: SINCE } })
    const refuse = url => (url.pathname.includes('/beta/') && url.searchParams.get('page') === '2' ? 30 : 0)
    const { tab } = await openTab([alpha, beta], { refuse })
    try {
      const outcome = await run(tab, [alpha, beta], { budget: 'none' })
      assert.equal(outcome.blocked, true)
      assert.equal((await claimOf(tab, alpha)).outcome, 'written')
      assert.equal((await claimOf(tab, beta)).outcome, 'blocked')
    }
    finally {
      await tab.close()
    }
  })

  test('asked through an earlier day, a pass stops once the copy is settled that far', async () => {
    resetWorkIds(9300)
    const alpha = listing('alpha', Array.from({ length: 10 }, (_, i) => [SINCE + i, 8]), { entry: { since: SINCE } })
    const { tab, fetched } = await openTab([alpha])
    try {
      await run(tab, [alpha], { through: -(TODAY - (SINCE + 2)) })
      assert.deepEqual(asked(fetched), [['/tags/alpha/works', SINCE, 1], ['/tags/alpha/works', SINCE, 2]], 'the second page reaches far enough')
      assert.ok((await copyOf(tab, alpha)).dated.through >= SINCE + 2)
    }
    finally {
      await tab.close()
    }
  })

  test('a copy two lists share asks AO3 to leave out only the tags both exclude', async () => {
    resetWorkIds(9400)
    const excluding = (...names) => ({ facets: { freeforms: { ex: names } } })
    const one = search('fluff', [[SINCE, 2]], { entry: { id: 'one', since: SINCE, filter: excluding('Angst', 'Smut') } })
    const two = { ...one, entry: { ...one.entry, id: 'two', alias: 'two', filter: excluding('Smut', 'Gore') } }
    const { tab, fetched } = await openTab([one])
    try {
      await run(tab, [one, two])
      assert.equal(fetched.filter(path => path.includes('fluff')).length, 1)
      const asks = new URL(fetched.find(path => path.includes('fluff')), 'https://archiveofourown.org')
      assert.equal(asks.searchParams.get('work_search[excluded_tag_names]'), 'Smut')
    }
    finally {
      await tab.close()
    }
  })

  test('a copy another page brought up to date after the run began isn’t read, nor wound back', async () => {
    resetWorkIds(9500)
    const alpha = listing('alpha', [[SINCE, 2]], { entry: { since: SINCE } })
    const key = copyKeyOf(alpha.entry)
    const settled = { v: 3, scrapedAt: 5, ids: 'zz9', descriptor: { sourceId: 'works-filter', label: 'alpha', listUrl: 'https://archiveofourown.org/tags/alpha/works' }, dated: { query: copyQuery([alpha.entry]), from: SINCE, through: TODAY - 1, readAt: CLOCK_BASE + 1, rows: packRows([{ sid: 'zz9', day: SINCE }]) } }
    const { tab, fetched } = await openTab([alpha])
    try {
      await run(tab, [alpha], { through: -1, writeFirst: { key, copy: settled } })
      assert.deepEqual(asked(fetched), [])
      assert.deepEqual(await copyOf(tab, alpha), settled)
    }
    finally {
      await tab.close()
    }
  })
})

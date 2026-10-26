import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { claimRefresh, REFRESH_CLAIM_TTL_MS } from '../../src/content_script/searchView/listRefresh.ts'
import { ensureBuilt, findChrome } from './helpers.mjs'
import { archiveTab, KEY, liveTitles, loadToRead, openToRead, runToRead, shownTitles, storedClaim, storedSeed, toReadPage, updatingNote, updatingStop } from './markedForLater.mjs'
import { until } from './optionsPage.mjs'
import { launch, linkWrites, settled } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

/** What AO3 says to wait, in seconds: long enough that the test sees the wait, and never sits it out. */
const RETRY_AFTER = 90

/**
 * The reader's Marked for Later list open in two tabs, which share one store as
 * a browser's tabs do. A stored list is refreshed by one page at a time: the
 * other tab follows that refresh — its progress, its pauses, its result — asks
 * AO3 for nothing itself, and can stop it.
 */
describe('Marked for Later: two tabs share one refresh', { skip }, () => {
  let browser

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /**
   * Two linked tabs, each with the to-read page loaded and the content script
   * not yet run on it (`runToRead`), so both see every write from here on.
   * Page 2 of the list is held back from tab A while `holding`, or refused
   * while `refusing`; `titles` is what the live list's works are called.
   */
  const pair = async (seed = storedSeed()) => {
    const archive = { titles: 'Live', holding: false, refusing: false, held: [], asked: { a: [], b: [] } }
    const answer = name => (url) => {
      const page = Number(url.searchParams.get('page') ?? 1)
      const body = toReadPage(page, archive.titles)
      if (name === 'a' && page === 2 && url.searchParams.has('page')) {
        if (archive.refusing)
          return { status: 429, headers: { 'Retry-After': String(RETRY_AFTER) }, body: 'Retry later' }
        if (archive.holding)
          return new Promise(resolve => archive.held.push(() => resolve(body)))
      }
      return body
    }
    const a = await archiveTab(browser, seed, answer('a'), archive.asked.a)
    const b = await archiveTab(browser, seed, answer('b'), archive.asked.b)
    await loadToRead(a)
    await loadToRead(b)
    await linkWrites([a, b])
    const release = () => {
      archive.holding = false
      for (const go of archive.held.splice(0))
        go()
    }
    return { a, b, archive, release }
  }

  test('a refresh in one tab shows in the other, which follows it rather than asking AO3 itself', async () => {
    const { a, b, archive, release } = await pair()
    try {
      archive.holding = true
      await runToRead(a)
      await until('tab A to be refreshing', async () => /^Updating… Loaded \d of 3 pages$/.test(await updatingNote(a) ?? ''))

      await runToRead(b)
      await until('tab B to show tab A’s refresh', async () => /^Updating… Loaded \d of 3 pages$/.test(await updatingNote(b) ?? ''))
      assert.ok(await updatingStop(b), 'with a Stop')
      assert.deepEqual(await shownTitles(b), ['Stored work 1', 'Stored work 2'], 'over the stored copy')

      release()
      await until('tab B to show the list tab A stored', async () =>
        JSON.stringify(await shownTitles(b)) === JSON.stringify(liveTitles()))
      await until('tab B’s note to go', async () => await updatingNote(b) === null)
      assert.deepEqual(archive.asked.b, [], 'tab B asked AO3 for no page of the list')
      assert.equal((await storedClaim(b))?.outcome, 'written')
    }
    finally {
      await a.close()
      await b.close()
    }
  })

  test('Stop in the other tab stops the refresh, while it sits out a pause too', async () => {
    const { a, b, archive } = await pair()
    try {
      await runToRead(a)
      await until('tab A’s first refresh to land', async () => JSON.stringify(await shownTitles(a)) === JSON.stringify(liveTitles()))
      await runToRead(b)

      // Refreshed again, by the button, into a list AO3 refuses part of.
      archive.titles = 'Newer'
      archive.refusing = true
      await a.$eval('.AO3E--search-view--refresh', button => button.click())
      const waiting = /^Updating… AO3 asked us to slow down — trying again in 1:[23]\d$/
      await until('tab B to show the pause, counting down', async () => waiting.test(await updatingNote(b) ?? ''))
      const first = await updatingNote(b)
      await until('it counts down', async () => waiting.test(await updatingNote(b) ?? '') && await updatingNote(b) !== first)

      await (await updatingStop(b)).evaluate(button => button.click())
      await until('tab A to stop', async () => await updatingNote(a) === null)
      await until('and tab B with it', async () => await updatingNote(b) === null)
      assert.equal((await storedClaim(a))?.outcome, 'cancelled')
      assert.deepEqual(await shownTitles(a), liveTitles(), 'tab A still shows the list it had')
      assert.deepEqual(archive.asked.b, [])
    }
    finally {
      await a.close()
      await b.close()
    }
  })

  test('Stop in the tab running it stops it for both', async () => {
    const { a, b, archive, release } = await pair()
    try {
      archive.holding = true
      await runToRead(a)
      await until('tab A to be refreshing', async () => (await updatingNote(a) ?? '').startsWith('Updating…'))
      await runToRead(b)
      await until('tab B to follow it', async () => (await updatingNote(b) ?? '').startsWith('Updating…'))

      await (await updatingStop(a)).evaluate(button => button.click())
      await until('tab B’s note to go', async () => await updatingNote(b) === null)
      assert.equal((await storedClaim(b))?.outcome, 'cancelled')
      release()
      assert.deepEqual(await shownTitles(b), ['Stored work 1', 'Stored work 2'], 'and the stored copy stands')
      assert.deepEqual(archive.asked.b, [], 'tab B did not take a cancelled refresh over')
    }
    finally {
      await a.close()
      await b.close()
    }
  })

  test('a refresh its tab dropped is taken over by the tab waiting on it', async () => {
    const { a, b, archive, release } = await pair()
    try {
      archive.holding = true
      await runToRead(a)
      await until('tab A to be refreshing', async () => (await updatingNote(a) ?? '').startsWith('Updating…'))
      await runToRead(b)
      await until('tab B to follow it', async () => (await updatingNote(b) ?? '').startsWith('Updating…'))

      // The view switched off in tab A alone: the re-run takes its view down
      // mid-refresh and nothing puts it back, so the refresh stops with it.
      // In front, for the frames the wait for its re-run checks on.
      await a.bringToFront()
      const runs = await a.evaluate(() => Number(document.documentElement.dataset.ao3eRuns ?? 0))
      await a.evaluate(() => window.__relayed({ 'option.searchMarkedForLater': false }))
      await settled(a, runs)

      await until('tab B to refresh the list itself', async () =>
        JSON.stringify(await shownTitles(b)) === JSON.stringify(liveTitles()))
      assert.ok(archive.asked.b.length >= 3, 'reading every page of it')
      release()
    }
    finally {
      await a.close()
      await b.close()
    }
  })

  test('a claim left unrenewed is a tab that went away, and holds nobody', async () => {
    const asked = []
    const tab = await archiveTab(browser, storedSeed(undefined, {
      [`listRefresh.${KEY}`]: claimRefresh('gone', 'page', Date.now() - REFRESH_CLAIM_TTL_MS - 1),
    }), url => toReadPage(Number(url.searchParams.get('page') ?? 1)), asked)
    try {
      await openToRead(tab)
      await until('the list to be refreshed here', async () =>
        JSON.stringify(await shownTitles(tab)) === JSON.stringify(liveTitles()))
      assert.ok(asked.length >= 3)
    }
    finally {
      await tab.close()
    }
  })
})

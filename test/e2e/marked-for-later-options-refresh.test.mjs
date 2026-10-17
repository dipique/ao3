import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { claimRefresh, released } from '../../src/content_script/searchView/listRefresh.ts'
import { archiveTab, KEY, liveTitles, loadToRead, runToRead, shownTitles, storedClaim, storedSeed, toReadPage, updatingNote, updatingStop } from './markedForLater.mjs'
import { skip, startOptions, stubArchive, until } from './optionsPage.mjs'
import { linkWrites, relayWrites } from './trackedPages.mjs'

/** What AO3 says to wait, in seconds: long enough that the test sees the wait, and never sits it out. */
const RETRY_AFTER = 90

/** The reader is `me`, so their Marked for Later copy is the tile's. */
const SEED = storedSeed(undefined, { 'option.user': { userId: 'me' } })

/**
 * The reader's Marked for Later list on AO3 in one tab and the options page in
 * another, sharing one store as the extension's pages do. A refresh of the list
 * started on either shows on the other, with its pages and its pauses, and
 * either can stop it; neither refreshes the list while the other is.
 */
describe('Marked for Later: the options page and an AO3 tab share one refresh', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  /**
   * The to-read page loaded in an AO3 tab, its content script not yet run, and
   * the options page open on the profile tiles: each page's requests for a page
   * of the list answered by `answer(name, page)`, a page's HTML, a
   * `{ status, headers, body }`, or a promise of either. Linked unless `linked`
   * is false, when `link()` links them later.
   */
  const open = async (answer, { linked = true } = {}) => {
    const asked = { tab: [], options: [] }
    const tab = await archiveTab(session.browser, SEED, (url) => {
      const page = Number(url.searchParams.get('page') ?? 1)
      return url.searchParams.has('page') ? answer('tab', page) : toReadPage(page)
    }, asked.tab)
    await loadToRead(tab)
    let archive
    const options = await session.open({
      seed: SEED,
      hash: '#user-profile-lists',
      prepare: async (page) => {
        await page.evaluateOnNewDocument(relayWrites)
        archive = await stubArchive(page, async (raw) => {
          const url = new URL(raw)
          if (!url.pathname.endsWith('/readings'))
            return { status: 404, body: '' }
          const page = Number(url.searchParams.get('page') ?? 1)
          asked.options.push(page)
          const reply = await answer('options', page)
          return typeof reply === 'string' ? { body: reply } : reply
        })
      },
    })
    const link = () => linkWrites([options.page, tab])
    if (linked)
      await link()
    const tile = () => options.tile('marked-for-later')
    const inTile = async (role, name) => options.control(await tile(), role, name)
    const tileText = async () => options.text(await tile())
    const close = async () => {
      await tab.close()
      await options.page.close()
    }
    return { tab, options, archive, asked, link, tile, inTile, tileText, close }
  }

  /** A promise and the way to settle it, for an answer held back until a test lets it go. */
  const hold = () => {
    let release
    const held = new Promise((resolve) => {
      release = resolve
    })
    return { held, release }
  }

  test('a refresh on the AO3 page shows on the tile, pauses and all, and the tile’s Cancel stops it', async () => {
    const { tab, options, asked, inTile, tileText, close } = await open((name, page) =>
      name === 'tab' && page === 2 ? { status: 429, headers: { 'Retry-After': String(RETRY_AFTER) }, body: 'Retry later' } : toReadPage(page))
    try {
      await runToRead(tab)
      await until('the tile to show the refresh, sitting out AO3’s pause', async () =>
        /Loading page \d of 3…|AO3 asked us to slow down — trying again in 1:[23]\d/.test(await tileText()))
      await until('the pause, counting down', async () => /AO3 asked us to slow down — trying again in 1:[23]\d/.test(await tileText()))
      assert.deepEqual(await options.controls(await options.tile('marked-for-later'), 'button', 'Refresh list'), [], 'Cancel takes the actions’ place')

      await options.page.bringToFront()
      await options.press(await inTile('button', 'Cancel'))
      await until('the AO3 page to stop updating', async () => await updatingNote(tab) === null)
      assert.equal((await storedClaim(tab))?.outcome, 'cancelled')
      await until('the tile’s actions to be back', async () => (await options.controls(await options.tile('marked-for-later'), 'button', 'Refresh list')).length === 1)
      assert.deepEqual(await shownTitles(tab), ['Stored work 1', 'Stored work 2'], 'the stored copy stands')
      assert.deepEqual(asked.options, [], 'the options page asked AO3 for nothing')
    }
    finally {
      await close()
    }
  })

  test('a refresh on the AO3 page leaves the tile once it has stored the list', async () => {
    const page2 = hold()
    const { tab, options, tileText, close } = await open((name, page) =>
      name === 'tab' && page === 2 ? page2.held.then(() => toReadPage(2)) : toReadPage(page))
    try {
      await runToRead(tab)
      await until('the tile to show the refresh', async () => /Loaded \d of 3 pages|\d \/ 3/.test(await tileText()))

      page2.release()
      await until('the AO3 page to store the list', async () => JSON.stringify(await shownTitles(tab)) === JSON.stringify(liveTitles()))
      await until('the tile’s actions to be back', async () => (await options.controls(await options.tile('marked-for-later'), 'button', 'Refresh list')).length === 1)
      assert.equal(await (await options.tile('marked-for-later')).evaluate(el => el.querySelector('[data-job-state]')?.dataset.jobState ?? null), null, 'and no job line left')
    }
    finally {
      page2.release()
      await close()
    }
  })

  test('a job’s refresh shows on the AO3 page, which asks AO3 for nothing, and the list it stores reaches the page', async () => {
    const page2 = hold()
    const { tab, options, asked, inTile, tileText, close } = await open((name, page) =>
      name === 'options' && page === 2 ? page2.held.then(() => toReadPage(2)) : toReadPage(page))
    try {
      await options.page.bringToFront()
      await options.press(await inTile('button', 'Refresh list'))
      await until('the job to be loading the list', async () => /Loading page \d of 3/.test(await tileText()))

      await runToRead(tab)
      await until('the AO3 page to show the job’s refresh', async () => /^Updating… Loaded \d of 3 pages$/.test(await updatingNote(tab) ?? ''))
      assert.ok(await updatingStop(tab), 'with a Stop')

      page2.release()
      await until('the AO3 page to show the list the job stored', async () => JSON.stringify(await shownTitles(tab)) === JSON.stringify(liveTitles()))
      await until('its note to go', async () => await updatingNote(tab) === null)
      assert.deepEqual(asked.tab, [], 'the AO3 page asked AO3 for no page of the list')
      await until('the job to finish', async () => /Finished/.test(await tileText()))
    }
    finally {
      page2.release()
      await close()
    }
  })

  test('a job’s refresh AO3 served signed out ends refused, and the AO3 page keeps its copy', async () => {
    const page1 = hold()
    const { tab, options, inTile, tileText, close } = await open((name, page) =>
      name === 'options' ? page1.held.then(() => toReadPage(page, 'Live', { signedIn: false })) : toReadPage(page))
    try {
      await options.page.bringToFront()
      await options.press(await inTile('button', 'Refresh list'))
      await until('the job to be fetching the list', async () => /Fetching the list…/.test(await tileText()))
      await runToRead(tab)
      await until('the AO3 page to show the job’s refresh', async () => !!await updatingStop(tab))

      page1.release()
      await until('the job to stop on it', async () => /signed-out view/.test(await tileText()))
      await until('the refresh to end refused, as the AO3 page hears it', async () => (await storedClaim(tab))?.outcome === 'refused')
      await until('the AO3 page to stop updating', async () => await updatingNote(tab) === null)
      assert.deepEqual(await shownTitles(tab), ['Stored work 1', 'Stored work 2'])
    }
    finally {
      page1.release()
      await close()
    }
  })

  test('Stop on the AO3 page cancels the job', async () => {
    const page2 = hold()
    const { tab, options, inTile, tileText, close } = await open((name, page) =>
      name === 'options' && page === 2 ? page2.held.then(() => toReadPage(2)) : toReadPage(page))
    try {
      await options.page.bringToFront()
      await options.press(await inTile('button', 'Refresh list'))
      await until('the job to be loading the list', async () => /Loading page \d of 3/.test(await tileText()))
      await runToRead(tab)
      await until('the AO3 page to show the job’s refresh', async () => !!await updatingStop(tab))

      await (await updatingStop(tab)).evaluate(button => button.click())
      await until('the job to be gone', async () => await options.stored('siteExportJob') === null)
      await until('the tile’s actions to be back', async () => (await options.controls(await options.tile('marked-for-later'), 'button', 'Refresh list')).length === 1)
      assert.deepEqual(await options.controls(await options.tile('marked-for-later'), 'button', 'Continue'), [], 'nothing left to continue')
      await until('the AO3 page to stop updating', async () => await updatingNote(tab) === null)
      assert.equal((await storedClaim(tab))?.outcome, 'cancelled')
    }
    finally {
      page2.release()
      await close()
    }
  })

  test('a job that claimed the list at the same time as the AO3 page gives way to it, and finishes on what the page stores', async () => {
    const options1 = hold()
    const tab2 = hold()
    const { tab, options, asked, inTile, tileText, link, close } = await open((name, page) => {
      if (name === 'options' && page === 1)
        return options1.held.then(() => toReadPage(1))
      if (name === 'tab' && page === 2)
        return tab2.held.then(() => toReadPage(2))
      return toReadPage(page)
    }, { linked: false })
    try {
      // Neither page hears the other yet, so each claims the list for itself:
      // the options page first, then the AO3 page.
      await options.page.bringToFront()
      await options.press(await inTile('button', 'Refresh list'))
      await until('the job to be fetching the list', async () => /Fetching the list…/.test(await tileText()))
      await runToRead(tab)
      await until('the AO3 page to be refreshing too', async () => /^Updating… Loaded \d of 3 pages$/.test(await updatingNote(tab) ?? ''))

      // From here each hears the other's writes: the AO3 page's claim is the later one.
      await link()
      tab2.release()
      await until('the AO3 page to store the list', async () => JSON.stringify(await shownTitles(tab)) === JSON.stringify(liveTitles()))
      await until('the job to finish on it', async () => /Finished/.test(await tileText()))
      assert.deepEqual(asked.options, [1], 'the job read no more of the list once it gave way')
    }
    finally {
      options1.release()
      tab2.release()
      await close()
    }
  })

  /**
   * The options page with an AO3 page's refresh under way, whose end it is then
   * not told of: the end is stored without a change event, as a tab the browser
   * froze in the background misses one.
   */
  const missedEnd = async () => {
    const claim = claimRefresh('elsewhere', 'page', Date.now())
    const options = await session.open({ seed: { ...SEED, [`listRefresh.${KEY}`]: claim }, hash: '#user-profile-lists' })
    const tile = () => options.tile('marked-for-later')
    await until('the tile to show the refresh', async () => /Fetching the list…/.test(await options.text(await tile())))
    await options.page.evaluate((key, ended) => window.__storeQuietly({ [key]: ended }), `listRefresh.${KEY}`, released(claim, 'written', Date.now()))
    const actionsBack = async () => (await options.controls(await tile(), 'button', 'Refresh list')).length === 1
    return { options, actionsBack }
  }

  test('a refresh whose end the page missed leaves the tile once the list it stored arrives', async () => {
    const { options, actionsBack } = await missedEnd()
    try {
      // What the refresh stored, which the page does hear.
      await options.page.evaluate(async (key) => {
        const lists = (await window.browser.storage.local.get('cache.searchLists'))['cache.searchLists']
        lists[key] = { ...lists[key], scrapedAt: Date.now() }
        await window.browser.storage.local.set({ 'cache.searchLists': lists })
      }, KEY)
      await until('the tile’s actions to be back', actionsBack)
    }
    finally {
      await options.page.close()
    }
  })

  test('a refresh whose end the page missed leaves the tile once the page is looked at again', async () => {
    const { options, actionsBack } = await missedEnd()
    try {
      await options.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
      await until('the tile’s actions to be back', actionsBack)
    }
    finally {
      await options.page.close()
    }
  })
})

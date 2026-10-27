import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { claimRefresh, released } from '../../src/content_script/searchView/listRefresh.ts'
import { archiveTab, KEY, liveTitles, loadToRead, PAGES, runToRead, shownTitles, storedClaim, storedSeed, toReadPage, updatingNote, updatingStop } from './markedForLater.mjs'
import { figures, skip, startOptions, stubArchive, until } from './optionsPage.mjs'
import { linkWrites, relayWrites } from './trackedPages.mjs'

/** What AO3 says to wait, in seconds: long enough that the test sees the wait, and never sits it out. */
const RETRY_AFTER = 90

/** The reader is `me`, so their Marked for Later copy is the tile's. */
const SEED = storedSeed(undefined, { 'option.user': { userId: 'me' } })

/**
 * The job line on the tile: its state, the pause it is sitting out, and how
 * many pages of the list its bar counts once it knows; null with no line.
 */
function jobLine(tile) {
  return tile.evaluate((el) => {
    const line = el.querySelector('[data-job-state]')
    const bar = line?.querySelector('[role="progressbar"]')
    return line && { state: line.dataset.jobState, wait: line.dataset.jobWait ?? null, pages: bar ? Number(bar.getAttribute('aria-valuemax')) : null }
  })
}

/** Whether the AO3 page's note says it is updating, counting the list's pages. */
async function updatingPages(tab) {
  return figures(await updatingNote(tab) ?? '').includes(PAGES)
}

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
      // Beside the AO3 tab, not in front of it: hidden, the tab's refresh would
      // run on timers slowed to one a second.
      window: true,
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
    const inTile = async action => options.action(await tile(), action)
    const line = async () => jobLine(await tile())
    const tileText = async () => options.text(await tile())
    const actionsBack = async () => (await options.actions(await tile(), 'refresh')).length === 1
    const close = async () => {
      await tab.close()
      await options.page.close()
    }
    return { tab, options, archive, asked, link, tile, inTile, line, tileText, actionsBack, close }
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
    const { tab, options, asked, tile, inTile, line, tileText, actionsBack, close } = await open((name, page) =>
      name === 'tab' && page === 2 ? { status: 429, headers: { 'Retry-After': String(RETRY_AFTER) }, body: 'Retry later' } : toReadPage(page))
    try {
      await runToRead(tab)
      await until('the tile to show the refresh', async () => (await line()) !== null)
      // AO3's pause, counting down from what it asked for.
      await until('the pause, counting down', async () => (await line())?.wait === 'refused' && /(?<!\d)1:[23]\d/.test(await tileText()))
      assert.deepEqual(await options.actions(await tile(), 'refresh'), [], 'Cancel takes the actions’ place')

      await options.page.bringToFront()
      await options.press(await inTile('cancel'))
      await until('the AO3 page to stop updating', async () => await updatingNote(tab) === null)
      assert.equal((await storedClaim(tab))?.outcome, 'cancelled')
      await until('the tile’s actions to be back', actionsBack)
      assert.deepEqual(await shownTitles(tab), ['Stored work 1', 'Stored work 2'], 'the stored copy stands')
      assert.deepEqual(asked.options, [], 'the options page asked AO3 for nothing')
    }
    finally {
      await close()
    }
  })

  test('a refresh on the AO3 page leaves the tile once it has stored the list', async () => {
    const page2 = hold()
    const { tab, line, actionsBack, close } = await open((name, page) =>
      name === 'tab' && page === 2 ? page2.held.then(() => toReadPage(2)) : toReadPage(page))
    try {
      await runToRead(tab)
      await until('the tile to show the refresh, counting the list’s pages', async () => (await line())?.pages === PAGES)

      page2.release()
      await until('the AO3 page to store the list', async () => JSON.stringify(await shownTitles(tab)) === JSON.stringify(liveTitles()))
      await until('the tile’s actions to be back', actionsBack)
      assert.equal(await line(), null, 'and no job line left')
    }
    finally {
      page2.release()
      await close()
    }
  })

  test('a job’s refresh shows on the AO3 page, which asks AO3 for nothing, and the list it stores reaches the page', async () => {
    const page2 = hold()
    const { tab, options, asked, inTile, line, close } = await open((name, page) =>
      name === 'options' && page === 2 ? page2.held.then(() => toReadPage(2)) : toReadPage(page))
    try {
      await options.page.bringToFront()
      await options.press(await inTile('refresh'))
      await until('the job to be loading the list', async () => (await line())?.pages === PAGES)

      await runToRead(tab)
      await until('the AO3 page to show the job’s refresh', async () => updatingPages(tab))
      assert.ok(await updatingStop(tab), 'with a Stop')

      page2.release()
      await until('the AO3 page to show the list the job stored', async () => JSON.stringify(await shownTitles(tab)) === JSON.stringify(liveTitles()))
      await until('its note to go', async () => await updatingNote(tab) === null)
      assert.deepEqual(asked.tab, [], 'the AO3 page asked AO3 for no page of the list')
      await until('the job to finish', async () => (await line())?.state === 'finished')
    }
    finally {
      page2.release()
      await close()
    }
  })

  test('a job’s refresh AO3 served signed out ends refused, and the AO3 page keeps its copy', async () => {
    const page1 = hold()
    const { tab, options, inTile, line, close } = await open((name, page) =>
      name === 'options' ? page1.held.then(() => toReadPage(page, 'Live', { signedIn: false })) : toReadPage(page))
    try {
      await options.page.bringToFront()
      await options.press(await inTile('refresh'))
      await until('the job to be fetching the list', async () => (await line())?.state === 'running')
      await runToRead(tab)
      await until('the AO3 page to show the job’s refresh', async () => !!await updatingStop(tab))

      page1.release()
      await until('the job to stop on it', async () => (await line())?.state === 'stopped')
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
    const { tab, options, tile, inTile, line, actionsBack, close } = await open((name, page) =>
      name === 'options' && page === 2 ? page2.held.then(() => toReadPage(2)) : toReadPage(page))
    try {
      await options.page.bringToFront()
      await options.press(await inTile('refresh'))
      await until('the job to be loading the list', async () => (await line())?.pages === PAGES)
      await runToRead(tab)
      await until('the AO3 page to show the job’s refresh', async () => !!await updatingStop(tab))

      await (await updatingStop(tab)).evaluate(button => button.click())
      await until('the job to be gone', async () => await options.stored('siteExportJob') === null)
      await until('the tile’s actions to be back', actionsBack)
      assert.deepEqual(await options.actions(await tile(), 'resume'), [], 'nothing left to continue')
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
    const { tab, options, asked, inTile, line, link, close } = await open((name, page) => {
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
      await options.press(await inTile('refresh'))
      await until('the job to be fetching the list', async () => (await line())?.state === 'running')
      await runToRead(tab)
      await until('the AO3 page to be refreshing too', async () => updatingPages(tab))

      // From here each hears the other's writes: the AO3 page's claim is the later one.
      await link()
      tab2.release()
      await until('the AO3 page to store the list', async () => JSON.stringify(await shownTitles(tab)) === JSON.stringify(liveTitles()))
      await until('the job to finish on it', async () => (await line())?.state === 'finished')
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
    await until('the tile to show the refresh', async () => (await jobLine(await tile()))?.state === 'running')
    await options.page.evaluate((key, ended) => window.__storeQuietly({ [key]: ended }), `listRefresh.${KEY}`, released(claim, 'written', Date.now()))
    const actionsBack = async () => (await options.actions(await tile(), 'refresh')).length === 1
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

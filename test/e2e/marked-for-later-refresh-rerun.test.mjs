import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { ensureBuilt, findChrome, storedListIds } from './helpers.mjs'
import { archiveTab, KEY, liveTitles, openToRead, shownTitles, storedClaim, storedSeed, toReadPage } from './markedForLater.mjs'
import { until } from './optionsPage.mjs'
import { launch, rerun } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const workMarks = readIds => ({
  enabled: true,
  marks: {
    read: { icon: 'read', label: 'Read', color: '#6b7280', hideSearchResult: false, items: readIds, order: 0 },
    saved: { icon: 'saved', label: 'Marked for later', color: '#2f8f4e', order: 1 },
  },
})

/**
 * A mark click re-runs the page, which takes the Marked for Later view down and
 * puts it straight back. A refresh of the list running behind the view at that
 * moment carries on into the view put back, and lands in storage.
 */
describe('Marked for Later: a refresh outlives a re-run', { skip }, () => {
  let browser

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  test('a work marked read while the list refreshes leaves the refresh to finish', async () => {
    const held = []
    let holding = true
    const answer = (url) => {
      const page = Number(url.searchParams.get('page') ?? 1)
      const body = toReadPage(page)
      if (holding && page === 2 && url.searchParams.has('page'))
        return new Promise(resolve => held.push(() => resolve(body)))
      return body
    }
    const tab = await archiveTab(browser, storedSeed(undefined, { 'option.workMarks': workMarks('') }), answer)
    try {
      await openToRead(tab)
      await until('the refresh to be held at page 2', () => held.length > 0)
      assert.deepEqual(await shownTitles(tab), ['Stored work 1', 'Stored work 2'])

      // What the work menu's "Mark as read" writes; every options change re-runs the page.
      await rerun(tab, () => tab.evaluate(marks => browser.storage.local.set({ 'option.workMarks': marks }), workMarks('1')))
      holding = false
      for (const go of held.splice(0))
        go()

      await until('the refresh to end', async () => (await storedClaim(tab))?.outcome)
      assert.equal((await storedClaim(tab)).outcome, 'written', 'the refresh ran to the end')
      const list = await tab.evaluate(async key => (await window.browser.storage.local.get('cache.searchLists'))['cache.searchLists'][key], KEY)
      assert.deepEqual(storedListIds(list), ['2', '3', '4', '5', '6'], 'the refreshed list is stored, less the work marked read')
      await until('the view to show the refreshed list', async () =>
        JSON.stringify(await shownTitles(tab)) === JSON.stringify(liveTitles().slice(1)))
    }
    finally {
      await tab.close()
    }
  })
})

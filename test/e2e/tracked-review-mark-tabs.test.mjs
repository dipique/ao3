import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { formatDay } from '../../src/common/trackedLists.ts'
import { DIST, ensureBuilt, findChrome, installMock, launch } from './helpers.mjs'
import { linkWrites, relayWrites, runs, settled } from './trackedPages.mjs'
import { archiveRoutes, CLOCK_BASE, installClock, listing, resetWorkIds, reviewDrawn, TODAY, trackedOption, works } from './trackedReview.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const REVIEW_URL = 'https://archiveofourown.org/users/me/readings#ao3e-tracked'

/**
 * Two tabs with the review open, and the reader marking the range reviewed in
 * one of them.
 *
 * Both tabs re-run on the watermark's write, and both compute the next window
 * from the records the reading has already filled, so neither asks the archive
 * for anything: the next range is on screen in both at once.
 *
 * The tabs' storage is kept in step the way a browser's is: each write one tab
 * makes reaches the other, with its change event.
 */
describe('tracked review: marking reviewed with the review open in another tab', { skip }, () => {
  let browser
  let css
  let js
  let clicking
  let other

  before(async () => {
    ensureBuilt()
    css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await clicking?.close()
    await other?.close()
    await browser?.close()
  })

  resetWorkIds(8000)
  const since = TODAY - 8
  const solo = listing('solo', works([...Array.from({ length: 8 }, (_, i) => [since + i, 3])]), { entry: { alias: 'Solo', since } })

  const SEED = {
    'option.searchReadWorks': false,
    'option.trackedLists': trackedOption([solo], { target: 6, reviewedThrough: since - 1 }),
    'cache.markedForLater': { userId: 'me', updatedAt: CLOCK_BASE, ids: '' },
  }

  const asked = { clicking: [], other: [] }

  const open = async (name) => {
    const tab = await browser.newPage()
    await tab.setViewport({ width: 1280, height: 900 })
    await tab.setRequestInterception(true)
    tab.on('request', archiveRoutes({ fixtures: [solo], fetched: asked[name] }))
    await tab.evaluateOnNewDocument(installClock, CLOCK_BASE)
    await tab.evaluateOnNewDocument(installMock, SEED)
    await tab.evaluateOnNewDocument(relayWrites)
    await tab.goto(REVIEW_URL, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await settled(tab)
    await reviewDrawn(tab)
    return tab
  }

  const rangeText = tab => tab.evaluate(() =>
    document.querySelector('.AO3E--tracked-review--bar--range')?.textContent?.trim() ?? null)

  const watermark = tab => tab.evaluate(async () =>
    (await browser.storage.local.get('option.trackedLists'))['option.trackedLists'].reviewedThrough)

  const listAsked = name => asked[name].filter(path => path.includes('/tags/'))

  test('both tabs show the first range', async () => {
    clicking = await open('clicking')
    other = await open('other')
    const first = `Reviewing ${formatDay(since).slice(0, -5)} – ${formatDay(since + 1)}`
    assert.equal(await rangeText(clicking), first)
    assert.equal(await rangeText(other), first)
    await linkWrites([clicking, other])
  })

  test('Mark reviewed in one puts the next range in both, asking the archive for nothing', async () => {
    const before = { clicking: listAsked('clicking').length, other: listAsked('other').length }
    const otherRuns = await runs(other)
    await clicking.$eval('.AO3E--tracked-review--bar--mark', button => button.click())
    // The other tab hears the watermark move and re-runs on it.
    await settled(other, otherRuns)
    assert.equal(await watermark(other), since + 1)
    const next = `Reviewing ${formatDay(since + 2).slice(0, -5)} – ${formatDay(since + 3)}`
    await other.waitForFunction(want =>
      document.querySelector('.AO3E--tracked-review--bar--range')?.textContent?.trim() === want, {}, next)
    await reviewDrawn(other)
    const shown = await other.evaluate(() =>
      document.querySelectorAll('.AO3E--search-view--results > li.blurb:not(.AO3E--search-view--hidden)').length)
    assert.equal(shown, 6, 'the two days of the next range')
    // In front, for the frames the wait checks on.
    await clicking.bringToFront()
    await reviewDrawn(clicking)
    assert.equal(await rangeText(clicking), next)
    assert.equal(listAsked('clicking').length, before.clicking, 'the clicking tab asked for nothing')
    assert.equal(listAsked('other').length, before.other, 'nor did the other')
  })
})

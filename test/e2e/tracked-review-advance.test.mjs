import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { formatRange } from '../../src/common/trackedReads.ts'
import { figures, mentions } from '../facts.mjs'
import { DIST, ensureBuilt, findChrome, installMock, launch } from './helpers.mjs'
import { pressFacet, pressToast, rerun, runs, settled } from './trackedPages.mjs'
import { archiveRoutes, CLOCK_BASE, installClock, listing, resetWorkIds, reviewDrawn, search, TODAY, trackedOption, works } from './trackedReview.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const REVIEW_URL = 'https://archiveofourown.org/users/me/readings#ao3e-tracked'

/**
 * Finishing a range and moving on.
 *
 * "Mark reviewed" is the whole of the review's bookkeeping: it moves one day
 * number, takes the reviewed days off the read records, and hands the reader
 * an Undo; the next range is computed from the records. So what matters is
 * that the watermark goes exactly where it should, that the next range is on
 * screen with the reader's filters still applied, that Undo puts it back and
 * reads again the days the records let go of, and that a range with a list
 * missing from it is never marked reviewed without being asked first, since
 * that is the one way this design could lose a work.
 *
 * Three works a day over eight days, a target of six: the window is two days.
 * The first work of each day carries the tag Fluff, so a facet selection has
 * something to survive on both sides of the move.
 */
describe('tracked review: marking a range reviewed', { skip }, () => {
  let browser
  let css
  let js
  let tab

  before(async () => {
    ensureBuilt()
    css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await tab?.close()
    await browser?.close()
  })

  resetWorkIds(6000)
  const since = TODAY - 8
  const days = []
  for (let day = since; day <= TODAY - 1; day++)
    days.push(...works([[day, 1, 0, { tags: ['Fluff'] }]]), ...works([[day, 2]]))
  const solo = listing('solo', days, { entry: { alias: 'Solo', since } })

  const SEED = {
    'option.searchReadWorks': false,
    'option.trackedLists': trackedOption([solo], { target: 6, reviewedThrough: since - 1 }),
    'cache.markedForLater': { userId: 'me', updatedAt: CLOCK_BASE, ids: '' },
  }

  const open = async ({ fixtures = [solo], seed = SEED, drawn = true } = {}) => {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })
    await page.setRequestInterception(true)
    page.on('request', archiveRoutes({ fixtures }))
    await page.evaluateOnNewDocument(installClock, CLOCK_BASE)
    await page.evaluateOnNewDocument(installMock, seed)
    await page.goto(REVIEW_URL, { waitUntil: 'domcontentloaded' })
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await settled(page)
    if (drawn)
      await reviewDrawn(page)
    return page
  }

  const barText = selector => tab.evaluate(sel =>
    document.querySelector(`.AO3E--tracked-review--bar${sel}`)?.textContent?.trim() ?? null, selector)

  const shownIds = () => tab.evaluate(() =>
    [...document.querySelectorAll('.AO3E--search-view--results > li.blurb:not(.AO3E--search-view--hidden)')]
      .map(li => li.id.replace('work_', '')))

  /** The watermark as storage holds it right now. */
  const watermark = () => tab.evaluate(async () =>
    (await browser.storage.local.get('option.trackedLists'))['option.trackedLists'].reviewedThrough)

  /** Whether a facet value is currently included. */
  const isIncluded = value => tab.evaluate((want) => {
    const row = Array.from(document.querySelectorAll('.AO3E--search-view--row'))
      .find(el => el.querySelector('.AO3E--search-view--row-name')?.textContent?.trim() === want)
    return row?.querySelector('.AO3E--search-view--toggle-include')?.getAttribute('aria-pressed') === 'true'
  }, value)

  /** Mark the range reviewed, and wait for the re-run its write causes and the review it reopens. */
  const markReviewed = async () => {
    await rerun(tab, () => tab.click('.AO3E--tracked-review--bar--mark'))
    await reviewDrawn(tab)
  }

  /** The toolbar's days, works and target, as its meta line gives them. */
  const meta = async () => figures(await barText('--meta'))

  test('the first window is the two days the target fits', async () => {
    tab = await open()
    assert.deepEqual(await meta(), [2, 6, 6])
    assert.equal((await shownIds()).length, 6)
    assert.equal(await watermark(), since - 1)
  })

  test('a facet selection narrows it', async () => {
    await pressFacet(tab, 'Fluff')
    assert.equal((await shownIds()).length, 2, 'one Fluff work a day')
  })

  test('Mark reviewed moves the watermark to the range’s last day', async () => {
    const before = await shownIds()
    await markReviewed()
    assert.equal(await watermark(), since + 1, 'the last day of the range just finished')
    const after = await shownIds()
    assert.deepEqual(await meta(), [2, 6, 6])
    assert.ok(mentions(await barText('--range'), formatRange(since + 2, since + 3)))
    assert.deepEqual(after.filter(id => before.includes(id)), [], 'a fresh range, not the one just cleared')
  })

  test('and the reader’s filters come with it', async () => {
    assert.equal(await isIncluded('Fluff'), true)
    assert.equal((await shownIds()).length, 2, 'still narrowed to the Fluff works of the new range')
  })

  test('Undo puts the watermark back, and reads again the days the records let go of', async () => {
    const before = await runs(tab)
    assert.equal(await pressToast(tab, 'marked-reviewed'), true, 'the Undo offer should still be up')
    await settled(tab, before)
    await reviewDrawn(tab)
    assert.equal(await watermark(), since - 1)
    assert.ok(mentions(await barText('--range'), formatRange(since, since + 1)))
    const record = await tab.evaluate(async () => (await browser.storage.local.get('trackedRead.solo'))['trackedRead.solo'])
    assert.equal(record.from, since, 'read again from the watermark put back')
    await tab.close()
    tab = null
  })

  test('a list that could not be loaded is never skipped without being asked', async () => {
    const broken = { ...search('broken', [[since, 2]], { entry: { alias: 'Hurt/comfort', since } }), fail: true }
    tab = await open({
      fixtures: [solo, broken],
      seed: { ...SEED, 'option.trackedLists': trackedOption([solo, broken], { target: 6, reviewedThrough: since - 1 }) },
    })

    assert.equal(await tab.$eval('.AO3E--tracked-review--bar--status', el => el.dataset.kind), 'failed')
    assert.ok(mentions(await barText('--status'), 'Hurt/comfort'), 'the status line names the list')

    await tab.click('.AO3E--tracked-review--bar--mark')
    await tab.waitForSelector('.AO3E--tracked-review--bar--prompt .AO3E--tracked-review--bar--confirm')
    assert.equal(await watermark(), since - 1, 'nothing has moved yet')
    assert.ok(mentions(await barText('--prompt'), 'Hurt/comfort'), 'the confirmation names the list whose works would be skipped')
  })

  test('and goes ahead once the reader says so', async () => {
    await rerun(tab, () => tab.click('.AO3E--tracked-review--bar--prompt [data-ao3e-action="confirm"]'))
    await reviewDrawn(tab)
    assert.equal(await watermark(), since + 1)
    await tab.close()
    tab = null
  })

  test('a range that turned up nothing is marked reviewed from its toast, with no view up', async () => {
    const quiet = listing('quiet', [[TODAY, 2]], { entry: { alias: 'Quiet', since } })
    tab = await open({
      fixtures: [quiet],
      seed: { ...SEED, 'option.trackedLists': trackedOption([quiet], { target: 6, reviewedThrough: since - 1 }) },
      drawn: false,
    })
    // Today's works can't be reviewed yet, so the range up to yesterday is empty.
    await tab.waitForFunction(() => [...document.querySelectorAll('body > div')]
      .some(el => !!el.shadowRoot?.querySelector('.toast[data-ao3e-toast="nothing-to-review"] button.action')))
    assert.equal(await tab.$('.AO3E--search-host'), null, 'the view closed, with nothing to show')

    const before = await runs(tab)
    assert.equal(await pressToast(tab, 'nothing-to-review'), true)
    await settled(tab, before)
    assert.equal(await watermark(), TODAY - 1)
    const claim = await tab.evaluate(async () => (await browser.storage.local.get('cache.trackedReadClaim'))['cache.trackedReadClaim'])
    assert.equal(claim?.at ?? 0, 0, 'the reading let go of its claim')
  })
})

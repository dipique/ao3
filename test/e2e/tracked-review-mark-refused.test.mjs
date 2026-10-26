import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { DIST, ensureBuilt, findChrome, installMock, launch } from './helpers.mjs'
import { rerun, settled } from './trackedPages.mjs'
import { archiveRoutes, CLOCK_BASE, installClock, listing, resetWorkIds, TODAY, trackedOption, works } from './trackedReview.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const REVIEW_URL = 'https://archiveofourown.org/users/me/readings#ao3e-tracked'

/**
 * The review while the archive is turning requests away.
 *
 * What is already read stays usable: the window is drawn from the records, the
 * status line says which lists are still being read and counts the pause
 * down, and Mark reviewed moves the watermark the moment it is clicked — with
 * no confirmation for a list that is only still being read — and draws the
 * next window from the records at once.
 *
 * Two lists. Solo has three works a day over eight days, and a target of six
 * makes a window two days; the archive answers it. Slow it refuses — for a
 * minute, which the reading waits out, or for two hours, which it doesn't.
 */
describe('tracked review: while the archive refuses', { skip }, () => {
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

  resetWorkIds(7000)
  const since = TODAY - 8
  const solo = listing('solo', works(Array.from({ length: 8 }, (_, i) => [since + i, 3])), { entry: { alias: 'Solo', since } })
  const slow = listing('slow', works([[since, 2]]), { entry: { alias: 'Slow', since } })
  const fixtures = [solo, slow]

  const SEED = {
    'option.searchReadWorks': false,
    'option.trackedLists': trackedOption(fixtures, { target: 6, reviewedThrough: since - 1 }),
    'cache.markedForLater': { userId: 'me', updatedAt: CLOCK_BASE, ids: '' },
  }

  /** How long the archive asks Slow's requests to wait, in seconds. */
  let wait = 0
  const refused = []
  const refuse = (url) => {
    if (!url.pathname.includes('/slow/'))
      return 0
    refused.push(url.pathname + url.search)
    return wait
  }

  const status = () => tab.evaluate(() => document.querySelector('.AO3E--tracked-review--bar--status')?.textContent?.trim() ?? '')

  const shownIds = () => tab.evaluate(() =>
    [...document.querySelectorAll('.AO3E--search-view--results > li.blurb:not(.AO3E--search-view--hidden)')]
      .map(li => li.id.replace('work_', '')))

  const watermark = () => tab.evaluate(async () =>
    (await browser.storage.local.get('option.trackedLists'))['option.trackedLists'].reviewedThrough)

  const ids = (from, to) => solo.works.filter(work => work.filed >= from && work.filed <= to).map(work => work.id)

  /** Wait until the toolbar says what it is still reading for the range starting on `start`, with `then` after it. */
  const stillReading = (start, then) => tab.waitForFunction((want, after) => {
    const text = document.querySelector('.AO3E--tracked-review--bar--status')?.textContent ?? ''
    return text.startsWith(want) && text.includes(after)
  }, { timeout: 15_000 }, `Still reading 1 of 2 lists for `, then)

  /** A tab with the review open, Slow refused for `seconds`, and Solo's works drawn. */
  const open = async (seconds) => {
    await tab?.close()
    wait = seconds
    refused.length = 0
    tab = await browser.newPage()
    await tab.setViewport({ width: 1280, height: 900 })
    await tab.setRequestInterception(true)
    tab.on('request', archiveRoutes({ fixtures, refuse }))
    await tab.evaluateOnNewDocument(installClock, CLOCK_BASE)
    await tab.evaluateOnNewDocument(installMock, SEED)
    await tab.goto(REVIEW_URL, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await settled(tab)
    await tab.waitForFunction(count => document.querySelectorAll('.AO3E--search-view--results > li.blurb').length === count, { timeout: 15_000 }, 6)
  }

  test('what is read is drawn, and the status line counts the pause down', async () => {
    await open(60)
    assert.deepEqual(await shownIds(), ids(since, since + 1))
    await stillReading(since, 'trying again in')
    assert.match(await status(), /AO3 asked us to slow down/)
    assert.ok(refused.length > 0)
  })

  test('Mark reviewed moves the watermark at once, with no confirmation, and draws the next window from the records', async () => {
    await rerun(tab, () => tab.click('.AO3E--tracked-review--bar--mark'))
    assert.equal(await tab.$('.AO3E--tracked-review--bar--prompt .AO3E--tracked-review--bar--confirm'), null)
    assert.equal(await watermark(), since + 1)
    await tab.waitForFunction(id => !!document.querySelector(`.AO3E--search-view--results > li#work_${id}`), { timeout: 15_000 }, ids(since + 2, since + 2)[0])
    assert.deepEqual(await shownIds(), ids(since + 2, since + 3))
  })

  test('a refusal too long to wait out stops the reading; the review stays as it is, and says what it is missing and how to try again', async () => {
    await open(7200)
    await tab.waitForFunction(() => !document.querySelector('.AO3E--search-view--updating-on'), { timeout: 15_000 })
    assert.deepEqual(await shownIds(), ids(since, since + 1))
    await tab.waitForFunction(() => document.querySelector('.AO3E--tracked-review--bar--status')?.textContent?.startsWith('Not yet read: 1 of 2 lists for '), { timeout: 15_000 })
    assert.match(await status(), /Refresh to try again\.$/)
    await rerun(tab, () => tab.click('.AO3E--tracked-review--bar--mark'))
    assert.equal(await watermark(), since + 1)
  })
})

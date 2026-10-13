import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock } from './helpers.mjs'
import { settled, toasts } from './trackedPages.mjs'
import { archiveRoutes, CLOCK_BASE, dayOfIso, installClock, listing, resetWorkIds, reviewDrawn, TODAY, trackedOption, works } from './trackedReview.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const REVIEW_URL = 'https://archiveofourown.org/users/me/readings#ao3e-tracked'

/**
 * Marking a range reviewed while the archive is turning requests away.
 *
 * The watermark is the reader's say-so and nothing else: it moves the moment
 * they click, whatever the archive is doing. Reading the next range is the
 * ordinary gather, which waits out a rate limit behind its own progress and
 * leaves the stored window alone until it has one to put in its place.
 *
 * Three works a day over eight days, a target of six: the window is two days,
 * and the archive refuses every request for the range after the first — for a
 * minute, which the gather waits out, and then for two hours, which it doesn't.
 */
describe('tracked review: marking reviewed while the archive refuses', { skip }, () => {
  let browser
  let css
  let js
  let tab

  before(async () => {
    ensureBuilt()
    css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-first-run', '--no-default-browser-check'],
    })
  }, { timeout: 180000 })

  after(async () => {
    await tab?.close()
    await browser?.close()
  })

  resetWorkIds(7000)
  const since = TODAY - 8
  const solo = listing('solo', works([...Array.from({ length: 8 }, (_, i) => [since + i, 3])]), { entry: { alias: 'Solo', since } })

  const SEED = {
    'option.searchReadWorks': false,
    'option.trackedLists': trackedOption([solo], { target: 6, reviewedThrough: since - 1 }),
    'cache.markedForLater': { userId: 'me', updatedAt: CLOCK_BASE, ids: '' },
  }

  /** How long the archive asks the next range's requests to wait, in seconds. */
  let wait = 0
  /** Requests for the range after the first: every list's query starts a day before its range. */
  const refused = []
  const refuse = (url) => {
    const from = dayOfIso(url.searchParams.get('work_search[date_from]'))
    if (from === null || from < since + 1)
      return 0
    refused.push(url.pathname + url.search)
    return wait
  }

  /** The watermark as storage holds it right now. */
  const watermark = () => tab.evaluate(async () =>
    (await browser.storage.local.get('option.trackedLists'))['option.trackedLists'].reviewedThrough)

  /** The stored window's facts. */
  const storedWindow = () => tab.evaluate(async () =>
    (await browser.storage.local.get('cache.trackedReview'))['cache.trackedReview'])

  /** A tab with the first range on screen, the archive asking the next range's requests to wait `seconds`. */
  const open = async (seconds) => {
    await tab?.close()
    wait = seconds
    refused.length = 0
    tab = await browser.newPage()
    await tab.setViewport({ width: 1280, height: 900 })
    await tab.setRequestInterception(true)
    tab.on('request', archiveRoutes({ fixtures: [solo], refuse }))
    await tab.evaluateOnNewDocument(installClock, CLOCK_BASE)
    await tab.evaluateOnNewDocument(installMock, SEED)
    await tab.goto(REVIEW_URL, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await settled(tab)
    await reviewDrawn(tab)
    assert.equal((await storedWindow()).start, since)
    assert.deepEqual(refused, [], 'nothing past the first range has been asked for yet')
  }

  /** Click Mark reviewed, and wait for the watermark to move: promptly, or not at all. */
  const markReviewed = async () => {
    await tab.click('.AO3E--tracked-review--bar--mark')
    await tab.waitForFunction(async want =>
      (await browser.storage.local.get('option.trackedLists'))['option.trackedLists'].reviewedThrough === want, { timeout: 10_000 }, since + 1)
  }

  test('Mark reviewed moves the watermark at once, without waiting for the archive', async () => {
    // A minute: a wait the gather sits out. The watermark has to be down long before.
    await open(60)
    await markReviewed()
    assert.equal(await watermark(), since + 1)
  })

  test('and the next range is gathered behind the view’s own progress, waiting out the refusal', async () => {
    await tab.waitForFunction(() => /trying again in/.test(document.querySelector('.AO3E--search-host--progress-label')?.textContent ?? ''), { timeout: 10_000 })
    assert.ok(refused.length > 0, 'the next range was asked for')
  })

  test('which leaves the stored window as it was until it has one to put in its place', async () => {
    const stored = await storedWindow()
    assert.equal(stored.start, since)
    assert.equal(stored.reviewedThrough, since - 1)
  })

  test('a refusal too long to wait out ends the gather as any refused load ends, and the range stays marked', async () => {
    // Two hours: past what a gather the reader is watching will wait.
    await open(7200)
    await markReviewed()
    await tab.waitForFunction(() => !document.querySelector('.AO3E--search-host'), { timeout: 10_000 })
    assert.ok(refused.length > 0, 'the next range was asked for')
    assert.equal(await watermark(), since + 1)
    const said = await toasts(tab)
    assert.ok(said.includes('AO3 asked us to slow down. Try again in a few minutes.'), `the refusal is said: ${JSON.stringify(said)}`)
    assert.ok(!said.some(text => /Could not mark/.test(text)), 'and the range is not reported unmarked')
    const stored = await storedWindow()
    assert.equal(stored.start, since, 'the stored window is not written over with the refusal')
    assert.equal(stored.reviewedThrough, since - 1)
  })
})

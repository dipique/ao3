import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { formatDay } from '../../src/common/trackedLists.ts'
import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'
import { runs, settled } from './trackedPages.mjs'
import { archiveRoutes, CLOCK_BASE, dayOfIso, installClock, listing, resetWorkIds, reviewDrawn, TODAY, trackedOption, works } from './trackedReview.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const REVIEW_URL = 'https://archiveofourown.org/users/me/readings#ao3e-tracked'

/**
 * Runs in the page, after the storage mock: every write the page makes is
 * handed to `window.__relay` while `window.__relaying` is set, and
 * `window.__relayed` writes one made elsewhere — as another tab's write
 * reaches this one, change event and all, without being handed on again.
 */
function relayWrites() {
  const local = window.browser.storage.local
  const own = local.set
  window.__relaying = false
  window.__relayed = items => own(items)
  local.set = (items) => {
    if (window.__relaying)
      window.__relay(JSON.parse(JSON.stringify(items)))
    return own(items)
  }
}

/**
 * Two tabs with the review open, and the reader marking the range reviewed in
 * one of them.
 *
 * Both tabs re-run on the watermark's write, and both find the stored window
 * answering to the old watermark. Only the tab the reader clicked in reads the
 * next range from the archive: the other waits for it to land in the store and
 * opens on it, rather than asking the archive for the same pages against a
 * rate limit the two of them share.
 *
 * The tabs' storage is kept in step the way a browser's is: each write one tab
 * makes reaches the other, with its change event. The archive holds the
 * clicking tab's answers back until the test lets them through, so the other
 * tab's re-run comes while the next range is still being read.
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
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-first-run', '--no-default-browser-check'],
    })
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

  /** Whether a request is for the range after the first: every list's query starts a day before its range. */
  const nextRange = url => (dayOfIso(url.searchParams.get('work_search[date_from]')) ?? -Infinity) >= since + 1

  const asked = { clicking: [], other: [] }
  let holding = false
  const held = []

  const open = async (name) => {
    const tab = await browser.newPage()
    await tab.setViewport({ width: 1280, height: 900 })
    await tab.setRequestInterception(true)
    const route = archiveRoutes({ fixtures: [solo], fetched: asked[name] })
    tab.on('request', (req) => {
      if (name === 'clicking' && holding && req.url().startsWith('https://archiveofourown.org/') && nextRange(new URL(req.url())))
        held.push(() => route(req))
      else
        route(req)
    })
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

  /** Hand every write `from` makes to `to`, in the order they were made. */
  const relay = async (from, to) => {
    let queue = Promise.resolve()
    await from.exposeFunction('__relay', (items) => {
      queue = queue.then(() => to.evaluate(i => window.__relayed(i), items)).catch(() => {})
    })
    await from.evaluate(() => (window.__relaying = true))
  }

  const rangeText = tab => tab.evaluate(() =>
    document.querySelector('.AO3E--tracked-review--bar--range')?.textContent?.trim() ?? null)

  const watermark = tab => tab.evaluate(async () =>
    (await browser.storage.local.get('option.trackedLists'))['option.trackedLists'].reviewedThrough)

  const nextRangeAsked = name => asked[name].filter(path => nextRange(new URL(path, 'https://archiveofourown.org')))

  test('both tabs show the first range', async () => {
    clicking = await open('clicking')
    other = await open('other')
    const first = `Reviewing ${formatDay(since).slice(0, -5)} – ${formatDay(since + 1)}`
    assert.equal(await rangeText(clicking), first)
    assert.equal(await rangeText(other), first)
    await relay(clicking, other)
    await relay(other, clicking)
  })

  test('only the tab Mark reviewed was clicked in reads the next range', async () => {
    holding = true
    const before = await runs(other)
    await clicking.$eval('.AO3E--tracked-review--bar--mark', button => button.click())
    // The other tab hears the watermark move and re-runs on it.
    await settled(other, before)
    assert.equal(await watermark(other), since + 1)
    // Polled: the clicking tab is behind the other, and draws no frames to check on.
    await clicking.waitForFunction(() => !!document.querySelector('.AO3E--search-host--progress'), { polling: 100 })
    // Long enough for a gather of its own to have asked for its first page.
    await sleep(1500)
    assert.ok(held.length > 0, 'the clicking tab is reading the next range')
    assert.deepEqual(nextRangeAsked('other'), [], 'the other tab is not')
  })

  test('the other tab says what it is waiting for', async () => {
    const label = await other.evaluate(() => document.querySelector('.AO3E--search-host--progress-label')?.textContent?.trim() ?? null)
    assert.match(label ?? '', /another tab/)
  })

  test('and opens on the range the clicking tab gathered, once it lands', async () => {
    holding = false
    for (const answer of held.splice(0))
      answer()
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
    assert.deepEqual(nextRangeAsked('other'), [], 'without asking the archive for any of it')
  })
})

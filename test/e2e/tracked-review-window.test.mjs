import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { formatDay } from '../../src/common/trackedLists.ts'
import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'
import { archiveRoutes, CLOCK_BASE, installClock, listing, resetWorkIds, search, TODAY, trackedOption, works } from './trackedReview.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const HISTORY_URL = 'https://archiveofourown.org/users/me/readings'

/** The range as the toolbar writes it: the year said once when both ends share it. */
function rangeText(start, end) {
  const from = formatDay(start)
  const to = formatDay(end)
  if (from === to)
    return `Reviewing ${from}`
  return `Reviewing ${from.slice(-4) === to.slice(-4) ? from.slice(0, -5) : from} – ${to}`
}

/**
 * The review window on screen.
 *
 * Three lists over ten days, a works-per-review target of ten, and one work
 * that two of the lists both turn up. What is pinned down here is that the
 * range the reader is shown is the one the counts imply, that the toolbar says
 * so, that moving its end by a day costs nothing, and that the List source
 * facet names each list the way the reader named it.
 *
 * The distribution, by day, as the union across the lists:
 *
 *     TODAY−10  3     TODAY−9  4     TODAY−8  3     TODAY−7  3  …
 *
 * so the target of ten is reached on TODAY−8 and passed on TODAY−7, which makes
 * the window the three days TODAY−10 … TODAY−8, holding ten works.
 */
describe('tracked review: the window', { skip }, () => {
  let browser
  let css
  let js
  let tab
  let fetched

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

  resetWorkIds(5000)
  const since = TODAY - 10
  /** One work both Alpha and Beta list, so it carries two facet values and counts once. */
  const shared = works([[since, 1]])
  const alpha = listing('alpha', [
    ...shared,
    ...works([[since, 2], [since + 1, 3], [since + 2, 3], [since + 3, 3], [since + 4, 3], [since + 5, 3]]),
  ], { entry: { alias: 'Alpha', since } })
  const beta = search('beta', [...shared], { entry: { alias: 'Beta', since } })
  // No alias: the facet falls back to the tail of the list's own address.
  const gamma = listing('gamma', works([[since + 1, 1]]), { entry: { alias: '', since } })
  const fixtures = [alpha, beta, gamma]

  const SEED = {
    // Off, so the subnav holds nothing between Marked for Later and our own
    // item — the ordering has a test of its own below.
    'option.searchReadWorks': false,
    'option.trackedLists': trackedOption(fixtures, { target: 10, reviewedThrough: since - 1 }),
    // An empty saved-work index that has actually been filled, so the toolbar
    // has nothing to warn about. A browser that has never opened Marked for
    // Later is its own case, in the already-reviewed tests.
    'cache.markedForLater': { userId: 'me', updatedAt: CLOCK_BASE, ids: '' },
  }

  /** The toolbar, as the reader reads it. */
  const toolbar = () => tab.evaluate(() => {
    const bar = document.querySelector('.AO3E--tracked-review--bar')
    if (!bar)
      return null
    const text = selector => bar.querySelector(selector)?.textContent?.trim() ?? null
    return {
      range: text('.AO3E--tracked-review--bar--range'),
      meta: text('.AO3E--tracked-review--bar--meta'),
      hint: text('.AO3E--tracked-review--bar--hint'),
      notes: text('.AO3E--tracked-review--bar--notes'),
      warnings: [...bar.querySelectorAll('.AO3E--tracked-review--bar--warning')].map(el => el.textContent.trim()),
      strip: [...bar.querySelectorAll('.AO3E--tracked-review--bar--day')].map(el => el.getAttribute('title')),
      steps: [...bar.querySelectorAll('.AO3E--tracked-review--bar--step')].map(el => el.disabled),
      markDisabled: bar.querySelector('.AO3E--tracked-review--bar--mark')?.disabled ?? null,
    }
  })

  /** Click the toolbar's − day (0) or + day (1). */
  const stepDay = async (index) => {
    await tab.evaluate(i => document.querySelectorAll('.AO3E--tracked-review--bar--step')[i].click(), index)
    await sleep(1500)
  }

  const shownCount = () => tab.evaluate(() =>
    document.querySelectorAll('.AO3E--search-view--results > li.blurb:not(.AO3E--search-view--hidden)').length)

  const facetRows = group => tab.evaluate((want) => {
    const details = Array.from(document.querySelectorAll('.AO3E--search-view--group'))
      .find(el => el.querySelector('.AO3E--search-view--group-label')?.textContent?.trim().startsWith(want))
    if (!details)
      return null
    return Array.from(details.querySelectorAll('.AO3E--search-view--row')).map(row => ({
      value: row.querySelector('.AO3E--search-view--row-name')?.textContent?.trim(),
      count: Number(row.querySelector('.AO3E--search-view--row-count')?.textContent),
    }))
  }, group)

  const includeFacet = async (value) => {
    await tab.evaluate((want) => {
      const row = Array.from(document.querySelectorAll('.AO3E--search-view--row'))
        .find(el => el.querySelector('.AO3E--search-view--row-name')?.textContent?.trim() === want)
      row.querySelector('.AO3E--search-view--toggle-include').click()
    }, value)
    await sleep(500)
  }

  const open = async (url, seed = SEED) => {
    const page = await browser.newPage()
    fetched = []
    await page.setViewport({ width: 1280, height: 900 })
    await page.setRequestInterception(true)
    page.on('request', archiveRoutes({ fixtures, fetched }))
    await page.evaluateOnNewDocument(installClock, CLOCK_BASE)
    await page.evaluateOnNewDocument(installMock, seed)
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await sleep(3000)
    return page
  }

  test('the hash opens the review, and the page says which list it is showing', async () => {
    tab = await open(`${HISTORY_URL}#ao3e-tracked`)
    assert.ok(await tab.$('.AO3E--search-host.AO3E--tracked-review'), 'the review view should be up')

    const chrome = await tab.evaluate(() => {
      const shown = el => getComputedStyle(el).display !== 'none'
      const nav = document.querySelector('#main ul.navigation.actions')
      return {
        heading: [...document.querySelectorAll('#main > h2.heading')].filter(shown).map(h => h.textContent.trim()),
        current: [...nav.querySelectorAll(':scope > li > span.current')].filter(s => shown(s.parentElement)).map(s => s.textContent.trim()),
        links: [...nav.querySelectorAll(':scope > li > a')].filter(a => shown(a.parentElement)).map(a => a.textContent.trim()),
        nativeList: shown(document.querySelector('#main ol.reading.work.index.group')),
      }
    })
    assert.deepEqual(chrome.heading, ['Tracked'])
    assert.deepEqual(chrome.current, ['Tracked'], 'History is no longer the current item')
    assert.deepEqual(chrome.links, ['History', 'Marked for Later'], 'and History’s Clear goes with it')
    assert.equal(chrome.nativeList, false)
  })

  test('the range is the run of days that fits the target, and the toolbar says so', async () => {
    const bar = await toolbar()
    assert.equal(bar.range, rangeText(since, since + 2))
    assert.equal(bar.meta, '3 days · 10 works (target 10)')
    assert.equal(await shownCount(), 10)
    assert.equal(bar.markDisabled, false, 'the range is over, and every list answered')
  })

  test('the day strip is one bar a day, with the day’s count on it', async () => {
    const bar = await toolbar()
    assert.deepEqual(bar.strip, [
      `${formatDay(since)} — 3 works`,
      `${formatDay(since + 1)} — 4 works`,
      `${formatDay(since + 2)} — 3 works`,
    ])
    assert.equal(bar.hint, '+1 day adds at least 3', 'what one more day would bring, from rows already read')
  })

  test('the notes line counts the lists and what is still waiting', async () => {
    const bar = await toolbar()
    // Twenty works across the three lists from the window's start through
    // today, ten of them in the window.
    assert.equal(bar.notes, '3 lists · about 10 more to review')
    assert.deepEqual(bar.warnings, [], 'nothing failed, and nothing hit the ceiling')
  })

  test('the List source facet names each list the way the reader named it', async () => {
    const rows = (await facetRows('List source')).sort((a, b) => (a.value < b.value ? -1 : 1))
    assert.deepEqual(rows, [
      { value: '/tags/gamma/works', count: 1 },
      { value: 'Alpha', count: 9 },
      { value: 'Beta', count: 1 },
    ])
    // Eleven facet hits over ten works: the work Alpha and Beta both list is
    // one work carrying two values, not two works.
    assert.equal(await shownCount(), 10)
  })

  test('narrowing to one list shows exactly its works', async () => {
    await includeFacet('Beta')
    assert.equal(await shownCount(), 1)
    await includeFacet('Beta')
    assert.equal(await shownCount(), 10)
  })

  test('+ day grows the range, and asks the archive for nothing', async () => {
    const before = fetched.length
    await stepDay(1)
    const bar = await toolbar()
    assert.equal(bar.meta, '4 days · 13 works (target 10)')
    assert.equal(bar.strip.length, 4)
    assert.equal(await shownCount(), 13)
    assert.equal(fetched.length, before, 'a day on the end re-plans over what is already in hand')
  })

  test('− day shrinks it, down to a floor of one day', async () => {
    await stepDay(0)
    assert.equal((await toolbar()).meta, '3 days · 10 works (target 10)')

    await stepDay(0)
    await stepDay(0)

    const bar = await toolbar()
    assert.equal(bar.meta, '1 day · 3 works (target 10)')
    assert.equal(bar.range, rangeText(since, since))
    assert.deepEqual(bar.steps, [true, false], 'a window is never less than a day')
    assert.equal(await shownCount(), 3)
    await tab.close()
    tab = null
  })

  test('the review’s subnav item sits after the read list’s', async () => {
    tab = await open(HISTORY_URL, {
      ...SEED,
      'option.searchReadWorks': true,
      // The read list is the reader's marks, so its own button needs them on.
      'option.workMarks': { enabled: true, marks: { read: { icon: 'read', label: 'Read', color: '#6b7280', items: '1', order: 0 } } },
    })
    const order = await tab.evaluate(() =>
      [...document.querySelectorAll('#main ul.navigation.actions > li')].map(li => li.textContent.trim()))
    assert.deepEqual(order.slice(0, 4), ['History', 'Marked for Later', 'Search read items', 'Tracked'])
    assert.equal(await tab.$('.AO3E--search-host'), null, 'and nothing opens until it is asked to')
  })

  test('clicking it opens the review in place, over History', async () => {
    await tab.click('.AO3E--tracked-review--button')
    await sleep(3000)
    assert.ok(await tab.$('.AO3E--search-host.AO3E--tracked-review'))
    assert.ok(await tab.$('.AO3E--search-view--back'), 'opened over History, "Back to list" means History')
    assert.equal(await shownCount(), 10)
  })
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { formatRange } from '../../src/common/trackedReads.ts'
import { figures, mentions } from '../facts.mjs'
import { DIST, ensureBuilt, findChrome, installMock, launch } from './helpers.mjs'
import { pressFacet, rerun, settled } from './trackedPages.mjs'
import { archiveRoutes, CLOCK_BASE, installClock, listing, resetWorkIds, reviewDrawn, search, TODAY, trackedOption, works } from './trackedReview.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const HISTORY_URL = 'https://archiveofourown.org/users/me/readings'

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
    browser = await launch(chromePath)
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

  /**
   * The toolbar: its range line, its meta line's days, works and target, the
   * figure its hint gives, its notes line's lists and works still waiting, the
   * kind of each warning, each day of the strip as `[day, works]`, which of its
   * steps are off, and whether Mark reviewed is.
   */
  const toolbar = async () => {
    const bar = await tab.evaluate(readBar)
    return bar && { ...bar, meta: figures(bar.meta), hint: figures(bar.hint), notes: figures(bar.notes) }
  }
  /** Runs in the page: the toolbar, its lines as they read. */
  function readBar() {
    const bar = document.querySelector('.AO3E--tracked-review--bar')
    if (!bar)
      return null
    const text = selector => bar.querySelector(selector)?.textContent?.trim() ?? null
    return {
      range: text('.AO3E--tracked-review--bar--range'),
      meta: text('.AO3E--tracked-review--bar--meta'),
      hint: text('.AO3E--tracked-review--bar--hint'),
      notes: text('.AO3E--tracked-review--bar--notes'),
      warnings: [...bar.querySelectorAll('.AO3E--tracked-review--bar--warning')].map(el => el.dataset.ao3eWarning),
      strip: [...bar.querySelectorAll('.AO3E--tracked-review--bar--day')].map(el => [Number(el.dataset.ao3eDay), Number(el.dataset.ao3eCount)]),
      steps: [...bar.querySelectorAll('.AO3E--tracked-review--bar--step')].map(el => el.disabled),
      markDisabled: bar.querySelector('.AO3E--tracked-review--bar--mark')?.disabled ?? null,
    }
  }

  /** Click the toolbar's − day (0) or + day (1), and wait for the range it gathers. */
  const stepDay = async (index) => {
    await tab.evaluate(i => document.querySelectorAll('.AO3E--tracked-review--bar--step')[i].click(), index)
    await reviewDrawn(tab)
  }

  const shownCount = () => tab.evaluate(() =>
    document.querySelectorAll('.AO3E--search-view--results > li.blurb:not(.AO3E--search-view--hidden)').length)

  const facetRows = key => tab.evaluate((want) => {
    const details = document.querySelector(`.AO3E--search-view--group[data-ao3e-facet="${want}"]`)
    if (!details)
      return null
    return Array.from(details.querySelectorAll('.AO3E--search-view--row')).map(row => ({
      value: row.querySelector('.AO3E--search-view--row-name')?.textContent?.trim(),
      count: Number(row.querySelector('.AO3E--search-view--row-count')?.textContent),
    }))
  }, key)

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
    await settled(page)
    return page
  }

  test('the hash opens the review, and the page says which list it is showing', async () => {
    tab = await open(`${HISTORY_URL}#ao3e-tracked`)
    await reviewDrawn(tab)
    assert.ok(await tab.$('.AO3E--search-host.AO3E--tracked-review'), 'the review view should be up')

    const chrome = await tab.evaluate(() => {
      const shown = el => getComputedStyle(el).display !== 'none'
      const nav = document.querySelector('#main ul.navigation.actions')
      const ours = el => el.classList.contains('AO3E--tracked-review--chrome')
      return {
        heading: [...document.querySelectorAll('#main > h2.heading')].filter(shown).map(ours),
        current: [...nav.querySelectorAll(':scope > li > span.current')].filter(s => shown(s.parentElement)).map(s => ours(s.parentElement)),
        links: [...nav.querySelectorAll(':scope > li > a')].filter(a => shown(a.parentElement)).map(a => a.textContent.trim()),
        nativeList: shown(document.querySelector('#main ol.reading.work.index.group')),
      }
    })
    assert.deepEqual(chrome.heading, [true], 'the review\'s own heading, in place of History\'s')
    assert.deepEqual(chrome.current, [true], 'History is no longer the current item')
    assert.deepEqual(chrome.links, ['History', 'Marked for Later'], 'and History’s Clear goes with it')
    assert.equal(chrome.nativeList, false)
  })

  test('the range is the run of days that fits the target, and the toolbar says so', async () => {
    const bar = await toolbar()
    assert.ok(mentions(bar.range, formatRange(since, since + 2)), bar.range)
    assert.deepEqual(bar.meta, [3, 10, 10])
    assert.equal(await shownCount(), 10)
    assert.equal(bar.markDisabled, false, 'the range is over, and every list answered')
  })

  test('the day strip is one bar a day, with the day’s count on it', async () => {
    const bar = await toolbar()
    assert.deepEqual(bar.strip, [[since, 3], [since + 1, 4], [since + 2, 3]])
    assert.ok(bar.hint.includes(3), 'what one more day would bring, from rows already read')
  })

  test('the notes line counts the lists and what is still waiting', async () => {
    const bar = await toolbar()
    // Nineteen works across the three lists from the window's start through
    // today, the one Alpha and Beta share counted once, ten of them in the window.
    assert.deepEqual(bar.notes, [3, 9])
    assert.deepEqual(bar.warnings, [], 'nothing to warn about')
  })

  test('the List source facet names each list the way the reader named it', async () => {
    const rows = (await facetRows('source')).sort((a, b) => (a.value < b.value ? -1 : 1))
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
    await pressFacet(tab, 'Beta')
    assert.equal(await shownCount(), 1)
    await pressFacet(tab, 'Beta')
    assert.equal(await shownCount(), 10)
  })

  test('+ day grows the range, and asks the archive for nothing', async () => {
    const before = fetched.length
    await stepDay(1)
    const bar = await toolbar()
    assert.deepEqual(bar.meta, [4, 10, 13])
    assert.equal(bar.strip.length, 4)
    assert.equal(await shownCount(), 13)
    assert.equal(fetched.length, before, 'a day on the end re-plans over what is already in hand')
  })

  test('− day shrinks it, down to a floor of one day', async () => {
    await stepDay(0)
    assert.deepEqual((await toolbar()).meta, [3, 10, 10])

    await stepDay(0)
    await stepDay(0)

    const bar = await toolbar()
    assert.deepEqual(bar.meta, [1, 3, 10])
    assert.ok(mentions(bar.range, formatRange(since, since)), bar.range)
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
    // AO3's own items by their text; the read list's and the review's by their buttons.
    const order = await tab.evaluate(() =>
      [...document.querySelectorAll('#main ul.navigation.actions > li')].map(li => (li.querySelector('.AO3E--search-read-works--button') && 'read list')
        || (li.querySelector('.AO3E--tracked-review--button') && 'review')
        || li.textContent.trim()))
    assert.deepEqual(order.slice(0, 4), ['History', 'Marked for Later', 'read list', 'review'])
    assert.equal(await tab.$('.AO3E--search-host'), null, 'and nothing opens until it is asked to')
  })

  test('clicking it opens the review in place, over History', async () => {
    await tab.click('.AO3E--tracked-review--button')
    await reviewDrawn(tab)
    assert.ok(await tab.$('.AO3E--search-host.AO3E--tracked-review'))
    assert.ok(await tab.$('.AO3E--search-view--back'), 'opened over History, "Back to list" means History')
    assert.equal(await shownCount(), 10)
  })

  test('a new target sizes the range again, rather than drawing the stored one', async () => {
    await rerun(tab, () => tab.evaluate(async () => {
      const { 'option.trackedLists': option } = await browser.storage.local.get('option.trackedLists')
      await browser.storage.local.set({ 'option.trackedLists': { ...option, target: 6 } })
    }))
    await reviewDrawn(tab)

    const bar = await toolbar()
    assert.deepEqual(bar.meta, [1, 3, 6], 'the next day would take it to seven')
    assert.ok(mentions(bar.range, formatRange(since, since)), bar.range)
    assert.equal(await shownCount(), 3)
  })
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'
import { archiveRoutes, CLOCK_BASE, installClock, listing, resetWorkIds, TODAY, trackedOption, works } from './trackedReview.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const REVIEW_URL = 'https://archiveofourown.org/users/me/readings#ao3e-tracked'

/** Work ids in the packed form the marks and the saved-work index store them in. */
function pack(ids) {
  let previous = 0
  return ids.map(Number).sort((a, b) => a - b).map((id) => {
    const delta = id - previous
    previous = id
    return delta.toString(36)
  }).join(',')
}

function marks(read, favorite) {
  return {
    enabled: true,
    marks: {
      read: { icon: 'read', label: 'Read', color: '#6b7280', hideSearchResult: false, items: pack(read), order: 0 },
      favorite: { icon: 'favorite', label: 'Favorite', color: '#b8860b', triggerAlias: 'read', hideSearchResult: false, items: pack(favorite), order: 1 },
    },
  }
}

/**
 * Works the reader has already dealt with never reach the review.
 *
 * A work marked read — or carrying any verdict that aliases read — and a work on
 * Marked for Later are both the reader having made their choice, so neither
 * belongs in a stream of things they have yet to look at. They don't merely go
 * unshown: they are out before anything is counted, which is what lets the
 * window reach further than it otherwise would.
 *
 * Two days of four works. Two of the first day's are already dealt with and one
 * of the second's, so against a target of six the counts are 2 and 3 — five
 * works over both days, where the raw eight would have ended the window after
 * the first day.
 */
describe('tracked review: works already dealt with', { skip }, () => {
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
  const since = TODAY - 2
  const first = works([[since, 4]])
  const second = works([[since + 1, 4]])
  const solo = listing('solo', [...first, ...second], { entry: { alias: 'Solo', since } })

  const [markedRead, markedFavorite] = first
  const [savedForLater, plain] = second

  const SEED = {
    'option.searchReadWorks': false,
    'option.trackedLists': trackedOption([solo], { target: 6, reviewedThrough: since - 1 }),
    'option.workMarks': marks([markedRead.id], [markedFavorite.id]),
    'cache.markedForLater': { userId: 'me', updatedAt: CLOCK_BASE, ids: pack([savedForLater.id]) },
  }

  const open = async (seed = SEED) => {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })
    await page.setRequestInterception(true)
    page.on('request', archiveRoutes({ fixtures: [solo] }))
    await page.evaluateOnNewDocument(installClock, CLOCK_BASE)
    await page.evaluateOnNewDocument(installMock, seed)
    await page.goto(REVIEW_URL, { waitUntil: 'domcontentloaded' })
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await sleep(3000)
    return page
  }

  const barText = selector => tab.evaluate(sel =>
    document.querySelector(`.AO3E--tracked-review--bar${sel}`)?.textContent?.trim() ?? null, selector)

  const shownIds = () => tab.evaluate(() =>
    [...document.querySelectorAll('.AO3E--search-view--results > li.blurb:not(.AO3E--search-view--hidden)')]
      .map(li => li.id.replace('work_', '')))

  test('a marked, a verdict-marked and a saved work are all absent', async () => {
    tab = await open()
    const shown = await shownIds()
    assert.ok(!shown.includes(markedRead.id), 'marked read')
    assert.ok(!shown.includes(markedFavorite.id), 'marked Favorite, which aliases read')
    assert.ok(!shown.includes(savedForLater.id), 'on Marked for Later')
    assert.equal(shown.length, 5)
  })

  test('and none of them counts toward the target', async () => {
    // Eight works over the two days; five of them count, which is inside the
    // target of six — so the range runs to yesterday instead of stopping after
    // the first day, which eight would have forced.
    assert.equal(await barText('--meta'), '2 days · 5 works (target 6)')
    const strip = await tab.evaluate(() =>
      [...document.querySelectorAll('.AO3E--tracked-review--bar--day')].map(el => el.getAttribute('title')))
    assert.deepEqual(strip.map(title => title.split('—')[1].trim()), ['2 works', '3 works'])
  })

  test('a work marked during the review stays where it is', async () => {
    await tab.evaluate(table => browser.storage.local.set({ 'option.workMarks': table }), marks([markedRead.id], [markedFavorite.id, plain.id]))
    await sleep(2500)
    const shown = await shownIds()
    assert.ok(shown.includes(plain.id), 'marking is taking notes on the box, not emptying it')
    assert.equal(shown.length, 5)
  })

  test('and only drops out when the range is reloaded — which the reader asks for', async () => {
    await tab.click('.AO3E--search-view--refresh')
    await sleep(3500)
    // A review holds its page layout, so a reload that arrives on its own is
    // offered rather than swapped in. This one is the reader's own Refresh, and
    // answering the button they pressed with a second button to press isn't an
    // answer — it goes in at once.
    assert.equal(await barText('--prompt'), '')
    const shown = await shownIds()
    assert.ok(!shown.includes(plain.id))
    assert.equal(shown.length, 4)
    // And the toolbar describes the window that is now on screen, not the one
    // it replaced.
    assert.equal(await barText('--meta'), '2 days · 4 works (target 6)')
  })

  test('a reload nobody asked for is offered rather than swapped in', async () => {
    // Everything the first page wrote, so this one opens on the stored window
    // instead of gathering one — a cached render is what a background reload
    // has to interrupt, and a zero refresh interval is what sends one.
    const stored = await tab.evaluate(() => Object.assign({}, ...window.__writes))
    await tab.close()
    tab = await open({ ...SEED, ...stored, 'option.searchProfileListsRefreshHours': 0 })
    await sleep(2500)

    assert.equal(await barText('--prompt'), 'Range updated.Show')
    assert.equal((await shownIds()).length, 4, 'the reader keeps the works they were looking at')

    await tab.evaluate(() => {
      [...document.querySelectorAll('.AO3E--tracked-review--bar--confirm')]
        .find(button => button.textContent.trim() === 'Show')
        .click()
    })
    await sleep(800)
    assert.equal(await barText('--prompt'), '')
    assert.equal((await shownIds()).length, 4)
    await tab.close()
    tab = null
  })

  test('a browser that has never opened Marked for Later says so, and shows more', async () => {
    const seed = { ...SEED }
    delete seed['cache.markedForLater']
    tab = await open(seed)

    const warnings = await tab.evaluate(() =>
      [...document.querySelectorAll('.AO3E--tracked-review--bar--warning')].map(el => el.textContent.trim()))
    assert.deepEqual(warnings, ['Marked for Later not loaded on this browser. Open it once to skip saved works.'])
    const shown = await shownIds()
    assert.ok(shown.includes(savedForLater.id), 'the index cannot rule it out, so it is shown')
    assert.equal(shown.length, 6)
  })
})

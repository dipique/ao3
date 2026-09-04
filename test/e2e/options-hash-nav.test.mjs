import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { ensureBuilt, findChrome, installMock, serveDist, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const SEED = {}

/**
 * Deep links into the options page. A hash may name a category, a sub-section or
 * a single setting, by the id it renders with or by the name it shows — and
 * getting there has to survive the two things that can be hiding the target: a
 * folded section and a running settings search.
 */
describe('options UI — jumping to a #hash', { skip }, () => {
  let server
  let browser
  let page

  before(async () => {
    ensureBuilt()
    server = await serveDist()
    browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-first-run', '--no-default-browser-check'] })
    page = await browser.newPage()
    await page.evaluateOnNewDocument(installMock, SEED)
    await page.goto(`${server.url}/options_ui/options_ui.html#work-text-reader-mode`, { waitUntil: 'networkidle2' })
    await sleep(1500)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
    await server?.close()
  })

  /** Where the named element sits relative to the viewport, and whether it's on screen. */
  const positionOf = id => page.evaluate((elementId) => {
    const el = document.getElementById(elementId)
    if (!el)
      return null
    const { top, height } = el.getBoundingClientRect()
    return { top, height, onScreen: top >= 0 && top < window.innerHeight }
  }, id)

  /**
   * Follow a hash the way the address bar (or a nav link) would. Setting the
   * same hash twice fires no `hashchange`, so it is cleared first — the tests
   * below revisit the same target more than once.
   */
  const goTo = async (hash) => {
    await page.evaluate((h) => {
      if (location.hash === h)
        location.hash = ''
      location.hash = h
    }, hash)
    // The jump waits for any unfold to stop moving the target before scrolling.
    await sleep(1600)
  }

  test('the hash the page opened with is scrolled to', async () => {
    const row = await positionOf('work-text-reader-mode')
    assert.ok(row, 'the reader mode row should have its own anchor id')
    assert.ok(row.onScreen, `reader mode row was at ${row.top}px`)
    // Landing under the sticky header would be the same bug as not landing at all.
    assert.ok(row.top > 0, `reader mode row was at ${row.top}px, under the header`)
  })

  test('a category can be named by its title, not just its id', async () => {
    await goTo('#Search')
    const category = await positionOf('search')
    assert.ok(category?.onScreen, `search category was at ${category?.top}px`)
  })

  test('a sub-section has an anchor of its own', async () => {
    await goTo('#chapter-statistics')
    const subsection = await positionOf('chapter-statistics')
    assert.ok(subsection?.onScreen, `chapter statistics was at ${subsection?.top}px`)
  })

  test('a folded-away section is unfolded on the way', async () => {
    // Fold everything, then ask for a row that only exists while its category is
    // open — the anchor registry has to outlive the unmount for this to resolve.
    await page.evaluate(() => {
      const collapse = [...document.querySelectorAll('button')].find(b => /Collapse all/i.test(b.textContent))
      collapse.click()
    })
    await sleep(500)
    assert.equal(await positionOf('work-text-reader-mode'), null, 'the row should be folded away')

    await goTo('#work-text-reader-mode')
    const row = await positionOf('work-text-reader-mode')
    assert.ok(row?.onScreen, `reader mode row was at ${row?.top}px after unfolding`)
  })

  test('a search hiding the target is cleared, and one that is not is kept', async () => {
    const search = await page.$('input[aria-label="Search settings by name or description"]')

    await search.click()
    await search.type('crossover')
    await sleep(400)
    await goTo('#work-text-reader-mode')
    assert.equal(await page.evaluate(() => document.querySelector('input[aria-label="Search settings by name or description"]').value), '')
    assert.ok((await positionOf('work-text-reader-mode'))?.onScreen)

    // A query the target survives is the reader's place in the page, and is left
    // where it is.
    await search.click()
    await search.type('reader mode')
    await sleep(400)
    await goTo('#work-text-reader-mode')
    assert.equal(await page.evaluate(() => document.querySelector('input[aria-label="Search settings by name or description"]').value), 'reader mode')
  })
})

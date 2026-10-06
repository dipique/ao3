import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { sleep } from './helpers.mjs'
import { skip, startOptions } from './optionsPage.mjs'

const SEARCH = 'Search settings by name or description'

const CATEGORIES = ['site-features-appearance', 'search', 'reading', 'sync-backups', 'advanced']

/**
 * Getting around the options page: the pane shows one category at a time, the
 * rail picks it, and a `#hash` names a category, a sub-section or a single
 * setting — by the id it renders with or by the name it shows — and opens the
 * category that holds it. A settings search looks across every category at
 * once, and Escape puts the pane back where it was.
 */
describe('options UI — the rail, #hash jumps and the settings search', { skip }, () => {
  let session
  let options
  let page

  before(async () => {
    session = await startOptions()
    options = await session.open({ hash: '#work-text-reader-mode', viewport: { width: 1280, height: 800 } })
    page = options.page
  }, { timeout: 180000 })

  after(() => session?.close())

  /**
   * Where the named element sits in the window: whether it's on screen, and
   * whether it's clear of the sticky top bar, which ends where the rail begins.
   */
  const positionOf = id => page.evaluate((elementId) => {
    const el = document.getElementById(elementId)
    if (!el || !el.checkVisibility())
      return null
    const { top } = el.getBoundingClientRect()
    const below = document.querySelector('[data-rail]').getBoundingClientRect().top
    return { top, onScreen: top >= 0 && top < window.innerHeight, clear: top >= below - 1 }
  }, id)

  /**
   * Follow a hash the way the address bar would. Setting the same hash twice
   * fires no `hashchange`, so it is cleared first — the tests below revisit the
   * same target more than once.
   */
  const goTo = async (hash) => {
    await page.evaluate((h) => {
      if (location.hash === h)
        location.hash = ''
      location.hash = h
    }, hash)
    await sleep(1600)
  }

  const railLink = async (id) => {
    const link = await (await options.rail()).$(`[data-rail-item][href="#${id}"]`)
    assert.ok(link, `no rail link to #${id}`)
    return link
  }

  const categoriesOnRail = async () => (await options.railItems()).filter(item => item.kind === 'category')
  const subsectionsOnRail = async () => (await options.railItems()).filter(item => item.kind === 'subsection')

  const searchBox = () => options.control(page, 'textbox', SEARCH)
  const searchText = async () => (await searchBox()).evaluate(el => el.value)
  const search = async (text) => {
    const box = await searchBox()
    await box.click({ count: 3 })
    await page.keyboard.press('Backspace')
    await box.type(text)
    await sleep(400)
  }

  /** "n of m settings match", as the pane says it while a query runs. */
  const matchLine = async () => {
    const found = /(\d+) of (\d+) settings match/.exec(await page.evaluate(() => document.querySelector('main').textContent))
    return found ? { hits: Number(found[1]), total: Number(found[2]) } : null
  }

  test('the hash the page opened with shows its category alone, scrolled to the setting', async () => {
    assert.deepEqual(await options.shownCategories(), ['reading'])
    const row = await positionOf('work-text-reader-mode')
    assert.ok(row, 'the reader mode row should be shown, under its own anchor id')
    assert.ok(row.onScreen, `reader mode row was at ${row.top}px`)
    assert.ok(row.clear, `reader mode row was at ${row.top}px, under the top bar`)
  })

  test('every category stays on the page while another is shown', async () => {
    const hidden = await options.row('filter-defaults-default-crossovers')
    assert.equal(await hidden.evaluate(el => el.checkVisibility()), false)
  })

  test('the rail lists every category by its short name, and opens the current one onto its sub-sections', async () => {
    const categories = await categoriesOnRail()
    assert.deepEqual(categories.map(c => c.id), CATEGORIES)
    assert.deepEqual(categories.map(c => c.name), ['Site features', 'Search', 'Reading', 'Sync & backups', 'Advanced'])
    assert.deepEqual(categories.filter(c => c.current).map(c => c.id), ['reading'])
    assert.ok(categories.every(c => c.count === null), 'no query, so no count beside a category')

    const subsections = await subsectionsOnRail()
    assert.deepEqual(subsections.map(s => s.id), ['marks-status', 'work-statistics', 'chapter-statistics', 'work-text'])
    assert.ok(subsections.every(s => Number.isInteger(s.count) && s.count > 0), JSON.stringify(subsections))
    assert.equal(subsections.find(s => s.id === 'work-statistics').count, 4, 'reading speed, reading time, finish time and kudos/hits')
  })

  test('a rail click opens that category and makes it current', async () => {
    await options.press(await railLink('search'))
    await sleep(1600)
    assert.equal(await page.evaluate(() => location.hash), '#search')
    assert.deepEqual(await options.shownCategories(), ['search'])
    assert.deepEqual((await categoriesOnRail()).filter(c => c.current).map(c => c.id), ['search'])
    assert.deepEqual((await subsectionsOnRail()).map(s => [s.id, s.name]), [
      ['filter-defaults', 'Filter defaults'],
      ['customize-search-results', 'Customize Search Results'],
      ['instant-search-views', 'Instant search views'],
    ])
  })

  test('a sub-section link jumps to it, inside the category', async () => {
    await options.press(await railLink('customize-search-results'))
    await sleep(1600)
    assert.equal(await page.evaluate(() => location.hash), '#customize-search-results')
    assert.deepEqual(await options.shownCategories(), ['search'])
    const subsection = await positionOf('customize-search-results')
    assert.ok(subsection?.onScreen && subsection.clear, `the sub-section was at ${subsection?.top}px`)
  })

  test('a hash naming another category\'s setting opens that category', async () => {
    await goTo('#chapter-statistics')
    assert.deepEqual(await options.shownCategories(), ['reading'])
    assert.ok((await positionOf('chapter-statistics'))?.onScreen)
  })

  test('a hash that names a category, or a setting, by what the page calls it lands there', async () => {
    await goTo('#Search')
    assert.deepEqual(await options.shownCategories(), ['search'])
    assert.ok((await positionOf('search'))?.onScreen)

    // The setting's id carries its sub-section; a hash written as the setting's
    // own name, without it, falls back to the name.
    await goTo('#Reader mode')
    assert.deepEqual(await options.shownCategories(), ['reading'])
    const row = await positionOf('work-text-reader-mode')
    assert.ok(row?.onScreen && row.clear, `reader mode row was at ${row?.top}px`)
  })

  test('a query shows every category with a hit under its heading, and only the rows that match', async () => {
    await goTo('#reading')
    await search('collapse')

    assert.deepEqual(await options.shownCategories(), ['site-features-appearance', 'search'])
    const headings = []
    for (const id of ['site-features-appearance', 'search'])
      headings.push((await options.lines(await options.row(id)))[0])
    assert.deepEqual(headings, ['Site features & appearance', 'Search'])

    const shown = async id => (await options.row(id)).evaluate(el => el.checkVisibility())
    assert.equal(await shown('link-menus-hide-or-highlight-an-author'), true, 'its description says "collapse"')
    assert.equal(await shown('link-menus-right-click-menus'), false, 'a row without the term is hidden')
  })

  test('while a query runs, the rail lists only the categories with hits, each with its count', async () => {
    const categories = await categoriesOnRail()
    assert.deepEqual(categories.map(c => c.id), ['site-features-appearance', 'search'])
    assert.ok(categories.every(c => c.count > 0), JSON.stringify(categories))
    const line = await matchLine()
    assert.ok(line, 'the pane says how many settings match')
    assert.equal(categories.reduce((sum, c) => sum + c.count, 0), line.hits, 'the counts add up to the settings that match')
    assert.deepEqual(await subsectionsOnRail(), [], 'the current category has no hit, so it is not open on the rail')
  })

  test('Escape clears the query and returns to the category the search started from', async () => {
    await (await searchBox()).focus()
    await page.keyboard.press('Escape')
    await sleep(400)
    assert.equal(await searchText(), '')
    assert.equal(await matchLine(), null)
    assert.deepEqual(await options.shownCategories(), ['reading'])
    assert.deepEqual((await categoriesOnRail()).map(c => c.id), CATEGORIES)
    assert.deepEqual((await categoriesOnRail()).filter(c => c.current).map(c => c.id), ['reading'])
  })

  test('a jump the search would hide clears it, and one it keeps leaves it running', async () => {
    await search('crossover')
    await goTo('#work-text-reader-mode')
    assert.equal(await searchText(), '')
    assert.deepEqual(await options.shownCategories(), ['reading'])
    assert.ok((await positionOf('work-text-reader-mode'))?.onScreen)

    // A query the target survives is the reader's place in the page, and is left
    // where it is.
    await search('reader mode')
    await goTo('#work-text-reader-mode')
    assert.equal(await searchText(), 'reader mode')
    assert.ok((await positionOf('work-text-reader-mode'))?.onScreen)
  })

  test('Back to the address the page opened with, which has no hash, returns to the first category', async () => {
    const fresh = await session.open({ viewport: { width: 1280, height: 800 } })
    try {
      assert.deepEqual(await fresh.shownCategories(), ['site-features-appearance'])
      await fresh.press(await (await fresh.rail()).$('[data-rail-item][href="#reading"]'))
      await sleep(1600)
      assert.deepEqual(await fresh.shownCategories(), ['reading'])

      await fresh.page.goBack()
      await sleep(1600)
      assert.equal(await fresh.page.evaluate(() => location.hash), '')
      assert.deepEqual(await fresh.shownCategories(), ['site-features-appearance'])
      assert.deepEqual((await fresh.railItems()).filter(item => item.current).map(item => item.id), ['site-features-appearance'])
    }
    finally {
      await fresh.close()
    }
  })
})

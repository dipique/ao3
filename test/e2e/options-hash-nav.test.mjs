import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { storedLists } from './helpers.mjs'
import { skip, startOptions, until } from './optionsPage.mjs'

const SEARCH = 'Search settings by name or description'

/** A stored works search, for the saved lists to have a row. */
const TEA_KEY = 'text-search:work_search%5Bquery%5D=tea'
const TEA_COPY = storedLists({
  [TEA_KEY]: {
    scrapedAt: Date.now(),
    blurbsHtml: ['<li class="work blurb group" id="work_101" role="article"><h4 class="heading"><a href="/works/101">Work 101</a></h4></li>'],
    descriptor: { sourceId: 'text-search', label: 'Works search — tea', listUrl: 'https://archiveofourown.org/works/search?work_search%5Bquery%5D=tea' },
  },
})

const CATEGORIES = ['site-features-appearance', 'search', 'lists', 'reading', 'sync-backups', 'advanced']

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

  /** Follow a hash the way the address bar would, and wait for the page to land there. */
  const goTo = hash => options.goTo(hash)

  const railLink = async (id) => {
    const link = await (await options.rail()).$(`[data-rail-item][href="#${id}"]`)
    assert.ok(link, `no rail link to #${id}`)
    return link
  }

  const categoriesOnRail = async () => (await options.railItems()).filter(item => item.kind === 'category')
  const subsectionsOnRail = async () => (await options.railItems()).filter(item => item.kind === 'subsection')

  /** "n of m settings match", as the pane says it while a query runs. */
  const matchLine = async () => {
    const found = /(\d+) of (\d+) settings match/.exec(await page.evaluate(() => document.querySelector('main').textContent))
    return found ? { hits: Number(found[1]), total: Number(found[2]) } : null
  }

  const searchBox = () => options.control(page, 'textbox', SEARCH)
  const searchText = async () => (await searchBox()).evaluate(el => el.value)
  const search = async (text) => {
    const box = await searchBox()
    await box.click({ count: 3 })
    await page.keyboard.press('Backspace')
    await box.type(text)
    await until('the query to filter the page', async () => (await matchLine()) !== null)
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
    assert.deepEqual(categories.map(c => c.name), ['Site features', 'Search', 'Lists', 'Reading', 'Sync & backups', 'Advanced'])
    assert.deepEqual(categories.filter(c => c.current).map(c => c.id), ['reading'])
    assert.ok(categories.every(c => c.count === null), 'no query, so no count beside a category')

    const subsections = await subsectionsOnRail()
    assert.deepEqual(subsections.map(s => s.id), ['marks-status', 'work-statistics', 'chapter-statistics', 'work-text'])
    assert.ok(subsections.every(s => Number.isInteger(s.count) && s.count > 0), JSON.stringify(subsections))
    assert.equal(subsections.find(s => s.id === 'work-statistics').count, 4, 'reading speed, reading time, finish time and kudos/hits')
  })

  test('a rail click opens that category and makes it current', async () => {
    const link = await railLink('search')
    await options.land(() => options.press(link))
    assert.equal(await page.evaluate(() => location.hash), '#search')
    assert.deepEqual(await options.shownCategories(), ['search'])
    assert.deepEqual((await categoriesOnRail()).filter(c => c.current).map(c => c.id), ['search'])
    assert.deepEqual((await subsectionsOnRail()).map(s => [s.id, s.name]), [
      ['filter-defaults', 'Filter defaults'],
      ['customize-search-results', 'Customize search results'],
      ['instant-search-views', 'Instant search views'],
    ])
  })

  test('a sub-section link jumps to it, inside the category', async () => {
    const link = await railLink('customize-search-results')
    await options.land(() => options.press(link))
    assert.equal(await page.evaluate(() => location.hash), '#customize-search-results')
    assert.deepEqual(await options.shownCategories(), ['search'])
    const subsection = await positionOf('customize-search-results')
    assert.ok(subsection?.onScreen && subsection.clear, `the sub-section was at ${subsection?.top}px`)
  })

  test('Lists, between Search and Reading, opens onto its review, its saved lists, the reader\'s profile lists and offline reading', async () => {
    const lists = await session.open({ seed: TEA_COPY, hash: '#lists', viewport: { width: 1280, height: 800 } })
    try {
      assert.deepEqual(await lists.shownCategories(), ['lists'])
      const subsections = (await lists.railItems()).filter(item => item.kind === 'subsection')
      assert.deepEqual(subsections.map(s => [s.id, s.name]), [
        ['review', 'Review'],
        ['saved-lists', 'Saved lists'],
        ['user-profile-lists', 'User profile lists'],
        ['offline-reading', 'Offline reading'],
      ])
      assert.equal(subsections.find(s => s.id === 'user-profile-lists').count, 2, 'Marked for Later and Read works')
      assert.equal(subsections.find(s => s.id === 'saved-lists').count, 1, 'one per saved list')
      for (const id of ['review-tracked-lists', 'user-profile-lists-marked-for-later', 'user-profile-lists-read-works', 'offline-reading-changes-made-in-an-export', 'offline-reading-cached-work-text', 'offline-reading-discard-unneeded-blurbs-automatically'])
        assert.equal(await (await lists.row(id)).evaluate(el => el.checkVisibility()), true, id)
      const stored = await lists.savedList(`copy:${TEA_KEY}`)
      assert.equal(await stored.evaluate(el => el.id), 'saved-lists-search-tea', 'a saved list\'s row is anchored under Saved lists, by its name')
    }
    finally {
      await lists.close()
    }
  })

  test('with no lists saved, Saved lists is on the rail at 0, and its link lands on the empty state', async () => {
    const lists = await session.open({ hash: '#lists', viewport: { width: 1280, height: 800 } })
    try {
      // With no rows, the frame is its header and its empty state.
      const frame = () => lists.list('saved-lists')
      await until('the saved lists to be read', async () => /No saved lists yet/.test(await lists.text(await frame())))
      const subsections = (await lists.railItems()).filter(item => item.kind === 'subsection')
      assert.deepEqual(subsections.map(s => s.id), ['review', 'saved-lists', 'user-profile-lists', 'offline-reading'])
      assert.equal(subsections.find(s => s.id === 'saved-lists').count, 0)

      const link = await (await lists.rail()).$('[data-rail-item="subsection"][href="#saved-lists"]')
      await lists.land(() => lists.press(link))
      const where = await (await frame()).evaluate((el) => {
        const { top, bottom } = el.getBoundingClientRect()
        return { top, bottom, below: document.querySelector('[data-rail]').getBoundingClientRect().top, height: window.innerHeight }
      })
      assert.ok(where.top >= where.below - 1 && where.bottom <= where.height, `the frame holding the empty state was at ${where.top}–${where.bottom}px`)
    }
    finally {
      await lists.close()
    }
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
    await until('the query to clear', async () => (await matchLine()) === null)
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
      const reading = await (await fresh.rail()).$('[data-rail-item][href="#reading"]')
      await fresh.land(() => fresh.press(reading))
      assert.deepEqual(await fresh.shownCategories(), ['reading'])

      await fresh.land(() => fresh.page.goBack())
      assert.equal(await fresh.page.evaluate(() => location.hash), '')
      assert.deepEqual(await fresh.shownCategories(), ['site-features-appearance'])
      assert.deepEqual((await fresh.railItems()).filter(item => item.current).map(item => item.id), ['site-features-appearance'])
    }
    finally {
      await fresh.close()
    }
  })
})

/**
 * As the page scrolls, the rail marks the current category's sub-section
 * being read: the one whose section holds the reading line, just under the
 * top bar, or at the foot of the page the last, however short. A jump marks
 * where it goes at once, and keeps it marked where it lands until the reader
 * scrolls on. A narrow window's chip row lists no sub-sections, so marks none.
 */
describe('options UI — the rail marks the sub-section being read', { skip }, () => {
  const VIEWPORT = { width: 1280, height: 800 }
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  /** The ids of the sub-sections the rail marks: the one, or none. */
  const marked = async options => (await options.railItems()).filter(item => item.inView).map(item => item.id)
  const markedIs = async (options, ...ids) => JSON.stringify(await marked(options)) === JSON.stringify(ids)

  /** Scroll the window, as the reader would. */
  const scrollTo = (options, top) => options.page.evaluate(y => window.scrollTo({ top: y, behavior: 'instant' }), top)

  /**
   * How far the page scrolls to bring the sub-section's top to the reading
   * line, where a jump puts it, and how far the page can scroll.
   */
  const reach = (options, id) => options.page.evaluate((sectionId) => {
    const section = document.getElementById(sectionId)
    const line = Number.parseFloat(getComputedStyle(section).scrollMarginTop)
    return { top: section.getBoundingClientRect().top + window.scrollY - line, max: document.documentElement.scrollHeight - window.innerHeight }
  }, id)

  /** From now on, note each sub-section the rail marks, in turn, for `marks` to read back. */
  const noteMarks = options => options.page.evaluate(() => {
    window.__marks = []
    const rail = document.querySelector('[data-rail]')
    new MutationObserver(() => {
      const now = rail.querySelector('[data-rail-item="subsection"][aria-current="location"]')?.hash.slice(1)
      if (now && window.__marks.at(-1) !== now)
        window.__marks.push(now)
    }).observe(rail, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-current'] })
  })
  const marks = options => options.page.evaluate(() => window.__marks)

  test('scrolling a category marks each of its sub-sections in turn, from the first', async () => {
    const options = await session.open({ hash: '#search', viewport: VIEWPORT })
    try {
      const ids = (await options.railItems()).filter(item => item.kind === 'subsection').map(item => item.id)
      assert.deepEqual(ids, ['filter-defaults', 'customize-search-results', 'instant-search-views'])
      await until('the first to be marked, above them all', () => markedIs(options, 'filter-defaults'))

      for (const [i, id] of ids.entries()) {
        const { top, max } = await reach(options, id)
        assert.ok(top <= max, `${id} reaches the reading line at ${top} px, within the page's ${max} px`)
        if (i > 0) {
          await scrollTo(options, top - 20)
          await until(`${ids[i - 1]} to be marked, ${id} still under the line`, () => markedIs(options, ids[i - 1]))
        }
        await scrollTo(options, top)
        await until(`${id} to be marked`, () => markedIs(options, id))
      }
    }
    finally {
      await options.close()
    }
  })

  test('at the foot of the page, a last sub-section too short to reach the reading line is marked', async () => {
    const options = await session.open({ hash: '#site-features-appearance', viewport: VIEWPORT })
    try {
      const { top, max } = await reach(options, 'appearance')
      assert.ok(top > max, `Appearance reaches the reading line at ${top} px, past the page's ${max} px`)
      await scrollTo(options, max)
      await until('Appearance to be marked', () => markedIs(options, 'appearance'))
    }
    finally {
      await options.close()
    }
  })

  test('a rail click marks its target at once, and where the page stops short of it, until the reader scrolls on', async () => {
    const options = await session.open({ hash: '#site-features-appearance', viewport: VIEWPORT })
    try {
      await until('Link menus to be marked', () => markedIs(options, 'link-menus'))
      const { top, max } = await reach(options, 'page-controls')
      assert.ok(top > max, `Page controls reaches the reading line at ${top} px, past the page's ${max} px`)

      await noteMarks(options)
      const link = await (await options.rail()).$('[data-rail-item="subsection"][href="#page-controls"]')
      await options.land(() => options.press(link))
      await until('Page controls to be marked', () => markedIs(options, 'page-controls'))
      assert.deepEqual(await marks(options), ['page-controls'], 'and nothing else on the way')

      await scrollTo(options, max - 200)
      await until('the reading line to decide again', () => markedIs(options, 'link-menus'))

      // Clicked again, the link changes no hash: the browser's scroll is the whole jump.
      await options.press(link)
      await until('Page controls to be marked again', () => markedIs(options, 'page-controls'))
      await scrollTo(options, max - 200)
      await until('the reading line to decide once more', () => markedIs(options, 'link-menus'))
    }
    finally {
      await options.close()
    }
  })

  test('a hash that opens another category marks its target at once, and where the page stops short of it', async () => {
    const options = await session.open({ hash: '#instant-search-views', viewport: VIEWPORT })
    try {
      await until('Instant search views to be marked', () => markedIs(options, 'instant-search-views'))
      await noteMarks(options)
      await options.goTo('#chapter-statistics')
      const { top, max } = await reach(options, 'chapter-statistics')
      assert.ok(top > max, `Chapter statistics reaches the reading line at ${top} px, past the page's ${max} px`)
      await until('Chapter statistics to be marked', () => markedIs(options, 'chapter-statistics'))
      assert.deepEqual(await marks(options), ['chapter-statistics'], 'and nothing else on the way')
    }
    finally {
      await options.close()
    }
  })

  test('a hash naming a setting marks the sub-section it is in', async () => {
    const options = await session.open({ hash: '#work-text-reader-mode', viewport: VIEWPORT })
    try {
      await until('Work text to be marked', () => markedIs(options, 'work-text'))
    }
    finally {
      await options.close()
    }
  })

  test('while a query runs, the mark is on a sub-section the rail lists', async () => {
    const options = await session.open({ hash: '#customize-search-results', viewport: VIEWPORT })
    try {
      await until('Customize search results to be marked', () => markedIs(options, 'customize-search-results'))
      await (await options.control(options.page, 'textbox', SEARCH)).type('complete')
      await until('the rail to list Filter defaults alone', async () => {
        const listed = (await options.railItems()).filter(item => item.kind === 'subsection').map(item => item.id)
        return JSON.stringify(listed) === JSON.stringify(['filter-defaults'])
      })
      await until('Filter defaults to be marked', () => markedIs(options, 'filter-defaults'))
    }
    finally {
      await options.close()
    }
  })

  test('below 768 px, where the chip row lists no sub-sections, none is marked', async () => {
    const options = await session.open({ hash: '#search', viewport: VIEWPORT })
    try {
      const anyMarked = () => options.page.$('[aria-current="location"]')
      await until('the first to be marked', () => markedIs(options, 'filter-defaults'))
      await options.page.setViewport({ width: 390, height: 844 })
      await until('the mark to go', async () => await anyMarked() === null)

      await scrollTo(options, (await reach(options, 'instant-search-views')).top)
      // The page reads where it is scrolled to once a frame, in the frame after the scroll.
      await options.frame()
      await options.frame()
      assert.equal(await anyMarked(), null)
    }
    finally {
      await options.close()
    }
  })
})

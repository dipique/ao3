import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { ensureBuilt, findChrome, storedListIds } from './helpers.mjs'
import { startOptions, until } from './optionsPage.mjs'
import { ARCHIVE, blurb, launch, listingPage, openTab, pillText, stored, visit } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const LISTING = `${ARCHIVE}/tags/Bees/works`
/** The same listing in the spelling its Sort & Filter sidebar submits, sorted by title. */
const BY_TITLE = `${ARCHIVE}/works?work_search[sort_column]=title&tag_id=Bees`
/** Where the listing's copy is stored: its source and its address, which leaves the sort out. */
const KEY = 'works-filter:/tags/Bees/works'
const ON = { 'option.searchFilteredListing': true }

const BUTTON = '.AO3E--search-filtered-listing--button'
const RESULTS = '.AO3E--search-view--results > li.blurb'
/** The link a narrow screen opens the sidebar by, which pushes the page aside for it. */
const FILTERS_LINK = 'li:has(> #go_to_filters)'

/** Two pages of twenty: works 101–140, every fourth carrying Draco Malfoy. */
const PER_PAGE = 20
const IDS = Array.from({ length: 2 * PER_PAGE }, (_, i) => String(101 + i))
const DRACO = new Set(IDS.filter(id => Number(id) % 4 === 0))

/** Whether `url` is the listing, in either spelling. */
function isListing(url) {
  return url.pathname === '/tags/Bees/works' || (url.pathname === '/works' && url.searchParams.get('tag_id') === 'Bees')
}

/** The listing's page `url` names: in date order, or, sorted by title, the other way about. */
function listing(url) {
  const ordered = url.searchParams.get('work_search[sort_column]') === 'title' ? [...IDS].reverse() : IDS
  const page = Number(url.searchParams.get('page') ?? 1)
  const ids = ordered.slice((page - 1) * PER_PAGE, page * PER_PAGE)
  const blurbs = ids.map(id => blurb(id, { characters: DRACO.has(id) ? ['Draco Malfoy'] : ['Harry Potter'] }))
  return listingPage(url, { tagId: 'Bees', blurbs, subnav: true, pages: 2, total: IDS.length })
}

/** The requests that walk the listing: every one that names a page. */
const walks = requests => requests.filter(url => new URL(url).searchParams.has('page'))

/**
 * Searching a filtered listing — a tag's, an author's or a collection's works,
 * which AO3's own Sort & Filter sidebar already sorts and filters. The view is
 * offered only when the reader switches it on. Every page of the listing is
 * loaded into it, kept under the listing's address, so the listing in another
 * spelling or another sort opens on the same copy.
 */
describe('search a filtered listing\'s works', { skip }, () => {
  let browser

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /** The works the view is showing, by id, in the order shown. */
  const shownIds = tab => tab.$$eval(`${RESULTS}:not(.AO3E--search-view--hidden)`, els => els.map(li => li.id.replace('work_', '')))

  /** Whether each of these is drawn: `display` isn't `none`. */
  const drawn = (tab, selectors) => tab.evaluate(list => list.map(selector =>
    [...document.querySelectorAll(selector)].every(el => getComputedStyle(el).display !== 'none')), selectors)

  test('switched off, as it starts, a filtered listing is left as AO3 draws it, and nothing more is asked of AO3', async () => {
    const requests = []
    const tab = await openTab(browser, { seed: {}, route: url => (isListing(url) ? listing(url) : null), requests })
    try {
      await visit(tab, LISTING)
      assert.equal(await tab.$(BUTTON), null)
      assert.deepEqual(walks(requests), [])
    }
    finally {
      await tab.close()
    }
  })

  describe('switched on', () => {
    let tab
    const requests = []
    /** While set, the walk of the listing sorted by title waits for it to settle. */
    let held = null

    before(async () => {
      tab = await openTab(browser, {
        seed: ON,
        route: async (url) => {
          if (!isListing(url))
            return null
          if (held && url.searchParams.has('page') && url.searchParams.has('work_search[sort_column]'))
            await held.promise
          return listing(url)
        },
        requests,
      })
    })

    after(async () => {
      held?.resolve()
      await tab?.close()
    })

    test('the offer sits at the end of the listing\'s own row of actions', async () => {
      await visit(tab, LISTING)
      const found = await tab.$eval(BUTTON, (button) => {
        const items = [...button.closest('ul.navigation.actions').children]
        return { text: button.textContent.trim(), after: items[items.indexOf(button.closest('li')) - 1]?.textContent.trim() }
      })
      assert.deepEqual(found, { text: 'Search these works', after: 'Filters' })
      assert.deepEqual(walks(requests), [], 'nothing is asked of AO3 until it is pressed')
    })

    test('pressing it walks every page of the listing, in its order, and keeps the works under the listing\'s address', async () => {
      await tab.click(BUTTON)
      await tab.waitForFunction(selector => document.querySelectorAll(selector).length === 40, {}, RESULTS)
      assert.deepEqual(await shownIds(tab), IDS)
      assert.deepEqual(walks(requests), [`${LISTING}?page=1`, `${LISTING}?page=2`])

      const lists = await stored(tab, 'cache.searchLists')
      assert.deepEqual(Object.keys(lists), [KEY])
      assert.deepEqual(storedListIds(lists[KEY]), IDS)
      // The options page has no `location` and no AO3 document, so everything a
      // refresh needs is written down here.
      assert.deepEqual(lists[KEY].descriptor, { sourceId: 'works-filter', label: 'Tag: Bees', listUrl: LISTING })
    })

    test('the view stands in for the works, their paging and the sidebar that sorts and filters them, under the listing\'s heading', async () => {
      assert.deepEqual(await drawn(tab, ['#main ol.work.index.group:not(.AO3E--search-view--results)', '#main ol.pagination', '#work-filters', FILTERS_LINK, `li:has(> ${BUTTON})`]), [false, false, false, false, false])
      assert.deepEqual(await drawn(tab, ['#main > h2.heading', '#main ul.navigation.actions']), [true, true])
    })

    test('Back to list puts the listing back', async () => {
      await tab.click('.AO3E--search-view--back')
      await tab.waitForFunction(() => document.querySelector('.AO3E--search-host') === null)
      assert.deepEqual(await drawn(tab, ['#main ol.work.index.group', '#main ol.pagination', '#work-filters', FILTERS_LINK, `li:has(> ${BUTTON})`]), [true, true, true, true, true])
    })

    test('the listing in its other spelling and sorted another way opens on the same copy, which the walk then brings up to date', async () => {
      await visit(tab, BY_TITLE)
      requests.length = 0
      held = Promise.withResolvers()
      await tab.click(BUTTON)
      // The walk is held, so the works can only have come from the copy.
      await tab.waitForFunction(selector => document.querySelectorAll(selector).length === 40, {}, RESULTS)
      assert.deepEqual(await shownIds(tab), IDS, 'in the order they were kept in')
      await until('the walk to ask for both pages', () => walks(requests).length === 2)
      assert.deepEqual(walks(requests), [`${BY_TITLE}&page=1`, `${BY_TITLE}&page=2`].map(url => url.replace('[sort_column]', '%5Bsort_column%5D')))

      held.resolve()
      held = null
      await until('the copy to be read again, sorted by title', async () => storedListIds((await stored(tab, 'cache.searchLists'))?.[KEY]).join() === [...IDS].reverse().join())
      const lists = await stored(tab, 'cache.searchLists')
      assert.deepEqual(Object.keys(lists), [KEY], 'one copy, under the listing\'s address')
      assert.equal(lists[KEY].descriptor.listUrl, BY_TITLE)
    })
  })

  test('a listing longer than the works ceiling asks first, and loads only what is agreed to', async () => {
    const requests = []
    const tab = await openTab(browser, { seed: { ...ON, 'option.searchMaxResults': PER_PAGE }, route: url => (isListing(url) ? listing(url) : null), requests })
    try {
      await visit(tab, LISTING)
      await tab.click(BUTTON)
      await tab.waitForSelector('.AO3E--search-host--gate')
      const gate = await tab.$eval('.AO3E--search-host--gate', el => el.textContent.replace(/\s+/g, ' '))
      assert.match(gate, /This list holds 40 works/)
      assert.match(gate, /Load the first 20/)
      assert.deepEqual(walks(requests), [], 'nothing is walked before the reader agrees')

      await tab.click('.AO3E--search-host--gate-cancel')
      await tab.waitForFunction(() => document.querySelector('.AO3E--search-host') === null)
      assert.equal(await stored(tab, 'cache.searchLists'), null, 'nothing kept')
      assert.deepEqual(walks(requests), [])

      await tab.click(BUTTON)
      await tab.waitForSelector('.AO3E--search-host--gate-load')
      await tab.click('.AO3E--search-host--gate-load')
      await tab.waitForFunction(selector => document.querySelectorAll(selector).length === 20, {}, RESULTS)
      assert.deepEqual(walks(requests), [`${LISTING}?page=1`], 'the first page alone')
      assert.deepEqual(storedListIds((await stored(tab, 'cache.searchLists'))[KEY]), IDS.slice(0, PER_PAGE))
    }
    finally {
      await tab.close()
    }
  })

  test('a saved list\'s link puts its view filter back on the listing, and the toolbar reads the view as that list', async () => {
    const list = { id: 'b33s', kind: 'works-filter', url: '/tags/Bees/works', title: 'Bees, no Draco', type: 'tag', entity: 'Bees', filter: { facets: { characters: { ex: ['Draco Malfoy'] } } } }
    const tab = await openTab(browser, { seed: { ...ON, 'option.savedLists': { v: 1, lists: { [list.id]: list } } }, route: url => (isListing(url) ? listing(url) : null) })
    try {
      await visit(tab, `${LISTING}#ao3e-list=${list.id}`)
      await until('the view to be up with the list\'s filter', async () => (await shownIds(tab)).length > 0)
      assert.deepEqual(await shownIds(tab), IDS.filter(id => !DRACO.has(id)))
      await until('the pill to follow the view', async () => await pillText(tab) === 'Refining “Bees, no Draco”')
    }
    finally {
      await tab.close()
    }
  })

  test('switched off, a saved list\'s link still puts its view filter back, so its Update can\'t save the list without it', async () => {
    const list = { id: 'b33s', kind: 'works-filter', url: '/tags/Bees/works', title: 'Bees, no Draco', type: 'tag', entity: 'Bees', filter: { facets: { characters: { ex: ['Draco Malfoy'] } } } }
    const tab = await openTab(browser, { seed: { 'option.savedLists': { v: 1, lists: { [list.id]: list } } }, route: url => (isListing(url) ? listing(url) : null) })
    try {
      await visit(tab, `${LISTING}#ao3e-list=${list.id}`)
      await until('the view to be up with the list\'s filter', async () => (await shownIds(tab)).length > 0)
      assert.deepEqual(await shownIds(tab), IDS.filter(id => !DRACO.has(id)))
      await until('the pill to follow the view', async () => await pillText(tab) === 'Refining “Bees, no Draco”')
      assert.equal(await tab.$(BUTTON), null, 'the listing still offers no view of its own')
    }
    finally {
      await tab.close()
    }
  })
})

describe('the option that offers it', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  test('is a switch under Instant search views, off until it is switched on', async () => {
    const options = await session.open({ hash: '#instant-search-views', viewport: { width: 1280, height: 800 } })
    try {
      const toggle = await options.control(await options.row('instant-search-views-search-a-filtered-listings-works'), 'switch')
      assert.equal(await toggle.evaluate(el => el.getAttribute('aria-checked')), 'false')
      await options.press(toggle)
      await until('the option to be stored', async () => await options.stored('option.searchFilteredListing') === true)
    }
    finally {
      await options.close()
    }
  })
})

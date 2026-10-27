import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { refreshIntervalMs } from '../../src/content_script/searchView/freshness.ts'
import { ensureBuilt, findChrome, storedListIds, storedLists } from './helpers.mjs'
import { startOptions, until } from './optionsPage.mjs'
import { ARCHIVE, blurb, launch, listingPage, openTab, searchPage, stored, tagPage, visit } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const RESULTS = '.AO3E--search-view--results > li.blurb'
const UPDATING = '.AO3E--search-view--updating-on'
const REFRESH = '.AO3E--search-view--refresh'

/** The interval every test that sets one sets: an hour. */
const HOURS = 1
const INTERVAL = refreshIntervalMs(HOURS)
const WITHIN = INTERVAL / 2
const PAST = INTERVAL * 2

/** What the archive lists now, and what the kept copy holds: never the same works, so either can be told on screen. */
const LIVE = ['101', '102', '103', '104']
const KEPT = ['901', '902']

const LISTING = `${ARCHIVE}/tags/Bees/works`
const KEY = 'works-filter:/tags/Bees/works'
const BY_TITLE = `${LISTING}?work_search[sort_column]=title`
/** The same read as {@link BY_TITLE}, in the spelling the listing's sidebar submits. */
const BY_TITLE_SUBMITTED = `${ARCHIVE}/works?work_search[sort_column]=title&tag_id=Bees`
const BOUNDED = `${LISTING}?work_search[date_from]=2026-01-01`
/** The date filter a read of {@link BOUNDED} keeps apart from the listing's address. */
const DATES = 'work_search[date_from]=2026-01-01'

/** Two pages of two works: a walk of the listing is two requests. */
const PER_PAGE = 2
const PAGES = LIVE.length / PER_PAGE

const SERIES = `${ARCHIVE}/series/77`
const RARE_TAG = `${ARCHIVE}/tags/Rare%20Thing`
const SEARCH = `${ARCHIVE}/works/search?work_search%5Bquery%5D=bees`

/** A series' page with the row of actions its search view's button goes in. */
function seriesPage(works) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>A Series</title></head>
<body>
  <div id="header"></div>
  <div id="main" class="series-show region">
    <h2 class="heading">A Series</h2>
    <ul class="navigation actions" role="navigation"><li><span class="current">Series</span></li></ul>
    <ul class="series work index group">${works.join('')}</ul>
  </div>
</body></html>`
}

/** The stand-in archive, answering with {@link LIVE}'s works wherever a view reads. */
function route(url) {
  const page = Number(url.searchParams.get('page') ?? 1)
  if (url.pathname === '/tags/Bees/works' || (url.pathname === '/works' && url.searchParams.get('tag_id') === 'Bees')) {
    const blurbs = LIVE.slice((page - 1) * PER_PAGE, page * PER_PAGE).map(id => blurb(id))
    return listingPage(url, { tagId: 'Bees', blurbs, subnav: true, pages: PAGES, total: LIVE.length })
  }
  if (url.pathname === '/series/77')
    return seriesPage(LIVE.map(id => blurb(id)))
  if (url.pathname === '/tags/Rare%20Thing')
    return tagPage('Rare Thing', 'Additional Tags', LIVE.map(id => blurb(id)))
  if (url.pathname === '/works/search')
    return searchPage(url, LIVE.map(id => blurb(id)), { subnav: true })
  return null
}

/** The requests that read a listing: every one that names a page. */
const walks = requests => requests.filter(url => new URL(url).searchParams.has('page'))

/** A kept copy of {@link KEPT}'s works, read from `listUrl` (between the dates of `dateFilter`, if given) `age` ago, under `key`. */
function keptCopy(key, { sourceId, listUrl, dateFilter, age }) {
  const descriptor = { sourceId, label: 'Kept', listUrl, ...(dateFilter ? { dateFilter } : {}) }
  return storedLists({ [key]: { scrapedAt: Date.now() - age, blurbsHtml: KEPT.map(id => blurb(id)), descriptor } })
}

/**
 * Each search view of the archive's listings opens on the copy it kept, without
 * reading the listing again, while the copy is younger than *Reload listings*
 * (`searchListingsRefreshHours`); older, it reads it again behind the copy. A
 * filtered listing keeps one copy for every sort and date range of it, and opens
 * on it only when it is a read of the same one. Every read is answered by a
 * stand-in archive, which counts them.
 */
describe('search views of listings, and how long they trust their copy', { skip }, () => {
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

  /**
   * Visit `url` with `seed` in storage, press the view's button, and wait for the
   * view to be drawn. Whether it reads the listing behind what it drew is decided
   * as it is drawn, so by then any read has been asked for.
   */
  const openView = async (url, button, seed) => {
    const requests = []
    const tab = await openTab(browser, { seed, route, requests })
    await visit(tab, url)
    await tab.click(button)
    await tab.waitForFunction(selector => document.querySelectorAll(selector).length > 0, {}, RESULTS)
    return { tab, requests }
  }

  /** Whether the view's "updating" indicator is showing: a read is under way. */
  const updating = async tab => (await tab.$(UPDATING)) !== null

  describe('a filtered listing', () => {
    const BUTTON = '.AO3E--search-filtered-listing--button'
    const ON = { 'option.searchFilteredListing': true }
    const kept = (listUrl, age, dateFilter) => keptCopy(KEY, { sourceId: 'works-filter', listUrl, dateFilter, age })
    const interval = { 'option.searchListingsRefreshHours': HOURS }

    test('left as it starts, the listing is read again on every open, however new its copy', async () => {
      const { tab, requests } = await openView(LISTING, BUTTON, { ...ON, ...kept(LISTING, WITHIN) })
      try {
        await until('the listing to be read again', async () => (await shownIds(tab)).join() === LIVE.join())
        assert.equal(walks(requests).length, PAGES)
      }
      finally {
        await tab.close()
      }
    })

    test('within the interval, it opens on its copy, and nothing is asked of AO3', async () => {
      const { tab, requests } = await openView(LISTING, BUTTON, { ...ON, ...interval, ...kept(LISTING, WITHIN) })
      try {
        assert.deepEqual(await shownIds(tab), KEPT)
        assert.equal(await updating(tab), false, 'no read is under way')
        assert.deepEqual(walks(requests), [])
      }
      finally {
        await tab.close()
      }
    })

    test('past the interval, it opens on its copy and reads the listing again behind it', async () => {
      const seed = { ...ON, ...interval, ...kept(LISTING, PAST) }
      const { tab, requests } = await openView(LISTING, BUTTON, seed)
      try {
        await until('the listing to be read again', async () => (await shownIds(tab)).join() === LIVE.join())
        assert.equal(walks(requests).length, PAGES)
        const copy = (await stored(tab, 'cache.searchLists'))[KEY]
        assert.deepEqual(storedListIds(copy), LIVE)
        assert.ok(copy.scrapedAt > seed['cache.searchLists'][KEY].scrapedAt, 'the copy is stamped with the read, so the interval starts again')
      }
      finally {
        await tab.close()
      }
    })

    test('the same read in the listing\'s other spelling opens on the copy', async () => {
      const { tab, requests } = await openView(BY_TITLE_SUBMITTED, BUTTON, { ...ON, ...interval, ...kept(BY_TITLE, WITHIN) })
      try {
        assert.deepEqual(await shownIds(tab), KEPT)
        assert.equal(await updating(tab), false)
        assert.deepEqual(walks(requests), [])
      }
      finally {
        await tab.close()
      }
    })

    test('a copy read in another sort is read again in this one, however new', async () => {
      const { tab, requests } = await openView(BY_TITLE, BUTTON, { ...ON, ...interval, ...kept(LISTING, WITHIN) })
      try {
        await until('the listing to be read again', async () => (await shownIds(tab)).join() === LIVE.join())
        assert.equal(walks(requests).length, PAGES)
        assert.equal((await stored(tab, 'cache.searchLists'))[KEY].descriptor.listUrl, BY_TITLE, 'the copy is now this sort\'s')
      }
      finally {
        await tab.close()
      }
    })

    test('a copy read between dates is read again for the listing without them, however new', async () => {
      const { tab, requests } = await openView(LISTING, BUTTON, { ...ON, ...interval, ...kept(LISTING, WITHIN, DATES) })
      try {
        await until('the listing to be read again', async () => (await shownIds(tab)).join() === LIVE.join())
        assert.equal(walks(requests).length, PAGES)
      }
      finally {
        await tab.close()
      }
    })

    test('a copy of the whole listing is read again for the listing between dates, however new', async () => {
      const { tab, requests } = await openView(BOUNDED, BUTTON, { ...ON, ...interval, ...kept(LISTING, WITHIN) })
      try {
        await until('the listing to be read again', async () => (await shownIds(tab)).join() === LIVE.join())
        assert.equal(walks(requests).length, PAGES)
        assert.ok(walks(requests).every(url => new URL(url).searchParams.get('work_search[date_from]') === '2026-01-01'), 'the page as shown, between its dates')
      }
      finally {
        await tab.close()
      }
    })

    test('a read between dates keeps the whole listing\'s address on the copy, its dates apart, and opens on it the next time', async () => {
      const first = await openView(BOUNDED, BUTTON, { ...ON, ...interval })
      try {
        await until('the listing to be read', async () => (await shownIds(first.tab)).join() === LIVE.join())
        const { descriptor } = (await stored(first.tab, 'cache.searchLists'))[KEY]
        assert.deepEqual({ listUrl: descriptor.listUrl, dateFilter: descriptor.dateFilter }, { listUrl: LISTING, dateFilter: DATES })

        const before = walks(first.requests).length
        await visit(first.tab, BOUNDED)
        await first.tab.click(BUTTON)
        await first.tab.waitForFunction(selector => document.querySelectorAll(selector).length > 0, {}, RESULTS)
        assert.deepEqual(await shownIds(first.tab), LIVE)
        assert.equal(await updating(first.tab), false)
        assert.equal(walks(first.requests).length, before, 'nothing more is asked of AO3')
      }
      finally {
        await first.tab.close()
      }
    })

    test('the Refresh button reads the listing again, whatever the interval says', async () => {
      const { tab, requests } = await openView(LISTING, BUTTON, { ...ON, ...interval, ...kept(LISTING, WITHIN) })
      try {
        assert.deepEqual(walks(requests), [])
        await tab.click(REFRESH)
        await until('the listing to be read again', async () => (await shownIds(tab)).join() === LIVE.join())
        assert.equal(walks(requests).length, PAGES)
      }
      finally {
        await tab.close()
      }
    })
  })

  const kinds = [
    { name: 'a series', url: SERIES, button: '.AO3E--search-series-works--button', on: 'searchSeriesWorks', key: 'series-works:77', sourceId: 'series-works', listUrl: SERIES },
    { name: 'an uncommon tag\'s works', url: RARE_TAG, button: '.AO3E--search-tag-works--link', on: 'searchTagWorks', key: 'tag-works:Rare%20Thing', sourceId: 'tag-works', listUrl: RARE_TAG },
    { name: 'a works search', url: SEARCH, button: '.AO3E--search-text-results--button', on: 'searchTextResults', key: 'text-search:work_search%5Bquery%5D=bees', sourceId: 'text-search', listUrl: `${SEARCH}&page=1` },
  ]

  for (const kind of kinds) {
    describe(kind.name, () => {
      const seed = age => ({
        [`option.${kind.on}`]: true,
        'option.searchListingsRefreshHours': HOURS,
        ...keptCopy(kind.key, { sourceId: kind.sourceId, listUrl: kind.listUrl, age }),
      })

      test('within the interval, it opens on its copy, and nothing is asked of AO3', async () => {
        const { tab, requests } = await openView(kind.url, kind.button, seed(WITHIN))
        try {
          assert.deepEqual(await shownIds(tab), KEPT)
          assert.equal(await updating(tab), false)
          assert.deepEqual(walks(requests), [])
        }
        finally {
          await tab.close()
        }
      })

      test('past the interval, it reads the listing again behind its copy', async () => {
        const { tab, requests } = await openView(kind.url, kind.button, seed(PAST))
        try {
          await until('the listing to be read again', async () => (await shownIds(tab)).join() === LIVE.join())
          assert.equal(walks(requests).length, 1)
          assert.deepEqual(storedListIds((await stored(tab, 'cache.searchLists'))[kind.key]), LIVE)
        }
        finally {
          await tab.close()
        }
      })
    })
  }
})

describe('Reload listings, on the options page', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  test('sits under Reload your own lists, reads Every time until a time is picked, and stores the hours picked', async () => {
    const options = await session.open({ hash: '#instant-search-views', viewport: { width: 1280, height: 800 } })
    try {
      const row = await options.row('instant-search-views-reload-listings')
      const own = await options.row('instant-search-views-reload-your-own-lists')
      assert.equal(await own.evaluate((el, next) => el.nextElementSibling === next, row), true, 'the row straight after Reload your own lists')

      const select = await options.control(row, 'combobox')
      assert.equal(await select.evaluate(el => el.dataset.value), '0', 'every time, until a time is picked')
      await select.evaluate(el => window.scrollBy({ top: el.getBoundingClientRect().top - window.innerHeight / 2, behavior: 'instant' }))
      await select.click()
      await options.page.waitForSelector('[role="option"]')
      await (await options.page.$('[role="option"][data-value="6"]')).click()
      await until('the hours to be stored', async () => await options.stored('option.searchListingsRefreshHours') === 6)
      assert.equal(await options.stored('option.searchProfileListsRefreshHours'), null, 'and only its own option')
    }
    finally {
      await options.close()
    }
  })
})

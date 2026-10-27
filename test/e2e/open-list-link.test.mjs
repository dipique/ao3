import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { ensureBuilt, findChrome, installMock, storedListIds } from './helpers.mjs'
import { until } from './optionsPage.mjs'
import {
  ARCHIVE,
  blurb,
  clickToastLink,
  inject,
  launch,
  listingPage,
  navigateBy,
  openTab,
  refiningMark,
  rerun,
  searchPage,
  seriesPage,
  stored,
  tagPage,
  toastLinks,
  toastNames,
  visit,
} from './trackedPages.mjs'
import { archiveRoutes, CLOCK_BASE, installClock, resetWorkIds, listing as reviewListing, TODAY, trackedOption, works } from './trackedReview.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const RESULTS = '.AO3E--search-view--results > li.blurb'
const HOST = '.AO3E--search-host'

/** Four works, the second and fourth carrying Draco Malfoy. */
const IDS = ['401', '402', '403', '404']
const DRACO = new Set(['402', '404'])
const BLURBS = IDS.map(id => blurb(id, { characters: DRACO.has(id) ? ['Draco Malfoy'] : ['Harry Potter'] }))
const NO_DRACO = { facets: { characters: { ex: ['Draco Malfoy'] } } }

/**
 * One saved list of each kind, each with a view filter, and the page it opens
 * on: the switch for its kind's page button, which every test here leaves off,
 * that button, where its copy is kept, and the archive's page for it.
 */
const KINDS = [
  {
    list: { id: 'f1lt3r', kind: 'works-filter', url: '/tags/Bees/works', title: 'Bees', type: 'tag', entity: 'Bees' },
    option: 'searchFilteredListing',
    button: '.AO3E--search-filtered-listing--button',
    key: 'works-filter:/tags/Bees/works',
    page: url => (url.pathname === '/tags/Bees/works' ? listingPage(url, { tagId: 'Bees', blurbs: BLURBS, subnav: true }) : null),
  },
  {
    list: { id: 's34rch', kind: 'text-search', url: '/works/search?work_search[query]=tea', title: 'Search: tea', type: 'search', entity: 'tea' },
    option: 'searchTextResults',
    button: '.AO3E--search-text-results--button',
    key: 'text-search:work_search%5Bquery%5D=tea',
    page: url => (url.pathname === '/works/search' ? searchPage(url, BLURBS, { subnav: true }) : null),
  },
  {
    list: { id: 't4g', kind: 'tag-works', url: '/tags/marriage%20problems', title: 'Tag: marriage problems', type: 'freeform', entity: 'marriage problems' },
    option: 'searchTagWorks',
    button: '.AO3E--search-tag-works--link',
    key: 'tag-works:marriage%20problems',
    page: url => (url.pathname === '/tags/marriage%20problems' ? tagPage('marriage problems', 'Additional Tags', BLURBS) : null),
  },
  {
    list: { id: 's3r', kind: 'series-works', url: '/series/9991', title: 'Series: Bees', type: 'series', entity: 'Bees' },
    option: 'searchSeriesWorks',
    button: '.AO3E--search-series-works--button',
    key: 'series-works:9991',
    page: url => (url.pathname === '/series/9991' ? seriesPage('Bees', BLURBS) : null),
  },
]

/** Every list of {@link KINDS}, filtered, with every kind's page button switched off. */
const SEED = {
  ...Object.fromEntries(KINDS.map(({ option }) => [`option.${option}`, false])),
  'option.savedLists': { v: 1, lists: Object.fromEntries(KINDS.map(({ list }) => [list.id, { ...list, filter: NO_DRACO }])) },
}

/** Any of {@link KINDS}' pages. */
const route = url => KINDS.map(kind => kind.page(url)).find(Boolean) ?? null

/** The requests that walk a list: every one that names a page. */
const walks = requests => requests.filter(url => new URL(url).searchParams.has('page'))

/** The works the view is showing, by id, in the order shown. */
const shownIds = tab => tab.$$eval(`${RESULTS}:not(.AO3E--search-view--hidden)`, els => els.map(li => li.id.replace('work_', '')))

const viewOpen = async tab => await tab.$(HOST) !== null

/** The page's address as the reader now sees it. */
const address = tab => tab.evaluate(() => location.href)

/**
 * A list's open URL — its own page with `#ao3e-open=<id>` — opens the
 * extension's search view of it whatever its kind's page button says, seeded
 * with its view filter. The first opening walks the listing and keeps the copy;
 * every one after opens on the copy.
 */
describe('a list opened by its URL', { skip }, () => {
  let browser

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  for (const { list, button, key } of KINDS) {
    describe(list.kind, () => {
      let tab
      const requests = []
      /** While set, every walk waits for it to settle. */
      let held = null

      before(async () => {
        tab = await openTab(browser, {
          seed: SEED,
          route: async (url) => {
            if (held && url.searchParams.has('page'))
              await held.promise
            return route(url)
          },
          requests,
        })
      })

      after(async () => {
        held?.resolve()
        await tab?.close()
      })

      test('opens its view with its filter, though the page offers none, and keeps the copy', async () => {
        await visit(tab, `${ARCHIVE}${list.url}#ao3e-open=${list.id}`)
        await until('the view to be up', async () => (await shownIds(tab)).length > 0)
        assert.deepEqual(await shownIds(tab), IDS.filter(id => !DRACO.has(id)), 'the list\'s filter is seeded')
        assert.equal(await tab.$(button), null, 'the page button is still off')

        await until('the copy to be kept', async () => storedListIds((await stored(tab, 'cache.searchLists'))?.[key]).length === IDS.length)
        assert.deepEqual(Object.keys(await stored(tab, 'cache.searchLists')), [key])
        assert.deepEqual(storedListIds((await stored(tab, 'cache.searchLists'))[key]), IDS, 'the whole listing, as the view is a filter over it')
      })

      test('the link is taken off the address, and doesn\'t mark the tab as refining the list', async () => {
        assert.equal(await address(tab), `${ARCHIVE}${list.url}`)
        assert.equal(await refiningMark(tab), null)
      })

      test('opened again, it shows the copy before the listing is read again', async () => {
        // Off the page first: from the page itself, a link that only adds a
        // fragment is a scroll, not a load.
        await tab.goto(`${ARCHIVE}/nowhere`, { waitUntil: 'domcontentloaded' })
        requests.length = 0
        held = Promise.withResolvers()
        await visit(tab, `${ARCHIVE}${list.url}#ao3e-open=${list.id}`)
        // The walk is held, so the works can only have come from the copy.
        await until('the view to be up', async () => (await shownIds(tab)).length > 0)
        assert.deepEqual(await shownIds(tab), IDS.filter(id => !DRACO.has(id)))
        held.resolve()
        held = null
      })
    })
  }

  describe('once a view is up', () => {
    const { list } = KINDS.find(({ list }) => list.kind === 'series-works')
    let tab

    before(async () => {
      tab = await openTab(browser, { seed: SEED, route })
      await visit(tab, `${ARCHIVE}${list.url}#ao3e-open=${list.id}`)
      await until('the view to be up', async () => (await shownIds(tab)).length > 0)
    })

    after(async () => {
      await tab?.close()
    })

    /** Write an option, which re-runs the page, and wait for the run to finish. */
    const writeOption = () => rerun(tab, () => tab.evaluate(async () => {
      const { 'option.searchPerPage': perPage = 50 } = await browser.storage.local.get('option.searchPerPage')
      await browser.storage.local.set({ 'option.searchPerPage': perPage + 1 })
    }))

    test('a re-run puts it back, though its page button is off', async () => {
      await writeOption()
      await until('the view to be back', async () => (await shownIds(tab)).length > 0)
      assert.deepEqual(await shownIds(tab), IDS.filter(id => !DRACO.has(id)), 'as the reader left it')
    })

    test('Back to list closes it, and the link, read once, doesn\'t open it again', async () => {
      await tab.click('.AO3E--search-view--back')
      await until('the view to close', async () => !(await viewOpen(tab)))
      await writeOption()
      assert.equal(await viewOpen(tab), false)
    })
  })

  describe('a link this page can\'t open', () => {
    /** The toast saying the link names no list this page can open. */
    const CANT_OPEN = 'unknown-link'

    test('a list this browser doesn\'t have leaves the page as it is, with a toast and no link', async () => {
      const requests = []
      const kind = KINDS.find(({ list }) => list.kind === 'works-filter')
      const tab = await openTab(browser, { seed: { ...SEED, [`option.${kind.option}`]: true }, route, requests })
      try {
        await visit(tab, `${ARCHIVE}${kind.list.url}#ao3e-open=n0n3`)
        await until('the toast', async () => (await toastNames(tab)).length > 0)
        assert.deepEqual(await toastNames(tab), [CANT_OPEN])
        assert.deepEqual(await toastLinks(tab), [], 'with no list to point to')
        assert.equal(await viewOpen(tab), false)
        assert.ok(await tab.$(kind.button), 'the page as its switch has it')
        assert.deepEqual(walks(requests), [], 'nothing is asked of AO3')
        assert.equal(await address(tab), `${ARCHIVE}${kind.list.url}`)
      }
      finally {
        await tab.close()
      }
    })

    test('so does a list whose own page is another one, and the toast links that page', async () => {
      const requests = []
      const series = KINDS.find(({ list }) => list.kind === 'series-works').list
      const tab = await openTab(browser, { seed: SEED, route, requests })
      try {
        await visit(tab, `${ARCHIVE}/tags/Bees/works#ao3e-open=${series.id}`)
        await until('the toast', async () => (await toastNames(tab)).length > 0)
        assert.deepEqual(await toastNames(tab), [CANT_OPEN])
        assert.deepEqual(await toastLinks(tab), [`${ARCHIVE}${series.url}#ao3e-open=${series.id}`])
        assert.equal(await viewOpen(tab), false)
        assert.deepEqual(walks(requests), [])
        assert.equal(await address(tab), `${ARCHIVE}/tags/Bees/works`, 'nothing navigates by itself')
      }
      finally {
        await tab.close()
      }
    })

    test('a list saved back to another search since its link was kept: the toast links its page now, and following it opens the list there', async () => {
      const { list } = KINDS.find(({ list }) => list.kind === 'works-filter')
      const moved = { ...list, url: '/tags/Bees/works?work_search[complete]=T', filter: NO_DRACO }
      const lists = { ...SEED['option.savedLists'].lists, [moved.id]: moved }
      const tab = await openTab(browser, { seed: { ...SEED, 'option.savedLists': { v: 1, lists } }, route })
      try {
        await visit(tab, `${ARCHIVE}${list.url}#ao3e-open=${moved.id}`)
        await until('the toast', async () => (await toastNames(tab)).length > 0)
        assert.deepEqual(await toastNames(tab), [CANT_OPEN])
        const there = `${ARCHIVE}${moved.url}#ao3e-open=${moved.id}`
        assert.deepEqual(await toastLinks(tab), [there])
        assert.equal(await viewOpen(tab), false)
        assert.equal(await address(tab), `${ARCHIVE}${list.url}`, 'nothing navigates by itself')

        await navigateBy(tab, async () => assert.ok(await clickToastLink(tab, there)))
        await until('the view to be up', async () => (await shownIds(tab)).length > 0)
        assert.deepEqual(await shownIds(tab), IDS.filter(id => !DRACO.has(id)), 'the list\'s filter is seeded')
        assert.equal(await address(tab), `${ARCHIVE}${moved.url}`)
      }
      finally {
        await tab.close()
      }
    })

    /**
     * The account the stand-in's pages are signed in as, which they also write;
     * a list tracked elsewhere, for the review to gather; and work marks on,
     * which say which works are read.
     */
    const READER = {
      'option.user': { userId: 'someone' },
      'option.trackedLists': trackedOption([{ entry: { id: 'w4sp', kind: 'series-works', url: '/series/1234', alias: 'Series: Wasps', tracked: true, since: TODAY } }]),
      'option.workMarks': { enabled: true, marks: { read: { icon: 'read', label: 'Read', color: '#6b7280', hideSearchResult: false, items: '', order: 0 } } },
    }
    const READINGS = `${ARCHIVE}/users/someone/readings`
    const BUILTIN_LINKS = {
      'marked-for-later': { at: '/tags/Bees/works#ao3e-open=marked-for-later', link: `${READINGS}?show=to-read#ao3e-open=marked-for-later` },
      'read-works': { at: '/series/9991#ao3e-open=read-works', link: `${READINGS}#ao3e-open=read-works` },
      'review': { at: '/works/search?work_search[query]=tea#ao3e-tracked', link: `${READINGS}#ao3e-open=tracked-review` },
    }

    /** Visit each of `cases`, a list without a record off its page, and read its toast's links. */
    const builtinToastLinks = async (seed, cases) => {
      const tab = await openTab(browser, { seed: { ...SEED, ...seed }, route })
      try {
        const links = {}
        for (const kind of cases) {
          const { at } = BUILTIN_LINKS[kind]
          await visit(tab, `${ARCHIVE}${at}`)
          await until('the toast', async () => (await toastNames(tab)).length > 0)
          assert.deepEqual(await toastNames(tab), [CANT_OPEN], at)
          assert.equal(await viewOpen(tab), false, at)
          links[kind] = await toastLinks(tab)
        }
        return links
      }
      finally {
        await tab.close()
      }
    }

    test('a list without a record, off its page, links the reader\'s readings, their account known', async () => {
      const links = await builtinToastLinks(READER, Object.keys(BUILTIN_LINKS))
      for (const [kind, { link }] of Object.entries(BUILTIN_LINKS))
        assert.deepEqual(links[kind], [link], kind)
    })

    test('a list without a record whose view would open nothing on the reader\'s readings gets the toast alone', async () => {
      const untracked = await builtinToastLinks({ ...READER, 'option.trackedLists': trackedOption([]) }, ['review', 'marked-for-later'])
      assert.deepEqual(untracked.review, [], 'the review, with no list tracked')
      assert.deepEqual(untracked['marked-for-later'], [BUILTIN_LINKS['marked-for-later'].link], 'which leaves the others\' links be')

      const unmarked = await builtinToastLinks({ ...READER, 'option.workMarks': { ...READER['option.workMarks'], enabled: false } }, ['read-works', 'review'])
      assert.deepEqual(unmarked['read-works'], [], 'Read works, with work marks off')
      assert.deepEqual(unmarked.review, [BUILTIN_LINKS.review.link], 'which leaves the others\' links be')
    })

    test('a list without a record, off its page, with the reader\'s account not known, gets the toast alone', async () => {
      const tab = await openTab(browser, { seed: SEED, route })
      try {
        await visit(tab, `${ARCHIVE}/tags/Bees/works#ao3e-open=marked-for-later`)
        await until('the toast', async () => (await toastNames(tab)).length > 0)
        assert.deepEqual(await toastNames(tab), [CANT_OPEN])
        assert.deepEqual(await toastLinks(tab), [], 'with no page to point to')
      }
      finally {
        await tab.close()
      }
    })
  })
})

/**
 * The lists with no record of their own open on the reader's readings: Marked
 * for Later on its own page, the works they have read and the review on their
 * History. Each page needs the reader signed in, as it always has.
 */
describe('a list without a record, opened by its URL', { skip }, () => {
  let browser

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  const HISTORY = `${ARCHIVE}/users/me/readings`
  const TO_READ = `${HISTORY}?show=to-read`

  /** A readings work's blurb, as the readings pages draw them. */
  const readingBlurb = id => `
    <li class="reading work blurb group" id="work_${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">Work ${id}</a>
          by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4>
        <h5 class="fandoms heading"><a class="tag" href="/tags/F/works">A Fandom</a></h5>
      </div>
      <dl class="stats"><dt class="words">Words:</dt><dd class="words">1,000</dd>
        <dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd></dl>
    </li>`

  /** Either readings page, signed in as `me`, listing works 1 to 3. */
  const readings = (toRead) => {
    const subnav = toRead
      ? '<li><a href="/users/me/readings">History</a></li><li><span class="current">Marked for Later</span></li>'
      : '<li><span class="current">History</span></li><li><a href="/users/me/readings?show=to-read">Marked for Later</a></li>'
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>Readings</title></head>
<body class="logged-in">
  <div id="header"><a href="/users/me/preferences">Preferences</a></div>
  <div id="main" class="readings-index dashboard region">
    <h2 class="heading">${toRead ? 'Marked for Later' : 'History'}</h2>
    <ul class="navigation actions" role="navigation">${subnav}</ul>
    <ol class="reading work index group">${['1', '2', '3'].map(readingBlurb).join('')}</ol>
  </div>
</body></html>`
  }
  const readingsRoute = url => (url.pathname === '/users/me/readings' ? readings(url.searchParams.get('show') === 'to-read') : null)

  test('Marked for Later opens on its own page though its view is switched off, and keeps the copy', async () => {
    const tab = await openTab(browser, { seed: { 'option.searchMarkedForLater': false }, route: readingsRoute })
    try {
      await visit(tab, `${TO_READ}#ao3e-open=marked-for-later`)
      await until('the view to be up', async () => (await shownIds(tab)).length > 0)
      assert.deepEqual(await shownIds(tab), ['1', '2', '3'])
      await until('the copy to be kept', async () => storedListIds((await stored(tab, 'cache.searchLists'))?.['marked-for-later:me']).length === 3)
      assert.equal(await address(tab), TO_READ)
    }
    finally {
      await tab.close()
    }
  })

  test('the works read open on the reader\'s History though their button is switched off, and keep the copy', async () => {
    const tab = await openTab(browser, {
      seed: {
        'option.searchReadWorks': false,
        'option.workMarks': {
          enabled: true,
          // Works 1 and 3, packed.
          marks: { read: { icon: 'read', label: 'Read', color: '#6b7280', hideSearchResult: false, items: '1,2', order: 0 } },
        },
      },
      route: readingsRoute,
    })
    try {
      await visit(tab, `${HISTORY}#ao3e-open=read-works`)
      await until('the view to be up', async () => (await shownIds(tab)).length > 0)
      assert.deepEqual(await shownIds(tab), ['1', '3'])
      assert.equal(await tab.$('.AO3E--search-read-works--button'), null, 'the page button is still off')
      await until('the copy to be kept', async () => storedListIds((await stored(tab, 'cache.searchLists'))?.['read-works:me']).length === 2)
      assert.equal(await address(tab), HISTORY)
    }
    finally {
      await tab.close()
    }
  })

  describe('the review', () => {
    resetWorkIds(9100)
    const solo = reviewListing('solo', works([[TODAY - 1, 3]]), { entry: { alias: 'Solo', since: TODAY - 1 } })
    const ids = solo.works.map(work => work.id)

    /** A tab on the reader's History at `hash`, the tracked list's archive behind it. */
    const openReview = async (seed, hash) => {
      const tab = await browser.newPage()
      await tab.setViewport({ width: 1280, height: 900 })
      await tab.setRequestInterception(true)
      tab.on('request', archiveRoutes({ fixtures: [solo] }))
      await tab.evaluateOnNewDocument(installClock, CLOCK_BASE)
      await tab.evaluateOnNewDocument(installMock, {
        'cache.markedForLater': { userId: 'me', updatedAt: CLOCK_BASE, ids: '' },
        ...seed,
      })
      await tab.goto(`${HISTORY}${hash}`, { waitUntil: 'domcontentloaded' })
      await inject(tab)
      return tab
    }

    const reviewUp = tab => until('the review to show its works', async () => JSON.stringify((await shownIds(tab)).sort()) === JSON.stringify([...ids].sort()))

    test('opens on the reader\'s History with Tracked lists switched off, and keeps the window', async () => {
      const tab = await openReview({ 'option.trackedLists': trackedOption([solo], { enabled: false }) }, '#ao3e-open=tracked-review')
      try {
        await reviewUp(tab)
        assert.ok(await tab.$(`${HOST}.AO3E--tracked-review`), 'the review is up')
        assert.equal(await tab.$('.AO3E--tracked-review--button'), null, 'with no entry point')
        await until('the window to be kept', async () => (await tab.evaluate(async () =>
          (await browser.storage.local.get('cache.searchLists'))['cache.searchLists']?.['tracked-review'])) !== undefined)
        assert.equal(await address(tab), HISTORY)
      }
      finally {
        await tab.close()
      }
    })

    test('its own link, #ao3e-tracked, still opens it', async () => {
      const tab = await openReview({ 'option.trackedLists': trackedOption([solo]) }, '#ao3e-tracked')
      try {
        await reviewUp(tab)
        assert.ok(await tab.$(`${HOST}.AO3E--tracked-review`))
        assert.equal(await address(tab), HISTORY)
      }
      finally {
        await tab.close()
      }
    })
  })
})

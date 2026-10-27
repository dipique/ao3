import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { figures } from '../facts.mjs'
import { ensureBuilt, findChrome, installMock, storedListIds } from './helpers.mjs'
import { until } from './optionsPage.mjs'
import { ARCHIVE, blurb, inject, launch, listingPage, openTab, rerun, stored, visit } from './trackedPages.mjs'
import { archiveRoutes, CLOCK_BASE, installClock, resetWorkIds, listing as reviewListing, TODAY, trackedOption, works } from './trackedReview.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const LISTING = `${ARCHIVE}/tags/Bees/works`
const KEY = 'works-filter:/tags/Bees/works'
const ON = { 'option.searchFilteredListing': true }

const BUTTON = '.AO3E--search-filtered-listing--button'
const HOST = '.AO3E--search-host'
const PROGRESS = '.AO3E--search-host--progress-label'
const GATE_LOAD = '.AO3E--search-host--gate-load'
const RESULTS = '.AO3E--search-view--results > li.blurb'
/** What the view stands in for while it, or its walk, is up. */
const NATIVE = ['#main ol.work.index.group:not(.AO3E--search-view--results)', '#main ol.pagination', '#work-filters']

/** Two pages of twenty: works 101–140, every fourth carrying Draco Malfoy. */
const PER_PAGE = 20
const IDS = Array.from({ length: 2 * PER_PAGE }, (_, i) => String(101 + i))
const DRACO = new Set(IDS.filter(id => Number(id) % 4 === 0))
const NO_DRACO = { facets: { characters: { ex: ['Draco Malfoy'] } } }

/** The works on the page of a two-page listing that `url` names. */
function pageIds(url) {
  const page = Number(url.searchParams.get('page') ?? 1)
  return IDS.slice((page - 1) * PER_PAGE, page * PER_PAGE)
}

/** The tag's works listing, or null for any other address. */
function listing(url) {
  if (url.pathname !== '/tags/Bees/works')
    return null
  const blurbs = pageIds(url).map(id => blurb(id, { characters: DRACO.has(id) ? ['Draco Malfoy'] : ['Harry Potter'] }))
  return listingPage(url, { tagId: 'Bees', blurbs, subnav: true, pages: 2, total: IDS.length })
}

const TO_READ = `${ARCHIVE}/users/me/readings?show=to-read`

/** The reader's own Marked for Later, signed in as `me`, or null for any other address. */
function toRead(url) {
  if (url.pathname !== '/users/me/readings' || url.searchParams.get('show') !== 'to-read')
    return null
  const page = Number(url.searchParams.get('page') ?? 1)
  const pagination = `<ol class="pagination actions" role="navigation">${[1, 2].map(n => (n === page ? `<li><span class="current">${n}</span></li>` : `<li><a href="?show=to-read&amp;page=${n}">${n}</a></li>`)).join('')}</ol>`
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Marked for Later</title></head>
<body class="logged-in">
  <div id="header"><a href="/users/me/preferences">Preferences</a></div>
  <div id="main" class="readings-index dashboard region">
    <h2 class="heading">Marked for Later</h2>
    <ul class="navigation actions" role="navigation">
      <li><a href="/users/me/readings">History</a></li>
      <li><span class="current">Marked for Later</span></li>
    </ul>
    ${pagination}
    <ol class="reading work index group">${pageIds(url).map(id => blurb(id)).join('')}</ol>
    ${pagination}
  </div>
</body></html>`
}

/** The requests that walk a list: every one that names a page. */
const walks = requests => requests.filter(url => new URL(url).searchParams.has('page'))
const EVERY_PAGE_ONCE = [`${LISTING}?page=1`, `${LISTING}?page=2`]

/** The works the view is showing, by id, in the order shown. */
const shownIds = tab => tab.$$eval(`${RESULTS}:not(.AO3E--search-view--hidden)`, els => els.map(li => li.id.replace('work_', '')))

/** Whether each of these is drawn: every element it matches has a `display` other than `none`. */
const drawn = (tab, selectors) => tab.evaluate(list => list.map(selector =>
  [...document.querySelectorAll(selector)].every(el => getComputedStyle(el).display !== 'none')), selectors)

/** Whether each of these is hidden: every element it matches has `display: none`. */
const hidden = (tab, selectors) => tab.evaluate(list => list.map(selector =>
  [...document.querySelectorAll(selector)].every(el => getComputedStyle(el).display === 'none')), selectors)

/** The pages `selector` says are loaded, and in all, as `done/total`; null while it is off. */
const pagesIn = async (tab, selector) => {
  const text = await tab.$eval(selector, el => el.textContent).catch(() => null)
  return text === null ? null : figures(text).join('/')
}

/** What the progress panel says of the walk before the view is up. */
const progressText = tab => pagesIn(tab, PROGRESS)

/** What the view's note says of the walk once the view is up with its first page. */
const walkNote = tab => pagesIn(tab, '.AO3E--search-view--updating-on .AO3E--search-view--updating-text')

/** Write an option, which re-runs the page, and wait for the run to finish. */
const writeOption = (tab, name, value) => rerun(tab, () => tab.evaluate((key, next) => window.browser.storage.local.set({ [key]: next }), `option.${name}`, value))

/**
 * A listing walked for the first time — the walk that keeps its copy — while an
 * options change re-runs the page under it. Every options change does, from any
 * tab, and a re-run takes everything the extension drew off the page; the walk
 * mustn't go with it, nor be started again.
 */
describe('a search view\'s first walk across a re-run', { skip }, () => {
  let browser

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /**
   * A tab on the stand-in archive, its pages drawn by `pages`, with the second
   * page of any list held back until `release()`: a walk of it stands half
   * done, its first page in hand.
   */
  async function heldListing(seed, pages = listing, { holdFirst = false } = {}) {
    const requests = []
    const held = Promise.withResolvers()
    const first = Promise.withResolvers()
    if (!holdFirst)
      first.resolve()
    const failed = []
    const tab = await openTab(browser, {
      seed,
      route: async (url) => {
        if (url.searchParams.get('page') === '1')
          await first.promise
        if (url.searchParams.get('page') === '2')
          await held.promise
        return pages(url)
      },
      requests,
    })
    tab.on('requestfailed', req => failed.push(req.url()))
    return { tab, requests, failed, release: () => held.resolve(), releaseFirst: () => first.resolve() }
  }

  /**
   * Wait for a walk to be half done: page 1 in, page 2 asked for and held. The
   * view is up by then, showing page 1, with the walk's progress on its note.
   */
  const halfWalked = async ({ tab, requests }) => {
    await until('the walk to ask for both pages', () => walks(requests).length === 2)
    await until('the first page to be on screen', async () => await walkNote(tab) === '1/2')
  }

  test('pressed, its first page is up while it walks on; the re-run puts it back still walking, then the rest, drawn as the options now say, and no page is fetched twice', async () => {
    const page = await heldListing(ON)
    const { tab, requests } = page
    try {
      await visit(tab, LISTING)
      await tab.click(BUTTON)
      await halfWalked(page)
      assert.deepEqual(await shownIds(tab), IDS.slice(0, PER_PAGE), 'the first page, before the second is in')
      assert.equal(await stored(tab, 'cache.searchLists'), null, 'and nothing kept yet')

      await writeOption(tab, 'searchPerPage', 25)
      await until('the view to be back', async () => await walkNote(tab) !== null)
      assert.equal(await walkNote(tab), '1/2', 'the same walk, where it had got to')
      assert.deepEqual(await shownIds(tab), IDS.slice(0, PER_PAGE))
      assert.deepEqual(await hidden(tab, NATIVE), [true, true, true], 'the listing stays out of the way')

      page.release()
      await until('the walk to end', async () => await walkNote(tab) === null)
      assert.deepEqual(await shownIds(tab), IDS.slice(0, 25), 'a page as long as the options now ask')
      assert.equal(await tab.$(PROGRESS), null)
      assert.deepEqual(walks(requests), EVERY_PAGE_ONCE)
      assert.deepEqual(storedListIds((await stored(tab, 'cache.searchLists'))?.[KEY]), IDS)
    }
    finally {
      page.release()
      await tab.close()
    }
  })

  test('a re-run before its first page is in carries the walk on, and the view goes up on that page all the same', async () => {
    const page = await heldListing(ON, listing, { holdFirst: true })
    const { tab, requests } = page
    try {
      await visit(tab, LISTING)
      await tab.click(BUTTON)
      await until('the walk to ask for both pages', () => walks(requests).length === 2)
      await until('the progress to be up', async () => await progressText(tab) === '0/2')

      await writeOption(tab, 'searchPerPage', 25)
      await until('the progress to be back', async () => await progressText(tab) === '0/2')

      page.releaseFirst()
      await until('the first page to be on screen', async () => await walkNote(tab) === '1/2')
      assert.deepEqual(await shownIds(tab), IDS.slice(0, PER_PAGE))
      assert.equal(await tab.$(PROGRESS), null)

      page.release()
      await until('the walk to end', async () => await walkNote(tab) === null)
      assert.deepEqual(await shownIds(tab), IDS.slice(0, 25))
      assert.deepEqual(walks(requests), EVERY_PAGE_ONCE)
      assert.deepEqual(storedListIds((await stored(tab, 'cache.searchLists'))?.[KEY]), IDS)
    }
    finally {
      page.releaseFirst()
      page.release()
      await tab.close()
    }
  })

  test('switched off under it, the walk stops and the listing comes back as AO3 drew it', async () => {
    const page = await heldListing(ON)
    const { tab, requests, failed } = page
    try {
      await visit(tab, LISTING)
      await tab.click(BUTTON)
      await halfWalked(page)

      await writeOption(tab, 'searchFilteredListing', false)
      await until('the listing to be back', async () => (await drawn(tab, NATIVE)).every(Boolean))
      assert.equal(await tab.$(HOST), null, 'no progress, and no view')
      assert.equal(await tab.$(BUTTON), null, 'nor any offer of one')
      await until('the held page to be given up on', () => failed.includes(`${LISTING}?page=2`))
      assert.deepEqual(walks(requests), EVERY_PAGE_ONCE)
      assert.equal(await stored(tab, 'cache.searchLists'), null, 'nothing kept')
    }
    finally {
      page.release()
      await tab.close()
    }
  })

  test('waiting at the limit gate, it asks again after the re-run, and loads only what is agreed to', async () => {
    const page = await heldListing({ ...ON, 'option.searchMaxResults': PER_PAGE })
    const { tab, requests } = page
    try {
      await visit(tab, LISTING)
      await tab.click(BUTTON)
      await tab.waitForSelector(GATE_LOAD)

      await writeOption(tab, 'searchPerPage', 51)
      await until('the gate to be back', async () => await tab.$(GATE_LOAD) !== null)
      assert.deepEqual(walks(requests), [], 'nothing is walked before the reader agrees')

      await tab.click(GATE_LOAD)
      await until('the view to be up', async () => (await shownIds(tab)).length > 0)
      assert.deepEqual(await shownIds(tab), IDS.slice(0, PER_PAGE))
      assert.deepEqual(walks(requests), [`${LISTING}?page=1`], 'the first page alone')
    }
    finally {
      page.release()
      await tab.close()
    }
  })

  describe('opened by its URL', () => {
    const list = { id: 'b33s', kind: 'works-filter', url: '/tags/Bees/works', title: 'Bees, no Draco', type: 'tag', entity: 'Bees', filter: NO_DRACO }
    const SEED = { 'option.savedLists': { v: 1, lists: { [list.id]: list } } }
    let page

    before(async () => {
      page = await heldListing(SEED)
    })

    after(async () => {
      page?.release()
      await page?.tab.close()
    })

    test('the walk is carried through the re-run rather than started again, and opens on the list\'s filter', async () => {
      const { tab, requests } = page
      await visit(tab, `${LISTING}#ao3e-open=${list.id}`)
      await halfWalked(page)

      await writeOption(tab, 'searchPerPage', 51)
      await until('the view to be back', async () => await walkNote(tab) !== null)
      assert.equal(await walkNote(tab), '1/2')

      page.release()
      await until('the walk to end', async () => await walkNote(tab) === null)
      assert.deepEqual(await shownIds(tab), IDS.filter(id => !DRACO.has(id)), 'the list\'s filter is seeded')
      assert.deepEqual(walks(requests), EVERY_PAGE_ONCE)
      assert.deepEqual(storedListIds((await stored(tab, 'cache.searchLists'))?.[KEY]), IDS)
    })

    test('Back to list closes it, and the link, answered, doesn\'t open it again', async () => {
      const { tab } = page
      await tab.click('.AO3E--search-view--back')
      await until('the view to close', async () => await tab.$(HOST) === null)
      await writeOption(tab, 'searchPerPage', 52)
      assert.equal(await tab.$(HOST), null)
      assert.deepEqual(await drawn(tab, NATIVE), [true, true, true])
    })
  })

  test('Marked for Later, which opens by itself on every run, carries its first walk too', async () => {
    const page = await heldListing({ 'option.searchMarkedForLater': true }, toRead)
    const { tab, requests } = page
    try {
      await visit(tab, TO_READ)
      await halfWalked(page)

      await writeOption(tab, 'searchPerPage', 51)
      await until('the view to be back', async () => await walkNote(tab) !== null)
      assert.equal(await walkNote(tab), '1/2')

      page.release()
      await until('the walk to end', async () => await walkNote(tab) === null)
      assert.deepEqual(await shownIds(tab), IDS)
      assert.deepEqual(walks(requests), [`${TO_READ}&page=1`, `${TO_READ}&page=2`])
    }
    finally {
      page.release()
      await tab.close()
    }
  })

  describe('the tracked review, which reads its lists its own way', () => {
    resetWorkIds(9300)
    const solo = reviewListing('solo', works([[TODAY - 1, 3]]), { entry: { alias: 'Solo', since: TODAY - 1 } })
    const ids = solo.works.map(work => work.id).sort()

    test('goes on reading its list through a re-run, and asks for no page twice', async () => {
      const routes = archiveRoutes({ fixtures: [solo] })
      const held = Promise.withResolvers()
      /** What the review asked of the tracked list. */
      const asked = []
      const tab = await browser.newPage()
      try {
        await tab.setViewport({ width: 1280, height: 900 })
        await tab.setRequestInterception(true)
        tab.on('request', (req) => {
          const url = new URL(req.url())
          if (url.origin !== ARCHIVE || url.pathname === '/users/me/readings')
            return routes(req)
          asked.push(url.pathname + url.search)
          void held.promise.then(() => routes(req))
        })
        await tab.evaluateOnNewDocument(installClock, CLOCK_BASE)
        await tab.evaluateOnNewDocument(installMock, {
          'cache.markedForLater': { userId: 'me', updatedAt: CLOCK_BASE, ids: '' },
          'option.trackedLists': trackedOption([solo]),
        })
        await tab.goto(`${ARCHIVE}/users/me/readings#ao3e-open=tracked-review`, { waitUntil: 'domcontentloaded' })
        await inject(tab)
        await until('the list to be asked for', () => asked.length > 0)
        // The review is up, empty, while its list is read in the background.
        await until('the review to be up', async () => !!await tab.$('.AO3E--search-host.AO3E--tracked-review'))

        await writeOption(tab, 'searchPerPage', 51)
        await until('the review to be back', async () => !!await tab.$('.AO3E--search-host.AO3E--tracked-review .AO3E--tracked-review--bar'))

        held.resolve()
        await until('the review to show its works', async () => JSON.stringify((await shownIds(tab)).sort()) === JSON.stringify(ids))
        const reads = asked.filter(path => path.startsWith('/tags/'))
        assert.equal(new Set(reads).size, reads.length, `no request made twice: ${reads.join(', ')}`)
      }
      finally {
        held.resolve()
        await tab.close()
      }
    })
  })
})

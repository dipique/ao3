import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { mentions } from '../facts.mjs'
import { ensureBuilt, findChrome, serveDist } from './helpers.mjs'
import { openOptions, until } from './optionsPage.mjs'
import {
  ARCHIVE,
  clickBoxAction,
  diffLines,
  launch,
  openBox,
  persistentMock,
  pillRow,
  pillText,
  refiningMark,
  rerun,
  settled,
  storedOption,
  tagPage,
  TITLE_INPUT,
  TRACK_BOX,
  visit,
} from './trackedPages.mjs'
import { archiveRoutes, blurbHtml, CLOCK_BASE, installClock, resetWorkIds, TODAY, works } from './trackedReview.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const TAG = 'marriage problems'
const TAG_PATH = '/tags/marriage%20problems'
const TAG_URL = `${ARCHIVE}${TAG_PATH}`
const REVIEW_URL = `${ARCHIVE}/users/me/readings#ao3e-tracked`
/** The title a new list of this tag gets: its category, read off the tag's own page, then its name. */
const TITLE = 'Tag: marriage problems'

resetWorkIds(7000)
/**
 * The tag's works, all posted today — which is the first day a list tracked
 * today reviews. Two of them carry Draco Malfoy, and two Ron Weasley (one work
 * both), so each exclusion the tests make takes works out of what is left.
 */
const TAG_WORKS = works([
  [TODAY, 1, 0, { characters: ['Draco Malfoy'] }],
  [TODAY, 1, 0, { characters: ['Harry Potter'] }],
  [TODAY, 1, 0, { characters: ['Ron Weasley'] }],
  [TODAY, 1, 0, { characters: ['Draco Malfoy', 'Ron Weasley'] }],
  [TODAY, 2, 0, { characters: ['Hermione Granger'] }],
])
const idsWithout = (...names) => TAG_WORKS.filter(work => !work.characters.some(name => names.includes(name))).map(work => work.id)

/** The tag read through a search by its name, as the review and the creation check both read it. */
const TAG_SEARCH = { key: TAG, layout: 'search', works: TAG_WORKS }

const SEED = {
  'option.trackedLists': { enabled: true, target: 40, reviewedThrough: 0, lists: [] },
  // An index that has been filled, so the review has nothing to warn about.
  'cache.markedForLater': { userId: 'me', updatedAt: CLOCK_BASE, ids: '' },
}

/**
 * A custom search's own filters, tracked with the list: an uncommon tag's page,
 * whose works the reader narrows in the in-memory search view rather than in
 * any address.
 *
 * - Tracking from the filtered view stores the view's filter, and the pill
 *   follows the view as its filter changes.
 * - The options page's link puts the filter back on screen — and survives the
 *   re-run that the first visit to a list's page can cause by filling in what
 *   the list is, even when that re-run lands while the view is still loading.
 * - It does so once, on arrival: never again over what the reader does after.
 * - Refining the filter and updating the list stores the new one.
 * - The review leaves out the works the filter rejects, and asks the archive to
 *   leave them out too.
 *
 * The tab navigates for real, so the extension's storage is kept in the page's
 * `localStorage` ({@link persistentMock}) and the content script is injected
 * again on every load ({@link visit}).
 */
describe('tracked lists: a custom search view’s own filters', { skip }, () => {
  let server
  let browser
  let tab
  /** Every archive URL the tab asked for. */
  const fetched = []
  /**
   * While set, the tag page's scrapes (`?page=`) go unanswered until it
   * settles, so that a re-run is sure to land while the view is still loading.
   */
  let holdScrape = null
  let link = null

  /** The archive, as far as this tab can see it: the tag's page, and every search and readings page the review asks for. */
  function handler() {
    const archive = archiveRoutes({ fixtures: [TAG_SEARCH], user: 'me', fetched })
    return (req) => {
      const url = new URL(req.url())
      if (url.origin !== ARCHIVE || url.pathname !== TAG_PATH)
        return archive(req)
      fetched.push(url.pathname + url.search)
      const body = tagPage(TAG, 'Additional Tags', TAG_WORKS.map(work => blurbHtml(work)))
      const respond = () => req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body }).catch(() => {})
      // The scrape is the view's own request; the page load is the reader's.
      if (url.searchParams.has('page') && holdScrape)
        return void holdScrape.promise.then(respond)
      void respond()
    }
  }

  before(async () => {
    ensureBuilt()
    server = await serveDist()
    browser = await launch(chromePath)
    tab = await browser.newPage()
    await tab.setViewport({ width: 1280, height: 900 })
    await tab.setRequestInterception(true)
    tab.on('request', handler())
    await tab.evaluateOnNewDocument(installClock, CLOCK_BASE)
    await tab.evaluateOnNewDocument(persistentMock(SEED))
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
    await server?.close()
  })

  const lists = async () => (await storedOption(tab))?.lists ?? []
  /** The pill is in `row`, for the one list, and names it. */
  const pillIs = async (row) => {
    const [list] = await lists()
    assert.equal(await pillRow(tab), row.replace('<id>', list.id))
    assert.ok(mentions(await pillText(tab), TITLE), `the pill should name ${TITLE}`)
  }
  /** The one line of the box's diff, which names each of `names`. */
  const diffNames = async (...names) => {
    const [line, ...more] = await diffLines(tab)
    assert.deepEqual(more, [])
    for (const name of names)
      assert.ok(mentions(line, name), `${line} should name ${name}`)
    return line
  }

  /** Whether the tracking pill's box is showing. */
  const boxOpen = () => tab.$eval(TRACK_BOX, box => !box.hidden)

  /** Whether the search view is up on the page. */
  const viewOpen = () => tab.evaluate(() => document.querySelector('.AO3E--search-view') !== null)

  /** The works the view is showing, by id. */
  const shownIds = () => tab.evaluate(() => [...document.querySelectorAll('.AO3E--search-view--results > li.blurb:not(.AO3E--search-view--hidden)')]
    .map(li => li.id.replace('work_', '')))

  /** Whether a facet value is excluded in the view, as its row's toggle says. */
  const excluded = value => tab.evaluate((want) => {
    const row = [...document.querySelectorAll('.AO3E--search-view--row')]
      .find(el => el.querySelector('.AO3E--search-view--row-name')?.textContent?.trim() === want)
    return row?.querySelector('.AO3E--search-view--toggle-exclude')?.getAttribute('aria-pressed') === 'true'
  }, value)

  /**
   * Click a facet value's exclude toggle — to exclude it, or to lift the
   * exclusion. The view redraws as it is clicked, and the toolbar follows it on
   * the next frame, so this waits for that frame.
   */
  const toggleExclude = async (value) => {
    await tab.evaluate(async (want) => {
      const row = [...document.querySelectorAll('.AO3E--search-view--row')]
        .find(el => el.querySelector('.AO3E--search-view--row-name')?.textContent?.trim() === want)
      row.querySelector('.AO3E--search-view--toggle-exclude').click()
      await new Promise(resolve => requestAnimationFrame(() => resolve()))
    }, value)
  }

  /** Wait for the view to be up with its works drawn. */
  const viewDrawn = () => tab.waitForSelector('.AO3E--search-view--row')

  test('tracking from a filtered view stores the view’s filter', async () => {
    await visit(tab, TAG_URL)
    await tab.click('.AO3E--search-tag-works--link')
    await viewDrawn()
    assert.equal(await viewOpen(), true)
    assert.equal(await pillRow(tab), 'new')

    await toggleExclude('Draco Malfoy')
    assert.deepEqual(await shownIds(), idsWithout('Draco Malfoy'))

    await openBox(tab)
    await rerun(tab, () => clickBoxAction(tab, 'track'))

    const [list] = await lists()
    assert.equal(list.kind, 'tag-works')
    assert.equal(list.url, TAG_PATH)
    assert.equal(list.alias, TITLE)
    assert.equal(list.scan, undefined, 'a search by the tag’s name finds the same works, so the list is read by date')
    assert.deepEqual(list.filter, { facets: { characters: { ex: ['Draco Malfoy'] } } })
  })

  test('the write re-runs the page, and the view comes back as the list it now is', async () => {
    await viewDrawn()
    assert.equal(await viewOpen(), true)
    assert.equal(await excluded('Draco Malfoy'), true)
    await pillIs('exact:<id>')
  })

  test('the pill follows the view’s filter as it changes', async () => {
    // The same tag unfiltered is the list's root but not the list.
    await toggleExclude('Draco Malfoy')
    assert.equal(await pillRow(tab), `same-root:${(await lists())[0].id}`)
    await toggleExclude('Draco Malfoy')
    await pillIs('exact:<id>')
  })

  test('the options row links to the list’s own page', async () => {
    const [list] = await lists()
    const options = await openOptions(browser, server, { seed: { 'option.trackedLists': await storedOption(tab) }, hash: '#saved-lists' })
    link = await (await options.action(await options.savedList(list.id), 'view-edit')).evaluate(a => a.href)
    await options.close()
    assert.equal(link, `${TAG_URL}#ao3e-list=${list.id}`)
  })

  test('the link reopens the view with the list’s filter, through the re-run its first visit causes', async () => {
    const [list] = await lists()
    // Off the tag's page, so that nothing runs over the store as it is set up:
    // the list as one made before its category was recorded — which the first
    // visit fills in, re-running the page — and no stored copy of the view, so
    // that it has to be read again, slowly, and the re-run lands mid-load.
    await tab.goto(`${ARCHIVE}/nowhere`, { waitUntil: 'domcontentloaded' })
    const { type, entity, ...bare } = list
    assert.equal(type, 'freeform')
    assert.equal(entity, TAG)
    await tab.evaluate(async (entry) => {
      const option = (await browser.storage.local.get('option.trackedLists'))['option.trackedLists']
      await browser.storage.local.set({ 'option.trackedLists': { ...option, lists: [entry] }, 'cache.searchLists': {} })
    }, bare)

    fetched.length = 0
    const scrapes = () => fetched.filter(url => url.startsWith(`${TAG_PATH}?page=`))
    holdScrape = Promise.withResolvers()
    try {
      await visit(tab, link)
      await until('the view to start loading', () => scrapes().length > 0)
      await until('the first visit to fill the category back in', async () => (await lists())[0]?.type === 'freeform')
      await settled(tab, 1)
      assert.equal(await viewOpen(), false, 'the re-run it caused landed while the view was still loading')
      holdScrape.resolve()
      await until('the view to be back with the list’s filter', async () => await excluded('Draco Malfoy')
        && (await refiningMark(tab))?.restore === false)
    }
    finally {
      holdScrape.resolve()
      holdScrape = null
    }

    assert.equal(scrapes().length, 1, 'the re-run carried the loading view on rather than starting it again')

    assert.equal(await viewOpen(), true, 'the view is up, without a click')
    assert.equal(await excluded('Draco Malfoy'), true)
    assert.deepEqual(await shownIds(), idsWithout('Draco Malfoy'))
    assert.deepEqual(await refiningMark(tab), { id: list.id, restore: false }, 'put back, and not to be put back again')
    await pillIs('refining:<id>:same')
  })

  test('a second exclusion and Update change the stored filter', async () => {
    const [before] = await lists()
    // The box is open while the reader works in the view (whose toggles are
    // clicked here without the pointer, so the toolbar stays open).
    await openBox(tab)
    await pillIs('refining:<id>:same')
    await toggleExclude('Ron Weasley')
    await pillIs('refining:<id>:changed')
    assert.equal(await boxOpen(), true, 'and the box it grew stays open')
    const ron = await diffNames('Ron Weasley')

    // A title typed into the open box, then another change in the view: the
    // same pill, so the box is redrawn where it is, and keeps what was typed.
    const renamed = 'Marriage problems, no Draco or Ron'
    await tab.$eval(TITLE_INPUT, (input, value) => {
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dataset.e2eMarker = 'same box'
    }, renamed)
    await toggleExclude('Hermione Granger')
    await diffNames('Hermione Granger', 'Ron Weasley')
    await toggleExclude('Hermione Granger')
    assert.equal(await diffNames('Ron Weasley'), ron)
    assert.deepEqual(await tab.$eval(TITLE_INPUT, input => [input.value, input.dataset.e2eMarker]), [renamed, 'same box'])

    await rerun(tab, () => clickBoxAction(tab, 'update'))

    const [updated] = await lists()
    assert.deepEqual(updated.filter, { facets: { characters: { ex: ['Draco Malfoy', 'Ron Weasley'] } } })
    assert.equal(updated.alias, renamed)
    assert.equal(updated.id, before.id)
    assert.equal(updated.since, before.since)
    assert.equal(updated.url, before.url)
    assert.equal(await refiningMark(tab), null, 'the update ends the refining')
  })

  test('the filter is put back once per arrival, never over what the reader does next', async () => {
    const [list] = await lists()
    await visit(tab, link)
    await until('the view to be back with the list’s filter', async () => (await refiningMark(tab))?.restore === false)
    assert.equal(await viewOpen(), true)
    assert.equal(await excluded('Ron Weasley'), true, 'the updated filter is the one put back')
    assert.deepEqual(await shownIds(), idsWithout('Draco Malfoy', 'Ron Weasley'))

    // The reader goes back to the tag's own list. A re-run — any options write —
    // leaves it there.
    await tab.click('.AO3E--search-view--back')
    await until('the view to close', async () => !(await viewOpen()))
    await rerun(tab, () => tab.evaluate(async () => {
      const option = (await browser.storage.local.get('option.trackedLists'))['option.trackedLists']
      await browser.storage.local.set({ 'option.trackedLists': { ...option, target: option.target + 1 } })
    }))
    assert.equal(await viewOpen(), false, 'a re-run doesn’t put the filter back')

    // Nor does loading the page again, in the same tab, still refining.
    await visit(tab, TAG_URL)
    assert.equal(await viewOpen(), false, 'nor does a reload')
    assert.deepEqual(await refiningMark(tab), { id: list.id, restore: false })
  })

  test('the review leaves out the works the filter rejects, and asks the archive to', async () => {
    fetched.length = 0
    await visit(tab, REVIEW_URL)
    const expected = idsWithout('Draco Malfoy', 'Ron Weasley').sort()
    await until('the review to show its works', async () => JSON.stringify((await shownIds()).sort()) === JSON.stringify(expected))
    assert.ok(await tab.$('.AO3E--search-host.AO3E--tracked-review'), 'the review is up')

    const reads = fetched.filter(url => url.startsWith('/works/search?'))
    assert.ok(reads.length > 0)
    for (const url of reads) {
      const params = new URLSearchParams(url.split('?')[1])
      assert.equal(params.get('work_search[other_tag_names]'), TAG)
      assert.equal(params.get('work_search[excluded_tag_names]'), 'Draco Malfoy,Ron Weasley')
    }
    // This archive ignores the exclusion, so every work comes back — and the
    // list's filter, applied on this side, still leaves out the ones it rejects.
    assert.deepEqual((await shownIds()).sort(), idsWithout('Draco Malfoy', 'Ron Weasley').sort())
  })
})

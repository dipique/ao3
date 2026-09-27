import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { normalizeTrackedUrl, utcToday } from '../../src/common/trackedLists.ts'
import { ensureBuilt, findChrome, installMock, serveDist, sleep } from './helpers.mjs'
import {
  ARCHIVE,
  boxButtons,
  boxText,
  clickBoxButton,
  clickToastAction,
  diffLines,
  launch,
  listingPage,
  navigateBy,
  openBox,
  openTab,
  pillText,
  refiningMark,
  searchPage,
  storedOption,
  TITLE_INPUT,
  toasts,
  visit,
} from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const TODAY = utcToday()

/** A fandom's listing, tracked on first visit, so in its path form and unfiltered. */
const HP_ID = 'Harry Potter - J*d* K*d* Rowling'
const HP = { id: 'hp1', kind: 'works-filter', url: '/tags/Harry%20Potter%20-%20J*d*%20K*d*%20Rowling/works', alias: 'Harry Potter', type: 'fandom', entity: 'Harry Potter - J. K. Rowling', tracked: true, since: TODAY - 20 }
/** A works search, still called by its default title. */
const COFFEE = { id: 'cof1', kind: 'text-search', url: '/works/search?work_search[query]=coffee', alias: 'Search: coffee', type: 'search', entity: 'coffee', tracked: true, since: TODAY - 9 }

const SEED = {
  'option.trackedLists': { enabled: true, target: 40, reviewedThrough: 0, lists: [HP, COFFEE] },
}

/** Both of Harry Potter's spellings are one listing, and searches answer whatever they're asked. */
function route(url) {
  if (url.pathname === '/tags/Harry%20Potter%20-%20J*d*%20K*d*%20Rowling/works')
    return listingPage(url, { tagId: HP_ID })
  if (url.pathname === '/works' && url.searchParams.get('tag_id') === HP_ID)
    return listingPage(url, { tagId: HP_ID })
  if (url.pathname === '/works/search')
    return searchPage(url)
  return null
}

const keyOf = url => normalizeTrackedUrl(url).key

/**
 * Refining a list — the workflow the pill's update rows are built for:
 *
 * 1. the reader opens the options page and follows a list's link,
 * 2. changes the search on the archive, usually several things at once,
 * 3. and updates the list from the floating toolbar.
 *
 * The link carries the list's id in its fragment; the tab keeps it as a mark in
 * its session storage, and the mark has to outlive the archive's own navigation —
 * above all a Sort & Filter submit, which moves a listing from its path form to
 * its query form. The works search half is the case where the mark is the only
 * thing that connects the page to its list: once the words change, nothing
 * about the address says which list it was.
 */
describe('tracked lists: refining a list from its link', { skip }, () => {
  let server
  let browser
  let tab
  /** The rows' links, as the options page draws them. */
  const links = {}

  before(async () => {
    ensureBuilt()
    server = await serveDist()
    browser = await launch(chromePath)

    // Step 1 happens on the options page: the links are read off its rows.
    const options = await browser.newPage()
    await options.evaluateOnNewDocument(installMock, SEED)
    await options.goto(`${server.url}/options_ui/options_ui.html`, { waitUntil: 'networkidle2' })
    await sleep(1500)
    Object.assign(links, await options.evaluate(() => Object.fromEntries(
      [...document.querySelectorAll('a[href*="#ao3e-list="]')].map(a => [a.href.split('#ao3e-list=')[1], a.href]),
    )))
    await options.close()

    tab = await openTab(browser, { seed: SEED, route })
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
    await server?.close()
  })

  const list = async id => (await storedOption(tab)).lists.find(one => one.id === id)

  test('the options page links each list to its own page, with its id', () => {
    assert.equal(links.hp1, `${ARCHIVE}/tags/Harry%20Potter%20-%20J*d*%20K*d*%20Rowling/works#ao3e-list=hp1`)
    assert.equal(links.cof1, `${ARCHIVE}/works/search?work_search[query]=coffee#ao3e-list=cof1`)
  })

  test('following the link marks the tab as refining the list, and takes the id off the address', async () => {
    await visit(tab, links.hp1)
    assert.deepEqual(await refiningMark(tab), { id: 'hp1', restore: true })
    assert.equal(await tab.evaluate(() => location.hash), '')
    assert.equal(await tab.evaluate(() => location.pathname), '/tags/Harry%20Potter%20-%20J*d*%20K*d*%20Rowling/works')
  })

  test('until the search changes, the pill only says so', async () => {
    await openBox(tab)
    assert.equal(await pillText(tab), 'Refining “Harry Potter”')
    assert.match(await boxText(tab), /Change the search, then update it here\./)
    assert.deepEqual(await boxButtons(tab), ['Stop refining'])
  })

  test('a Sort & Filter submit is a real navigation, and the mark survives it', async () => {
    // Two changes at once: a character excluded, and complete works only.
    await tab.click('#exclude_work_search_character_ids_1234')
    await tab.click('input[name="work_search[complete]"][value="T"]')
    await navigateBy(tab, () => tab.click('#work-filters input[type="submit"]'))
    assert.equal(await tab.evaluate(() => location.pathname), '/works', 'the listing is in its query form now')
    assert.equal(await tab.evaluate(() => new URLSearchParams(location.search).get('tag_id')), HP_ID)
    assert.deepEqual(await refiningMark(tab), { id: 'hp1', restore: true })
  })

  test('the pill offers the update, and the box names both changes', async () => {
    await openBox(tab)
    assert.equal(await pillText(tab), 'Update “Harry Potter”')
    // The exclusion is an id in the address; the page's own sidebar names it.
    assert.deepEqual(await diffLines(tab), ['Excludes: Draco Malfoy', 'Completion: any → complete only'])
    assert.doesNotMatch(await boxText(tab), /changes what/, 'the list keeps its root, so there is nothing to warn about')
    assert.equal(await tab.$eval(TITLE_INPUT, el => el.value), 'Harry Potter', 'the list keeps its own title')
    assert.deepEqual(await boxButtons(tab), ['Update “Harry Potter”', 'Track as a new list instead', 'Stop refining'])
  })

  test('Update replaces the query in place, and ends the mark', async () => {
    const pageUrl = await tab.evaluate(() => location.href)
    await clickBoxButton(tab, 'Update “Harry Potter”')
    await sleep(1500)

    const lists = (await storedOption(tab)).lists
    assert.equal(lists.length, 2, 'no list was added')
    const updated = lists.find(one => one.id === 'hp1')
    assert.equal(updated.url, normalizeTrackedUrl(pageUrl).url)
    assert.match(updated.url, /exclude_work_search\[character_ids\]\[\]=1234/)
    assert.match(updated.url, /work_search\[complete\]=T/)
    // What makes it the same list is kept.
    assert.equal(updated.since, HP.since)
    assert.equal(updated.tracked, true)
    assert.equal(updated.alias, 'Harry Potter')
    assert.equal(updated.type, 'fandom')
    assert.equal(updated.entity, 'Harry Potter - J. K. Rowling')

    assert.equal(await refiningMark(tab), null, 'the mark ends with the update')
    await tab.click('.AO3E--filter-toolbar--fab')
    await sleep(300)
    assert.equal(await pillText(tab), 'Tracked as “Harry Potter”')
    assert.ok((await toasts(tab)).includes('Updated “Harry Potter”.'))
  })

  test('Undo puts the old query back, and the tab back to refining it', async () => {
    assert.equal(await clickToastAction(tab, 'Undo'), true)
    await sleep(1500)
    const restored = await list('hp1')
    assert.equal(restored.url, HP.url)
    assert.equal(restored.since, HP.since)
    assert.deepEqual(await refiningMark(tab), { id: 'hp1', restore: false })
    await openBox(tab)
    assert.equal(await pillText(tab), 'Update “Harry Potter”')
  })

  test('Stop refining ends the mark and writes nothing', async () => {
    const before = await storedOption(tab)
    await clickBoxButton(tab, 'Stop refining')
    await sleep(500)
    assert.equal(await refiningMark(tab), null)
    assert.deepEqual(await storedOption(tab), before)
    // Without the mark the page is what it is: the same fandom, filtered otherwise.
    assert.equal(await pillText(tab), 'Track or update…')
  })

  test('a works search is refined the same way, from its own link', async () => {
    await visit(tab, links.cof1)
    assert.deepEqual(await refiningMark(tab), { id: 'cof1', restore: true })
    await openBox(tab)
    assert.equal(await pillText(tab), 'Refining “Search: coffee”')
  })

  test('once its words change, only the mark says which list the page is', async () => {
    await visit(tab, `${ARCHIVE}/works/search?utf8=%E2%9C%93&commit=Search&work_search%5Bquery%5D=tea+shop`)
    assert.notEqual(keyOf(await tab.evaluate(() => location.href)), keyOf(`${ARCHIVE}${COFFEE.url}`))
    await openBox(tab)
    assert.equal(await pillText(tab), 'Update “Search: coffee”')
    // Updating is still allowed — replacing the query is what refining is for —
    // but the move is said first.
    assert.match(await boxText(tab), /This changes what “Search: coffee” searches: from coffee to tea shop\./)
    assert.deepEqual(await diffLines(tab), ['Search words: “coffee” → “tea shop”'])
    // A title that was only ever the default follows the words.
    assert.equal(await tab.$eval(TITLE_INPUT, el => el.value), 'Search: tea shop')
  })

  test('and Update moves the list to the new words, keeping its place', async () => {
    await clickBoxButton(tab, 'Update “Search: coffee”')
    await sleep(1500)
    const updated = await list('cof1')
    assert.equal(updated.url, '/works/search?work_search[query]=tea+shop')
    assert.equal(updated.alias, 'Search: tea shop')
    assert.equal(updated.entity, 'tea shop')
    assert.equal(updated.since, COFFEE.since)
    assert.equal(await refiningMark(tab), null)
    // The other list is as the Undo left it.
    assert.equal((await list('hp1')).url, HP.url)
  })

  test('Track as a new list instead leaves the list alone, and ends the mark', async () => {
    await visit(tab, links.hp1)
    await tab.click('#exclude_work_search_character_ids_5678')
    await navigateBy(tab, () => tab.click('#work-filters input[type="submit"]'))
    await openBox(tab)
    assert.equal(await pillText(tab), 'Update “Harry Potter”')
    await clickBoxButton(tab, 'Track as a new list instead')
    await sleep(1500)

    const lists = (await storedOption(tab)).lists
    assert.equal(lists.length, 3)
    const added = lists.at(-1)
    // The box held the list's own title, which the new one can't share, so it
    // takes the page's default instead.
    assert.equal(added.alias, 'Fandom: Harry Potter - J. K. Rowling')
    assert.equal(added.type, 'fandom')
    assert.match(added.url, /exclude_work_search\[character_ids\]\[\]=5678/)
    assert.equal(added.since, TODAY)
    assert.equal((await list('hp1')).url, HP.url, 'the list being refined is untouched')
    assert.equal(await refiningMark(tab), null)
  })

  test('a mark whose list is gone is dropped the next time the pill looks', async () => {
    await tab.evaluate(() => sessionStorage.setItem('ao3e:refining', JSON.stringify({ id: 'g0ne', restore: true })))
    await visit(tab, `${ARCHIVE}/works/search?work_search%5Bquery%5D=tea+shop`)
    await openBox(tab)
    assert.equal(await pillText(tab), 'Tracked as “Search: tea shop”')
    assert.equal(await refiningMark(tab), null)
  })
})

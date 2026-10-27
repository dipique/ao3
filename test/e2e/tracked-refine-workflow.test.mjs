import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { SAVE_BACK_UNDO_TIMEOUT } from '../../src/common/constants.ts'
import { addressOf, planSavedLists, savedListsWrite, storedListRefs } from '../../src/common/savedLists.ts'
import { normalizeTrackedUrl, utcToday } from '../../src/common/trackedLists.ts'
import { mentions } from '../facts.mjs'
import { ensureBuilt, findChrome, serveDist, storedLists } from './helpers.mjs'
import { openOptions, until } from './optionsPage.mjs'
import {
  ARCHIVE,
  blurb,
  boxActions,
  boxWarnings,
  clickBoxAction,
  diffLines,
  launch,
  listingPage,
  navigateBy,
  openBox,
  openTab,
  pillRow,
  pillText,
  pressToast,
  refiningMark,
  rerun,
  searchPage,
  stored,
  storedOption,
  TITLE_INPUT,
  toastNamed,
  TRACK_BOX,
  TRACK_PILL,
  visit,
} from './trackedPages.mjs'

const chromePath = findChrome()

/**
 * Undo's window, cut to a few seconds: long enough for the steps a test takes
 * inside it, short enough that the tests waiting it out don't wait twenty.
 */
const HURRY = { [SAVE_BACK_UNDO_TIMEOUT]: 3000 }
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const TODAY = utcToday()

/** A fandom's listing, tracked on first visit, so in its path form and unfiltered. */
const HP_ID = 'Harry Potter - J*d* K*d* Rowling'
const HP = { id: 'hp1', kind: 'works-filter', url: '/tags/Harry%20Potter%20-%20J*d*%20K*d*%20Rowling/works', alias: 'Harry Potter', type: 'fandom', entity: 'Harry Potter - J. K. Rowling', tracked: true, since: TODAY - 20 }
/** A works search, still called by its default title. */
const COFFEE = { id: 'cof1', kind: 'text-search', url: '/works/search?work_search[query]=coffee', alias: 'Search: coffee', type: 'search', entity: 'coffee', tracked: true, since: TODAY - 9 }

/** A saved list's record, as the background files it for an entry: its id, query and title. */
function recordOf({ id, kind, url, alias, type, entity, filter }) {
  return Object.fromEntries(Object.entries({ id, kind, url, title: alias, type, entity, filter }).filter(([, value]) => value !== undefined))
}

const SEED = {
  'option.trackedLists': { enabled: true, target: 40, reviewedThrough: 0, lists: [HP, COFFEE] },
  'option.savedLists': { v: 1, lists: { hp1: recordOf(HP), cof1: recordOf(COFFEE) } },
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

/** The toolbar's Undo, as long as its toast is up. */
async function undoShown(tab) {
  return !!await toastNamed(tab, 'updated')
}

/** The pill is in `row` ({@link pillRow}), and names the list `title`. */
async function pillIs(tab, row, title) {
  assert.equal(await pillRow(tab), row)
  assert.ok(mentions(await pillText(tab), title), `the pill should name ${title}`)
}

/** What the box warns, where it warns that the update moves the list to another root. */
function rootWarning(tab) {
  return tab.$eval(`${TRACK_BOX} [data-ao3e-warn="root"]`, el => el.textContent)
}

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
 *
 * A tracked list's update rewrites both of its homes, the entry that syncs and
 * the record this browser keeps, and each write re-runs the page.
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
    const options = await openOptions(browser, server, { seed: SEED, hash: '#saved-lists' })
    for (const id of await options.savedListIds())
      links[id] = await (await options.action(await options.savedList(id), 'view-edit')).evaluate(a => a.href)
    await options.close()

    tab = await openTab(browser, { hurry: HURRY, seed: SEED, route })
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
    await server?.close()
  })

  const list = async id => (await storedOption(tab)).lists.find(one => one.id === id)
  const record = async id => (await storedOption(tab, 'savedLists')).lists[id]

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
    await pillIs(tab, 'refining:hp1:same', 'Harry Potter')
    assert.deepEqual(await boxActions(tab), ['stop-refining'])
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
    await pillIs(tab, 'refining:hp1:changed', 'Harry Potter')
    // The exclusion is an id in the address; the page's own sidebar names it.
    const lines = await diffLines(tab)
    assert.equal(lines.length, 2, 'a line for each change')
    assert.ok(mentions(lines[0], 'Draco Malfoy'), lines[0])
    assert.deepEqual(await boxWarnings(tab), [], 'the list keeps its root, so there is nothing to warn about')
    assert.equal(await tab.$eval(TITLE_INPUT, el => el.value), 'Harry Potter', 'the list keeps its own title')
    assert.deepEqual(await boxActions(tab), ['update', 'track-new', 'stop-refining'])
  })

  test('Update rewrites the entry and the record in place, keeps the tracking start, and ends the mark', async () => {
    const pageUrl = await tab.evaluate(() => location.href)
    await rerun(tab, () => clickBoxAction(tab, 'update'))

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
    assert.deepEqual(Object.keys((await storedOption(tab, 'savedLists')).lists).sort(), ['cof1', 'hp1'])
    assert.deepEqual(await record('hp1'), recordOf(updated), 'the record says what the entry does')

    assert.equal(await refiningMark(tab), null, 'the mark ends with the update')
    await pillIs(tab, 'exact:hp1', 'Harry Potter')
    assert.ok(mentions((await toastNamed(tab, 'updated'))?.message ?? '', 'Harry Potter'), 'the update is said, naming the list')
  })

  test('Undo puts the old query back in both, and the tab back to refining it', async () => {
    await rerun(tab, async () => assert.equal(await pressToast(tab, 'updated'), true))
    assert.deepEqual(await list('hp1'), HP)
    assert.deepEqual(await record('hp1'), recordOf(HP))
    assert.deepEqual(await refiningMark(tab), { id: 'hp1', restore: false })
    await openBox(tab)
    await pillIs(tab, 'refining:hp1:changed', 'Harry Potter')
  })

  test('Stop refining ends the mark and writes nothing', async () => {
    const before = await storedOption(tab)
    await clickBoxAction(tab, 'stop-refining')
    assert.equal(await refiningMark(tab), null)
    assert.deepEqual(await storedOption(tab), before)
    // Without the mark the page is what it is: the same fandom, filtered otherwise.
    assert.equal(await pillRow(tab), 'same-root:hp1')
  })

  test('a works search is refined the same way, from its own link', async () => {
    await visit(tab, links.cof1)
    assert.deepEqual(await refiningMark(tab), { id: 'cof1', restore: true })
    await openBox(tab)
    await pillIs(tab, 'refining:cof1:same', 'Search: coffee')
  })

  test('once its words change, only the mark says which list the page is', async () => {
    await visit(tab, `${ARCHIVE}/works/search?utf8=%E2%9C%93&commit=Search&work_search%5Bquery%5D=tea+shop`)
    assert.notEqual(keyOf(await tab.evaluate(() => location.href)), keyOf(`${ARCHIVE}${COFFEE.url}`))
    await openBox(tab)
    await pillIs(tab, 'refining:cof1:changed', 'Search: coffee')
    // Updating is still allowed — replacing the query is what refining is for —
    // but the move is said first.
    assert.deepEqual(await boxWarnings(tab), ['root'])
    const move = await rootWarning(tab)
    assert.ok(mentions(move, 'Search: coffee') && mentions(move, 'tea shop'), move)
    const [words, ...more] = await diffLines(tab)
    assert.deepEqual(more, [])
    assert.ok(mentions(words, 'coffee') && mentions(words, 'tea shop'), words)
    // A title that was only ever the default follows the words.
    assert.equal(await tab.$eval(TITLE_INPUT, el => el.value), 'Search: tea shop')
  })

  test('and Update moves the list to the new words, keeping its place', async () => {
    await rerun(tab, () => clickBoxAction(tab, 'update'))
    const updated = await list('cof1')
    assert.equal(updated.url, '/works/search?work_search[query]=tea+shop')
    assert.equal(updated.alias, 'Search: tea shop')
    assert.equal(updated.entity, 'tea shop')
    assert.equal(updated.since, COFFEE.since)
    assert.deepEqual(await record('cof1'), recordOf(updated))
    assert.equal(await refiningMark(tab), null)
    // The other list is as the Undo left it.
    assert.equal((await list('hp1')).url, HP.url)
  })

  test('a mark a tab already held refines its list, as one taken from a link does', async () => {
    await tab.evaluate(() => sessionStorage.setItem('ao3e:refining', JSON.stringify({ id: 'cof1', restore: false })))
    await visit(tab, `${ARCHIVE}/works/search?work_search%5Bquery%5D=chai`)
    await openBox(tab)
    await pillIs(tab, 'refining:cof1:changed', 'Search: tea shop')
    await clickBoxAction(tab, 'stop-refining')
  })

  test('Track as a new list instead leaves the list alone, and ends the mark', async () => {
    await visit(tab, links.hp1)
    await tab.click('#exclude_work_search_character_ids_5678')
    await navigateBy(tab, () => tab.click('#work-filters input[type="submit"]'))
    await openBox(tab)
    await pillIs(tab, 'refining:hp1:changed', 'Harry Potter')
    await rerun(tab, () => clickBoxAction(tab, 'track-new'))

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
    assert.deepEqual(await record('hp1'), recordOf(HP))
    assert.equal(await refiningMark(tab), null)
  })

  test('a mark whose list is gone is dropped the next time the pill looks', async () => {
    await tab.evaluate(() => sessionStorage.setItem('ao3e:refining', JSON.stringify({ id: 'g0ne', restore: true })))
    await visit(tab, `${ARCHIVE}/works/search?work_search%5Bquery%5D=tea+shop`)
    await openBox(tab)
    await pillIs(tab, 'exact:cof1', 'Search: tea shop')
    assert.equal(await refiningMark(tab), null)
  })
})

/** A saved list nothing tracks: a works search, titled. */
const LATTE = { id: 'l4tte', kind: 'text-search', url: '/works/search?work_search[query]=latte', title: 'Latte art', type: 'search', entity: 'latte' }
/** Its search's copy, stored by the search view, and the same search stored in an older sort order. */
const LATTE_KEY = 'text-search:work_search%5Bquery%5D=latte'
const LATTE_BY_KUDOS = 'text-search:work_search%5Bquery%5D=latte&work_search%5Bsort_column%5D=kudos_count'
/** What the newer copy failed to find, as the search view packs it. */
const LATTE_MISSES = '7d'
/** The search the list is refined into, as the search form submits it. */
const MACCHIATO_URL = `${ARCHIVE}/works/search?utf8=%E2%9C%93&commit=Search&work_search%5Bquery%5D=latte+macchiato`
const MACCHIATO = normalizeTrackedUrl(MACCHIATO_URL).url
/** The works the old copies hold, which no other list does. */
const OLD_WORKS = [301, 302, 303]

const HOUR = 60 * 60 * 1000
const latteCopy = (listUrl, hours, ids) => ({
  version: 2,
  scrapedAt: Date.now() - hours * HOUR,
  blurbsHtml: ids.map(id => blurb(id)),
  descriptor: { sourceId: 'text-search', label: 'Works search: latte', listUrl },
})

const UNTRACKED_SEED = {
  'option.trackedLists': { enabled: true, target: 40, reviewedThrough: 0, lists: [] },
  'option.savedLists': { v: 1, lists: { l4tte: LATTE } },
  // So that what the old copies held, once they are let go, goes with them.
  'option.pruneOrphanedBlurbs': true,
  ...storedLists({
    [LATTE_KEY]: latteCopy(`${ARCHIVE}/works/search?work_search%5Bquery%5D=latte`, 5, OLD_WORKS.slice(0, 2)),
    [LATTE_BY_KUDOS]: latteCopy(`${ARCHIVE}/works/search?work_search%5Bquery%5D=latte&work_search%5Bsort_column%5D=kudos_count`, 6, OLD_WORKS.slice(2)),
  }),
  'cache.searchMisses': { [LATTE_KEY]: LATTE_MISSES },
}

/** Searches, each with the search view's button; the latte macchiato one has characters to filter by. */
function untrackedRoute(url) {
  if (url.pathname !== '/works/search')
    return null
  const query = url.searchParams.get('work_search[query]')
  const blurbs = query === 'latte macchiato'
    ? [blurb(201, { characters: ['Draco Malfoy'] }), blurb(202, { characters: ['Ron Weasley'] })]
    : undefined
  return searchPage(url, blurbs, { subnav: true })
}

/**
 * What the background does whenever the stored lists change, which a tab has
 * no background to do: the planner, over what the tab's storage holds, written
 * back where it changed. Returns what it wrote.
 */
async function reconcile(tab) {
  const held = await tab.evaluate(() => window.browser.storage.local.get(['option.trackedLists', 'option.savedLists', 'cache.searchLists']))
  const state = { tracked: held['option.trackedLists'], saved: held['option.savedLists'] }
  const update = savedListsWrite(state, planSavedLists(state, storedListRefs(held['cache.searchLists'])).state)
  const items = Object.fromEntries(Object.entries(update).map(([name, value]) => [`option.${name}`, value]))
  if (Object.keys(items).length)
    await tab.evaluate(set => window.browser.storage.local.set(set), items)
  return update
}

/** The key the search view stored a copy of `url`'s search under, or null. */
function copyKeyOf(lists, url) {
  return Object.entries(lists ?? {}).find(([, list]) => addressOf(list.descriptor?.listUrl) === addressOf(url))?.[0] ?? null
}

/** Exclude a value in the open search view, as its facet's toggle does. */
function exclude(tab, value) {
  return tab.evaluate((want) => {
    const row = [...document.querySelectorAll('.AO3E--search-view--row')]
      .find(el => el.querySelector('.AO3E--search-view--row-name')?.textContent?.trim() === want)
    row.querySelector('.AO3E--search-view--toggle-exclude').click()
  }, value)
}

/**
 * Saving a refined search back to a saved list that nothing tracks: its record,
 * the one home it has, is rewritten in place under its own id, and nothing
 * syncs. Its old copies at the old address go — every sort order of them, or
 * one left behind would come back as a list of its own — until Undo puts them
 * back as they were. The copy the search view stored on the refined page, which
 * the background had given a record of its own, becomes the list's.
 *
 * Writing only this browser's records re-runs nothing on the page, so the pill
 * is rebuilt where it is.
 */
describe('saved lists: saving a refined search back', { skip }, () => {
  let server
  let browser
  let tab
  let link
  /** The view's copy of the latte macchiato search, once it has stored one. */
  let newKey = null
  /** What storage held just before the first Update. */
  let held = null

  before(async () => {
    ensureBuilt()
    server = await serveDist()
    browser = await launch(chromePath)
    const options = await openOptions(browser, server, { seed: UNTRACKED_SEED, hash: '#saved-lists' })
    link = await (await options.action(await options.savedList('l4tte'), 'view-edit')).evaluate(a => a.href)
    await options.close()
    tab = await openTab(browser, { hurry: HURRY, seed: UNTRACKED_SEED, route: untrackedRoute })
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
    await server?.close()
  })

  const latte = async () => (await storedOption(tab, 'savedLists')).lists.l4tte

  test('the options page links a list nothing tracks to its page, with its id', () => {
    assert.equal(link, `${ARCHIVE}/works/search?work_search[query]=latte#ao3e-list=l4tte`)
  })

  test('following the link marks the tab as refining it', async () => {
    await visit(tab, link)
    // Its page has nothing to put back: the list has no view filter.
    assert.deepEqual(await refiningMark(tab), { id: 'l4tte', restore: false })
    await openBox(tab)
    await pillIs(tab, 'refining:l4tte:same', 'Latte art')
  })

  test('a changed search offers the update, under the list\'s own title', async () => {
    await visit(tab, MACCHIATO_URL)
    await openBox(tab)
    await pillIs(tab, 'refining:l4tte:changed', 'Latte art')
    const [words, ...more] = await diffLines(tab)
    assert.deepEqual(more, [])
    assert.ok(mentions(words, 'latte macchiato'), words)
    assert.equal(await tab.$eval(TITLE_INPUT, el => el.value), 'Latte art')
    assert.deepEqual(await boxActions(tab), ['update', 'track-new', 'stop-refining'])
  })

  test('the search view opened there stores a copy, which the background gives a record of its own', async () => {
    await tab.click('.AO3E--search-text-results--button')
    await until('the view to store its copy', async () => {
      newKey = copyKeyOf(await stored(tab, 'cache.searchLists'), MACCHIATO_URL)
      return newKey !== null
    })
    const update = await reconcile(tab)
    const made = Object.values(update.savedLists.lists).filter(one => one.id !== 'l4tte')
    assert.deepEqual(made.map(({ id, ...rest }) => rest), [{ kind: 'text-search', url: MACCHIATO, title: 'Search: latte macchiato', type: 'search', entity: 'latte macchiato' }])
  })

  test('Update rewrites the list\'s record in place, absorbs that record, and drops every old copy', async () => {
    held = {
      lists: await stored(tab, 'cache.searchLists'),
      misses: await stored(tab, 'cache.searchMisses'),
      records: await storedOption(tab, 'savedLists'),
    }
    await openBox(tab)
    await clickBoxAction(tab, 'update')
    await until('the list to be saved back', async () => (await latte()).url === MACCHIATO)

    assert.deepEqual((await storedOption(tab, 'savedLists')).lists, { l4tte: { ...LATTE, url: MACCHIATO, entity: 'latte macchiato' } }, 'one list, its id and title kept')
    const lists = await stored(tab, 'cache.searchLists')
    assert.deepEqual(Object.keys(lists), [newKey], 'both old copies are gone, and the view\'s is the list\'s now')
    assert.equal(LATTE_KEY in await stored(tab, 'cache.searchMisses'), false, 'with what the old one missed')
    assert.equal(await tab.evaluate(() => window.__writes.filter(write => 'option.trackedLists' in write).length), 0, 'nothing that syncs is written')
    assert.deepEqual(await storedOption(tab), UNTRACKED_SEED['option.trackedLists'])
    assert.deepEqual(await reconcile(tab), {}, 'the background finds no list left to file at the old address')

    assert.equal(await refiningMark(tab), null)
    assert.equal(await pillRow(tab), 'saved:l4tte', 'the page is the saved list now')
    assert.ok(mentions((await toastNamed(tab, 'updated'))?.message ?? '', 'Latte art'), 'the update is said, naming the list')
  })

  test('Undo puts back exactly what Update changed: the record, the absorbed one, both old copies and what they missed', async () => {
    assert.equal(await pressToast(tab, 'updated'), true)
    await until('the copies to be back', async () => {
      const lists = await stored(tab, 'cache.searchLists')
      return LATTE_KEY in lists && LATTE_BY_KUDOS in lists
    })
    assert.deepEqual(await storedOption(tab, 'savedLists'), held.records)
    assert.deepEqual(await stored(tab, 'cache.searchLists'), held.lists, 'byte for byte, the view\'s copy still there')
    assert.deepEqual(await stored(tab, 'cache.searchMisses'), held.misses)
    assert.deepEqual(await storedOption(tab), UNTRACKED_SEED['option.trackedLists'])
    assert.deepEqual(await reconcile(tab), {}, 'nothing for the background to do')

    assert.deepEqual(await refiningMark(tab), { id: 'l4tte', restore: false })
    await pillIs(tab, 'refining:l4tte:changed', 'Latte art')
    assert.ok(mentions((await toastNamed(tab, 'undone'))?.message ?? '', 'Latte art'), 'the undo is said, naming the list')
  })

  test('once Undo\'s time is up, the blurbs only the old copies held go, as a deleted list\'s do', async () => {
    await openBox(tab)
    await clickBoxAction(tab, 'update')
    await until('the list to be saved back again', async () => (await latte()).url === MACCHIATO)
    // A pointer resting on a toast holds it up.
    await tab.mouse.move(0, 0)
    await until('Undo to time out', async () => !(await undoShown(tab)), SAVE_BACK_UNDO_TIMEOUT * 2)

    const blurbKeys = async () => Object.keys(await tab.evaluate(() => browser.storage.local.get(null))).filter(key => key.startsWith('blurb.'))
    const oldKeys = OLD_WORKS.map(id => `blurb.${id.toString(36)}`)
    await until('the old copies\' blurbs to go', async () => !(await blurbKeys()).some(key => oldKeys.includes(key)))
    for (const id of [201, 202])
      assert.ok((await blurbKeys()).includes(`blurb.${id.toString(36)}`), `the view's work ${id} stays`)
  })

  test('a change of view filter alone keeps the list\'s copy', async () => {
    await visit(tab, `${ARCHIVE}${MACCHIATO}#ao3e-list=l4tte`)
    await tab.click('.AO3E--search-text-results--button')
    // This page's address spells the search without the form's extra fields,
    // so the view keeps a second copy of it, at the same address.
    await until('the view to store its copy', async () => Object.values(await stored(tab, 'cache.searchLists'))
      .filter(list => addressOf(list.descriptor?.listUrl) === addressOf(MACCHIATO_URL))
      .length === 2)
    await until('the view to be up', () => tab.evaluate(() => document.querySelector('.AO3E--search-view--row') !== null))
    await exclude(tab, 'Draco Malfoy')
    await until('the pill to follow the view', async () => await pillRow(tab) === 'refining:l4tte:changed')
    await openBox(tab)
    const [excluded, ...more] = await diffLines(tab)
    assert.deepEqual(more, [])
    assert.ok(mentions(excluded, 'Draco Malfoy'), excluded)

    const before = Object.keys(await stored(tab, 'cache.searchLists'))
    await clickBoxAction(tab, 'update')
    await until('the filter to be saved back', async () => !!(await latte()).filter)
    assert.deepEqual(await latte(), { ...LATTE, url: MACCHIATO, entity: 'latte macchiato', filter: { facets: { characters: { ex: ['Draco Malfoy'] } } } })
    assert.deepEqual(Object.keys(await stored(tab, 'cache.searchLists')), before, 'no copy is dropped')
  })

  test('a list removed while it is being refined is refused as missing, and the refining ends', async () => {
    await visit(tab, `${ARCHIVE}${MACCHIATO}#ao3e-list=l4tte`)
    await visit(tab, `${ARCHIVE}/works/search?work_search%5Bquery%5D=flat+white`)
    await openBox(tab)
    await pillIs(tab, 'refining:l4tte:changed', 'Latte art')
    // Removed on the options page meanwhile: a write the page doesn't re-run on.
    await tab.evaluate(() => browser.storage.local.set({ 'option.savedLists': { v: 1, lists: {} } }))
    await clickBoxAction(tab, 'update')
    await until('the refusal', () => toastNamed(tab, 'refused-missing'))
    assert.ok(mentions((await toastNamed(tab, 'refused-missing')).message, 'Latte art'), 'the refusal names the list')
    assert.equal(await refiningMark(tab), null)
    assert.deepEqual(await storedOption(tab, 'savedLists'), { v: 1, lists: {} }, 'nothing is written')
    assert.equal(await pillRow(tab), 'new')
  })
})

/**
 * A list come back to the old address while Undo's toast is up: here, another
 * browser tracking the old search, whose entry a sync brings in. The copies the
 * save-back set aside are that list's now, so when the toast goes they are put
 * back as they were, not let go.
 */
describe('saved lists: a list back at the old address before Undo\'s time is up', { skip }, () => {
  let browser
  let tab
  /** Another browser's list of the old search, as a sync brings its entry in. */
  const THEIRS = { id: 'th3irs', kind: 'text-search', url: LATTE.url, alias: 'Their latte', type: 'search', entity: 'latte', tracked: true, since: TODAY }

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
    tab = await openTab(browser, { hurry: HURRY, seed: UNTRACKED_SEED, route: untrackedRoute })
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  test('once the toast goes, the old copies are put back, byte for byte, with what they missed and their blurbs', async () => {
    await visit(tab, `${ARCHIVE}${LATTE.url}#ao3e-list=l4tte`)
    const held = { lists: await stored(tab, 'cache.searchLists'), misses: await stored(tab, 'cache.searchMisses') }
    await visit(tab, MACCHIATO_URL)
    await openBox(tab)
    await clickBoxAction(tab, 'update')
    await until('the list to be saved back', async () => (await storedOption(tab, 'savedLists')).lists.l4tte.url === MACCHIATO)
    assert.deepEqual(await stored(tab, 'cache.searchLists'), {}, 'the old copies are set aside')

    await rerun(tab, () => tab.evaluate(entry => browser.storage.local.set({
      'option.trackedLists': { enabled: true, target: 40, reviewedThrough: 0, lists: [entry] },
    }), THEIRS))
    assert.ok(await undoShown(tab), 'within Undo\'s time')

    // A pointer resting on a toast holds it up.
    await tab.mouse.move(0, 0)
    await until('Undo to time out', async () => !(await undoShown(tab)), SAVE_BACK_UNDO_TIMEOUT * 2)
    await until('the old copies to be back', async () => {
      const lists = await stored(tab, 'cache.searchLists')
      return LATTE_KEY in lists && LATTE_BY_KUDOS in lists
    })
    assert.deepEqual(await stored(tab, 'cache.searchLists'), held.lists)
    assert.deepEqual(await stored(tab, 'cache.searchMisses'), held.misses)
    const blurbKeys = Object.keys(await tab.evaluate(() => browser.storage.local.get(null))).filter(key => key.startsWith('blurb.'))
    for (const id of OLD_WORKS)
      assert.ok(blurbKeys.includes(`blurb.${id.toString(36)}`), `work ${id}'s blurb stays`)

    assert.deepEqual((await storedOption(tab, 'savedLists')).lists, { l4tte: { ...LATTE, url: MACCHIATO, entity: 'latte macchiato' } }, 'the saved-back list keeps its new search')
    assert.deepEqual(await storedOption(tab), { enabled: true, target: 40, reviewedThrough: 0, lists: [THEIRS] })
    const update = await reconcile(tab)
    assert.deepEqual(Object.keys(update.savedLists.lists).sort(), ['l4tte', 'th3irs'], 'the background files the arrived list, and makes no list of the copies')
  })
})

/**
 * Saving back belongs to saved lists, not to tracking: with *Tracked lists*
 * switched off, the refining link and the update still work, and only the offer
 * to track a page is gone.
 */
describe('saved lists: saving back with Tracked lists switched off', { skip }, () => {
  let browser
  let tab
  const seed = {
    ...UNTRACKED_SEED,
    'option.trackedLists': { enabled: false, target: 40, reviewedThrough: 0, lists: [] },
  }

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
    tab = await openTab(browser, { hurry: HURRY, seed, route: untrackedRoute })
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  test('the link still marks the tab, and the pill says it is refining', async () => {
    await visit(tab, `${ARCHIVE}${LATTE.url}#ao3e-list=l4tte`)
    assert.deepEqual(await refiningMark(tab), { id: 'l4tte', restore: false })
    await openBox(tab)
    await pillIs(tab, 'refining:l4tte:same', 'Latte art')
  })

  test('a changed search offers the update, and no tracking', async () => {
    await visit(tab, MACCHIATO_URL)
    await openBox(tab)
    await pillIs(tab, 'refining:l4tte:changed', 'Latte art')
    assert.deepEqual(await boxActions(tab), ['update', 'stop-refining'])
  })

  test('Update saves the list back, and with nothing left to refine the pill goes', async () => {
    await clickBoxAction(tab, 'update')
    await until('the list to be saved back', async () => (await storedOption(tab, 'savedLists')).lists.l4tte.url === MACCHIATO)
    assert.deepEqual(Object.keys(await stored(tab, 'cache.searchLists')), [], 'its old copies went with its old address')
    assert.deepEqual(await storedOption(tab), seed['option.trackedLists'], 'and nothing that syncs changed')
    assert.equal(await refiningMark(tab), null)
    assert.equal(await tab.$(TRACK_PILL), null)
  })
})

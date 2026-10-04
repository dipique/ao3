import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { utcToday } from '../../src/common/trackedLists.ts'
import { ensureBuilt, findChrome, sleep } from './helpers.mjs'
import {
  ARCHIVE,
  blurb,
  clickBoxButton,
  launch,
  listingPage,
  openBox,
  openTab,
  pillText,
  searchPage,
  seriesPage,
  storedOption,
  tagPage,
  TITLE_INPUT,
  toasts,
  TRACK_BOX,
  TRACK_PILL,
  visit,
} from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const TODAY = utcToday()

/** A works search that has taken the title a Draco Malfoy character list would default to. */
const NAMESAKE = { id: 'nmsk', kind: 'text-search', url: '/works/search?work_search[query]=Draco+Malfoy', alias: 'Character: Draco Malfoy', tracked: true, since: TODAY - 4 }
/** Tracked before lists recorded what they are: a tag's list that reads "Tag", and a series that reads as its id. */
const RON = { id: 'ron', kind: 'works-filter', url: '/tags/Ron%20Weasley/works', alias: 'Ron', tracked: true, since: TODAY - 4 }
const LONG_WAY = { id: 'lway', kind: 'series-works', url: '/series/4242', alias: 'Long way', tracked: true, since: TODAY - 4 }

const SEED = {
  'option.trackedLists': { enabled: true, target: 40, reviewedThrough: 0, lists: [NAMESAKE, RON, LONG_WAY] },
}

const PAIRING = 'Draco Malfoy*s*Harry Potter'
const PAIRING_PAGE = `/tags/${encodeURIComponent(PAIRING)}`

function route(url) {
  switch (url.pathname) {
    case '/tags/Draco%20Malfoy/works':
      return listingPage(url, { tagId: 'Draco Malfoy', blurbs: [blurb(401, { characters: ['Harry Potter', 'Draco Malfoy'] })] })
    // Every blurb here carries the pairing by a synonym, so none of them names it.
    case `${PAIRING_PAGE}/works`:
      return listingPage(url, { tagId: PAIRING, blurbs: [blurb(402, { relationships: ['Harry/Draco'] }), blurb(403, { relationships: ['Drarry'] })] })
    case PAIRING_PAGE:
      return tagPage('Draco Malfoy/Harry Potter', 'Relationship')
    case '/tags/Ron%20Weasley/works':
      return listingPage(url, { tagId: 'Ron Weasley', blurbs: [blurb(404, { characters: ['Ron Weasley'] })] })
    case '/tags/marriage%20problems':
      return tagPage('marriage problems', 'Additional Tags', [blurb(405, { freeforms: ['marriage problems'] })])
    case '/series/4242':
      return seriesPage('The Long Way Round')
    case '/series/5151':
      return seriesPage('Another Way Entirely')
    case '/works/search':
      return searchPage(url)
  }
  return null
}

/**
 * What a list is, read off the page it's made from: a tag's category, which no
 * address says, and a series' title, which its address only numbers. A new list
 * is titled "Type: entity" from them, made unique; a title another list has is
 * refused; and a list made before lists recorded this has it filled in when the
 * reader is next on its page.
 *
 * A tag's category costs a request only when no blurb on its listing names the
 * tag — and then just the one, and only once the reader opens the box that
 * needs it.
 */
describe('tracked lists: what a list is, from its page', { skip }, () => {
  let browser
  let tab
  const requests = []

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
    tab = await openTab(browser, { seed: SEED, route, requests })
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  const list = async id => (await storedOption(tab)).lists.find(one => one.id === id)
  /** How many times the tab asked for this path. */
  const asked = path => requests.filter(url => new URL(url).pathname === path).length

  test('a character\'s listing is a Character list, by the blurbs that file the tag', async () => {
    await visit(tab, `${ARCHIVE}/tags/Draco%20Malfoy/works`)
    await openBox(tab)
    assert.equal(await pillText(tab), 'Track this search')
    // The default is taken, so it's offered made unique.
    assert.equal(await tab.$eval(TITLE_INPUT, el => el.value), 'Character: Draco Malfoy (2)')
    assert.equal(asked('/tags/Draco%20Malfoy'), 0, 'the blurbs said, so the tag\'s page wasn\'t asked')
  })

  test('a title another list has is refused, and says which list', async () => {
    const before = await storedOption(tab)
    await tab.$eval(TITLE_INPUT, (el) => {
      el.value = '  character: DRACO malfoy '
    })
    await clickBoxButton(tab, 'Track')
    await sleep(800)
    assert.deepEqual(await storedOption(tab), before, 'nothing is written')
    assert.ok(
      (await toasts(tab)).includes('Another list is already called “Character: Draco Malfoy” (Search: Draco Malfoy). Choose a different title.'),
      'the refusal names the list by its title, and by what it is',
    )
    // The box is still there to try again.
    assert.equal(await tab.$eval(`${TRACK_BOX} button`, el => el.disabled), false)
  })

  test('tracked, it keeps its type apart from its title', async () => {
    await tab.$eval(TITLE_INPUT, (el) => {
      el.value = 'Character: Draco Malfoy (2)'
    })
    await clickBoxButton(tab, 'Track')
    await sleep(1500)
    const added = (await storedOption(tab)).lists.at(-1)
    assert.equal(added.alias, 'Character: Draco Malfoy (2)')
    assert.equal(added.type, 'character')
    assert.equal(added.entity, 'Draco Malfoy')
    assert.equal(added.url, '/tags/Draco%20Malfoy/works')
  })

  test('when no blurb names the tag, its own page is asked — once the box opens, and once only', async () => {
    await visit(tab, `${ARCHIVE}${PAIRING_PAGE}/works`)
    assert.equal(asked(PAIRING_PAGE), 0, 'nothing is asked just for opening the page')

    await openBox(tab)
    await sleep(500)
    assert.equal(asked(PAIRING_PAGE), 1)
    // Until then the title said "Tag"; the page's answer replaces it, since the
    // reader hadn't typed over it.
    assert.equal(await tab.$eval(TITLE_INPUT, el => el.value), 'Relationship: Draco Malfoy/Harry Potter')

    // Closing and opening again asks nothing more, and neither does tracking.
    await tab.click(TRACK_PILL)
    await tab.click(TRACK_PILL)
    await clickBoxButton(tab, 'Track')
    await sleep(1500)
    assert.equal(asked(PAIRING_PAGE), 1)
    const added = (await storedOption(tab)).lists.at(-1)
    assert.equal(added.type, 'relationship')
    assert.equal(added.entity, 'Draco Malfoy/Harry Potter')
    assert.equal(added.alias, 'Relationship: Draco Malfoy/Harry Potter')
  })

  test('an uncommon tag\'s page says its own category', async () => {
    const before = requests.length
    await visit(tab, `${ARCHIVE}/tags/marriage%20problems`)
    await openBox(tab)
    // Titled as readers name an additional tag, so only what's stored shows the category was read.
    assert.equal(await tab.$eval(TITLE_INPUT, el => el.value), 'Tag: marriage problems')
    assert.deepEqual(requests.slice(before).map(url => new URL(url).pathname), ['/tags/marriage%20problems'], 'only the page itself')
    await clickBoxButton(tab, 'Track')
    await sleep(1500)
    const added = (await storedOption(tab)).lists.at(-1)
    assert.equal(added.type, 'freeform')
    assert.equal(added.alias, 'Tag: marriage problems')
  })

  test('a series\' page gives its title', async () => {
    await visit(tab, `${ARCHIVE}/series/5151`)
    await openBox(tab)
    assert.equal(await tab.$eval(TITLE_INPUT, el => el.value), 'Series: Another Way Entirely')
  })

  test('a list that reads "Tag" learns its category on its own page, with nothing fetched', async () => {
    const before = requests.length
    await visit(tab, `${ARCHIVE}/tags/Ron%20Weasley/works`)
    await sleep(800)
    const ron = await list('ron')
    assert.equal(ron.type, 'character')
    assert.equal(ron.entity, 'Ron Weasley')
    assert.equal(ron.alias, 'Ron', 'the title is the reader\'s, and stays')
    assert.deepEqual(requests.slice(before).map(url => new URL(url).pathname), ['/tags/Ron%20Weasley/works'])
    await tab.click('.AO3E--filter-toolbar--fab')
    await sleep(300)
    assert.equal(await pillText(tab), 'Tracked as “Ron”')
  })

  test('a series that reads as its id learns its title on its own page', async () => {
    await visit(tab, `${ARCHIVE}/series/4242`)
    await sleep(800)
    const series = await list('lway')
    assert.equal(series.type, 'series')
    assert.equal(series.entity, 'The Long Way Round')
    assert.equal(series.alias, 'Long way')
  })
})

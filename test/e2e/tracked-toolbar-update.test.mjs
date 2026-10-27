import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { normalizeTrackedUrl, utcToday } from '../../src/common/trackedLists.ts'
import { mentions } from '../facts.mjs'
import { ensureBuilt, findChrome } from './helpers.mjs'
import { until } from './optionsPage.mjs'
import {
  ARCHIVE,
  boxActions,
  boxWarnings,
  clickBoxAction,
  diffLines,
  launch,
  LIST_CHOOSER,
  listingPage,
  navigateBy,
  openBox,
  openTab,
  openToolbar,
  pillRow,
  pillText,
  refiningMark,
  rerun,
  searchPage,
  storedOption,
  TITLE_INPUT,
  toastNamed,
  TRACK_BOX,
  visit,
} from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const TODAY = utcToday()

const HP_ID = 'Harry Potter - J*d* K*d* Rowling'
const HP_PATH = '/tags/Harry%20Potter%20-%20J*d*%20K*d*%20Rowling/works'
const HP_QUERY = 'tag_id=Harry+Potter+-+J*d*+K*d*+Rowling'

/** Harry Potter without Draco Malfoy. */
const NO_DRACO = { id: 'nodraco', kind: 'works-filter', url: `${HP_PATH}?exclude_work_search[character_ids][]=1234`, alias: 'Harry Potter, no Draco', type: 'fandom', entity: 'Harry Potter - J. K. Rowling', tracked: true, since: TODAY - 15 }
/** Harry Potter, complete works only: the same root, filtered another way. */
const COMPLETE = { id: 'hpdone', kind: 'works-filter', url: `${HP_PATH}?work_search[complete]=T`, alias: 'Harry Potter, complete', tracked: true, since: TODAY - 30 }
/** Another fandom altogether, which no Harry Potter page is ever offered as. */
const SHERLOCK = { id: 'sherl', kind: 'works-filter', url: '/tags/Sherlock%20(TV)/works', alias: 'Sherlock', tracked: true, since: TODAY - 3 }

/** The record a browser keeps of a list it took from another browser's entry and has done nothing to. */
function mirrorOf({ id, kind, url, alias, type, entity }) {
  return { id, kind, url, title: alias, type, entity, mirror: true }
}

const SEED = {
  'option.trackedLists': { enabled: true, target: 40, reviewedThrough: 0, lists: [NO_DRACO, COMPLETE, SHERLOCK] },
  'option.savedLists': { v: 1, lists: { nodraco: mirrorOf(NO_DRACO) } },
}

function route(url) {
  if (url.pathname === HP_PATH || (url.pathname === '/works' && url.searchParams.get('tag_id') === HP_ID))
    return listingPage(url, { tagId: HP_ID })
  return null
}

/** The pill is in `row`, and names the list `title`. */
async function pillIs(tab, row, title) {
  assert.equal(await pillRow(tab), row)
  assert.ok(mentions(await pillText(tab), title), `the pill should name ${title}`)
}

/** Whether each line of the box's diff names its own one of `names`, in order. */
async function diffNames(tab, names) {
  const lines = await diffLines(tab)
  assert.equal(lines.length, names.length, JSON.stringify(lines))
  lines.forEach((line, i) => assert.ok(mentions(line, names[i]), `${line} should name ${names[i]}`))
}

/** The chooser's lists, and which is picked. */
const chooser = tab => tab.$eval(LIST_CHOOSER, select => ({
  options: [...select.options].map(option => option.textContent.trim()),
  value: select.value,
}))

/**
 * Arriving at a list's page some other way than its refining link — by a tag in
 * a blurb, from history, by editing the address — where the only thing tying
 * the page to a list is what it searches. A page that shares a root with lists
 * without being any of them offers to update one of them, or to go and refine one
 * from its own page, or to track itself as a new list.
 */
describe('tracked lists: updating a list the page shares a root with', { skip }, () => {
  let browser
  let tab

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
    tab = await openTab(browser, { seed: SEED, route })
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  const list = async id => (await storedOption(tab)).lists.find(one => one.id === id)

  /** Both of the tracked exclusions: one more than the list has. */
  const BOTH_OUT = `${ARCHIVE}/works?exclude_work_search%5Bcharacter_ids%5D%5B%5D=1234&exclude_work_search%5Bcharacter_ids%5D%5B%5D=5678&${HP_QUERY}`

  test('a page no list is, but two share the root of, offers to track or update', async () => {
    await visit(tab, BOTH_OUT)
    await openBox(tab)
    assert.equal(await pillRow(tab), 'same-root:nodraco,hpdone')
    assert.deepEqual(await boxActions(tab), ['update', 'refine', 'track', 'cancel'], 'update or refine a list, or track the page as a new one')
  })

  test('the lists to update are chosen between by title, and only those with the root', async () => {
    const got = await chooser(tab)
    assert.deepEqual(got.options, ['Harry Potter, complete', 'Harry Potter, no Draco'])
    assert.equal(got.value, 'hpdone')
    const [excludes, completion, ...more] = await diffLines(tab)
    assert.deepEqual(more, [])
    assert.ok(mentions(excludes, 'Draco Malfoy') && mentions(excludes, 'Ron Weasley'), excludes)
    assert.ok(completion, 'and the completion it no longer asks for')
    for (const action of ['update', 'refine'])
      assert.ok(mentions(await tab.$eval(`${TRACK_BOX} [data-ao3e-action="${action}"]`, el => el.textContent), 'Harry Potter, complete'), `${action} names the list picked`)
  })

  test('choosing another list says what updating that one would change', async () => {
    await tab.select(LIST_CHOOSER, 'nodraco')
    await diffNames(tab, ['Ron Weasley'])
    assert.ok(mentions(await tab.$eval(`${TRACK_BOX} [data-ao3e-action="update"]`, el => el.textContent), 'Harry Potter, no Draco'), 'update names the list picked')
  })

  test('Update rewrites that list in place, keeping its tracking start', async () => {
    await rerun(tab, () => clickBoxAction(tab, 'update'))
    const updated = await list('nodraco')
    assert.equal(updated.url, normalizeTrackedUrl(BOTH_OUT).url)
    assert.equal(updated.tracked, true)
    assert.equal(updated.since, NO_DRACO.since)
    assert.equal(updated.alias, NO_DRACO.alias)
    // The other list with the root keeps its query. The only thing that has
    // changed about it is what the page's blurbs said about its root, which it
    // didn't know: that the tag is a fandom.
    assert.deepEqual(await list('hpdone'), { ...COMPLETE, type: 'fandom', entity: 'Harry Potter - J. K. Rowling' })
    assert.deepEqual(await list('sherl'), SHERLOCK)
    assert.ok(mentions((await toastNamed(tab, 'updated'))?.message ?? '', 'Harry Potter, no Draco'), 'the update is said, naming the list')
    assert.equal(await refiningMark(tab), null, 'nothing was being refined, and nothing is now')

    // The page is that list now.
    await openToolbar(tab)
    await pillIs(tab, 'exact:nodraco', 'Harry Potter, no Draco')
  })

  /**
   * The list came from another browser, so its record here was only a mirror,
   * which goes when tracking stops over there. Changed here, it is this
   * browser's own list too, and stays saved.
   */
  test('the update is this browser\'s own: the list\'s record follows it, and is no longer a mirror', async () => {
    const updated = await list('nodraco')
    const { mirror, ...record } = mirrorOf(updated)
    assert.equal(mirror, true)
    assert.deepEqual((await storedOption(tab, 'savedLists')).lists.nodraco, record)
  })

  test('Refine opens the chosen list\'s own page, refining it', async () => {
    await visit(tab, `${ARCHIVE}${HP_PATH}?work_search%5Blanguage_id%5D=en`)
    await openBox(tab)
    assert.equal(await pillRow(tab), 'same-root:nodraco,hpdone')
    assert.equal((await chooser(tab)).value, 'hpdone')
    await navigateBy(tab, () => clickBoxAction(tab, 'refine'))

    assert.equal(await tab.evaluate(() => location.href), `${ARCHIVE}${COMPLETE.url}`)
    assert.deepEqual(await refiningMark(tab), { id: 'hpdone', restore: true })
    await openBox(tab)
    await pillIs(tab, 'refining:hpdone:same', 'Harry Potter, complete')
  })

  test('an update that would duplicate another list is refused, and says which', async () => {
    // The page the other list now is: while refining, the refining row wins,
    // so the update is offered — and warned about.
    await visit(tab, BOTH_OUT)
    await openBox(tab)
    await pillIs(tab, 'refining:hpdone:changed', 'Harry Potter, complete')
    assert.deepEqual(await boxWarnings(tab), ['twin'])
    assert.ok(mentions(await tab.$eval(`${TRACK_BOX} [data-ao3e-warn="twin"]`, el => el.textContent), 'Harry Potter, no Draco'), 'the warning names the list it would duplicate')

    const before = await storedOption(tab)
    await clickBoxAction(tab, 'update')
    const refusal = () => toastNamed(tab, 'refused-duplicate')
    await until('the refusal', refusal)
    assert.deepEqual(await storedOption(tab), before, 'nothing is written')
    const said = (await refusal()).message
    for (const fact of ['Harry Potter, no Draco', 'Fandom: Harry Potter - J. K. Rowling', 'Harry Potter, complete'])
      assert.ok(mentions(said, fact), `the refusal names ${fact}: ${said}`)
    assert.deepEqual(await refiningMark(tab), { id: 'hpdone', restore: true }, 'and the tab is still refining')
  })

  test('Track makes a new list, titled for what it searches', async () => {
    await clickBoxAction(tab, 'stop-refining')
    await visit(tab, `${ARCHIVE}/works?work_search%5Bcomplete%5D=F&${HP_QUERY}`)
    await openBox(tab)
    assert.match(await pillRow(tab), /^same-root:/)
    // The category comes from the blurbs, which file the fandom in their heading.
    assert.equal(await tab.$eval(TITLE_INPUT, el => el.value), 'Fandom: Harry Potter - J. K. Rowling')
    await rerun(tab, () => clickBoxAction(tab, 'track'))
    const lists = (await storedOption(tab)).lists
    assert.equal(lists.length, 4)
    const added = lists.at(-1)
    assert.equal(added.alias, 'Fandom: Harry Potter - J. K. Rowling')
    assert.equal(added.type, 'fandom')
    assert.equal(added.url, `/works?work_search[complete]=F&${HP_QUERY}`)
    assert.equal(added.since, TODAY)
  })
})

/**
 * A works search made on the Search Works form with its "Any Field" box left
 * empty, a fandom and a character, tracked under its default title. It has no
 * words to be a search of, so it's a search of its fandom.
 */
const HP_SEARCH = {
  id: 'hpsrch',
  kind: 'text-search',
  url: normalizeTrackedUrl(`${ARCHIVE}/works/search?work_search[fandom_names]=Harry+Potter+-+J.+K.+Rowling&work_search[character_names]=Draco+Malfoy`).url,
  alias: 'Search: Harry Potter - J. K. Rowling',
  type: 'search',
  entity: 'Harry Potter - J. K. Rowling',
  tracked: true,
  since: TODAY - 12,
}

/** The form's submit: every field it has, the empty ones too, with the character swapped for another. */
const RON_INSTEAD = `${ARCHIVE}/works/search?utf8=%E2%9C%93&commit=Search&work_search%5Bquery%5D=&work_search%5Btitle%5D=&work_search%5Bcreators%5D=`
  + '&work_search%5Bfandom_names%5D=Harry+Potter+-+J.+K.+Rowling&work_search%5Bcharacter_names%5D=Ron+Weasley&work_search%5Bcomplete%5D='

/**
 * The same, for a works search with no words: back on the form, the reader edits
 * a field other than the one it's a search of, and submits. Nothing marks the tab
 * as refining the list, so the pill knows the page only by what it searches.
 */
describe('tracked lists: updating a works search without words from an edited search', { skip }, () => {
  let browser
  let tab

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
    tab = await openTab(browser, {
      seed: { 'option.trackedLists': { enabled: true, target: 40, reviewedThrough: 0, lists: [HP_SEARCH] } },
      route: url => (url.pathname === '/works/search' ? searchPage(url) : null),
    })
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  test('the same fandom with another character offers to update the list it came from', async () => {
    await visit(tab, RON_INSTEAD)
    assert.equal(await refiningMark(tab), null)
    await openBox(tab)
    assert.equal(await pillRow(tab), 'same-root:hpsrch')
    assert.ok(mentions(await tab.$eval(TRACK_BOX, el => el.textContent), HP_SEARCH.alias), 'the box names the list it would update')
    assert.deepEqual(await boxWarnings(tab), [], 'the list keeps its root')
    await diffNames(tab, ['Ron Weasley', 'Draco Malfoy'])
    assert.deepEqual(await boxActions(tab), ['update', 'refine', 'track', 'cancel'])
  })

  test('Update rewrites it in place, as the search it now is', async () => {
    await rerun(tab, () => clickBoxAction(tab, 'update'))
    const lists = (await storedOption(tab)).lists
    assert.equal(lists.length, 1)
    assert.deepEqual(lists[0], {
      ...HP_SEARCH,
      url: '/works/search?work_search[fandom_names]=Harry+Potter+-+J.+K.+Rowling&work_search[character_names]=Ron+Weasley',
    })
    await openToolbar(tab)
    await pillIs(tab, 'exact:hpsrch', HP_SEARCH.alias)
  })

  test('another fandom with the same character is no list\'s', async () => {
    await visit(tab, `${ARCHIVE}/works/search?work_search%5Bfandom_names%5D=Sherlock+%28TV%29&work_search%5Bcharacter_names%5D=Ron+Weasley`)
    await openBox(tab)
    assert.equal(await pillRow(tab), 'new')
    assert.equal(await tab.$eval(TITLE_INPUT, el => el.value), 'Search: Sherlock (TV)')
  })
})

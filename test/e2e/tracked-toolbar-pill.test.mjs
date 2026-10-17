import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { DIST, ensureBuilt, findChrome, installMock, launch } from './helpers.mjs'
import { openToolbar, rerun, settled } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const SEARCH_URL = 'https://archiveofourown.org/works/search?work_search%5Bquery%5D=coffee&page=2'
const LATER_URL = 'https://archiveofourown.org/users/someone/readings?show=to-read'

const TRACK_PILL = '.AO3E--filter-toolbar--track button'
const TRACK_TEXT = '.AO3E--filter-toolbar--track--text'
const TRACK_BOX = '.AO3E--filter-toolbar--track--box'
const ALIAS_INPUT = '.AO3E--filter-toolbar--track--alias'

/** The signed-in header `parseUser` reads the reader's own id out of. */
const HEADER = `
  <div id="header">
    <ul class="user navigation actions">
      <li><a href="/users/someone/preferences">someone</a></li>
    </ul>
  </div>`

function blurb(id, title) {
  return `
    <li class="work blurb group" id="work_${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">${title}</a>
          by <a rel="author" href="/users/other/pseuds/other">other</a></h4>
      </div>
      <p class="datetime">14 Sep 2026</p>
    </li>`
}

/** A works-search results page: the count heading, the results, the pagination. */
const SEARCH_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Search Works</title></head>
<body>
  ${HEADER}
  <div id="main" class="works-search region">
    <h2 class="heading">Search Works</h2>
    <h3 class="heading">146,449 Found</h3>
    <ul class="navigation actions"><li><a href="?edit_search=true">Edit Your Search</a></li></ul>
    <ol class="work index group">${blurb(101, 'A coffee shop AU')}${blurb(102, 'Another one')}</ol>
    <ol role="navigation" class="pagination actions">
      <li><a href="?page=1">1</a></li><li><span class="current">2</span></li>
    </ol>
  </div>
</body></html>`

/** Marked for Later — the reader's own choices, so never trackable. */
const LATER_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Marked for Later</title></head>
<body>
  ${HEADER}
  <div id="main" class="reading works-index region">
    <h2 class="heading">someone's Marked for Later</h2>
    <ul class="navigation actions"><li><a href="?show=to-read">Marked for Later</a></li></ul>
    <ol class="reading work index group">${blurb(201, 'Saved for later')}</ol>
  </div>
</body></html>`

/**
 * The floating toolbar's "Track this search" pill: making a tracked list out of
 * the page the reader is on, the two things they can do to one afterwards, and
 * tracking a saved list from its page again.
 *
 * Every state the pill shows is read back out of the saved option — a write
 * re-runs every unit, which rebuilds the toolbar — so this drives it the way a
 * reader would, a click at a time, and checks both what was stored and what the
 * rebuilt pill then says.
 *
 * Real pointer clicks throughout, including the ones that land while the toast
 * raised by the previous write is still up: the toast shares this corner with
 * the toolbar, and pressing the next pill without waiting for it to go is the
 * ordinary case. That the two can share the corner is pinned down in
 * `visual/filter-toolbar-hit-area`.
 */
describe('the toolbar\'s tracked-list pill', { skip }, () => {
  let browser
  let css
  let js

  before(async () => {
    ensureBuilt()
    css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  const load = async (url, body, seed = {}) => {
    const tab = await browser.newPage()
    await tab.setViewport({ width: 1280, height: 900 })
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (!req.url().startsWith('https://archiveofourown.org/'))
        return void req.abort()
      void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body })
    })
    await tab.evaluateOnNewDocument(installMock, seed)
    await tab.goto(url, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await settled(tab)
    return tab
  }

  /** Open the collapsed toolbar. Every re-run rebuilds it shut. */
  const openPanel = openToolbar

  /** Press the pill, and wait for its box to open or shut as it says. */
  const pressPill = async (tab, open) => {
    await tab.click(TRACK_PILL)
    await tab.waitForFunction((selector, shown) => document.querySelector(selector)?.hidden === !shown, {}, TRACK_BOX, open)
  }

  /** An option as it was last written, or null: `trackedLists` unless told otherwise. */
  const savedOption = (tab, name = 'trackedLists') => tab.evaluate((key) => {
    const writes = window.__writes ?? []
    for (let i = writes.length - 1; i >= 0; i--) {
      if (key in writes[i])
        return writes[i][key]
    }
    return null
  }, `option.${name}`)

  const TODAY = Math.floor(Date.now() / 86_400_000)

  const pillText = tab => tab.$eval(TRACK_TEXT, el => el.textContent.trim())

  /** The messages of the toasts on screen. */
  const toasts = tab => tab.evaluate(() => [...document.querySelectorAll('body > div')]
    .flatMap(el => [...el.shadowRoot?.querySelectorAll('.toast .message') ?? []])
    .map(el => el.textContent.trim()))

  let tab

  test('a works search offers to be tracked', async () => {
    tab = await load(SEARCH_URL, SEARCH_PAGE)
    await openPanel(tab)
    assert.equal(await pillText(tab), 'Track this search')
    // Nothing is written until the reader says so.
    assert.equal(await savedOption(tab), null)
  })

  test('the pill grows a title box, filled in from the page', async () => {
    assert.equal(await tab.$eval(TRACK_BOX, el => el.hidden), true, 'the box starts closed')
    await pressPill(tab, true)
    // What kind of list it is, and the words the reader searched for — a name
    // they have just seen.
    assert.equal(await tab.$eval(ALIAS_INPUT, el => el.value), 'Search: coffee')
  })

  test('Cancel closes it again, having written nothing', async () => {
    await tab.click(`${TRACK_BOX} button:last-of-type`)
    assert.equal(await tab.$eval(TRACK_BOX, el => el.hidden), true)
    assert.equal(await savedOption(tab), null)
    // …and it reopens with the name still there.
    await pressPill(tab, true)
    assert.equal(await tab.$eval(ALIAS_INPUT, el => el.value), 'Search: coffee')
  })

  test('Track stores the list under the reader\'s own name for it', async () => {
    await tab.$eval(ALIAS_INPUT, (el) => {
      el.value = 'Coffee shop AUs'
    })
    await rerun(tab, () => tab.click(`${TRACK_BOX} button:first-of-type`))

    const saved = await savedOption(tab)
    assert.ok(saved, 'the option should have been written')
    assert.equal(saved.lists.length, 1)
    const entry = saved.lists[0]
    assert.equal(entry.kind, 'text-search')
    assert.equal(entry.alias, 'Coffee shop AUs')
    // What it is is kept apart from what the reader calls it.
    assert.equal(entry.type, 'search')
    assert.equal(entry.entity, 'coffee')
    assert.equal(entry.tracked, true)
    // The stored address is the query alone: `page` is not part of what a list is.
    assert.equal(entry.url, '/works/search?work_search[query]=coffee')
    assert.match(entry.id, /^[a-z0-9]+$/)
    // Tracking starts today, on the archive's calendar — the UTC one its date
    // filters work in.
    assert.equal(entry.since, TODAY)
    // Everything else about the option is left as it was.
    assert.equal(saved.enabled, true)
    assert.equal(saved.target, 40)
    assert.equal(saved.reviewedThrough, 0)
    // The list is this browser's saved list too, under the same id and title.
    const records = await savedOption(tab, 'savedLists')
    assert.deepEqual(records.lists[entry.id], { id: entry.id, kind: 'text-search', url: entry.url, title: 'Coffee shop AUs', type: 'search', entity: 'coffee' })
  })

  test('the rebuilt pill says the page is tracked, and by what name', async () => {
    await openPanel(tab)
    assert.equal(await pillText(tab), 'Tracked as “Coffee shop AUs”')
    assert.equal(await tab.$eval(TRACK_PILL, el => el.getAttribute('aria-pressed')), 'true')
  })

  test('it offers a way to stop, and a way through to the review', async () => {
    await pressPill(tab, true)
    const actions = await tab.$$eval(`${TRACK_BOX} a, ${TRACK_BOX} button`, els =>
      els.map(el => ({ text: el.textContent.trim(), href: el.getAttribute('href') })))
    assert.deepEqual(actions.map(a => a.text), ['Stop tracking', 'Review…'])
    // The review lives on the reader's own readings page, and is linkable.
    assert.equal(actions[1].href, 'https://archiveofourown.org/users/someone/readings#ao3e-tracked')
  })

  let id

  test('Stop tracking takes the list out of what syncs, and keeps it saved', async () => {
    id = (await savedOption(tab)).lists[0].id
    await rerun(tab, () => tab.click(`${TRACK_BOX} button`))
    assert.deepEqual((await savedOption(tab)).lists, [], 'the entry goes')
    assert.equal((await savedOption(tab, 'savedLists')).lists[id].title, 'Coffee shop AUs', 'and the saved list keeps its title')
    assert.ok((await toasts(tab)).includes('Stopped tracking “Coffee shop AUs”. It stays a saved list on this browser.'))
  })

  test('the pill then offers to track that saved list, and does it in one click, under its own id', async () => {
    await openPanel(tab)
    assert.equal(await pillText(tab), 'Track “Coffee shop AUs”')
    assert.equal(await tab.$eval(TRACK_PILL, el => el.getAttribute('aria-pressed')), 'false')
    // No box: the list already has its title.
    assert.equal(await tab.$(TRACK_BOX), null)

    await rerun(tab, () => tab.click(TRACK_PILL))
    const [entry] = (await savedOption(tab)).lists
    assert.equal(entry.id, id)
    assert.equal(entry.alias, 'Coffee shop AUs')
    assert.equal(entry.tracked, true)
    // Tracking starts the clock again, so the stretch it wasn't tracked is not filled back in.
    assert.equal(entry.since, TODAY)

    await openPanel(tab)
    assert.equal(await pillText(tab), 'Tracked as “Coffee shop AUs”')
    await tab.close()
  })

  test('Track this search tracks the saved list the page already is, read when it is pressed', async () => {
    const page = await load(SEARCH_URL, SEARCH_PAGE)
    // Opening the search view stores a copy, and the background gives it a
    // record — after the page was drawn, and without drawing it again.
    const auto = { id: 'aut0', kind: 'text-search', url: '/works/search?work_search[query]=coffee', title: '', type: 'search', entity: 'coffee' }
    await page.evaluate(record => window.browser.storage.local.set({ 'option.savedLists': { v: 1, lists: { [record.id]: record } } }), auto)
    await openPanel(page)
    assert.equal(await pillText(page), 'Track this search')
    await pressPill(page, true)
    await rerun(page, () => page.click(`${TRACK_BOX} button:first-of-type`))

    assert.deepEqual((await savedOption(page)).lists.map(entry => entry.id), ['aut0'], 'no second list at its address')
    assert.deepEqual((await savedOption(page, 'savedLists')).lists, { aut0: { ...auto, title: 'Search: coffee' } })
    await page.close()
  })

  test('Marked for Later is never offered — those works are the reader\'s own choices', async () => {
    const later = await load(LATER_URL, LATER_PAGE)
    await openPanel(later)
    assert.equal(await later.$('.AO3E--filter-toolbar--track'), null, 'no tracking pill on Marked for Later')
    // The toolbar itself is still there, so this is the pill's absence and not the
    // toolbar failing to render at all.
    assert.notEqual(await later.$('.AO3E--filter-toolbar--fab'), null)
    await later.close()
  })

  test('the whole feature can be switched off', async () => {
    const off = await load(SEARCH_URL, SEARCH_PAGE, {
      'option.trackedLists': { enabled: false, target: 40, reviewedThrough: 0, lists: [] },
    })
    await openPanel(off)
    assert.equal(await off.$('.AO3E--filter-toolbar--track'), null)
    await off.close()
  })
})

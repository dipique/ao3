import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

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
 * the page the reader is on, and the two things they can do to one afterwards.
 *
 * Every state the pill shows is read back out of the saved option — a write
 * re-runs every unit, which rebuilds the toolbar — so this drives it the way a
 * reader would, a click at a time, and checks both what was stored and what the
 * rebuilt pill then says.
 */
describe('the toolbar\'s tracked-list pill', { skip }, () => {
  let browser
  let css
  let js

  before(async () => {
    ensureBuilt()
    css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-first-run', '--no-default-browser-check'],
    })
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
    await sleep(1200)
    return tab
  }

  /**
   * A click dispatched on the element itself rather than at its coordinates.
   *
   * Every write puts a toast up, and a toast is fixed to the bottom-right corner
   * over the toolbar that is also there — so a real pointer click lands on the
   * toast for as long as it is up. That the toolbar's own controls are reachable
   * by pointer is what `filter-toolbar-hit-area` is for; this file is about which
   * state the pill is in, and it drives the states from the first click after
   * each write rather than waiting seconds for a toast to expire.
   */
  const clickEl = (tab, selector) => tab.$eval(selector, el => el.click())

  /** Open the collapsed toolbar. Every re-run rebuilds it shut. */
  const openPanel = async (tab, real = false) => {
    if (real)
      await tab.click('.AO3E--filter-toolbar--fab')
    else
      await clickEl(tab, '.AO3E--filter-toolbar--fab')
    await sleep(300)
  }

  /** The `trackedLists` option as it was last written, or null. */
  const savedOption = tab => tab.evaluate(() => {
    const writes = window.__writes ?? []
    for (let i = writes.length - 1; i >= 0; i--) {
      if ('option.trackedLists' in writes[i])
        return writes[i]['option.trackedLists']
    }
    return null
  })

  const pillText = tab => tab.$eval(TRACK_TEXT, el => el.textContent.trim())

  let tab

  test('a works search offers to be tracked', async () => {
    tab = await load(SEARCH_URL, SEARCH_PAGE)
    // A real pointer click, since nothing is covering the toolbar yet.
    await openPanel(tab, true)
    assert.equal(await pillText(tab), 'Track this search')
    // Nothing is written until the reader says so.
    assert.equal(await savedOption(tab), null)
  })

  test('the pill grows a name box, filled in from the page', async () => {
    assert.equal(await tab.$eval(TRACK_BOX, el => el.hidden), true, 'the box starts closed')
    await clickEl(tab, TRACK_PILL)
    await sleep(200)
    assert.equal(await tab.$eval(TRACK_BOX, el => el.hidden), false)
    // The words the reader searched for — a name they have just seen.
    assert.equal(await tab.$eval(ALIAS_INPUT, el => el.value), 'coffee')
  })

  test('Cancel closes it again, having written nothing', async () => {
    await clickEl(tab, `${TRACK_BOX} button:last-of-type`)
    await sleep(200)
    assert.equal(await tab.$eval(TRACK_BOX, el => el.hidden), true)
    assert.equal(await savedOption(tab), null)
    // …and it reopens with the name still there.
    await clickEl(tab, TRACK_PILL)
    await sleep(200)
    assert.equal(await tab.$eval(TRACK_BOX, el => el.hidden), false)
  })

  test('Track stores the list under the reader\'s own name for it', async () => {
    await tab.$eval(ALIAS_INPUT, (el) => {
      el.value = 'Coffee shop AUs'
    })
    await clickEl(tab, `${TRACK_BOX} button:first-of-type`)
    await sleep(1500)

    const saved = await savedOption(tab)
    assert.ok(saved, 'the option should have been written')
    assert.equal(saved.lists.length, 1)
    const entry = saved.lists[0]
    assert.equal(entry.kind, 'text-search')
    assert.equal(entry.alias, 'Coffee shop AUs')
    assert.equal(entry.tracked, true)
    // The stored address is the query alone: `page` is not part of what a list is.
    assert.equal(entry.url, '/works/search?work_search[query]=coffee')
    assert.match(entry.id, /^[a-z0-9]+$/)
    // Tracking starts today, on the archive's calendar — the UTC one its date
    // filters work in.
    assert.equal(entry.since, Math.floor(Date.now() / 86_400_000))
    // Everything else about the option is left as it was.
    assert.equal(saved.enabled, true)
    assert.equal(saved.target, 40)
    assert.equal(saved.reviewedThrough, 0)
  })

  test('the rebuilt pill says the page is tracked, and by what name', async () => {
    await openPanel(tab)
    assert.equal(await pillText(tab), 'Tracked as “Coffee shop AUs”')
    assert.equal(await tab.$eval(TRACK_PILL, el => el.getAttribute('aria-pressed')), 'true')
  })

  test('it offers a way to stop, and a way through to the review', async () => {
    await clickEl(tab, TRACK_PILL)
    await sleep(200)
    const actions = await tab.$$eval(`${TRACK_BOX} a, ${TRACK_BOX} button`, els =>
      els.map(el => ({ text: el.textContent.trim(), href: el.getAttribute('href') })))
    assert.deepEqual(actions.map(a => a.text), ['Stop tracking', 'Review…'])
    // The review lives on the reader's own readings page, and is linkable.
    assert.equal(actions[1].href, 'https://archiveofourown.org/users/someone/readings#ao3e-tracked')
  })

  test('Stop tracking pauses the list without losing it', async () => {
    await clickEl(tab, `${TRACK_BOX} button`)
    await sleep(1500)
    const saved = await savedOption(tab)
    assert.equal(saved.lists.length, 1, 'the entry is kept, not removed')
    assert.equal(saved.lists[0].tracked, false)
    assert.equal(saved.lists[0].alias, 'Coffee shop AUs', 'and keeps its name')
  })

  test('the pill then offers to resume, and does it in one click', async () => {
    await openPanel(tab)
    assert.equal(await pillText(tab), 'Resume tracking “Coffee shop AUs”')
    assert.equal(await tab.$eval(TRACK_PILL, el => el.getAttribute('aria-pressed')), 'false')
    // No box: resuming needs nothing from the reader.
    assert.equal(await tab.$(TRACK_BOX), null)

    await clickEl(tab, TRACK_PILL)
    await sleep(1500)
    const saved = await savedOption(tab)
    assert.equal(saved.lists[0].tracked, true)
    // Resuming restarts the clock, so the paused stretch is not filled back in.
    assert.equal(saved.lists[0].since, Math.floor(Date.now() / 86_400_000))

    await openPanel(tab)
    assert.equal(await pillText(tab), 'Tracked as “Coffee shop AUs”')
    await tab.close()
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

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep, storedListIds } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const SERIES_ID = '2829268'
const SERIES_URL = `https://archiveofourown.org/series/${SERIES_ID}`
const SEED = { 'option.searchSeriesWorks': true }

/** Pages of works AO3 would page through; 5 per page, distinct ids and titles. */
const PAGES = 3
const PER_PAGE = 5

function blurb(id, title) {
  return `
    <li class="work blurb group" id="work_${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">${title}</a>
          by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4>
        <h5 class="fandoms heading"><a class="tag" href="/tags/F/works">A Fandom</a></h5>
      </div>
      <ul class="tags commas"><li class="freeforms"><a class="tag" href="/tags/Fluff/works">Fluff</a></li></ul>
      <dl class="stats">
        <dt class="words">Words:</dt><dd class="words">7,150</dd>
        <dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd>
      </dl>
    </li>`
}

function pagination(current) {
  const items = Array.from({ length: PAGES }, (_, i) => i + 1)
    .map(n => (n === current ? `<li><span class="current">${n}</span></li>` : `<li><a href="?page=${n}">${n}</a></li>`))
    .join('')
  return `<ol role="navigation" class="pagination actions">${items}</ol>`
}

/**
 * A series page: the actions row AO3 puts "Bookmark Series" in, the series' own
 * metadata, then its works between two pagination blocks.
 */
function seriesPage(page, works) {
  const start = (page - 1) * PER_PAGE + 1
  const listed = works ?? Array.from({ length: PER_PAGE }, (_, i) =>
    blurb(start + i, `Work number ${start + i}`)).join('')
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>A Series</title>
<style>body { font-family: Verdana, sans-serif; margin: 0 }</style></head>
<body>
  <div id="header"></div>
  <div id="main" class="series-show region">
    <h2 class="heading">A Very Long Series</h2>
    <ul class="navigation actions" role="navigation">
      <li><span class="current">Series</span></li>
      <li><form id="new_subscription" action="/users/someone/subscriptions" method="post">
        <input type="submit" name="commit" value="Subscribe" /></form></li>
      <li><a class="bookmark_form_placement_open" href="#bookmark-form">Bookmark Series</a></li>
    </ul>
    <h3 class="landmark heading">Series Metadata</h3>
    <div class="wrapper">
      <dl class="series meta group">
        <dt>Creator:</dt><dd><a rel="author" href="/users/someone/pseuds/someone">someone</a></dd>
        <dt>Series Begun:</dt><dd>2024-07-05</dd>
        <dt>Series Updated:</dt><dd>2026-06-16</dd>
        <dt class="stats">Stats:</dt>
        <dd class="stats">
          <dl class="stats">
            <dt class="words">Words:</dt><dd class="words">19,614</dd>
            <dt class="works">Works:</dt><dd class="works">${PAGES * PER_PAGE}</dd>
            <dt>Complete:</dt><dd>No</dd>
          </dl>
        </dd>
      </dl>
    </div>
    <h3 class="landmark heading">Listing Series</h3>
    ${pagination(page)}
    <ul class="series work index group">${listed}</ul>
    ${pagination(page)}
  </div>
</body></html>`
}

/** The same page for a series nothing has been posted to yet. */
const EMPTY_PAGE = seriesPage(1, '')

/**
 * Searching a series' works. AO3 lists a series as a plain paged list with no
 * sort or filter of any kind, however long the series runs; the unit offers to
 * pull that whole list into the in-memory search view instead.
 */
describe('search a series\' works', { skip }, () => {
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

  /** Load a series page with the content script running against it. */
  const load = async (url, body, seed = SEED) => {
    const tab = await browser.newPage()
    await tab.setViewport({ width: 1280, height: 900 })
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (!req.url().startsWith('https://archiveofourown.org/'))
        return void req.abort()
      const page = Number(new URL(req.url()).searchParams.get('page') ?? 1)
      const html = body ?? seriesPage(Number.isFinite(page) && page > 0 ? page : 1)
      void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
    })
    await tab.evaluateOnNewDocument(installMock, seed)
    await tab.goto(url, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await sleep(1200)
    return tab
  }

  /** Titles of the blurbs the view is currently showing. */
  const shownTitles = tab => tab.evaluate(() =>
    Array.from(document.querySelectorAll('.AO3E--search-view--results > li.blurb'))
      .filter(li => li.style.display !== 'none')
      .map(li => li.querySelector('.header h4.heading a')?.textContent?.trim()))

  let tab

  test('the offer sits in the series\' own row of actions', async () => {
    tab = await load(SERIES_URL)
    const found = await tab.evaluate(() => {
      const button = document.querySelector('.AO3E--search-series-works--button')
      if (!button)
        return null
      const items = Array.from(button.closest('ul.navigation.actions').children)
      return {
        text: button.textContent.trim(),
        // Appended after the row's last native action, which is the bookmark link.
        after: items[items.indexOf(button.closest('li')) - 1]?.textContent.trim(),
      }
    })
    assert.ok(found, 'the button should be added')
    assert.equal(found.text, 'Search these works')
    assert.equal(found.after, 'Bookmark Series')
  })

  test('clicking it loads every page into one view', async () => {
    await tab.click('.AO3E--search-series-works--button')
    await sleep(2500)
    const titles = await shownTitles(tab)
    assert.equal(titles.length, PAGES * PER_PAGE, 'every page of works should be in the view')
    assert.deepEqual(
      titles,
      Array.from({ length: PAGES * PER_PAGE }, (_, i) => `Work number ${i + 1}`),
      'in the order the series lists them',
    )
  })

  test('the native list, its paging and the button are hidden while the view is up', async () => {
    const hidden = await tab.evaluate(() => ({
      list: getComputedStyle(document.querySelector('#main ul.series.work.index.group')).display,
      paging: Array.from(document.querySelectorAll('#main ol.pagination'))
        .map(ol => getComputedStyle(ol).display),
      // The whole action, not just the button: the CSS hides its `li`.
      button: getComputedStyle(document.querySelector('.AO3E--search-series-works--button').closest('li')).display,
      // The series' own details are not the listing, and stay put.
      meta: getComputedStyle(document.querySelector('#main dl.series.meta')).display,
    }))
    assert.equal(hidden.list, 'none')
    assert.deepEqual(hidden.paging, ['none', 'none'])
    assert.equal(hidden.button, 'none')
    assert.notEqual(hidden.meta, 'none')
  })

  test('the view sits between the series details and the paging', async () => {
    const placed = await tab.evaluate(() => {
      const view = document.querySelector('.AO3E--search-host')
      const meta = document.querySelector('#main dl.series.meta').closest('div.wrapper')
      const paging = document.querySelector('#main ol.pagination')
      return {
        beforePaging: view.nextElementSibling === paging,
        // DOCUMENT_POSITION_FOLLOWING: the view comes after the details block.
        afterMeta: (meta.compareDocumentPosition(view) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      }
    })
    assert.ok(placed.afterMeta, 'the view should follow the series details')
    assert.ok(placed.beforePaging, 'the view should sit right before the paging')
  })

  test('the works are cached under the series, and the layout under the feature', async () => {
    const stored = await tab.evaluate(() => {
      const writes = window.__writes ?? []
      let snapshots = null
      for (let i = writes.length - 1; i >= 0 && !snapshots; i--)
        snapshots = writes[i]['cache.searchLists'] ?? null
      return snapshots
    })
    assert.ok(stored, 'a snapshot should have been written')
    const key = `series-works:${SERIES_ID}`
    assert.ok(key in stored, `the snapshot should be keyed ${key}`)
    assert.equal(storedListIds(stored[key]).length, PAGES * PER_PAGE)
    // The options page has no `location` and no AO3 document, so everything a
    // refresh needs has to have been written down here.
    assert.deepEqual(stored[key].descriptor, {
      sourceId: 'series-works',
      label: 'Series: A Very Long Series',
      listUrl: SERIES_URL,
      // A series lists its works in a `ul`, not the `ol` every other listing
      // uses; a refresh must scope blurbs as we do.
      blurbSelector: 'ul.series.work.index.group > li.blurb',
    })
  })

  test('"Back to list" puts the native page back', async () => {
    await tab.click('.AO3E--search-view--back')
    await sleep(400)
    const restored = await tab.evaluate(() => ({
      view: document.querySelector('.AO3E--search-host'),
      list: getComputedStyle(document.querySelector('#main ul.series.work.index.group')).display,
      paging: getComputedStyle(document.querySelector('#main ol.pagination')).display,
      button: getComputedStyle(document.querySelector('.AO3E--search-series-works--button').closest('li')).display,
    }))
    assert.equal(restored.view, null, 'the view should be gone')
    assert.notEqual(restored.list, 'none')
    assert.notEqual(restored.paging, 'none')
    assert.notEqual(restored.button, 'none')
    await tab.close()
  })

  test('a series with nothing posted to it yet is left alone', async () => {
    const empty = await load(SERIES_URL, EMPTY_PAGE)
    assert.equal(await empty.$('.AO3E--search-series-works--button'), null, 'nothing to search')
    await empty.close()
  })

  test('only a series\' own page carries the button', async () => {
    // The same markup reached at another address is not the series listing.
    const work = await load('https://archiveofourown.org/works/57138619', seriesPage(1))
    assert.equal(await work.$('.AO3E--search-series-works--button'), null, 'not a series page')
    await work.close()
  })
})

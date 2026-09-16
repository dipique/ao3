import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const HISTORY_URL = 'https://archiveofourown.org/users/me/readings'
const TO_READ_URL = `${HISTORY_URL}?show=to-read`

/**
 * Every way a work can be taken out of a listing, switched on at once, over two
 * sets of four works that differ only in which list they sit on:
 *
 * - a rule that **hides** a tag outright (`Gone`)
 * - a rule that **collapses** one (`HideMe`)
 * - the language filter, set to drop anything but English
 * - a `read` mark configured to hide the works carrying it
 *
 * `hideShowReason` is off, so everything that isn't a rule hides outright rather
 * than collapsing — the harsher of the two, and the one a reader would notice as
 * a list that had quietly shrunk.
 *
 * Works 1–4 are the Marked for Later list and carry no verdict: one that did
 * would be pruned off that list by `belongs`, which is a different subject.
 * Works 5–8 are the history, and all four are marked read — so on the read list
 * the mark hiding its own works would empty the list outright.
 *
 * `5,1,1,1` is the packed form of ids 5–8: delta-encoded from 0, in base 36.
 */
const SEED = {
  'option.searchMarkedForLater': true,
  'option.searchReadWorks': true,
  'option.autoExcludeHidden': true,
  'option.hideShowReason': false,
  'option.hideLanguages': { enabled: true, show: [{ label: 'English' }] },
  'option.rules': {
    enabled: true,
    colors: {},
    filters: [
      { target: 'tag', value: 'Gone', matcher: 'exact', behavior: 'hide' },
      { target: 'tag', value: 'HideMe', matcher: 'exact', behavior: 'collapse' },
    ],
  },
  'option.workMarks': {
    enabled: true,
    marks: {
      read: { icon: 'read', label: 'Read', color: '#6b7280', hideSearchResult: true, items: '5,1,1,1', order: 0 },
      saved: { icon: 'saved', label: 'Marked for later', color: '#2f8f4e', order: 1 },
    },
  },
}

/** The four works, one per reason a listing might take one away. */
const WORKS = [
  { title: 'Hidden by a rule', tags: ['Gone'], language: 'English' },
  { title: 'Collapsed by a rule', tags: ['HideMe'], language: 'English' },
  { title: 'Wrong language', tags: [], language: 'Français' },
  { title: 'Nothing wrong with it', tags: [], language: 'English' },
]

const TITLES = WORKS.map(work => work.title)

function blurb(id, { title, tags, language }) {
  const tagList = tags
    .map(tag => `<li class="freeforms"><a class="tag" href="/tags/${encodeURIComponent(tag)}/works">${tag}</a></li>`)
    .join('')
  return `
    <li class="reading work blurb group" id="work_${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">${title}</a>
          by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4>
        <h5 class="fandoms heading"><a class="tag" href="/tags/F/works">A Fandom</a></h5>
      </div>
      <ul class="tags commas">${tagList}</ul>
      <dl class="stats">
        <dt class="language">Language:</dt><dd class="language">${language}</dd>
        <dt class="words">Words:</dt><dd class="words">7,150</dd>
        <dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd>
      </dl>
    </li>`
}

/** Either half of `/users/me/readings`: to-read holds works 1–4, history 5–8. */
function readingsPage({ toRead }) {
  const listed = WORKS.map((work, i) => blurb(i + (toRead ? 1 : 5), work)).join('')
  const subnav = toRead
    ? `<li><a href="/users/me/readings">History</a></li>
       <li><span class="current">Marked for Later</span></li>`
    : `<li><span class="current">History</span></li>
       <li><a href="/users/me/readings?show=to-read">Marked for Later</a></li>`
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${toRead ? 'Marked for Later' : 'History'}</title></head>
<body class="logged-in">
  <div id="header"><a href="/users/me/preferences">Preferences</a></div>
  <div id="main" class="readings-index dashboard region">
    <h2 class="heading">${toRead ? 'Marked for Later' : 'History'}</h2>
    <ul class="navigation actions" role="navigation">
      ${subnav}
      <li><a href="/users/me/readings/confirm_clear">Clear Entire History</a></li>
    </ul>
    <ol class="reading work index group">${listed}</ol>
  </div>
</body></html>`
}

/**
 * The two lists the reader assembled themselves — Marked for Later, and the
 * works they have marked read — show every work on them.
 *
 * Hiding earns its keep on a listing AO3 chose, where the reader is handed works
 * they never asked for. On a list they built work by work there is nothing left
 * for it to decide — they already said yes to each of these — and a list that
 * comes back four works long when they put six on it is the list lying about
 * itself. That is `SearchSource.hidesNothing`, and it covers every reason a work
 * can go: rules, marks, language, crossovers alike, plus the exclusions
 * `autoExcludeHidden` would otherwise hand the view's own filter, which take a
 * work off the list just as surely.
 *
 * The first test is the control — the same rules over the same works, on AO3's
 * own listing with the view switched off. Without it the rest of this file would
 * pass just as happily on a seed that never hid anything.
 */
describe('the lists the reader built themselves', { skip }, () => {
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

  /** Load a readings page with the content script running against it. */
  const load = async (url, seed = SEED) => {
    const tab = await browser.newPage()
    await tab.setViewport({ width: 1280, height: 900 })
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (!req.url().startsWith('https://archiveofourown.org/'))
        return void req.abort()
      void req.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: readingsPage({ toRead: new URL(req.url()).searchParams.get('show') === 'to-read' }),
      })
    })
    await tab.evaluateOnNewDocument(installMock, seed)
    await tab.goto(url, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await sleep(1500)
    return tab
  }

  /** How one listing's works came out, whoever drew the listing. */
  const stateOf = (tab, selector) => tab.evaluate((sel) => {
    const title = li => li.querySelector('.header h4.heading a')?.textContent?.trim()
    const blurbs = [...document.querySelectorAll(sel)]
    return {
      titles: blurbs.map(title),
      hidden: blurbs.filter(li => li.hidden).map(title),
      collapsed: blurbs.filter(li => li.querySelector('.AO3E--hide-works--msg')).map(title),
    }
  }, selector)

  const nativeState = tab => stateOf(tab, '#main ol.reading.work.index.group > li.blurb')
  const viewState = tab => stateOf(tab, '.AO3E--search-view--results > li.blurb')

  /** Facet values the view has excluded for the reader — `autoExcludeHidden`'s work. */
  const excluded = tab => tab.evaluate(() =>
    [...document.querySelectorAll('.AO3E--search-view--toggle-exclude')]
      .filter(btn => btn.getAttribute('aria-pressed') === 'true')
      .map(btn => btn.closest('.AO3E--search-view--row')?.querySelector('.AO3E--search-view--row-name')?.textContent?.trim()))

  test('on AO3’s own listing, all of this hides — the control', async () => {
    // The same page with the view switched off, so what is on screen is AO3's
    // own to-read listing under the content script's usual pass over it.
    const tab = await load(TO_READ_URL, { ...SEED, 'option.searchMarkedForLater': false })
    const native = await nativeState(tab)
    assert.deepEqual(native.titles, TITLES, 'AO3’s listing is the one on screen')
    assert.deepEqual(native.hidden, ['Hidden by a rule', 'Wrong language'])
    assert.deepEqual(native.collapsed, ['Collapsed by a rule'])
    await tab.close()
  })

  test('the Marked for Later view shows every work on the list', async () => {
    const tab = await load(TO_READ_URL)
    // The view opens by itself here; give the scrape and the first render time.
    await sleep(2000)
    const view = await viewState(tab)
    assert.deepEqual(view.titles, TITLES)
    assert.deepEqual(view.hidden, [], 'nothing is dropped from the results')
    assert.deepEqual(view.collapsed, [], 'and nothing is squeezed down to a reason line')
    assert.deepEqual(
      await excluded(tab),
      [],
      'nor is a reason handed to the view’s own filter, which would take the work away too',
    )
    await tab.close()
  })

  test('and so does the read view, marks and all', async () => {
    const tab = await load(HISTORY_URL)
    // History is not replaced, so the read list is opened from its button.
    await tab.click('.AO3E--search-read-works--button')
    await sleep(2500)
    const view = await viewState(tab)
    // Every one of these carries the `read` mark, which is set to hide its own
    // works: on a list that *is* those marks, honouring that would leave nothing.
    assert.deepEqual(view.titles, TITLES)
    assert.deepEqual(view.hidden, [])
    assert.deepEqual(view.collapsed, [])
    assert.deepEqual(await excluded(tab), [])
    await tab.close()
  })
})

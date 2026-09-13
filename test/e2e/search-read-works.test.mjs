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

/** A history long enough that reading all of it would be the wrong thing to do. */
const PAGES = 8
const PER_PAGE = 3

/**
 * Three marks over a twenty-four-work history, all of them on its first page:
 *
 * - work 1 is **Read** and **Favorite**
 * - work 3 is **Read**
 * - work 2 is **Ongoing**, which is in the read trigger group but is the mark
 *   that says you are *not* done — so it is not a verdict and work 2 is not on
 *   this list.
 *
 * Everything else in the history is unmarked, and unmarked is the whole point:
 * visiting a work is not reading it, and none of them belong here.
 *
 * `1,2` is the packed form of ids 1 and 3: delta-encoded from 0, in base 36.
 */
const SEED = {
  'option.searchMarkedForLater': true,
  'option.searchReadWorks': true,
  'option.workMarks': {
    enabled: true,
    marks: {
      read: { icon: 'read', label: 'Read', color: '#6b7280', hideSearchResult: false, items: '1,2', order: 0 },
      favorite: { icon: 'favorite', label: 'Favorite', color: '#b8860b', triggerAlias: 'read', hideSearchResult: false, items: '1', order: 1 },
      continue: { icon: 'continue', label: 'Ongoing', color: '#0369a1', triggerAlias: 'read', tracksProgress: true, hideSearchResult: false, items: '2', order: 2 },
      saved: { icon: 'saved', label: 'Marked for later', color: '#2f8f4e', order: 3 },
    },
  },
}

function blurb(id, title) {
  return `
    <li class="reading work blurb group" id="work_${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">${title}</a>
          by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4>
        <h5 class="fandoms heading"><a class="tag" href="/tags/F/works">A Fandom</a></h5>
      </div>
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
 * One of the two readings pages. AO3 serves them at the same path, told apart by
 * `show=to-read`, and gives both the same subnav — which is why the offer to
 * search the read works can sit on either.
 */
function readingsPage({ toRead, page = 1 }) {
  const start = (page - 1) * PER_PAGE + 1
  const listed = Array.from({ length: PER_PAGE }, (_, i) =>
    blurb(start + i, `Work number ${start + i}`)).join('')
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
    ${pagination(page)}
  </div>
</body></html>`
}

/**
 * Searching what you have read.
 *
 * The list is the reader's marks — `read` and every verdict aliasing it — and
 * the archive's history is only the haystack those works' blurbs are found in, a
 * mark table holding ids and nothing else. So the two things worth pinning down
 * are that visiting a work never puts it on the list, and that the scrape stops
 * once it has found the works it came for instead of reading a history to its
 * end.
 */
describe('search read items', { skip }, () => {
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

  /** Every history page AO3 was asked for, so a test can say what was read. */
  let fetched

  /** Load a readings page with the content script running against it. */
  const load = async (url, seed = SEED) => {
    const tab = await browser.newPage()
    fetched = []
    await tab.setViewport({ width: 1280, height: 900 })
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (!req.url().startsWith('https://archiveofourown.org/'))
        return void req.abort()
      const params = new URL(req.url()).searchParams
      const page = Number(params.get('page') ?? 1)
      const toRead = params.get('show') === 'to-read'
      if (!toRead)
        fetched.push(page)
      void req.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: readingsPage({ toRead, page: Number.isFinite(page) && page > 0 ? page : 1 }),
      })
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
      .filter(li => li.style.display !== 'none' && !li.classList.contains('AO3E--search-view--hidden'))
      .map(li => li.querySelector('.header h4.heading a')?.textContent?.trim()))

  /** One facet group's rows, by the group's label. */
  const facetRows = (tab, group) => tab.evaluate((want) => {
    const details = Array.from(document.querySelectorAll('.AO3E--search-view--group'))
      .find(el => el.querySelector('.AO3E--search-view--group-label')?.textContent?.trim().startsWith(want))
    if (!details)
      return null
    return Array.from(details.querySelectorAll('.AO3E--search-view--row')).map(row => ({
      value: row.querySelector('.AO3E--search-view--row-name')?.textContent?.trim(),
      count: Number(row.querySelector('.AO3E--search-view--row-count')?.textContent),
    }))
  }, group)

  /**
   * What the page says it is showing: the visible heading, the visible subnav
   * item marked current, and the visible subnav links. AO3 names a list in both
   * places, so a view standing in for one has to rename it in both.
   */
  const pageChrome = tab => tab.evaluate(() => {
    const shown = el => getComputedStyle(el).display !== 'none'
    const nav = document.querySelector('#main ul.navigation.actions')
    return {
      heading: [...document.querySelectorAll('#main > h2.heading')].filter(shown).map(h => h.textContent.trim()),
      current: [...nav.querySelectorAll(':scope > li > span.current')]
        .filter(span => shown(span.parentElement))
        .map(span => span.textContent.trim()),
      links: [...nav.querySelectorAll(':scope > li > a')]
        .filter(a => shown(a.parentElement))
        .map(a => ({ text: a.textContent.trim(), href: a.getAttribute('href') })),
    }
  })

  let tab

  test('the Marked for Later page is the search view, with nothing to go back to', async () => {
    tab = await load(TO_READ_URL)
    await sleep(2000)
    const page = await tab.evaluate(() => {
      const shown = el => !!el && getComputedStyle(el).display !== 'none'
      const button = document.querySelector('.AO3E--search-read-works--button')
      const items = Array.from(document.querySelectorAll('#main ul.navigation.actions > li'))
      return {
        view: !!document.querySelector('.AO3E--search-host.AO3E--marked-for-later'),
        nativeList: shown(document.querySelector('#main ol.reading.work.index.group')),
        back: !!document.querySelector('.AO3E--search-view--back'),
        mflButton: !!document.querySelector('.AO3E--search-marked-for-later--button'),
        readButton: button?.textContent.trim(),
        readButtonAfter: items[items.indexOf(button?.closest('li')) - 1]?.textContent.trim(),
      }
    })
    assert.equal(page.view, true, 'the view opens by itself')
    assert.equal(page.nativeList, false, 'and AO3\u2019s paged list is not shown alongside it')
    assert.equal(page.back, false, 'no "Back to list" \u2014 the view is the list')
    assert.equal(page.mflButton, false, 'no button to open what is already open')
    assert.equal(page.readButton, 'Search read items')
    assert.equal(page.readButtonAfter, 'Marked for Later')
  })

  test('Clear Entire History is not offered beside the to-read list', async () => {
    const chrome = await pageChrome(tab)
    assert.deepEqual(chrome.links.map(link => link.text), ['History'])
  })

  test('the read view replaces the Marked for Later one rather than being refused by it', async () => {
    // The page count can't be read off this document — it is the to-read
    // listing, not the history — so the source fetches page 1 to find out.
    await tab.click('.AO3E--search-read-works--button')
    await sleep(2500)
    assert.deepEqual(await shownTitles(tab), ['Work number 1', 'Work number 3'])
    assert.equal(await tab.$('.AO3E--search-host.AO3E--marked-for-later'), null, 'one view at a time')
    // Opened over a page that is itself a search view, "Back to list" would
    // mean AO3's paged list, which this page no longer shows. The subnav's
    // Marked for Later link is the way back instead.
    assert.equal(await tab.$('.AO3E--search-view--back'), null)

    // The page was Marked for Later; what is on screen now is the read list, and
    // the heading and subnav have to stop claiming otherwise.
    assert.deepEqual(await pageChrome(tab), {
      heading: ['Read'],
      current: ['Read'],
      links: [
        { text: 'History', href: '/users/me/readings' },
        { text: 'Marked for Later', href: '/users/me/readings?show=to-read' },
      ],
    })
    await tab.close()
  })

  test('the list is what you marked, not what you visited', async () => {
    tab = await load(HISTORY_URL)
    assert.ok(await tab.$('.AO3E--search-read-works--button'), 'the button should be added here too')
    // History is not replaced: its own listing, and its own Clear, stay put
    // until the reader asks for the read list.
    assert.equal(await tab.$('.AO3E--search-host'), null)
    assert.deepEqual((await pageChrome(tab)).links.map(link => link.text), ['Marked for Later', 'Clear Entire History'])
    await tab.click('.AO3E--search-read-works--button')
    await sleep(2500)

    // Twenty-four works in the history; two of them have a verdict. Work 2 is
    // marked Ongoing, which is the one mark in the read group that means you are
    // not done, so it is not on this list either.
    assert.deepEqual(await shownTitles(tab), ['Work number 1', 'Work number 3'])

    const chrome = await pageChrome(tab)
    assert.deepEqual(chrome.heading, ['Read'])
    assert.deepEqual(chrome.current, ['Read'], 'History is no longer the current item')
    // And with History off screen, so is its Clear.
    assert.deepEqual(chrome.links.map(link => link.text), ['History', 'Marked for Later'])
  })

  test('and it stops reading the history once it has found them', async () => {
    // Both marked works are on page 1. Three workers are already in flight by
    // the time that lands, so a page or two more is fetched — but eight pages of
    // history for two works is exactly what `satisfied` exists to prevent.
    assert.ok(
      fetched.length < PAGES,
      `read ${fetched.length} of ${PAGES} history pages looking for two works`,
    )
    assert.ok(fetched.includes(1), 'the page the marked works are on was read')
  })

  test('the Status facet lists the verdicts, and nothing it did not collect', async () => {
    // Every work here has a verdict, so no Unread and no readiness values: just
    // the marks. Anything else turning up would be a desync worth seeing.
    assert.deepEqual(await facetRows(tab, 'Status'), [
      // Sorted by count, then by name — the engine's own row order.
      { value: 'Read', count: 2 },
      { value: 'Favorite', count: 1 },
    ])
  })

  test('including one narrows the view to the works marked that way', async () => {
    await tab.evaluate(() => {
      const row = Array.from(document.querySelectorAll('.AO3E--search-view--row'))
        .find(el => el.querySelector('.AO3E--search-view--row-name')?.textContent?.trim() === 'Favorite')
      row.querySelector('.AO3E--search-view--toggle-include').click()
    })
    await sleep(400)
    assert.deepEqual(await shownTitles(tab), ['Work number 1'])
  })

  test('only the read works are cached, not the history they were found in', async () => {
    const stored = await tab.evaluate(() => {
      const writes = window.__writes ?? []
      let snapshots = null
      for (let i = writes.length - 1; i >= 0 && !snapshots; i--)
        snapshots = writes[i]['cache.searchSnapshots'] ?? null
      return snapshots
    })
    assert.ok(stored, 'a snapshot should have been written')
    assert.ok('read-works:me' in stored, 'the snapshot should be keyed read-works:me')
    assert.equal(stored['read-works:me'].blurbsHtml.length, 2, 'the haystack is not the list')
    // The options page has no `location` and no AO3 document, so everything a
    // refresh needs has to have been written down here.
    assert.deepEqual(stored['read-works:me'].descriptor, {
      sourceId: 'read-works',
      label: 'Read works — me',
      listUrl: HISTORY_URL,
    })
  })

  test('"Back to list" puts the native page back', async () => {
    await tab.click('.AO3E--search-view--back')
    await sleep(400)
    const restored = await tab.evaluate(() => ({
      view: document.querySelector('.AO3E--search-host'),
      list: getComputedStyle(document.querySelector('#main ol.reading.work.index.group')).display,
      button: getComputedStyle(document.querySelector('.AO3E--search-read-works--button').closest('li')).display,
    }))
    assert.equal(restored.view, null, 'the view should be gone')
    assert.notEqual(restored.list, 'none')
    assert.notEqual(restored.button, 'none')
    // AO3's own heading and subnav are back exactly as they were, and nothing we
    // put in their place is left behind.
    assert.deepEqual(await pageChrome(tab), {
      heading: ['History'],
      current: ['History'],
      links: [
        { text: 'Marked for Later', href: '/users/me/readings?show=to-read' },
        { text: 'Clear Entire History', href: '/users/me/readings/confirm_clear' },
      ],
    })
    assert.equal(await tab.$('.AO3E--search-read-works--chrome'), null)
    await tab.close()
  })

  test('with nothing marked there is no history to read at all', async () => {
    const empty = await load(HISTORY_URL, {
      ...SEED,
      'option.workMarks': {
        ...SEED['option.workMarks'],
        marks: Object.fromEntries(Object.entries(SEED['option.workMarks'].marks)
          .map(([id, mark]) => [id, { ...mark, items: id === 'continue' ? mark.items : '' }])),
      },
    })
    const before = fetched.length
    await empty.click('.AO3E--search-read-works--button')
    await sleep(1200)
    assert.equal(await empty.$('.AO3E--search-host'), null, 'no view opens')
    assert.equal(fetched.length, before, 'and AO3 is not asked for a single page')
    await empty.close()
  })

  test('someone else\'s readings page is none of our business', async () => {
    const other = await load('https://archiveofourown.org/users/someone/readings')
    assert.equal(await other.$('.AO3E--search-read-works--button'), null, 'not your history')
    await other.close()
  })
})

const HOUR = 60 * 60_000

/** A work's own page in miniature: enough of the meta block and preface to build a blurb from. */
function workPage(id, title) {
  return `<!DOCTYPE html><html><body class="logged-in"><div id="main">
  <dl class="work meta group">
    <dt class="rating tags">Rating:</dt>
    <dd class="rating tags"><ul class="commas"><li><a class="tag" href="/tags/General%20Audiences/works">General Audiences</a></li></ul></dd>
    <dt class="fandom tags">Fandom:</dt>
    <dd class="fandom tags"><ul class="commas"><li><a class="tag" href="/tags/F/works">A Fandom</a></li></ul></dd>
    <dt class="stats">Stats:</dt>
    <dd class="stats"><dl class="stats"><dt class="published">Published:</dt><dd class="published">2024-01-02</dd>
      <dt class="words">Words:</dt><dd class="words">500</dd><dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd></dl></dd>
  </dl>
  <div id="workskin"><div class="preface group">
    <h2 class="title heading">${title}</h2>
    <h3 class="byline heading"><a rel="author" href="/users/someone/pseuds/someone">someone</a></h3>
  </div></div>
</div></body></html>`
}

/**
 * A stored read list, `ageMs` old, holding `ids`. Stored blurbs are titled
 * "Stored work N" and the live history's "Work number N", so a test can see
 * whether a work on screen was fetched again or kept as it was.
 */
function storedReadList(ids, ageMs) {
  return {
    'read-works:me': {
      version: 2,
      scrapedAt: Date.now() - ageMs,
      blurbsHtml: ids.map(id => blurb(id, `Stored work ${id}`)),
      descriptor: { sourceId: 'read-works', label: 'Read works \u2014 me', listUrl: HISTORY_URL },
    },
  }
}

/** {@link SEED}, with the read mark holding works 1, 3 and 99 \u2014 which is in no history at all. */
const SEED_WITH_ABSENT = {
  ...SEED,
  'option.workMarks': {
    ...SEED['option.workMarks'],
    marks: { ...SEED['option.workMarks'].marks, read: { ...SEED['option.workMarks'].marks.read, items: '1,2,2o' } },
  },
}

/**
 * Reloading the read list on a timer.
 *
 * It can run to thousands of works and they rarely change, so an automatic
 * reload is a top-up: it goes looking only for works marked since the list was
 * stored, never re-reads a work it already has, and doesn't go looking again for
 * works an earlier scrape couldn't find. The Refresh button re-reads in full.
 */
describe('read list auto-reload', { skip }, () => {
  let browser
  let css
  let js
  let listPages
  /** Work ids whose own page AO3 was asked for. */
  let workRequests

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

  /**
   * History, with a stored read list, and the view opened. `workPages` maps a
   * work id to the title its own page carries; any other work's page is a 404.
   */
  const open = async ({ seed = SEED, stored, misses, workPages = {} }) => {
    const tab = await browser.newPage()
    listPages = []
    workRequests = []
    await tab.setViewport({ width: 1280, height: 900 })
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (!req.url().startsWith('https://archiveofourown.org/'))
        return void req.abort()
      const url = new URL(req.url())
      const workId = url.pathname.match(/^\/works\/(\d+)$/)?.[1]
      if (workId) {
        workRequests.push(workId)
        return void req.respond(workPages[workId]
          ? { status: 200, contentType: 'text/html; charset=utf-8', body: workPage(workId, workPages[workId]) }
          : { status: 404, body: '' })
      }
      const params = url.searchParams
      const page = Number(params.get('page') ?? 1)
      if (params.has('page'))
        listPages.push(page)
      void req.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: readingsPage({ toRead: params.get('show') === 'to-read', page }),
      })
    })
    await tab.evaluateOnNewDocument(installMock, {
      ...seed,
      'cache.searchSnapshots': stored,
      ...misses && { 'cache.searchMisses': { 'read-works:me': misses } },
    })
    await tab.goto(HISTORY_URL, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await sleep(1000)
    await tab.click('.AO3E--search-read-works--button')
    await sleep(3000)
    return tab
  }

  const shownTitles = tab => tab.evaluate(() =>
    Array.from(document.querySelectorAll('.AO3E--search-view--results > li.blurb'))
      .filter(li => !li.classList.contains('AO3E--search-view--hidden'))
      .map(li => li.querySelector('.header h4.heading a')?.textContent?.trim()))

  /** The latest value this page wrote under a cache key. */
  const lastWrite = (tab, key) => tab.evaluate((k) => {
    const writes = window.__writes ?? []
    for (let i = writes.length - 1; i >= 0; i--) {
      if (k in writes[i])
        return writes[i][k]
    }
    return null
  }, key)

  test('a stored list younger than the interval is shown without asking AO3 for anything', async () => {
    // Work 3 is marked but not stored; that is for the next reload to find, not this open.
    const tab = await open({ stored: storedReadList(['1'], 2 * HOUR) })
    assert.deepEqual(await shownTitles(tab), ['Stored work 1'])
    assert.deepEqual(listPages, [])
    await tab.close()
  })

  test('an older one only goes looking for the works it lacks, and keeps the ones it has', async () => {
    const tab = await open({ stored: storedReadList(['1'], 25 * HOUR) })
    // Work 3 was found and added; work 1 was not fetched again \u2014 it is still
    // the stored blurb, although the page it sits on had to be read to find 3.
    assert.deepEqual((await shownTitles(tab)).sort(), ['Stored work 1', 'Work number 3'])
    assert.ok(listPages.length < PAGES, `read ${listPages.length} of ${PAGES} history pages for one work`)
    const snapshots = await lastWrite(tab, 'cache.searchSnapshots')
    assert.equal(snapshots['read-works:me'].blurbsHtml.length, 2, 'the addition is stored with the rest')
    await tab.close()
  })

  test('with nothing missing, even an old stored list makes no request at all', async () => {
    const tab = await open({ stored: storedReadList(['1', '3'], 25 * HOUR) })
    assert.deepEqual((await shownTitles(tab)).sort(), ['Stored work 1', 'Stored work 3'])
    assert.deepEqual(listPages, [])
    await tab.close()
  })

  test('a marked work the history doesn’t have is fetched from its own page', async () => {
    // Work 99 is marked read but in no history. Once the history has been read
    // without finding it, its work page is the next place to look.
    const tab = await open({
      seed: SEED_WITH_ABSENT,
      stored: storedReadList(['1', '3'], 25 * HOUR),
      workPages: { 99: 'Work from its own page' },
    })
    assert.deepEqual(workRequests, ['99'], 'only the work nothing else had')
    assert.deepEqual((await shownTitles(tab)).sort(), ['Stored work 1', 'Stored work 3', 'Work from its own page'])
    const snapshots = await lastWrite(tab, 'cache.searchSnapshots')
    assert.equal(snapshots['read-works:me'].blurbsHtml.length, 3, 'and stored, so it isn’t fetched again')
    assert.equal(await lastWrite(tab, 'cache.searchMisses').then(m => m?.['read-works:me'] ?? ''), '', 'nothing recorded as missing')
    await tab.close()
  })

  test('only a work whose own page fails too is written off, and remembered', async () => {
    const tab = await open({ seed: SEED_WITH_ABSENT, stored: storedReadList(['1', '3'], 25 * HOUR) })
    assert.deepEqual(workRequests, ['99'])
    assert.equal(await lastWrite(tab, 'cache.searchMisses').then(m => m?.['read-works:me']), '2r', 'work 99, recorded')
    await tab.close()
  })

  test('and once remembered, an automatic reload doesn’t go looking for it again', async () => {
    const tab = await open({ seed: SEED_WITH_ABSENT, stored: storedReadList(['1', '3'], 25 * HOUR), misses: '2r' })
    assert.deepEqual(listPages, [], 'nothing new to find, so nothing asked for')
    assert.deepEqual(workRequests, [], 'not even its own page')
    await tab.close()
  })

  test('taking the last read mark off a work takes it off the list at once', async () => {
    const tab = await open({ stored: storedReadList(['1', '3'], 2 * HOUR) })
    assert.deepEqual((await shownTitles(tab)).sort(), ['Stored work 1', 'Stored work 3'])
    const { scrapedAt } = storedReadList(['1', '3'], 2 * HOUR)['read-works:me']

    // Work 3's only verdict was Read. Work 1 keeps Favorite, so it stays.
    const marks = {
      ...SEED['option.workMarks'],
      marks: { ...SEED['option.workMarks'].marks, read: { ...SEED['option.workMarks'].marks.read, items: '' } },
    }
    await tab.evaluate(m => browser.storage.local.set({ 'option.workMarks': m }), marks)
    await sleep(2000)

    assert.deepEqual(await shownTitles(tab), ['Stored work 1'], 'gone without a reload')
    assert.deepEqual(listPages, [])
    const stored = (await lastWrite(tab, 'cache.searchSnapshots'))?.['read-works:me']
    assert.equal(stored?.blurbsHtml.length, 1, 'and gone from the stored copy')
    assert.ok(Math.abs(stored.scrapedAt - scrapedAt) < 5000, 'without counting as a reload')
    await tab.close()
  })

  test('the Refresh button re-reads the whole list, stored works included', async () => {
    const tab = await open({ stored: storedReadList(['1', '3'], 2 * HOUR) })
    assert.deepEqual(listPages, [])
    await tab.click('.AO3E--search-view--refresh')
    await sleep(3000)
    assert.ok(listPages.length > 0)
    assert.deepEqual(await shownTitles(tab), ['Work number 1', 'Work number 3'], 'fresh blurbs, not the stored ones')
    await tab.close()
  })
})

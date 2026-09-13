import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const URL_TO_READ = 'https://archiveofourown.org/users/me/readings?show=to-read'
const HOUR = 60 * 60_000
const PAGES = 2
const PER_PAGE = 2

function blurb(id, title) {
  return `<li class="reading work blurb group" id="work_${id}">
    <div class="header module"><h4 class="heading"><a href="/works/${id}">${title}</a>
      by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4></div>
    <dl class="stats"><dt class="words">Words:</dt><dd class="words">1,000</dd>
      <dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd></dl>
  </li>`
}

/** The live list: what a refresh would bring back. */
function toReadPage(page) {
  const start = (page - 1) * PER_PAGE + 1
  const listed = Array.from({ length: PER_PAGE }, (_, i) => blurb(start + i, `Live work ${start + i}`)).join('')
  const pages = Array.from({ length: PAGES }, (_, i) => i + 1)
    .map(n => (n === page ? `<li><span class="current">${n}</span></li>` : `<li><a href="?show=to-read&page=${n}">${n}</a></li>`))
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Marked for Later</title></head>
<body class="logged-in">
  <div id="header"><a href="/users/me/preferences">Preferences</a></div>
  <div id="main" class="readings-index dashboard region">
    <h2 class="heading">Marked for Later</h2>
    <ul class="navigation actions" role="navigation">
      <li><a href="/users/me/readings">History</a></li>
      <li><span class="current">Marked for Later</span></li>
    </ul>
    <ol class="reading work index group">${listed}</ol>
    <ol role="navigation" class="pagination actions">${pages}</ol>
  </div>
</body></html>`
}

/** A stored copy of the list, as it was `ageMs` ago — told apart from the live one by its titles. */
function storedSnapshot(ageMs) {
  return {
    'marked-for-later:me': {
      version: 2,
      scrapedAt: Date.now() - ageMs,
      blurbsHtml: [blurb(1, 'Stored work 1'), blurb(2, 'Stored work 2')],
      descriptor: {
        sourceId: 'marked-for-later',
        label: 'Marked for Later — me',
        listUrl: URL_TO_READ,
      },
    },
  }
}

/**
 * How long a stored Marked for Later list is trusted.
 *
 * A reader with several hundred works saved pays dozens of requests for every
 * full reload, and paying that on every visit is how AO3's rate limit gets
 * tripped. So opening the view shows the stored copy as it is until it is older
 * than `searchMarkedForLaterRefreshHours`, and only then reloads behind it —
 * while the Refresh button reloads whenever it is pressed.
 */
describe('Marked for Later auto-refresh interval', { skip }, () => {
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

  /**
   * Open the to-read page with a stored copy `ageMs` old, press the search
   * button, and report which pages of the list AO3 was then asked for.
   */
  const open = async ({ ageMs, hours }) => {
    const tab = await browser.newPage()
    const listRequests = []
    let armed = false
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (!req.url().startsWith('https://archiveofourown.org/'))
        return void req.abort()
      const page = Number(new URL(req.url()).searchParams.get('page') ?? 1)
      // The page load itself is not a refresh; only what follows the click is.
      if (armed)
        listRequests.push(page)
      void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: toReadPage(page) })
    })
    const seed = {
      'option.searchMarkedForLater': true,
      'cache.searchSnapshots': storedSnapshot(ageMs),
    }
    if (hours !== undefined)
      seed['option.searchMarkedForLaterRefreshHours'] = hours
    await tab.evaluateOnNewDocument(installMock, seed)
    await tab.goto(URL_TO_READ, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await sleep(1000)
    armed = true
    await tab.click('.AO3E--search-marked-for-later--button')
    await sleep(2500)
    return { tab, listRequests }
  }

  const shownTitles = tab => tab.evaluate(() =>
    Array.from(document.querySelectorAll('.AO3E--search-view--results > li.blurb'))
      .filter(li => !li.classList.contains('AO3E--search-view--hidden'))
      .map(li => li.querySelector('.header h4.heading a')?.textContent?.trim()))

  test('a copy younger than a day is shown as it is, without asking AO3 for anything', async () => {
    const { tab, listRequests } = await open({ ageMs: 2 * HOUR })
    assert.deepEqual(await shownTitles(tab), ['Stored work 1', 'Stored work 2'])
    assert.deepEqual(listRequests, [], 'no page of the list was fetched')
    await tab.close()
  })

  test('a copy older than the interval is reloaded behind the view', async () => {
    const { tab, listRequests } = await open({ ageMs: 25 * HOUR })
    assert.ok(listRequests.length >= PAGES, `fetched ${listRequests.length} pages, expected the whole list`)
    assert.deepEqual(await shownTitles(tab), ['Live work 1', 'Live work 2', 'Live work 3', 'Live work 4'])
    await tab.close()
  })

  test('the interval is the reader’s to set', async () => {
    // Two hours old is fresh under the one-day default, and stale under one hour.
    const { tab, listRequests } = await open({ ageMs: 2 * HOUR, hours: 1 })
    assert.ok(listRequests.length >= PAGES)
    await tab.close()
  })

  test('zero hours reloads on every open, as it did before there was an interval', async () => {
    const { tab, listRequests } = await open({ ageMs: 60_000, hours: 0 })
    assert.ok(listRequests.length >= PAGES)
    await tab.close()
  })

  test('the Refresh button reloads whatever the interval says', async () => {
    const { tab, listRequests } = await open({ ageMs: 2 * HOUR })
    assert.deepEqual(listRequests, [])

    await tab.click('.AO3E--search-view--refresh')
    await sleep(2500)
    assert.ok(listRequests.length >= PAGES, 'pressing it reloads the list')
    assert.deepEqual(await shownTitles(tab), ['Live work 1', 'Live work 2', 'Live work 3', 'Live work 4'])

    // And a reload is what moves the stored time, so the next visit starts the
    // interval over.
    const scrapedAt = await tab.evaluate(() => {
      const writes = window.__writes ?? []
      for (let i = writes.length - 1; i >= 0; i--) {
        const snapshots = writes[i]['cache.searchSnapshots']
        if (snapshots?.['marked-for-later:me'])
          return snapshots['marked-for-later:me'].scrapedAt
      }
      return null
    })
    assert.ok(scrapedAt && Date.now() - scrapedAt < 60_000, 'the stored copy is stamped with the reload time')
    await tab.close()
  })
})

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { ensureBuilt, findChrome, installMock, storedLists } from './helpers.mjs'
import { until } from './optionsPage.mjs'
import { inject, launch } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const URL_TO_READ = 'https://archiveofourown.org/users/me/readings?show=to-read'
/** What AO3 says to wait, in seconds: long enough that the test sees the wait, and never sits it out. */
const RETRY_AFTER = 90
const WAIT_LINE = /^AO3 asked us to slow down — trying again in 1:[23]\d$/

function blurb(id, title) {
  return `<li class="reading work blurb group" id="work_${id}">
    <div class="header module"><h4 class="heading"><a href="/works/${id}">${title}</a>
      by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4></div>
    <dl class="stats"><dt class="words">Words:</dt><dd class="words">1,000</dd>
      <dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd></dl>
  </li>`
}

const TO_READ_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Marked for Later</title></head>
<body class="logged-in">
  <div id="header"><a href="/users/me/preferences">Preferences</a></div>
  <div id="main" class="readings-index dashboard region">
    <h2 class="heading">Marked for Later</h2>
    <ul class="navigation actions" role="navigation">
      <li><a href="/users/me/readings">History</a></li>
      <li><span class="current">Marked for Later</span></li>
    </ul>
    <ol class="reading work index group">${blurb(1, 'Live work 1')}</ol>
  </div>
</body></html>`

/**
 * The Marked for Later view whose very first request to AO3 is refused: what
 * it is waiting for, and for how long, is on screen while it waits — not a
 * spinner that could as well have hung.
 */
describe('Marked for Later refused at once', { skip }, () => {
  let browser

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /** The to-read page, with every request the view makes for a page of the list refused. */
  const open = async (seed) => {
    const tab = await browser.newPage()
    let armed = false
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (!req.url().startsWith('https://archiveofourown.org/'))
        return void req.abort()
      if (armed && new URL(req.url()).searchParams.has('page'))
        return void req.respond({ status: 429, headers: { 'Retry-After': String(RETRY_AFTER) }, contentType: 'text/html', body: 'Retry later' })
      void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: TO_READ_PAGE })
    })
    await tab.evaluateOnNewDocument(installMock, { 'option.searchMarkedForLater': true, ...seed })
    await tab.goto(URL_TO_READ, { waitUntil: 'domcontentloaded' })
    armed = true
    await inject(tab)
    return tab
  }

  test('with nothing stored, the progress panel says what it is waiting for and counts it down', async () => {
    const tab = await open({})
    try {
      const label = () => tab.$eval('.AO3E--search-host--progress-label', el => el.textContent.trim()).catch(() => '')
      await until('the wait is on screen', async () => WAIT_LINE.test(await label()))
      const first = await label()
      await until('it counts down', async () => WAIT_LINE.test(await label()) && await label() !== first)
      assert.ok(await tab.$('.AO3E--search-host--progress-cancel'), 'and it can be cancelled')
    }
    finally {
      await tab.close()
    }
  })

  test('over a stored copy, the list is shown and the updating note says what it is waiting for', async () => {
    const tab = await open(storedLists({
      'marked-for-later:me': {
        scrapedAt: 1,
        blurbsHtml: [blurb(2, 'Stored work 2')],
        descriptor: { sourceId: 'marked-for-later', label: 'Marked for Later — me', listUrl: URL_TO_READ },
      },
    }))
    try {
      await tab.waitForSelector('.AO3E--search-view--results li.blurb')
      const note = () => tab.$eval('.AO3E--search-view--updating-on .AO3E--search-view--updating-text', el => el.textContent.trim()).catch(() => '')
      await until('the wait is beside Updating', async () => (await note()).startsWith('Updating… ')
        && WAIT_LINE.test((await note()).slice('Updating… '.length)))
      assert.match(await tab.$eval('.AO3E--search-view--results', el => el.textContent), /Stored work 2/)
    }
    finally {
      await tab.close()
    }
  })
})

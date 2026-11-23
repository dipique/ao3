import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { packIds } from '../../src/common/workMarks.ts'
import { ensureBuilt, findChrome, installMock } from './helpers.mjs'
import { inject, launch } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const SAVED_ID = '1414213'
const OTHER_ID = '3141592'
const SEARCH_URL = 'https://archiveofourown.org/works/search?work_search%5Bquery%5D=bees'

function listingBlurb(id, title) {
  return `<li id="work_${id}" class="work blurb group" role="article">
    <div class="header module"><h4 class="heading"><a href="/works/${id}">${title}</a>
      by <a rel="author" href="/users/writer/pseuds/writer">writer</a></h4>
      <h5 class="fandoms heading"><a class="tag" href="/tags/Bees/works">Bees</a></h5>
      <p class="datetime">14 Sep 2026</p></div>
    <blockquote class="userstuff summary"><p>Buzzing.</p></blockquote>
    <dl class="stats"><dt class="words">Words:</dt><dd class="words">3,100</dd>
      <dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd></dl>
  </li>`
}

/** Search results, signed in as `me`: one work on Marked for Later, one not. */
const SEARCH_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="csrf-token" content="test-token"><title>Search Works</title></head><body class="logged-in">
  <div id="header"><ul class="user navigation actions"><li><a href="/users/me/preferences">Preferences</a></li></ul></div>
  <div id="main" class="works-search region">
    <h3 class="heading">2 Found</h3>
    <ol class="work index group">
      ${listingBlurb(SAVED_ID, 'A saved work')}
      ${listingBlurb(OTHER_ID, 'Another work')}
    </ol>
  </div>
</body></html>`

/**
 * Works already Marked for Later takes the works on the reader's list out of
 * AO3's own listings, collapsing or hiding them as Collapse or hide says.
 */
describe('Works already Marked for Later on a native listing', { skip }, () => {
  let browser

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  const open = async (seed) => {
    const tab = await browser.newPage()
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (!req.url().startsWith('https://archiveofourown.org/'))
        return void req.abort()
      void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: SEARCH_PAGE })
    })
    await tab.evaluateOnNewDocument(installMock, {
      'option.hideMarkedForLater': true,
      'cache.markedForLater': { userId: 'me', updatedAt: Date.now(), ids: packIds([SAVED_ID]) },
      ...seed,
    })
    await tab.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' })
    await inject(tab)
    return tab
  }

  /** How a work left the listing: `collapsed` to its reason line, `hidden` outright, or `shown`. */
  const fate = (tab, id) => tab.evaluate((sel) => {
    const li = document.querySelector(sel)
    if (li.hidden)
      return 'hidden'
    return li.querySelector(':scope > .AO3E--hide-works--wrapper[data-ao3e-hidden]') ? 'collapsed' : 'shown'
  }, `#work_${id}`)

  test('a work on the list collapses when Collapse or hide says collapse', async () => {
    const tab = await open({ 'option.hideShowReason': true })
    try {
      assert.equal(await fate(tab, SAVED_ID), 'collapsed')
      assert.equal(await fate(tab, OTHER_ID), 'shown')
    }
    finally {
      await tab.close()
    }
  })

  test('and is hidden outright when it says hide', async () => {
    const tab = await open({ 'option.hideShowReason': false })
    try {
      assert.equal(await fate(tab, SAVED_ID), 'hidden')
      assert.equal(await fate(tab, OTHER_ID), 'shown')
    }
    finally {
      await tab.close()
    }
  })

  test('nothing leaves the listing with the switch off', async () => {
    const tab = await open({ 'option.hideMarkedForLater': false })
    try {
      assert.equal(await fate(tab, SAVED_ID), 'shown')
    }
    finally {
      await tab.close()
    }
  })
})

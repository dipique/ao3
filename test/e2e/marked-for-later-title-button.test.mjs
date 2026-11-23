import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { createDefaultMarks, packIds, unpackIds } from '../../src/common/workMarks.ts'
import { ensureBuilt, findChrome, installMock, until } from './helpers.mjs'
import { inject, launch, toastTypes } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const UNREAD_ID = '3141592'
const READ_ID = '2718281'
const SAVED_ID = '1414213'
const SEARCH_URL = 'https://archiveofourown.org/works/search?work_search%5Bquery%5D=bees'

function listingBlurb(id, title) {
  return `<li id="work_${id}" class="work blurb group" role="article">
    <div class="header module"><h4 class="heading"><a href="/works/${id}">${title}</a>
      by <a rel="author" href="/users/writer/pseuds/writer">writer</a></h4>
      <p class="datetime">14 Sep 2026</p></div>
    <blockquote class="userstuff summary"><p>Buzzing.</p></blockquote>
    <dl class="stats"><dt class="words">Words:</dt><dd class="words">3,100</dd>
      <dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd></dl>
  </li>`
}

/** Search results, signed in as `me`: a work never touched, one marked read, and one on Marked for Later. */
const SEARCH_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="csrf-token" content="test-token"><title>Search Works</title></head><body class="logged-in">
  <div id="header"><ul class="user navigation actions"><li><a href="/users/me/preferences">Preferences</a></li></ul></div>
  <div id="main" class="works-search region">
    <h3 class="heading">3 Found</h3>
    <ol class="work index group">
      ${listingBlurb(UNREAD_ID, 'An unread work')}
      ${listingBlurb(READ_ID, 'A read work')}
      ${listingBlurb(SAVED_ID, 'A saved work')}
    </ol>
  </div>
</body></html>`

/** A work's own page, as the button fetches it to learn whether the work is already saved. */
function workPage(id, { saved }) {
  const form = saved
    ? `<form class="button_to" method="post" action="/works/${id}/mark_as_read"><button type="submit">Mark as Read</button></form>`
    : `<form class="button_to" method="post" action="/works/${id}/mark_for_later"><button type="submit">Mark for Later</button></form>`
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>A work</title></head><body class="logged-in">
  <ul class="work navigation actions"><li class="mark">${form}</li></ul>
</body></html>`
}

const button = id => `#work_${id} h4.heading [data-ao3e-action="mark-for-later"]`
const savedClock = id => `#work_${id} h4.heading .AO3E--indicator--mark-saved`

/**
 * With the button on, every work the reader hasn't read or saved carries an
 * outlined Marked for Later icon beside its title, and one click puts the work
 * on the list.
 */
describe('Mark for later from a work\'s title', { skip }, () => {
  let browser

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  const marks = () => {
    const table = createDefaultMarks()
    table.read.items = packIds([READ_ID])
    return table
  }

  const open = async (seed = {}, { alreadySaved = false } = {}) => {
    const tab = await browser.newPage()
    const posts = []
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      const url = new URL(req.url())
      if (url.origin !== 'https://archiveofourown.org')
        return void req.abort()
      if (req.method() === 'POST')
        posts.push(url.pathname)
      const body = url.pathname === `/works/${UNREAD_ID}` ? workPage(UNREAD_ID, { saved: alreadySaved }) : SEARCH_PAGE
      void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body })
    })
    await tab.evaluateOnNewDocument(installMock, {
      'option.markForLaterToolbar': true,
      'option.markForLaterButton': true,
      'option.workMarks': { enabled: true, marks: marks() },
      'cache.markedForLater': { userId: 'me', updatedAt: Date.now(), ids: packIds([SAVED_ID]) },
      ...seed,
    })
    await tab.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' })
    await inject(tab)
    return { tab, posts }
  }

  const has = (tab, selector) => tab.evaluate(s => document.querySelector(s) !== null, selector)
  const storedIndex = async tab => unpackIds(await tab.evaluate(async () => (await browser.storage.local.get('cache.markedForLater'))['cache.markedForLater'].ids))
  const press = (tab, id) => tab.evaluate(s => document.querySelector(s).click(), button(id))

  test('only the work neither read nor saved is offered', async () => {
    const { tab } = await open()
    try {
      await until('the unread work is offered', () => has(tab, button(UNREAD_ID)))
      assert.equal(await has(tab, button(READ_ID)), false)
      assert.equal(await has(tab, button(SAVED_ID)), false)
      assert.equal(await has(tab, savedClock(SAVED_ID)), true)
    }
    finally {
      await tab.close()
    }
  })

  test('one click puts the work on Marked for Later', async () => {
    const { tab, posts } = await open()
    try {
      await until('the unread work is offered', () => has(tab, button(UNREAD_ID)))
      await press(tab, UNREAD_ID)
      await until('the work is saved', async () => (await toastTypes(tab)).includes('success'))
      assert.deepEqual(posts, [`/works/${UNREAD_ID}/mark_for_later`])
      assert.ok((await storedIndex(tab)).has(UNREAD_ID))
      assert.equal(await has(tab, button(UNREAD_ID)), false)
      assert.equal(await has(tab, savedClock(UNREAD_ID)), true)
    }
    finally {
      await tab.close()
    }
  })

  test('a work already on the list is not saved again, which would move it to the top', async () => {
    const { tab, posts } = await open({}, { alreadySaved: true })
    try {
      await until('the unread work is offered', () => has(tab, button(UNREAD_ID)))
      await press(tab, UNREAD_ID)
      await until('the saved clock replaces the button', () => has(tab, savedClock(UNREAD_ID)))
      assert.deepEqual(posts, [])
      assert.ok((await storedIndex(tab)).has(UNREAD_ID))
      assert.equal(await has(tab, button(UNREAD_ID)), false)
    }
    finally {
      await tab.close()
    }
  })

  test('nothing is offered with the button off, or without Mark a work for later', async () => {
    for (const seed of [{ 'option.markForLaterButton': false }, { 'option.markForLaterToolbar': false }]) {
      const { tab } = await open(seed)
      try {
        await until('the page is decorated', () => has(tab, `#work_${READ_ID} h4.heading .AO3E--indicator--mark-read`))
        assert.equal(await has(tab, button(UNREAD_ID)), false, JSON.stringify(seed))
      }
      finally {
        await tab.close()
      }
    }
  })
})

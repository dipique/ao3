import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { ensureBuilt, findChrome, installMock, storedListIds, storedLists } from './helpers.mjs'
import { until } from './optionsPage.mjs'
import { inject, launch, openMenu, pickRow, toastTypes } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const WORK_ID = '2718281'
const SEARCH_URL = 'https://archiveofourown.org/works/search?work_search%5Bquery%5D=bees'
const LIST_KEY = 'marked-for-later:me'

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

/** Search results, signed in as `me`. */
const SEARCH_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="csrf-token" content="test-token"><title>Search Works</title></head><body class="logged-in">
  <div id="header"><ul class="user navigation actions"><li><a href="/users/me/preferences">Preferences</a></li></ul></div>
  <div id="main" class="works-search region">
    <h3 class="heading">1 Found</h3>
    <ol class="work index group">${listingBlurb(WORK_ID, 'A searched work')}</ol>
  </div>
</body></html>`

/** The work's own page, as the menu fetches it to learn the work isn't saved yet. */
const WORK_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>A work</title></head><body class="logged-in">
  <ul class="work navigation actions"><li class="mark"><form class="button_to" method="post" action="/works/${WORK_ID}/mark_for_later"><button type="submit">Mark for Later</button></form></li></ul>
</body></html>`

/**
 * Saving a work for later from search results puts it on the stored copy of
 * the reader's Marked for Later list straight away, with the blurb the listing
 * already has, so the list opens with it rather than waiting for a refresh.
 */
describe('Marked for Later kept from a listing', { skip }, () => {
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
    const posts = []
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      const url = new URL(req.url())
      if (url.origin !== 'https://archiveofourown.org')
        return void req.abort()
      if (req.method() === 'POST')
        posts.push(url.pathname)
      const body = url.pathname === `/works/${WORK_ID}` ? WORK_PAGE : SEARCH_PAGE
      void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body })
    })
    await tab.evaluateOnNewDocument(installMock, {
      'option.markForLaterToolbar': true,
      'cache.markedForLater': { userId: 'me', updatedAt: Date.now(), ids: '' },
      ...seed,
    })
    await tab.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' })
    await inject(tab)
    return { tab, posts }
  }

  /** Mark the work for later through its own menu, and wait for the menu to say it's done. */
  const markForLater = async (tab) => {
    await openMenu(tab, () => tab.evaluate((id) => {
      document.querySelector(`#work_${id} h4.heading a`).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
      )
    }, WORK_ID))
    await until('the menu offers to save it', () => pickRow(tab, 'mark-for-later'))
    await until('the work is saved', async () => (await toastTypes(tab)).includes('success'))
  }

  const read = (tab, key) => tab.evaluate(async k => (await browser.storage.local.get(k))[k] ?? null, key)
  const listIds = async tab => storedListIds((await read(tab, 'cache.searchLists'))?.[LIST_KEY])
  const sid = Number(WORK_ID).toString(36)

  test('the work goes first on the stored list, with the listing\'s blurb, as no read', async () => {
    const scrapedAt = Date.now() - 60_000
    const { tab, posts } = await open(storedLists({
      [LIST_KEY]: { scrapedAt, blurbsHtml: [listingBlurb('1', 'Stored work 1')] },
    }))
    try {
      await markForLater(tab)
      assert.deepEqual(posts, [`/works/${WORK_ID}/mark_for_later`])
      assert.deepEqual(await listIds(tab), [WORK_ID, '1'])
      assert.equal((await read(tab, 'cache.searchLists'))[LIST_KEY].scrapedAt, scrapedAt)
      const { html } = await read(tab, `blurb.${sid}`)
      assert.match(html, /A searched work/)
      assert.doesNotMatch(html, /AO3E/)
      assert.equal((await read(tab, `blurbData.${sid}`)).src, 'listing')
    }
    finally {
      await tab.close()
    }
  })

  test('with no stored list there is nothing to add to, and no blurb is kept', async () => {
    const { tab } = await open({})
    try {
      await markForLater(tab)
      assert.notEqual((await read(tab, 'cache.markedForLater')).ids, '')
      assert.equal(await tab.evaluate(k => window.__writes.some(w => k in w), 'cache.searchLists'), false)
      assert.equal(await read(tab, `blurb.${sid}`), null)
    }
    finally {
      await tab.close()
    }
  })
})

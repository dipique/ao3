import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { packIds } from '../../src/common/workMarks.ts'
import { ensureBuilt, findChrome, installMock, storedListIds, storedLists } from './helpers.mjs'
import { until } from './optionsPage.mjs'
import { inject, launch } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const WORK_ID = '4815162'
const WORK_URL = `https://archiveofourown.org/works/${WORK_ID}`
const LIST_KEY = 'marked-for-later:me'
const SAVED_INDICATOR = '#workskin h2.title.heading .AO3E--indicator--mark-saved'

function listingBlurb(id, title) {
  return `<li class="reading work blurb group" id="work_${id}">
    <div class="header module"><h4 class="heading"><a href="/works/${id}">${title}</a>
      by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4></div>
    <dl class="stats"><dt class="words">Words:</dt><dd class="words">1,000</dd>
      <dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd></dl>
  </li>`
}

/** A stored copy of the reader's Marked for Later list, holding `ids`. */
function storedList(ids, scrapedAt) {
  return storedLists({
    [LIST_KEY]: {
      scrapedAt,
      blurbsHtml: ids.map(id => listingBlurb(id, `Stored work ${id}`)),
      descriptor: { sourceId: 'marked-for-later', label: 'Marked for Later — me', listUrl: 'https://archiveofourown.org/users/me/readings?show=to-read' },
    },
  })
}

/** AO3's `button_to` mark form, as it renders it. */
function markForm(action, label) {
  return `<form class="button_to" method="post" action="/works/${WORK_ID}/${action}"><input type="hidden" name="_method" value="patch"><button type="submit">${label}</button></form>`
}

/**
 * A work page in AO3's shape, signed in as `me`. A work on the reader's Marked
 * for Later list has "Mark as Read" in its header; any other, "Mark for Later".
 */
function workPage({ saved }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>A work</title></head><body class="logged-in">
  <div id="header"><ul class="primary navigation"><li class="dropdown"><a href="/users/me/preferences">Preferences</a></li></ul></div>
  <div id="main" class="works-show">
    <ul class="work navigation actions">
      <li class="mark">${saved ? markForm('mark_as_read', 'Mark as Read') : markForm('mark_for_later', 'Mark for Later')}</li>
    </ul>
    <div class="wrapper">
      <dl class="work meta group">
        <dt class="rating tags">Rating:</dt>
        <dd class="rating tags"><ul class="commas"><li><a class="tag" href="/tags/Teen%20And%20Up%20Audiences/works">Teen And Up Audiences</a></li></ul></dd>
        <dt class="fandom tags">Fandom:</dt>
        <dd class="fandom tags"><ul class="commas"><li><a class="tag" href="/tags/Bees/works">Bees</a></li></ul></dd>
        <dt class="language">Language:</dt><dd class="language">English</dd>
        <dt class="stats">Stats:</dt>
        <dd class="stats"><dl class="stats">
          <dt class="published">Published:</dt><dd class="published">2026-02-12</dd>
          <dt class="words">Words:</dt><dd class="words">4,200</dd>
          <dt class="chapters">Chapters:</dt><dd class="chapters">2/3</dd>
        </dl></dd>
      </dl>
    </div>
    <div id="workskin">
      <div class="preface group">
        <h2 class="title heading">The visited work</h2>
        <h3 class="byline heading"><a rel="author" href="/users/writer/pseuds/writer">writer</a></h3>
        <div class="summary module"><h3 class="heading">Summary:</h3><blockquote class="userstuff"><p>Buzzing.</p></blockquote></div>
      </div>
      <div id="chapters"><div class="chapter" id="chapter-1"></div></div>
    </div>
  </div>
</body></html>`
}

/**
 * A work on the reader's Marked for Later list goes onto the stored copy of
 * that list from the work's own page — when the page is visited, and when it
 * is saved for later in another tab while the page is open — so the list
 * opens with it rather than waiting for a refresh.
 */
describe('Marked for Later kept from the work page', { skip }, () => {
  let browser

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  const open = async ({ saved, seed = {} }) => {
    const tab = await browser.newPage()
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: workPage({ saved }) })
      else
        void req.abort()
    })
    await tab.evaluateOnNewDocument(installMock, seed)
    await tab.goto(WORK_URL, { waitUntil: 'domcontentloaded' })
    await inject(tab)
    return tab
  }

  const read = (tab, key) => tab.evaluate(async k => (await browser.storage.local.get(k))[k] ?? null, key)
  const listIds = async tab => storedListIds((await read(tab, 'cache.searchLists'))?.[LIST_KEY])
  const sid = Number(WORK_ID).toString(36)
  const wrote = (tab, key) => tab.evaluate(k => window.__writes.some(w => k in w), key)

  test('visiting a saved work puts it first on the stored list, with its blurb, as no read', async () => {
    const scrapedAt = Date.now() - 60_000
    const tab = await open({ saved: true, seed: storedList(['1', '2'], scrapedAt) })
    try {
      await until('the work is on the stored list', async () => (await listIds(tab))[0] === WORK_ID)
      assert.deepEqual(await listIds(tab), [WORK_ID, '1', '2'])
      assert.equal((await read(tab, 'cache.searchLists'))[LIST_KEY].scrapedAt, scrapedAt)
      assert.match((await read(tab, `blurb.${sid}`)).html, /The visited work/)
      const data = await read(tab, `blurbData.${sid}`)
      assert.equal(data.src, 'workPage')
      assert.equal(data.work.words, 4200)
    }
    finally {
      await tab.close()
    }
  })

  test('the blurb keeps the summary as the author wrote it, whatever the reader\'s text replacements say', async () => {
    const tab = await open({
      saved: true,
      seed: {
        'option.textReplacements': {
          enabled: true,
          rules: [{ find: 'Buzzing', replace: 'Humming', caseSensitive: false, matchCasing: false, wholeWord: false }],
        },
        ...storedList(['1'], Date.now()),
      },
    })
    try {
      await until('the work is on the stored list', async () => (await listIds(tab))[0] === WORK_ID)
      assert.match(await tab.$eval('#workskin .summary', el => el.textContent), /Humming/)
      const { html } = await read(tab, `blurb.${sid}`)
      assert.match(html, /Buzzing/)
      assert.doesNotMatch(html, /Humming|AO3E/)
    }
    finally {
      await tab.close()
    }
  })

  test('a saved work the list already holds moves to its front', async () => {
    const tab = await open({ saved: true, seed: storedList(['1', WORK_ID, '2'], Date.now()) })
    try {
      await until('the work is first', async () => (await listIds(tab))[0] === WORK_ID)
      assert.deepEqual(await listIds(tab), [WORK_ID, '1', '2'])
    }
    finally {
      await tab.close()
    }
  })

  test('a work that isn\'t saved is left off', async () => {
    const tab = await open({ saved: false, seed: storedList(['1', '2'], Date.now()) })
    try {
      assert.deepEqual(await listIds(tab), ['1', '2'])
      assert.equal(await read(tab, `blurb.${sid}`), null)
    }
    finally {
      await tab.close()
    }
  })

  test('with no stored list there is nothing to add to, and no blurb is kept', async () => {
    const tab = await open({ saved: true })
    try {
      assert.equal(await wrote(tab, 'cache.searchLists'), false)
      assert.equal(await wrote(tab, `blurb.${sid}`), false)
    }
    finally {
      await tab.close()
    }
  })

  test('saved for later in another tab: the page shows it, and the list gets it', async () => {
    const tab = await open({
      saved: false,
      seed: {
        'option.markForLaterToolbar': true,
        'cache.markedForLater': { userId: 'me', updatedAt: Date.now(), ids: packIds(['1']) },
        ...storedList(['1', '2'], Date.now()),
      },
    })
    try {
      assert.equal(await tab.$(SAVED_INDICATOR), null)
      await tab.evaluate(ids => browser.storage.local.set({
        'cache.markedForLater': { userId: 'me', updatedAt: Date.now(), ids },
      }), packIds(['1', WORK_ID]))
      await until('the saved indicator is on the title', async () => !!await tab.$(SAVED_INDICATOR))
      await until('the work is on the stored list', async () => (await listIds(tab))[0] === WORK_ID)
      assert.deepEqual(await listIds(tab), [WORK_ID, '1', '2'])
    }
    finally {
      await tab.close()
    }
  })

  test('taken off in another tab: the page stops showing it', async () => {
    const tab = await open({
      saved: true,
      seed: {
        'option.markForLaterToolbar': true,
        'cache.markedForLater': { userId: 'me', updatedAt: Date.now(), ids: packIds([WORK_ID]) },
      },
    })
    try {
      await until('the saved indicator is on the title', async () => !!await tab.$(SAVED_INDICATOR))
      await tab.evaluate(() => browser.storage.local.set({
        'cache.markedForLater': { userId: 'me', updatedAt: Date.now(), ids: '' },
      }))
      await until('the saved indicator is gone', async () => !await tab.$(SAVED_INDICATOR))
    }
    finally {
      await tab.close()
    }
  })
})

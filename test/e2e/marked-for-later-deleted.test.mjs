import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { CACHED, DELETED } from '../../src/content_script/searchView/engine.ts'
import { WORK_TEXT_INDEX_KEY, WORK_TEXT_VERSION } from '../../src/content_script/siteExport/workText.ts'
import { ensureBuilt, findChrome, storedListIds, storedLists, until } from './helpers.mjs'
import { archiveTab, blurb, DESCRIPTOR, HOUR, KEY, openToRead, shownTitles, storedClaim } from './markedForLater.mjs'
import { launch } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const READING = '37956871836'
const VISITED = '16 Sep 2026'

/** A work on the to-read page, its readings block holding the history entry `readingId`. */
function readingBlurb(id, title, readingId) {
  return blurb(id, title).replace(/<\/li>\s*$/, `<div class="user module group">
    <h4 class="viewed heading"><span>Last visited:</span> ${VISITED} (Latest version.) Visited 2 times (Marked for Later.)</h4>
    <ul class="actions"><li><form class="ajax-remove" action="/users/me/readings/${readingId}" method="post"><input type="hidden" name="authenticity_token" value="SECRET"><input type="hidden" name="reading" value="${readingId}"><input type="submit" value="Delete from History"></form></li></ul>
  </div></li>`)
}

/** What the to-read page shows in the place of a work AO3 has deleted. */
function deletedEntry(readingId) {
  return `<li class="deleted reading work blurb group" role="article">
  <div class="user module group">
    <h4 class="viewed heading">(Deleted work, last visited ${VISITED})</h4>
    <ul class="actions"><li><form class="ajax-remove" action="/users/me/readings/${readingId}?page=1" method="post"><input type="hidden" name="authenticity_token" value="SECRET"><input type="hidden" name="reading" id="reading" value="${readingId}" class="text"><input type="submit" name="commit" value="Delete from History"></form></li></ul>
  </div>
</li>`
}

/** The to-read page, one page long, holding `items`. */
function toReadPage(items) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Marked for Later</title></head>
<body class="logged-in">
  <div id="header"><a href="/users/me/preferences">Preferences</a></div>
  <div id="main" class="readings-index dashboard region">
    <h2 class="heading">Marked for Later</h2>
    <ul class="navigation actions" role="navigation">
      <li><a href="/users/me/readings">History</a></li>
      <li><span class="current">Marked for Later</span></li>
    </ul>
    <ol class="reading work index group">${items.join('')}</ol>
  </div>
</body></html>`
}

/** The extension's storage with the list stored `ageMs` ago: works 1 to 3, the second with its history entry. */
function seed(ageMs, extra = {}) {
  return {
    'option.searchMarkedForLater': true,
    ...storedLists({
      [KEY]: {
        scrapedAt: Date.now() - ageMs,
        blurbsHtml: [readingBlurb(1, 'Work 1', '1001'), readingBlurb(2, 'Work 2', READING), readingBlurb(3, 'Work 3', '1003')],
        descriptor: DESCRIPTOR,
      },
    }),
    ...extra,
  }
}

const STATUS_ROWS = '.AO3E--search-view--group[data-ao3e-facet="status"] .AO3E--search-view--row'

const stored = (tab, key) => tab.evaluate(async k => (await window.browser.storage.local.get(k))[k] ?? null, key)

/** The titles of the shown works that carry the deleted badge. */
const badged = tab => tab.evaluate(() =>
  Array.from(document.querySelectorAll('.AO3E--search-view--results > li.blurb'))
    .filter(li => li.querySelector('[data-ao3e-deleted]'))
    .map(li => li.querySelector('.header h4.heading a')?.textContent?.trim()))

/**
 * A work AO3 deletes leaves a "Deleted work" entry in its place on Marked for
 * Later, naming no work. A refresh keeps the work it stood for on the list,
 * blurb and all, records it as deleted, and the view badges it.
 */
describe('Marked for Later: works AO3 deleted', { skip }, () => {
  let browser

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  test('a refresh keeps the work a "Deleted work" entry stands for, and badges it', async () => {
    const live = toReadPage([readingBlurb(1, 'Work 1', '1001'), deletedEntry(READING), readingBlurb(3, 'Work 3', '1003')])
    const tab = await archiveTab(browser, seed(48 * HOUR), () => live)
    try {
      await openToRead(tab)
      await until('the refresh to end', async () => (await storedClaim(tab))?.outcome)
      assert.equal((await storedClaim(tab)).outcome, 'written')

      const list = (await stored(tab, 'cache.searchLists'))[KEY]
      assert.deepEqual(storedListIds(list), ['1', '2', '3'], 'the deleted work keeps its place on the stored list')
      assert.ok(await stored(tab, 'blurb.2'), 'and its blurb is kept')
      const deleted = await stored(tab, 'cache.deletedWorks')
      assert.deepEqual(Object.keys(deleted), ['2'], 'it is recorded as deleted')
      assert.equal(deleted[2].reading, READING)

      await until('the refreshed list on screen', async () => (await shownTitles(tab)).length === 3)
      assert.deepEqual(await badged(tab), ['Work 2'])
    }
    finally {
      await tab.close()
    }
  })

  test('a stored copy opened without a refresh badges the works recorded as deleted', async () => {
    const asked = []
    const tab = await archiveTab(browser, seed(HOUR, { 'cache.deletedWorks': { 2: { at: Date.now() - HOUR, reading: READING } } }), () => toReadPage([]), asked)
    try {
      await openToRead(tab)
      assert.deepEqual(await shownTitles(tab), ['Work 1', 'Work 2', 'Work 3'])
      assert.deepEqual(await badged(tab), ['Work 2'])
      assert.deepEqual(asked, [], 'nothing was asked of AO3')
    }
    finally {
      await tab.close()
    }
  })

  test('the Status facet says which works are deleted and which have their text cached', async () => {
    const tab = await archiveTab(browser, seed(HOUR, {
      'cache.deletedWorks': { 2: { at: Date.now() - HOUR, reading: READING } },
      [WORK_TEXT_INDEX_KEY]: { 3: { size: 10, updatedAt: 0, chapters: 1, words: 10, fetchedAt: Date.now(), v: WORK_TEXT_VERSION } },
    }), () => toReadPage([]))
    try {
      await openToRead(tab)
      const rows = await tab.$$eval(STATUS_ROWS, els => els.map(el => [
        el.querySelector('.AO3E--search-view--row-name').textContent,
        el.querySelector('.AO3E--search-view--row-count').textContent.replace(/\D/g, ''),
      ]))
      assert.deepEqual(rows.filter(([name]) => name === DELETED || name === CACHED).sort(), [[CACHED, '1'], [DELETED, '1']])

      await tab.evaluate((sel, value) => {
        const row = [...document.querySelectorAll(sel)]
          .find(el => el.querySelector('.AO3E--search-view--row-name').textContent === value)
        row.querySelector('.AO3E--search-view--toggle-exclude').click()
      }, STATUS_ROWS, DELETED)
      await until('the deleted work to leave the results', async () => (await shownTitles(tab)).length === 2)
      assert.deepEqual(await shownTitles(tab), ['Work 1', 'Work 3'])
    }
    finally {
      await tab.close()
    }
  })
})

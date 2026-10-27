import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { unpackIds } from '../../src/common/workMarks.ts'
import { WAIT_BUDGET } from '../../src/content_script/archiveFetch.ts'
import { figures } from '../facts.mjs'
import { ensureBuilt, findChrome, installMock, storedListIds, storedLists } from './helpers.mjs'
import { archiveTab, blurb, DESCRIPTOR, HOUR, KEY, liveTitles, loadToRead, shownTitles, storedClaim, TO_READ, toReadPage, updatingNote } from './markedForLater.mjs'
import { until } from './optionsPage.mjs'
import { ARCHIVE, inject, launch, viewDrawn } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const PROGRESS = '.AO3E--search-host--progress-label'
/** The pages the progress panel says are loaded, and in all, as `done/total`; null with no panel. */
const progress = async (tab) => {
  const text = await tab.$eval(PROGRESS, el => el.textContent).catch(() => null)
  return text === null ? null : figures(text).join('/')
}

/** A stored list the page holds now, by its key, or undefined. */
const storedList = (tab, key) => tab.evaluate(async k => (await window.browser.storage.local.get('cache.searchLists'))['cache.searchLists']?.[k], key)

/** A page's answer held back until `release()`. */
function gate() {
  const { promise, resolve } = Promise.withResolvers()
  return { held: promise, release: resolve }
}

/**
 * A list opened with nothing stored is read page by page, and the view comes
 * up with the first pages while the rest are still being fetched. Nothing is
 * stored until the whole list is in.
 */
describe('a first load shows its works as they come', { skip }, () => {
  let browser

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  test('Marked for Later: pages 1–2 are on screen while page 3 is held, and stored only once it lands', async () => {
    const page1 = gate()
    const page3 = gate()
    const tab = await archiveTab(browser, { 'option.searchMarkedForLater': true }, async (url) => {
      const page = Number(url.searchParams.get('page') ?? 1)
      if (url.searchParams.has('page') && page === 1)
        await page1.held
      if (page === 3)
        await page3.held
      return toReadPage(page)
    })
    try {
      await loadToRead(tab)
      await inject(tab)
      // Page 2 lands first: the listing from page 1 on is still empty.
      await until('page 2 to land', async () => await progress(tab) === '1/3')
      page1.release()

      await until('the view to show pages 1–2', async () => JSON.stringify(await shownTitles(tab)) === JSON.stringify(liveTitles().slice(0, 4)))
      assert.equal(await tab.$(PROGRESS), null, 'the progress panel has made way for the view')
      assert.deepEqual(figures(await updatingNote(tab)), [2, 3], 'and its progress is the view’s note')
      assert.equal(await storedList(tab, KEY), undefined, 'nothing is stored yet')

      page3.release()
      await viewDrawn(tab)
      assert.deepEqual(await shownTitles(tab), liveTitles())
      assert.deepEqual(storedListIds(await storedList(tab, KEY)), ['1', '2', '3', '4', '5', '6'])
    }
    finally {
      page1.release()
      page3.release()
      await tab.close()
    }
  })

  describe('the read list', () => {
    const HISTORY = `${ARCHIVE}/users/me/readings`
    const PAGES = 3
    const PER_PAGE = 3

    function blurb(id) {
      return `<li class="reading work blurb group" id="work_${id}">
        <div class="header module"><h4 class="heading"><a href="/works/${id}">Work number ${id}</a>
          by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4></div>
        <dl class="stats"><dt class="words">Words:</dt><dd class="words">1,000</dd>
          <dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd></dl>
      </li>`
    }

    function historyPage(page) {
      const start = (page - 1) * PER_PAGE + 1
      const listed = Array.from({ length: PER_PAGE }, (_, i) => blurb(start + i)).join('')
      const pages = Array.from({ length: PAGES }, (_, i) => i + 1)
        .map(n => (n === page ? `<li><span class="current">${n}</span></li>` : `<li><a href="?page=${n}">${n}</a></li>`))
        .join('')
      return `<!doctype html><html><head><meta charset="utf-8"><title>History</title></head>
<body class="logged-in">
  <div id="header"><a href="/users/me/preferences">Preferences</a></div>
  <div id="main" class="readings-index dashboard region">
    <h2 class="heading">History</h2>
    <ul class="navigation actions" role="navigation">
      <li><span class="current">History</span></li>
      <li><a href="/users/me/readings?show=to-read">Marked for Later</a></li>
    </ul>
    <ol class="reading work index group">${listed}</ol>
    <ol role="navigation" class="pagination actions">${pages}</ol>
  </div>
</body></html>`
    }

    /** A work's own page in miniature: enough to build a blurb from. */
    function workPage(id) {
      return `<!DOCTYPE html><html><body class="logged-in"><div id="main">
  <dl class="work meta group">
    <dt class="stats">Stats:</dt>
    <dd class="stats"><dl class="stats"><dt class="published">Published:</dt><dd class="published">2024-01-02</dd>
      <dt class="words">Words:</dt><dd class="words">500</dd><dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd></dl></dd>
  </dl>
  <div id="workskin"><div class="preface group">
    <h2 class="title heading">Work ${id} from its own page</h2>
    <h3 class="byline heading"><a rel="author" href="/users/someone/pseuds/someone">someone</a></h3>
  </div></div>
</div></body></html>`
    }

    test('the marked works of page 1 are on screen while page 3 is held; the rest, and the one from its own page, follow', async () => {
      const page3 = gate()
      const tab = await browser.newPage()
      try {
        await tab.setViewport({ width: 1280, height: 900 })
        await tab.setRequestInterception(true)
        tab.on('request', async (req) => {
          const url = new URL(req.url())
          if (url.origin !== ARCHIVE)
            return void req.abort()
          const workId = url.pathname.match(/^\/works\/(\d+)$/)?.[1]
          if (workId)
            return void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: workPage(workId) })
          const page = Number(url.searchParams.get('page') ?? 1)
          if (page === 3)
            await page3.held
          void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: historyPage(page) }).catch(() => {})
        })
        // Read: work 1 (history page 1), work 8 (page 3) and work 99, in no
        // history at all. Packed: deltas 1, 7, 91 in base 36.
        await tab.evaluateOnNewDocument(installMock, {
          'option.searchReadWorks': true,
          'option.workMarks': {
            enabled: true,
            marks: {
              read: { icon: 'read', label: 'Read', color: '#6b7280', hideSearchResult: false, items: '1,7,2j', order: 0 },
              saved: { icon: 'saved', label: 'Marked for later', color: '#2f8f4e', order: 1 },
            },
          },
        })
        await tab.goto(HISTORY, { waitUntil: 'domcontentloaded' })
        await inject(tab)
        await tab.click('.AO3E--search-read-works--button')

        await until('the view to show page 1’s marked work', async () => JSON.stringify(await shownTitles(tab)) === JSON.stringify(['Work number 1']))
        assert.equal(await tab.$(PROGRESS), null)
        assert.equal(await storedList(tab, 'read-works:me'), undefined, 'nothing is stored yet')

        page3.release()
        await viewDrawn(tab)
        assert.deepEqual((await shownTitles(tab)).sort(), ['Work 99 from its own page', 'Work number 1', 'Work number 8'])
        assert.deepEqual(storedListIds(await storedList(tab, 'read-works:me')).sort(), ['1', '8', '99'])
      }
      finally {
        page3.release()
        await tab.close()
      }
    })
  })
})

/**
 * A refresh of a stored list puts each page it reads in front of the stored
 * works as it goes, and one that AO3 cuts off keeps what it read: the stored
 * works it never reached stay, on screen and in storage.
 */
describe('a refresh shows its works as they come', { skip }, () => {
  let browser

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /** Long enough past the wait budget that the refresh gives up at once rather than sit it out. */
  const RETRY_AFTER = WAIT_BUDGET.interactive / 1000 + 60

  /** Page 1 of Marked for Later as AO3 has it now: a work saved since the list was stored, then work 1. */
  function pageOne() {
    return toReadPage(1).replace(blurb(1, 'Live work 1') + blurb(2, 'Live work 2'), blurb(9, 'New work 9') + blurb(1, 'Live work 1'))
  }

  test('Marked for Later cut off at page 2: the new work goes first, and the stored works it never reached stay', async () => {
    const scrapedAt = Date.now() - 48 * HOUR
    const seed = {
      'option.searchMarkedForLater': true,
      ...storedLists({ [KEY]: { scrapedAt, blurbsHtml: [1, 2, 3, 4, 5, 6].map(id => blurb(id, `Stored work ${id}`)), descriptor: DESCRIPTOR } }),
    }
    const tab = await archiveTab(browser, seed, async (url) => {
      const page = Number(url.searchParams.get('page') ?? 1)
      if (!url.searchParams.has('page'))
        return toReadPage(1)
      if (page === 1)
        return pageOne()
      // Refused once page 1 is in: a refusal calls off the pages still on their way.
      if (page === 2) {
        await until('page 1 to land', async () => (await storedClaim(tab))?.done >= 1)
        return { status: 429, headers: { 'Retry-After': String(RETRY_AFTER) }, body: 'Retry later' }
      }
      return toReadPage(page)
    })
    try {
      await tab.goto(TO_READ, { waitUntil: 'domcontentloaded' })
      await inject(tab)
      await until('the refresh to end', async () => (await storedClaim(tab))?.outcome)
      assert.equal((await storedClaim(tab)).outcome, 'blocked')
      await viewDrawn(tab)

      const list = await storedList(tab, KEY)
      assert.deepEqual(storedListIds(list), ['9', '1', '2', '3', '4', '5', '6'], 'page 1 as read, then the stored works it lacks')
      assert.equal(list.scrapedAt, scrapedAt, 'and dated as the copy it was read over, so the next open reads the list again')
      assert.deepEqual((await shownTitles(tab)).slice(0, 3), ['New work 9', 'Live work 1', 'Stored work 2'])
      const index = await tab.evaluate(async () => (await window.browser.storage.local.get('cache.markedForLater'))['cache.markedForLater'])
      assert.deepEqual([...unpackIds(index.ids)].sort(), ['1', '2', '3', '4', '5', '6', '9'], 'the saved-work index is written from the same merge')
    }
    finally {
      await tab.close()
    }
  })
})

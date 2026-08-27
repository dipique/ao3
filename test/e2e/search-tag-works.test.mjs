import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const TAG_URL = 'https://archiveofourown.org/tags/marriage%20problems'
const SEED = { 'option.searchTagWorks': true }

/** Pages of works AO3 would page through; 5 per page, distinct ids and titles. */
const PAGES = 3
const PER_PAGE = 5

function blurb(id, title, extraTags = []) {
  const tags = ['marriage problems', ...extraTags]
    .map(t => `<li class="freeforms"><a class="tag" href="/tags/${t}/works">${t}</a></li>`)
    .join('')
  return `
    <li class="work blurb group" id="work_${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">${title}</a>
          by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4>
        <h5 class="fandoms heading"><a class="tag" href="/tags/F/works">A Fandom</a></h5>
      </div>
      <ul class="tags commas">${tags}</ul>
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
 * A non-canonical tag's page: no navigation to a filterable listing, the notice
 * that says so, then a plain paged works list — and, on page 1 only, a second
 * `ul.index.group` of bookmarks that must not be mistaken for works.
 */
/**
 * The reader's rules have to reach these blurbs too, so the first work of each
 * page carries a tag a hide rule matches, the second carries that tag plus one an
 * "always show" rule matches — the priority contest, inside the view — and the
 * third carries a tag a *collapse* rule matches, which is the other half of it:
 * a collapsed work keeps its place in the results, a hidden one leaves them.
 */
const RULE_TAGS = [['HideMe'], ['HideMe', 'Keeper'], ['Squish']]

function tagPage(page) {
  const start = (page - 1) * PER_PAGE + 1
  const works = Array.from({ length: PER_PAGE }, (_, i) =>
    blurb(start + i, `Work number ${start + i}`, RULE_TAGS[i] ?? [])).join('')
  const bookmarks = page === 1
    ? `<div class="bookmark listbox group">
         <h3 class="heading">Bookmarks which have used it as a tag:</h3>
         <ul class="index group">${blurb(9001, 'A bookmarked work')}</ul>
       </div>`
    : ''
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>marriage problems</title>
<style>body { font-family: Verdana, sans-serif; margin: 0 }</style></head>
<body>
  <div id="header"></div>
  <div id="main" class="tags-show region">
    <div class="tag home profile">
      <div class="primary header module"><h2 class="heading">marriage problems</h2></div>
      <p>This tag belongs to the Additional Tags Category.</p>
      <div class="parent listbox group">
        <h3 class="heading">Parent tags (more general):</h3>
        <ul class="tags commas index group"><li><a class="tag" href="/tags/No%20Fandom">No Fandom</a></li></ul>
      </div>
      <p>This tag has not been marked common and can&#39;t be filtered on (yet).</p>
      <div class="work listbox group">
        <h3 class="heading">Works which have used it as a tag:</h3>
        ${pagination(page)}
        <ul class="index group">${works}</ul>
      </div>
      ${bookmarks}
    </div>
  </div>
</body></html>`
}

/** The same page for a tag AO3 *has* marked common: no works list, and it says so. */
const CANONICAL_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Romance</title></head>
<body>
  <div id="header"></div>
  <div id="main" class="tags-show region">
    <div class="tag home profile">
      <div class="primary header module">
        <h2 class="heading">Romance</h2>
        <ul class="navigation actions"><li><a href="/tags/Romance/works">Works</a></li></ul>
      </div>
      <p>This tag belongs to the Additional Tags Category.
        It&#39;s a <a href="/faq/glossary#canonicaldef">canonical tag</a>. You can use it to
        <a href="/tags/Romance/works">filter works</a>.
      </p>
      <div class="parent listbox group">
        <h3 class="heading">Parent tags (more general):</h3>
        <ul class="tags commas index group"><li><a class="tag" href="/tags/No%20Fandom">No Fandom</a></li></ul>
      </div>
    </div>
  </div>
</body></html>`

/**
 * Searching an uncommon tag. AO3 only offers sort & filter once a tag has been
 * marked common; for every other tag the page is a plain paged list. The unit
 * offers to pull that whole list into the in-memory search view instead.
 */
describe('search an uncommon tag\'s works', { skip }, () => {
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

  /** Load a tag page with the content script running against it. */
  const load = async (url, body, seed = SEED) => {
    const tab = await browser.newPage()
    await tab.setViewport({ width: 1280, height: 900 })
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (!req.url().startsWith('https://archiveofourown.org/'))
        return void req.abort()
      const page = Number(new URL(req.url()).searchParams.get('page') ?? 1)
      const html = body ?? tagPage(Number.isFinite(page) && page > 0 ? page : 1)
      void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
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
      .filter(li => li.style.display !== 'none')
      .map(li => li.querySelector('.header h4.heading a')?.textContent?.trim()))

  let tab

  test('the notice about not being filterable carries the offer to search', async () => {
    tab = await load(TAG_URL)
    const found = await tab.evaluate(() => {
      const link = document.querySelector('.AO3E--search-tag-works--link')
      if (!link)
        return null
      return { text: link.textContent.trim(), notice: link.parentElement.textContent.trim() }
    })
    assert.ok(found, 'the link should be added')
    assert.equal(found.text, 'Search these works')
    assert.match(found.notice, /^This tag has not been marked common/)
  })

  test('clicking it loads every page into one view', async () => {
    await tab.click('.AO3E--search-tag-works--link')
    await sleep(2500)
    const titles = await shownTitles(tab)
    assert.equal(titles.length, PAGES * PER_PAGE, 'every page of works should be in the view')
    assert.deepEqual(
      titles,
      Array.from({ length: PAGES * PER_PAGE }, (_, i) => `Work number ${i + 1}`),
      'in the order the Archive listed them',
    )
  })

  test('the bookmarks listed under the works are not mistaken for them', async () => {
    const titles = await shownTitles(tab)
    assert.ok(!titles.includes('A bookmarked work'), 'the bookmark blurb should not be scraped')
  })

  test('the native list and the link are hidden while the view is up', async () => {
    const hidden = await tab.evaluate(() => {
      const listbox = document.querySelector('#main div.work.listbox')
      const link = document.querySelector('.AO3E--search-tag-works--link')
      return {
        listbox: getComputedStyle(listbox).display,
        link: getComputedStyle(link).display,
        // The sentence itself stays — it's why the reader is looking at the view.
        notice: link.parentElement.textContent.includes('has not been marked common'),
      }
    })
    assert.equal(hidden.listbox, 'none')
    assert.equal(hidden.link, 'none')
    assert.ok(hidden.notice)
  })

  test('the view sits directly below that sentence', async () => {
    const order = await tab.evaluate(() => {
      const view = document.querySelector('.AO3E--search-host')
      const notice = document.querySelector('.AO3E--search-tag-works--link').parentElement
      return notice.nextElementSibling === view
    })
    assert.ok(order, 'the view container should be the notice\'s next sibling')
  })

  test('the works are cached under the tag, and the layout under the feature', async () => {
    const stored = await tab.evaluate(() => {
      const writes = window.__writes ?? []
      let snapshots = null
      for (let i = writes.length - 1; i >= 0 && !snapshots; i--)
        snapshots = writes[i]['cache.searchSnapshots'] ?? null
      return snapshots
    })
    assert.ok(stored, 'a snapshot should have been written')
    const key = 'tag-works:marriage%20problems'
    assert.ok(key in stored, `the snapshot should be keyed ${key}`)
    assert.equal(stored[key].blurbsHtml.length, PAGES * PER_PAGE)
  })

  test('"Back to list" puts the native page back', async () => {
    await tab.click('.AO3E--search-view--back')
    await sleep(400)
    const restored = await tab.evaluate(() => ({
      view: document.querySelector('.AO3E--search-host'),
      listbox: getComputedStyle(document.querySelector('#main div.work.listbox')).display,
      link: getComputedStyle(document.querySelector('.AO3E--search-tag-works--link')).display,
    }))
    assert.equal(restored.view, null, 'the view should be gone')
    assert.notEqual(restored.listbox, 'none')
    assert.notEqual(restored.link, 'none')
    await tab.close()
  })

  test('the hide rules a reader set still reach the works in the view', async () => {
    const seeded = await load(TAG_URL, undefined, {
      ...SEED,
      'option.rules': {
        enabled: true,
        colors: {},
        filters: [
          { target: 'tag', value: 'HideMe', matcher: 'exact', behavior: 'hide' },
          { target: 'tag', value: 'Squish', matcher: 'exact', behavior: 'collapse' },
          { target: 'tag', value: 'Keeper', matcher: 'exact', behavior: 'invert' },
        ],
      },
    })
    await seeded.click('.AO3E--search-tag-works--link')
    await sleep(2500)
    const state = await seeded.evaluate(() => {
      const lis = [...document.querySelectorAll('.AO3E--search-view--results > li.blurb')]
      const shown = lis.filter(li => !li.classList.contains('AO3E--search-view--hidden'))
      return {
        mounted: lis.length,
        shown: shown.map(li => li.id),
        collapsed: shown.filter(li => li.querySelector('[data-ao3e-hidden]')).map(li => li.id),
        count: document.querySelector('.AO3E--search-view--count')?.textContent ?? '',
        wrappers: Math.max(...lis.map(li => li.querySelectorAll('.AO3E--hide-works--wrapper').length)),
      }
    })
    // Every work is still mounted — the view holds them all — but the one work
    // per page a hide rule matched is no longer a result: it costs no slot, and
    // the count the reader is shown never knew about it.
    assert.equal(state.mounted, PAGES * PER_PAGE)
    assert.equal(state.shown.length, PAGES * PER_PAGE - PAGES, 'one work per page should be gone')
    for (const id of ['work_1', 'work_6', 'work_11'])
      assert.ok(!state.shown.includes(id), `${id} was hidden by a rule and should have left the results`)
    assert.match(state.count, new RegExp(`of ${PAGES * PER_PAGE - PAGES} works`))
    // The one that also carries the "always show" tag stays, because invert
    // outranks hide by default...
    assert.ok(state.shown.includes('work_2'), 'an always-show rule should beat the hide rule')
    // ...and a collapse rule keeps its work in the results, squeezed down.
    assert.deepEqual(state.collapsed, ['work_3', 'work_8', 'work_13'])
    assert.equal(state.wrappers, 1, 'no blurb should be wrapped more than once')
    await seeded.close()
  })

  test('a canonical tag is left alone — AO3 can already filter it', async () => {
    const canonical = await load('https://archiveofourown.org/tags/Romance', CANONICAL_PAGE)
    const link = await canonical.$('.AO3E--search-tag-works--link')
    assert.equal(link, null, 'no link on a tag AO3 has marked common')
    await canonical.close()
  })
})

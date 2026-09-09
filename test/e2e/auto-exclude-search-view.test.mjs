import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const TAG_URL = 'https://archiveofourown.org/tags/marriage%20problems'

/**
 * A hide rule on one Additional Tag, plus a language filter that no filter can
 * speak for — the two halves of what "exclude hidden works from the search"
 * has to tell apart inside a view.
 */
const SEED = {
  'option.searchTagWorks': true,
  'option.autoExcludeHidden': true,
  // The language filter hides outright rather than collapsing, so it is the
  // same kind of decision as the rule and differs only in being unfilterable.
  'option.hideShowReason': false,
  'option.hideLanguages': { enabled: true, show: [{ label: 'English' }] },
  'option.rules': {
    enabled: true,
    colors: {},
    filters: [{ target: 'F', value: 'Gone', matcher: 'exact', behavior: 'hide' }],
  },
}

const PAGES = 2

function blurb(id, title, tags, language = 'English') {
  const tagList = ['marriage problems', ...tags]
    .map(t => `<li class="freeforms"><a class="tag" href="https://archiveofourown.org/tags/${encodeURIComponent(t)}/works">${t}</a></li>`)
    .join('')
  return `
    <li class="work blurb group" id="work_${id}">
      <div class="header module">
        <h4 class="heading"><a href="https://archiveofourown.org/works/${id}">${title}</a> by <a rel="author" href="https://archiveofourown.org/users/s/pseuds/s">s</a></h4>
        <h5 class="fandoms heading"><a class="tag" href="https://archiveofourown.org/tags/F/works">A Fandom</a></h5>
      </div>
      <ul class="tags commas">${tagList}</ul>
      <dl class="stats">
        <dt class="language">Language:</dt><dd class="language">${language}</dd>
        <dt class="words">Words:</dt><dd class="words">1,000</dd>
        <dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd>
      </dl>
    </li>`
}

const WORKS = {
  1: [
    blurb(1, 'Plain one', []),
    blurb(2, 'Another plain one', []),
  ],
  2: [
    blurb(3, 'A rule-gone one', ['Gone']),
    blurb(4, 'A Spanish one', [], 'Español'),
  ],
}

function pagination(current) {
  const items = Array.from({ length: PAGES }, (_, i) => i + 1)
    .map(n => (n === current ? `<li><span class="current">${n}</span></li>` : `<li><a href="?page=${n}">${n}</a></li>`))
    .join('')
  return `<ol role="navigation" class="pagination actions">${items}</ol>`
}

function tagPage(page) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>marriage problems</title></head>
<body>
  <div id="header"></div>
  <div id="main" class="tags-show region">
    <div class="tag home profile">
      <div class="primary header module"><h2 class="heading">marriage problems</h2></div>
      <p>This tag belongs to the Additional Tags Category.</p>
      <p>This tag has not been marked common and can&#39;t be filtered on (yet).</p>
      <div class="work listbox group">
        <h3 class="heading">Works which have used it as a tag:</h3>
        ${pagination(page)}
        <ul class="index group">${WORKS[page].join('')}</ul>
      </div>
    </div>
  </div>
</body></html>`
}

/**
 * The same option, inside a custom search view. There is no sidebar to fill in
 * here — the view *is* the filter — so a hide rule that can be said as a facet
 * exclusion is said that way instead of taking the work away silently, and the
 * reader gets a row they can see and lift. A hide nothing can express (a work in
 * a language they don't read) still just goes.
 */
describe('auto-excluding what the rules hide, in a search view', { skip }, () => {
  let browser
  let page

  before(async () => {
    ensureBuilt()
    const css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    const js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')

    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-first-run', '--no-default-browser-check'],
    })
    page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      if (!req.url().startsWith('https://archiveofourown.org/'))
        return void req.abort()
      const n = Number(new URL(req.url()).searchParams.get('page') ?? 1)
      void req.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: tagPage(Number.isFinite(n) && n >= 1 && n <= PAGES ? n : 1),
      })
    })
    await page.evaluateOnNewDocument(installMock, SEED)
    await page.goto(TAG_URL, { waitUntil: 'domcontentloaded' })
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await sleep(1200)
    await page.click('.AO3E--search-tag-works--link')
    await sleep(2500)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /** Titles of the works actually in front of the reader. */
  const visibleTitles = () => page.evaluate(() =>
    [...document.querySelectorAll('.AO3E--search-view--results > li.blurb')]
      .filter(li => li.style.display !== 'none' && !li.classList.contains('AO3E--search-view--hidden'))
      .map(li => li.querySelector('h4.heading a').textContent))

  /** A facet row by its value: whether it is shown, and which way it is selected. */
  const facetRow = value => page.evaluate((want) => {
    for (const name of document.querySelectorAll('.AO3E--search-view--row-name')) {
      if (name.textContent.trim() !== want)
        continue
      const row = name.closest('.AO3E--search-view--row')
      return {
        shown: !row.classList.contains('AO3E--search-view--hidden'),
        excluded: row.querySelector('.AO3E--search-view--toggle-exclude').getAttribute('aria-pressed') === 'true',
      }
    }
    return null
  }, value)

  test('the work a hide rule matched is out of the results', async () => {
    const titles = await visibleTitles()
    assert.ok(!titles.includes('A rule-gone one'), `got ${JSON.stringify(titles)}`)
    assert.ok(titles.includes('Plain one'))
  })

  test('and its tag is a facet row, shown as excluded, rather than nothing at all', async () => {
    assert.deepEqual(await facetRow('Gone'), { shown: true, excluded: true })
  })

  test('a hide no filter can express still just takes the work away', async () => {
    const titles = await visibleTitles()
    assert.ok(!titles.includes('A Spanish one'))
    // Nothing carries that language into the facets: the work never became a
    // result, so there is no row for the reader to lift.
    assert.equal(await facetRow('Español'), null)
  })

  test('lifting the exclusion brings the work back collapsed, not as a blank slot', async () => {
    await page.evaluate(() => {
      for (const name of document.querySelectorAll('.AO3E--search-view--row-name')) {
        if (name.textContent.trim() === 'Gone')
          name.closest('.AO3E--search-view--row').querySelector('.AO3E--search-view--toggle-exclude').click()
      }
    })
    await sleep(600)
    assert.ok((await visibleTitles()).includes('A rule-gone one'))
    const collapsed = await page.evaluate(() => {
      const li = [...document.querySelectorAll('.AO3E--search-view--results > li.blurb')]
        .find(el => el.querySelector('h4.heading a').textContent === 'A rule-gone one')
      return { hidden: li.hidden, hasReason: !!li.querySelector('.AO3E--hide-works--msg') }
    })
    assert.deepEqual(collapsed, { hidden: false, hasReason: true })
  })
})

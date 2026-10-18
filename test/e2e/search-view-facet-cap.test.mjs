import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { FACET_ROW_CAP, leftOutNote } from '../../src/content_script/searchView/facetRows.ts'
import { DIST, ensureBuilt, findChrome, installMock, launch } from './helpers.mjs'
import { pressFacet, settled, viewDrawn } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const READINGS_URL = 'https://archiveofourown.org/users/me/readings?show=to-read'

// Five more tags than the cap, all on the first work, so by most works first
// (ties by name) the last five by name are the ones left out.
const TAG_COUNT = FACET_ROW_CAP + 5
const tag = i => `Tag ${i}`
const ALL_TAGS = Array.from({ length: TAG_COUNT }, (_, k) => tag(k + 1))
const LAST = tag(TAG_COUNT)

function blurb(id, freeforms) {
  return `
    <li class="blurb work" id="work_${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">Work ${id}</a> by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4>
        <h5 class="fandoms heading"><a class="tag" href="/tags/F/works">A Fandom</a></h5>
      </div>
      <ul class="tags commas">
        ${freeforms.map(name => `<li class="freeforms"><a class="tag" href="/tags/${name}/works">${name}</a></li>`).join('')}
      </ul>
      <dl class="stats">
        <dt class="words">Words:</dt>
        <dd class="words">1,000</dd>
        <dt class="chapters">Chapters:</dt>
        <dd class="chapters">1/1</dd>
      </dl>
    </li>`
}

const READINGS_HTML = `<!doctype html>
<html><head><title>Marked for Later</title></head>
<body class="logged-in">
  <div id="header"><a href="/users/me/preferences">Preferences</a></div>
  <div id="main">
    <ul class="navigation actions"><li><span class="current">Marked for Later</span></li></ul>
    <ol class="reading work index group">
      ${blurb(1, ALL_TAGS)}
      ${blurb(2, [tag(1)])}
    </ol>
  </div>
</body></html>`

/**
 * A facet group with more values than the cap. Which rows the cap keeps, in
 * each sort and with a selection, is `layoutFacetRows`'s, tested case by case
 * in `test/searchView/facetRows.test.mjs`; here, that the sidebar draws what
 * it says, and that the group's filter box reaches past it.
 */
describe('search view facet row cap', { skip }, () => {
  let browser
  let page

  before(async () => {
    ensureBuilt()
    const css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    const js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')

    browser = await launch(chromePath)
    page = await browser.newPage()
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html', body: READINGS_HTML })
      else
        void req.abort()
    })
    await page.evaluateOnNewDocument(installMock, { 'option.searchMarkedForLater': true })
    await page.goto(READINGS_URL, { waitUntil: 'domcontentloaded' })
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await settled(page)
    await viewDrawn(page)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /** What the Additional Tags group shows: its heading count, its unselected and included rows, and the line under them. */
  const tagGroup = () => page.evaluate(() => {
    const group = [...document.querySelectorAll('.AO3E--search-view--group')]
      .find(g => g.querySelector('.AO3E--search-view--group-label')?.textContent?.includes('Additional Tags'))
    const body = group.querySelector('.AO3E--search-view--group-body')
    const name = row => row.querySelector('.AO3E--search-view--row-name').textContent
    return {
      count: group.querySelector('.AO3E--search-view--group-count').textContent,
      rest: [...body.children].filter(el => el.classList.contains('AO3E--search-view--row')).map(name),
      included: [...group.querySelectorAll('.AO3E--search-view--sel-include .AO3E--search-view--row')].map(name),
      note: group.querySelector('.AO3E--search-view--group-capped')?.textContent ?? null,
      noteLast: body.lastElementChild?.classList.contains('AO3E--search-view--group-capped') ?? false,
      notesInPage: document.querySelectorAll('.AO3E--search-view--group-capped').length,
    }
  })

  const filterTags = text => page.evaluate((value) => {
    const input = document.querySelector('input[aria-label="Filter Additional Tags"]')
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, text)

  test('shows the cap\'s worth of rows, says how many are left out, and finds the rest through the filter box', async () => {
    const opened = await tagGroup()
    assert.equal(opened.rest.length, FACET_ROW_CAP)
    assert.ok(!opened.rest.includes(LAST))
    assert.equal(opened.count, String(TAG_COUNT))
    assert.equal(opened.note, leftOutNote({ shown: FACET_ROW_CAP, matching: TAG_COUNT, leftOut: TAG_COUNT - FACET_ROW_CAP }))
    assert.ok(opened.noteLast, 'the line sits after the group\'s rows')
    assert.equal(opened.notesInPage, 1, 'only the capped group has the line')

    await filterTags(LAST)
    const found = await tagGroup()
    assert.deepEqual(found.rest, [LAST])
    assert.equal(found.note, null)

    await pressFacet(page, LAST, 'include')
    await filterTags('')
    await page.waitForFunction(() => document.querySelector('.AO3E--search-view--count')?.textContent.includes('of 1 '))
    const selected = await tagGroup()
    assert.deepEqual(selected.included, [LAST])
    assert.equal(selected.rest.length, FACET_ROW_CAP)
    assert.ok(!selected.rest.includes(LAST))
    assert.equal(selected.count, String(TAG_COUNT))
  })
})

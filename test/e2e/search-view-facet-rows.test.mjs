import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { DIST, ensureBuilt, findChrome, installMock, launch } from './helpers.mjs'
import { settled, viewDrawn } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const READINGS_URL = 'https://archiveofourown.org/users/me/readings?show=to-read'
const FILLER = ['F1', 'F2', 'F3', 'F4', 'F5']

function blurb(id, words, freeforms) {
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
        <dd class="words">${words.toLocaleString('en-US')}</dd>
        <dt class="chapters">Chapters:</dt>
        <dd class="chapters">1/1</dd>
      </dl>
    </li>`
}

// Unfiltered, the five fillers and X each have two works, so X sorts after
// them by name. Under 10,000 words the fillers drop to one work and X keeps
// two, so X alone changes place; Z, only on the long work, has none left.
const READINGS_HTML = `<!doctype html>
<html><head><title>Marked for Later</title></head>
<body class="logged-in">
  <div id="header"><a href="/users/me/preferences">Preferences</a></div>
  <div id="main">
    <ul class="navigation actions"><li><span class="current">Marked for Later</span></li></ul>
    <ol class="reading work index group">
      ${blurb(1, 2000, [...FILLER, 'X'])}
      ${blurb(2, 7000, ['X'])}
      ${blurb(3, 40000, [...FILLER, 'Z'])}
    </ol>
  </div>
</body></html>`

/**
 * The search view's facet rows, drawn as the counts change. Which rows show in
 * what order is `layoutFacetRows`'s business and how few moves get them there
 * is `planChildren`'s, each tested case by case in `test/searchView/`; here,
 * that a filter change reaches the sidebar through them.
 */
describe('search view facet rows', { skip }, () => {
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

  /** The values of the Additional Tags rows in the page, in order. */
  const tagRows = () => page.evaluate(() => {
    const group = [...document.querySelectorAll('.AO3E--search-view--group')]
      .find(g => g.querySelector('.AO3E--search-view--group-label')?.textContent?.includes('Additional Tags'))
    return [...group.querySelectorAll('.AO3E--search-view--row-name')].map(el => el.textContent)
  })

  test('a word-count bound moves only the row whose place changed, and takes out the one with no works left', async () => {
    assert.deepEqual(await tagRows(), [...FILLER, 'X', 'Z'])
    await page.evaluate(() => {
      window.__rowsAdded = []
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.classList?.contains('AO3E--search-view--row'))
              window.__rowsAdded.push(node.querySelector('.AO3E--search-view--row-name').textContent)
          }
        }
      }).observe(document.querySelector('.AO3E--search-view--facets'), { childList: true, subtree: true })
      const max = document.querySelector('input[aria-label="Maximum words"]')
      max.value = '10000'
      max.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.waitForFunction(() => document.querySelector('.AO3E--search-view--count')?.textContent.includes('of 2 '))

    assert.deepEqual(await page.evaluate(() => window.__rowsAdded), ['X'])
    assert.deepEqual(await tagRows(), ['X', ...FILLER])
  })
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const WORK_URL = 'https://archiveofourown.org/works/1'

const SEED = {
  'option.textReplacements': {
    enabled: true,
    rules: [{ find: 'middle', replace: 'last', caseSensitive: false, matchCasing: false, wholeWord: false }],
  },
}

/**
 * A work page, laid out the way AO3 lays one out: the summary and notes sit in
 * `.preface.group`, a *sibling* of `#chapters` — not inside it. The title and
 * byline are in that same preface, and must survive untouched.
 */
function workPage() {
  return `<!doctype html>
<html><head><title>A work</title></head><body class="logged-in">
  <div id="header"><ul class="primary navigation"><li class="dropdown"></li></ul></div>
  <div id="main" class="works-show">
    <div id="workskin">
      <div class="preface group">
        <h2 class="title heading">A middle name</h2>
        <h3 class="byline heading">A middle author</h3>
        <div class="summary module">
          <h3 class="heading">Summary:</h3>
          <blockquote class="userstuff"><p>Apart from his boring office job, the middle-aged man doesn't have much going on in his life.</p></blockquote>
        </div>
        <div class="notes module">
          <h3 class="heading">Notes:</h3>
          <blockquote class="userstuff"><p>Written in the middle of the night.</p></blockquote>
        </div>
      </div>
      <div id="chapters" role="article">
        <div class="chapter" id="chapter-1">
          <div class="userstuff"><p>He was middle of the road.</p></div>
        </div>
      </div>
    </div>
  </div>
</body></html>`
}

/**
 * Text replacement covers the whole of a work's prose. It used to walk only
 * `#chapters`, which silently skipped the summary and notes — the two blocks a
 * reader is most likely to be looking at when they set a rule up.
 */
describe('text replacement on a work page', { skip }, () => {
  let browser
  let css
  let js
  let text

  before(async () => {
    ensureBuilt()
    css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-first-run', '--no-default-browser-check'],
    })

    const tab = await browser.newPage()
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html', body: workPage() })
      else
        void req.abort()
    })
    await tab.evaluateOnNewDocument(installMock, SEED)
    // Injected before the document parses, the way the real content script runs.
    await tab.evaluateOnNewDocument(js)
    await tab.goto(WORK_URL, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await sleep(1500)

    text = await tab.evaluate(() => ({
      summary: document.querySelector('.summary blockquote p').textContent,
      notes: document.querySelector('.notes blockquote p').textContent,
      chapter: document.querySelector('#chapters p').textContent,
      title: document.querySelector('h2.title.heading').textContent.trim(),
      byline: document.querySelector('h3.byline.heading').textContent.trim(),
    }))
  }, { timeout: 300000 })

  after(async () => {
    await browser?.close()
  })

  test('rewrites the summary', () => {
    assert.match(text.summary, /the last-aged man/)
  })

  test('rewrites the notes', () => {
    assert.match(text.notes, /the last of the night/)
  })

  test('still rewrites the chapter text', () => {
    assert.match(text.chapter, /last of the road/)
  })

  // The work menu names a work from its heading, and a work rule stores that
  // name as its matched value — so a replacement must never reach them.
  test('leaves the title and byline alone', () => {
    assert.equal(text.title, 'A middle name')
    assert.equal(text.byline, 'A middle author')
  })
})

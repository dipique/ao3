import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const WORK_URL = 'https://archiveofourown.org/works/1'

/**
 * Four rules over one paragraph whose markup splits it in three:
 *
 * 0. wants to read across the seam, and is allowed to.
 * 1. wants the same seam, and isn't — the default.
 * 2. sits wholly inside one text node, so the seam never comes up.
 * 3. would reach across a paragraph boundary, which nothing is allowed to do.
 */
const SEED = {
  'option.textReplacements': {
    enabled: true,
    tools: true,
    rules: [
      { find: ', Love...', replace: ', honey', caseSensitive: true, acrossFormatting: true },
      { find: 'nightlight as soon', replace: 'lamp as soon', caseSensitive: true },
      { find: 'Alright', replace: 'OK', caseSensitive: true },
      { find: 'tonight..." "Second', replace: 'NEVER', caseSensitive: true, acrossFormatting: true },
    ],
  },
}

/**
 * The first paragraph is the reader's own example, verbatim. The second exists
 * only to sit after the first, so a rule can try to reach into it.
 */
function workPage() {
  return `<!doctype html>
<html><head><title>A work</title></head><body class="logged-in">
  <div id="header"><ul class="primary navigation"><li class="dropdown"></li></ul></div>
  <div id="main" class="works-show">
    <div id="workskin">
      <div class="preface group">
        <h2 class="title heading">A work</h2>
        <h3 class="byline heading">An author</h3>
      </div>
      <div id="chapters" role="article">
        <div class="chapter" id="chapter-1">
          <div class="userstuff">
            <p dir="ltr" id="one">"I'll get you a night<em>light</em> as soon as I can,<em> Love....</em> Alright?... Just hold on a bit for tonight..."</p>
            <p dir="ltr" id="two">"Second paragraph."</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</body></html>`
}

describe('replacements across a change of formatting', { skip }, () => {
  let browser
  let tab

  before(async () => {
    ensureBuilt()
    const css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    const js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-first-run', '--no-default-browser-check'],
    })

    tab = await browser.newPage()
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html', body: workPage() })
      else
        void req.abort()
    })
    await tab.evaluateOnNewDocument(installMock, SEED)
    await tab.evaluateOnNewDocument(js)
    await tab.goto(WORK_URL, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await sleep(1500)
  }, { timeout: 300000 })

  after(async () => {
    await browser?.close()
  })

  const html = id => tab.evaluate(at => document.getElementById(at).innerHTML, id)
  const text = id => tab.evaluate(at => document.getElementById(at).textContent, id)

  test('a rule that asked to cross the seam gets its match', async () => {
    // ("OK" rather than "Alright" because rule 2 has already been along.)
    assert.match(await text('one'), /as soon as I can, honey\. OK/)
  })

  test('the replacement lands where the match started, and takes its formatting', async () => {
    // The comma was in the paragraph's own text, so `, honey` is not italic —
    // and the italic run keeps only the full stop the match didn't reach.
    assert.match(await html('one'), /I can<span class="AO3E--replaced"[^>]*>, honey<\/span><em>\.<\/em> /)
  })

  test('a rule that did not ask still gets nothing', async () => {
    // "nightlight" is split by <em>, and rule 1 has no acrossFormatting.
    assert.match(await text('one'), /you a nightlight as soon/)
  })

  test('a rule inside one text node is unaffected either way', async () => {
    assert.match(await text('one'), /OK\?\.\.\. Just hold on/)
  })

  test('nothing reaches across a paragraph boundary, whatever it asked for', async () => {
    assert.match(await text('one'), /for tonight\.\.\."$/)
    assert.equal(await text('two'), '"Second paragraph."')
  })

  test('a crossing replacement is one span, so it edits as one rule', async () => {
    const marks = await tab.evaluate(() => Array.from(
      document.querySelectorAll('#one .AO3E--replaced'),
      el => ({ text: el.textContent, rule: el.getAttribute('data-ao3e-replaced-by') }),
    ))
    assert.deepEqual(marks, [
      { text: ', honey', rule: '0' },
      { text: 'OK', rule: '2' },
    ])
  })
})

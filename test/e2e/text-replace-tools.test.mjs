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
 * Two rules: one that applies, and one parked with `disabled`. The disabled one
 * comes first so its index isn't the one the live rule is checked against — an
 * inert rule still has to hold its place in the list, or clicking a replaced run
 * would open the wrong rule.
 */
const SEED = {
  'option.textReplacements': {
    enabled: true,
    tools: true,
    rules: [
      { find: 'boring', replace: 'thrilling', disabled: true },
      { find: 'middle', replace: 'last', caseSensitive: false, matchCasing: false, wholeWord: false },
    ],
  },
}

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
 * The work-page text replacement tools: the underline under everything a rule
 * replaced, the editor it opens, and the button offered beside a selection.
 */
describe('text replacement tools on a work page', { skip }, () => {
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

  test('wraps each replaced run, naming the rule behind it', async () => {
    const marks = await tab.evaluate(() => Array.from(
      document.querySelectorAll('.AO3E--replaced'),
      el => ({ text: el.textContent, rule: el.getAttribute('data-ao3e-replaced-by') }),
    ))
    assert.deepEqual(marks, [
      { text: 'last', rule: '1' },
      { text: 'last', rule: '1' },
    ])
  })

  // The marks are markup around the same words, not different words: whatever
  // reads the page's text has to see exactly what it saw with the tools off.
  test('leaves the rewritten text reading the same', async () => {
    const text = await tab.evaluate(() => ({
      summary: document.querySelector('.summary blockquote p').textContent,
      chapter: document.querySelector('#chapters p').textContent,
      title: document.querySelector('h2.title.heading').textContent.trim(),
    }))
    assert.match(text.summary, /the last-aged man/)
    assert.match(text.chapter, /last of the road/)
    assert.equal(text.title, 'A middle name')
  })

  test('a disabled rule changes nothing', async () => {
    const summary = await tab.evaluate(() => document.querySelector('.summary blockquote p').textContent)
    assert.match(summary, /his boring office job/)
  })

  test('clicking a replaced run opens that rule', async () => {
    await tab.evaluate(() => document.querySelector('.AO3E--replaced').click())
    await sleep(200)
    const editor = await tab.evaluate(() => {
      const el = document.querySelector('.AO3E--replace-editor')
      if (!el)
        return null
      return {
        title: el.querySelector('.AO3E--replace-editor--title').textContent,
        find: el.querySelector('.AO3E--replace-editor--find').value,
        replace: el.querySelector('.AO3E--replace-editor--replace').value,
        hasDelete: !!el.querySelector('.AO3E--replace-editor--delete'),
      }
    })
    assert.deepEqual(editor, {
      title: 'Edit replacement',
      find: 'middle',
      replace: 'last',
      hasDelete: true,
    })
  })

  test('saving writes the edited rule back in place', async () => {
    await tab.evaluate(() => {
      const el = document.querySelector('.AO3E--replace-editor')
      el.querySelector('.AO3E--replace-editor--replace').value = 'final'
      el.querySelector('.AO3E--replace-editor--save').click()
    })
    await sleep(300)
    const written = await tab.evaluate(() => {
      const write = window.__writes.findLast(w => 'option.textReplacements' in w)
      return write?.['option.textReplacements']
    })
    // The disabled rule is untouched and still first; the edited one is still
    // second, which is what keeps the marks' indexes meaning anything.
    assert.equal(written.rules.length, 2)
    assert.equal(written.rules[0].disabled, true)
    assert.equal(written.rules[1].find, 'middle')
    assert.equal(written.rules[1].replace, 'final')
    assert.equal(written.rules[1].disabled, false)
    assert.equal(written.tools, true)
  })

  test('selecting work text offers to make a rule out of it', async () => {
    // The rebuild after that save re-ran every unit; let it settle first.
    await sleep(1200)
    await tab.evaluate(() => {
      const node = document.querySelector('.summary blockquote p').firstChild
      const range = document.createRange()
      range.setStart(node, 0)
      range.setEnd(node, 5)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
    })
    await sleep(300)
    const button = await tab.evaluate(() => {
      const el = document.querySelector('.AO3E--replace-selection')
      return el ? { text: el.textContent, fixed: getComputedStyle(el).position } : null
    })
    assert.ok(button, 'expected a replace button beside the selection')
    assert.match(button.text, /Replace/)
    assert.equal(button.fixed, 'fixed')
  })

  test('the selection button opens a new rule with the selection in Find', async () => {
    await tab.evaluate(() => document.querySelector('.AO3E--replace-selection').click())
    await sleep(200)
    const editor = await tab.evaluate(() => {
      const el = document.querySelector('.AO3E--replace-editor')
      return el && {
        title: el.querySelector('.AO3E--replace-editor--title').textContent,
        find: el.querySelector('.AO3E--replace-editor--find').value,
        hasDelete: !!el.querySelector('.AO3E--replace-editor--delete'),
      }
    })
    assert.deepEqual(editor, { title: 'New replacement', find: 'Apart', hasDelete: false })
  })

  // The one pill that is on every page, and the reason the toolbar now is too.
  test('the floating toolbar offers the options page', async () => {
    const labels = await tab.evaluate(() => Array.from(
      document.querySelectorAll('.AO3E--filter-toolbar--button'),
      el => el.textContent,
    ))
    assert.ok(labels.some(label => /Open extension options/.test(label)), labels.join(' | '))
    assert.ok(labels.some(label => /text replacement tools/i.test(label)), labels.join(' | '))
  })
})

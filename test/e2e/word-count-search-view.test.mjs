import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const READINGS_URL = 'https://archiveofourown.org/users/me/readings?show=to-read'

const SEED = {
  'option.searchMarkedForLater': true,
  'option.wordCountToolbar': {
    enabled: true,
    ranges: [{ from: 1000, to: 3000 }, { from: 5000, to: 100000 }],
  },
}

function blurb(id, title, words) {
  return `
    <li class="blurb work" id="work_${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">${title}</a> by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4>
        <h5 class="fandoms heading"><a class="tag" href="/tags/F/works">A Fandom</a></h5>
        <ul class="required-tags"><li><a class="help symbol question modal" href="/help/symbols-key.html"><span class="rating rating-general-audiences" title="General Audiences"><span class="text">General Audiences</span></span></a></li></ul>
      </div>
      <dl class="stats">
        <dt class="words">Words:</dt>
        <dd class="words">${words.toLocaleString('en-US')}</dd>
        <dt class="chapters">Chapters:</dt>
        <dd class="chapters">1/1</dd>
      </dl>
    </li>`
}

/** A minimal but structurally real "Marked for Later" page for our own user. */
const READINGS_HTML = `<!doctype html>
<html><head><title>Marked for Later</title></head>
<body class="logged-in">
  <div id="header"><a href="/users/me/preferences">Preferences</a></div>
  <div id="main">
    <ul class="navigation actions"><li><span class="current">Marked for Later</span></li></ul>
    <ol class="reading work index group">
      ${blurb(1, 'A short one', 2000)}
      ${blurb(2, 'A long one', 40000)}
      ${blurb(3, 'A middling one', 7000)}
    </ol>
  </div>
</body></html>`

/**
 * The same word-count menu inside a custom search page. "Search Marked for
 * Later" renders its own in-memory view, so a range picked there must drive that
 * view's filter — not AO3's sidebar, which the page doesn't even have.
 */
describe('word-count range menu in the search view', { skip }, () => {
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
    // Serve every archiveofourown.org request from the fixture: the page itself,
    // and the page-1 fetch the view's scrape makes. Nothing leaves the machine.
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html', body: READINGS_HTML })
      else
        void req.abort()
    })
    await page.evaluateOnNewDocument(installMock, SEED)
    await page.goto(READINGS_URL, { waitUntil: 'domcontentloaded' })
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await sleep(1200)

    // Open the in-memory view, then wait for the scrape + first render.
    await page.click('.AO3E--search-marked-for-later--button')
    await sleep(1500)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /** Titles of the works currently visible in the view. */
  const visibleTitles = () => page.evaluate(() =>
    [...document.querySelectorAll('.AO3E--search-view--results > li.blurb')]
      .filter(li => li.style.display !== 'none' && !li.classList.contains('AO3E--search-view--hidden'))
      .map(li => li.querySelector('h4.heading a').textContent))

  const wordBounds = () => page.evaluate(() => {
    const inputs = [...document.querySelectorAll('.AO3E--search-view--words input')]
    return { min: inputs[0].value, max: inputs[1].value }
  })

  const openMenuOnFirstWordCount = async () => {
    await page.evaluate(() => {
      document.querySelector('.AO3E--search-view--results dd.words').click()
    })
    await sleep(200)
    return page.evaluate(() =>
      [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
        .map(el => el.querySelector('.AO3E--menu--label').textContent))
  }

  const pick = async (prefix) => {
    await page.evaluate((p) => {
      const rows = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
      rows.find(el => el.textContent.startsWith(p)).click()
    }, prefix)
    await sleep(400)
  }

  test('the view opened with every work', async () => {
    assert.deepEqual((await visibleTitles()).sort(), ['A long one', 'A middling one', 'A short one'])
  })

  test('the word counts in the view carry the menu', async () => {
    const labels = await openMenuOnFirstWordCount()
    assert.deepEqual(labels.filter(l => l.includes('words')).length, 2, labels.join(' | '))
    assert.ok(!labels.some(l => l.startsWith('Clear')), 'nothing to clear yet')
  })

  test('picking a range filters the loaded list, not AO3', async () => {
    await pick('5,000')
    assert.deepEqual(await wordBounds(), { min: '5000', max: '100000' })
    // 7,000 and 40,000 are inside 5,000–100,000; the 2,000-word one is not.
    assert.deepEqual((await visibleTitles()).sort(), ['A long one', 'A middling one'])
    // Still on our own page — the pick must not have submitted anything.
    assert.equal(page.url(), READINGS_URL)
  })

  test('clearing restores the full list', async () => {
    await openMenuOnFirstWordCount()
    await pick('Clear')
    assert.deepEqual(await wordBounds(), { min: '', max: '' })
    assert.deepEqual((await visibleTitles()).sort(), ['A long one', 'A middling one', 'A short one'])
  })
})

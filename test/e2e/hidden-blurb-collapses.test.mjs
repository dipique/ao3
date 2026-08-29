import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, REPO_ROOT, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const LISTING_URL = 'https://archiveofourown.org/works?work_search[query]=x'

const SEED = {
  'option.rules': {
    enabled: true,
    colors: {},
    filters: [{ target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'hide' }],
  },
}

/** One AO3 search-results listing: a work tagged Fluff, and one that isn't. */
function listing() {
  return `<!doctype html>
<html><head><title>Works</title></head><body class="logged-in works-index">
  <div id="header"><ul class="primary navigation"><li class="dropdown"></li></ul></div>
  <div id="main" class="works-index">
    <ol class="work index group">
      <li id="work_75388256" class="work blurb group" role="article">
        <div class="header module">
          <h4 class="heading"><a href="/works/75388256">Hidden one</a>
            <a href="/users/a/pseuds/a" rel="author">a</a></h4>
        </div>
        <ul class="tags commas">
          <li class="freeforms"><a class="tag" href="/tags/Fluff/works">Fluff</a></li>
        </ul>
      </li>
      <li id="work_75388257" class="work blurb group" role="article">
        <div class="header module">
          <h4 class="heading"><a href="/works/75388257">Shown one</a>
            <a href="/users/b/pseuds/b" rel="author">b</a></h4>
        </div>
        <ul class="tags commas">
          <li class="freeforms"><a class="tag" href="/tags/Angst/works">Angst</a></li>
        </ul>
      </li>
    </ol>
  </div>
</body></html>`
}

/**
 * A rule with the `hide` behaviour drops the whole `<li>`. AO3's own
 * `li.blurb { display: block }` is an author rule and so outranks the UA
 * stylesheet's `[hidden] { display: none }` — setting the attribute alone left
 * the blurb's padded box on the page as an empty rectangle.
 */
describe('a work hidden outright leaves no gap', { skip }, () => {
  let browser
  let tab

  before(async () => {
    ensureBuilt()
    const css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    const js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')
    // AO3's real screen stylesheet — the source of the `li.blurb` display rule.
    const ao3 = await readFile(
      join(REPO_ROOT, '..', 'html', '_shared', 'stylesheets', 'skins', 'skin_1_default', '1_site_screen_.css'),
      'utf8',
    )
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-first-run', '--no-default-browser-check'],
    })
    tab = await browser.newPage()
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html', body: listing() })
      else
        void req.abort()
    })
    await tab.evaluateOnNewDocument(installMock, SEED)
    await tab.goto(LISTING_URL, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: ao3 })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await sleep(1500)
  }, { timeout: 300000 })

  after(async () => {
    await browser?.close()
  })

  const box = id => tab.evaluate((i) => {
    const li = document.getElementById(i)
    return {
      hidden: li.hasAttribute('hidden'),
      display: getComputedStyle(li).display,
      height: li.getBoundingClientRect().height,
    }
  }, id)

  test('the matched work is marked hidden', async () => {
    const li = await box('work_75388256')
    assert.equal(li.hidden, true)
  })

  test('and takes up no space — no empty rectangle', async () => {
    const li = await box('work_75388256')
    assert.equal(li.display, 'none', 'AO3\'s li.blurb display rule must be overridden')
    assert.equal(li.height, 0)
  })

  test('the unmatched work is untouched', async () => {
    const li = await box('work_75388257')
    assert.equal(li.hidden, false)
    assert.equal(li.display, 'block')
    assert.ok(li.height > 0)
  })

  test('peek still reveals the hidden work', async () => {
    await tab.evaluate(() => document.body.classList.add('AO3E--peek-hidden'))
    const li = await box('work_75388256')
    assert.equal(li.display, 'block')
    assert.ok(li.height > 0)
    await tab.evaluate(() => document.body.classList.remove('AO3E--peek-hidden'))
  })
})

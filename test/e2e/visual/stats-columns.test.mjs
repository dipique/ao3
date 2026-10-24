import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { DIST, ensureBuilt, findChrome, installMock, launch } from '../helpers.mjs'
import { settled } from '../trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const LISTING_URL = 'https://archiveofourown.org/tags/A%20Fandom/works'

/** AO3's own type and blurb box, at about the width the search view gives a blurb. */
const AO3_CSS = `
  body { margin: 0; font: 100%/1.125 'Lucida Grande', 'Lucida Sans Unicode', Verdana, Helvetica, sans-serif; }
  #main { font-size: 0.875em; padding: 1em; }
  ol.index { list-style: none; margin: 0; padding: 0; }
  li.blurb { width: 760px; padding: 0.429em 0.75em; border: 1px solid #ddd; }`

/** Every statistic AO3 puts on a blurb, before the extension adds its own. */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Works</title><style>${AO3_CSS}</style></head>
<body>
  <div id="main" class="works-index">
    <ol class="work index group">
      <li id="work_1" class="work blurb group" role="article">
        <div class="header module"><h4 class="heading"><a href="/works/1">A work</a> by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4></div>
        <dl class="stats">
          <dt class="language">Language:</dt><dd class="language" lang="en">English</dd>
          <dt class="words">Words:</dt><dd class="words">3,169</dd>
          <dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd>
          <dt class="comments">Comments:</dt><dd class="comments"><a href="/works/1?show_comments=true">11</a></dd>
          <dt class="kudos">Kudos:</dt><dd class="kudos"><a href="/works/1#kudos">86</a></dd>
          <dt class="bookmarks">Bookmarks:</dt><dd class="bookmarks"><a href="/works/1/bookmarks">8</a></dd>
          <dt class="hits">Hits:</dt><dd class="hits">1,101</dd>
        </dl>
      </li>
    </ol>
  </div>
</body></html>`

/**
 * "Show statistics in columns" stands each statistic's value under its label.
 * A label set as large as its value made every column as wide as its label,
 * so a work's full line of statistics ran to a second row of columns — four
 * lines in all. A small label over each value keeps the columns as narrow as
 * their values, and the whole line to one row.
 */
describe('statistics in columns', { skip }, () => {
  let browser
  let css
  let js

  before(async () => {
    ensureBuilt()
    css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  const open = async (columns) => {
    const tab = await browser.newPage()
    await tab.setViewport({ width: 1280, height: 800 })
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE })
      else
        void req.abort()
    })
    await tab.evaluateOnNewDocument(installMock, { 'option.showStatsColumns': columns })
    await tab.goto(LISTING_URL, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await settled(tab)
    return tab
  }

  /** Each statistic's label and value boxes, and their type sizes. */
  const pairs = tab => tab.evaluate(() => [...document.querySelectorAll('dl.stats dt')].map((dt) => {
    const dd = dt.nextElementSibling
    const box = el => el.getBoundingClientRect()
    return {
      name: dt.textContent.trim(),
      dt: { top: box(dt).top, bottom: box(dt).bottom, left: box(dt).left, size: Number.parseFloat(getComputedStyle(dt).fontSize) },
      dd: { top: box(dd).top, left: box(dd).left, size: Number.parseFloat(getComputedStyle(dd).fontSize) },
    }
  }))

  test('each value stands under a smaller label', async () => {
    const tab = await open(true)
    const stats = await pairs(tab)
    await tab.close()
    assert.ok(stats.length >= 7, `${stats.length} statistics`)
    for (const { name, dt, dd } of stats) {
      assert.ok(dd.top >= dt.bottom - 1, `${name} value under its label`)
      assert.ok(Math.abs(dd.left - dt.left) < 1, `${name} value lined up with its label`)
      assert.ok(dt.size <= dd.size * 0.8, `${name} label ${dt.size}px, value ${dd.size}px`)
    }
  })

  test('a work\'s full line of statistics keeps to one row', async () => {
    const tab = await open(true)
    const stats = await pairs(tab)
    await tab.close()
    const rows = new Set(stats.map(({ dt }) => Math.round(dt.top)))
    assert.equal(rows.size, 1, `labels on ${rows.size} rows: ${stats.map(s => `${s.name} ${Math.round(s.dt.top)}`).join(', ')}`)
  })

  test('with the setting off, each label and its value share a line', async () => {
    const tab = await open(false)
    const stats = await pairs(tab)
    await tab.close()
    for (const { name, dt, dd } of stats)
      assert.ok(Math.abs(dd.top - dt.top) < 4, `${name} on one line`)
  })
})

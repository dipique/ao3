import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const URL_TO_READ = 'https://archiveofourown.org/users/me/readings?show=to-read'
const HOUR = 60 * 60_000
/** Enough works that rebuilding the list from storage is a cost you can see. */
const LISTED = 400
/** Another stored list — a long read list — sharing the one snapshot entry. */
const OTHER = 3000

function blurb(id, title) {
  const tags = Array.from({ length: 12 }, (_, i) =>
    `<li class="freeforms"><a class="tag" href="/tags/Tag%20${(id * 7 + i) % 90}/works">Tag ${(id * 7 + i) % 90}</a></li>`).join('')
  return `<li class="reading work blurb group" id="work_${id}" role="article">
    <!--title, author, fandom-->
    <div class="header module">
      <h4 class="heading"><a href="/works/${id}">${title}</a>
        by <a rel="author" href="/users/someone${id % 40}/pseuds/someone${id % 40}">someone${id % 40}</a></h4>
      <h5 class="fandoms heading"><span class="landmark">Fandoms:</span>
        <a class="tag" href="/tags/Fandom%20${id % 15}/works">Fandom ${id % 15}</a></h5>
      <ul class="required-tags"><li><a class="help symbol question modal" title="Symbols key"><span class="rating-teen rating" title="Teen And Up Audiences"><span class="text">Teen And Up Audiences</span></span></a></li>
        <li><span class="complete-yes iswip" title="Complete Work"><span class="text">Complete Work</span></span></li></ul>
      <p class="datetime">19 Jun 2012</p>
    </div>
    <ul class="tags commas">${tags}</ul>
    <blockquote class="userstuff summary"><p>A summary for work ${id}, long enough to be a summary.</p></blockquote>
    <dl class="stats"><dt class="language">Language:</dt><dd class="language" lang="en">English</dd>
      <dt class="words">Words:</dt><dd class="words">${(id * 131) % 90000}</dd>
      <dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd>
      <dt class="kudos">Kudos:</dt><dd class="kudos">${id % 500}</dd>
      <dt class="hits">Hits:</dt><dd class="hits">${id * 3}</dd></dl>
  </li>`
}

function toReadPage() {
  const listed = Array.from({ length: 20 }, (_, i) => blurb(i + 1, `Work ${i + 1}`)).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Marked for Later</title></head>
<body class="logged-in">
  <div id="header"><a href="/users/me/preferences">Preferences</a></div>
  <div id="main" class="readings-index dashboard region">
    <h2 class="heading">Marked for Later</h2>
    <ul class="navigation actions" role="navigation">
      <li><a href="/users/me/readings">History</a></li>
      <li><span class="current">Marked for Later</span></li>
    </ul>
    <ol class="reading work index group">${listed}</ol>
    <ol role="navigation" class="pagination actions"><li><span class="current">1</span></li></ol>
  </div>
</body></html>`
}

function snapshots() {
  const descriptor = (sourceId, label) => ({ sourceId, label, listUrl: URL_TO_READ })
  return {
    'marked-for-later:me': {
      version: 2,
      scrapedAt: Date.now() - HOUR,
      blurbsHtml: Array.from({ length: LISTED }, (_, i) => blurb(i + 1, `Work ${i + 1}`)),
      descriptor: descriptor('marked-for-later', 'Marked for Later — me'),
    },
    'read-works:me': {
      version: 2,
      scrapedAt: Date.now() - HOUR,
      blurbsHtml: Array.from({ length: OTHER }, (_, i) => blurb(10_000 + i, `Read ${i}`)),
      descriptor: descriptor('read-works', 'Read — me'),
    },
  }
}

const workMarks = readIds => ({
  enabled: true,
  marks: {
    read: { icon: 'read', label: 'Read', color: '#6b7280', hideSearchResult: false, items: readIds, order: 0 },
    saved: { icon: 'saved', label: 'Marked for later', color: '#2f8f4e', order: 1 },
  },
})

/**
 * The real storage API answers across a process boundary: never in the same
 * task, and a copy rather than the object itself. The shared mock answers with
 * a resolved promise, which would hide exactly the gap this file is about.
 */
function slowStorage() {
  const { local } = window.browser.storage
  const get = local.get.bind(local)
  local.get = keys => get(keys).then(out => new Promise(resolve => setTimeout(() => resolve(structuredClone(out)), 0)))
}

/**
 * What an options change does to a Marked for Later list that is already on
 * screen. Every change re-runs the whole page — that is how a new setting
 * reaches every unit — but the list itself has nothing new to fetch, so the
 * reader should never see it leave: not blank, not a frame without it.
 */
describe('Marked for Later across a re-run', { skip }, () => {
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

  test('marking a work read takes it off the list without the list leaving the screen', { timeout: 60000 }, async () => {
    const tab = await browser.newPage()
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (!req.url().startsWith('https://archiveofourown.org/'))
        return void req.abort()
      void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: toReadPage() })
    })
    await tab.evaluateOnNewDocument(installMock, {
      'option.searchMarkedForLater': true,
      'option.workMarks': workMarks(''),
      'cache.searchSnapshots': snapshots(),
    })
    await tab.evaluateOnNewDocument(slowStorage)
    await tab.goto(URL_TO_READ, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await tab.waitForSelector('.AO3E--search-view--results > li.blurb', { timeout: 20000 })
    await sleep(500)

    // Scrolled into the list, as a reader coming back to it would be.
    await tab.evaluate(() => window.scrollTo(0, 1500))
    const scrolled = await tab.evaluate(() => window.scrollY)

    // Watch every frame from here on for one drawn without the list.
    await tab.evaluate(() => {
      const shown = () => document.querySelectorAll('.AO3E--search-view--results > li.blurb:not(.AO3E--search-view--hidden)').length
      window.__frames = { total: 0, blank: 0, gone: 0, back: 0 }
      const t0 = performance.now()
      const tick = () => {
        const f = window.__frames
        f.total++
        if (shown() === 0) {
          f.blank++
          f.gone ||= performance.now() - t0
        }
        else if (f.gone && !f.back) {
          f.back = performance.now() - t0
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await tab.evaluate(marks => browser.storage.local.set({ 'option.workMarks': marks }), workMarks('1'))
    await sleep(4000)

    const frames = await tab.evaluate(() => window.__frames)
    const titles = await tab.evaluate(() =>
      Array.from(document.querySelectorAll('.AO3E--search-view--results > li.blurb'), li => li.querySelector('h4.heading a')?.textContent?.trim()))
    assert.equal(titles.length, LISTED - 1, 'the work marked read is off the list')
    assert.ok(!titles.includes('Work 1'))
    assert.equal(frames.blank, 0, `the list was missing for ${frames.blank} frames (${Math.round(frames.back - frames.gone)}ms)`)
    assert.equal(await tab.evaluate(() => window.scrollY), scrolled, 'and the reader is still where they were')
    await tab.close()
  })
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const TAG_URL = 'https://archiveofourown.org/tags/marriage%20problems'

const RULES = {
  enabled: true,
  colors: {},
  filters: [
    { target: 'tag', value: 'Soft', matcher: 'exact', behavior: 'collapse' },
    { target: 'tag', value: 'Gone', matcher: 'exact', behavior: 'hide' },
    { target: 'tag', value: 'Doomed', matcher: 'exact', behavior: 'hide' },
    { target: 'tag', value: 'Keeper', matcher: 'exact', behavior: 'invert' },
  ],
}

function blurb(id, title, tags) {
  const tagList = ['marriage problems', ...tags]
    .map(t => `<li class="freeforms"><a class="tag" href="/tags/${encodeURIComponent(t)}/works">${t}</a></li>`)
    .join('')
  return `
    <li class="work blurb group" id="work_${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">${title}</a> by <a rel="author" href="/users/s/pseuds/s">s</a></h4>
        <h5 class="fandoms heading"><a class="tag" href="/tags/F/works">A Fandom</a></h5>
      </div>
      <ul class="tags commas">${tagList}</ul>
      <dl class="stats">
        <dt class="language">Language:</dt><dd class="language">English</dd>
        <dt class="words">Words:</dt><dd class="words">1,000</dd>
        <dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd>
      </dl>
    </li>`
}

/**
 * One work per outcome: left alone, collapsed, hidden, and one a hide rule
 * matches but an "always show" rule keeps on the page. The kept one is matched
 * by a hide rule of its own, so "Gone" is carried by the hidden work alone and a
 * search view is free to hand it to its filter.
 */
const WORKS = [
  blurb(1, 'Plain one', []),
  blurb(2, 'Soft one', ['Soft']),
  blurb(3, 'Gone one', ['Gone']),
  blurb(4, 'Kept one', ['Doomed', 'Keeper']),
].join('')

/** An uncommon tag's page, which is what offers "Search these works". */
const TAG_PAGE = `<!doctype html>
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
        <ol role="navigation" class="pagination actions"><li><span class="current">1</span></li></ol>
        <ul class="index group">${WORKS}</ul>
      </div>
    </div>
  </div>
</body></html>`

const SOFT = 'Work 2 "Soft one" collapsed — Additional Tags: "Soft" (Any tag "Soft")'
const GONE = 'Work 3 "Gone one" hidden — Additional Tags: "Gone" (Any tag "Gone")'

/**
 * With debug mode on, every work the extension takes off the page — or out of a
 * search view's results — says so in the console, naming the rule responsible.
 * Without it, the console hears nothing about it.
 */
describe('removed works are logged in debug mode', { skip }, () => {
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

  /** Load the tag page with `seed` in storage; returns the page and everything it logs. */
  async function open(seed) {
    const page = await browser.newPage()
    const logs = []
    page.on('console', msg => logs.push(msg.text()))
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      if (!req.url().startsWith('https://archiveofourown.org/'))
        return void req.abort()
      void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: TAG_PAGE })
    })
    await page.evaluateOnNewDocument(installMock, seed)
    await page.goto(TAG_URL, { waitUntil: 'domcontentloaded' })
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await sleep(1200)
    return { page, logs }
  }

  /** Open the search view over the tag's works, and give it time to settle. */
  async function openView(page) {
    await page.click('.AO3E--search-tag-works--link')
    await sleep(2500)
  }

  const linesAbout = (logs, id) => logs.filter(line => line.includes(`Work ${id} "`))

  test('a listing logs each work it hides or collapses, with the reason', async () => {
    const { page, logs } = await open({ 'option.verbose': true, 'option.rules': RULES })
    try {
      assert.ok(logs.some(line => line.includes(SOFT)), `no line saying: ${SOFT}\n${logs.join('\n')}`)
      assert.ok(logs.some(line => line.includes(GONE)), `no line saying: ${GONE}\n${logs.join('\n')}`)
      assert.deepEqual(linesAbout(logs, 1), [], 'a work nothing matched is not logged')
      assert.deepEqual(linesAbout(logs, 4), [], 'a work an "always show" rule kept is not logged')
    }
    finally {
      await page.close()
    }
  })

  test('nothing is logged with debug mode off', async () => {
    const { page, logs } = await open({ 'option.verbose': false, 'option.rules': RULES })
    try {
      assert.deepEqual(logs.filter(line => /Work \d "/.test(line)), [])
    }
    finally {
      await page.close()
    }
  })

  test('a search view logs the works its rules leave out of the results', async () => {
    const { page, logs } = await open({ 'option.verbose': true, 'option.searchTagWorks': true, 'option.rules': RULES })
    try {
      await openView(page)
      const line = 'Work 3 "Gone one" left out of the results — Additional Tags: "Gone" (Any tag "Gone")'
      assert.ok(logs.some(l => l.includes(line)), `no line saying: ${line}\n${logs.join('\n')}`)
    }
    finally {
      await page.close()
    }
  })

  test('a search view logs the works it hands to its own filter', async () => {
    const { page, logs } = await open({
      'option.verbose': true,
      'option.searchTagWorks': true,
      'option.autoExcludeHidden': true,
      'option.rules': RULES,
    })
    try {
      await openView(page)
      const line = 'Work 3 "Gone one" excluded by the view\'s filter — Additional Tags: "Gone" (Any tag "Gone")'
      assert.ok(logs.some(l => l.includes(line)), `no line saying: ${line}\n${logs.join('\n')}`)
    }
    finally {
      await page.close()
    }
  })
})

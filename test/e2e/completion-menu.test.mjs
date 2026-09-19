import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

function launch() {
  return puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-first-run', '--no-default-browser-check'],
  })
}

/** The open menu's rows. */
const menuRows = page => page.evaluate(() =>
  [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')].map(el => ({
    label: el.querySelector('.AO3E--menu--label').textContent,
    disabled: el.disabled,
  })))

/** Click the open menu's row whose label starts with `prefix`. */
async function pick(page, prefix) {
  const picked = await page.evaluate((p) => {
    const row = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
      .find(el => el.querySelector('.AO3E--menu--label').textContent.startsWith(p))
    row?.click()
    return !!row
  }, prefix)
  assert.ok(picked, `no "${prefix}" row in the menu`)
  await sleep(400)
}

/** Close whatever menu is up, then click `selector` to open its menu. */
async function openMenu(page, selector) {
  await page.keyboard.press('Escape')
  await sleep(100)
  await page.evaluate(sel => document.querySelector(sel).click(), selector)
  await sleep(200)
  return menuRows(page)
}

/**
 * Two blurbs — a finished work whose left number is AO3's link to the latest
 * chapter, and an open-ended one — plus the Sort & Filter sidebar's Completion
 * Status radios, in AO3's own markup. The form is `action="#"` so a submit can
 * be observed without navigating away.
 */
const PAGE = `
<div id="main">
  <ol class="work index group">
    <li class="blurb work" id="done">
      <h4 class="heading"><a href="/works/1">A finished work</a></h4>
      <dl class="stats">
        <dt class="words">Words:</dt>
        <dd class="words">70,150</dd>
        <dt class="chapters">Chapters:</dt>
        <dd class="chapters"><a href="#latest">9</a>/23</dd>
      </dl>
    </li>
    <li class="blurb work" id="open">
      <h4 class="heading"><a href="/works/2">An open-ended work</a></h4>
      <dl class="stats">
        <dt class="words">Words:</dt>
        <dd class="words">2,497</dd>
        <dt class="chapters">Chapters:</dt>
        <dd class="chapters">1/?</dd>
      </dl>
    </li>
  </ol>

  <form id="work-filters" method="get" action="#">
    <dt class="filter-toggle complete">Completion Status</dt>
    <dd class="expandable"><ul>
      <li><label><input type="radio" value="" checked="checked" name="work_search[complete]" id="work_search_complete_"><span>All works</span></label></li>
      <li><label><input type="radio" value="T" name="work_search[complete]" id="work_search_complete_t"><span>Complete works only</span></label></li>
      <li><label><input type="radio" value="F" name="work_search[complete]" id="work_search_complete_f"><span>Works in progress only</span></label></li>
    </ul></dd>
    <input type="submit" name="commit" value="Sort and Filter">
  </form>
</div>
`

/**
 * The completion menu on a native listing: clicking a work's chapter total (or
 * the "Chapters:" label) offers complete / incomplete works only, and ticks
 * AO3's own Completion Status radio — without submitting it, so the reader runs
 * the search when they're ready, prompted by the pending-search toast.
 */
describe('completion menu', { skip }, () => {
  let browser
  let page

  before(async () => {
    ensureBuilt()
    const css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    const js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')

    browser = await launch()
    page = await browser.newPage()
    await page.goto('about:blank')
    await page.evaluate(installMock, { 'option.completionToolbar': true })
    await page.evaluate((html) => {
      document.body.innerHTML = html
      window.__submits = 0
      document.getElementById('work-filters').addEventListener('submit', (e) => {
        e.preventDefault()
        window.__submits++
      })
    }, PAGE)
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await sleep(1500)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  const radio = () => page.evaluate(() => ({
    checked: document.querySelector('input[name="work_search[complete]"]:checked').value,
    submits: window.__submits,
  }))

  /** The pending-search prompt's message, or null when it isn't up. */
  const prompt = () => page.evaluate(() => {
    for (const el of document.body.children) {
      const toast = [...el.shadowRoot?.querySelectorAll('.toast') ?? []]
        .find(t => t.querySelector('.action')?.textContent.startsWith('Update results'))
      if (toast && toast.style.visibility !== 'hidden')
        return toast.querySelector('.message').textContent
    }
    return null
  })

  test('wraps only the chapter total, and marks the label', async () => {
    const cells = await page.evaluate(() => [...document.querySelectorAll('dd.chapters')].map(dd => ({
      text: dd.textContent,
      total: dd.querySelector('.AO3E--completion')?.textContent ?? null,
      link: dd.querySelector('a')?.classList.contains('AO3E--completion') ?? null,
    })))
    assert.deepEqual(cells, [
      { text: '9/23', total: '23', link: false },
      { text: '1/?', total: '?', link: null },
    ])
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('dt.chapters.AO3E--completion')].length)
    assert.equal(labels, 2)
  })

  test('offers both choices, and no clear row while none is set', async () => {
    const rows = await openMenu(page, '#open dd.chapters .AO3E--completion')
    assert.deepEqual(rows.map(r => r.label), ['Completed works only', 'Incomplete works only'])
  })

  test('picking one ticks AO3\'s radio without re-running the search', async () => {
    await pick(page, 'Completed works only')
    assert.deepEqual(await radio(), { checked: 'T', submits: 0 })
    assert.equal(await prompt(), 'Completion filter set to completed works only.')
  })

  test('the label opens the same menu, showing the choice as current', async () => {
    const rows = await openMenu(page, '#done dt.chapters')
    assert.deepEqual(rows.map(r => r.label), [
      'Clear completion filter (completed works only)',
      'Completed works only',
      'Incomplete works only',
    ])
    assert.equal(rows[1].disabled, true, 'the choice already on should not be selectable again')
  })

  test('the other choice replaces it', async () => {
    await pick(page, 'Incomplete works only')
    assert.deepEqual(await radio(), { checked: 'F', submits: 0 })
  })

  test('clearing goes back to all works, and the prompt comes down', async () => {
    await openMenu(page, '#done dd.chapters .AO3E--completion')
    await pick(page, 'Clear')
    assert.deepEqual(await radio(), { checked: '', submits: 0 })
    assert.equal(await prompt(), null, 'the form is back in step with the results')
  })

  test('the chapter link is still just a link', async () => {
    await page.keyboard.press('Escape')
    await sleep(100)
    await page.click('#done dd.chapters a')
    await sleep(200)
    assert.equal(await page.$('.AO3E--menu'), null, 'no menu on the chapter link')
    assert.ok(page.url().endsWith('#latest'), page.url())
  })
})

const READINGS_URL = 'https://archiveofourown.org/users/me/readings?show=to-read'

function blurb(id, title, complete) {
  return `
    <li class="blurb work" id="work_${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">${title}</a> by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4>
        <h5 class="fandoms heading"><a class="tag" href="/tags/F/works">A Fandom</a></h5>
        <ul class="required-tags">
          <li><a class="help symbol question modal" href="/help/symbols-key.html"><span class="rating rating-general-audiences" title="General Audiences"><span class="text">General Audiences</span></span></a></li>
          <li><a class="help symbol question modal" href="/help/symbols-key.html"><span class="${complete ? 'complete-yes' : 'complete-no'} iswip" title="${complete ? 'Complete Work' : 'Work in Progress'}"><span class="text">${complete ? 'Complete Work' : 'Work in Progress'}</span></span></a></li>
        </ul>
      </div>
      <dl class="stats">
        <dt class="words">Words:</dt>
        <dd class="words">1,000</dd>
        <dt class="chapters">Chapters:</dt>
        <dd class="chapters">${complete ? '3/3' : '1/?'}</dd>
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
      ${blurb(1, 'A finished one', true)}
      ${blurb(2, 'An ongoing one', false)}
      ${blurb(3, 'Another finished one', true)}
    </ol>
  </div>
</body></html>`

/**
 * The same menu inside a custom search page: the pick drives the view's own
 * Completion Status facet and filters the loaded list at once.
 */
describe('completion menu in the search view', { skip }, () => {
  let browser
  let page

  before(async () => {
    ensureBuilt()
    const css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    const js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')

    browser = await launch()
    page = await browser.newPage()
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html', body: READINGS_HTML })
      else
        void req.abort()
    })
    await page.evaluateOnNewDocument(installMock, {
      'option.searchMarkedForLater': true,
      'option.completionToolbar': true,
    })
    await page.goto(READINGS_URL, { waitUntil: 'domcontentloaded' })
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await sleep(2700)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  const visibleTitles = () => page.evaluate(() =>
    [...document.querySelectorAll('.AO3E--search-view--results > li.blurb')]
      .filter(li => li.style.display !== 'none' && !li.classList.contains('AO3E--search-view--hidden'))
      .map(li => li.querySelector('h4.heading a').textContent)
      .sort())

  /** The completion values whose facet row has its "include" toggle on. */
  const included = () => page.evaluate(() =>
    [...document.querySelectorAll('.AO3E--search-view--row')]
      .filter(row => row.querySelector('.AO3E--search-view--toggle-include')?.getAttribute('aria-pressed') === 'true')
      .map(row => row.querySelector('.AO3E--search-view--row-name').textContent)
      .filter(name => name === 'Complete' || name === 'Work in Progress'))

  const TOTAL = '.AO3E--search-view--results dd.chapters .AO3E--completion'

  test('the view opened with every work', async () => {
    assert.deepEqual(await visibleTitles(), ['A finished one', 'An ongoing one', 'Another finished one'])
  })

  test('picking a choice filters the loaded list, not AO3', async () => {
    const rows = await openMenu(page, TOTAL)
    assert.deepEqual(rows.map(r => r.label), ['Completed works only', 'Incomplete works only'])
    await pick(page, 'Incomplete works only')
    assert.deepEqual(await visibleTitles(), ['An ongoing one'])
    assert.deepEqual(await included(), ['Work in Progress'], 'the facet sidebar shows the same filter')
    assert.equal(page.url(), READINGS_URL)
  })

  test('the other choice replaces it rather than adding to it', async () => {
    const rows = await openMenu(page, TOTAL)
    assert.equal(rows[0].label, 'Clear completion filter (incomplete works only)')
    await pick(page, 'Completed works only')
    assert.deepEqual(await visibleTitles(), ['A finished one', 'Another finished one'])
    assert.deepEqual(await included(), ['Complete'])
  })

  test('the facet sidebar\'s own selection reads back as the current choice', async () => {
    const rows = await openMenu(page, '.AO3E--search-view--results dt.chapters')
    assert.equal(rows.find(r => r.label === 'Completed works only').disabled, true)
  })

  test('clearing restores the full list', async () => {
    await pick(page, 'Clear')
    assert.deepEqual(await visibleTitles(), ['A finished one', 'An ongoing one', 'Another finished one'])
    assert.deepEqual(await included(), [])
  })
})

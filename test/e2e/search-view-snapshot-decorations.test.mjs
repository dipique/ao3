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
  'option.tagToolbar': true,
  'option.fandomToolbar': true,
  'option.showKudosHitsRatio': true,
  'option.rules': {
    enabled: true,
    colors: {},
    filters: [
      // A star after the tag — the indicator that came out doubled.
      { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'highlight' },
      // HideWorks' wrapper and reason line: the one unit that rewrites a blurb.
      { target: 'tag', value: 'HideMe', matcher: 'exact', behavior: 'collapse' },
    ],
  },
}

function blurb(id, title, tags) {
  const tagList = tags
    .map(t => `<li class="freeforms"><a class="tag" href="/tags/${encodeURIComponent(t)}/works">${t}</a></li>`)
    .join('')
  return `<li class="blurb work" id="work_${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">${title}</a> by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4>
        <h5 class="fandoms heading"><a class="tag" href="/tags/A%20Fandom/works">A Fandom</a></h5>
      </div>
      <ul class="tags commas">${tagList}</ul>
      <dl class="stats">
        <dt class="words">Words:</dt><dd class="words">17,150</dd>
        <dt class="chapters">Chapters:</dt><dd class="chapters"><a href="/works/${id}/chapters/1">12</a>/23</dd>
        <dt class="kudos">Kudos:</dt><dd class="kudos">1,204</dd>
        <dt class="hits">Hits:</dt><dd class="hits">40,312</dd>
      </dl>
    </li>`
}

const READINGS_HTML = `<!doctype html>
<html><head><title>Marked for Later</title><meta name="csrf-token" content="token"></head>
<body class="logged-in">
  <div id="header"><a href="/users/me/preferences">Preferences</a></div>
  <div id="main">
    <ul class="navigation actions"><li><span class="current">Marked for Later</span></li></ul>
    <ol class="reading work index group">
      ${blurb(1, 'Fluffy one', ['Fluff'])}
      ${blurb(2, 'Angsty one', ['Angst'])}
      ${blurb(3, 'Both at once', ['Fluff', 'Angst'])}
      ${blurb(4, 'A collapsed one', ['HideMe'])}
    </ol>
  </div>
</body></html>`

/**
 * A stored list is the blurbs as AO3 served them, never as the view drew them.
 * Opening a list decorates it, so a decorated copy opens with every star, clock
 * and "Mark as Read" button twice — and a list does get written while its
 * blurbs are on screen (a blurb action, a top-up), so the copy has to be
 * stripped rather than timed.
 */
describe('stored search-view lists hold undecorated blurbs', { skip }, () => {
  let browser
  let css
  let js
  let page

  /** The to-read page, opened on `seed`. */
  const open = async (seed) => {
    const tab = await browser.newPage()
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (!req.url().startsWith('https://archiveofourown.org/'))
        return void req.abort()
      // The mark-as-read POST is answered like any other request: a 200 is success.
      void req.respond({ status: 200, contentType: 'text/html', body: READINGS_HTML })
    })
    await tab.evaluateOnNewDocument(installMock, seed)
    await tab.goto(READINGS_URL, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await sleep(2700)
    return tab
  }

  before(async () => {
    ensureBuilt()
    css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')

    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-first-run', '--no-default-browser-check'],
    })
    page = await open(SEED)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /** Per work in the view: stars after its tags, and "Mark as Read" buttons. */
  const decorations = (tab = page) => tab.evaluate(() => {
    const out = {}
    for (const li of document.querySelectorAll('.AO3E--search-view--results > li.blurb')) {
      const indicatorsAfter = (a) => {
        let n = 0
        for (let s = a.nextElementSibling; s?.classList.contains('AO3E--indicators'); s = s.nextElementSibling)
          n++
        return n
      }
      out[li.querySelector('h4.heading a').textContent] = {
        tags: [...li.querySelectorAll('ul.tags a.tag')].map(indicatorsAfter),
        actions: li.querySelectorAll('.AO3E--search-view--blurb-action').length,
        reasons: li.querySelectorAll('.AO3E--hide-works--msg').length,
      }
    }
    return out
  })

  /** The stored lists as last written, and the blurbs of the first of them. */
  const storedSnapshots = () => page.evaluate(async () =>
    (await browser.storage.local.get('cache.searchSnapshots'))['cache.searchSnapshots'])
  const storedBlurbs = async () => Object.values(await storedSnapshots())[0].blurbsHtml

  const EXPECTED = {
    'Fluffy one': { tags: [1], actions: 1, reasons: 0 },
    'Both at once': { tags: [1, 0], actions: 1, reasons: 0 },
    'A collapsed one': { tags: [0], actions: 1, reasons: 1 },
  }

  test('the view opens decorated once', async () => {
    assert.deepEqual(await decorations(), { ...EXPECTED, 'Angsty one': { tags: [0], actions: 1, reasons: 0 } })
  })

  test('a list written while its blurbs are on screen is stored undecorated', async () => {
    await page.evaluate(() => {
      const li = [...document.querySelectorAll('.AO3E--search-view--results > li.blurb')]
        .find(el => el.querySelector('h4.heading a').textContent === 'Angsty one')
      li.querySelector('.AO3E--search-view--blurb-action').click()
    })
    await sleep(1000)
    const stored = await storedBlurbs()
    assert.equal(stored.length, 3, 'Mark as Read should have taken the work off the stored list')
    for (const html of stored) {
      assert.doesNotMatch(html, /ao3e/i)
      assert.doesNotMatch(html, /<dl class="stats"><div|\bhidden\b|\u2009/)
    }
    // Stats' reformatted numbers go back to what AO3 wrote, link and all.
    assert.match(stored[0], /<dd class="words">17,150<\/dd>/)
    assert.match(stored[0], /<dd class="chapters"><a href="\/works\/1\/chapters\/1">12<\/a>\/23<\/dd>/)
  })

  test('a list reopened by an options change is decorated once', async () => {
    await page.evaluate(() => {
      document.querySelector('.AO3E--search-view--results').dataset.stale = ''
    })
    // Any options change re-runs the units, which reopens the view from the works
    // it was already showing — the same blurbs, decorated once already.
    await page.evaluate(() => browser.storage.local.set({ 'option.searchPerPage': 49 }))
    await sleep(2500)
    assert.ok(
      await page.evaluate(() => document.querySelector('.AO3E--search-view--results')?.dataset.stale === undefined),
      'the view should have reopened',
    )
    assert.deepEqual(await decorations(), EXPECTED)
  })

  test('a list stored decorated by an earlier build opens decorated once', async () => {
    const snapshots = await storedSnapshots()
    const live = await page.evaluate(() =>
      [...document.querySelectorAll('.AO3E--search-view--results > li.blurb')].map(li => li.outerHTML))
    for (const entry of Object.values(snapshots))
      entry.blurbsHtml = live
    const tab = await open({ ...SEED, 'cache.searchSnapshots': snapshots })
    assert.deepEqual(await decorations(tab), EXPECTED)
    await tab.close()
  })
})

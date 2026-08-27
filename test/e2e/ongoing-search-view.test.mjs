import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const READINGS_URL = 'https://archiveofourown.org/users/me/readings?show=to-read'

/**
 * Three works, all on the Marked for Later list, with the ongoing mark already
 * carrying progress for two of them:
 *
 * - work 1: chapter 3 of 9 published — something to read, so **Ready**
 * - work 2: chapter 5 of 5 — nothing new, so **Caught up**
 * - work 3: no mark at all — an untracked to-read work is Ready by definition
 *
 * A wait-until date is deliberately not used for the *waiting* case: it would
 * have to be a fixed date, and this test would start failing the day it passed.
 * "Caught up" makes the same point — a facet value that hides a work — without
 * a clock in it.
 *
 * `1,3` / `1:3,1:5` are the packed forms: ids delta-encoded from 0 in base 36,
 * progress as `<idDelta>:<chapter>` with no trailing colon.
 */
const SEED = {
  'option.searchMarkedForLater': true,
  'option.workMarks': {
    enabled: true,
    marks: {
      read: { icon: 'read', label: 'Read', color: '#6b7280', hideSearchResult: false, items: '' },
      continue: {
        icon: 'continue',
        label: 'Ongoing',
        color: '#0369a1',
        triggerAlias: 'read',
        tracksProgress: true,
        hideSearchResult: true,
        items: '1,1',
        progress: '1:3,1:5',
      },
      saved: { icon: 'saved', label: 'Marked for later', color: '#2f8f4e' },
    },
  },
}

function blurb(id, title, chapters) {
  return `
    <li class="blurb work" id="work_${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">${title}</a> by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4>
        <h5 class="fandoms heading"><a class="tag" href="/tags/F/works">A Fandom</a></h5>
      </div>
      <dl class="stats">
        <dt class="words">Words:</dt>
        <dd class="words">7,150</dd>
        <dt class="chapters">Chapters:</dt>
        <dd class="chapters">${chapters}</dd>
      </dl>
    </li>`
}

const READINGS_HTML = `<!doctype html>
<html><head><title>Marked for Later</title></head>
<body class="logged-in">
  <div id="header"><a href="/users/me/preferences">Preferences</a></div>
  <div id="main">
    <ul class="navigation actions"><li><span class="current">Marked for Later</span></li></ul>
    <ol class="reading work index group">
      ${blurb(1, 'Still going', '<a href="/works/1/navigate">9</a>/23')}
      ${blurb(2, 'All caught up', '<a href="/works/2/navigate">5</a>/?')}
      ${blurb(3, 'Never marked', '1/1')}
    </ol>
  </div>
</body></html>`

/**
 * Nothing is collapsed inside the search view — it *is* the Marked for Later
 * list, so hiding works there would empty it. The Status facet is the only
 * filtering mechanism, which is why it defaults to "Ready" and why that default
 * has to stick across visits.
 *
 * It also carries the rest of what the reader has done with a work — the marks
 * it holds, "Unread" when it holds none, and "Marked for later" from the id
 * index this very page writes — so the values here are the union of all of that.
 */
describe('the Status facet in the search view', { skip }, () => {
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
    // Serve every archive request from the fixture: the page itself, and the
    // page-1 fetch the view's scrape makes.
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

    await page.click('.AO3E--search-marked-for-later--button')
    await sleep(1800)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /** Titles of the works currently visible in the view. */
  const visibleTitles = () => page.evaluate(() =>
    [...document.querySelectorAll('.AO3E--search-view--results > li.blurb')]
      .filter(li => !li.classList.contains('AO3E--search-view--hidden'))
      .map(li => li.querySelector('h4.heading a').textContent))

  /** The Status group's rows: value, drill-down count, and whether "include" is on. */
  const statusRows = () => page.evaluate(() => {
    const group = [...document.querySelectorAll('.AO3E--search-view--group')]
      .find(g => g.querySelector('.AO3E--search-view--group-label')?.textContent.trim().startsWith('Status'))
    if (!group)
      return null
    return [...group.querySelectorAll('.AO3E--search-view--row')].map(row => ({
      value: row.querySelector('.AO3E--search-view--row-name').textContent,
      hidden: row.classList.contains('AO3E--search-view--hidden'),
      included: row.querySelector('.AO3E--search-view--toggle-include').getAttribute('aria-pressed') === 'true',
    }))
  })

  const clickInclude = async (value) => {
    await page.evaluate((v) => {
      const rows = [...document.querySelectorAll('.AO3E--search-view--row')]
      const row = rows.find(r => r.querySelector('.AO3E--search-view--row-name').textContent === v)
      row.querySelector('.AO3E--search-view--toggle-include').click()
    }, value)
    await sleep(400)
  }

  test('the facet exists, listing every status present', async () => {
    const rows = await statusRows()
    assert.notEqual(rows, null, 'no Status facet group was rendered')
    // Works 1 and 2 carry the ongoing mark (one Ready, one Caught up); work 3
    // carries nothing, so it is Unread and ready by definition. All three are on
    // the Marked for Later list this page is, and the view writes that index
    // before it renders.
    assert.deepEqual(
      rows.map(r => r.value).sort(),
      ['Caught up', 'Marked for later', 'Ongoing', 'Ready', 'Unread'],
    )
  })

  test('it defaults to Ready, with nothing else selected', async () => {
    const rows = await statusRows()
    assert.deepEqual(
      rows.filter(r => r.included).map(r => r.value),
      ['Ready'],
    )
  })

  test('so a caught-up work is out of the list, and the rest are in', async () => {
    // Work 2 is on chapter 5 of 5 published; works 1 and 3 have something to read
    // (work 3 carries no mark at all, which reads as Ready).
    assert.deepEqual((await visibleTitles()).sort(), ['Never marked', 'Still going'])
  })

  test('nothing is collapsed inside the view — the facet is the only filter', async () => {
    const collapsed = await page.evaluate(() =>
      document.querySelectorAll('.AO3E--search-view--results .AO3E--hide-works--msg').length)
    assert.equal(collapsed, 0)
  })

  test('the selection lands in the stored search-view prefs', async () => {
    const status = await page.evaluate(() => {
      const writes = window.__writes.filter(w => 'cache.searchViewPrefs' in w)
      if (!writes.length)
        return null
      return writes[writes.length - 1]['cache.searchViewPrefs']['marked-for-later']?.status ?? null
    })
    assert.deepEqual(status, ['Ready'])
  })

  test('picking Caught up as well brings the whole list back', async () => {
    await clickInclude('Caught up')
    assert.deepEqual((await visibleTitles()).sort(), ['All caught up', 'Never marked', 'Still going'])
    const rows = await statusRows()
    assert.deepEqual(rows.filter(r => r.included).map(r => r.value).sort(), ['Caught up', 'Ready'])
  })

  test('and that change is persisted too, so it is what opens next time', async () => {
    const status = await page.evaluate(() => {
      const writes = window.__writes.filter(w => 'cache.searchViewPrefs' in w)
      return writes[writes.length - 1]['cache.searchViewPrefs']['marked-for-later'].status
    })
    assert.deepEqual([...status].sort(), ['Caught up', 'Ready'])
  })
})

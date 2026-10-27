import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { createDefaultMarks, moveMark, packIds, packProgress } from '../../src/common/workMarks.ts'
import { addMonths, fromEpochDays, todayEpochDays } from '../../src/common/workProgress.ts'
import { DIST, ensureBuilt, findChrome, installMock, launch } from './helpers.mjs'
import { until } from './optionsPage.mjs'
import { menuRows, openMenu, pickRow, settled } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const WORK_ID = '66597949'
/**
 * AO3 serves a chapter at its own permalink and does *not* redirect it to the
 * `/works/:id/chapters/:id` form — verified against the live archive. So this URL
 * carries no work id at all, and everything that needs one has to read it off
 * the page instead.
 */
const CHAPTER_PERMALINK = 'https://archiveofourown.org/chapters/227236561'
const WORK_URL = `https://archiveofourown.org/works/${WORK_ID}/chapters/227236561`

function baseSeed() {
  return {
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
          hideSearchResult: false,
          items: '',
          progress: '',
        },
        saved: { icon: 'saved', label: 'Marked for later', color: '#2f8f4e' },
      },
    },
  }
}

/**
 * A chapter page, in AO3's own shape — the work navigation and chapter index
 * both carry `/works/:id` links, which is where the id has to come from when the
 * URL has none.
 */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>A work</title></head><body class="logged-in">
  <div id="header"><ul class="primary navigation"><li class="dropdown"></li></ul></div>
  <div id="main" class="chapters-show">
    <ul class="work navigation actions">
      <li class="chapter entire"><a href="/works/${WORK_ID}?view_full_work=true">Entire Work</a></li>
      <li class="share hidden"><a href="/works/${WORK_ID}/share">Share</a></li>
    </ul>
    <ul id="chapter_index" class="actions"><li>
      <form action="/works/${WORK_ID}/navigate">
        <select id="selected_id" name="selected_id">
          <option value="1">1. One</option>
          <option value="6" selected="selected">6. Six</option>
        </select>
      </form>
    </li></ul>
    <div id="workskin">
      <div class="preface group"><h2 class="title heading">A long one</h2></div>
      <dl class="stats">
        <dt class="chapters">Chapters:</dt>
        <dd class="chapters"><a href="/works/${WORK_ID}/navigate">9</a>/23</dd>
      </dl>
      <div id="chapters">
        <div class="chapter" id="chapter-1">
          <div class="chapter preface group">
            <h3 class="title"><a href="/works/${WORK_ID}/chapters/227236561">Chapter 6</a></h3>
          </div>
        </div>
      </div>
    </div>
  </div>
</body></html>`

/**
 * The work menu on a work page: that it appears at all on a bare chapter
 * permalink, that the title opens it on a plain click, and what the editor and
 * the indicators do there.
 */
describe('the work menu on a work page', { skip }, () => {
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

  const open = async (url, seed = baseSeed()) => {
    const tab = await browser.newPage()
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE })
      else
        void req.abort()
    })
    await tab.evaluateOnNewDocument(installMock, seed)
    await tab.goto(url, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await settled(tab)
    return tab
  }

  /** Whether the open menu offers to mark the work `markId`. */
  const offersMark = async (tab, markId) =>
    (await menuRows(tab)).some(row => row.action === 'mark' && row.value === markId)

  /** The marks the open menu offers to set or take off, in order. */
  const dispositions = async tab =>
    (await menuRows(tab)).filter(row => row.action === 'mark' || row.action === 'unmark').map(row => row.value)

  /** Click the work's title, which opens its menu, and wait for the menu. */
  const openTitleMenu = tab => openMenu(tab, () => tab.click('#workskin > .preface.group > h2.title.heading'))

  test('a plain left click on the title opens the menu', async () => {
    const tab = await open(WORK_URL)
    await openTitleMenu(tab)
    const offered = await offersMark(tab, 'continue')
    await tab.close()
    assert.ok(offered, 'the work menu opened on a left click')
  })

  test('a bare /chapters/:id permalink still gets the menu', async () => {
    // The URL carries no work id, so this only works if the id is read off the
    // page. Before that, the title was silently skipped while the author menu
    // and the reader handles carried on working.
    const tab = await open(CHAPTER_PERMALINK)
    await openTitleMenu(tab)
    const offered = await offersMark(tab, 'continue')
    await tab.close()
    assert.ok(offered, 'the work menu opened on a chapter permalink')
  })

  test('the wait-until field starts at today when no date is set', async () => {
    const tab = await open(WORK_URL)
    await openTitleMenu(tab)
    assert.ok(await pickRow(tab, 'mark', 'continue'))
    await tab.waitForSelector('.AO3E--progress-editor')
    const value = await tab.$eval('.AO3E--progress-editor--date', el => el.value)
    await tab.close()
    assert.equal(value, fromEpochDays(todayEpochDays()), 'the presets need a visible base to move from')
  })

  test('Clear still empties the field, so no date is genuinely unset', async () => {
    const tab = await open(WORK_URL)
    await openTitleMenu(tab)
    assert.ok(await pickRow(tab, 'mark', 'continue'))
    await tab.waitForSelector('.AO3E--progress-editor')
    await tab.evaluate(() => document.querySelector('.AO3E--progress-editor [data-ao3e-action="clear"]').click())
    const value = await tab.$eval('.AO3E--progress-editor--date', el => el.value)
    await tab.close()
    assert.equal(value, '')
  })

  test('pressing a preset twice adds it twice', async () => {
    const tab = await open(WORK_URL)
    await openTitleMenu(tab)
    assert.ok(await pickRow(tab, 'mark', 'continue'))
    await tab.waitForSelector('.AO3E--progress-editor')
    await tab.evaluate(() => {
      const quarter = document.querySelector('.AO3E--progress-editor [data-ao3e-action="add-quarter"]')
      quarter.click()
      quarter.click()
    })
    const value = await tab.$eval('.AO3E--progress-editor--date', el => el.value)
    await tab.close()
    assert.equal(value, fromEpochDays(addMonths(todayEpochDays(), 6)))
  })

  test('saving the default today stores no date, not today', async () => {
    // "Wait until today" and "no wait-until date" say the same thing, so the
    // field can default to today for the presets' sake without every mark then
    // carrying a date. A real future date is still stored.
    const tab = await open(WORK_URL)
    await openTitleMenu(tab)
    assert.ok(await pickRow(tab, 'mark', 'continue'))
    await tab.waitForSelector('.AO3E--progress-editor')
    await tab.evaluate(() => document.querySelector('.AO3E--progress-editor--save').click())
    await until('the ongoing mark to be written', () => tab.evaluate(() =>
      (window.__writes ?? []).some(w => w['option.workMarks']?.marks?.continue?.items)))
    const written = await tab.evaluate(() => {
      const writes = window.__writes ?? []
      for (let i = writes.length - 1; i >= 0; i--) {
        const marks = writes[i]['option.workMarks']?.marks
        if (marks?.continue)
          return marks.continue.progress
      }
      return null
    })
    await tab.close()
    assert.ok(written, 'the mark was written')
    assert.ok(!written.includes(':', written.indexOf(':') + 1), `no date component expected, got ${written}`)
  })

  test('the dispositions are offered in table order, with Marked for Later apart', async () => {
    // Seeded from the shipped defaults rather than a hand-written subset, so this
    // is the order a real install actually sees.
    const tab = await open(WORK_URL, {
      'option.workMarks': { enabled: true, marks: createDefaultMarks() },
      'option.markForLaterToolbar': true,
    })
    await openTitleMenu(tab)
    const offered = await dispositions(tab)
    const rows = await menuRows(tab)
    await tab.close()

    assert.deepEqual(offered, ['read', 'no', 'bad', 'boring', 'gross', 'good', 'hot', 'dark', 'feelsy', 'fluff', 'favorite', 'abandoned', 'continue'])

    // Marked for Later is an AO3-side action, so it sits in its own scope group
    // rather than among the dispositions.
    const mfl = rows.find(r => r.action?.endsWith('-for-later'))
    assert.ok(mfl, rows.map(r => r.action).join(' | '))
    assert.equal(mfl.scope, 'account')
  })

  test('a reordered table reorders the menu', async () => {
    // The whole point of the order being editable: the menu is built from what
    // the table says, not from the order the marks shipped in. `favorite` is
    // moved from the end of the verdicts to the front of them.
    const marks = moveMark(createDefaultMarks(), 'favorite', -10)
    const tab = await open(WORK_URL, { 'option.workMarks': { enabled: true, marks } })
    await openTitleMenu(tab)
    const offered = await dispositions(tab)
    await tab.close()

    assert.deepEqual(offered, ['favorite', 'read', 'no', 'bad', 'boring', 'gross', 'good', 'hot', 'dark', 'feelsy', 'fluff', 'abandoned', 'continue'])
  })

  test('a mark switched off leaves the menu — unless the work carries it', async () => {
    // The pseudo-delete: `boring` stops being one of the answers, but a work
    // already called boring has to keep the row that takes it back off.
    const marks = createDefaultMarks()
    marks.boring.disabled = true
    marks.bad.disabled = true

    const clean = await open(WORK_URL, { 'option.workMarks': { enabled: true, marks } })
    await openTitleMenu(clean)
    const offered = (await menuRows(clean)).filter(row => row.action === 'mark').map(row => row.value)
    await clean.close()
    assert.ok(!offered.includes('boring'), offered.join(' | '))
    assert.ok(!offered.includes('bad'), offered.join(' | '))
    assert.ok(offered.includes('gross'), 'the marks still offered are untouched')

    const carried = createDefaultMarks()
    carried.boring.disabled = true
    carried.boring.items = packIds([WORK_ID])
    const marked = await open(WORK_URL, { 'option.workMarks': { enabled: true, marks: carried } })
    await openTitleMenu(marked)
    const withMark = await menuRows(marked)
    await marked.close()
    assert.ok(withMark.some(row => row.action === 'unmark' && row.value === 'boring'), withMark.map(row => `${row.action} ${row.value}`).join(' | '))
  })

  test('an ongoing work drops the Marked-for-Later clock from its indicators', async () => {
    // The two always travel together — an ongoing work is kept on the list on
    // purpose — so showing both says nothing the calendar didn't already.
    const seed = baseSeed()
    seed['option.workMarks'].marks.continue.items = packIds([WORK_ID])
    seed['option.workMarks'].marks.continue.progress = packProgress([[WORK_ID, { chapter: 4 }]])
    seed['option.markForLaterToolbar'] = true

    const tab = await open(WORK_URL, seed)
    const shown = await tab.evaluate(() => ({
      ongoing: !!document.querySelector('.AO3E--indicator--mark-continue'),
      saved: !!document.querySelector('.AO3E--indicator--mark-saved'),
    }))
    await tab.close()
    assert.ok(shown.ongoing, 'the ongoing calendar is shown')
    assert.ok(!shown.saved, 'the marked-for-later clock is not')
  })
})

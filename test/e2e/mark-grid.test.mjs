import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { createDefaultMarks, packIds, unpackIds } from '../../src/common/workMarks.ts'
import { DIST, ensureBuilt, findChrome, installMock, launch } from './helpers.mjs'
import { runs, settled } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const WORK_ID = '70011223'
const WORK_URL = `https://archiveofourown.org/works/${WORK_ID}`

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>A work</title></head><body>
  <div id="main" class="works-show">
    <input id="search" type="text">
    <div id="workskin">
      <div class="preface group"><h2 class="title heading">Something to rate</h2></div>
      <div id="chapters"><div class="chapter" id="chapter-1"><p>Text.</p></div></div>
    </div>
  </div>
</body></html>`

function seed({ grid = true, carried = [] } = {}) {
  const marks = createDefaultMarks()
  for (const id of carried)
    marks[id].items = packIds([WORK_ID])
  return { 'option.workMarks': { enabled: true, marks }, 'option.markGrid': grid }
}

const GRID = '[data-ao3e-mark-grid]'

/** The rating grid on a work page: opened with R, several marks chosen from one opening. */
describe('the rating grid', { skip }, () => {
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

  const open = async (stored) => {
    const tab = await browser.newPage()
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE })
      else
        void req.abort()
    })
    await tab.evaluateOnNewDocument(installMock, stored)
    await tab.goto(WORK_URL, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await settled(tab)
    return tab
  }

  const gridOpen = tab => tab.evaluate(sel => document.querySelector(sel) !== null, GRID)

  /** The mark ids in one of the grid's rows, in the order shown. */
  const row = (tab, name) => tab.$$eval(`${GRID} [data-ao3e-row="${name}"] [data-ao3e-value]`, els => els.map(el => el.dataset.ao3eValue))

  /** Which marks the work carries, by the last mark table the page wrote. */
  const carried = tab => tab.evaluate(() => {
    const table = (window.__writes ?? []).findLast(w => w['option.workMarks'])?.['option.workMarks']?.marks ?? {}
    return Object.fromEntries(Object.entries(table).map(([id, config]) => [id, config.items ?? '']))
  }).then(items => Object.keys(items).filter(id => unpackIds(items[id]).has(WORK_ID)).sort())

  /** Click a tile, and wait for the re-run that mark's write asks for to finish. */
  const choose = async (tab, markId) => {
    const done = await runs(tab)
    await tab.click(`${GRID} [data-ao3e-value="${markId}"]`)
    await settled(tab, done)
  }

  test('R opens the grid with every mark the work can take, and nothing selected', async () => {
    const tab = await open(seed())
    await tab.keyboard.press('r')
    assert.ok(await gridOpen(tab))
    assert.deepEqual(await row(tab, 'selected'), [])
    const available = await row(tab, 'available')
    await tab.close()
    assert.deepEqual(available, ['read', 'no', 'bad', 'boring', 'gross', 'good', 'hot', 'dark', 'feelsy', 'fluff', 'favorite', 'abandoned', 'continue'])
  })

  test('several marks chosen from one opening, each moving up to the selected row', async () => {
    const tab = await open(seed())
    await tab.keyboard.press('r')
    await choose(tab, 'hot')
    await choose(tab, 'favorite')
    await choose(tab, 'feelsy')
    assert.ok(await gridOpen(tab), 'the grid stays open across the page\'s re-runs')
    assert.deepEqual(await row(tab, 'selected'), ['hot', 'feelsy', 'favorite'])
    assert.ok(!(await row(tab, 'available')).includes('hot'))
    assert.ok(!(await row(tab, 'available')).includes('read'), 'plain Read is not offered beside a verdict, as in the menu')
    assert.deepEqual(await carried(tab), ['favorite', 'feelsy', 'hot'])
    await tab.close()
  })

  test('a selected mark chosen again comes off the work and goes back down', async () => {
    const tab = await open(seed({ carried: ['hot', 'dark'] }))
    await tab.keyboard.press('r')
    assert.deepEqual(await row(tab, 'selected'), ['hot', 'dark'])
    assert.equal(await tab.$eval(`${GRID} [data-ao3e-value="hot"]`, el => el.dataset.ao3eAction), 'unmark')
    await choose(tab, 'hot')
    assert.deepEqual(await row(tab, 'selected'), ['dark'])
    assert.ok((await row(tab, 'available')).includes('hot'))
    assert.deepEqual(await carried(tab), ['dark'])
    await tab.close()
  })

  test('R again, Escape, or a click outside closes it', async () => {
    const tab = await open(seed())
    await tab.keyboard.press('r')
    await tab.keyboard.press('r')
    assert.equal(await gridOpen(tab), false, 'R closes it')

    await tab.keyboard.press('r')
    await tab.keyboard.press('Escape')
    assert.equal(await gridOpen(tab), false, 'Escape closes it')

    await tab.keyboard.press('r')
    await tab.mouse.click(5, 5)
    assert.equal(await gridOpen(tab), false, 'a click outside closes it')
    await tab.close()
  })

  test('R typed into a field is typing', async () => {
    const tab = await open(seed())
    await tab.click('#search')
    await tab.keyboard.type('r')
    const opened = await gridOpen(tab)
    const typed = await tab.$eval('#search', el => el.value)
    await tab.close()
    assert.equal(opened, false)
    assert.equal(typed, 'r')
  })

  test('nothing opens while the grid is switched off', async () => {
    const tab = await open(seed({ grid: false }))
    await tab.keyboard.press('r')
    const opened = await gridOpen(tab)
    await tab.close()
    assert.equal(opened, false)
  })

  test('switching it off on an open page stops R from opening it', async () => {
    const tab = await open(seed())
    const done = await runs(tab)
    await tab.evaluate(() => window.browser.storage.local.set({ 'option.markGrid': false }))
    await settled(tab, done)
    await tab.keyboard.press('r')
    const opened = await gridOpen(tab)
    await tab.close()
    assert.equal(opened, false)
  })
})

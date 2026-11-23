import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { createDefaultMarks, markIds, packIds, unpackIds } from '../../src/common/workMarks.ts'
import { DIST, ensureBuilt, findChrome, installMock, launch, until } from './helpers.mjs'
import { inject, persistentMock, runs, settled, stored } from './trackedPages.mjs'

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

function seed({ grid = true, carried = [], pinned = false } = {}) {
  const marks = createDefaultMarks()
  for (const id of carried)
    marks[id].items = packIds([WORK_ID])
  return { 'option.workMarks': { enabled: true, marks }, 'option.markGrid': grid, 'option.markGridPinned': pinned }
}

const GRID = '[data-ao3e-mark-grid]'
const PIN = `${GRID} [data-ao3e-action="pin"]`
const EDIT = `${GRID} [data-ao3e-action="edit-order"]`
const tile = markId => `${GRID} [data-ao3e-value="${markId}"]`

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

  /** The last value the page wrote for one option, or undefined. */
  const lastWrite = (tab, key) => tab.evaluate(k => (window.__writes ?? []).findLast(w => k in w)?.[k], key)

  test('the pin is kept as a setting, and a pinned grid is pinned when opened again', async () => {
    const tab = await open(seed())
    await tab.keyboard.press('r')
    assert.equal(await tab.$eval(PIN, el => el.getAttribute('aria-pressed')), 'false')
    await tab.click(PIN)
    assert.equal(await lastWrite(tab, 'option.markGridPinned'), true)
    await tab.keyboard.press('Escape')
    await tab.keyboard.press('r')
    const pressed = await tab.$eval(PIN, el => el.getAttribute('aria-pressed'))
    await tab.close()
    assert.equal(pressed, 'true')
  })

  test('pinned, the marks chosen are written only when the grid is dismissed', async () => {
    const tab = await open(seed({ pinned: true, carried: ['read'] }))
    await tab.keyboard.press('r')
    await tab.click(tile('hot'))
    await tab.click(tile('feelsy'))
    assert.ok(await gridOpen(tab))
    assert.deepEqual(await row(tab, 'selected'), ['hot', 'feelsy'])
    assert.equal(await lastWrite(tab, 'option.workMarks'), undefined, 'nothing written while the grid is open')

    const done = await runs(tab)
    await tab.keyboard.press('Escape')
    await settled(tab, done)
    assert.equal(await gridOpen(tab), false)
    assert.deepEqual(await carried(tab), ['feelsy', 'hot'])
    await tab.close()
  })

  test('unpinning writes what the pinned grid had chosen', async () => {
    const tab = await open(seed({ pinned: true }))
    await tab.keyboard.press('r')
    await tab.click(tile('dark'))
    const done = await runs(tab)
    await tab.click(PIN)
    await settled(tab, done)
    assert.ok(await gridOpen(tab), 'unpinning leaves the grid open')
    assert.deepEqual(await carried(tab), ['dark'])
    await tab.close()
  })

  test('in edit mode a tile dragged onto another moves it there in the mark order, and a click marks nothing', async () => {
    const tab = await open(seed())
    await tab.keyboard.press('r')
    await tab.click(EDIT)
    assert.equal(await tab.$eval(EDIT, el => el.getAttribute('aria-pressed')), 'true')
    await tab.click(tile('read'))
    assert.equal(await lastWrite(tab, 'option.workMarks'), undefined, 'a click in edit mode is not a mark')

    const box = markId => tab.$eval(tile(markId), (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left, y: r.top, w: r.width, h: r.height }
    })
    const from = await box('favorite')
    const to = await box('no')
    const done = await runs(tab)
    await tab.mouse.move(from.x + from.w / 2, from.y + from.h / 2)
    await tab.mouse.down()
    await tab.mouse.move(to.x + to.w / 4, to.y + to.h / 2, { steps: 8 })
    await tab.mouse.up()
    await settled(tab, done)

    const order = markIds((await lastWrite(tab, 'option.workMarks')).marks)
    const shown = await row(tab, 'available')
    await tab.close()
    assert.deepEqual(order.slice(0, 3), ['read', 'favorite', 'no'])
    assert.deepEqual(shown.slice(0, 3), ['read', 'favorite', 'no'], 'the grid redraws in the new order')
  })

  test('a tile\'s description shows as soon as the pointer is over it, and goes when it leaves', async () => {
    const stored = seed()
    stored['option.workMarks'].marks.hot.description = 'Steamy.'
    const tab = await open(stored)
    await tab.keyboard.press('r')
    const tip = () => tab.evaluate(() => {
      const el = document.querySelector('[data-ao3e-mark-tip]')
      return el && !el.hidden ? el.textContent : null
    })
    await tab.hover(tile('hot'))
    const shown = await tip()
    const described = await tab.$eval(tile('hot'), el => ({ title: el.getAttribute('title'), description: el.getAttribute('aria-description') }))
    await tab.hover(tile('bad'))
    const undescribed = await tip()
    await tab.mouse.move(5, 5)
    const left = await tip()
    await tab.close()
    assert.equal(shown, 'Steamy.')
    assert.deepEqual(described, { title: null, description: 'Steamy.' }, 'no native tooltip to wait for; still described to a screen reader')
    assert.equal(undescribed, null, 'a mark without a description shows nothing')
    assert.equal(left, null)
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

/**
 * What pinning is for: on a work saved for later, a verdict takes it off the
 * list through AO3's own button, which reloads the page. Pinned, that happens
 * once, after every mark chosen is written.
 */
describe('the pinned rating grid on a work saved for later', { skip }, () => {
  let browser

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  const page = saved => `<!doctype html>
<html><head><meta charset="utf-8"><title>A work</title></head><body class="logged-in">
  <div id="main" class="works-show">
    <ul class="work navigation actions"><li class="mark"><form class="button_to" method="post" action="/works/${WORK_ID}/${saved ? 'mark_as_read' : 'mark_for_later'}"><button type="submit">Mark</button></form></li></ul>
    <div id="workskin">
      <div class="preface group"><h2 class="title heading">Something to rate</h2></div>
      <div id="chapters"><div class="chapter" id="chapter-1"><p>Text.</p></div></div>
    </div>
  </div>
</body></html>`

  test('several verdicts chosen, then one trip to AO3 when the grid is dismissed', async () => {
    const tab = await browser.newPage()
    const posts = []
    try {
      await tab.setRequestInterception(true)
      tab.on('request', (req) => {
        const url = new URL(req.url())
        if (url.origin !== 'https://archiveofourown.org')
          return void req.abort()
        if (req.method() === 'POST')
          posts.push(url.pathname)
        void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: page(req.method() !== 'POST') })
      })
      await tab.evaluateOnNewDocument(persistentMock({ ...seed({ pinned: true }), 'option.markForLaterToolbar': true }))
      await tab.goto(WORK_URL, { waitUntil: 'domcontentloaded' })
      await inject(tab)

      await tab.keyboard.press('r')
      await tab.click(tile('hot'))
      await tab.click(tile('feelsy'))
      assert.deepEqual(posts, [], 'nothing sent while the grid is open')

      await Promise.all([tab.waitForNavigation({ waitUntil: 'domcontentloaded' }), tab.keyboard.press('Escape')])
      await until('the reloaded page to be readable', () => tab.evaluate(() => document.readyState !== 'loading'))
      assert.deepEqual(posts, [`/works/${WORK_ID}/mark_as_read`])
      const table = await stored(tab, 'option.workMarks')
      const carries = Object.keys(table.marks).filter(id => unpackIds(table.marks[id].items ?? '').has(WORK_ID)).sort()
      assert.deepEqual(carries, ['feelsy', 'hot'])
    }
    finally {
      await tab.close()
    }
  })
})

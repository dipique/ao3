import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { DIST, ensureBuilt, findChrome, installMock, launch } from '../helpers.mjs'
import { settled } from '../trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const READINGS_URL = 'https://archiveofourown.org/users/me/readings'

/** AO3's own sidebar rules, as its default skin draws your own dashboard. */
const AO3_CSS = `
  body { margin: 0; font: 100%/1.125 'Lucida Grande', Verdana, sans-serif; }
  #dashboard { width: 11.25em; float: left; padding: 0.5em; }
  #dashboard.own { border-top: 15px solid #900; border-bottom: 15px solid #900; }`

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>History</title><style>${AO3_CSS}</style></head>
<body class="logged-in">
  <div id="dashboard" class="region own" role="navigation region">
    <ul class="navigation actions"><li><a href="/users/me">Dashboard</a></li><li><a href="/users/me/readings">History</a></li></ul>
  </div>
  <div id="main" class="dashboard region"><h2 class="heading">History</h2></div>
</body></html>`

/**
 * Clicking the red band across the top of your own dashboard folds the
 * sidebar away. The band is a border, which says nothing of being a control,
 * so the fold hints at itself there: a pointer over the band and a chevron
 * pointing the way it folds, wherever a click on it would fold the sidebar
 * and nowhere else.
 */
describe('the dashboard band\'s fold hint', { skip }, () => {
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

  const open = async ({ width = 1280, on = true } = {}) => {
    const tab = await browser.newPage()
    await tab.setViewport({ width, height: 800 })
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE })
      else
        void req.abort()
    })
    await tab.evaluateOnNewDocument(installMock, { 'option.collapsibleDashboard': on })
    await tab.evaluateOnNewDocument(() => localStorage.removeItem('ao3e:dashboard:collapsed'))
    await tab.goto(READINGS_URL, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await settled(tab)
    return tab
  }

  /** What the band shows: its overlay's cursor, and whether a chevron is drawn on it. */
  const hint = tab => tab.evaluate(() => {
    const dashboard = document.querySelector('#dashboard')
    return {
      cursor: getComputedStyle(dashboard, '::before').cursor,
      chevron: getComputedStyle(dashboard, '::after').content !== 'none',
    }
  })

  test('in the wide layout the band shows a pointer and a chevron', async () => {
    const tab = await open()
    const s = await hint(tab)
    await tab.close()
    assert.deepEqual(s, { cursor: 'pointer', chevron: true })
  })

  test('a click on the chevron still folds the sidebar', async () => {
    const tab = await open()
    const point = await tab.evaluate(() => {
      const box = document.querySelector('#dashboard').getBoundingClientRect()
      return { x: box.left + box.width / 2, y: box.top + 7 }
    })
    await tab.mouse.click(point.x, point.y)
    const folded = await tab.evaluate(() => document.documentElement.classList.contains('AO3E--dashboard-collapsed'))
    await tab.close()
    assert.equal(folded, true)
  })

  test('where the sidebar can\'t fold, the band shows nothing', async () => {
    const tab = await open({ width: 900 })
    const s = await hint(tab)
    await tab.close()
    assert.equal(s.chevron, false)
    assert.notEqual(s.cursor, 'pointer')
  })

  test('with the fold switched off, the band shows nothing', async () => {
    const tab = await open({ on: false })
    const s = await hint(tab)
    await tab.close()
    assert.equal(s.chevron, false)
    assert.notEqual(s.cursor, 'pointer')
  })
})

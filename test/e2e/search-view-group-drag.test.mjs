import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { DIST, ensureBuilt, findChrome, installMock, launch } from './helpers.mjs'
import { settled, viewDrawn } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const READINGS_URL = 'https://archiveofourown.org/users/me/readings?show=to-read'

function blurb(id, freeforms) {
  return `
    <li class="blurb work" id="work_${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">Work ${id}</a> by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4>
        <h5 class="fandoms heading"><a class="tag" href="/tags/F/works">A Fandom</a></h5>
      </div>
      <ul class="tags commas">
        ${freeforms.map(name => `<li class="freeforms"><a class="tag" href="/tags/${name}/works">${name}</a></li>`).join('')}
      </ul>
      <dl class="stats">
        <dt class="words">Words:</dt>
        <dd class="words">1,000</dd>
        <dt class="chapters">Chapters:</dt>
        <dd class="chapters">1/1</dd>
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
      ${blurb(1, ['A'])}
      ${blurb(2, ['B'])}
    </ol>
  </div>
</body></html>`

const GROUP = '.AO3E--search-view--group'
const HANDLE = '.AO3E--search-view--group-grip'

/**
 * Dragging a facet group by its grip. Where the group lands for a pointer
 * height is `dropSlot`'s business, tested case by case in `test/searchView/`;
 * here, that a drag reaches it and the order it leaves is the one stored.
 */
describe('search view facet group drag', { skip }, () => {
  let browser
  let page

  before(async () => {
    ensureBuilt()
    const css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    const js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')

    browser = await launch(chromePath)
    page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html', body: READINGS_HTML })
      else
        void req.abort()
    })
    await page.evaluateOnNewDocument(installMock, { 'option.searchMarkedForLater': true })
    await page.goto(READINGS_URL, { waitUntil: 'domcontentloaded' })
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await settled(page)
    await viewDrawn(page)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /** The facet groups in the page, in order: each one's key and whether it is open. */
  const groups = () => page.$$eval(GROUP, els => els.map(el => ({ key: el.dataset.ao3eFacet, open: el.open })))

  /** The facet order the last write of the search-view prefs stored, or null before there is one. */
  const storedOrder = () => page.evaluate(() => {
    const writes = window.__writes.filter(w => 'cache.searchViewPrefs' in w)
    return writes.at(-1)?.['cache.searchViewPrefs']['marked-for-later']?.order ?? null
  })

  /** The middle of an element, in the page's coordinates. */
  async function middle(selector) {
    const box = await (await page.$(selector)).boundingBox()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }

  /** Drag the `from`th group's grip to just past the `to`th group's middle, in the direction of travel. */
  async function drag(from, to) {
    const grip = await middle(`${GROUP}:nth-child(${from + 1}) ${HANDLE}`)
    const target = await middle(`${GROUP}:nth-child(${to + 1})`)
    await page.mouse.move(grip.x, grip.y)
    await page.mouse.down()
    await page.mouse.move(grip.x, target.y + (to > from ? 2 : -2), { steps: 8 })
    await page.mouse.up()
  }

  test('dropping a group below another puts it there, stores that order, and leaves it open', async () => {
    const start = await groups()
    assert.ok(start.length >= 3, 'the view has groups enough to drag between')

    await drag(0, 2)

    const moved = await groups()
    assert.deepEqual(moved.map(g => g.key), [start[1].key, start[2].key, start[0].key, ...start.slice(3).map(g => g.key)])
    assert.deepEqual(moved.map(g => g.open), [start[1].open, start[2].open, start[0].open, ...start.slice(3).map(g => g.open)])
    assert.deepEqual((await storedOrder()).slice(0, moved.length), moved.map(g => g.key))
  })

  test('dragging a group up puts it above the groups it passed', async () => {
    const start = (await groups()).map(g => g.key)

    await drag(2, 0)

    assert.deepEqual((await groups()).map(g => g.key), [start[2], start[0], start[1], ...start.slice(3)])
    assert.deepEqual((await storedOrder()).slice(0, start.length), (await groups()).map(g => g.key))
  })
})

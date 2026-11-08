import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { ensureBuilt, findChrome, launch } from './helpers.mjs'
import { menuClosed, menuRows, openMenu, openTab, pickRow, visit } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const WORK_URL = 'https://archiveofourown.org/works/1'
const TITLE = '#workskin > .preface.group > h2.title.heading'
const RIGHT_HANDLE = '.AO3E--reader-handle-right'
const WIDTH_KEY = 'ao3e:reader:widthRem'

const WORK_MARKS = {
  enabled: true,
  marks: {
    read: { icon: 'read', label: 'Read', color: '#6b7280', hideSearchResult: false, items: '' },
    saved: { icon: 'saved', label: 'Marked for later', color: '#2f8f4e' },
  },
}
const SEED = { 'option.readerMode': true, 'option.workMarks': WORK_MARKS }

const PAGE = `<!doctype html>
<html><head><title>A work</title></head><body>
  <div id="main" class="works-show">
    <div id="workskin">
      <div class="preface group"><h2 class="title heading">A long one</h2></div>
      <div id="chapters"><div class="chapter" id="chapter-1"><p>Some text.</p></div></div>
    </div>
  </div>
</body></html>`

/**
 * Halfway down a long work the title is a long way up, and the width handles are
 * the one thing of ours still on screen. So they open the title's menu too, while
 * staying drag handles to the left button.
 */
describe('the reader handles open the work menu', { skip }, () => {
  let browser

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  const open = async (seed = SEED) => {
    const tab = await openTab(browser, { seed, route: () => PAGE })
    await visit(tab, WORK_URL)
    await tab.waitForSelector(RIGHT_HANDLE)
    return tab
  }

  const centre = (tab, selector) => tab.$eval(selector, (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })

  const width = tab => tab.$eval('#workskin', el => el.getBoundingClientRect().width)
  const savedWidth = tab => tab.evaluate(key => localStorage.getItem(key), WIDTH_KEY)

  const rightClick = async (tab, selector) => {
    const { x, y } = await centre(tab, selector)
    await openMenu(tab, () => tab.mouse.click(x, y, { button: 'right' }))
  }

  test('right-clicking a handle offers what the title offers, and acts on the work', async () => {
    const tab = await open()
    try {
      await tab.waitForSelector(`${TITLE}.AO3E--menu-trigger`)
      await rightClick(tab, TITLE)
      const fromTitle = await menuRows(tab)
      await tab.keyboard.press('Escape')
      await menuClosed(tab)

      await rightClick(tab, RIGHT_HANDLE)
      assert.deepEqual(await menuRows(tab), fromTitle)

      assert.ok(await pickRow(tab, 'mark', 'read'), 'the menu offers the marks')
      await tab.waitForFunction(async () => {
        const stored = (await browser.storage.local.get('option.workMarks'))['option.workMarks']
        return stored.marks.read.items !== ''
      })
    }
    finally {
      await tab.close()
    }
  })

  test('the left handle opens it too', async () => {
    const tab = await open()
    try {
      await tab.waitForSelector(`${TITLE}.AO3E--menu-trigger`)
      await rightClick(tab, '.AO3E--reader-handle-left')
      assert.ok((await menuRows(tab)).some(row => row.action === 'mark'))
    }
    finally {
      await tab.close()
    }
  })

  test('a right-button press is not a drag: the width and its saved target stay put', async () => {
    const tab = await open()
    try {
      const before = await width(tab)
      const { x, y } = await centre(tab, RIGHT_HANDLE)
      await tab.mouse.move(x, y)
      await tab.mouse.down({ button: 'right' })
      await tab.mouse.move(x - 120, y, { steps: 4 })
      await tab.mouse.up({ button: 'right' })
      assert.equal(await width(tab), before)
      assert.equal(await savedWidth(tab), null)
    }
    finally {
      await tab.close()
    }
  })

  test('a left-button drag still resizes, and leaves no menu behind', async () => {
    const tab = await open()
    try {
      await tab.waitForSelector(`${TITLE}.AO3E--menu-trigger`)
      const before = await width(tab)
      const { x, y } = await centre(tab, RIGHT_HANDLE)
      await tab.mouse.move(x, y)
      await tab.mouse.down()
      await tab.mouse.move(x - 120, y, { steps: 4 })
      await tab.mouse.up()
      assert.ok(await width(tab) < before - 100)
      assert.notEqual(await savedWidth(tab), null)

      // The menu builds asynchronously, so give a wrongly opened one time to appear.
      await tab.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)))
      assert.equal(await tab.$('.AO3E--menu'), null)
    }
    finally {
      await tab.close()
    }
  })

  test('with the menus switched off, a handle leaves the browser its own menu', async () => {
    const tab = await open({ ...SEED, 'option.contextMenusEnabled': false })
    try {
      await tab.waitForSelector(`${TITLE}.AO3E--menu-trigger`)
      const prevented = await tab.$eval(RIGHT_HANDLE, el =>
        !el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
      assert.equal(prevented, false)
    }
    finally {
      await tab.close()
    }
  })

  test('with no work menu on the page, a handle leaves the browser its own menu', async () => {
    const tab = await open({
      'option.readerMode': true,
      'option.workMarks': { ...WORK_MARKS, enabled: false },
      'option.markForLaterToolbar': false,
      'option.rules': { enabled: false, filters: [], colors: {} },
    })
    try {
      assert.equal(await tab.$(`${TITLE}.AO3E--menu-trigger`), null)
      const prevented = await tab.$eval(RIGHT_HANDLE, el =>
        !el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
      assert.equal(prevented, false)
    }
    finally {
      await tab.close()
    }
  })
})

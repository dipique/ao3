import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { DIST, ensureBuilt, findChrome, installMock, launch } from '../helpers.mjs'
import { startOptions } from '../optionsPage.mjs'
import { openMenu, settled } from '../trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const LISTING_URL = 'https://archiveofourown.org/tags/A%20Fandom/works'

const SEED = {
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
    },
  },
}

const PAGE = `<!doctype html>
<html><head><title>Works</title></head>
<body class="logged-in">
  <div id="header"><ul class="primary navigation"><li class="dropdown"></li></ul></div>
  <div id="main">
    <ol class="work index group">
      <li class="blurb work" id="work_1">
        <div class="header module">
          <h4 class="heading"><a href="/works/1">A work</a></h4>
        </div>
        <dl class="stats">
          <dt class="chapters">Chapters:</dt>
          <dd class="chapters"><a href="/works/1/navigate">4</a>/9</dd>
        </dl>
      </li>
    </ol>
  </div>
</body></html>`

/** `user-select` as each element matching `selector` computes it, keyed by its text. */
function userSelect(page, selector) {
  return page.$$eval(selector, els => els.map(el => [
    el.textContent.trim() || el.getAttribute('aria-label') || el.outerHTML.slice(0, 80),
    getComputedStyle(el).userSelect,
  ]))
}

/**
 * A press that drifts a little, or a double-click on a preset, selects the
 * label under the pointer — so no control the extension draws offers its text
 * to the selection. Prose around the controls still selects as usual.
 */
describe('button text is never selected', { skip }, () => {
  describe('on an archive page', () => {
    let browser
    let css
    let js

    before(async () => {
      ensureBuilt()
      css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
      js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')
      browser = await launch(chromePath)
    }, { timeout: 180000 })

    after(() => browser?.close())

    test('the context menu and the ongoing editor', async () => {
      const tab = await browser.newPage()
      await tab.setRequestInterception(true)
      tab.on('request', (req) => {
        if (req.url().startsWith('https://archiveofourown.org/'))
          void req.respond({ status: 200, contentType: 'text/html', body: PAGE })
        else
          void req.abort()
      })
      await tab.evaluateOnNewDocument(installMock, SEED)
      await tab.goto(LISTING_URL, { waitUntil: 'domcontentloaded' })
      await tab.addStyleTag({ content: css })
      await tab.addScriptTag({ content: js })
      await settled(tab)

      await openMenu(tab, () => tab.evaluate(() => {
        document.querySelector('#work_1 h4.heading a').dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
        )
      }))
      const menuItems = await userSelect(tab, '.AO3E--menu .AO3E--menu--item')
      await tab.evaluate(() => document.querySelector('.AO3E--menu .AO3E--menu--item[data-ao3e-action="mark"][data-ao3e-value="continue"]').click())
      await tab.waitForSelector('.AO3E--progress-editor')
      const editorButtons = await userSelect(tab, '.AO3E--progress-editor button')
      const [[, title]] = await userSelect(tab, '.AO3E--progress-editor--title')
      const [[, heading]] = await userSelect(tab, '#work_1 h4.heading a')
      await tab.close()

      assert.ok(menuItems.length > 0, 'the menu opened')
      assert.ok(editorButtons.length >= 6, editorButtons.map(([text]) => text).join(' | '))
      for (const [text, value] of [...menuItems, ...editorButtons])
        assert.equal(value, 'none', `"${text}" can be selected`)
      assert.equal(title, 'auto', 'the editor\'s heading is still text')
      assert.equal(heading, 'auto', 'the archive\'s own text is left alone')
    })
  })

  describe('on the options page', () => {
    let session

    before(async () => {
      session = await startOptions()
    }, { timeout: 180000 })

    after(() => session?.close())

    test('every control, and none of the prose', async () => {
      const options = await session.open({ hash: '#site-features-appearance' })
      const controls = await userSelect(options.page, 'button, [role="button"], [role="tab"], [role="switch"]')
      const prose = await userSelect(options.page, 'main p, main label')
      await options.page.close()

      assert.ok(controls.length > 0, 'the page drew its controls')
      for (const [text, value] of controls)
        assert.equal(value, 'none', `"${text}" can be selected`)
      assert.ok(prose.length > 0, 'the page drew some prose')
      assert.ok(prose.some(([, value]) => value !== 'none'), 'prose is still selectable')
    })
  })
})

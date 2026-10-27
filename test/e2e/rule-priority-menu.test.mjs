import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import { DIST, ensureBuilt, findChrome, installMock, launch } from './helpers.mjs'
import { menuClosed, openMenu, settled } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

/** A collapse rule raised to 6, a highlight, and a tag with no rule at all. */
const SEED = {
  'option.tagToolbar': true,
  'option.rules': {
    enabled: true,
    colors: {},
    filters: [
      { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'collapse', priority: 6 },
      { target: 'F', value: 'Waff', matcher: 'exact', behavior: 'highlight' },
    ],
  },
}

const PAGE = `
<div id="main">
  <ol class="work index group">
    <li class="work blurb group" id="work_1">
      <div class="header module">
        <h4 class="heading"><a href="/works/1">A work</a> by <a rel="author" href="/users/s/pseuds/s">s</a></h4>
      </div>
      <ul class="tags commas">
        <li class="freeforms"><a class="tag" href="/tags/Fluff/works">Fluff</a></li>
        <li class="freeforms"><a class="tag" href="/tags/Waff/works">Waff</a></li>
        <li class="freeforms"><a class="tag" href="/tags/Angst/works">Angst</a></li>
      </ul>
    </li>
  </ol>
</div>
`

/**
 * A tag's menu offers its rule's priority as an "Update Priority" submenu, once
 * there is a rule whose priority decides anything; and switching the rule to
 * another behaviour keeps the priority it was given.
 */
describe('rule priority from the tag menu', { skip }, () => {
  let browser
  let page
  let js

  before(async () => {
    ensureBuilt()
    js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await page?.close()
    await browser?.close()
  })

  beforeEach(async () => {
    await page?.close()
    page = await browser.newPage()
    await page.goto('about:blank')
    await page.evaluate(installMock, SEED)
    await page.evaluate((html) => {
      document.body.innerHTML = html
    }, PAGE)
    await page.addScriptTag({ content: js })
    await settled(page)
  })

  /** Right-click the blurb tag link reading `text`; returns the menu's own row labels. */
  const openMenuOn = async (text) => {
    await openMenu(page, () => page.evaluate((want) => {
      const link = [...document.querySelectorAll('.blurb ul.tags a.tag')]
        .find(a => a.textContent.trim() === want)
      link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
    }, text))
    return page.evaluate(() =>
      [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
        .filter(el => !el.closest('.AO3E--menu--submenu'))
        .map(el => el.querySelector('.AO3E--menu--label').textContent))
  }

  /** Click the row reading `label`, in the menu or its open submenu. */
  const click = label => page.evaluate((want) => {
    const row = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
      .find(el => el.textContent === want)
    if (!row)
      throw new Error(`no menu row reading "${want}"`)
    row.click()
  }, label)

  /** The open submenu's rows, as label, and whether each is current and offered. */
  const submenuRows = () => page.evaluate(() =>
    [...document.querySelectorAll('.AO3E--menu--submenu .AO3E--menu--item')].map(el => ({
      label: el.textContent,
      active: el.classList.contains('AO3E--menu--active'),
      disabled: el.disabled,
    })))

  const storedRule = value => page.evaluate(async (want) => {
    const { 'option.rules': rules } = await window.browser.storage.local.get('option.rules')
    return rules.filters.find(r => r.value === want)
  }, value)

  test('is offered only for a rule whose priority decides anything', async () => {
    assert.ok((await openMenuOn('Fluff')).includes('Update Priority'))
    assert.ok(!(await openMenuOn('Waff')).includes('Update Priority'), 'a highlight never enters the contest')
    assert.ok(!(await openMenuOn('Angst')).includes('Update Priority'), 'no rule, nothing to weigh')
  })

  test('lists every priority, the current one marked and not offered, and sets the one picked', async () => {
    await openMenuOn('Fluff')
    await click('Update Priority')
    const rows = await submenuRows()
    assert.deepEqual(rows.map(r => r.label), Array.from({ length: 10 }, (_, i) => `Priority ${i}`))
    assert.deepEqual(rows.filter(r => r.active).map(r => r.label), ['Priority 6'])
    assert.deepEqual(rows.filter(r => r.disabled).map(r => r.label), ['Priority 6'])

    await click('Priority 2')
    await menuClosed(page)
    assert.deepEqual(await storedRule('Fluff'), { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'collapse', priority: 2 })
  })

  test('opens beside the menu when pointed at, and goes when another row is', async () => {
    await openMenuOn('Fluff')
    const rowAt = label => page.evaluate((want) => {
      const row = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')].find(el => el.textContent === want)
      const { x, y, width, height } = row.getBoundingClientRect()
      return { x: x + width / 2, y: y + height / 2 }
    }, label)

    const parent = await rowAt('Update Priority')
    await page.mouse.move(parent.x, parent.y)
    await page.waitForSelector('.AO3E--menu--submenu')
    assert.equal((await submenuRows()).length, 10)

    const other = await rowAt('Clear')
    await page.mouse.move(other.x, other.y)
    await page.waitForFunction(() => !document.querySelector('.AO3E--menu--submenu'))
    assert.ok(await page.$('.AO3E--menu'), 'the menu itself stays open')
  })

  test('switching the rule to another behaviour keeps its priority', async () => {
    await openMenuOn('Fluff')
    await click('Hide works with tag')
    await menuClosed(page)
    assert.deepEqual(await storedRule('Fluff'), { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'hide', priority: 6 })
  })
})

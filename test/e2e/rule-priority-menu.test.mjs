import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import { DIST, ensureBuilt, findChrome, installMock, launch } from './helpers.mjs'
import { menuClosed, menuRows, openMenu, pickRow, settled } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

/**
 * A collapse rule raised to 6, a highlight, and a tag with no rule at all; and
 * for the works an "always show" keeps on the page, two fandom collapses (at 0
 * and 5) and two force-shows (at their default 4, and at 9).
 */
const SEED = {
  'option.tagToolbar': true,
  'option.rules': {
    enabled: true,
    colors: {},
    filters: [
      { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'collapse', priority: 6 },
      { target: 'F', value: 'Waff', matcher: 'exact', behavior: 'highlight' },
      { target: 'f', value: 'Soft Fandom', matcher: 'exact', behavior: 'collapse' },
      { target: 'f', value: 'Hard Fandom', matcher: 'exact', behavior: 'collapse', priority: 5 },
      { target: 'F', value: 'Keeper', matcher: 'exact', behavior: 'invert' },
      { target: 'F', value: 'Override', matcher: 'exact', behavior: 'invert', priority: 9 },
    ],
  },
}

/** A blurb in one fandom, carrying the given additional tags. */
function shownBlurb(id, fandom, tags) {
  return `
    <li class="work blurb group" id="work_${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">Work ${id}</a></h4>
        <h5 class="fandoms heading"><a class="tag" href="/tags/${encodeURIComponent(fandom)}/works">${fandom}</a></h5>
      </div>
      <ul class="tags commas">
        ${tags.map(t => `<li class="freeforms"><a class="tag" href="/tags/${t}/works">${t}</a></li>`).join('')}
      </ul>
    </li>`
}

const PAGE = `
<div id="main">
  <ol class="work index group">
    <li class="work blurb group" id="work_1">
      <div class="header module">
        <h4 class="heading"><a href="/works/1">A work</a></h4>
      </div>
      <ul class="tags commas">
        <li class="freeforms"><a class="tag" href="/tags/Fluff/works">Fluff</a></li>
        <li class="freeforms"><a class="tag" href="/tags/Waff/works">Waff</a></li>
        <li class="freeforms"><a class="tag" href="/tags/Angst/works">Angst</a></li>
      </ul>
    </li>
    ${shownBlurb(2, 'Soft Fandom', ['Keeper'])}
    ${shownBlurb(3, 'Hard Fandom', ['Keeper', 'Override'])}
    ${shownBlurb(4, 'Plain Fandom', ['Keeper'])}
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

  /** Right-click the tag link reading `text` in a blurb; returns the menu's own rows, not its submenu's. */
  const openMenuOn = async (text, blurb = 'work_1') => {
    await openMenu(page, () => page.evaluate((want, id) => {
      const link = [...document.querySelectorAll(`#${id} ul.tags a.tag`)]
        .find(a => a.textContent.trim() === want)
      link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
    }, text, blurb))
    return (await menuRows(page)).filter(row => !row.submenu)
  }
  const actions = rows => rows.map(row => row.action)
  /** The values of the rows that do `action`. */
  const valuesOf = (rows, action) => rows.filter(row => row.action === action).map(row => row.value)

  /** Click the row that does `action` — to `value`, when given — in the menu or its open submenu. */
  const click = async (action, value) => {
    assert.ok(await pickRow(page, action, value), `no ${action} row ${value ?? ''}`)
  }

  /** The open submenu's rows: the priority each sets, and whether each is current and offered. */
  const submenuRows = async () => (await menuRows(page)).filter(row => row.submenu)

  const storedRule = value => page.evaluate(async (want) => {
    const { 'option.rules': rules } = await window.browser.storage.local.get('option.rules')
    return rules.filters.find(r => r.value === want)
  }, value)

  test('is offered only for a rule whose priority decides anything', async () => {
    assert.ok(actions(await openMenuOn('Fluff')).includes('priority'))
    assert.ok(!actions(await openMenuOn('Waff')).includes('priority'), 'a highlight never enters the contest')
    assert.ok(!actions(await openMenuOn('Angst')).includes('priority'), 'no rule, nothing to weigh')
  })

  test('lists every priority, the current one marked and not offered, and sets the one picked', async () => {
    await openMenuOn('Fluff')
    await click('priority')
    const rows = await submenuRows()
    assert.deepEqual(valuesOf(rows, 'set-priority'), Array.from({ length: 10 }, (_, i) => String(i)))
    assert.deepEqual(rows.filter(r => r.active).map(r => r.value), ['6'])
    assert.deepEqual(rows.filter(r => r.disabled).map(r => r.value), ['6'])

    await click('set-priority', '2')
    await menuClosed(page)
    assert.deepEqual(await storedRule('Fluff'), { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'collapse', priority: 2 })
  })

  test('opens beside the menu when pointed at, and goes when another row is', async () => {
    await openMenuOn('Fluff')
    const rowAt = action => page.evaluate((want) => {
      const row = document.querySelector(`.AO3E--menu .AO3E--menu--item[data-ao3e-action="${want}"]`)
      const { x, y, width, height } = row.getBoundingClientRect()
      return { x: x + width / 2, y: y + height / 2 }
    }, action)

    const parent = await rowAt('priority')
    await page.mouse.move(parent.x, parent.y)
    await page.waitForSelector('.AO3E--menu--submenu')
    assert.equal((await submenuRows()).length, 10)

    const other = await rowAt('clear')
    await page.mouse.move(other.x, other.y)
    await page.waitForFunction(() => !document.querySelector('.AO3E--menu--submenu'))
    assert.ok(await page.$('.AO3E--menu'), 'the menu itself stays open')
  })

  test('switching the rule to another behaviour keeps its priority', async () => {
    await openMenuOn('Fluff')
    await click('hide')
    await menuClosed(page)
    assert.deepEqual(await storedRule('Fluff'), { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'hide', priority: 6 })
  })

  test('an "always show" offers the hide it overrides on this work, at that rule’s own priority', async () => {
    const rows = await openMenuOn('Keeper', 'work_2')
    assert.deepEqual(valuesOf(rows, 'overriding'), ['Soft Fandom'])

    await click('overriding', 'Soft Fandom')
    assert.deepEqual((await submenuRows()).filter(r => r.active).map(r => r.value), ['0'])
    await click('set-priority', '5')
    await menuClosed(page)
    assert.deepEqual(await storedRule('Soft Fandom'), { target: 'f', value: 'Soft Fandom', matcher: 'exact', behavior: 'collapse', priority: 5 })
    await page.waitForFunction(() => document.getElementById('work_2').dataset.ao3eHiddenBy === 'tags')
  })

  test('lists only the hides this force-show outranks by itself', async () => {
    // "Hard Fandom" collapses at 5: above "Keeper" at 4, so it's "Override" at 9 holding it off.
    const keeper = await openMenuOn('Keeper', 'work_3')
    assert.deepEqual(valuesOf(keeper, 'overriding'), [])
    const override = await openMenuOn('Override', 'work_3')
    assert.deepEqual(valuesOf(override, 'overriding'), ['Hard Fandom'])
  })

  test('a force-show overriding nothing on this work offers nothing', async () => {
    const rows = await openMenuOn('Keeper', 'work_4')
    assert.ok(actions(rows).includes('priority'), 'the menu is the force-show’s own')
    assert.deepEqual(valuesOf(rows, 'overriding'), [])
  })
})

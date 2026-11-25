import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import { OPTION_DEFAULTS } from '../../src/common/optionDefaults.ts'
import { DIST, ensureBuilt, findChrome, installMock, launch } from './helpers.mjs'
import { menuClosed, menuRows, openMenu, pickRow, settled } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

/** The priority an "always show" rule takes when it sets none of its own. */
const ALWAYS_SHOW = OPTION_DEFAULTS.rules.alwaysShowPriority
/** The priority every other rule takes when it sets none of its own. */
const DEFAULT = 0

/** Every priority a rule can take, as the submenu rows' values. */
const PRIORITIES = Array.from({ length: 10 }, (_, i) => String(i))

/**
 * A collapse rule raised to 6, a collapse at its default, a highlight, a
 * disabled rule that kept a priority of 4, and a tag with no rule at all; and
 * for the works an "always show" keeps on the page, two fandom collapses (at 0
 * and one above the "always show" default) and two force-shows (at that
 * default, and at 9).
 */
const SEED = {
  'option.tagToolbar': true,
  'option.rules': {
    enabled: true,
    colors: {},
    filters: [
      { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'collapse', priority: 6 },
      { target: 'F', value: 'Meh', matcher: 'exact', behavior: 'collapse' },
      { target: 'F', value: 'Waff', matcher: 'exact', behavior: 'highlight' },
      { target: 'F', value: 'Paused', matcher: 'exact', behavior: 'none', priority: 4 },
      { target: 'f', value: 'Soft Fandom', matcher: 'exact', behavior: 'collapse' },
      { target: 'f', value: 'Hard Fandom', matcher: 'exact', behavior: 'collapse', priority: ALWAYS_SHOW + 1 },
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
        <li class="freeforms"><a class="tag" href="/tags/Meh/works">Meh</a></li>
        <li class="freeforms"><a class="tag" href="/tags/Waff/works">Waff</a></li>
        <li class="freeforms"><a class="tag" href="/tags/Paused/works">Paused</a></li>
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
 * Hide, collapse and always show each open a submenu of priorities. On the
 * behaviour the tag's rule has, it changes that rule's priority and offers
 * "Clear"; on any other it gives the tag that behaviour at the priority picked.
 * Highlight and hiding the tag itself have no priority, and are toggles.
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
  const rowFor = (rows, action) => rows.find(row => row.action === action)

  /** Click the row that does `action` — to `value`, when given — in the menu or its open submenu. */
  const click = async (action, value) => {
    assert.ok(await pickRow(page, action, value), `no ${action} row ${value ?? ''}`)
  }

  /** The open submenu's rows. */
  const submenuRows = async () => (await menuRows(page)).filter(row => row.submenu)
  /** The priorities the open submenu marks, and those it doesn't offer. */
  const marked = rows => rows.filter(r => r.active).map(r => r.value)
  const off = rows => rows.filter(r => r.disabled).map(r => r.value)

  const storedRule = value => page.evaluate(async (want) => {
    const { 'option.rules': rules } = await window.browser.storage.local.get('option.rules')
    return rules.filters.find(r => r.value === want)
  }, value)

  test('the behaviour a tag\'s rule has is marked and offered, with no separate priority row', async () => {
    const rows = await openMenuOn('Fluff')
    assert.equal(rowFor(rows, 'collapse').active, true)
    assert.equal(rowFor(rows, 'collapse').disabled, false)
    assert.ok(!actions(rows).includes('priority'))
    assert.ok(!actions(rows).includes('clear'), 'clearing the rule lives in its own submenu')
  })

  test('the rule\'s own behaviour lists every priority, the current one marked and not offered, and sets the one picked', async () => {
    await openMenuOn('Fluff')
    await click('collapse')
    const rows = await submenuRows()
    assert.deepEqual(valuesOf(rows, 'set-priority'), PRIORITIES)
    assert.deepEqual(marked(rows), ['6'])
    assert.deepEqual(off(rows), ['6'])

    await click('set-priority', '2')
    await menuClosed(page)
    assert.deepEqual(await storedRule('Fluff'), { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'collapse', priority: 2 })
  })

  test('the rule\'s own behaviour offers "Clear", which removes the rule', async () => {
    await openMenuOn('Fluff')
    await click('collapse')
    assert.ok(actions(await submenuRows()).includes('clear'))
    await click('clear')
    await menuClosed(page)
    assert.equal(await storedRule('Fluff'), undefined)
  })

  test('another behaviour marks its default and the rule\'s current priority, offers every priority, and switches the rule to the one picked', async () => {
    await openMenuOn('Fluff')
    await click('hide')
    const rows = await submenuRows()
    assert.deepEqual(valuesOf(rows, 'set-priority'), PRIORITIES)
    assert.deepEqual(marked(rows), [String(DEFAULT), '6'])
    assert.deepEqual(off(rows), [])
    assert.ok(!actions(rows).includes('clear'))

    await click('set-priority', '6')
    await menuClosed(page)
    assert.deepEqual(await storedRule('Fluff'), { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'hide', priority: 6 })
  })

  test('a current priority that is also the default is marked once', async () => {
    await openMenuOn('Meh')
    await click('hide')
    assert.deepEqual(marked(await submenuRows()), [String(DEFAULT)])
  })

  test('a tag with no rule gets one at the priority picked, the default marked', async () => {
    const rows = await openMenuOn('Angst')
    assert.ok(!rows.some(row => row.active))
    await click('always-show')
    const sub = await submenuRows()
    assert.deepEqual(valuesOf(sub, 'set-priority'), PRIORITIES)
    assert.deepEqual(marked(sub), [String(ALWAYS_SHOW)])
    assert.deepEqual(off(sub), [])
    assert.ok(!actions(sub).includes('clear'))

    await click('set-priority', '9')
    await menuClosed(page)
    assert.deepEqual(await storedRule('Angst'), { target: 'F', value: 'Angst', matcher: 'exact', behavior: 'invert', priority: 9 })
  })

  test('a highlight is a toggle: chosen again, it goes', async () => {
    const rows = await openMenuOn('Waff')
    assert.equal(rowFor(rows, 'highlight').active, true)
    await click('highlight')
    await menuClosed(page)
    assert.equal(await storedRule('Waff'), undefined)

    await openMenuOn('Angst')
    await click('highlight')
    await menuClosed(page)
    assert.deepEqual(await storedRule('Angst'), { target: 'F', value: 'Angst', matcher: 'exact', behavior: 'highlight' })
  })

  test('a highlight has no priority to mark as current when another behaviour replaces it', async () => {
    await openMenuOn('Waff')
    await click('collapse')
    assert.deepEqual(marked(await submenuRows()), [String(DEFAULT)])
    await click('set-priority', '4')
    await menuClosed(page)
    assert.deepEqual(await storedRule('Waff'), { target: 'F', value: 'Waff', matcher: 'exact', behavior: 'collapse', priority: 4 })
  })

  test('a disabled rule, which no behaviour stands for, is cleared from the menu itself', async () => {
    const rows = await openMenuOn('Paused')
    assert.ok(!rows.some(row => row.active))
    await click('clear')
    await menuClosed(page)
    assert.equal(await storedRule('Paused'), undefined)
  })

  test('opens beside the menu when pointed at, and goes when another row is', async () => {
    await openMenuOn('Fluff')
    const rowAt = action => page.evaluate((want) => {
      const row = document.querySelector(`.AO3E--menu .AO3E--menu--item[data-ao3e-action="${want}"]`)
      const { x, y, width, height } = row.getBoundingClientRect()
      return { x: x + width / 2, y: y + height / 2 }
    }, action)

    const parent = await rowAt('collapse')
    await page.mouse.move(parent.x, parent.y)
    await page.waitForSelector('.AO3E--menu--submenu')
    assert.deepEqual(valuesOf(await submenuRows(), 'set-priority'), PRIORITIES)

    const other = await rowAt('highlight')
    await page.mouse.move(other.x, other.y)
    await page.waitForFunction(() => !document.querySelector('.AO3E--menu--submenu'))
    assert.ok(await page.$('.AO3E--menu'), 'the menu itself stays open')
  })

  test('an "always show" offers the hide it overrides on this work, at that rule’s own priority', async () => {
    const rows = await openMenuOn('Keeper', 'work_2')
    assert.deepEqual(valuesOf(rows, 'overriding'), ['Soft Fandom'])

    await click('overriding', 'Soft Fandom')
    assert.deepEqual(marked(await submenuRows()), ['0'])
    // One above "Keeper" at its default is enough to beat it.
    const above = ALWAYS_SHOW + 1
    await click('set-priority', String(above))
    await menuClosed(page)
    assert.deepEqual(await storedRule('Soft Fandom'), { target: 'f', value: 'Soft Fandom', matcher: 'exact', behavior: 'collapse', priority: above })
    await page.waitForFunction(() => document.getElementById('work_2').dataset.ao3eHiddenBy === 'tags')
  })

  test('lists only the hides this force-show outranks by itself', async () => {
    // "Hard Fandom" collapses above "Keeper" at its default, so it's "Override" at 9 holding it off.
    const keeper = await openMenuOn('Keeper', 'work_3')
    assert.deepEqual(valuesOf(keeper, 'overriding'), [])
    const override = await openMenuOn('Override', 'work_3')
    assert.deepEqual(valuesOf(override, 'overriding'), ['Hard Fandom'])
  })

  test('a force-show overriding nothing on this work offers nothing', async () => {
    const rows = await openMenuOn('Keeper', 'work_4')
    assert.equal(rowFor(rows, 'always-show').active, true, 'the menu is the force-show’s own')
    assert.deepEqual(valuesOf(rows, 'overriding'), [])
  })
})
